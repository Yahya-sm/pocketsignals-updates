// Appended to the mobile bundle: runs the engine inside the page and exposes window.LocalEngine,
// the same message interface the UI uses with the PC server.
const Engine = require('./engine');
const engine = new Engine();
const subs = [];
const push = m => subs.forEach(f => f(m));
engine.on('state', () => push({ type: 'state', state: engine.state() }));
engine.on('signal', signal => { push({ type: 'signal', signal }); push({ type: 'state', state: engine.state() }); });

window.LocalEngine = {
  subscribe(f) { subs.push(f); f({ type: 'state', state: engine.state() }); },
  act(msg) {
    switch (msg.action) {
      case 'openPO': {
        const sig = engine.signals.find(s => s.id === msg.id);
        const symbol = sig ? sig.symbol : msg.symbol;
        if (!symbol) return { ok: false };
        const asset = engine.assets.get(symbol);
        return { ok: engine.openOnPocketOption(symbol, msg.tf), symbol, name: asset ? asset.name : symbol };
      }
      case 'settings': engine.updateSettings(msg.patch || {}); return { ok: true };
      case 'strategy': engine.updateStrategy(msg.name, msg.patch, msg.tfs, msg.presets); return { ok: true };
      case 'resetStrategy': engine.resetStrategy(msg.name); return { ok: true };
      case 'import': return engine.importSettings(msg.data);
      case 'export': return { ok: true, data: engine.exportSettings() };
      case 'ssid': engine.setSsid(String(msg.ssid || '').trim(), msg.url, !!msg.auto); return { ok: true };
      case 'clear': engine.clearSignals(); return { ok: true };
      case 'mine': engine.markMine(msg.id, msg.on); return { ok: true };
      case 'scan': engine.scan(); return { ok: true };
      case 'polog': engine.po._log(String(msg.text || '').slice(0, 200)); return { ok: true }; // from the PocketOption tab
      default: return { ok: false };
    }
  },
};
// The Android side asks for the PocketOption switch script with the asset name.
window.poSwitchScript = name => require('./po-switch').switchScript(name);
// Tell Android which PocketOption page to open (demo or real), now and whenever the setting changes.
let lastPoStart = null;
const sendPoStart = () => {
  const url = require('./po-switch').poStartUrl(engine.settings);
  if (url !== lastPoStart && window.AndroidApp && window.AndroidApp.setPoStart) { lastPoStart = url; window.AndroidApp.setPoStart(url); }
};
engine.on('state', sendPoStart);
sendPoStart();
// Where TradingView opens: the phone's browser / TradingView app (default, sign-in works) or inside the app.
let lastTv = null;
const sendTvMode = () => {
  const ext = engine.settings.tv_open !== 'app';
  if (ext !== lastTv && window.AndroidApp && window.AndroidApp.setTvExternal) { lastTv = ext; window.AndroidApp.setTvExternal(ext); }
};
engine.on('state', sendTvMode);
sendTvMode();
setInterval(() => push({ type: 'state', state: engine.state() }), 15000);
// Called by the Android app every 30 s: a hidden or backgrounded WebView may skip timers for many minutes, so the
// reconnect after a drop never came (phone log 28.10.2026: 28 minutes without a new attempt). Reconnect if needed.
window.__psWake = () => {
  const p = engine.po;
  if (p.ssid && !p.authed && (!p.ws || p.ws.readyState > 1)) { p._log('Wieder wach – verbinde neu'); p.connect(); }
};
engine.start();
