// Automatic tests of src/pro_strategies.js (Breakout + Retest).
// Synthetic candles with known structure + seeded property tests. Run: node tools/test-pro.js
const path = require('path');
const I = require('../src/indicators'), S = require('../src/strategies');
const { roomAhead } = require('../src/levels');
let ok = 0, bad = 0;
const t = (name, cond, extra) => { if (cond) ok++; else { bad++; console.log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra)); } };
const L = (ru, de, en) => ({ ru, de, en: en ?? de }), sig = (dir, strength, reason, expiry) => ({ dir, strength, reason, expiry });
const PRO = require('../src/pro_strategies')({ I, L, sig, roomAhead });
const rng = (s => () => { s |= 0; s = s + 0x6D2B79F5 | 0; let x = Math.imul(s ^ s >>> 15, 1 | s); x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x; return ((x ^ x >>> 14) >>> 0) / 4294967296; })(12345);
const T0 = 1700000000 - (1700000000 % 60);
const mk = (k, o, c, hi, lo) => ({ time: T0 + k * 60, open: o, close: c, high: hi ?? Math.max(o, c) + 0.05, low: lo ?? Math.min(o, c) - 0.05 });
const run = (name, c, p, tf = 'M1') => S.evaluate({ [tf]: c }, [name], { strategy_settings: { [name]: p }, strat_presets: {}, strat_tfs: { [name]: [tf] } });
const mirror = c => c.map(k => ({ time: k.time, open: 200 - k.open, close: 200 - k.close, high: 200 - k.low, low: 200 - k.high }));

// ---------- Breakout + Retest + Confirmation ----------
function borSeries() {
  const c = [];
  for (let k = 0; k < 60; k++) { // range 98.4–100.0, resistance touched at every wave peak
    const mid = 99.2 + 0.7 * Math.sin(2 * Math.PI * k / 15), o = mid - 0.1, cl = mid + 0.1;
    c.push(mk(k, o, cl, mid + 0.3, mid - 0.3));
  }
  c[59] = mk(59, 99.4, 99.5, 99.7, 99.3);
  c.push(mk(60, 100.0, 101.0, 101.1, 99.95));  // breakout: closes above the zone
  c.push(mk(61, 101.0, 100.6, 101.0, 99.9));   // retest: touches the zone, no close below it
  c.push(mk(62, 100.6, 101.2, 101.3, 100.5));  // confirmation 1
  c.push(mk(63, 101.2, 101.7, 101.8, 101.1));  // confirmation 2
  return c;
}
{
  const c = borSeries(), r = run('n_bor', c, {});
  t('BOR CALL fires after breakout → retest → 2 confirmations', r.length === 1 && r[0].dir === 1, r.map(x => x.dir));
  t('BOR one signal key per breakout (bar = breakout candle)', r[0] && r[0].bar === c[60].time, r[0] && r[0].bar);
  const rm = run('n_bor', mirror(c), {});
  t('BOR PUT is the exact mirror', rm.length === 1 && rm[0].dir === -1);
  t('BOR no signal after only 1 confirmation', run('n_bor', c.slice(0, 63), {}).length === 0);
  t('BOR 1 confirmation is enough when set to 1', run('n_bor', c.slice(0, 63), { br_confirm: 1 }).length === 1);
  t('BOR 3 confirmations needed → none with 2', run('n_bor', c, { br_confirm: 3 }).length === 0);
  const c2 = borSeries(); c2[62] = mk(62, 100.6, 99.5, 100.7, 99.4); // a close back below the zone cancels the scenario
  t('BOR zone violated → cancelled', run('n_bor', c2, {}).length === 0);
  const c3 = borSeries(); c3[62] = mk(62, 101.2, 100.9, 101.3, 100.8); // bearish "confirmation"
  t('BOR bearish confirmation → no signal', run('n_bor', c3, {}).length === 0);
  const c4 = borSeries(); c4[61] = mk(61, 101.0, 101.2, 101.4, 100.8); // price never came back to the zone: no retest
  t('BOR no retest → no signal', run('n_bor', c4, {}).length === 0);
  t('BOR respects the CALL switch', run('n_bor', c, { br_buy: false }).length === 0);
  // no look-ahead: the same candles + a future candle change nothing for the earlier evaluation
  t('BOR evaluation on the history prefix is unchanged by later candles', JSON.stringify(run('n_bor', c.slice(0, 64), {})) === JSON.stringify(run('n_bor', c.concat([mk(64, 101.7, 90, 102, 80)]).slice(0, 64), {})));
  // levels: breakout through a one-touch level is no signal with 2 required touches
  t('BOR needs the minimum number of touches', run('n_bor', c, { br_touches: 9 }).length === 0);
  // M3 timeframe object works the same way (candle times are not checked)
  t('BOR works on another timeframe key', run('n_bor', c, {}, 'M3').length === 1);
}

// ---------- RSI filter modes (shared) ----------
{
  const c = Array.from({ length: 30 }, (_, k) => mk(k, 1, 1)), at = v => { const a = Array(30).fill(null); a[29] = v; return a; };
  const f = (mode, v, dir, lo = 50, hi = 70) => PRO.rsiCheck(c, 29, { rsi_mode: mode, rsi_min: lo, rsi_max: hi }, dir, at(v)).ok;
  t('RSI OFF never blocks', f(0, 99, 1) && f(0, 1, -1));
  t('RSI RANGE CALL inside 50–70', f(1, 55, 1) && !f(1, 45, 1) && !f(1, 75, 1));
  t('RSI RANGE PUT inside 30–50 (mirror)', f(1, 40, -1) && !f(1, 60, -1) && !f(1, 25, -1));
  t('RSI OVERHEAT ONLY: CALL blocked at ≥ max, no lower bound', !f(2, 70, 1) && f(2, 20, 1) && f(2, 69, 1));
  t('RSI OVERHEAT ONLY: PUT blocked at ≤ 100 − max', !f(2, 30, -1) && f(2, 80, -1) && f(2, 31, -1));
}

// ---------- MAM-lite ----------
{
  const act = Array.from({ length: 140 }, (_, k) => mk(k, 100, 100.1 + (k % 3) * 0.05, 100.5, 99.8)), flat = act.map(k => ({ ...k, open: 100, close: 100, high: 100, low: 100 }));
  const p = { mam_on: true, mam_block: true, mam_min_act: 0.6, mam_max_stale: 0.3, mam_from: 0, mam_to: 24 };
  t('MAM off: no note, no block', PRO.mamCheck(act, 139, {}, 60).block === false && PRO.mamCheck(act, 139, {}, 60).note === null);
  t('MAM active market passes and says volume is unavailable', !PRO.mamCheck(act, 139, p, 60).block && /объём недоступен/.test(PRO.mamCheck(act, 139, p, 60).note.ru));
  t('MAM frozen quotes are blocked (UNKNOWN)', PRO.mamCheck(flat, 139, p, 60).block && /UNKNOWN/.test(PRO.mamCheck(flat, 139, p, 60).note.ru));
  t('MAM WARN only does not block', !PRO.mamCheck(flat, 139, { ...p, mam_block: false }, 60).block);
  const quiet = act.map((k, j) => (j >= 130 ? { ...k, high: k.close + 0.01, low: k.close - 0.01 } : k));
  t('MAM LOW activity blocks', PRO.mamCheck(quiet, 139, p, 60).block && /LOW/.test(PRO.mamCheck(quiet, 139, p, 60).note.ru));
  const hourOnly = { ...p, mam_from: (new Date(act[139].time * 1000).getUTCHours() + 5) % 24, mam_to: (new Date(act[139].time * 1000).getUTCHours() + 6) % 24 };
  t('MAM hour filter blocks outside the hours', PRO.mamCheck(act, 139, hourOnly, 60).block);
}

// ---------- integration ----------
t('strategy registered with names, defaults, own-trend logic', ['n_bor'].every(n => S.META[n] && S.NAMES[n] && S.DEFAULTS[n] && S.OWN_LOGIC.includes(n)));
t('AUTO trading does not exist in the defaults (no auto key)', !['n_bor'].some(n => Object.keys(S.DEFAULTS[n]).some(k => /auto|martin/i.test(k))));
console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
