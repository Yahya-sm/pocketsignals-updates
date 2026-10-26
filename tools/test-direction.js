// Checks reversal vs. follow: a run of red candles gives CALL ("rebound expected") by default and PUT with follow_move.
const strategies = require('../src/strategies');
// 70 calm candles, then 5 red ones.
const c = [];
let p = 1.1;
for (let i = 0; i < 70; i++) { const o = p, cl = p + (i % 2 ? 0.0002 : -0.0002); c.push({ time: i * 60, open: o, close: cl, high: Math.max(o, cl) + 0.0001, low: Math.min(o, cl) - 0.0001 }); p = cl; }
for (let i = 0; i < 5; i++) { const o = p, cl = p - 0.0006; c.push({ time: (70 + i) * 60, open: o, close: cl, high: o + 0.0001, low: cl - 0.0001 }); p = cl; }
const run = settings => strategies.evaluate({ M1: c }, ['n_sharp'], settings)[0];
const a = run({ strategy_settings: {} });
const b = run({ strategy_settings: { n_sharp: { follow_move: true } } });
console.log('Standard (Umkehr):', a && a.dir > 0 ? 'CALL' : a ? 'PUT' : '-', '|', a && a.reason.de, '|', a && a.mode);
console.log('Folgen:           ', b && b.dir > 0 ? 'CALL' : b ? 'PUT' : '-', '|', b && b.reason.de, '|', b && b.mode);
const shown = strategies.paramsFor('n_sharp', { strategy_settings: { n_sharp: { only_confirmed: true, anti_saw: false, ma_fast: 10, sharp_min: 5 } } });
console.log('Angezeigte Werte n_sharp:', Object.keys(shown).join(', '), '| sharp_min =', shown.sharp_min);
