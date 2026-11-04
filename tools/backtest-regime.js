// Backtest by market regime: every strategy (default settings) on M1 windows of 150 candles, like the app.
// Entry = open of the next candle, result = close at expiry vs entry. Split by I.regime of the signal candle.
// Walk-forward: first 60 % of each pair's days = "seen", last 40 % = "unseen" (both reported).
// Usage: node tools/backtest-regime.js <app dir> <hist.json {symbol: [M1 candles]}> > result.json
// Result 04.11.2026 (17 OTC pairs, 5 days): all ~50 % in TREND and RANGE alike, CHAOS 36 % (n 70).
const path = require('path');
const app = process.argv[2], hist = require(process.argv[3]);
const S = require(path.join(app, 'src/strategies')), I = require(path.join(app, 'src/indicators'));
const names = S.list, W = 150, res = {};
const add = (k, win) => { const r = (res[k] ||= { w: 0, l: 0 }); win ? r.w++ : r.l++; };
for (const [sym, c] of Object.entries(hist)) {
  const byTime = new Map(c.map((k, i) => [k.time, i]));
  const split = c[Math.floor(c.length * 0.6)].time;
  for (let e = W; e < c.length - 20; e++) {
    const win = c.slice(e - W, e);
    if (win[W - 1].time - win[0].time !== (W - 1) * 60) continue; // gap
    const rg = I.regime(win); if (!rg) continue;
    let sigs; try { sigs = S.evaluate({ M1: win }, names, {}); } catch { continue; }
    for (const s of sigs) {
      const entryI = e, exp = Math.max(60, Math.round(s.expiry / 60) * 60);
      const exitI = byTime.get(c[entryI].time + exp - 60); if (exitI === undefined) continue;
      const diff = c[exitI].close - c[entryI].open; if (!diff) continue;
      const ok = (diff > 0) === (s.dir > 0), part = win[W - 1].time < split ? 'seen' : 'unseen';
      for (const p of ['all', part]) { add(`${s.strategy}|${rg.regime}|${p}`, ok); add(`${s.strategy}|ALL|${p}`, ok); add(`*|${rg.regime}|${p}`, ok); }
    }
  }
  process.stderr.write(sym + ' ');
}
const wilson = (w, n) => { if (!n) return [0, 0]; const z = 1.96, p = w / n, d = 1 + z * z / n, m = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return [m - h, m + h]; };
const rows = Object.entries(res).map(([k, r]) => { const [st, rg, p] = k.split('|'), n = r.w + r.l, [lo, hi] = wilson(r.w, n); return { st, rg, p, n, rate: +(100 * r.w / n).toFixed(1), lo: +(100 * lo).toFixed(1), hi: +(100 * hi).toFixed(1) }; });
console.log(JSON.stringify(rows));
