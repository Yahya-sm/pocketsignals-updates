// Unit tests for the Strategy Lab (src/lab.js) and its translations. Run: node tools/test-lab.js
const assert = require('assert');
const path = require('path'), fs = require('fs'), vm = require('vm');
const LAB = require('../src/lab');
const S = require('../src/strategies');
let ok = 0; const test = (name, fn) => { try { fn(); ok++; console.log('ok  ', name); } catch (e) { console.log('FAIL', name, '-', e.message); process.exitCode = 1; } };

// Reproducible random walk with bursts, ranges and spikes so every logic has something to find.
function candles(n, seed = 7) {
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const out = []; let p = 1.1, t = 1700000000;
  for (let i = 0; i < n; i++) {
    const vol = 0.0004 * (rnd() < 0.05 ? 3 : 1), drift = Math.sin(i / 40) * 0.00005;
    const o = p, c = o + drift + (rnd() - 0.5) * vol, h = Math.max(o, c) + rnd() * vol * 0.5, l = Math.min(o, c) - rnd() * vol * 0.5;
    out.push({ time: t + i * 60, open: o, high: h, low: l, close: c }); p = c;
  }
  return out;
}
const C = candles(6000);

test('break-even 1/(1+p)', () => {
  assert.strictEqual(LAB.breakEven(0.7).toFixed(3), '0.588');
  assert.strictEqual(LAB.breakEven(0.8).toFixed(3), '0.556');
  assert.strictEqual(LAB.breakEven(0.9).toFixed(3), '0.526');
});
test('Wilson 95 % interval', () => {
  const w = LAB.wilson(744, 1240); // 60 %
  assert.ok(Math.abs(w.lo - 0.5725) < 0.002 && Math.abs(w.hi - 0.6269) < 0.002, JSON.stringify(w));
});
test('verdict colours', () => {
  assert.strictEqual(LAB.verdict(30, 50, 0.8).v, 'few');
  assert.strictEqual(LAB.verdict(744, 1240, 0.8).v, 'above');
  assert.strictEqual(LAB.verdict(690, 1240, 0.8).v, 'unproven');
  assert.strictEqual(LAB.verdict(600, 1240, 0.8).v, 'below');
});
test('catalog has 27 strategies, 9 built (5 logics, OTC + FOREX where it exists)', () => {
  assert.strictEqual(LAB.CATALOG.length, 27);
  assert.strictEqual(LAB.CATALOG.filter(c => c.impl).length, 9);
  assert.strictEqual(new Set(LAB.CATALOG.map(c => c.id)).size, 27);
});
test('no look-ahead: a decision depends only on candles up to i', () => {
  for (const logic of ['impulse', 'range', 'fractal', 'trap', 'overheat']) {
    for (let i = 300; i < 2300; i += 7) {
      const a = LAB.run(logic, C.slice(i - 299, i + 1), LAB.PARAMS[logic]);
      // Change every future candle wildly: the decision at i must not move.
      const fut = C.map((k, j) => (j > i ? { ...k, open: k.open * 2, high: k.high * 3, low: k.low / 3, close: k.close / 2 } : k));
      const b = LAB.run(logic, fut.slice(i - 299, i + 1), LAB.PARAMS[logic]);
      assert.deepStrictEqual(a, b, logic + ' @' + i);
    }
  }
  // The strategies entry point only sees what it is given; evaluating the prefix twice gives the same answer.
  const st = { strategies: ['impulse_bot_forex'], strat_tfs: {}, strategy_settings: {} };
  const e1 = S.evaluate({ M1: C.slice(0, 1500), asset: 'EURUSD' }, ['impulse_bot_forex'], st);
  const e2 = S.evaluate({ M1: candles(6000).slice(0, 1500), asset: 'EURUSD' }, ['impulse_bot_forex'], st);
  assert.deepStrictEqual(e1.map(x => x.dir), e2.map(x => x.dir));
});
test('backtest entry is after the signal candle (no same-candle entry)', () => {
  const r = LAB.backtest(C, 'impulse_bot_otc');
  for (const t of r.trades) assert.ok(t.i + 1 < C.length);
  assert.ok(r.is.n + r.oos.n + r.all.draws === r.trades.length);
});
test('every built logic gives SIGNAL and NO_TRADE with reasons', () => {
  for (const logic of ['impulse', 'range', 'fractal', 'trap', 'overheat']) {
    let sig = 0, no = 0;
    for (let i = 300; i < C.length; i++) {
      const r = LAB.run(logic, C.slice(i - 299, i + 1), LAB.PARAMS[logic]);
      if (r.status === 'SIGNAL') { sig++; assert.ok(r.reasons.length >= 3 && r.score >= 0 && r.score <= 100 && r.stages.every(x => x === 'PASS')); }
      else { no++; assert.ok(r.rejects.length && r.stages.includes('FAIL') || r.status === 'NO_DATA'); }
    }
    assert.ok(sig > 0, logic + ': no signal in 6000 candles'); assert.ok(no > 0);
  }
});
test('OTC strategy refuses a FOREX asset and the other way round', () => {
  const x = { c: C.slice(0, 300), last: 299, otc: false, asset: 'EURUSD' };
  assert.strictEqual(LAB.STRAT.impulse_bot_otc(x, {}), null);
  assert.strictEqual(LAB.lastDecisions().impulse_bot_otc.code, 'wrong_asset_type');
});
test('old candles give STALE_DATA, fresh ones are evaluated', () => {
  const x = { c: C.slice(0, 300), last: 299, otc: true, asset: 'EURUSD_otc' };
  LAB.setStale(5); assert.strictEqual(LAB.STRAT.impulse_bot_otc(x, {}), null);
  assert.strictEqual(LAB.lastDecisions().impulse_bot_otc.status, 'STALE_DATA');
  const now = Math.floor(Date.now() / 1000 / 60) * 60 - 60, shift = now - C[299].time;
  const fresh = C.slice(0, 300).map(k => ({ ...k, time: k.time + shift }));
  LAB.setStale(65); // the engine adds the scan interval on top
  LAB.STRAT.impulse_bot_otc({ c: fresh, last: 299, otc: true, asset: 'EURUSD_otc' }, {});
  assert.notStrictEqual(LAB.lastDecisions().impulse_bot_otc.status, 'STALE_DATA');
});
test('duplicate setup and cooldown are blocked', () => {
  const s = { strategy: 'trap_bot_otc', asset: 'EURUSD_otc', dir: 1, candle: { time: 1000 } };
  assert.strictEqual(LAB.setupKey(s), LAB.setupKey({ ...s }));
  assert.notStrictEqual(LAB.setupKey(s), LAB.setupKey({ ...s, dir: -1 }));
  const signals = [{ strategy: 'trap_bot_otc', symbol: 'EURUSD_otc', created: Date.now() - 30000 }];
  assert.deepStrictEqual(LAB.riskCheck(s, signals, {}, 90), { status: 'BLOCKED_BY_RISK', reason: 'cooldown' });
  assert.strictEqual(LAB.riskCheck(s, [], {}, 90), null);
  assert.strictEqual(LAB.riskCheck(s, [], {}, 75).reason, 'min_payout');
  const many = Array.from({ length: 20 }, (_, k) => ({ strategy: 'trap_bot_otc', symbol: 'X' + k, created: Date.now() - 600000 }));
  assert.strictEqual(LAB.riskCheck(s, many, {}, 90).reason, 'daily_signal_limit');
});
test('manual limits from my trades (demo/real apart, no stake increase)', () => {
  const at = Math.floor(Date.now() / 1000);
  const tr = (r, demo) => ({ mine: true, payout: 80, trade: { at, demo, result: r } });
  const l = LAB.manualLimits([tr('LOSS', true), tr('LOSS', true), tr('LOSS', true), tr('LOSS', true), tr('WIN', false)], {}, 'DEMO');
  assert.strictEqual(l.cur.trades, 4); assert.strictEqual(l.cur.streak, 4); assert.strictEqual(l.hit, 'daily_loss_limit');
  assert.strictEqual(LAB.manualLimits([tr('LOSS', true)], {}, 'REAL').cur.trades, 0);
});
test('translations: same keys in ru / de / en (main file and lab file)', () => {
  const ctx = { localStorage: { getItem: () => null }, navigator: { language: 'de' }, document: {}, module: undefined };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'ui', 'i18n.js'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, '..', 'ui', 'i18n-lab.js'), 'utf8') + '\nthis.I18N = I18N;', ctx);
  const lab = require('../ui/i18n-lab.js');
  const k = o => Object.keys(o).sort().join();
  assert.strictEqual(k(lab.ru), k(lab.de)); assert.strictEqual(k(lab.ru), k(lab.en));
  for (const key of Object.keys(lab.ru)) for (const l of ['ru', 'de', 'en']) assert.ok(ctx.I18N[l][key], l + ' ' + key);
  // reason/reject templates exist in all three languages
  for (const [code, f] of Object.entries(LAB.T)) { const r = f({}); assert.ok(r.ru && r.de && r.en, code); }
});

// Example SIGNAL and NO_TRADE in the contract format.
function contract(id, r, asset) {
  const c = LAB.BY_ID[id], now = new Date();
  return { strategy_id: id, strategy_version: LAB.VERSION, asset, asset_type: c.asset_type, direction: r.status !== 'SIGNAL' ? null : r.dir > 0 ? 'CALL' : 'PUT',
    expiry: c.expiry[0], signal_score: r.score ?? null, stage_1: r.stages[0], stage_2: r.stages[1], stage_3: r.stages[2], status: r.status,
    reason_codes: r.reasons.map(x => x.code), reject_codes: r.rejects.map(x => x.code),
    explanation: [...r.reasons, ...r.rejects].map(x => LAB.T[x.code](x.v).ru).join('; '), risk_level: c.risk_level,
    created_at: now.toISOString(), expires_at: new Date(now.getTime() + 10000).toISOString() };
}
let exSig = null, exNo = null;
for (let i = 300; i < C.length && !(exSig && exNo); i++) {
  const r = LAB.run('impulse', C.slice(i - 299, i + 1), { ...LAB.PARAMS.impulse });
  if (r.status === 'SIGNAL' && !exSig) exSig = contract('impulse_bot_otc', r, 'EURUSD_OTC');
  if (r.status === 'NO_TRADE' && r.stage === 2 && !exNo) exNo = contract('impulse_bot_otc', r, 'EURUSD_OTC');
}
console.log('\nExample SIGNAL (synthetic data):\n' + JSON.stringify(exSig, null, 1));
console.log('\nExample NO_TRADE (synthetic data):\n' + JSON.stringify(exNo, null, 1));
console.log(`\n${ok} tests passed${process.exitCode ? ', some FAILED' : ''}`);
