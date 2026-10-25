// Classic indicators over arrays of candles {open, high, low, close}. All return arrays aligned to input.
function sma(v, n) {
  const out = Array(v.length).fill(null); let s = 0;
  for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= n) s -= v[i - n]; if (i >= n - 1) out[i] = s / n; }
  return out;
}
function ema(v, n) {
  const out = Array(v.length).fill(null); const k = 2 / (n + 1); let e = null;
  for (let i = 0; i < v.length; i++) { e = e === null ? v[i] : v[i] * k + e * (1 - k); if (i >= n - 1) out[i] = e; }
  return out;
}
function ma(v, n, type) { return type === 'SMA' ? sma(v, n) : ema(v, n); }

function rsi(v, n) {
  const out = Array(v.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i < v.length; i++) {
    const d = v[i] - v[i - 1], up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up / n; l += dn / n; } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; }
    if (i >= n) out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}
function trueRange(c, i) {
  if (i === 0) return c[0].high - c[0].low;
  return Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
}
function atr(c, n = 14) {
  const out = Array(c.length).fill(null); let a = 0;
  for (let i = 0; i < c.length; i++) {
    const tr = trueRange(c, i);
    if (i < n) { a += tr / n; if (i === n - 1) out[i] = a; } else { a = (a * (n - 1) + tr) / n; out[i] = a; }
  }
  return out;
}
function adx(c, n = 14) {
  const out = Array(c.length).fill(null);
  let trS = 0, pS = 0, mS = 0, adxV = null; const dxs = [];
  for (let i = 1; i < c.length; i++) {
    const up = c[i].high - c[i - 1].high, dn = c[i - 1].low - c[i].low;
    const p = up > dn && up > 0 ? up : 0, m = dn > up && dn > 0 ? dn : 0, tr = trueRange(c, i);
    if (i <= n) { trS += tr; pS += p; mS += m; } else { trS = trS - trS / n + tr; pS = pS - pS / n + p; mS = mS - mS / n + m; }
    if (i < n) continue;
    const pdi = trS ? 100 * pS / trS : 0, mdi = trS ? 100 * mS / trS : 0;
    const dx = pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0;
    if (adxV === null) { dxs.push(dx); if (dxs.length === n) adxV = dxs.reduce((a, b) => a + b) / n; }
    else adxV = (adxV * (n - 1) + dx) / n;
    out[i] = adxV === null ? null : { adx: adxV, pdi, mdi };
  }
  return out;
}
function psar(c, step = 0.02, max = 0.2) {
  const out = Array(c.length).fill(null); if (c.length < 2) return out;
  let up = c[1].close >= c[0].close, sar = up ? c[0].low : c[0].high, ep = up ? c[1].high : c[1].low, af = step;
  for (let i = 1; i < c.length; i++) {
    sar = sar + af * (ep - sar);
    if (up) {
      sar = Math.min(sar, c[i - 1].low, i > 1 ? c[i - 2].low : c[i - 1].low);
      if (c[i].low < sar) { up = false; sar = ep; ep = c[i].low; af = step; }
      else if (c[i].high > ep) { ep = c[i].high; af = Math.min(af + step, max); }
    } else {
      sar = Math.max(sar, c[i - 1].high, i > 1 ? c[i - 2].high : c[i - 1].high);
      if (c[i].high > sar) { up = true; sar = ep; ep = c[i].high; af = step; }
      else if (c[i].low < ep) { ep = c[i].low; af = Math.min(af + step, max); }
    }
    out[i] = { sar, up };
  }
  return out;
}
function stoch(c, kN = 14, kS = 3, dS = 3) {
  const raw = c.map((_, i) => {
    if (i < kN - 1) return null;
    let hi = -Infinity, lo = Infinity;
    for (let j = i - kN + 1; j <= i; j++) { hi = Math.max(hi, c[j].high); lo = Math.min(lo, c[j].low); }
    return hi === lo ? 50 : 100 * (c[i].close - lo) / (hi - lo);
  });
  const k = smaNull(raw, kS), d = smaNull(k, dS);
  return { k, d };
}
// SMA that skips leading nulls.
function smaNull(v, n) {
  const start = v.findIndex(x => x !== null); const out = Array(v.length).fill(null);
  if (start < 0) return out;
  const s = sma(v.slice(start), n); s.forEach((x, i) => { out[start + i] = x; }); return out;
}
function emaNull(v, n) {
  const start = v.findIndex(x => x !== null); const out = Array(v.length).fill(null);
  if (start < 0) return out;
  const s = ema(v.slice(start), n); s.forEach((x, i) => { out[start + i] = x; }); return out;
}
function macd(v, f = 12, s = 26, sig = 9) {
  const a = ema(v, f), b = ema(v, s);
  const line = v.map((_, i) => (a[i] === null || b[i] === null ? null : a[i] - b[i]));
  const signal = emaNull(line, sig);
  return { line, signal, hist: line.map((x, i) => (x === null || signal[i] === null ? null : x - signal[i])) };
}
function bollinger(v, n = 20, mult = 2) {
  const mid = sma(v, n);
  return v.map((_, i) => {
    if (mid[i] === null) return null;
    let s = 0; for (let j = i - n + 1; j <= i; j++) s += (v[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / n);
    return { mid: mid[i], up: mid[i] + mult * sd, lo: mid[i] - mult * sd, width: (2 * mult * sd) / mid[i] };
  });
}
function cci(c, n = 20) {
  const tp = c.map(k => (k.high + k.low + k.close) / 3), m = sma(tp, n);
  return tp.map((x, i) => {
    if (m[i] === null) return null;
    let md = 0; for (let j = i - n + 1; j <= i; j++) md += Math.abs(tp[j] - m[i]);
    md /= n; return md ? (x - m[i]) / (0.015 * md) : 0;
  });
}
function supertrend(c, n = 10, mult = 3) {
  const a = atr(c, n), out = Array(c.length).fill(null);
  let upper = null, lower = null, up = true;
  for (let i = 0; i < c.length; i++) {
    if (a[i] === null) continue;
    const hl = (c[i].high + c[i].low) / 2, bu = hl + mult * a[i], bl = hl - mult * a[i];
    upper = upper === null || bu < upper || c[i - 1].close > upper ? bu : upper;
    lower = lower === null || bl > lower || c[i - 1].close < lower ? bl : lower;
    if (up && c[i].close < lower) up = false; else if (!up && c[i].close > upper) up = true;
    out[i] = { up, line: up ? lower : upper };
  }
  return out;
}
function vortex(c, n = 14) {
  const out = Array(c.length).fill(null);
  for (let i = n; i < c.length; i++) {
    let vp = 0, vm = 0, tr = 0;
    for (let j = i - n + 1; j <= i; j++) {
      vp += Math.abs(c[j].high - c[j - 1].low); vm += Math.abs(c[j].low - c[j - 1].high);
      tr += Math.max(c[j].high - c[j].low, Math.abs(c[j].high - c[j - 1].close), Math.abs(c[j].low - c[j - 1].close));
    }
    out[i] = { plus: vp / tr, minus: vm / tr };
  }
  return out;
}
// Bill Williams fractal confirmed 2 bars later: returns { i, type: 'high'|'low', price } list.
function fractals(c) {
  const out = [];
  for (let i = 2; i < c.length - 2; i++) {
    const h = c[i].high, l = c[i].low;
    if (h > c[i - 1].high && h > c[i - 2].high && h > c[i + 1].high && h > c[i + 2].high) out.push({ i, type: 'high', price: h });
    if (l < c[i - 1].low && l < c[i - 2].low && l < c[i + 1].low && l < c[i + 2].low) out.push({ i, type: 'low', price: l });
  }
  return out;
}
const body = k => Math.abs(k.close - k.open);
const dirOf = k => (k.close > k.open ? 1 : k.close < k.open ? -1 : 0);

// Combine 1-minute candles into N-minute candles aligned to the clock.
function resample(c, minutes) {
  if (minutes <= 1) return c;
  const out = [], sec = minutes * 60;
  for (const k of c) {
    const t = Math.floor(k.time / sec) * sec, last = out[out.length - 1];
    if (last && last.time === t) { last.high = Math.max(last.high, k.high); last.low = Math.min(last.low, k.low); last.close = k.close; last.n++; }
    else out.push({ time: t, open: k.open, high: k.high, low: k.low, close: k.close, n: 1 });
  }
  if (out.length && out[out.length - 1].n < minutes) out.pop(); // drop the unfinished bucket
  return out;
}

module.exports = { sma, ema, ma, rsi, atr, adx, psar, stoch, macd, bollinger, cci, supertrend, vortex, fractals, body, dirOf, resample };
