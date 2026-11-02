// Automatic tests of the three strategies of src/pro_strategies.js (ADX/DMI Micro-Impulse, Breakout + Retest, APC Pro).
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

// ---------- APC Pro ----------
function apcSeries() {
  const c = [];
  for (let k = 0; k < 60; k++) { const m = 100 + 0.15 * Math.sin(k), o = m - 0.05, cl = m + 0.05; c.push(mk(k, o, cl, m + 0.25, m - 0.25)); } // calm, ATR ≈ 0.5
  let px = c[59].close;
  for (let k = 0; k < 4; k++) { c.push(mk(60 + k, px, px + 0.6, px + 0.65, px - 0.02)); px += 0.6; }       // impulse: 4 bullish candles, 2.4 ≈ 4.8 ATR
  const top = px;                                                                                           // 102.4+
  c.push(mk(64, top, top - 0.3, top + 0.02, top - 0.35));                                                   // pullback 1
  c.push(mk(65, top - 0.3, top - 0.55, top - 0.28, top - 0.6));                                             // pullback 2 (≈ 23% of the impulse)
  c.push(mk(66, top - 0.55, top - 0.15, top - 0.1, top - 0.58));                                            // resumption 1
  c.push(mk(67, top - 0.15, top + 0.25, top + 0.3, top - 0.18));                                            // resumption 2: breaks the pullback high
  return c;
}
{
  const base = { apc_rsi_mode: 0, apc_ext_mode: 0, apc_exh_on: false };
  const c = apcSeries(), r = run('n_apc', c, base);
  t('APC CALL: impulse → pullback → resumption', r.length === 1 && r[0].dir === 1, r.map(x => x.dir));
  t('APC one signal per impulse (bar = impulse extreme candle)', r[0] && r[0].bar === c[63].time, r[0] && r[0].bar);
  t('APC PUT is the exact mirror', run('n_apc', mirror(c), base).length === 1 && run('n_apc', mirror(c), base)[0].dir === -1);
  t('APC no signal before the resumption candle breaks the level', run('n_apc', c.slice(0, 67), base).length === 0);
  const deep = apcSeries(); deep[65] = mk(65, deep[64].close, deep[64].close - 1.7, deep[64].close - 0.05, deep[64].close - 1.75); // pullback too deep
  t('APC pullback deeper than the maximum → cancelled', run('n_apc', deep, base).length === 0);
  const brk = apcSeries(); brk[65] = mk(65, brk[64].close, brk[60].open - 0.2, brk[64].close, brk[60].open - 0.25); // through the impulse start
  t('APC impulse start broken → invalidated', run('n_apc', brk, base).length === 0);
  const jump = apcSeries(); for (let k = 60; k < 64; k++) { jump[k] = mk(k, jump[k].open, jump[k].open + 3, jump[k].open + 3.05, jump[k].open - 0.02); }
  t('APC absurd jump (> max ATR) is not an impulse', run('n_apc', jump, base).length === 0);
  t('APC RSI overheat blocks after a strong impulse (mode ON), advisory only warns',
    run('n_apc', c, { ...base, apc_rsi_mode: 1, apc_rsi_hi: 55 }).length === 0 && run('n_apc', c, { ...base, apc_rsi_mode: 2, apc_rsi_hi: 55 }).length === 1);
  t('APC advisory note is in the reason', /перегрев/.test(run('n_apc', c, { ...base, apc_rsi_mode: 2, apc_rsi_hi: 55 })[0].reason.ru));
  t('APC extension filter blocks when the path is too long', run('n_apc', c, { ...base, apc_ext_mode: 1, apc_ext_atr: 1 }).length === 0);
  t('APC respects the PUT/CALL switches', run('n_apc', c, { ...base, apc_buy: false }).length === 0);
  t('APC context TF needed but missing → no signal', run('n_apc', c, { ...base, apc_ctx_m15: true }).length === 0);
  t('APC reason never shows a made-up win percentage', !/\d+\s*%\s*(win|выигр|Gewinn)/i.test(JSON.stringify(r[0].reason)));
}

// ---------- ADX / DMI Micro-Impulse: property tests on a seeded random series ----------
function regimeSeries(n) {
  const c = []; let px = 100, drift = 0;
  for (let k = 0; k < n; k++) {
    if (k % 70 === 0) drift = (rng() - 0.5) * 0.5 * (rng() < 0.6 ? 1 : 0);
    const o = px, cl = px + drift + (rng() - 0.5) * 0.4; px = cl;
    c.push(mk(k, o, cl, Math.max(o, cl) + rng() * 0.15, Math.min(o, cl) - rng() * 0.15));
  }
  return c;
}
{
  const c = regimeSeries(900), a = I.adx(c, 14), N = c.length;
  const sweep = (p) => { const out = []; for (let i = 100; i < N; i++) { const r = run('n_adxmicro', c.slice(0, i + 1), p); if (r.length) out.push({ i, s: r[0] }); } return out; };

  const A = sweep({ am_mode: 'A' }), dI = (i) => Math.sign(a[i].pdi - a[i].mdi);
  t('A: some signals on the test series', A.length > 3, A.length);
  t('A: every signal is a DI cross with ADX ≥ 25 and the DI direction', A.every(({ i, s }) => a[i].adx >= 25 && a[i - 1] && Math.sign(a[i].pdi - a[i].mdi) === s.dir && Math.sign(a[i - 1].pdi - a[i - 1].mdi) === -s.dir));

  const B = sweep({ am_mode: 'B', am_adx_thr: 25, am_hyst: 2, am_cooldown: 0 });
  t('B: some signals on the test series', B.length > 3, B.length);
  t('B: trigger = ADX crosses the threshold between two consecutive bars', B.every(({ i }) => a[i - 1].adx < 25 && a[i].adx >= 25));
  t('B: direction = the dominant DI line', B.every(({ i, s }) => dI(i) === s.dir));
  let reArm = true;
  for (let q = 1; q < B.length; q++) { let mn = Infinity; for (let j = B[q - 1].i; j < B[q].i; j++) mn = Math.min(mn, a[j].adx); if (mn > 25 - 2) reArm = false; }
  t('B: re-armed only after ADX fell to ≤ threshold − hysteresis (no repeats while ADX stays high)', reArm);
  const Bh = sweep({ am_mode: 'B', am_adx_thr: 25, am_hyst: 6, am_cooldown: 0 });
  t('B: a bigger hysteresis never gives more signals', Bh.length <= B.length, [Bh.length, B.length]);
  t('B: DI filter (gap ≥ 8) only removes signals', sweep({ am_mode: 'B', am_cooldown: 0, am_use_di_gap: true, am_di_gap: 8 }).length <= B.length);
  t('B: ADX-rising filter only removes signals', sweep({ am_mode: 'B', am_cooldown: 0, am_use_adx_rise: true, am_adx_rise: 1.5 }).length <= B.length);

  const Cp = sweep({ am_mode: 'C', am_cross_mode: 'PRE', am_conv_min: 0.8 });
  t('C PRE: some early candidates on the test series', Cp.length > 3, Cp.length);
  t('C PRE: candidate is on the not-yet-crossed side, lines converging', Cp.every(({ i, s }) => dI(i) === -s.dir && Math.abs(a[i - 1].pdi - a[i - 1].mdi) - Math.abs(a[i].pdi - a[i].mdi) >= 0.8));
  t('C PRE: ADX ≥ 25 is NOT required (some candidates below it)', Cp.some(({ i }) => a[i].adx < 25));
  t('C PRE: consecutive evaluations of one candidate share the same event key (no double signal)', Cp.every((x, q) => q === 0 || Cp[q - 1].i + 1 !== x.i || Cp[q - 1].s.bar === x.s.bar));
  const Cc = sweep({ am_mode: 'C', am_cross_mode: 'CROSS', am_conv_min: 0.8 });
  t('C CROSS: only real DI crosses', Cc.every(({ i, s }) => dI(i) === s.dir && dI(i - 1) === -s.dir));
  const Cb = sweep({ am_mode: 'C', am_cross_mode: 'BOTH', am_conv_min: 0.8 });
  t('C BOTH ⊆ PRE ∪ CROSS (nothing new appears)', Cb.every(({ i }) => Cp.some(x => x.i === i) || Cc.some(x => x.i === i)));
  t('C BOTH: a cross right after a fired candidate is not a second signal', Cb.length <= Cp.length + Cc.length);

  // D CUSTOM: ALL needs every trigger, ANY needs one
  const Dall = sweep({ am_mode: 'D', am_t_dicross: true, am_t_adxcross: true, am_logic: 'ALL', am_cooldown: 0 }), Dany = sweep({ am_mode: 'D', am_t_dicross: true, am_t_adxcross: true, am_logic: 'ANY', am_cooldown: 0 });
  t('D: no trigger switched on → no signal', sweep({ am_mode: 'D', am_t_dicross: false }).length === 0);
  t('D: ALL ⊆ ANY', Dall.every(({ i }) => Dany.some(x => x.i === i)), [Dall.length, Dany.length]);
  t('D: ALL = both a DI cross and an ADX cross on the same bar', Dall.every(({ i }) => a[i - 1].adx < 25 && a[i].adx >= 25 && Math.sign(a[i].pdi - a[i].mdi) !== Math.sign(a[i - 1].pdi - a[i - 1].mdi)));
  // RSI modes through the strategy: OFF must not change anything
  t('RSI OFF leaves A unchanged', JSON.stringify(sweep({ am_mode: 'A', rsi_mode: 0 }).map(x => x.i)) === JSON.stringify(A.map(x => x.i)));
  t('RSI filter only removes signals', sweep({ am_mode: 'A', rsi_mode: 1 }).length <= A.length && sweep({ am_mode: 'A', rsi_mode: 2 }).length <= A.length);
  // CLOSED ignores a forming candle; LIVE sees it (Date.now is moved so the last candle is "forming")
  const realNow = Date.now;
  try {
    let diff = 0, same = 0;
    for (let i = 200; i < 400; i++) {
      const closedOnly = c.slice(0, i), withForming = c.slice(0, i + 1);
      Date.now = () => (c[i].time + 30) * 1000; // 30 s into candle i
      const rc = run('n_adxmicro', withForming, { am_mode: 'B', am_cooldown: 0 }), rb = run('n_adxmicro', closedOnly, { am_mode: 'B', am_cooldown: 0 });
      if (JSON.stringify(rc.map(x => [x.dir, x.bar])) === JSON.stringify(rb.map(x => [x.dir, x.bar]))) same++; else diff++;
    }
    t('CLOSED: a forming candle changes nothing', diff === 0, { same, diff });
    let live = 0, provisional = 0;
    for (let i = 200; i < 900; i++) {
      Date.now = () => (c[i].time + 30) * 1000;
      const r = run('n_adxmicro', c.slice(0, i + 1), { am_mode: 'B', am_live: true, am_cooldown: 0 });
      if (r.length) { live++; if (/ПРЕДВАРИТЕЛЬНО/.test(r[0].reason.ru) && r[0].entry) provisional++; }
    }
    t('LIVE: provisional signals are marked and enter now', live > 0 && provisional === live, { live, provisional });
  } finally { Date.now = realNow; }
  t('liveMode follows the source switch', S.liveMode('n_adxmicro', { strategy_settings: { n_adxmicro: { am_live: true } } }) === 'live' && S.liveMode('n_adxmicro', {}) === 'closed');
}

// ---------- integration ----------
t('three strategies registered with names, defaults, own-trend logic', ['n_adxmicro', 'n_bor', 'n_apc'].every(n => S.META[n] && S.NAMES[n] && S.DEFAULTS[n] && S.OWN_LOGIC.includes(n)));
t('AUTO trading does not exist in the defaults (no auto key)', !['n_adxmicro', 'n_bor', 'n_apc'].some(n => Object.keys(S.DEFAULTS[n]).some(k => /auto|martin/i.test(k))));
console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
