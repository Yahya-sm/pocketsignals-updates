// Runs the engine with a copy of the installed app's data and reports connection, scans and why signals are dropped.
const fs = require('fs'), os = require('os'), path = require('path');
const src = path.join(process.env.APPDATA, 'PocketSignals', 'data');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-diag-'));
for (const f of fs.readdirSync(src)) fs.copyFileSync(path.join(src, f), path.join(dir, f));
process.env.SIGNAL_DATA = dir;
const Engine = require('../src/engine');
const strategies = require('../src/strategies');
const e = new Engine();
const t0 = Date.now(), log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', ...a);
e.po.on('status', s => log('status', s, e.po.lastError || ''));
let hist = 0; e.po.on('history', () => hist++);
e.on('signal', s => log('SIGNAL', s.name, s.dir));
e.start();
setTimeout(() => {
  log('authed', e.po.authed, '| url', e.po.url, '| watching', e.selectedAssets().length, '| history answers', hist, '| candles', e.candles.size, '| trend sets', e.trendCandles.size);
  // Raw strategy hits now, and how many the trend filter would drop.
  let raw = 0, dropped = 0;
  for (const [sym, c] of e.candles) {
    const hits = strategies.evaluate({ M1: c }, e.settings.strategies, e.settings);
    const tr = e.m5Trend(sym);
    for (const h of hits) { raw++; if ((tr === 'CALL' && h.dir < 0) || (tr === 'PUT' && h.dir > 0)) dropped++; }
  }
  log('strategy hits on last candle:', raw, '| dropped by trend filter:', dropped);
  const last = [...e.candles.values()][0]; if (last) log('newest candle', new Date(last[last.length - 1].time * 1000).toLocaleTimeString());
  process.exit(0);
}, 40000);
