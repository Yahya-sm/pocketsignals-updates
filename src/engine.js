// Signal engine: pulls 1-minute candles for all selected PocketOption assets once per minute,
// runs the enabled strategies on closed candles and tracks each signal's result.
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const POClient = require('./po-client');
const strategies = require('./strategies');
const I = require('./indicators');
const PAT = require('./patterns'); // pattern radar (21.11.2026)
// Market-regime thresholds (settings, see I.regime).
const LAB = require('./lab');
// 13.11.2026 (Strategy Lab, user): only "Pin bar + Stochastic" stays from the old strategies; the rest is hidden (code stays).
const KEEP = ['n_levelstoch', 'n_lsweather', 'n_market', 'n_trend15', 'n_sharp', 'n_deeprev', 'n_run', 'n_pin', 'n_spike5', 'n_tweezer']; // + its copy with market weather filters (14.11.2026)
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
      const st1 = LAB.CATALOG.filter(c => ['impulse', 'range', 'fractal', 'trap', 'overheat'].includes(c.impl)).map(c => c.id);
      s.strategies = [...new Set([...KEEP, ...st1])];
      s.strat_tfs = { ...s.strat_tfs }; for (const k of st1) s.strat_tfs[k] = ['M1'];
      s.trade_mode = 'SIGNAL_ONLY'; s.account = s.account || 'DEMO'; s.lab_1311 = true;
      writeJson(this.settingsFile, s);
    }
    // 13.11.2026 stage 2: the 18 further lab strategies switched on once, except the ones hardly tradable by hand
    // (Ludo 15 s, Fun 5 s, Volatility 25 s, Candle Bot at the minute's end); second-candle ones run on S5.
    if (!this.settings.lab2_1311) {
      const s = this.settings, risky = ['ludo', 'fun5s', 'volatility', 'candle_bot'];
      const fresh = LAB.CATALOG.filter(c => c.impl && !['impulse', 'range', 'fractal', 'trap', 'overheat'].includes(c.impl));
      s.strategies = [...new Set([...(s.strategies || []), ...fresh.filter(c => !risky.includes(c.impl)).map(c => c.id)])];
      s.strat_tfs = { ...s.strat_tfs }; for (const c of fresh) s.strat_tfs[c.id] = [LAB.SECOND_TF[c.impl] || 'M1'];
      s.lab2_1311 = true; writeJson(this.settingsFile, s);
    }
    if (Array.isArray(this.settings.strategies)) this.settings.strategies = this.settings.strategies.filter(n => strategies.META[n] && !HIDDEN.includes(n));
    // 13.11.2026: Settings → Strategies lists only favourites; at first every working strategy is a favourite (user:
    // the list was empty after the update). Unstarring later stays.
    if (!this.settings.fav_all_1311) {
      this.settings.favorite_strategies = [...new Set([...(this.settings.favorite_strategies || []), ...strategies.list.filter(k => !HIDDEN.includes(k))])];
      this.settings.fav_all_1311 = true; writeJson(this.settingsFile, this.settings);
    }
    // 14.11.2026: the new "pin bar + Stochastic + weather" copy appears in Settings → Strategies and is switched on to compare.
    if (!this.settings.lsw_1411) {
      const s = this.settings;
      s.favorite_strategies = [...new Set([...(s.favorite_strategies || []), 'n_lsweather'])];
      s.strategies = [...new Set([...(s.strategies || []), 'n_lsweather'])];
      s.strat_tfs = { ...s.strat_tfs, n_lsweather: ['M1'] };
      s.lsw_1411 = true; writeJson(this.settingsFile, s);
    }
    // 14.11.2026: "Рынок: цена пересекла скользящую" (n_market) back at the user's request – switched on + favourite once.
    if (!this.settings.mkt_1411) {
      const s = this.settings;
      s.favorite_strategies = [...new Set([...(s.favorite_strategies || []), 'n_market'])];
      s.strategies = [...new Set([...(s.strategies || []), 'n_market'])];
      if (!(s.strat_tfs || {}).n_market) s.strat_tfs = { ...s.strat_tfs, n_market: ['M1'] };
      s.mkt_1411 = true; writeJson(this.settingsFile, s);
    }
    // 14.11.2026: "Тренд M5 + вход на S15" (n_trend15, bounce from EMA 20 in the M5 trend) back at the user's request.
    if (!this.settings.t15_1411) {
      const s = this.settings;
      s.favorite_strategies = [...new Set([...(s.favorite_strategies || []), 'n_trend15'])];
      s.strategies = [...new Set([...(s.strategies || []), 'n_trend15'])];
      if (!(s.strat_tfs || {}).n_trend15) s.strat_tfs = { ...s.strat_tfs, n_trend15: ['S15'] };
      s.t15_1411 = true; writeJson(this.settingsFile, s);
    }
    // 21.11.2026: n_emastart removed (user) – the 15.11 migration that switched it on is gone; cleanup below.
    // 16.11.2026: "Глубокое падение/рост → отскок" (n_sharp) and "Разворот после глубокого падения" (n_deeprev) back at the
    // user's request – favourite + switched on once, M1 unless a timeframe was already set.
    if (!this.settings.deep_1611) {
      const s = this.settings;
      s.favorite_strategies = [...new Set([...(s.favorite_strategies || []), 'n_sharp', 'n_deeprev'])];
      s.strategies = [...new Set([...(s.strategies || []), 'n_sharp', 'n_deeprev'])];
      for (const k of ['n_sharp', 'n_deeprev']) if (!(s.strat_tfs || {})[k]) s.strat_tfs = { ...s.strat_tfs, [k]: ['M1'] };
      s.deep_1611 = true; writeJson(this.settingsFile, s);
    }
    // 16.11.2026: Pin bar 1 gave no signals on OTC (skip OTC + 7–21 UTC) – OTC and all hours on once, also in saved settings.
    if (!this.settings.ls_otc_1611) {
      const s = this.settings, ss = s.strategy_settings || {};
      s.strategy_settings = { ...ss, n_levelstoch: { ...(ss.n_levelstoch || {}), ls_no_otc: false, ls_hour_from: 0, ls_hour_to: 24 } };
      s.ls_otc_1611 = true; writeJson(this.settingsFile, s);
    }
    // 17.11.2026: the user's chosen settings – set once, only keys that are not set yet; the 4 strategies switched on;
    // old n_sharp keys (follow_move, min_adx, sharp_tr_min) removed.
    if (!this.settings.user_1711) {
      const s = this.settings, ss = { ...(s.strategy_settings || {}) };
      const want = {
        n_sharp: { sharp_on_trend: true, sharp_on_rev: false, sharp_expiry: 60, sharp_exp_adapt: true, sharp_tr_deep: 8, sharp_tr_opp: 1, sharp_tr_atr: 3, sharp_tr_new: 3, sharp_tr_adx: 25, sharp_tr_far: 1.5, sharp_tr_di: false, sharp_rv_adx: 0 },
        n_levelstoch: { ls_tf: 'M2', ls_m5_on: true, ls_m5_body: 0.5, expiry: 360 },
        n_deeprev: { dr_sell: true, dr_use_trend: false, dr_use_flat: false, dr_bear: 3, dr_late_atr: 0, dr_room: 0 },
        n_emastart: { es_tf: 'M3', es_period: 34, es_bars: 2, es_slope: 60, es_ma: 'EMA', es_mode: 'START', es_side: true, es_saw: 3, expiry: 180 },
      };
      for (const [k, v] of Object.entries(want)) { const cur = { ...(ss[k] || {}) }; for (const [a, b] of Object.entries(v)) if (!(a in cur)) cur[a] = b; ss[k] = cur; }
      if (ss.n_sharp) for (const a of ['follow_move', 'min_adx', 'sharp_tr_min']) delete ss.n_sharp[a];
      s.strategy_settings = ss;
      s.strategies = [...new Set([...(s.strategies || []), ...Object.keys(want)])];
      s.user_1711 = true; writeJson(this.settingsFile, s);
    }
    // 23.11.2026 (user): new strategy n_tweezer – favourite + switched on, M1.
    if (!this.settings.tweezer_2311) {
      const s = this.settings;
      s.favorite_strategies = [...new Set([...(s.favorite_strategies || []), 'n_tweezer'])];
      s.strategies = [...new Set([...(s.strategies || []), 'n_tweezer'])];
      s.strat_tfs = { ...s.strat_tfs }; if (!s.strat_tfs.n_tweezer) s.strat_tfs.n_tweezer = ['M1'];
      s.tweezer_2311 = true; writeJson(this.settingsFile, s);
    }
    // 19.11.2026: new n_run / n_pin – favourites only (not switched on), entry TF M1.
    if (!this.settings.runpin_1911) {
      const s = this.settings;
      s.favorite_strategies = [...new Set([...(s.favorite_strategies || []), 'n_run', 'n_pin'])];
      s.strat_tfs = { ...s.strat_tfs }; for (const n of ['n_run', 'n_pin']) if (!s.strat_tfs[n]) s.strat_tfs[n] = ['M1'];
      s.runpin_1911 = true; writeJson(this.settingsFile, s);
    }
    // 20.11.2026: new n_spike5 – favourites only (not switched on), strategy TF M1.
    if (!this.settings.spike5_2011) {
      const s = this.settings;
      s.favorite_strategies = [...new Set([...(s.favorite_strategies || []), 'n_spike5'])];
      s.strat_tfs = { ...s.strat_tfs }; if (!s.strat_tfs.n_spike5) s.strat_tfs.n_spike5 = ['M1'];
      s.spike5_2011 = true; writeJson(this.settingsFile, s);
    }
    // 19.11.2026 (user chose "stricter"): pin bar tail ≥ 50 %, no early signal – written once into saved settings too.
    if (!this.settings.pin_strict_1911) {
      const s = this.settings, ss = { ...(s.strategy_settings || {}) };
      ss.n_pin = { ...(ss.n_pin || {}), pn_tail: 50, pn_early: 0 };
      s.strategy_settings = ss; s.pin_strict_1911 = true; writeJson(this.settingsFile, s);
    }
    // 21.11.2026 (user, main PC): n_spike5 favourite + switched on, M5/M10/M15 on (only the two switches, other values kept).
    if (!this.settings.spike5_on_2111) {
      const s = this.settings, ss = { ...(s.strategy_settings || {}) };
      s.favorite_strategies = [...new Set([...(s.favorite_strategies || []), 'n_spike5'])];
      s.strategies = [...new Set([...(s.strategies || []), 'n_spike5'])];
      s.strat_tfs = { ...s.strat_tfs }; if (!s.strat_tfs.n_spike5) s.strat_tfs.n_spike5 = ['M1'];
      ss.n_spike5 = { ...(ss.n_spike5 || {}), sp_m5: true, sp_m10: true, sp_m15: true }; s.strategy_settings = ss;
      s.spike5_on_2111 = true; writeJson(this.settingsFile, s);
    }
    // 21.11.2026: Ludo back to its original settings – saved extra keys dropped, only the expiry stays.
    if (!this.settings.ludo_reset_2111) {
      const s = this.settings, ss = s.strategy_settings || {};
      if (ss.ludo_bot_otc) ss.ludo_bot_otc = { expiry: 60 };
      s.ludo_reset_2111 = true; writeJson(this.settingsFile, s);
    }
    // 23.11.2026 (user): Ludo became a swing strategy (support/resistance turns, S15–M5). Old Ludo keys (S5 micro, ludo_new
    // M1 series) are dropped once and an S5 timeframe becomes M1; whether it is switched on stays as the user had it.
    if (!this.settings.ludo_swing_2311) {
      const s = this.settings, ss = s.strategy_settings || {};
      if (ss.ludo_bot_otc) ss.ludo_bot_otc = {};
      const tf = s.strat_tfs && s.strat_tfs.ludo_bot_otc;
      if (tf) { const ok = (Array.isArray(tf) ? tf : [tf]).filter(x => ['S15', 'S30', 'M1', 'M2', 'M3', 'M4', 'M5'].includes(x)); s.strat_tfs = { ...s.strat_tfs, ludo_bot_otc: ok.length ? ok : ['M1'] }; }
      s.ludo_swing_2311 = true; writeJson(this.settingsFile, s);
    }
    // 21.11.2026: "Начало движения: наклон EMA" (n_emastart) removed – cleaned out of the switched-on and favourite lists.
    { const s = this.settings, no = l => (l || []).filter(k => k !== 'n_emastart');
      if ((s.strategies || []).includes('n_emastart') || (s.favorite_strategies || []).includes('n_emastart')) { s.strategies = no(s.strategies); s.favorite_strategies = no(s.favorite_strategies); s.es_1511 = true; writeJson(this.settingsFile, s); } }
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
    this.po.on('status', s => {
      this.status = s;
      // 21.11.2026 (user: "Session expired", opening PO did not help): a demo login from the PO tab was swapped for the stored
      // real-account login; when that one is dead, forget it and use the demo login the page gave us.
      const lg0 = this.config.lastGood, rg = this.config.realGood || (lg0 && lg0.ssid && !/"isDemo"\s*:\s*1/.test(lg0.ssid) ? lg0 : null);
      if (s === 'expired' && rg && rg.ssid === this.po.ssid && this._autoDemo) {
        this.realDead = true; this.po._log('Gespeicherter Real-Login abgelaufen – nehme den Login aus PocketOption');
        this.config.realGood = null; if (this.config.lastGood && this.config.lastGood.ssid === rg.ssid) this.config.lastGood = null;
        writeJson(this.configFile, this.config);
        const d = this._autoDemo; if (d && d.ssid !== this.po.ssid) setTimeout(() => this.setSsid(d.ssid, d.url, true), 0);
      }
      this.emit('state');
    });
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
    // 22.11.2026 (user): radar and patterns re-checked every 5 s on the live candles (state() recomputes both).
    setInterval(() => { this._sampleAdx(); this.emit('state'); }, 5000);
    setInterval(() => { try { this._watchdog(); } catch (e) {} }, 60000); // watchdog (22.11.2026), never breaks the engine
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
      this._due = Date.now() + ms;
      this.timer = setTimeout(() => { this.scan(); tick(); }, ms);
    };
    tick();
  }
  // Phone with the screen off (20.11.2026): Android WebView throttles JS timers in a hidden page, so the scan timer fires
  // minutes late. The app wakes JS every few seconds; if the planned scan is overdue, scan now and restart the timer.
  wakeScan() {
    if (this._due && Date.now() > this._due + 1500) { this.scan(); this.restartTimer(); }
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
    // 22.11.2026 (log: "0 pairs with fresh candles, 22 delayed"): PocketOption streams live prices for one pair at a time, so
    // after the one-off subscription every other pair's prices stopped. Re-subscribe each pair whose newest price is older
    // than 20 s (at most every 15 s per pair) – each answer brings its last ~10 minutes of prices again.
    // 22.11.2026 (1.0.231: the user's PO chart stopped loading): on the demo session the PO tab uses too, frequent
    // changeSymbol empties the user's chart (seen 09.11 too) – there only the one-off subscription, as before.
    this._subAt = this._subAt || new Map();
    const nowS = Date.now() / 1000, shared = /"isDemo"\s*:\s*1/.test(this.po.ssid || '');
    list.filter(a => {
      const t = this.ticks.get(a.symbol), last = t && t.length ? t[t.length - 1][0] : 0;
      return !this.subscribed.has(a.symbol) || (!shared && nowS - last > 20 && Date.now() - (this._subAt.get(a.symbol) || 0) > 120000);
    }).filter((a, i, arr) => !this.subscribed.has(a.symbol) || arr.slice(0, i + 1).filter(b => this.subscribed.has(b.symbol)).length <= 3).forEach((a, i) => { // 22.11.2026: re-subscribe a stale pair at most every 2 min, max 3 per scan
      this.subscribed.add(a.symbol); this._subAt.set(a.symbol, Date.now());
      setTimeout(() => this.po.subscribe(a.symbol), i * 150);
    });
    // Spread the requests a little so the server is not flooded.
    list.forEach((a, i) => setTimeout(() => this.po.loadHistory(a.symbol, 60, 60 * 300), i * 40));
    // Trend candles in the trend timeframe itself (PocketOption sends at most ~150 candles per request,
    // too few one-minute candles for M10+). Fetched at most once a minute per pair.
    // + the radar's trend TF (radar_ttf, user 21.11.2026) so M10/M15 trends work in the radar too.
    const rtf = this.settings.radar_on !== false ? Number(this.settings.radar_ttf) || 5 : 0;
    const ptf = this.settings.pat_on === false ? 1 : this.patTf(); // pattern timeframe M2–M5 (22.11.2026): 150 own candles, patterns need ~110
    const tms = (this.settings.show_m5 !== false || this.settings.trend_filter ? this.trendMinutes : []).concat(rtf && !this.trendMinutes.includes(rtf) ? [rtf] : (rtf && !(this.settings.show_m5 !== false || this.settings.trend_filter) ? [rtf] : [])).concat(ptf > 1 ? [ptf] : []).concat(this.settings.radar_on !== false || this.settings.pat_on !== false ? [15] : []).concat(this.settings.pat_on !== false && this.settings.tw_trend_on ? [this.twTf()] : []); // M15 trend arrow (22.11.2026)
    if (tms.length) {
      [...new Set(tms)].filter(tm => tm > 1).forEach((tm, n) => list.forEach((a, i) => {
        const have = this.trendCandles.get(a.symbol + '|' + tm);
        if (have && Date.now() - have.at < 55000 && (tm !== ptf || have.candles.length >= 120)) return;
        const cnt = tm === ptf ? 150 : 60;
        setTimeout(() => { this.trendReq.set(this.po.loadHistory(a.symbol, tm * 60, tm * 60 * cnt), { tf: tm }); }, list.length * 40 * (n + 1) + i * 40);
      }));
    }
    // M5 and M15 history for multi-timeframe strategies (150 candles each = 12.5 h / 37 h), at most once a minute.
    const st = strategies.paramsFor('n_strongtrend', this.settings), en = this.enabledStrategies();
    if (en.includes('n_deeprev') || en.includes('n_levelstoch') || en.includes('n_lsweather') || en.includes('n_trend15') || en.includes('n_emastart') || en.includes('n_run') || en.includes('n_pin') || (en.includes('n_strongtrend') && (st.st_use_m5 || st.st_use_m15))) {
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
      if (!sig.lab && sig.strength < (this.settings.min_strength || 0)) continue;
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
    // Server clock (19.11.2026): offset = max over pairs (last tick time − PC time), limited to ±60 s.
    const tk = this.ticks.get(h.asset);
    if (tk && tk.length) { this._clk = this._clk || {}; this._clk[h.asset] = tk[tk.length - 1][0] * 1000 - Date.now(); strategies.setClockOffset(Math.max(-60000, Math.min(60000, Math.max(...Object.values(this._clk))))); }
    const nowMin = Math.floor(strategies.serverNow() / 60) * 60;
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
    // 21.11.2026 (user): signal cards switched off (☑ Карточки) = no strategy scanning at all; candles still load for the radar.
    const enabled = this.settings.cards_off ? [] : this.enabledStrategies();
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
    // 23.11.2026 (user): signal selection for every strategy – minimum score (50 weak / 70 working / 85 strong) and at most
    // sig_per_hour signals in the last 60 min (0 = no limit); the strongest go first.
    const minSc = Number(this.settings.sig_score_min ?? 50) || 0, perHour = Number(this.settings.sig_per_hour) || 0;
    let lastHour = perHour ? this.signals.filter(x => !x.manual && Date.now() - (x.created || 0) < 3600000).length : 0;
    // 23.11.2026 (user): cleanliness = how straight the price went over the last sig_clean_n M1 candles:
    // |net move| / sum of candle bodies (100 % = all one colour, low = saw). sig_clean_min 0 = off.
    const cleanMin = Number(this.settings.sig_clean_min) || 0, cleanN = Math.max(3, Math.min(30, Number(this.settings.sig_clean_n) || 10));
    for (const s of (this.scanSignals || []).sort((a, b) => b.strength - a.strength)) {
      const entry = s.entry || s.candle.time + 60;
      if ((Number(s.strength) || 0) < minSc) continue;
      if (cleanMin) { const er = this._cleanness(s.asset, cleanN); if (er != null && er < cleanMin) continue; }
      if (perHour && lastHour >= perHour) continue;
      if (this.signals.filter(x => x.entryTime === entry).length >= max) continue;
      lastHour++;
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
    if (s.strategy === 'n_deeprev' && this.signals.some(x => x.strategy === s.strategy && x.symbol === s.asset && x.dir === (s.dir > 0 ? 'CALL' : 'PUT') && Date.now() - (x.created || 0) < 30 * 60000)) return;
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
      this._tally(s);
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
    const generic = !LAB.BY_ID[id] && strategies.META[id] && !HIDDEN.includes(id); // old strategies, e.g. pin bar + Stochastic
    if (!generic && (!LAB.BY_ID[id] || !LAB.BY_ID[id].impl)) return { ok: false, error: 'not_built' };
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
    const want = generic ? null : LAB.BY_ID[id].asset_type === 'OTC';
    const agg = { is: [], oos: [] }; let pairs = 0, candles = 0;
    for (const [sym, c] of series) {
      if ((want !== null && /_otc$/i.test(sym) !== want) || c.length < 260) continue;
      pairs++; candles += c.length;
      if (generic) { for (const t of this._genericBacktest(c.slice(-20000), id, sym, opt)) (t.oos ? agg.oos : agg.is).push(t); continue; }
      const r = LAB.backtest(c.slice(-20000), id, { payout: (Number(opt.payout) || 80) / 100, expirySec: Number(opt.expiry) || undefined });
      for (const t of r.trades) (t.oos ? agg.oos : agg.is).push(t);
    }
    const sum = list => { const w = list.filter(x => x.res === 'WIN').length, n = list.filter(x => x.res !== 'DRAW').length; return { w, n, ci: LAB.wilson(w, n) }; };
    return { ok: true, id, pairs, candles, payout: Number(opt.payout) || 80, is: sum(agg.is), oos: sum(agg.oos), at: Date.now() };
  }

  // Backtest of an old strategy (pin bar + Stochastic …) through strategies.evaluate with the user's settings:
  // decision on the last 300 closed M1 candles (+ M15 built from them), entry at the next open, exit at the close of
  // the candle where the expiry ends; first 70 % in-sample, rest out-of-sample.
  _genericBacktest(c, id, sym, opt) {
    const st = { ...this.settings, strat_tfs: { ...this.settings.strat_tfs, [id]: ['M1'] }, chaos_skip: this.settings.chaos_skip };
    const cut = Math.floor(c.length * 0.7), out = [], otc = /_otc$/i.test(sym);
    let next = 0;
    for (let i = 300; i < c.length - 16; i++) {
      if (i < next) continue;
      const w = c.slice(i - 299, i + 1);
      let r; try { r = strategies.evaluate({ M1: w, ctx: { M15: I.resample(w, 15), M5: I.resample(w, 5), M1: w }, otc, asset: sym }, [id], st)[0]; } catch { r = null; }
      if (!r) continue;
      const expC = Math.max(1, Math.round((Number(opt.expiry) || r.expiry || 60) / 60)); if (i + expC >= c.length) break;
      const m = (c[i + expC].close - c[i + 1].open) * (r.dir > 0 ? 1 : -1);
      out.push({ res: m > 0 ? 'WIN' : m < 0 ? 'LOSS' : 'DRAW', oos: i >= cut });
      next = i + 1 + 2;
    }
    return out;
  }

  // Paper trade on a lab signal: virtual entry at the current price, settled at expiry like the signal.
  paperTrade(id) {
    const s = this.signals.find(x => x.id === id); if (!s || s.paper) return;
    const t = this.ticks.get(s.symbol), price = t && t.length ? t[t.length - 1][1] : s.entryPrice;
    s.paper = { at: Math.floor(Date.now() / 1000), price, delay: Math.round(Date.now() / 1000 - s.created / 1000) };
    writeJson(this.signalsFile, this.signals); this.emit('state');
  }

  // Lasting per-strategy signal results (user 15.11.2026: the Catalog shows win rate / n for every strategy, kept when the
  // strategy is switched off). The signals list keeps only the newest 300, so results are also counted here:
  // data/strat-stats.json {strategy: {w, n, last: [1/0 newest first, ≤ 50]}}. Seeded once from the stored signals.
  _tallyLoad() {
    if (this.stratTally) return;
    this.stratTallyFile = path.join(DATA, 'strat-stats.json');
    this.stratTally = readJson(this.stratTallyFile, null);
    if (!this.stratTally) {
      this.stratTally = {};
      for (const s of this.signals.slice().reverse()) this._tally(s, true);
      writeJson(this.stratTallyFile, this.stratTally);
    }
  }
  _tally(s, seeding) {
    if (!seeding) this._tallyLoad();
    if (!s || s.manual || !s.strategy || (s.result !== 'WIN' && s.result !== 'LOSS')) return;
    const b = (this.stratTally[s.strategy] ||= { w: 0, n: 0, last: [] });
    b.n++; if (s.result === 'WIN') b.w++; b.last.unshift(s.result === 'WIN' ? 1 : 0); if (b.last.length > 50) b.last.length = 50;
    if (!seeding) writeJson(this.stratTallyFile, this.stratTally);
  }
  _labStats() {
    this._tallyLoad();
    const st = LAB.statsFor(this.signals);
    for (const [k, b] of Object.entries(this.stratTally)) if (!st[k] || !st[k].signals || st[k].signals.n <= b.n) (st[k] ||= {}).signals = b;
    return st;
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
    const known = ['strategy_settings', 'strategies', 'strat_tfs', 'pairs', 'min_strength', 'max_per_scan', 'min_payout', 'market', 'assets_off', 'favorite_strategies', 'radar_on', 'pat_on', 'radar_auto', 'pat_auto', 'pat_pre', 'tw_trend_on', 'tw_trend_tf', 'pat_sold_atr', 'pat_sold_big', 'pat_sold_rev', 'radar_n', 'radar_x', 'radar_k', 'radar_dn', 'radar_ttf', 'radar_atr', 'radar_pay', 'pat_ids', 'pat_fav', 'pat_atr_on', 'pat_atr', 'pat_adx_on', 'pat_adx', 'pat_alert', 'pat_sound', 'radar_alert', 'radar_sound', 'pat_tf', 'sig_score_min', 'sig_per_hour', 'sig_clean_min', 'sig_clean_n'];
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
    if (auto && demo(ssid)) this._autoDemo = { ssid, url };
    if (auto && demo(ssid) && !this.realDead && !(real && real.ssid === this.po.ssid && (this.po.denied || this.status === 'expired')) && (this.demoDead || !this.settings.quotes_demo) && real && real.ssid) {
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

  // Radar of active pairs (user 20.11.2026): no signal, only where big candles are now. Big = body at least radar_x x the
  // pair's usual candle (mean high–low of the 120 closed M1 candles before the window); the window is the last radar_n
  // closed M1 candles; listed when at least radar_k of them are big. Sorted by the number of big candles, then by size.
  // Radar trend on the chosen TF: EMA 9/21 like m5Trend, but needs only 22 candles of that TF (M15 from M1 history).
  radarTrend(symbol, tm, c) {
    const own = this.trendCandles.get(symbol + '|' + tm), tc = own ? own.candles : I.resample(c, tm);
    if (!tc || tc.length < 22) return null;
    const close = tc.map(k => k.close), f = I.ema(close, 9), sl = I.ema(close, 21), i = close.length - 1;
    return f[i] > sl[i] && close[i] > f[i] ? 'CALL' : f[i] < sl[i] && close[i] < f[i] ? 'PUT' : 'FLAT';
  }

  // ATR(14) of M1 as % of price (user 21.11.2026): comparable between pairs; radar_atr = minimum, 0 = off.
  radarAtr(c) { if (!c || c.length < 20) return 0; const a = I.atr(c, 14), v = a[a.length - 1], p = c[c.length - 1].close; return v > 0 && p > 0 ? +(100 * v / p).toFixed(3) : 0; }

  // 22.11.2026 (user: patterns must be fresh on M1): the stored candles come from the history, which ends ~5 min before now;
  // the newest closed minutes are rebuilt from the live prices here (like the strategies get them). Null = no fresh data.
  _freshM1(sym) {
    const base = this.candles.get(sym); if (!base || !base.length) return null;
    const nowS = Date.now() / 1000, nowMin = Math.floor(nowS / 60) * 60;
    const c = this._withLive(sym, base, 60).filter(k => k.time < nowMin);
    if (!c.length || nowS - c[c.length - 1].time > 180) return null; // last closed minute older than ~2 min: lagging
    return c;
  }
  // 22.11.2026 (user): watchdog. Every minute: connection, fresh candles, login, scan. Careful by design – it only
  // (a) reconnects OUR quote socket the same way the wake-up does, (b) nudges an overdue scan, (c) on the real quote
  // login re-subscribes pairs once when no pair has fresh candles. It never touches the PO tab, the sessions, the
  // settings, and never re-subscribes on the demo session the PO tab shares. Everything else = a warning to the user.
  _watchdog() {
    const W = this._wd = this._wd || { offSince: 0, staleSince: 0, tries: 0, last: {} }, now = Date.now(), p = this.po;
    const warn = (kind, ru, de) => {
      if (now - (W.last[kind] || 0) < 15 * 60000) return; W.last[kind] = now;
      this.watch = { id: now, kind, ru, de }; p._log('⚠ Wächter: ' + de); this.emit('state');
    };
    if (!p.ssid) return warn('nossid', 'Нет входа в PocketOption — откройте вкладку PO и войдите', 'Kein PocketOption-Login – PO-Tab öffnen und anmelden');
    if (this.status === 'expired') return warn('expired', 'Вход истёк — откройте вкладку PO и войдите заново', 'Login abgelaufen – im PO-Tab neu anmelden');
    if (!p.authed) {
      W.offSince = W.offSince || now;
      if (now - W.offSince > 2 * 60000 && (!p.ws || p.ws.readyState > 1) && W.tries < 3) { W.tries++; p._log(`Wächter: keine Verbindung seit ${Math.round((now - W.offSince) / 60000)} min – verbinde neu (${W.tries}/3)`); p.connect(); }
      if (now - W.offSince > 8 * 60000) warn('offline', 'Нет связи с PocketOption больше 8 мин, переподключение не помогло', 'Seit über 8 min keine Verbindung, Neuverbinden half nicht');
      return;
    }
    W.offSince = 0; W.tries = 0;
    if (this._due && now - this._due > 2 * 60000) { p._log('Wächter: Scan überfällig – starte ihn'); try { this.wakeScan(); } catch (e) {} }
    const fresh = this._freshN || 0, lag = this._lagN || 0, shared = /"isDemo"\s*:\s*1/.test(p.ssid || '');
    if (lag && !fresh) {
      W.staleSince = W.staleSince || now;
      if (now - W.staleSince > 5 * 60000) {
        if (!shared && !W.resubAt) { W.resubAt = now; p._log('Wächter: keine frischen Kerzen seit 5 min – Paare neu abonniert'); this.subscribed.clear(); }
        if (shared) warn('stale', 'Свечи не обновляются: котировки идут через демо-вход. Зайдите один раз в реальный счёт во вкладке PO и вернитесь на демо', 'Keine frischen Kerzen: Kurse über die Demo-Sitzung – einmal im PO-Tab ins Real-Konto wechseln');
        else if (now - W.resubAt > 3 * 60000) warn('stale', 'Свечи не обновляются больше 8 мин, повторная подписка не помогла', 'Seit über 8 min keine frischen Kerzen, Neu-Abo half nicht');
      }
    } else { W.staleSince = 0; W.resubAt = 0; }
  }

  _cleanness(sym, n) { // % 0–100 over the last n closed M1 candles, null = no candles
    const c = (this._freshM1 && this._freshM1(sym)) || this.candles.get(sym); if (!c || c.length < n) return null;
    const seg = c.slice(-n), path = seg.reduce((a, k) => a + Math.abs(k.close - k.open), 0);
    return path > 0 ? Math.round(100 * Math.abs(seg[n - 1].close - seg[0].open) / path) : 0;
  }
  patTf() { const v = Number(this.settings.pat_tf) || 1; return [1, 2, 3, 4, 5].includes(v) ? v : 1; }
  // Closed candles of the pattern timeframe with the newest bars rebuilt from live prices; null = no fresh data.
  _patCandles(sym, tf) {
    if (tf === 1) return this._freshM1(sym);
    const own = this.trendCandles.get(sym + '|' + tf); if (!own || !own.candles.length) return null;
    const sec = tf * 60, nowS = Date.now() / 1000, bar = Math.floor(nowS / sec) * sec;
    const c = this._withLive(sym, own.candles, sec).filter(k => k.time < bar);
    const t = this.ticks.get(sym), lastTick = t && t.length ? t[t.length - 1][0] : 0;
    if (!c.length || bar - c[c.length - 1].time > sec + 5 || nowS - lastTick > 120) return null; // last closed bar missing or no live prices
    return c;
  }

  _logFresh(fresh, lag) {
    this._freshN = fresh; this._lagN = lag;
    if (Date.now() - (this._freshLogAt || 0) < 5 * 60000) return; this._freshLogAt = Date.now();
    this.po._log(`Radar: ${fresh} Paare mit frischen Kerzen, ${lag} verzögert (ohne Live-Kurse – ausgeblendet)`
      + (lag && /"isDemo"\s*:\s*1/.test(this.po.ssid || '') ? ' – Kurse laufen über die Demo-Sitzung des PO-Tabs; für frische Kurse einmal im PO-Tab ins Real-Konto wechseln' : ''));
  }

  radar() {
    // 22.11.2026 (user): radar switchable – off = nothing computed, no trend candles loaded, no sound.
    if (this.settings.radar_on === false) { this._freshN = 0; this._lagN = 0; return { on: false, alert: false, list: [], n: 10, x: 1, k: 3, pay: 0, ttf: 5, atr: 0, dn: 10 }; }
    const s = this.settings, N = Math.max(3, Math.min(60, Number(s.radar_n) || 10)), X = Number(s.radar_x) || 1, K = Math.max(1, Number(s.radar_k) || 3), PAY = Math.max(0, Number(s.radar_pay) || 0), TTF = [2, 3, 4, 5, 10, 15].includes(Number(s.radar_ttf)) ? Number(s.radar_ttf) : 5, ATR = Math.max(0, Number(s.radar_atr) || 0), DN = Math.max(1, Math.min(60, Number(s.radar_dn) || N)); // radar_dn: candles for the first arrow // radar_pay: minimum payout % (user 21.11.2026)
    const out = []; let nFresh = 0, nLag = 0;
    for (const a of this.selectedAssets()) {
      if (PAY && !(Number(a.payout) >= PAY)) continue;
      if (!this.candles.get(a.symbol)) continue;
      const c = this._freshM1(a.symbol); if (!c) { nLag++; continue; } nFresh++;
      if (c.length < N + 60) continue;
      const atr = this.radarAtr(c); if (ATR && atr < ATR) continue;
      const w = c.slice(-N), base = c.slice(Math.max(0, c.length - N - 120), c.length - N);
      const avg = base.reduce((t, k) => t + k.high - k.low, 0) / base.length; if (!(avg > 0)) continue;
      const big = w.filter(k => Math.abs(k.close - k.open) >= X * avg).length; if (big < K) continue;
      // 21.11.2026 (user): since when the pair is active – walk back while the window ending at that candle still had >= K big candles.
      const isBig = k => Math.abs(k.close - k.open) >= X * avg; let e = c.length - 1, cnt = big;
      while (e - 1 >= N && e > c.length - 180) { cnt += (isBig(c[e - N]) ? 1 : 0) - (isBig(c[e]) ? 1 : 0); if (cnt < K) break; e--; }
      const since = c[e].time + 60;
      const size = w.reduce((t, k) => t + k.high - k.low, 0) / w.length / avg, mv = c[c.length - 1].close - c[c.length - DN].open; // first arrow: move over the last DN candles (user 21.11.2026)
      out.push({ symbol: a.symbol, name: a.name, otc: !!a.otc, payout: a.payout, big, n: N, size: +size.toFixed(1), dir: mv > 0 ? 'up' : mv < 0 ? 'down' : '', last: w[w.length - 1].time, since,
        trend: { CALL: 'up', PUT: 'down', FLAT: 'flat' }[this.radarTrend(a.symbol, TTF, c)] || '', trend15: TTF === 15 ? '' : { CALL: 'up', PUT: 'down', FLAT: 'flat' }[this.radarTrend(a.symbol, 15, c)] || '', m1n: c.length, atr }); // + M15 trend always (user 22.11.2026) // higher-TF trend (EMA 9/21), TF chosen by the user (radar_ttf)
    }
    this._logFresh(nFresh, nLag);
    out.sort((p, q) => q.since - p.since || q.big - p.big || q.size - p.size); // newest active pair on top (user 22.11.2026)
    return { auto: !!s.radar_auto, alert: s.radar_alert !== false, sound: s.radar_sound || 'double', on: s.radar_on !== false, n: N, x: X, k: K, pay: PAY, ttf: TTF, atr: ATR, dn: DN, list: out.slice(0, 15) };
  }

  // Pattern radar (user 21.11.2026): known trading patterns on closed M1 candles, only while valid. Not a signal.
  // pat_ids = patterns the user wants to see (default all). Cached per pair by the last candle time.
  // 23.11.2026 (user): tweezers only in the direction of the trend on a chosen higher TF (2/3/4/5/10/15), on/off.
  twTf() { const v = Number(this.settings.tw_trend_tf); return [2, 3, 4, 5, 10, 15].includes(v) ? v : 5; }
  _twOk(sym, id, dir, c) { if (id !== 'tweezer' || !this.settings.tw_trend_on) return true; const t = this.radarTrend(sym, this.twTf(), c); return dir > 0 ? t === 'CALL' : t === 'PUT'; }
  patRadar() {
    if (this.settings.pat_on === false) { const s = this.settings; return { on: false, tf: this.patTf(), alert: false, sound: s.pat_sound || 'bell', atrOn: !!s.pat_atr_on, atrMin: 0.02, adxOn: !!s.pat_adx_on, adxMin: 20, ids: Array.isArray(s.pat_ids) ? s.pat_ids : PAT.LIST.map(p => p.id), fav: s.pat_fav || [], all: PAT.LIST.map(p => ({ id: p.id, ru: p.ru, en: p.en, g: p.g, wr: p.wr })), list: [] }; }
    const s = this.settings, ids = Array.isArray(s.pat_ids) ? s.pat_ids : PAT.LIST.map(p => p.id), fav = Array.isArray(s.pat_fav) ? s.pat_fav : [], out = [];
    this._patCache = this._patCache || new Map();
    const sAtr = s.pat_sold_atr != null ? Number(s.pat_sold_atr) : 1.0, sBig = Math.min(3, Math.max(1, Number(s.pat_sold_big) || 1)), sRev = !!s.pat_sold_rev, optKey = sAtr + '|' + sBig + '|' + sRev;
    PAT.setOpts({ soldAtr: sAtr, soldBig: sBig, soldRev: sRev }); if (this._patOptKey !== optKey) { this._patCache.clear(); this._patOptKey = optKey; }
    for (const a of this.selectedAssets()) {
      if (Number(s.radar_pay) > 0 && !(Number(a.payout) >= Number(s.radar_pay))) continue; // same minimum payout as the pairs radar
      const tf = this.patTf(), sec = tf * 60; // pattern timeframe M1–M5 (user 22.11.2026)
      const c = this._patCandles(a.symbol, tf); if (!c || c.length < PAT.MIN + 5) continue; // only pairs with fresh candles (22.11.2026)
      // Own ATR / ADX filters of the pattern radar (user 21.11.2026), each with an on/off switch.
      const atr = this.radarAtr(c); if (s.pat_atr_on && atr < (s.pat_atr != null ? Number(s.pat_atr) : 0.02)) continue;
      const ad = I.adx(c, 14), adx = ad[ad.length - 1] ? Math.round(ad[ad.length - 1].adx) : 0; if (s.pat_adx_on && adx < (s.pat_adx != null ? Number(s.pat_adx) : 20)) continue;
      const last = c[c.length - 1].time, key = a.symbol + '|' + tf, nowS = Date.now() / 1000; let e = this._patCache.get(key);
      if (!e || e.last !== last) { const w = c.slice(-160); e = { last, act: PAT.active(w, PAT.prep(w), null) }; this._patCache.set(key, e); }
      const atrAbs = (() => { const v = I.atr(c, 14); return v[v.length - 1] || 0; })();
      const tk = this.ticks.get(a.symbol), lp = tk && tk.length && nowS - tk[tk.length - 1][0] < 120 ? +tk[tk.length - 1][1] : null;
      // 23.11.2026 (user, experiment, pat_pre): early warning while the candle is still forming – the patterns are checked on the
      // live candle as if it closed now, in the last 15 s of an M1 candle (20 % of the bar on M2–M5, 60 s on M5). May not confirm.
      if (s.pat_pre) { const bar = Math.floor(nowS / sec) * sec, win = Math.max(15, sec * 0.2), lt = tk && tk.length ? tk[tk.length - 1][0] : 0;
        const base = tf === 1 ? this.candles.get(a.symbol) : (this.trendCandles.get(a.symbol + '|' + tf) || {}).candles;
        if (base && base.length && bar + sec - nowS <= win && nowS - lt < 10) { const lv = this._withLive(a.symbol, base, sec), fk = lv[lv.length - 1];
          if (fk && fk.time === bar && lv.length > PAT.MIN + 5) { const w = lv.slice(-160), X = PAT.prep(w), dg = v => +v.toPrecision(7);
            for (const id of ids) { const r = PAT.at(w, w.length - 1, X, id); if (!r || !this._twOk(a.symbol, id, r.dir, c)) continue; const p = PAT.LIST.find(q => q.id === id);
              out.push({ pre: true, sleft: Math.max(0, Math.round(bar + sec - nowS)), k: w.slice(-20).map(k => [dg(k.open), dg(k.high), dg(k.low), dg(k.close)]), ki: 19, symbol: a.symbol, name: a.name, payout: a.payout, id, ru: p.ru, en: p.en, dir: r.dir > 0 ? 'up' : 'down', left: p.life, wr: p.wr, time: bar, at: bar + sec, tf, fav: fav.includes(id), atr, adx,
                trend: { CALL: 'up', PUT: 'down', FLAT: 'flat' }[this.radarTrend(a.symbol, [2, 3, 4, 5, 10, 15].includes(Number(s.radar_ttf)) ? Number(s.radar_ttf) : 5, c)] || '',
                trend15: Number(s.radar_ttf) === 15 ? '' : { CALL: 'up', PUT: 'down', FLAT: 'flat' }[this.radarTrend(a.symbol, 15, c)] || '' }); } } } }
      for (const x of e.act) if (ids.includes(x.id)) { const p = PAT.LIST.find(q => q.id === x.id);
        // 22.11.2026 (user): late entry = no signal. Entry window = the minute after the pattern candle closed (M1);
        // also gone once the live price already ran 0.5 ATR the pattern's way from that close, or is beyond its stop.
        if (nowS - (x.time + sec) > sec) continue; // one candle of the pattern TF
        if (!this._twOk(a.symbol, x.id, x.dir, c)) continue;
        const pc = c.find(k => k.time === x.time);
        if (lp != null && pc && atrAbs > 0 && (lp - pc.close) * x.dir > 0.5 * atrAbs) continue;
        if (lp != null && x.stop != null && (x.dir > 0 ? lp < x.stop : lp > x.stop)) continue;
        // Mini chart for the radar row (22.11.2026): up to 20 candles ending with the newest closed one; ki = the pattern candle.
        const pi = c.findIndex(k => k.time === x.time), k0 = Math.max(0, c.length - 20), dg = v => +v.toPrecision(7);
        const mk = pi >= k0 ? c.slice(k0).map(k => [dg(k.open), dg(k.high), dg(k.low), dg(k.close)]) : null;
        out.push({ k: mk, ki: pi - k0, symbol: a.symbol, name: a.name, payout: a.payout, id: x.id, ru: p.ru, en: p.en, dir: x.dir > 0 ? 'up' : 'down', left: x.left, wr: p.wr, time: x.time, at: x.time + sec, tf, fav: fav.includes(x.id), atr, adx,
          trend: { CALL: 'up', PUT: 'down', FLAT: 'flat' }[this.radarTrend(a.symbol, [2, 3, 4, 5, 10, 15].includes(Number(s.radar_ttf)) ? Number(s.radar_ttf) : 5, c)] || '',
          trend15: Number(s.radar_ttf) === 15 ? '' : { CALL: 'up', PUT: 'down', FLAT: 'flat' }[this.radarTrend(a.symbol, 15, c)] || '' }); }
    }
    out.sort((p, q) => (q.fav ? 1 : 0) - (p.fav ? 1 : 0) || q.time - p.time || (q.payout || 0) - (p.payout || 0)); // favourites ★ first, then newest (user 21–22.11.2026)
    return { soldAtr: sAtr, soldBig: sBig, soldRev: sRev, twOn: !!s.tw_trend_on, twTf: this.twTf(), pre: !!s.pat_pre, auto: !!s.pat_auto, on: true, tf: this.patTf(), alert: s.pat_alert !== false, sound: s.pat_sound || 'bell', atrOn: !!s.pat_atr_on, atrMin: s.pat_atr != null ? Number(s.pat_atr) : 0.02, adxOn: !!s.pat_adx_on, adxMin: s.pat_adx != null ? Number(s.pat_adx) : 20, ids, fav, all: PAT.LIST.map(p => ({ id: p.id, ru: p.ru, en: p.en, g: p.g, wr: p.wr })), list: out.slice(0, 25) };
  }

  state() {
    const done =this.signals.filter(s => s.result === 'WIN' || s.result === 'LOSS');
    const wins = done.filter(s => s.result === 'WIN').length;
    return {
      radar: this.radar(), patRadar: this.patRadar(), watch: this.watch || null,
      status: this.status, connected: this.po.authed, lastError: this.po.lastError || null, log: this.po.log.slice(-40),
      // What session is stored (never the session itself): shown under the session field.
      session: this.po.ssid ? { length: this.po.ssid.length, demo: /"isDemo"\s*:\s*1/.test(this.po.ssid) } : null, demo: /"isDemo"\s*:\s*1/.test(this.po.ssid || ''),
      otcRec: { rows: this.otcRec?.rows || 0, pairs: this.otcLast?.size || 0, error: this.otcRec?.error || null, dir: path.join(DATA, 'otc') },
      watching: this.selectedAssets().length, assetsKnown: this.assets.size,
      // Running signals carry the pair's current M5 trend (recomputed from the latest candles).
      // 22.11.2026: the screen update was ~3 MB (every signal carried its candle chart). Charts only for the 30 newest
      // signals (the cards); older ones go without m1/m5 – the journal does not draw them. signals.json keeps everything.
      signals: this.signals.map((s, i) => (i < 30 && !s.result ? { ...s, trends: this.trendMinutes.map(m => ({ tf: 'M' + m, dir: this.m5Trend(s.symbol, m) })).filter(x => x.dir) } : i < 30 ? s : (({ m1, m5, adTf, recWhy, recShort, adxLive, tv, ...r }) => r)(s))), // card-only fields dropped too
      stats: { total: done.length, wins, rate: done.length ? Math.round(100 * wins / done.length) : null },
      why: strategies.whyHour(), // "Why (last hour)": found / filtered / delivered per strategy
      lab: {
        catalog: LAB.CATALOG.map(c => ({ ...c, params: c.impl ? strategies.paramsFor(c.id, this.settings) : null })),
        decisions: LAB.lastDecisions(), stats: this._labStats(),
        limits: LAB.manualLimits(this.signals, this.settings, this.settings.account === 'REAL' ? 'REAL' : 'DEMO'),
        paramLog: this.paramLog.slice(0, 100), risk: { ...LAB.RISK_DEFAULTS, ...LAB.COMMON, ...Object.fromEntries(Object.keys({ ...LAB.RISK_DEFAULTS, ...LAB.COMMON }).filter(k => this.settings[k] != null).map(k => [k, this.settings[k]])) },
        account: this.settings.account === 'REAL' ? 'REAL' : 'DEMO', mode: this.settings.trade_mode || 'SIGNAL_ONLY',
        notify_strats: this.settings.notify_strats || [], stale_sec: Number(this.settings.stale_sec ?? 5),
        latency: (() => { let best = null; for (const t of this.ticks.values()) { const x = t && t.length ? t[t.length - 1][0] : null; if (x) { const age = Math.max(0, Date.now() - x * 1000); if (best === null || age < best) best = age; } } return best; })(),
      },
      settings: {
        strategies: this.settings.strategies || [], favorites: this.settings.favorite_strategies || [],
        allStrategies: strategies.list.filter(k => !HIDDEN.includes(k)).map(k => ({
          key: k, names: strategies.NAMES[k], type: strategies.META[k][1],
          params: strategies.paramsFor(k, this.settings), tfs: this.settings.strat_tfs?.[k] || ['M1'],
          modes: 'ludo_mode' in strategies.paramsFor(k, this.settings) ? LAB.LUDO_MODES : null,
          presets: strategies.PRESETS[k] || [], groups: strategies.GROUPS[k] || null, tests: strategies.TESTS[k] || null, labels: strategies.LABELS[k] || null,
          activePresets: this.settings.strat_presets?.[k] || [], help: strategies.HELP[k] || null, log: null,
        })),
        strat_sounds: this.settings.strat_sounds || {},
        min_payout: this.settings.min_payout || 0, otc_po_on: this.settings.otc_po_on !== false,
        assets_off: this.settings.assets_off || [],
        markets: this.marketsForUi(), pairs: this.settings.pairs || [],
        min_strength: this.settings.min_strength || 0, max_per_scan: this.settings.max_per_scan || 0, sig_score_min: Number(this.settings.sig_score_min ?? 50), sig_per_hour: Number(this.settings.sig_per_hour) || 0, sig_clean_min: Number(this.settings.sig_clean_min) || 0, sig_clean_n: Number(this.settings.sig_clean_n) || 10,
        market: this.settings.market || 'both', signals_on: this.settings.signals_on !== false, sound: this.settings.sound !== false, auto_po: !!this.settings.auto_po, regime_mode: this.settings.regime_mode || (this.settings.regime_filter ? 'auto' : 'off'),
        ...Object.fromEntries(Object.entries(RG_DEFAULTS).map(([k, d]) => [k, this.settings[k] ?? d])), chaos_skip: this.settings.chaos_skip !== false, po_click_toggle: this.settings.po_click_toggle !== false, scan_interval: this.scanInterval, mini_on_blur: this.settings.mini_on_blur === true, quick_trade: this.settings.quick_trade === true, quick_real: this.settings.quick_real === true, mini_tf: this.settings.mini_tf || 'M5', mkt_level: Number(this.settings.mkt_level) || 0, smart_exp: this.settings.smart_exp === true, quotes_demo: this.settings.quotes_demo === true, show_m5: this.settings.show_m5 !== false, trend_tfs: this.trendMinutes.map(m => 'M' + m), otc_record: this.settings.otc_record !== false, trend_filter: !!this.settings.trend_filter,
        deposit: Number(this.settings.deposit) || 1000,
        po_start_mode: this.settings.po_start_mode || 'last', tv_open: this.settings.tv_open === 'app' ? 'app' : 'external', po_last_mode: this.settings.po_last_mode || null,
        mini_count: Math.min(5, Math.max(1, Number(this.settings.mini_count) || 2)), mini_pos: this.settings.mini_pos || 'tr',
      },
    };
  }
}

module.exports = Engine;
