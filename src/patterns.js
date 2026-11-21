'use strict';
// Pattern radar (user 21.11.2026): known trading patterns on closed M1 candles. Not a signal: the radar only lists pairs
// where a pattern has just formed and is still valid. Each detector looks at candle i and returns
// { dir: 1 | -1, stop } or null. stop = price level; if a later close goes beyond it against dir, the pattern is gone.
// LIFE = how many minutes a pattern stays in the radar. EXP = expiry (min) used for the history check.

function prep(c) {
  const n = c.length, atr = new Array(n).fill(NaN), rsi = new Array(n).fill(NaN), bbU = new Array(n).fill(NaN), bbL = new Array(n).fill(NaN), bbW = new Array(n).fill(NaN);
  let a = 0, g = 0, l = 0;
  for (let i = 1; i < n; i++) {
    const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    a = i <= 14 ? a + tr / 14 : (a * 13 + tr) / 14; if (i >= 14) atr[i] = a;
    const d = c[i].close - c[i - 1].close, up = Math.max(d, 0), dn = Math.max(-d, 0);
    g = i <= 14 ? g + up / 14 : (g * 13 + up) / 14; l = i <= 14 ? l + dn / 14 : (l * 13 + dn) / 14;
    if (i >= 14) rsi[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  let s = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const x = c[i].close; s += x; s2 += x * x;
    if (i >= 20) { const y = c[i - 20].close; s -= y; s2 -= y * y; }
    if (i >= 19) { const m = s / 20, sd = Math.sqrt(Math.max(0, s2 / 20 - m * m)); bbU[i] = m + 2 * sd; bbL[i] = m - 2 * sd; bbW[i] = m ? 4 * sd / m : 0; }
  }
  return { atr, rsi, bbU, bbL, bbW };
}

const body = k => Math.abs(k.close - k.open), rng = k => k.high - k.low, col = k => (k.close > k.open ? 1 : k.close < k.open ? -1 : 0);
const upW = k => k.high - Math.max(k.open, k.close), loW = k => Math.min(k.open, k.close) - k.low;
const hi = (c, a, b) => { let m = -Infinity; for (let j = a; j <= b; j++) m = Math.max(m, c[j].high); return m; };
const lo = (c, a, b) => { let m = Infinity; for (let j = a; j <= b; j++) m = Math.min(m, c[j].low); return m; };
const trend = (c, i, n) => Math.sign(c[i - 1].close - c[i - 1 - n].close); // move of the n candles before i
const isPivH = (c, j, w) => { for (let k = j - w; k <= j + w; k++) if (k !== j && c[k].high >= c[j].high) return false; return true; };
const isPivL = (c, j, w) => { for (let k = j - w; k <= j + w; k++) if (k !== j && c[k].low <= c[j].low) return false; return true; };
function pivots(c, a, b, w, high) { const r = []; for (let j = Math.max(a, w); j <= b; j++) if (high ? isPivH(c, j, w) : isPivL(c, j, w)) r.push(j); return r; }

const D = {
  // --- candle patterns ---
  pin(c, i, a) { const k = c[i], R = rng(k); if (R < 0.8 * a || body(k) > 0.3 * R) return null;
    if (loW(k) >= 0.6 * R) return { dir: 1, stop: k.low }; if (upW(k) >= 0.6 * R) return { dir: -1, stop: k.high }; return null; },
  pinimp(c, i, a) { const X = col(c[i - 1]); if (!X) return null; let mb = Infinity;
    for (let j = i - 3; j < i; j++) { if (col(c[j]) !== X || body(c[j]) < 0.8 * a) return null; mb = Math.min(mb, body(c[j])); }
    const k = c[i]; if (body(k) > 0.5 * mb) return null; const tail = X > 0 ? upW(k) : loW(k); if (tail < 0.1 * rng(k) || !rng(k)) return null;
    return { dir: -X, stop: X > 0 ? k.high : k.low }; },
  engulf(c, i, a) { const p = c[i - 1], k = c[i], d = col(k); if (!d || col(p) !== -d || body(k) < 0.5 * a || body(k) <= body(p)) return null;
    if (Math.max(k.open, k.close) < Math.max(p.open, p.close) || Math.min(k.open, k.close) > Math.min(p.open, p.close)) return null;
    if (trend(c, i - 1, 3) !== -d) return null; return { dir: d, stop: d > 0 ? Math.min(k.low, p.low) : Math.max(k.high, p.high) }; },
  hammer(c, i, a) { const k = c[i], b = Math.max(body(k), 1e-12); if (rng(k) < 0.6 * a || loW(k) < 2 * b || upW(k) > 0.5 * b + 0.1 * rng(k)) return null;
    const t = trend(c, i, 5); if (!t) return null; return t < 0 ? { dir: 1, stop: k.low } : { dir: -1, stop: k.high }; }, // hammer / hanging man
  star(c, i, a) { const k = c[i], b = Math.max(body(k), 1e-12); if (rng(k) < 0.6 * a || upW(k) < 2 * b || loW(k) > 0.5 * b + 0.1 * rng(k)) return null;
    const t = trend(c, i, 5); if (!t) return null; return t > 0 ? { dir: -1, stop: k.high } : { dir: 1, stop: k.low }; }, // shooting star / inverted hammer
  doji(c, i, a) { const k = c[i]; if (rng(k) < 0.5 * a || body(k) > 0.1 * rng(k)) return null; const X = col(c[i - 1]); if (!X) return null;
    for (let j = i - 3; j < i; j++) if (col(c[j]) !== X) return null; return { dir: -X, stop: X > 0 ? k.high : k.low }; },
  harami(c, i, a) { const p = c[i - 1], k = c[i], X = col(p); if (!X || body(p) < a || col(k) !== -X || body(k) > 0.5 * body(p)) return null;
    if (Math.max(k.open, k.close) > Math.max(p.open, p.close) || Math.min(k.open, k.close) < Math.min(p.open, p.close)) return null;
    return { dir: -X, stop: X > 0 ? p.high : p.low }; },
  mstar(c, i, a) { const f = c[i - 2], m = c[i - 1], k = c[i], X = col(f); if (!X || body(f) < 0.8 * a || body(m) > 0.3 * a || col(k) !== -X || body(k) < 0.5 * a) return null;
    const mid = (f.open + f.close) / 2; if (X > 0 ? k.close > mid : k.close < mid) return null;
    return { dir: -X, stop: X > 0 ? Math.max(f.high, m.high, k.high) : Math.min(f.low, m.low, k.low) }; },
  soldiers(c, i, a) { const X = col(c[i]); if (!X) return null;
    for (let j = i - 2; j <= i; j++) { if (col(c[j]) !== X || body(c[j]) < 0.6 * a) return null; if (j > i - 2 && (c[j].close - c[j - 1].close) * X <= 0) return null; }
    return { dir: X, stop: X > 0 ? c[i - 2].low : c[i - 2].high }; },
  tweezer(c, i, a) { const p = c[i - 1], k = c[i];
    if (Math.abs(k.high - p.high) <= 0.1 * a && col(p) > 0 && col(k) < 0 && Math.max(k.high, p.high) >= hi(c, i - 10, i)) return { dir: -1, stop: Math.max(k.high, p.high) };
    if (Math.abs(k.low - p.low) <= 0.1 * a && col(p) < 0 && col(k) > 0 && Math.min(k.low, p.low) <= lo(c, i - 10, i)) return { dir: 1, stop: Math.min(k.low, p.low) };
    return null; },
  inside(c, i, a) { const p = c[i - 1], k = c[i], X = col(p); if (!X || rng(p) < a || k.high >= p.high || k.low <= p.low) return null;
    return { dir: X, stop: X > 0 ? p.low : p.high }; },
  // --- chart patterns ---
  double(c, i, a) {
    for (const H of [true, false]) { const ps = pivots(c, i - 40, i - 4, 3, H); if (ps.length < 2) continue;
      const j2 = ps[ps.length - 1], j1 = ps[ps.length - 2]; if (j2 - j1 < 5) continue;
      const v1 = H ? c[j1].high : c[j1].low, v2 = H ? c[j2].high : c[j2].low; if (Math.abs(v1 - v2) > 0.3 * a) continue;
      const lvl = H ? Math.max(v1, v2) : Math.min(v1, v2), mid = H ? lo(c, j1, j2) : hi(c, j1, j2); if (Math.abs(lvl - mid) < a) continue;
      const k = c[i]; if (H && k.high >= lvl - 0.3 * a && k.high <= lvl + 0.3 * a && k.close < lvl) return { dir: -1, stop: lvl + 0.3 * a };
      if (!H && k.low <= lvl + 0.3 * a && k.low >= lvl - 0.3 * a && k.close > lvl) return { dir: 1, stop: lvl - 0.3 * a }; }
    return null; },
  triple(c, i, a) {
    for (const H of [true, false]) { const ps = pivots(c, i - 60, i - 4, 3, H); if (ps.length < 3) continue;
      const js = ps.slice(-3), v = js.map(j => (H ? c[j].high : c[j].low)); if (Math.max(...v) - Math.min(...v) > 0.4 * a || js[2] - js[0] < 12) continue;
      const lvl = H ? Math.max(...v) : Math.min(...v), k = c[i];
      if (H && k.high >= lvl - 0.3 * a && k.close < lvl) return { dir: -1, stop: lvl + 0.3 * a };
      if (!H && k.low <= lvl + 0.3 * a && k.close > lvl) return { dir: 1, stop: lvl - 0.3 * a }; }
    return null; },
  hs(c, i, a) {
    for (const H of [true, false]) { const ps = pivots(c, i - 50, i - 3, 3, H); if (ps.length < 3) continue;
      const [l, h, r] = ps.slice(-3), v = j => (H ? c[j].high : c[j].low), s = H ? 1 : -1;
      if ((v(h) - v(l)) * s < 0.5 * a || (v(h) - v(r)) * s < 0.5 * a || Math.abs(v(l) - v(r)) > 0.5 * a) continue;
      const neck = H ? Math.min(lo(c, l, h), lo(c, h, r)) : Math.max(hi(c, l, h), hi(c, h, r));
      const k = c[i], pv = c[i - 1]; if (H && k.close < neck && pv.close >= neck) return { dir: -1, stop: v(r) };
      if (!H && k.close > neck && pv.close <= neck) return { dir: 1, stop: v(r) }; }
    return null; },
  triangle(c, i, a) { const n = 20, s0 = i - n; const xs = [], hs = [], ls = [];
    for (let j = s0; j < i; j++) { xs.push(j - s0); hs.push(c[j].high); ls.push(c[j].low); }
    const sl = ys => { const m = (n - 1) / 2, my = ys.reduce((t, y) => t + y, 0) / n; let u = 0, w = 0; ys.forEach((y, x) => { u += (x - m) * (y - my); w += (x - m) ** 2; }); return u / w; };
    if (!(sl(hs) < 0 && sl(ls) > 0)) return null; if (hi(c, i - 5, i - 1) - lo(c, i - 5, i - 1) > 0.5 * (hi(c, s0, s0 + 4) - lo(c, s0, s0 + 4))) return null;
    const H = hi(c, i - 5, i - 1), L = lo(c, i - 5, i - 1), k = c[i];
    if (k.close > H) return { dir: 1, stop: L }; if (k.close < L) return { dir: -1, stop: H }; return null; },
  flag(c, i, a) { const e = i - 6, mv = c[e].close - c[e - 5].open, X = Math.sign(mv); if (Math.abs(mv) < 3 * a) return null;
    const H = hi(c, e + 1, i), L = lo(c, e + 1, i); if (H - L > 0.5 * Math.abs(mv)) return null;
    const ret = X > 0 ? c[e].close - L : H - c[e].close; if (ret > 0.5 * Math.abs(mv)) return null;
    const k = c[i]; if (X > 0 ? k.close <= hi(c, e + 1, i - 1) : k.close >= lo(c, e + 1, i - 1)) return null; // breaks out of the flag
    return { dir: X, stop: X > 0 ? L : H }; },
  retest(c, i, a) { const H = hi(c, i - 60, i - 11), L = lo(c, i - 60, i - 11), k = c[i];
    let up = false, dn = false; for (let j = i - 10; j <= i - 3; j++) { if (c[j].close > H + 0.2 * a) up = true; if (c[j].close < L - 0.2 * a) dn = true; }
    if (up && !dn && k.low <= H + 0.3 * a && k.close > H) return { dir: 1, stop: H - 0.3 * a };
    if (dn && !up && k.high >= L - 0.3 * a && k.close < L) return { dir: -1, stop: L + 0.3 * a }; return null; },
  bounce(c, i, a) { const H = hi(c, i - 60, i - 6), L = lo(c, i - 60, i - 6), k = c[i];
    if (hi(c, i - 5, i - 1) > H || lo(c, i - 5, i - 1) < L) return null;
    const touches = (lvl, isH) => { let t = 0; for (let j = i - 60; j <= i - 6; j++) if (Math.abs((isH ? c[j].high : c[j].low) - lvl) <= 0.3 * a) { t++; j += 3; } return t; };
    if (k.high >= H - 0.2 * a && k.high <= H + 0.2 * a && k.close < H - 0.1 * a && touches(H, true) >= 2) return { dir: -1, stop: H + 0.3 * a };
    if (k.low <= L + 0.2 * a && k.low >= L - 0.2 * a && k.close > L + 0.1 * a && touches(L, false) >= 2) return { dir: 1, stop: L - 0.3 * a }; return null; },
  channel(c, i, a) { const n = 30, s0 = i - n; let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (let j = s0; j < i; j++) { const x = j - s0, y = c[j].close; sx += x; sy += y; sxy += x * y; sxx += x * x; }
    const b = (n * sxy - sx * sy) / (n * sxx - sx * sx), a0 = (sy - b * sx) / n; if (Math.abs(b) * n < 2 * a) return null; // a sloped channel only
    let up = 0, dn = 0; for (let j = s0; j < i; j++) { const f = a0 + b * (j - s0); up = Math.max(up, c[j].high - f); dn = Math.max(dn, f - c[j].low); }
    const f = a0 + b * n, k = c[i];
    if (k.high >= f + 0.9 * up && k.close < f + 0.9 * up) return { dir: -1, stop: f + up + 0.3 * a };
    if (k.low <= f - 0.9 * dn && k.close > f - 0.9 * dn) return { dir: 1, stop: f - dn - 0.3 * a }; return null; },
  // --- volatility / indicators ---
  squeeze(c, i, a, P) { let m = Infinity; for (let j = i - 100; j < i - 5; j++) m = Math.min(m, P.bbW[j]);
    let sq = false; for (let j = i - 5; j < i; j++) if (P.bbW[j] <= m) sq = true; if (!sq) return null;
    const k = c[i]; if (k.close > P.bbU[i]) return { dir: 1, stop: (P.bbU[i] + P.bbL[i]) / 2 }; if (k.close < P.bbL[i]) return { dir: -1, stop: (P.bbU[i] + P.bbL[i]) / 2 }; return null; },
  bbout(c, i, a, P) { const k = c[i], X = col(k); if (!X) return null; for (let j = i - 2; j <= i; j++) if (col(c[j]) !== X) return null;
    if (X > 0 && k.close > P.bbU[i]) return { dir: -1, stop: k.high + 0.3 * a }; if (X < 0 && k.close < P.bbL[i]) return { dir: 1, stop: k.low - 0.3 * a }; return null; },
  rsidiv(c, i, a, P) {
    const ph = pivots(c, i - 20, i - 3, 3, true).pop(); if (ph != null && c[i].high > c[ph].high && P.rsi[i] < P.rsi[ph] - 5 && P.rsi[ph] > 60) return { dir: -1, stop: c[i].high + 0.3 * a };
    const pl = pivots(c, i - 20, i - 3, 3, false).pop(); if (pl != null && c[i].low < c[pl].low && P.rsi[i] > P.rsi[pl] + 5 && P.rsi[pl] < 40) return { dir: 1, stop: c[i].low - 0.3 * a };
    return null; },
};

// id, group (c = candle, g = chart, v = volatility), LIFE (min in the radar), EXP (expiry for the history check, min)
const LIST = [
  ['pin', 'c', 2, 2, 'Пин-бар', 'Pin bar'], ['pinimp', 'c', 2, 2, 'Пин-бар после импульса', 'Pin bar after impulse'],
  ['engulf', 'c', 2, 2, 'Поглощение', 'Engulfing'], ['hammer', 'c', 2, 2, 'Молот / повешенный', 'Hammer / hanging man'],
  ['star', 'c', 2, 2, 'Падающая звезда / перевёрнутый молот', 'Shooting star / inverted hammer'], ['doji', 'c', 2, 2, 'Доджи после серии', 'Doji after a run'],
  ['harami', 'c', 2, 2, 'Харами', 'Harami'], ['mstar', 'c', 2, 2, 'Утренняя / вечерняя звезда', 'Morning / evening star'],
  ['soldiers', 'c', 2, 2, 'Три солдата / три вороны', 'Three soldiers / crows'], ['tweezer', 'c', 2, 2, 'Пинцет', 'Tweezers'],
  ['inside', 'c', 2, 2, 'Внутренний бар', 'Inside bar'],
  ['double', 'g', 3, 3, 'Двойная вершина / дно', 'Double top / bottom'], ['triple', 'g', 3, 3, 'Тройная вершина / дно', 'Triple top / bottom'],
  ['hs', 'g', 3, 3, 'Голова и плечи', 'Head and shoulders'], ['triangle', 'g', 3, 3, 'Треугольник: пробой', 'Triangle breakout'],
  ['flag', 'g', 3, 3, 'Флаг / вымпел', 'Flag / pennant'], ['retest', 'g', 3, 3, 'Пробой уровня с ретестом', 'Breakout and retest'],
  ['bounce', 'g', 3, 3, 'Отбой от уровня', 'Level bounce'], ['channel', 'g', 3, 3, 'Граница канала', 'Channel edge'],
  ['squeeze', 'v', 3, 3, 'Сжатие Боллинджера: выход', 'Bollinger squeeze breakout'], ['bbout', 'v', 2, 2, 'Выход за Боллинджер после серии', 'Close outside Bollinger after a run'],
  ['rsidiv', 'v', 3, 3, 'Дивергенция RSI', 'RSI divergence'],
].map(([id, g, life, exp, ru, en]) => ({ id, g, life, exp, ru, en }));

// History check 21.11.2026 (13.5 days, 53 OTC pairs, entry on the close, expiry EXP): first / second half, %. Not a probability.
const WR = {"pin": "50/49", "pinimp": "53/54", "engulf": "50/50", "hammer": "50/50", "star": "50/50", "doji": "50/50", "harami": "50/51", "mstar": "49/49", "soldiers": "50/51", "tweezer": "50/51", "inside": "50/50", "double": "50/50", "triple": "50/51", "hs": "50/53", "triangle": "49/48", "flag": "50/52", "retest": "49/51", "bounce": "50/49", "channel": "50/50", "squeeze": "50/50", "bbout": "50/49", "rsidiv": "50/50"};
LIST.forEach(p => { p.wr = WR[p.id]; });

const MIN = 110; // candles needed before i (the squeeze looks 100 back)
function at(c, i, P, id) { if (i < MIN || i >= c.length) return null; const a = P.atr[i]; if (!(a > 0)) return null; try { return D[id](c, i, a, P); } catch { return null; } }

// Live: patterns formed on the last LIFE closed candles that are still valid (no close beyond stop since).
function active(c, P, ids) {
  const out = [], n = c.length - 1;
  for (const p of LIST) { if (ids && !ids.includes(p.id)) continue;
    for (let age = 0; age < p.life; age++) { const i = n - age, r = at(c, i, P, p.id); if (!r) continue;
      let ok = true; for (let j = i + 1; j <= n; j++) if (r.dir > 0 ? c[j].close < r.stop : c[j].close > r.stop) { ok = false; break; }
      if (ok) out.push({ id: p.id, dir: r.dir, age, left: p.life - age, time: c[i].time }); break; } }
  return out;
}

module.exports = { LIST, prep, at, active, MIN };
