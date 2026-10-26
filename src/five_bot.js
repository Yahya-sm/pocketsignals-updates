// «5 на 5» точно как в Telegram-боте (@yahyaschka_bot, bot.py: s_5x5 + fast_pick), перенесено 26.10.2026.
// Работает только по закрытым свечам c[0..last]; индикаторы считаются так же, как в pandas (ewm adjust=False).
//
// Сигнал ВВЕРХ: свеча открылась ниже SMA(candle_ma) и закрылась выше, RSI 5 > 50.  ВНИЗ — зеркально.
// Фильтры (каждый включается параметром):
//   five_er_min   — «не флэт»: эффективность движения за 10 свечей не ниже (0 — выкл);
//   five_trend    — по тренду EMA 50: цена по нужную сторону EMA 50 и EMA 50 растёт/падает за 5 свечей;
//   five_adx_min  — ADX (период 7, как в боте) не ниже (0 — выкл);
//   five_sar      — Parabolic SAR 0.05/0.2 по стороне сигнала и перевернулся не больше N точек назад (0 — выкл);
//   five_confirm  — подтверждение разворота: свеча закрылась за максимумом/минимумом прошлой и Stochastic 14,3,3 повернул;
//   five_room     — место до ближайшего уровня по ходу сигнала, в ATR 14 (0 — выкл).

function ewm(v, alpha) { // pandas: Series.ewm(alpha, adjust=False).mean(), старт с первого числа
  const out = Array(v.length).fill(NaN); let e = NaN;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (!Number.isFinite(x)) { out[i] = e; continue; }
    e = Number.isFinite(e) ? alpha * x + (1 - alpha) * e : x;
    out[i] = e;
  }
  return out;
}
const emaS = (v, n) => ewm(v, 2 / (n + 1));
const wilder = (v, n) => ewm(v, 1 / n);
function sma(v, n, i) { if (i < n - 1) return NaN; let s = 0; for (let k = i - n + 1; k <= i; k++) s += v[k]; return s / n; }

function rsi(close, n) {
  const g = [NaN], l = [NaN];
  for (let i = 1; i < close.length; i++) { const d = close[i] - close[i - 1]; g.push(Math.max(d, 0)); l.push(Math.max(-d, 0)); }
  const G = wilder(g, n), L = wilder(l, n);
  return G.map((gv, i) => {
    const lv = L[i];
    if (!(lv > 0) && !(gv <= 0)) return 100;            // убытков нет, только рост
    if (!(lv > 0)) return 50;                            // нет движения вообще (как fillna(50))
    return 100 - 100 / (1 + gv / lv);
  });
}

function trArr(c) {
  return c.map((k, i) => i === 0 ? k.high - k.low
    : Math.max(k.high - k.low, Math.abs(k.high - c[i - 1].close), Math.abs(k.low - c[i - 1].close)));
}

function adx(c, n) {
  const atrW = wilder(trArr(c), n), p = [0], m = [0];
  for (let i = 1; i < c.length; i++) {
    const up = c[i].high - c[i - 1].high, dn = c[i - 1].low - c[i].low;
    p.push(up > dn && up > 0 ? up : 0); m.push(dn > up && dn > 0 ? dn : 0);
  }
  // в pandas первое значение diff — NaN, поэтому сглаживание +DM/−DM начинается с нуля на свече 0 (np.where → 0.0)
  const P = wilder(p, n), M = wilder(m, n);
  const dx = c.map((_, i) => {
    const a = atrW[i] > 0 ? atrW[i] : NaN, pd = 100 * P[i] / a, md = 100 * M[i] / a, s = pd + md;
    const v = 100 * Math.abs(pd - md) / (s !== 0 ? s : NaN);
    return Number.isFinite(v) ? v : 0;
  });
  return wilder(dx, n);
}

function psar(c, step, mx) { // Parabolic SAR Уайлдера, как psar() в боте: [сторона, номер точки]
  const n = c.length, side = Array(n).fill(0), cnt = Array(n).fill(0);
  if (n < 3) return { side, cnt };
  let up = c[1].high >= c[0].high, ep = up ? c[0].high : c[0].low, s = up ? c[0].low : c[0].high, af = step, run = 0;
  for (let i = 1; i < n; i++) {
    s = s + af * (ep - s);
    if (up) {
      s = Math.min(s, c[i - 1].low, i > 1 ? c[i - 2].low : c[i - 1].low);
      if (c[i].low < s) { up = false; s = ep; ep = c[i].low; af = step; run = 0; }
      else if (c[i].high > ep) { ep = c[i].high; af = Math.min(af + step, mx); }
    } else {
      s = Math.max(s, c[i - 1].high, i > 1 ? c[i - 2].high : c[i - 1].high);
      if (c[i].high > s) { up = true; s = ep; ep = c[i].high; af = step; run = 0; }
      else if (c[i].low < ep) { ep = c[i].low; af = Math.min(af + step, mx); }
    }
    run++; side[i] = up ? 1 : -1; cnt[i] = run;
  }
  return { side, cnt };
}

function stochKD(c, i) { // Stochastic 14,3,3 на свече i
  const raw = j => {
    if (j < 13) return NaN;
    let hi = -Infinity, lo = Infinity;
    for (let k = j - 13; k <= j; k++) { hi = Math.max(hi, c[k].high); lo = Math.min(lo, c[k].low); }
    return hi - lo > 0 ? 100 * (c[j].close - lo) / (hi - lo) : NaN;
  };
  const kAt = j => (raw(j) + raw(j - 1) + raw(j - 2)) / 3;
  return { k: kAt(i), d: (kAt(i) + kAt(i - 1) + kAt(i - 2)) / 3 };
}

function levels(c, i, atr) { // уровни бота: экстремумы 2/2 за 80 свечей, близкие (0,3 ATR) объединяются
  const lo = Math.max(2, i - 80), pts = [];
  for (let j = lo; j < i - 2; j++) {
    let hiP = true, loP = true;
    for (let k = j - 2; k <= j + 2; k++) { if (c[k].high > c[j].high) hiP = false; if (c[k].low < c[j].low) loP = false; }
    if (hiP) pts.push(c[j].high); if (loP) pts.push(c[j].low);
  }
  pts.sort((a, b) => a - b);
  const groups = [];
  for (const x of pts) {
    const g = groups[groups.length - 1];
    if (g && x - g[g.length - 1] <= 0.3 * atr) g.push(x); else groups.push([x]);
  }
  return groups.map(g => g.reduce((s, v) => s + v, 0) / g.length);
}

// Возвращает { dir, reason } или { dir: 0, reason } — почему нет сигнала.
function five5(c, last, p = {}) {
  const i = last, k = c[i];
  if (i < 60) return { dir: 0, reason: 'мало истории' };
  const close = c.map(x => x.close);
  const n = Number(p.candle_ma) || 5, ma = sma(close, n, i), r5 = rsi(close, 5)[i];
  let dir = 0;
  if (k.open < ma && ma < k.close && r5 > 50) dir = 1;
  else if (k.open > ma && ma > k.close && r5 < 50) dir = -1;
  if (!dir) return { dir: 0, reason: `свеча не пересекает SMA ${n} или RSI 5 не подтверждает` };
  const up = dir > 0;
  const erMin = Number(p.five_er_min ?? 0.3);
  if (erMin > 0) {
    let path = 0; for (let j = i - 9; j <= i; j++) path += Math.abs(close[j] - close[j - 1]);
    const er = path > 0 ? Math.abs(close[i] - close[i - 10]) / path : 0;
    if (er < erMin) return { dir: 0, reason: `флэт: эффективность ${er.toFixed(2)} < ${erMin}` };
  }
  if (p.five_trend !== false) {
    const e50 = emaS(close, 50);
    const ok = up ? (k.close > e50[i] && e50[i] > e50[i - 5]) : (k.close < e50[i] && e50[i] < e50[i - 5]);
    if (!ok) return { dir: 0, reason: 'против тренда EMA 50' };
  }
  const adxMin = Number(p.five_adx_min ?? 20);
  if (adxMin > 0) {
    const a = adx(c, 7)[i];
    if (!(a >= adxMin)) return { dir: 0, reason: `ADX ${Number.isFinite(a) ? a.toFixed(0) : '—'} ниже ${adxMin}` };
  }
  const sarN = Number(p.five_sar ?? 4);
  if (sarN > 0) {
    const s = psar(c, 0.05, 0.2);
    if (s.side[i] && s.side[i] !== dir) return { dir: 0, reason: 'Parabolic SAR ещё против сигнала' };
    if (s.cnt[i] > sarN) return { dir: 0, reason: `SAR перевернулся ${s.cnt[i]} точек назад (нужна 1–${sarN})` };
  }
  if (p.five_confirm !== false) {
    const prev = c[i - 1], st = stochKD(c, i);
    const candle = up ? (k.close > k.open && k.close > prev.high) : (k.close < k.open && k.close < prev.low);
    const turn = up ? st.k > st.d : st.k < st.d;
    if (!(candle && turn)) return { dir: 0, reason: 'разворот не подтверждён (свеча или Stochastic)' };
  }
  const roomMin = Number(p.five_room ?? 0.7);
  if (roomMin > 0) {
    const atr = wilder(trArr(c), 14)[i];
    if (atr > 0) {
      const lv = levels(c, i, atr).filter(x => (x - k.close) * dir > 0);
      if (lv.length) {
        const room = Math.min(...lv.map(x => (x - k.close) * dir / atr));
        if (room < roomMin) return { dir: 0, reason: `до уровня по ходу сигнала ${room.toFixed(2)} ATR` };
      }
    }
  }
  return { dir, reason: `SMA ${n} пересекла свечу, RSI 5 ${r5.toFixed(0)}` };
}

module.exports = { five5 };
