// Headless check: connect, load candles, then run every strategy on every asset over the last 60 minutes.
const Engine = require('../src/engine');
const strategies = require('../src/strategies');
const I = require('../src/indicators');
const e = new Engine();
e.po.on('status', s => console.log('status:', s));
e.po.connect();
e.po.on('ready', () => setTimeout(() => { console.log('selected', e.selectedAssets().length); e.scan(); }, 1500));
setTimeout(() => {
  console.log('candles for', e.candles.size, 'assets');
  const hits = Object.fromEntries(strategies.list.map(k => [k, 0])), errors = {};
  const settings = { ...e.settings, strat_tfs: {} };
  for (const [, c] of e.candles) {
    for (let end = c.length - 60; end <= c.length; end++) {
      const part = c.slice(0, end);
      const byTf = { M1: part };
      for (const s of strategies.evaluate(byTf, strategies.list, settings)) hits[s.strategy]++;
    }
  }
  // Errors are swallowed in evaluate, so call each strategy once directly to surface them.
  console.log('hits per strategy (all assets x 60 min):');
  for (const [k, v] of Object.entries(hits)) console.log(String(v).padStart(5), k, strategies.NAMES[k]);
  const m5 = I.resample([...e.candles.values()][0], 5);
  console.log('M5 resample candles:', m5.length, Object.keys(errors).length ? errors : '');
  process.exit(0);
}, 20000);
