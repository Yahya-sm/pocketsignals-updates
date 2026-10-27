// Signal engine: pulls 1-minute candles for all selected PocketOption assets once per minute,
// runs the enabled strategies on closed candles and tracks each signal's result.
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const POClient = require('./po-client');
const strategies = require('./strategies');
const I = require('./indicators');
const { parseSymbol, tvUrl, tvSymbol } = require('./assets');

const ROOT = path.join(__dirname, '..');
// The installed desktop app sets SIGNAL_DATA to a folder in the user's profile.
// (The phone runs this file in a browser, where "process" does not exist.)
const DATA = (typeof process !== 'undefined' && process.env && process.env.SIGNAL_DATA) || path.join(ROOT, 'data');
const CATEGORY = { currency: 'forex', cryptocurrency: 'po_crypto', commodity: 'po_goods', index: 'po_indices', stock: 'po_stocks' };

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, data) { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 1)); }

function loadSsid(config) {
  if (config.ssid) return config.ssid;
  // Fall back to the PO_SSID line in the original access file next to the app folder.
  try {
    const txt = fs.readFileSync(path.join(ROOT, '..', 'signal-zugang.txt'), 'utf8');
    const m = txt.match(/PO_SSID='(.+)'/); return m ? m[1] : '';
  } catch { return ''; }
}

class Engine extends EventEmitter {
  constructor() {
    super();
    this.settingsFile = path.join(DATA, 'settings.json');
    this.configFile = path.join(DATA, 'config.json');
    this.signalsFile = path.join(DATA, 'signals.json');
    this.settings = readJson(this.settingsFile, null)
      || readJson(path.join(ROOT, '..', 'signal-app-einstellungen.json'), null) // phone bundle: built-in defaults
      || readJson(path.join(ROOT, 'defaults', 'settings.json'), {});
    this.config = readJson(this.configFile, {});
    this.signals = readJson(this.signalsFile, []);
    this.assets = new Map();      // symbol -> { symbol, name, type, payout, active, key, otc, category }
    this.candles = new Map();     // symbol -> closed candles
    this.trendCandles = new Map(); // symbol -> { tf, at, candles } in the trend timeframe
    this.trendReq = new Map();     // request index -> { tf }
    this.secReq = new Map();       // request index -> { sec } for S10/S15/S30 candles
    this.lastEval = new Map();    // symbol -> time of last evaluated candle
    this.lastEvalBot = new Map(); // symbol -> last closed candle evaluated by the bot strategies
    this.pendingScan = [];
    this.status = 'start';
    this.po = new POClient(loadSsid(this.config), this.config.poUrl);
    this.po.on('status', s => { this.status = s; this.emit('state'); });
    this.po.on('assets', a => this._onAssets(a));
    this.po.on('history', h => this._onHistory(h));
    this.po.on('ready', () => { this._rememberGood(); this.scan(); });
    this.po.on('log', () => this.emit('state'));
  }

  // A session that connected is kept as fallback for sessions taken over automatically from a login.
  _rememberGood() {
    clearTimeout(this.autoTimer);
    const good = { ssid: this.po.ssid, url: this.po.url || null };
    if (JSON.stringify(good) === JSON.stringify(this.config.lastGood)) return;
    this.config.lastGood = good;
    writeJson(this.configFile, this.config);
  }

  // If an automatically taken-over session does not connect within 20 s, go back to the last working one
  // (or the built-in one) and never try that session again.
  _watchAutoSession() {
    clearTimeout(this.autoTimer);
    // Installs from before this check stored a taken-over session without the flag.
    const legacy = this.config.ssidAuto === undefined && this.config.ssid && this.config.ssid !== loadSsid({});
    if (!this.config.ssidAuto && !legacy) return;
    this.autoTimer = setTimeout(() => {
      if (this.po.authed) return;
      const bad = this.po.ssid;
      const back = this.config.lastGood && this.config.lastGood.ssid !== bad ? this.config.lastGood : { ssid: loadSsid({}), url: null };
      this.po._log(`Übernommene Sitzung verbindet nicht – zurück zur ${back.ssid ? 'letzten funktionierenden' : '(keiner) gespeicherten'} Sitzung`);
      this.config.rejected = [...(this.config.rejected || []), bad].slice(-10);
      this.config.ssid = back.ssid; this.config.poUrl = back.url; this.config.ssidAuto = false;
      writeJson(this.configFile, this.config);
      this.po.setSsid(back.ssid, back.url);
    }, 20000);
  }

  start() {
    this.po.connect();
    this._watchAutoSession();
    this.restartTimer();
  }

  get scanInterval() {
    const s = Number(this.settings.scan_interval) || 60;
    return [5, 10, 15, 20, 30, 60].includes(s) ? s : 60;
  }

  // 60 s: scan shortly after every minute boundary, once the candle has closed.
  // Shorter intervals: scan on the clock grid (e.g. :00, :05, :10 …) and include the still-forming candle.
  restartTimer() {
    clearTimeout(this.timer);
    const step = this.scanInterval * 1000, offset = step === 60000 ? 1500 : 300;
    const tick = () => {
      const ms = step - (Date.now() % step) + offset;
      this.timer = setTimeout(() => { this.scan(); tick(); }, ms);
    };
    tick();
  }

  _onAssets(list) {
    if (!Array.isArray(list)) return;
    for (const a of list) {
      const [, symbol, name, type, , payout] = a;
      const active = a[14] === true;
      const p = parseSymbol(symbol);
      this.assets.set(symbol, { symbol, name, type, payout, active, key: p.key, otc: p.otc, category: p.otc && type === 'currency' ? 'otc' : CATEGORY[type] || type });
    }
    this.emit('state');
  }

  selectedAssets() {
    const s = this.settings, pairs = new Set(s.pairs || []), off = new Set(s.assets_off || []);
    const minPayout = s.min_payout || 0;
    return [...this.assets.values()].filter(a =>
      a.active && pairs.has(a.key) && !off.has(a.category) && a.payout >= minPayout &&
      (a.otc ? s.otc_po_on !== false && s.market !== 'real' : s.market !== 'otc'));
  }

  scan() {
    if (!this.po.authed || this.settings.signals_on === false) return;
    this.scanStarted = Date.now();
    this.scanSignals = [];
    const list = this.selectedAssets();
    this.scanCount = list.length;
    // Spread the requests a little so the server is not flooded.
    list.forEach((a, i) => setTimeout(() => this.po.loadHistory(a.symbol, 60, 60 * 300), i * 40));
    // Trend candles in the trend timeframe itself (PocketOption sends at most ~150 candles per request,
    // too few one-minute candles for M10+). Fetched at most once a minute per pair.
    const tm = this.trendMinutes;
    if (tm > 1 && (this.settings.show_m5 !== false || this.settings.trend_filter)) {
      list.forEach((a, i) => {
        const have = this.trendCandles.get(a.symbol);
        if (have && have.tf === tm && Date.now() - have.at < 55000) return;
        setTimeout(() => { this.trendReq.set(this.po.loadHistory(a.symbol, tm * 60, tm * 60 * 60), { tf: tm }); }, list.length * 40 + i * 40);
      });
    }
    // Second timeframes (S10/S15/S30) used by enabled strategies: own candles in that period.
    for (const sec of this.secondTimeframes()) {
      list.forEach((a, i) => setTimeout(() => { this.secReq.set(this.po.loadHistory(a.symbol, sec, sec * 150), { sec }); }, i * 40 + 20));
    }
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this._flushScan(), list.length * 40 + Math.min(6000, this.scanInterval * 600));
    this.emit('state');
  }

  enabledStrategies() {
    return (this.settings.strategies || []).filter(n => !(this.settings.disabled || []).includes(n));
  }

  // Seconds of the S-timeframes (S10, S15, S30) that enabled strategies use.
  secondTimeframes() {
    const tfs = new Set(this.enabledStrategies().flatMap(n => this.settings.strat_tfs?.[n] || ['M1']));
    return [10, 15, 30].filter(s => tfs.has('S' + s));
  }

  // Candles in a second timeframe: evaluate the strategies set to it on the newest closed candle.
  _onSecondHistory(h, sec) {
    const now = Date.now() / 1000;
    const closed = h.data.map(k => ({ time: k.time, open: k.open, high: k.high, low: k.low, close: k.close }))
      .filter(k => k.time + sec <= now).sort((a, b) => a.time - b.time);
    if (!closed.length) return;
    const last = closed[closed.length - 1].time, key = h.asset + '|' + sec;
    if (this.lastEval.get(key) === last || last < now - 3 * sec) return; // already done / stale
    const entry = Math.ceil(now / sec) * sec; // next full 10/15/30-second mark
    this.lastEval.set(key, last);
    const tf = 'S' + sec, trend = this.settings.trend_filter ? this.m5Trend(h.asset) : null;
    for (const sig of strategies.evaluate({ [tf]: closed }, this.enabledStrategies(), this.settings)) {
      if (sig.strength < (this.settings.min_strength || 0)) continue;
      if ((trend === 'CALL' && sig.dir < 0) || (trend === 'PUT' && sig.dir > 0)) continue;
      this.scanSignals.push({ ...sig, asset: h.asset, candle: closed[closed.length - 1], entry });
    }
  }

  _onHistory(h) {
    if (!h || !h.asset || !Array.isArray(h.data)) return;
    const sreq = this.secReq.get(h.index);
    if (sreq) { this.secReq.delete(h.index); this._onSecondHistory(h, sreq.sec); return; }
    const req = this.trendReq.get(h.index);
    if (req) { // answer to a trend-timeframe request
      this.trendReq.delete(h.index);
      const c = h.data.map(k => ({ time: k.time, open: k.open, high: k.high, low: k.low, close: k.close })).sort((a, b) => a.time - b.time);
      this.trendCandles.set(h.asset, { tf: req.tf, at: Date.now(), candles: c });
      return;
    }
    const nowMin = Math.floor(Date.now() / 60000) * 60;
    const all = h.data
      .map(k => ({ time: k.time, open: k.open, high: k.high, low: k.low, close: k.close }))
      .sort((a, b) => a.time - b.time);
    if (all.length > 1 && (all[1].time - all[0].time) % 60 !== 0) return; // not one-minute candles: ignore
    const closed = all.filter(k => k.time < nowMin);
    if (!closed.length) return;
    this.candles.set(h.asset, closed);
    this._settleResults(h.asset, closed);           // results only from closed candles
    // Fast scanning also looks at the forming candle; one signal per candle is kept by the signal id.
    const fast = this.scanInterval < 60;
    const forming = all.length && all[all.length - 1].time === nowMin;
    const enabled = this.enabledStrategies();
    // Strategies decide which candles they need (strategies.liveMode): the program's own ones as before ('legacy'),
    // the Telegram-bot ones only closed candles, only the forming candle, or both.
    const mode = n => strategies.liveMode(n, this.settings);
    const legacy = enabled.filter(n => mode(n) === 'legacy');
    const closedOnly = enabled.filter(n => mode(n) === 'closed' || mode(n) === 'both');
    const liveOnly = enabled.filter(n => mode(n) === 'live' || mode(n) === 'both');
    // Optional filter: skip signals against the trend on the trend timeframe (sideways trend does not filter).
    const trend = this.settings.trend_filter ? this.m5Trend(h.asset) : null;
    const run = (candles, names, live) => {
      if (!names.length) return;
      const last = candles[candles.length - 1].time;
      const tfs = new Set(names.flatMap(n => this.settings.strat_tfs?.[n] || ['M1']));
      const byTf = {};
      for (const tf of tfs) {
        if (tf[0] === 'S') continue; // second timeframes come from their own candles (_onSecondHistory)
        const m = parseInt(tf.slice(1), 10) || 1;
        const c = I.resample(candles, m, live);
        // Closed: only when the higher-timeframe candle closed with this minute. Live: its candle contains the current minute.
        if (c.length && (live ? c[c.length - 1].time + m * 60 > last : c[c.length - 1].time + m * 60 === last + 60)) byTf[tf] = c;
      }
      for (const sig of strategies.evaluate(byTf, names, this.settings)) {
        if (sig.strength < (this.settings.min_strength || 0)) continue;
        if ((trend === 'CALL' && sig.dir < 0) || (trend === 'PUT' && sig.dir > 0)) continue;
        this.scanSignals.push({ ...sig, asset: h.asset, candle: candles[candles.length - 1] });
      }
    };
    // The program's own strategies – unchanged.
    if (legacy.length) {
      const candles = fast && forming ? all : closed;
      const last = candles[candles.length - 1].time;
      if ((fast || this.lastEval.get(h.asset) !== last) && last >= nowMin - 60) {
        this.lastEval.set(h.asset, last);
        run(candles, legacy, false);
      }
    }
    // Bot strategies on the closed candle: once per new closed candle.
    const cLast = closed[closed.length - 1].time;
    if (closedOnly.length && this.lastEvalBot.get(h.asset) !== cLast && cLast >= nowMin - 60) {
      this.lastEvalBot.set(h.asset, cLast);
      run(closed, closedOnly, false);
    }
    // Bot strategies inside the candle (before the close / at the touch / at the cross) – on every fast scan.
    if (liveOnly.length && fast && forming) run(all, liveOnly, true);
  }

  _flushScan() {
    // The limit counts per minute (per entry time), however often we scan.
    const max = this.settings.max_per_scan || 99;
    for (const s of (this.scanSignals || []).sort((a, b) => b.strength - a.strength)) {
      const entry = s.entry || s.candle.time + 60;
      if (this.signals.filter(x => x.entryTime === entry).length >= max) continue;
      this._emitSignal(s);
    }
    this.scanSignals = [];
    this.emit('state');
  }

  _emitSignal(s) {
    const a = this.assets.get(s.asset) || { name: s.asset, type: '' };
    const entryTime = s.entry || s.candle.time + 60; // next candle start (S-timeframes set their own)
    const id = `${s.asset}-${s.strategy}-${s.tf}-${s.bar ?? entryTime}`; // entry "now" inside a candle: one signal per candle
    if (this.signals.some(x => x.id === id)) return;
    const sig = {
      id, symbol: s.asset, name: a.name, otc: !!a.otc, payout: a.payout, dir: s.dir > 0 ? 'CALL' : 'PUT',
      strategy: s.strategy, strategyName: strategies.NAMES[s.strategy] || s.strategy, reason: s.reason, tf: s.tf,
      strength: s.strength, expiry: s.expiry, entryTime, entryPrice: s.candle.close,
      tv: tvUrl(s.asset, a.type), tvSymbol: tvSymbol(s.asset, a.type), result: null, created: Date.now(),
    };
    this.signals.unshift(sig);
    this.signals = this.signals.slice(0, 300);
    writeJson(this.signalsFile, this.signals);
    this.emit('signal', sig);
  }

  // Result = close of the candle at expiry vs. entry price.
  _settleResults(asset, candles) {
    let changed = false;
    for (const s of this.signals) {
      if (s.symbol !== asset || s.result) continue;
      // Close of the one-minute candle in which the expiry falls (exact for minute signals; for signals on
      // second timeframes the expiry can be inside a minute, then this minute's close is an approximation).
      const exit = s.entryTime + s.expiry - 1;
      const k = candles.find(c => c.time <= exit && exit < c.time + 60);
      if (!k) { if (Date.now() / 1000 > s.entryTime + s.expiry + 3600) { s.result = 'n/a'; changed = true; } continue; }
      const diff = k.close - s.entryPrice;
      s.result = diff === 0 ? 'DRAW' : (diff > 0) === (s.dir === 'CALL') ? 'WIN' : 'LOSS';
      s.exitPrice = k.close; changed = true;
    }
    if (changed) { writeJson(this.signalsFile, this.signals); this.emit('state'); }
  }

  // Timeframe of the trend badge (setting trend_tf, default M5), in minutes.
  get trendMinutes() {
    const m = parseInt(String(this.settings.trend_tf || 'M5').slice(1), 10);
    return [1, 2, 3, 5, 10, 15, 30].includes(m) ? m : 5;
  }

  // Direction on the trend timeframe: EMA 9 above EMA 21 with price above EMA 9 = CALL, the mirror = PUT, else FLAT.
  m5Trend(symbol) {
    const tm = this.trendMinutes, own = this.trendCandles.get(symbol);
    let tc;
    if (own && own.tf === tm) tc = own.candles;
    else { const c = this.candles.get(symbol); if (!c) return null; tc = I.resample(c, tm); }
    if (tc.length < 25) return null;
    const close = tc.map(k => k.close), f = I.ema(close, 9), s = I.ema(close, 21), i = close.length - 1;
    if (f[i] > s[i] && close[i] > f[i]) return 'CALL';
    if (f[i] < s[i] && close[i] < f[i]) return 'PUT';
    return 'FLAT';
  }

  // All pairs PocketOption offers, grouped by market, with whether each is chosen (settings.pairs) and open now.
  marketsForUi() {
    const chosen = new Set(this.settings.pairs || []), by = {};
    for (const a of this.assets.values()) {
      (by[a.category] ||= []).push({ key: a.key, name: a.name, payout: a.payout, open: a.active, on: chosen.has(a.key) });
    }
    for (const list of Object.values(by)) list.sort((x, y) => x.name.localeCompare(y.name));
    return by;
  }

  // tf: optional timeframe like 'M1' / 'M5' to open the chart with.
  openOnPocketOption(symbol, tf) {
    const unit = { S: 1, M: 60, H: 3600 }[String(tf || '')[0]] || 60;
    const sec = tf ? (parseInt(String(tf).slice(1), 10) || 0) * unit : 0;
    return this.po.openOnAccount(symbol, sec || undefined);
  }

  updateSettings(patch) {
    Object.assign(this.settings, patch);
    writeJson(this.settingsFile, this.settings);
    if ('scan_interval' in patch) this.restartTimer();
    this.emit('state');
  }

  // patch: parameter changes for one strategy; tfs: its timeframes.
  updateStrategy(name, patch, tfs) {
    if (!strategies.META[name]) return;
    const s = this.settings;
    s.strategy_settings = s.strategy_settings || {};
    if (patch) s.strategy_settings[name] = { ...(s.strategy_settings[name] || {}), ...patch };
    if (tfs) { s.strat_tfs = s.strat_tfs || {}; s.strat_tfs[name] = tfs.length ? tfs : ['M1']; }
    writeJson(this.settingsFile, s);
    this.emit('state');
  }

  // Settings exported from the Telegram bot / original app (same JSON shape as signal-app-einstellungen.json).
  importSettings(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'err_json' };
    const known = ['strategy_settings', 'strategies', 'strat_tfs', 'pairs', 'min_strength', 'max_per_scan', 'min_payout', 'market', 'assets_off', 'favorite_strategies'];
    if (!known.some(k => k in data)) return { ok: false, error: 'err_nosettings' };
    const s = this.settings;
    for (const [k, v] of Object.entries(data)) {
      if (k === 'strategy_settings' && v && typeof v === 'object') {
        s.strategy_settings = s.strategy_settings || {};
        for (const [name, p] of Object.entries(v)) s.strategy_settings[name] = { ...(s.strategy_settings[name] || {}), ...p };
      } else s[k] = v;
    }
    writeJson(this.settingsFile, s);
    this.emit('state');
    return { ok: true, strategies: Object.keys(data.strategy_settings || {}).length, active: (s.strategies || []).length };
  }

  exportSettings() { return this.settings; }

  resetStrategy(name) {
    if (this.settings.strategy_settings) delete this.settings.strategy_settings[name];
    writeJson(this.settingsFile, this.settings);
    this.emit('state');
  }

  // url: the server the PocketOption page itself connected to (depends on account type and region).
  // Without it (session pasted by hand) the server is guessed from the session.
  // auto: taken over from the PocketOption login (may be rejected; see _watchAutoSession).
  setSsid(ssid, url, auto = false) {
    // The apps report the logged-in session on every PocketOption page load; only reconnect on change.
    if (ssid === this.po.ssid && (url || null) === (this.config.poUrl || null) && this.po.authed) return;
    if (auto && (this.config.rejected || []).includes(ssid)) { this.po._log('Login aus PocketOption erkannt, aber früher schon abgelehnt – ignoriert'); return; }
    this.po._log(auto ? 'Login aus PocketOption übernommen' : 'Neue Sitzung eingetragen');
    if (auto && this.po.authed) this._rememberGood();
    this.config.ssid = ssid; this.config.poUrl = url || null; this.config.ssidAuto = auto;
    writeJson(this.configFile, this.config);
    this.po.setSsid(ssid, url);
    this._watchAutoSession();
  }

  clearSignals() { this.signals = []; writeJson(this.signalsFile, this.signals); this.emit('state'); }

  state() {
    const done = this.signals.filter(s => s.result === 'WIN' || s.result === 'LOSS');
    const wins = done.filter(s => s.result === 'WIN').length;
    return {
      status: this.status, connected: this.po.authed, lastError: this.po.lastError || null, log: this.po.log.slice(-40),
      // What session is stored (never the session itself): shown under the session field.
      session: this.po.ssid ? { length: this.po.ssid.length, demo: /"isDemo"\s*:\s*1/.test(this.po.ssid) } : null, demo: /"isDemo"\s*:\s*1/.test(this.po.ssid || ''),
      watching: this.selectedAssets().length, assetsKnown: this.assets.size,
      // Running signals carry the pair's current M5 trend (recomputed from the latest candles).
      signals: this.signals.slice(0, 300).map((s, i) => (i < 30 && !s.result ? { ...s, m5: this.m5Trend(s.symbol) } : s)),
      stats: { total: done.length, wins, rate: done.length ? Math.round(100 * wins / done.length) : null },
      settings: {
        strategies: this.settings.strategies || [], favorites: this.settings.favorite_strategies || [],
        allStrategies: strategies.list.map(k => ({
          key: k, names: strategies.NAMES[k], type: strategies.META[k][1],
          params: strategies.paramsFor(k, this.settings), tfs: this.settings.strat_tfs?.[k] || ['M1'],
        })),
        min_payout: this.settings.min_payout || 0, otc_po_on: this.settings.otc_po_on !== false,
        assets_off: this.settings.assets_off || [],
        markets: this.marketsForUi(), pairs: this.settings.pairs || [],
        min_strength: this.settings.min_strength || 0, max_per_scan: this.settings.max_per_scan || 0,
        market: this.settings.market || 'both', signals_on: this.settings.signals_on !== false, sound: this.settings.sound !== false, auto_po: !!this.settings.auto_po, scan_interval: this.scanInterval, mini_on_blur: this.settings.mini_on_blur === true, show_m5: this.settings.show_m5 !== false, trend_tf: 'M' + this.trendMinutes, trend_filter: !!this.settings.trend_filter,
        po_start_mode: this.settings.po_start_mode || 'last', tv_open: this.settings.tv_open === 'app' ? 'app' : 'external', po_last_mode: this.settings.po_last_mode || null,
        mini_count: Math.min(5, Math.max(1, Number(this.settings.mini_count) || 2)), mini_pos: this.settings.mini_pos || 'tr',
      },
    };
  }
}

module.exports = Engine;
