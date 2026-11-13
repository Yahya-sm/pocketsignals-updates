// Signal engine: pulls 1-minute candles for all selected PocketOption assets once per minute,
// runs the enabled strategies on closed candles and tracks each signal's result.
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const POClient = require('./po-client');
const strategies = require('./strategies');
const I = require('./indicators');
// Market-regime thresholds (settings, see I.regime).
const LAB = require('./lab');
// 13.11.2026 (Strategy Lab, user): only "Pin bar + Stochastic" stays from the old strategies; the rest is hidden (code stays).
const KEEP = ['n_levelstoch'];
const HIDDEN = strategies.list.filter(k => !KEEP.includes(k) && !LAB.STRAT[k]);
const RG_DEFAULTS = { rg_adx: 25, rg_slope: 0.08, rg_dist: 2, rg_range_adx: 25, rg_chaos_atr: 2, rg_spike: 3.5, rg_vol: 0.7 };
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
    // Until 1.0.57 a session without connection (no internet yet) was also marked "rejected" and then ignored for good.
    // 09.11.2026: demo logins rejected while the demo server was dead (since 27.10) would be ignored forever – forget them once.
    if (!this.config.demoUnreject1109) { this.config.rejected = (this.config.rejected || []).filter(x => !/"isDemo"\s*:\s*1/.test(x || '')); this.config.demoUnreject1109 = true; writeJson(this.configFile, this.config); }
    if (!this.config.rejectedReset) { this.config.rejected = []; this.config.rejectedReset = true; writeJson(this.configFile, this.config); }
    // 28.10.2026, the user's choice for every device: only "reversal at a level", medium values, corridor/beyond bans off,
    // impulse move 2 SD (measured: ~15–20 signals per 1.5 h on 14 pairs instead of 1); GBP/NZD pairs off (not tradable in PO).
    if (!this.settings.lr_soft_1028) {
      const s = this.settings, ss = (s.strategy_settings ||= {});
      ss.n_levelrev = { ...ss.n_levelrev, ...strategies.PRESETS.n_levelrev[1].values, lr_use_corridor: false, lr_use_beyond: false, lr_imp_move_sd: 2 };
      if (Array.isArray(s.pairs)) s.pairs = s.pairs.filter(p => !/GBP|NZD/.test(p));
      s.lr_soft_1028 = true;
      writeJson(this.settingsFile, s);
    }
    // V-reversal settings back to the new defaults (spike); the old multi-candle values gave junk signals.
    if (!this.settings.vrev_spike_1028) {
      if (this.settings.strategy_settings) delete this.settings.strategy_settings.n_vrev;
      this.settings.vrev_spike_1028 = true;
      writeJson(this.settingsFile, this.settings);
    }
    // Strategies removed from the program (29.10.2026) drop out of the enabled list.
    if (Array.isArray(this.settings.strategies)) this.settings.strategies = this.settings.strategies.filter(n => strategies.META[n] && !HIDDEN.includes(n));
    // 09.11.2026: the new trend strategy runs on S15 by default (user: entry on 15-second candles, expiry 1 min).
    if (!this.settings.strat_tfs?.n_trend15) { this.settings.strat_tfs = { ...this.settings.strat_tfs, n_trend15: ['S15'] }; writeJson(this.settingsFile, this.settings); }
    // 05.11.2026: "Trend pullback" is switched on once, on M1 (the user asked for it); switching it off later stays off.
    if (!this.settings.trendpull_on_1105) {
      const s = this.settings;
      s.strategies = [...new Set([...(s.strategies || []), 'n_trendpull'])];
      s.strat_tfs = { ...s.strat_tfs, n_trendpull: s.strat_tfs?.n_trendpull || ['M1'] };
      s.trendpull_on_1105 = true;
      writeJson(this.settingsFile, s);
    }
    // 06.11.2026: MA 2/5 got a new first level, so the saved old profiles 1–3 move up by one.
    if (!this.settings.ma25_presets_1106) {
      const s = this.settings;
      if (s.strat_presets?.n_ma25) s.strat_presets.n_ma25 = s.strat_presets.n_ma25.map(n => n + 1);
      s.ma25_presets_1106 = true;
      writeJson(this.settingsFile, s);
    }
    // Same general filters as on the user's PC (the phone still had the old stricter ones and gave no signals).
    if (!this.settings.pc_match_1028) {
      Object.assign(this.settings, { min_payout: 75, min_confirm: 1, min_strength: 60, trend_only: false, no_countertrend: false,
        max_per_scan: 17, signals_on: true, pause_until: 0, pc_match_1028: true });
      writeJson(this.settingsFile, this.settings);
    }
    // 13.11.2026 Strategy Lab: the 10 lab strategies + pin bar/Stochastic switched on once; manual mode, demo account.
    if (!this.settings.lab_1311) {
      const s = this.settings;
      s.strategies = [...new Set([...KEEP, ...Object.keys(LAB.STRAT)])];
      s.strat_tfs = { ...s.strat_tfs }; for (const k of Object.keys(LAB.STRAT)) s.strat_tfs[k] = ['M1'];
      s.trade_mode = 'SIGNAL_ONLY'; s.account = s.account || 'DEMO'; s.lab_1311 = true;
      writeJson(this.settingsFile, s);
    }
    if (Array.isArray(this.settings.strategies)) this.settings.strategies = this.settings.strategies.filter(n => strategies.META[n] && !HIDDEN.includes(n));
    LAB.setStale(this.settings.stale_sec);
    this.paramLogFile = path.join(DATA, 'param-log.json');
    this.paramLog = readJson(this.paramLogFile, []); // who, when, what: old → new (parameters and mode/account switches)
    this.signals = readJson(this.signalsFile, []);
    this.assets = new Map();     // symbol -> { symbol, name, type, payout, active, key, otc, category }
    this.candles = new Map();     // symbol -> closed candles
    this.trendCandles = new Map(); // "symbol|minutes" -> { at, candles } in a trend timeframe
    this.trendReq = new Map();     // request index -> { tf }
    this.ctxReq = new Map();       // request index -> { m } (M5/M15 history for multi-timeframe strategies)
    this.ctxCandles = new Map();   // symbol -> { M5, M15, at }
    this.secReq = new Map();       // request index -> { sec } for S10/S15/S30 candles
    this.lastEval = new Map();    // symbol -> time of last evaluated candle
    this.lastEvalBot = new Map(); // symbol -> last closed candle evaluated by the bot strategies
    this.scanSignals = [];        // PocketOption sends candles by itself right after the login, before the first scan
    this.pendingScan = [];
    this.status = 'start';
    // A demo session allows only one connection: ours kicked the PocketOption tab off (empty demo chart on the phone,
    // log "PO-Seite: getrennt … 1005" right after "Verbinde"). With a known real login the data goes over that one.
    // 09.11.2026: the demo server answers again (tested: login, candles, live prices, two connections at once) – quotes now go
    // over the demo session when there is one (user: not over the real account); the real login is only the fallback (demoDead).
    // Same evening (user screenshot): with our connection on the demo session the user's demo chart showed no candles, so the
    // real login is the default again; quotes over the demo session only with the setting quotes_demo.
    const rg = this.config.realGood, startDemo = /"isDemo"\s*:\s*1/.test(loadSsid(this.config) || '');
    this.po = startDemo && !this.settings.quotes_demo && rg && rg.ssid ? new POClient(rg.ssid, rg.url) : new POClient(loadSsid(this.config), this.config.poUrl);
    this.po.on('status', s => { this.status = s; this.emit('state'); });
    // Demo server fails or keeps dropping: back to the last working real login (same prices), until the app restarts.
    this.po.on('demoDead', () => {
      const lg = this.config.lastGood, real = this.config.realGood || (lg && lg.ssid && !/"isDemo"\s*:\s*1/.test(lg.ssid) ? lg : null);
      this.demoDead = true;
      if (real && real.ssid && real.ssid !== this.po.ssid) { this.po._log('Kurse jetzt über das Real-Konto (Demo-Server unzuverlässig)'); this.po.setSsid(real.ssid, real.url); }
    });
    this.po.on('assets', a => this._onAssets(a));
    this.po.on('history', h => this._onHistory(h));
    // Another PocketOption server worked than the stored one: remember it for the next start.
    this.po.on('server', url => { this.config.poUrl = url; writeJson(this.configFile, this.config); });
    // Live prices: PocketOption's candle history ends ~5 minutes before now, the newest minutes are built from these.
    this.ticks = new Map();      // symbol -> [[time, price], …] of the last ~15 minutes (real time)
    this.subscribed = new Set(); // pairs with live prices on this connection
    this.po.on('ticks', t => { this.ticks.set(t.asset, t.ticks.slice()); });
    this.po.on('stream', rows => { for (const [a, time, price] of rows) this._addTick(a, time, price); });
    this.po.on('ready', () => { this.subscribed.clear(); this.ticks.clear(); this._rememberGood(); this.scan(); });
    this.po.on('log', () => this.emit('state'));
  }

  // Own OTC candle history for later tests (user, 07.11.2026): closed M1 candles of the scanned OTC pairs, one CSV per UTC day
  // (symbol,time,open,high,low,close,payout). Prices only, no account data. Phone: the fs shim hands this to AndroidApp.recAppend.
  _recordOtc(sym, closed) {
    if (this.settings.otc_record === false || !/_otc$/i.test(sym)) return;
    this.otcLast ||= new Map(); this.otcRec ||= { rows: 0 };
    const last = this.otcLast.get(sym) || 0, payout = this.assets.get(sym)?.payout ?? '', days = {};
    let top = last, rows = 0;
    for (const k of closed) {
      if (k.time <= last) continue;
      const day = new Date(k.time * 1000).toISOString().slice(0, 10);
      days[day] = (days[day] || '') + [sym, k.time, k.open, k.high, k.low, k.close, payout].join(',') + '\n';
      top = Math.max(top, k.time); rows++;
    }
    if (!rows) return;
    try {
      const dir = path.join(DATA, 'otc'); fs.mkdirSync(dir, { recursive: true });
      for (const [day, text] of Object.entries(days)) fs.appendFileSync(path.join(dir, day + '.csv'), text);
      this.otcLast.set(sym, top); this.otcRec.rows += rows;
    } catch (e) { this.otcRec.error = String(e.message || e).slice(0, 120); }
  }

  // "Early impulse" journal (user, 08.11.2026): one line per settled signal, to find which second / size / pullback wins.
  // data/otc/imp-<UTC day>.csv (phone: same folder via recAppend, exported in the OTC zip). Prices only, no account data.
  _logImpulse(s) {
    try {
      const day = new Date(s.entryTime * 1000).toISOString().slice(0, 10), dir = path.join(DATA, 'otc');
      const row = [new Date(s.entryTime * 1000).toISOString().slice(0, 19), s.symbol, s.otc ? 1 : 0, s.dir + (s.im.fade ? '-fade' : ''), s.im.sec, s.im.atr, s.im.back,
        s.expiry, s.adx0 != null ? s.adx0.toFixed(1) : '', s.payout ?? '', s.result];
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, `imp-${day}.csv`), row.join(',') + '\n');
    } catch {}
  }

  // Reversal setups trade against the move by design: the general trend filter would drop nearly all of them.
  // They decide by their own structure (level side, vertical move), so the filter does not apply to them.
  _ownTrendLogic(sig) {
    return strategies.OWN_LOGIC.includes(sig.strategy);
  }

  _addTick(asset, time, price) {
    const t = this.ticks.get(asset); if (!t) return; // only after the pair's tick history arrived
    if (t.length && time <= t[t.length - 1][0]) return;
    t.push([time, price]);
    const cut = time - 15 * 60; let i = 0; while (i < t.length && t[i][0] < cut) i++;
    if (i) t.splice(0, i);
  }

  // History candles (period sec) completed with candles built from the live prices: the tick candles replace the
  // history from their second bucket on (the first one is usually incomplete). Without ticks: history unchanged.
  _withLive(asset, candles, sec) {
    const t = this.ticks.get(asset);
    if (!t || t.length < 2) return candles;
    const live = [];
    for (const [time, price] of t) {
      const b = Math.floor(time / sec) * sec, k = live[live.length - 1];
      if (k && k.time === b) { k.high = Math.max(k.high, price); k.low = Math.min(k.low, price); k.close = price; }
      else live.push({ time: b, open: price, high: price, low: price, close: price });
    }
    if (live.length < 2) return candles;
    const from = live[1].time;
    return [...candles.filter(k => k.time < from), ...live.slice(1)];
  }

  // A session that connected is kept as fallback for sessions taken over automatically from a login.
  _rememberGood() {
    clearTimeout(this.autoTimer);
    const good = { ssid: this.po.ssid, url: this.po.url || null };
    if (JSON.stringify(good) === JSON.stringify(this.config.lastGood)) return;
    this.config.lastGood = good;
    if (!/"isDemo"\s*:\s*1/.test(good.ssid || '')) this.config.realGood = good; // used for signals while PO shows demo
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
      // Only a session PocketOption actively rejected is bad. No connection (PC just woke up, no internet yet) is not
      // the session's fault – before, that replaced a good login by "none" and the app showed "session not set".
      if (this.po.authed || !this.po.denied) return;
      const bad = this.po.ssid;
      const back = this.config.lastGood && this.config.lastGood.ssid !== bad ? this.config.lastGood : { ssid: loadSsid({}), url: null };
      if (!back.ssid) { this.po._log('Übernommene Sitzung abgelehnt – keine andere gespeichert, bitte in PocketOption neu einloggen'); return; }
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
    // Live ADX on the running signal cards (user, 03.11.2026): every 5 s, so a fading trend is seen before entering.
    setInterval(() => { if (this._sampleAdx()) this.emit('state'); }, 5000);
    // Price against the signal during the countdown (user, 07.11.2026), once a second.
    setInterval(() => { if (this._samplePrice()) this.emit('state'); }, 1000);
  }

  // Countdown hint: how far the price already went in the signal's direction, in ATR of the signal candle.
  // Below 0.2 green, below 0.5 yellow, else red (first guesses, not tested: the app stores no tick history).
  // The colour at the entry second is stored, the result per colour is counted from that price (see _settleResults).
  _samplePrice() {
    const now = Date.now() / 1000; let changed = false, save = false;
    for (const s of this.signals.slice(0, 30)) {
      if (s.manual || s.result || s.entryZone || !s.atr0 || now >= s.entryTime + 10) { if (s.live) { delete s.live; changed = true; } continue; }
      const t = this.ticks.get(s.symbol), last = t && t[t.length - 1];
      if (!last || now - last[0] > 15) { if (s.live) { delete s.live; changed = true; } continue; }
      const off = +((last[1] - s.entryPrice) * (s.dir === 'CALL' ? 1 : -1) / s.atr0).toFixed(2);
      const zone = off < 0.2 ? 'green' : off < 0.5 ? 'yellow' : 'red';
      if (now >= s.entryTime) { s.entryZone = zone; s.entryOff = off; s.entryLive = last[1]; delete s.live; changed = save = true; }
      else if (!s.live || s.live.off !== off) { s.live = { off, zone }; changed = true; }
    }
    if (save) writeJson(this.signalsFile, this.signals);
    return changed;
  }

  // ADX 14 / +DI / −DI of the signal's pair on its timeframe, including the forming candle (live prices).
  liveAdx(sig) {
    const closed = this.candles.get(sig.symbol); if (!closed || closed.length < 30) return null;
    const now = Math.floor(Date.now() / 60000) * 60;
    const m1 = this._withLive(sig.symbol, closed, 60).filter(k => k.time <= now);
    const m = parseInt(String(sig.tf).slice(1), 10) || 1;
    const c = sig.tf[0] === 'S' ? m1 : I.resample(m1, m, true);
    const a = I.adx(c, 14)[c.length - 1];
    const rg = I.regime(c, c.length - 1, this.settings);
    // Trend on the signal's own timeframe (user, 04.11.2026: "show the trend on the card, M1 signal = M1 trend"):
    // EMA 9 above EMA 21, EMA 21 rising over 5 candles and price above EMA 21 = UP; the mirror = DOWN; else FLAT.
    const cl = c.map(k => k.close), e9 = I.ema(cl, 9), e21 = I.ema(cl, 21), L = c.length - 1;
    let trend = 'FLAT';
    if (e21[L] !== null && e21[L - 5] !== null) {
      if (e9[L] > e21[L] && e21[L] > e21[L - 5] && cl[L] > e21[L]) trend = 'UP';
      else if (e9[L] < e21[L] && e21[L] < e21[L - 5] && cl[L] < e21[L]) trend = 'DOWN';
    }
    return a ? { adx: +a.adx.toFixed(1), pdi: +a.pdi.toFixed(1), mdi: +a.mdi.toFixed(1), regime: rg ? rg.regime : null, trend } : null;
  }

  // Recommended expiry by technical analysis (v4, user 05.11.2026: "real TA – support, resistance, ADX, ATR").
  // All on the pair's M1 candles (~150):
  //  1. Support/resistance: swing highs/lows (2 candles each side), merged within 0.3 ATR, strength = touches.
  //     Target = the next level in the signal direction (resistance for CALL, support for PUT).
  //  2. ATR 14 = how far the price moves per minute. ADX/DI = how much of that is real progress: strong trend in the
  //     signal direction moves straight (efficiency 0.55), range zigzags (0.25), against the DI it is slower.
  //  3. Stochastic: already overbought for CALL / oversold for PUT = little fuel → shorter.
  //  Minutes = 60 % of the way to the level / (ATR × efficiency), 1…10, snapped to 1/2/3/5/10/15.
  //  Level closer than 0.4 ATR = the price will likely hit it soon → 1 min + warning.
  //  4. Check: the 30 most similar moments of the pair's history and how often each expiry won there.
  recExpiry(sig) {
    const closed = this.candles.get(sig.symbol); if (!closed || closed.length < 60) return null;
    const now = Math.floor(Date.now() / 60000) * 60;
    const c = this._withLive(sig.symbol, closed, 60).filter(k => k.time <= now);
    const L = c.length - 1, d = sig.dir === 'CALL' ? 1 : -1;
    const cl = c.map(k => k.close), e21 = I.ema(cl, 21), atrA = I.atr(c, 14), st = I.stoch(c, 14, 3), ad = I.adx(c, 14);
    const atr = atrA[L], price = cl[L], a = ad[L], k = st.k[L];
    if (!atr || !a || k == null) return null;
    // 1. Levels
    const piv = [];
    for (let j = Math.max(2, L - 140); j <= L - 2; j++) {
      let isH = true, isL = true;
      for (let q = j - 2; q <= j + 2; q++) { if (q === j) continue; if (c[q].high > c[j].high) isH = false; if (c[q].low < c[j].low) isL = false; }
      if (isH) piv.push(c[j].high); if (isL) piv.push(c[j].low);
    }
    piv.sort((x, y) => x - y);
    const lv = [];
    for (const p of piv) { const g = lv[lv.length - 1]; if (g && p - g.lo <= atr * 0.3) { g.hi = p; g.n++; g.sum += p; } else lv.push({ lo: p, hi: p, n: 1, sum: p }); }
    const levels = lv.map(g => ({ p: g.sum / g.n, n: g.n }));
    const ahead = levels.filter(x => (x.p - price) * d > atr * 0.1).sort((x, y) => Math.abs(x.p - price) - Math.abs(y.p - price));
    const behind = levels.filter(x => (price - x.p) * d > atr * 0.1).sort((x, y) => Math.abs(x.p - price) - Math.abs(y.p - price));
    const tgt = ahead.find(x => x.n >= 2) || ahead[0] || null;
    const dist = tgt ? Math.abs(tgt.p - price) / atr : 3; // in ATR; no level ahead = open space
    // 2. Efficiency from ADX / DI
    const diWith = d > 0 ? a.pdi > a.mdi : a.mdi > a.pdi;
    let eff = a.adx < 20 ? 0.25 : a.adx < 30 ? 0.4 : 0.55;
    if (!diWith) eff *= 0.6;
    // 3. Stochastic fuel
    const exhausted = d > 0 ? k > 80 : k < 20, fuel = d > 0 ? k < 20 : k > 80;
    let mins = Math.min(dist, 3) * 0.6 / eff;
    if (exhausted) mins *= 0.5;
    const close = dist < 0.4;
    if (close) mins = 1;
    mins = Math.min(Math.max(Math.round(mins), 1), 10);
    const snap = [1, 2, 3, 5, 10, 15].find(x => x >= mins) || 15;
    // 4. Check with the pair's history: similar moments, win rate per expiry
    const H = [1, 2, 3, 5, 10];
    const feat = i => (!atrA[i] || e21[i] == null || st.k[i] == null || !ad[i]) ? null
      : [st.k[i] / 50, (cl[i] - e21[i]) / atrA[i] / 2, (cl[i] - cl[i - 3]) / atrA[i] / 2, ad[i].adx / 50];
    const f0 = feat(L), nn = [];
    if (f0) {
      for (let i = 25; i <= L - 10; i++) { const f = feat(i); if (f) nn.push({ i, dd: f.reduce((s, v, j) => s + (v - f0[j]) ** 2, 0) }); }
      nn.sort((x, y) => x.dd - y.dd); nn.length = Math.min(nn.length, 30);
    }
    const rate = h => { let w = 0, n = 0; for (const { i } of nn) { const mv = (cl[i + h] - cl[i]) * d; if (mv) { n++; if (mv > 0) w++; } } return n ? Math.round(100 * w / n) : null; };
    const hist = nn.length >= 15 ? H.map(h => ({ h, p: rate(h) })) : [];
    const histAt = (hist.find(x => x.h === snap) || {}).p;
    const weak = histAt != null && histAt <= 50;
    // Text for the card (one line per factor)
    const dp = Math.max(0, Math.min(6, Math.ceil(-Math.log10(atr)) + 1)), fx = v => v.toFixed(dp);
    const r1 = v => v.toFixed(1);
    const lvName = { ru: d > 0 ? 'Сопротивление' : 'Поддержка', de: d > 0 ? 'Widerstand' : 'Unterstützung', en: d > 0 ? 'Resistance' : 'Support' };
    const bh = behind[0], bhName = { ru: d > 0 ? 'поддержка' : 'сопротивление', de: d > 0 ? 'Unterstützung' : 'Widerstand', en: d > 0 ? 'support' : 'resistance' };
    const T = (ru, de, en) => ({ ru, de, en });
    const lines = [
      tgt ? T(`${lvName.ru} ${fx(tgt.p)} — ${r1(dist)} ATR (касаний ${tgt.n})${close ? ' ⚠ вплотную' : ''}`, `${lvName.de} ${fx(tgt.p)} — ${r1(dist)} ATR (${tgt.n}× berührt)${close ? ' ⚠ ganz nah' : ''}`, `${lvName.en} ${fx(tgt.p)} — ${r1(dist)} ATR (${tgt.n} touches)${close ? ' ⚠ very close' : ''}`)
          : T(`${lvName.ru} впереди нет — свободный ход`, `Kein ${lvName.de} voraus – freier Raum`, `No ${lvName.en.toLowerCase()} ahead – open space`),
      bh ? T(`Позади ${bhName.ru} ${fx(bh.p)} (${r1(Math.abs(price - bh.p) / atr)} ATR)`, `Dahinter ${bhName.de} ${fx(bh.p)} (${r1(Math.abs(price - bh.p) / atr)} ATR)`, `Behind: ${bhName.en} ${fx(bh.p)} (${r1(Math.abs(price - bh.p) / atr)} ATR)`) : null,
      T(`ATR ${fx(atr)}/мин · ADX ${a.adx.toFixed(0)} ${diWith ? '✓ DI по сигналу' : '✗ DI против'} · ход ${Math.round(eff * 100)}%`,
        `ATR ${fx(atr)}/Min · ADX ${a.adx.toFixed(0)} ${diWith ? '✓ DI mit Signal' : '✗ DI dagegen'} · Fortschritt ${Math.round(eff * 100)}%`,
        `ATR ${fx(atr)}/min · ADX ${a.adx.toFixed(0)} ${diWith ? '✓ DI with signal' : '✗ DI against'} · progress ${Math.round(eff * 100)}%`),
      T(`Стохастик ${k.toFixed(0)}${exhausted ? ' — уже ' + (d > 0 ? 'перекуплен' : 'перепродан') + ', короче' : fuel ? ' — ' + (d > 0 ? 'перепродан' : 'перекуплен') + ', есть запас' : ''}`,
        `Stochastik ${k.toFixed(0)}${exhausted ? ' – schon ' + (d > 0 ? 'überkauft' : 'überverkauft') + ', kürzer' : fuel ? ' – ' + (d > 0 ? 'überverkauft' : 'überkauft') + ', Luft' : ''}`,
        `Stochastic ${k.toFixed(0)}${exhausted ? ' – already ' + (d > 0 ? 'overbought' : 'oversold') + ', shorter' : fuel ? ' – ' + (d > 0 ? 'oversold' : 'overbought') + ', room' : ''}`),
      hist.length ? T(`История пары: ${hist.map(x => x.h + 'м ' + x.p + '%').join(' · ')}${weak ? ' ⚠' : ''}`, `Verlauf: ${hist.map(x => x.h + 'm ' + x.p + '%').join(' · ')}${weak ? ' ⚠' : ''}`, `Pair history: ${hist.map(x => x.h + 'm ' + x.p + '%').join(' · ')}${weak ? ' ⚠' : ''}`) : null,
    ].filter(Boolean);
    const why = { ru: lines.map(x => x.ru).join('\n'), de: lines.map(x => x.de).join('\n'), en: lines.map(x => x.en).join('\n') };
    // Compact one-liner for the card (user 05.11.2026: card too tall); the full lines stay in the tooltip.
    const lvS = tgt ? `${d > 0 ? 'R' : 'S'} ${r1(dist)}ATR${close ? '⚠' : ''}` : `${d > 0 ? 'R' : 'S'} —`;
    const stS = `St ${k.toFixed(0)}${exhausted ? '⚠' : ''}`;
    const hS = histAt != null ? ` · ${snap}м ${histAt}%${weak ? '⚠' : ''}` : '';
    const short = `${lvS} · ADX ${a.adx.toFixed(0)}${diWith ? '✓' : '✗'} · ${stS}${hS}`;
    return { sec: snap * 60, weak, why, short: { ru: short, de: short.replace(/м /g, 'm '), en: short.replace(/м /g, 'm ') } };
  }
  // One sample per running signal (kept up to 2 min after expiry for the card); history = the last 36 samples (3 min).
  _sampleAdx() {
    const nowS = Date.now() / 1000; let any = false;
    this.adxHist ||= new Map();
    const run = this.signals.slice(0, 30).filter(s => !s.result && !s.manual && nowS < s.entryTime + s.expiry + 120);
    for (const s of run) {
      const v = this.liveAdx(s); if (!v) continue;
      const h = this.adxHist.get(s.id) || [];
      h.push(v.adx); if (h.length > 36) h.shift();
      this.adxHist.set(s.id, h);
      if (s.adx0 === undefined) s.adx0 = v.adx; // ADX when the signal came (first sample)
      s.adxLive = { ...v, hist: h.slice() }; any = true;
    }
    for (const id of this.adxHist.keys()) if (!run.some(s => s.id === id)) this.adxHist.delete(id);
    return any;
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
      (a.otc ? s.otc_po_on !== false : true)); // the OTC/real "market" select was removed (04.11.2026): the pair lists decide
  }

  scan() {
    if (!this.po.authed || this.settings.signals_on === false) return;
    this.scanStarted = Date.now();
    this.scanSignals = [];
    const list = this.selectedAssets();
    this.scanCount = list.length;
    // Every 10 minutes a line in the connection log: what is scanned and how many signals came (for comparing devices).
    if (!this.scanLogAt || Date.now() - this.scanLogAt > 600000) {
      const s = this.settings, mins = this.scanLogAt ? Math.round((Date.now() - this.scanLogAt) / 60000) : 0;
      this.po._log(`Scan: ${list.length} Paare (${this.assets.size} bekannt), Strategien ${(s.strategies || []).join(',')}, min. Auszahlung ${s.min_payout || 0}%`
        + (mins ? `, ${this.signalsLogged || 0} Signale in ${mins} min` : ''));
      this.scanLogAt = Date.now(); this.signalsLogged = 0;
    }
    // Live prices for every scanned pair (once per connection; the first answer brings the last ~10 minutes).
    list.filter(a => !this.subscribed.has(a.symbol)).forEach((a, i) => {
      this.subscribed.add(a.symbol);
      setTimeout(() => this.po.subscribe(a.symbol), i * 150);
    });
    // Spread the requests a little so the server is not flooded.
    list.forEach((a, i) => setTimeout(() => this.po.loadHistory(a.symbol, 60, 60 * 300), i * 40));
    // Trend candles in the trend timeframe itself (PocketOption sends at most ~150 candles per request,
    // too few one-minute candles for M10+). Fetched at most once a minute per pair.
    if (this.settings.show_m5 !== false || this.settings.trend_filter) {
      this.trendMinutes.filter(tm => tm > 1).forEach((tm, n) => list.forEach((a, i) => {
        const have = this.trendCandles.get(a.symbol + '|' + tm);
        if (have && Date.now() - have.at < 55000) return;
        setTimeout(() => { this.trendReq.set(this.po.loadHistory(a.symbol, tm * 60, tm * 60 * 60), { tf: tm }); }, list.length * 40 * (n + 1) + i * 40);
      }));
    }
    // M5 and M15 history for multi-timeframe strategies (150 candles each = 12.5 h / 37 h), at most once a minute.
    const st = strategies.paramsFor('n_strongtrend', this.settings), en = this.enabledStrategies();
    if (en.includes('n_deeprev') || en.includes('n_levelstoch') || en.includes('n_trend15') || (en.includes('n_strongtrend') && (st.st_use_m5 || st.st_use_m15))) {
      list.forEach((a, i) => {
        const have = this.ctxCandles.get(a.symbol);
        if (have && Date.now() - have.at < 55000) return;
        for (const m of [5, 15]) setTimeout(() => { this.ctxReq.set(this.po.loadHistory(a.symbol, m * 60, m * 60 * 150), { m }); }, list.length * 80 + i * 60 + (m === 15 ? 30 : 0));
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
    const hist = h.data.map(k => ({ time: k.time, open: k.open, high: k.high, low: k.low, close: k.close })).sort((a, b) => a.time - b.time);
    const closed = this._withLive(h.asset, hist, sec).filter(k => k.time + sec <= now);
    if (!closed.length) return;
    const last = closed[closed.length - 1].time, key = h.asset + '|' + sec;
    if (this.lastEval.get(key) === last || last < now - 3 * sec) return; // already done / stale
    const entry = Math.ceil(now / sec) * sec; // next full 10/15/30-second mark
    this.lastEval.set(key, last);
    const tf = 'S' + sec;
    // ctx: M5/M15 history (n_trend15 takes its trend from M5) plus the M1 history as a fallback.
    const cx = { ...(this.ctxCandles.get(h.asset) || {}), M1: this.candles.get(h.asset) };
    const a = this.assets.get(h.asset);
    for (const sig of strategies.evaluate({ [tf]: closed, ctx: cx, otc: !!(a && a.otc), asset: h.asset }, this.enabledStrategies(), this.settings)) {
      if (sig.strength < (this.settings.min_strength || 0)) continue;
      if (!this._ownTrendLogic(sig) && this._againstTrend(h.asset, sig.dir)) continue;
      this.scanSignals.push({ ...sig, asset: h.asset, candle: closed[closed.length - 1], entry });
    }
  }

  _onHistory(h) {
    if (!h || !h.asset || !Array.isArray(h.data)) return;
    const sreq = this.secReq.get(h.index);
    if (sreq) { this.secReq.delete(h.index); this._onSecondHistory(h, sreq.sec); return; }
    const creq = this.ctxReq.get(h.index);
    if (creq) { // M5/M15 history: closed candles only, the newest from the live prices
      this.ctxReq.delete(h.index);
      const sec = creq.m * 60, now = Date.now() / 1000;
      const c = h.data.map(k => ({ time: k.time, open: k.open, high: k.high, low: k.low, close: k.close })).sort((a, b) => a.time - b.time);
      const all = this._withLive(h.asset, c, sec).filter(k => k.time + sec <= now);
      const cur = this.ctxCandles.get(h.asset) || {};
      this.ctxCandles.set(h.asset, { ...cur, ['M' + creq.m]: all, at: Date.now() });
      return;
    }
    const req = this.trendReq.get(h.index);
    if (req) { // answer to a trend-timeframe request
      this.trendReq.delete(h.index);
      const c = h.data.map(k => ({ time: k.time, open: k.open, high: k.high, low: k.low, close: k.close })).sort((a, b) => a.time - b.time);
      this.trendCandles.set(h.asset + '|' + req.tf, { at: Date.now(), candles: this._withLive(h.asset, c, req.tf * 60) });
      return;
    }
    const nowMin = Math.floor(Date.now() / 60000) * 60;
    const hist = h.data
      .map(k => ({ time: k.time, open: k.open, high: k.high, low: k.low, close: k.close }))
      .sort((a, b) => a.time - b.time);
    if (hist.length > 1 && (hist[1].time - hist[0].time) % 60 !== 0) return; // not one-minute candles: ignore
    const all = this._withLive(h.asset, hist, 60); // newest minutes (and the forming one) from the live prices
    const closed = all.filter(k => k.time < nowMin);
    if (!closed.length) return;
    this._recordOtc(h.asset, closed);
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
    // Several timeframes (user, 07.11.2026): one contradicting timeframe is enough to drop the signal.
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
      byTf.ctx = this.ctxCandles.get(h.asset);
      byTf.otc = /_otc$/i.test(h.asset); byTf.asset = h.asset;
      // Stale-data limit = stale_sec on top of the scan interval (a closed candle is only seen at the next scan).
      LAB.setStale(Number(this.settings.stale_sec ?? 5) === 0 ? 0 : Number(this.settings.stale_sec ?? 5) + (this.scanInterval || 60));
      for (const sig of strategies.evaluate(byTf, names, this.settings)) {
        // The pin bar strategy has its own minimum score (pb_min_score) instead of the general minimum strength.
        if (!this._ownTrendLogic(sig) && sig.strength < (this.settings.min_strength || 0)) continue;
        if (!this._ownTrendLogic(sig) && this._againstTrend(h.asset, sig.dir)) continue;
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

  // Mini chart for every signal card (user 08.11.2026): last 24 candles of the chosen timeframe (mini_tf, 'off' = none),
  // built from the M1 history (300 candles) plus the signal candle. The strategy's own m5 is replaced so all cards match the setting.
  _miniChart(hist, s) {
    const tf = this.settings.mini_tf || 'M5'; if (tf === 'off' || !hist || hist.length < 10) return null;
    const m = parseInt(tf.slice(1), 10) || 5, c = hist.slice();
    if (s.candle && s.candle.time > c[c.length - 1].time && !(s.candle.time % 60)) c.push(s.candle);
    const out = (m === 1 ? c : I.resample(c, m, true)).slice(-24);
    if (out.length < 6) return null;
    // Last 120 M1 candles too, so the card can switch M1/M2/M3/M5/M15 itself (user 08.11.2026). [minute offset, o, h, l, c].
    const r = v => +v.toPrecision(7), m1 = c.slice(-120), t0 = m1[0].time;
    return { m5: out.map(k => [k.open, k.high, k.low, k.close]), m1: { t0, k: m1.map(k => [(k.time - t0) / 60, r(k.open), r(k.high), r(k.low), r(k.close)]) } };
  }

  _emitSignal(s) {
    const a = this.assets.get(s.asset) || { name: s.asset, type: '' };
    const entryTime = s.entry || s.candle.time + 60; // next candle start (S-timeframes set their own)
    const id = `${s.asset}-${s.strategy}-${s.tf}-${s.bar ?? entryTime}`; // entry "now" inside a candle: one signal per candle
    if (this.signals.some(x => x.id === id)) return;
    // Lab: setup key = strategy + asset + direction + formation candle; risk checks (payout, cooldown, daily limit).
    if (s.lab) {
      const key = LAB.setupKey(s);
      if (this.signals.some(x => x.setupKey === key)) return;
      const rb = LAB.riskCheck(s, this.signals, this.settings, a.payout);
      if (rb) { const d = LAB.lastDecisions(); d[s.strategy] = { status: rb.status, code: rb.reason, at: Date.now(), asset: s.asset }; return; }
      s.setupKey = key;
    }
    strategies.whyAdd(s.strategy, s.whyKey || id, 'delivered');
    const sig = {
      id, symbol: s.asset, name: a.name, otc: !!a.otc, payout: a.payout, dir: s.dir > 0 ? 'CALL' : 'PUT',
      strategy: s.strategy, strategyName: strategies.NAMES[s.strategy] || s.strategy, reason: s.reason, tf: s.tf, ...(s.model ? { model: s.model } : {}), ...(s.regime ? { regime: s.regime } : {}), ...(s.im ? { im: s.im } : {}),      strength: s.strength, expiry: s.expiry, entryTime, entryPrice: s.candle.close,
      tv: tvUrl(s.asset, a.type), tvSymbol: tvSymbol(s.asset, a.type), result: null, created: Date.now(),
      account: this.settings.account === 'REAL' ? 'REAL' : 'DEMO', tradeMode: this.settings.trade_mode || 'SIGNAL_ONLY',
    };
    if (s.lab) {
      // Entry window made for a human: at least 10 s for 1M, 20 s for 2M+ after the entry candle opens.
      Object.assign(sig, { lab: s.lab, setupKey: s.setupKey, expiresAt: entryTime + (s.expiry >= 120 ? 20 : 10) });
    }
    const hist0 = this.candles.get(s.asset), atr0 = hist0 && hist0.length > 15 ? I.atr(hist0, 14)[hist0.length - 1] : null;
    if (atr0 > 0) sig.atr0 = atr0;
    // Adaptive timeframe for the chart (structure, ADX, ATR on M1…M15; LAB.adaptiveTf).
    try { const at = hist0 && LAB.adaptiveTf(hist0, s.dir); if (at) sig.adTf = { tf: at.tf, why: at.why, all: at.all }; } catch {}
    try { const mc = this._miniChart(hist0, s); if (mc) { sig.m5 = mc.m5; sig.m1 = mc.m1; sig.miniTf = this.settings.mini_tf || 'M5'; } } catch {}
    const a0 = this.liveAdx(sig); if (a0) { sig.adx0 = a0.adx; sig.adxLive = { ...a0, hist: [a0.adx] }; }
    try { const re = this.recExpiry(sig); if (re) { sig.recExp = re.sec; sig.recWhy = re.why; sig.recWeak = re.weak; sig.recShort = re.short; } } catch {}
    // Smart expiry (11.11.2026): the recommended expiry becomes the card's expiry (results are settled on it too).
    if (this.settings.smart_exp && sig.recExp && !sig.recWeak) { sig.expBase = sig.expiry; sig.expiry = sig.recExp; }
    this.signals.unshift(sig); this.signalsLogged = (this.signalsLogged || 0) + 1;
    // The newest 300, plus the user's own trades (marked "taken") that are older – their statistics stay.
    this.signals = this.signals.slice(0, 300).concat(this.signals.slice(300).filter(x => x.mine).slice(0, 1000));
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
      if (s.paper && !s.paper.result && s.paper.price != null) { const dp = k.close - s.paper.price; s.paper.result = dp === 0 ? 'DRAW' : (dp > 0) === (s.dir === 'CALL') ? 'WIN' : 'LOSS'; s.paper.close = k.close; }
      if (s.im) this._logImpulse(s);
      if (s.entryLive != null) { const dz = k.close - s.entryLive; s.zoneResult = dz === 0 ? 'DRAW' : (dz > 0) === (s.dir === 'CALL') ? 'WIN' : 'LOSS'; }
    }
    if (changed) { writeJson(this.signalsFile, this.signals); this.emit('state'); }
  }

  // Trend timeframes in minutes, ascending (setting trend_tfs; older settings have one trend_tf; default M5).
  get trendMinutes() {
    const raw = Array.isArray(this.settings.trend_tfs) ? this.settings.trend_tfs : [this.settings.trend_tf || 'M5'];
    const ms = raw.map(x => parseInt(String(x).slice(1), 10)).filter(m => [1, 2, 3, 5, 10, 15, 30].includes(m));
    return ms.length ? [...new Set(ms)].sort((a, b) => a - b) : [5];
  }

  // Filter on: does any chosen timeframe point the other way? FLAT or no data does not filter.
  _againstTrend(symbol, dir) {
    if (!this.settings.trend_filter) return false;
    return this.trendMinutes.some(tm => { const tr = this.m5Trend(symbol, tm); return (tr === 'CALL' && dir < 0) || (tr === 'PUT' && dir > 0); });
  }

  // Direction on the trend timeframe: EMA 9 above EMA 21 with price above EMA 9 = CALL, the mirror = PUT, else FLAT.
  m5Trend(symbol, tm) {
    const own = this.trendCandles.get(symbol + '|' + tm);
    let tc;
    if (own) tc = own.candles;
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

  // Parameter journal: who, when, old → new (newest 1000).
  _logParam(scope, key, oldV, newV) {
    if (JSON.stringify(oldV) === JSON.stringify(newV)) return;
    this.paramLog.unshift({ at: Date.now(), who: 'user', scope, key, old: oldV ?? null, new: newV ?? null });
    this.paramLog = this.paramLog.slice(0, 1000);
    try { writeJson(this.paramLogFile, this.paramLog); } catch {}
  }

  // Broker history import (CSV/Excel-CSV/HTML table parsed in the UI into rows):
  // { time (s), asset, dir 'CALL'|'PUT', amount, expiry (s), result 'WIN'|'LOSS'|'DRAW', profit, demo }.
  // Each row is matched to a signal (same asset + direction, open time within created … expiresAt + tolerance);
  // otherwise it is kept as a trade outside signals. Already imported rows (same key) are skipped.
  importHistory(rows, account) {
    if (!Array.isArray(rows)) return { ok: false, error: 'err_json' };
    const tol = Number(this.settings.match_tolerance_sec ?? 10);
    let matched = 0, outside = 0, ambiguous = 0, skipped = 0;
    const norm = a => String(a || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/OTC$/, '_otc');
    for (const r of rows) {
      const t = Number(r.time), dir = /put|down|sell|вниз/i.test(r.dir) ? 'PUT' : 'CALL', sym = norm(r.asset);
      if (!t || !sym) { skipped++; continue; }
      const key = `imp-${sym}-${t}-${dir}-${r.amount || ''}`;
      if (this.signals.some(s => s.trade && s.trade.req === key)) { skipped++; continue; }
      const res = /win|выиг|gewinn|^\+/i.test(r.result) ? 'WIN' : /loss|проиг|verlust|^-/i.test(r.result) ? 'LOSS' : /draw|ничья|возврат|refund/i.test(r.result) ? 'DRAW' : (Number(r.profit) > 0 ? 'WIN' : Number(r.profit) < 0 ? 'LOSS' : null);
      const demo = r.demo != null ? !!r.demo : account !== 'REAL';
      const trade = { req: key, at: t, expiry: Number(r.expiry) || 60, amount: Number(r.amount) || 0, demo, dir, result: res, profit: Number(r.profit) || 0, source: 'import' };
      const cands = this.signals.filter(s => !s.manual && s.symbol.toUpperCase().replace(/[^A-Z0-9_]/g, '') === sym.toUpperCase() && s.dir === dir && !s.trade
        && t >= (s.created || 0) / 1000 - 5 && t <= (s.expiresAt ? s.expiresAt + tol : s.entryTime + s.expiry));
      const sig = cands.sort((x, y) => Math.abs(t - x.created / 1000) - Math.abs(t - y.created / 1000))[0];
      if (sig) { sig.mine = true; sig.trade = { ...trade, delay: Math.round(t - sig.created / 1000), ambiguous: cands.length > 1 }; matched++; if (cands.length > 1) ambiguous++; }
      else {
        this.signals.push({ id: `trade-${key}`, symbol: sym, name: sym.replace(/_otc$/, ' OTC'), otc: /_otc$/.test(sym), payout: null, dir, manual: true, mine: true,
          strategy: 'manual', strategyName: { ru: 'Вне сигналов', de: 'Außerhalb der Signale', en: 'Outside signals' }, reason: '', tf: '', strength: 0,
          expiry: trade.expiry, entryTime: t, entryPrice: null, result: res, created: t * 1000, trade });
        outside++;
      }
    }
    this.signals.sort((a, b) => (b.created || 0) - (a.created || 0));
    writeJson(this.signalsFile, this.signals); this.emit('state');
    return { ok: true, matched, outside, ambiguous, skipped };
  }

  // Backtest inside the app: the PC uses the recorded quotes (data/otc/*.csv) plus the loaded candles,
  // the phone only the loaded candles (~300 per pair). Returns the lab report per strategy.
  labBacktest(id, opt = {}) {
    if (!LAB.BY_ID[id] || !LAB.BY_ID[id].impl) return { ok: false, error: 'not_built' };
    const series = new Map();
    for (const [sym, c] of this.candles) series.set(sym, c.slice());
    try {
      const dir = path.join(DATA, 'otc'), files = fs.readdirSync(dir).filter(f => /^\d{4}-\d\d-\d\d\.csv$/.test(f)).sort().slice(-Number(opt.days || 14));
      const rec = new Map();
      for (const f of files) for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        const [sym, time, o, h, l, c] = line.split(','); if (!sym || !c) continue;
        (rec.get(sym) || rec.set(sym, new Map()).get(sym)).set(Number(time), { time: Number(time), open: +o, high: +h, low: +l, close: +c });
      }
      for (const [sym, m] of rec) { const old = series.get(sym) || []; for (const k of old) m.set(k.time, k); series.set(sym, [...m.values()].sort((a, b) => a.time - b.time)); }
    } catch {}
    const want = LAB.BY_ID[id].asset_type === 'OTC';
    const agg = { is: [], oos: [] }; let pairs = 0, candles = 0;
    for (const [sym, c] of series) {
      if (/_otc$/i.test(sym) !== want || c.length < 260) continue;
      pairs++; candles += c.length;
      const r = LAB.backtest(c.slice(-20000), id, { payout: (Number(opt.payout) || 80) / 100, expirySec: Number(opt.expiry) || undefined });
      for (const t of r.trades) (t.oos ? agg.oos : agg.is).push(t);
    }
    const sum = list => { const w = list.filter(x => x.res === 'WIN').length, n = list.filter(x => x.res !== 'DRAW').length; return { w, n, ci: LAB.wilson(w, n) }; };
    return { ok: true, id, pairs, candles, payout: Number(opt.payout) || 80, is: sum(agg.is), oos: sum(agg.oos), at: Date.now() };
  }

  // Paper trade on a lab signal: virtual entry at the current price, settled at expiry like the signal.
  paperTrade(id) {
    const s = this.signals.find(x => x.id === id); if (!s || s.paper) return;
    const t = this.ticks.get(s.symbol), price = t && t.length ? t[t.length - 1][1] : s.entryPrice;
    s.paper = { at: Math.floor(Date.now() / 1000), price, delay: Math.round(Date.now() / 1000 - s.created / 1000) };
    writeJson(this.signalsFile, this.signals); this.emit('state');
  }

  updateSettings(patch) {
    for (const k of ['account', 'trade_mode', 'strategies', 'risk_daily_loss_units', 'risk_max_trades', 'risk_max_losses', 'risk_min_payout', 'risk_stake_pct', 'cooldown_candles', 'daily_signal_limit', 'min_payout'])
      if (k in patch) this._logParam('settings', k, this.settings[k], patch[k]);
    Object.assign(this.settings, patch);
    if ('stale_sec' in patch) LAB.setStale(patch.stale_sec);
    writeJson(this.settingsFile, this.settings);
    if ('scan_interval' in patch) this.restartTimer();
    // Quotes back to the real login right away when the demo option is switched off (the demo chart gets its candles back).
    if ('quotes_demo' in patch && !patch.quotes_demo && /"isDemo"\s*:\s*1/.test(this.po.ssid || '')) {
      const lg = this.config.lastGood, real = this.config.realGood || (lg && lg.ssid && !/"isDemo"\s*:\s*1/.test(lg.ssid) ? lg : null);
      if (real && real.ssid) { this.po._log('Kurse über das Real-Konto (Demo-Chart bleibt frei)'); this.config.ssid = real.ssid; this.config.poUrl = real.url || null; writeJson(this.configFile, this.config); this.po.setSsid(real.ssid, real.url); }
    }
    this.emit('state');
  }

  // patch: parameter changes for one strategy; tfs: its timeframes.
  updateStrategy(name, patch, tfs, presets) {
    if (!strategies.META[name]) return;
    const s = this.settings;
    s.strategy_settings = s.strategy_settings || {};
    if (patch) for (const [k, v] of Object.entries(patch)) this._logParam(name, k, strategies.paramsFor(name, s)[k], v);
    if (patch) s.strategy_settings[name] = { ...(s.strategy_settings[name] || {}), ...patch };
    if (Array.isArray(presets)) { s.strat_presets = s.strat_presets || {}; s.strat_presets[name] = presets.filter(n => Number.isInteger(n)); }
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
    if (this.settings.strat_presets) delete this.settings.strat_presets[name];
    writeJson(this.settingsFile, this.settings);
    this.emit('state');
  }

  // url: the server the PocketOption page itself connected to (depends on account type and region).
  // Without it (session pasted by hand) the server is guessed from the session.
  // auto: taken over from the PocketOption login (may be rejected; see _watchAutoSession).
  setSsid(ssid, url, auto = false) {
    if (!ssid) return; // an empty field must never delete the stored login
    // The apps report the logged-in session on every PocketOption page load; only reconnect on change.
    // Same login and connected: keep the working server even if the page reports another one (it probes several).
    if (ssid === this.po.ssid && this.po.authed) return;
    if (auto && (this.config.rejected || []).includes(ssid)) { this.po._log('Login aus PocketOption erkannt, aber früher schon abgelehnt – ignoriert'); return; }
    // The demo server often breaks off (28.10.2026: no signals on the phone in demo). The prices are the same, so with a
    // known working real-account login the signals keep coming over that one; trading in the PO tab stays on demo.
    const demo = x => /"isDemo"\s*:\s*1/.test(x || ''), lg = this.config.lastGood;
    const real = this.config.realGood || (lg && lg.ssid && !demo(lg.ssid) ? lg : null);
    // Demo logins are used directly again (09.11.2026). Only if the demo server failed in this run, stay on the real login.
    if (auto && demo(ssid) && (this.demoDead || !this.settings.quotes_demo) && real && real.ssid) {
      // Our connection on the demo session empties the user's demo chart: the demo login stays with the PO window only.
      if (this.po.authed && !demo(this.po.ssid)) { this.po._log('Demo-Login erkannt – Kurse weiter über das Real-Konto (Demo-Chart bleibt frei)'); return; }
      this.po._log('Demo-Login erkannt – Kurse über das Real-Konto (Demo-Chart bleibt frei)');
      ssid = real.ssid; url = real.url;
      if (ssid === this.po.ssid && this.po.authed) return;
    }
    this.po._log(auto ? 'Login aus PocketOption übernommen' : 'Neue Sitzung eingetragen');
    if (auto && this.po.authed) this._rememberGood();
    this.config.ssid = ssid; this.config.poUrl = url || null; this.config.ssidAuto = auto;
    writeJson(this.configFile, this.config);
    this.po.setSsid(ssid, url);
    this._watchAutoSession();
  }

  clearSignals() { this.signals = this.signals.filter(s => s.mine); writeJson(this.signalsFile, this.signals); this.emit('state'); } // own trades stay

  // "My trades" reset: the marks are removed (the signals stay in the history and in the bot's statistics); counting starts anew.
  clearMine() {
    this.signals = this.signals.filter(s => !s.manual);
    for (const s of this.signals) { delete s.mine; delete s.trade; }
    writeJson(this.signalsFile, this.signals); this.emit('state');
  }

  // Real trades from the PocketOption page (user, 04.11.2026: "trades I entered with Buy/Sell go to My trades
  // automatically"). The page hook (Android AUTH_HOOK / Electron DevTools) passes the page's own socket messages:
  //   out 42["openOrder",{asset, amount, action:"call"|"put", isDemo, requestId, time}]   – the user pressed Buy/Sell
  //   in  successopenOrder {id, requestId, openPrice, openTimestamp, closeTimestamp, command, asset}
  //   in  successcloseOrder {deals:[{id, openPrice, closePrice, command, profit, …}]} (also updateClosedDeals: [deals])
  // A running signal of the same pair and direction becomes "mine" with the trade attached; a trade without a signal
  // is kept as its own entry (strategy "manual"). The result is the trade's own (close vs open price), not the signal's.
  poTrade(kind, d) {
    if (!d || typeof d !== 'object') return;
    const now = Date.now() / 1000;
    if (kind === 'openOrder') {
      const sym = String(d.asset || ''), dir = /put/i.test(d.action) ? 'PUT' : 'CALL', exp = Number(d.time) || 60;
      if (!sym) return;
      const key = String(d.requestId ?? `${sym}-${Math.floor(now)}`);
      if (this.signals.some(s => s.trade && s.trade.req === key)) return;
      const trade = { req: key, at: Math.floor(now), expiry: exp, amount: Number(d.amount) || 0, demo: !!d.isDemo, dir };
      // Lab signals: open time within created … expiresAt + 10 s; several candidates → the nearest, marked ambiguous.
      const cands = this.signals.filter(s => !s.manual && s.symbol === sym && s.dir === dir && !s.trade
        && now >= (s.created || 0) / 1000 - 5 && now < (s.expiresAt ? s.expiresAt + 10 : s.entryTime + s.expiry));
      const sig = cands.sort((x, y) => Math.abs(now - x.created / 1000) - Math.abs(now - y.created / 1000))[0];
      if (sig) { sig.mine = true; sig.trade = trade; trade.delay = Math.round(now - sig.created / 1000); if (cands.length > 1) trade.ambiguous = true; }
      else {
        const a = this.assets.get(sym) || { name: sym.replace(/_otc$/, ' OTC'), otc: /_otc$/.test(sym) };
        const t = this.ticks.get(sym), price = t && t.length ? t[t.length - 1][1] : null;
        this.signals.unshift({ id: `trade-${key}`, symbol: sym, name: a.name, otc: !!a.otc, payout: a.payout, dir, manual: true, mine: true,
          strategy: 'manual', strategyName: { ru: 'Своя сделка', de: 'Eigener Trade', en: 'Own trade' }, reason: '', tf: '',
          strength: 0, expiry: exp, entryTime: Math.floor(now), entryPrice: price, result: null, created: Date.now(), trade });
      }
      this.po._log(`Trade erkannt: ${dir} ${sym} ${exp}s${sig ? ' (Signal ' + sig.strategy + ')' : ''}`);
    } else if (kind === 'successopenOrder') {
      const s = this.signals.find(x => x.trade && (x.trade.req === String(d.requestId) || x.trade.id === d.id));
      if (!s) return;
      Object.assign(s.trade, { id: d.id, open: Number(d.openPrice) || s.trade.open });
      if (d.closeTimestamp && d.openTimestamp) s.trade.expiry = d.closeTimestamp - d.openTimestamp;
      if (s.manual && s.trade.open) s.entryPrice = s.trade.open;
    } else {
      const deals = Array.isArray(d) ? d : Array.isArray(d.deals) ? d.deals : d.id ? [d] : [];
      for (const x of deals) {
        const s = this.signals.find(y => y.trade && y.trade.id && y.trade.id === x.id); if (!s || s.trade.result) continue;
        const o = Number(x.openPrice) || s.trade.open, c = Number(x.closePrice);
        if (!o || !c) continue;
        const up = x.command === 1 ? false : x.command === 0 ? true : s.trade.dir === 'CALL';
        s.trade.result = c === o ? 'DRAW' : (c > o) === up ? 'WIN' : 'LOSS';
        Object.assign(s.trade, { open: o, close: c, profit: Number(x.profit) || 0 });
        if (s.manual) { s.result = s.trade.result; s.entryPrice = o; s.exitPrice = c; }
      }
    }
    writeJson(this.signalsFile, this.signals); this.emit('state');
  }

  // The user marks a signal as traded by themself ("taken"): their own statistics are counted from these.
  markMine(id, on) {
    const s = this.signals.find(x => x.id === id); if (!s) return;
    s.mine = !!on;
    writeJson(this.signalsFile, this.signals);
    this.emit('state');
  }

  state() {
    const done = this.signals.filter(s => s.result === 'WIN' || s.result === 'LOSS');
    const wins = done.filter(s => s.result === 'WIN').length;
    return {
      status: this.status, connected: this.po.authed, lastError: this.po.lastError || null, log: this.po.log.slice(-40),
      // What session is stored (never the session itself): shown under the session field.
      session: this.po.ssid ? { length: this.po.ssid.length, demo: /"isDemo"\s*:\s*1/.test(this.po.ssid) } : null, demo: /"isDemo"\s*:\s*1/.test(this.po.ssid || ''),
      otcRec: { rows: this.otcRec?.rows || 0, pairs: this.otcLast?.size || 0, error: this.otcRec?.error || null, dir: path.join(DATA, 'otc') },
      watching: this.selectedAssets().length, assetsKnown: this.assets.size,
      // Running signals carry the pair's current M5 trend (recomputed from the latest candles).
      signals: this.signals.map((s, i) => (i < 30 && !s.result ? { ...s, trends: this.trendMinutes.map(m => ({ tf: 'M' + m, dir: this.m5Trend(s.symbol, m) })).filter(x => x.dir) } : s)),
      stats: { total: done.length, wins, rate: done.length ? Math.round(100 * wins / done.length) : null },
      why: strategies.whyHour(), // "Why (last hour)": found / filtered / delivered per strategy
      lab: {
        catalog: LAB.CATALOG.map(c => ({ ...c, params: c.impl ? strategies.paramsFor(c.id, this.settings) : null })),
        decisions: LAB.lastDecisions(), stats: LAB.statsFor(this.signals),
        limits: LAB.manualLimits(this.signals, this.settings, this.settings.account === 'REAL' ? 'REAL' : 'DEMO'),
        paramLog: this.paramLog.slice(0, 100), risk: { ...LAB.RISK_DEFAULTS, ...LAB.COMMON, ...Object.fromEntries(Object.keys({ ...LAB.RISK_DEFAULTS, ...LAB.COMMON }).filter(k => this.settings[k] != null).map(k => [k, this.settings[k]])) },
        account: this.settings.account === 'REAL' ? 'REAL' : 'DEMO', mode: this.settings.trade_mode || 'SIGNAL_ONLY',
        notify_strats: this.settings.notify_strats || [], stale_sec: Number(this.settings.stale_sec ?? 5),
        latency: (() => { let best = null; for (const t of this.ticks.values()) { const x = t && t.length ? t[t.length - 1][0] : null; if (x) { const age = Date.now() - x * 1000; if (best === null || age < best) best = age; } } return best; })(),
      },
      settings: {
        strategies: this.settings.strategies || [], favorites: this.settings.favorite_strategies || [],
        allStrategies: strategies.list.filter(k => !HIDDEN.includes(k)).map(k => ({
          key: k, names: strategies.NAMES[k], type: strategies.META[k][1],
          params: strategies.paramsFor(k, this.settings), tfs: this.settings.strat_tfs?.[k] || ['M1'],
          presets: strategies.PRESETS[k] || [], groups: strategies.GROUPS[k] || null, tests: strategies.TESTS[k] || null, labels: strategies.LABELS[k] || null,
          activePresets: this.settings.strat_presets?.[k] || [], help: strategies.HELP[k] || null, log: null,
        })),
        strat_sounds: this.settings.strat_sounds || {},
        min_payout: this.settings.min_payout || 0, otc_po_on: this.settings.otc_po_on !== false,
        assets_off: this.settings.assets_off || [],
        markets: this.marketsForUi(), pairs: this.settings.pairs || [],
        min_strength: this.settings.min_strength || 0, max_per_scan: this.settings.max_per_scan || 0,
        market: this.settings.market || 'both', signals_on: this.settings.signals_on !== false, sound: this.settings.sound !== false, auto_po: !!this.settings.auto_po, regime_mode: this.settings.regime_mode || (this.settings.regime_filter ? 'auto' : 'off'),
        ...Object.fromEntries(Object.entries(RG_DEFAULTS).map(([k, d]) => [k, this.settings[k] ?? d])), chaos_skip: this.settings.chaos_skip !== false, po_click_toggle: this.settings.po_click_toggle !== false, scan_interval: this.scanInterval, mini_on_blur: this.settings.mini_on_blur === true, quick_trade: this.settings.quick_trade === true, quick_real: this.settings.quick_real === true, mini_tf: this.settings.mini_tf || 'M5', mkt_level: Number(this.settings.mkt_level) || 0, smart_exp: this.settings.smart_exp === true, quotes_demo: this.settings.quotes_demo === true, show_m5: this.settings.show_m5 !== false, trend_tfs: this.trendMinutes.map(m => 'M' + m), otc_record: this.settings.otc_record !== false, trend_filter: !!this.settings.trend_filter,
        po_start_mode: this.settings.po_start_mode || 'last', tv_open: this.settings.tv_open === 'app' ? 'app' : 'external', po_last_mode: this.settings.po_last_mode || null,
        mini_count: Math.min(5, Math.max(1, Number(this.settings.mini_count) || 2)), mini_pos: this.settings.mini_pos || 'tr',
      },
    };
  }
}

module.exports = Engine;
