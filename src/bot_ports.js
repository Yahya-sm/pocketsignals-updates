// Стратегии Telegram-бота (@yahyaschka_bot, bot.py), перенесённые 26.10.2026 без изменения логики.
// Каждая функция получает свечи c (старые → новые) и индекс последней свечи; последняя может быть ещё не закрытой
// («живой»): это определяется по времени — свеча текущей минуты (текущего периода) считается живой.
// Возвращают { dir, reason, expiry?, entry?, bar? } или { dir: 0, reason } — почему нет сигнала.

// ---------- общие расчёты (как pandas ewm adjust=False) ----------
function ewm(v, alpha) {
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
function trArr(c) {
  return c.map((k, i) => i === 0 ? k.high - k.low
    : Math.max(k.high - k.low, Math.abs(k.high - c[i - 1].close), Math.abs(k.low - c[i - 1].close)));
}
const nowSec = () => Date.now() / 1000;
const isLive = (c, i, period = 60) => c[i].time + period > nowSec();       // свеча ещё не закрылась
const secondsLeft = (c, i, period = 60) => c[i].time + period - nowSec();

// Тренд M5 бота (m5_trend): закрытые M5-свечи до свечи i; вверх — цена > EMA 20 > EMA 50 и EMA 20 выросла за 3 свечи M5.
function m5Trend(c, i) {
  if (i < 60) return 0;
  const bins = new Map();                                   // начало 5-минутки → close последней минуты в ней
  for (let k = 0; k < i; k++) bins.set(Math.floor(c[k].time / 300) * 300, c[k].close);
  let keys = [...bins.keys()].sort((a, b) => a - b);
  // pandas resample('5min').last(): пустые 5-минутки (выходные/пропуски) дают NaN и отбрасываются — как здесь.
  if (keys.length && keys[keys.length - 1] + 300 > c[i].time) keys = keys.slice(0, -1);   // последняя M5 не закрыта
  if (keys.length < 25) return 0;
  const m5 = keys.map(k => bins.get(k)), e20 = emaS(m5, 20), e50 = emaS(m5, 50), n = m5.length - 1;
  const x = m5[n], a = e20[n], b = e50[n], sl = e20[n] - e20[n - 3];
  if (x > a && a > b && sl > 0) return 1;
  if (x < a && a < b && sl < 0) return -1;
  return 0;
}
const zurichHour = t => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Zurich', hour: '2-digit', hour12: false }).format(new Date(t * 1000))) % 24;

// ---------- 1. Откат после большой свечи (s_bigcandle) ----------
const BIG_BAD_HOURS = [0, 2, 7, 8, 9];
function bigFade(c, i, p = {}) {
  if (i < 20) return { dir: 0, reason: 'мало истории' };
  const live = isLive(c, i);
  if (live) {                                               // сигнал ДО закрытия: только в окне за preclose_sec до конца свечи
    const left = secondsLeft(c, i), pre = Number(p.preclose_sec || 8);
    const [lo, hi] = pre >= 8 ? [3, 10] : [2, 6];             // бот: 5,5–8,5 с (или 3–5,5 с); проверка раз в 5 с → окно чуть шире
    if (!(left >= lo && left <= hi)) return { dir: 0, reason: 'ожидание окна перед закрытием свечи' };
  }
  const atr = ewm(trArr(c), 1 / 14)[i - 1];                 // ATR 14 (Уайлдер) по свечам ДО большой свечи
  if (!(atr > 0)) return { dir: 0, reason: 'нет ATR' };
  const k = c[i], size = Math.abs(k.close - k.open) / atr;
  if (size < Number(p.big_body ?? 4)) return { dir: 0, reason: `свеча ${size.toFixed(1)} ATR — не большая` };
  if (p.big_quiet) {
    const atrs = ewm(trArr(c), 1 / 14), w = atrs.slice(Math.max(0, i - 100), i).filter(Number.isFinite).sort((a, b) => a - b);
    const med = w.length >= 30 ? (w.length % 2 ? w[(w.length - 1) / 2] : (w[w.length / 2 - 1] + w[w.length / 2]) / 2) : NaN;
    if (!(med > 0) || atr / med >= 0.8) return { dir: 0, reason: 'рынок перед свечой не был тихим' };
  }
  const up = k.close < k.open;                              // большая красная → ВВЕРХ, зелёная → ВНИЗ
  if (p.big_m5 !== false) { const t = m5Trend(c, i); if ((up && t < 0) || (!up && t > 0)) return { dir: 0, reason: 'против тренда M5' }; }
  if (p.big_hours && BIG_BAD_HOURS.includes(zurichHour(k.time))) return { dir: 0, reason: 'неудачный час' };
  if (p.big_away) {
    const e50 = emaS(c.map(x => x.close), 50)[i - 1];
    if (Number.isFinite(e50) && ((up && k.close >= e50) || (!up && k.close <= e50))) return { dir: 0, reason: 'свеча вернула цену к EMA 50' };
  }
  if (p.big_rsiedge) {
    const cl = c.map(x => x.close), g = [NaN], l = [NaN];
    for (let j = 1; j < cl.length; j++) { const d = cl[j] - cl[j - 1]; g.push(Math.max(d, 0)); l.push(Math.max(-d, 0)); }
    const G = ewm(g, 1 / 14)[i], L = ewm(l, 1 / 14)[i], r = L > 0 ? 100 - 100 / (1 + G / L) : (G <= 0 ? 50 : 100);
    if (r >= 40 && r <= 60) return { dir: 0, reason: `RSI ${r.toFixed(0)} в середине` };
  }
  return { dir: up ? 1 : -1, expiry: 120, reason: `${live ? '⏰ до закрытия — вход с открытия следующей свечи · ' : ''}большая ${up ? 'красная' : 'зелёная'} свеча ×${size.toFixed(1)} ATR` };
}

// ---------- 2. Серия свечей → откат (_sharp_scan, условие «серия») ----------
const SERIES_BAD_HOURS = [3, 8, 16, 19, 21];
function sharpSeries(c, i, p = {}, otc = true) {
  if (i < 30) return { dir: 0, reason: 'мало истории' };
  const live = isLive(c, i);
  if (live) {
    const left = secondsLeft(c, i), pre = Number(p.preclose_sec || 8);
    const [lo, hi] = pre >= 8 ? [3, 10] : [2, 6];
    if (!(left >= lo && left <= hi)) return { dir: 0, reason: 'ожидание окна перед закрытием свечи' };
  } else {
    const fresh = Number(p.sharp_fresh || 0) > 0 ? Number(p.sharp_fresh) : 15;
    const after = nowSec() - (c[i].time + 60);
    if (!(after >= 0 && after <= fresh + 3)) return { dir: 0, reason: 'свеча закрылась слишком давно' };   // +3 с — PocketSignals проверяет через 1,5 с после закрытия
  }
  let dir = 0, txt = '';
  if (p.sharp_move === true) {                              // условие «резкое движение за 5 свечей» (у пользователя выключено)
    const tr = trArr(c), atrAt = j => { let s = 0; for (let q = j - 13; q <= j; q++) s += tr[q]; return s / 14; };
    const N = Number(p.sharp_drop ?? 4), a = atrAt(i), ap = atrAt(i - 1);
    const mv = (c[i].close - c[i - 5].close) / a, mvp = ap > 0 ? (c[i - 1].close - c[i - 6].close) / ap : 0;
    if (mv < -N && !(mvp < -N) && p.sharp_buy !== false) dir = 1;
    else if (mv > N && !(mvp > N) && p.sharp_sell !== false) dir = -1;
    if (dir && (dir > 0 ? -mv : mv) <= N) dir = 0;
    if (dir) txt = `движение ${Math.abs(mv).toFixed(1)} средних свечи за 5`;
  }
  if (!dir && p.sharp_series !== false) {
    const body = c.map(k => Math.abs(k.close - k.open)), col = c.map(k => Math.sign(k.close - k.open));
    let usual = 0; for (let j = i - 22; j < i - 2; j++) usual += body[j]; usual /= 20;
    const sg = col[i];
    if (usual > 0 && sg !== 0) {
      let k = 0; while (k < 8 && col[i - k] === sg && body[i - k] > usual) k++;
      let mx = 0; for (let j = i - k + 1; j <= i; j++) mx = Math.max(mx, body[j]);
      const imp = k ? mx / usual : 0, kmin = Number(p.sharp_min || 3);
      if (k === kmin && imp >= Number(p.sharp_imp ?? 2)) {
        if (sg < 0 && p.sharp_buy !== false) dir = 1; else if (sg > 0 && p.sharp_sell !== false) dir = -1;
        if (dir) txt = `${k} ${sg < 0 ? 'красных' : 'зелёных'} свечи подряд больше обычных, импульс ×${imp.toFixed(1)}`;
      }
    }
  }
  if (!dir) return { dir: 0, reason: 'нет серии' };
  if (p.sharp_hours && SERIES_BAD_HOURS.includes(zurichHour(c[i].time))) return { dir: 0, reason: 'неудачный час' };
  if (p.sharp_m5 !== false) { const t = m5Trend(c, i); if ((dir > 0 && t < 0) || (dir < 0 && t > 0)) return { dir: 0, reason: 'против тренда M5' }; }
  // фильтр качества серии в боте действует только на M5 (sharp_quality: 'm5'); на M1 он не применяется
  if (Number(p.sharp_adx || 0) > 0) {
    const tr = trArr(c), aw = ewm(tr, 1 / 14), pd = [0], md = [0];
    for (let j = 1; j < c.length; j++) { const u = c[j].high - c[j - 1].high, d = c[j - 1].low - c[j].low; pd.push(u > d && u > 0 ? u : 0); md.push(d > u && d > 0 ? d : 0); }
    const P = ewm(pd, 1 / 14), M = ewm(md, 1 / 14);
    const dx = c.map((_, j) => { const a = aw[j] > 0 ? aw[j] : NaN, x = 100 * P[j] / a, y = 100 * M[j] / a, v = 100 * Math.abs(x - y) / (x + y); return Number.isFinite(v) ? v : 0; });
    const adx = ewm(dx, 1 / 14)[i];
    if (adx > Number(p.sharp_adx)) return { dir: 0, reason: `ADX ${adx.toFixed(0)} выше порога` };
  }
  if (p.sharp_day_only === true && !otc) { const h = zurichHour(c[i].time + 60); if (h < 8 || h > 21) return { dir: 0, reason: 'обычная пара ночью' }; }
  return { dir, expiry: Number(p.sharp_expiry || 180), reason: `${live ? '⏰ до закрытия — вход с открытия следующей свечи · ' : ''}${txt}` };
}

// ---------- 3. Подход к уровню → отскок (level_touch.py + level_scanner) ----------
const LW = 5, LLB = 240, LZ = 0.25, LOOK = 60;
function levelZones(c, n) {              // зоны по ЗАКРЫТЫМ свечам c[0..n-1]
  if (n < 120) return null;
  let R = 0; for (let k = n - 20; k < n; k++) R += c[k].high - c[k].low; R /= 20;
  if (!(R > 0)) return null;
  const piv = (j, hi) => { const v = hi ? c[j].high : c[j].low; for (let k = j - LW; k <= j + LW; k++) { const u = hi ? c[k].high : c[k].low; if (hi ? u > v : u < v) return false; } return true; };
  const res = [], sup = [], pl = [], ph = [];
  for (let j = Math.max(LW, n - LLB); j < n - LW; j++) {
    if (piv(j, true)) ph.push(c[j].high);
    if (piv(j, false)) pl.push(c[j].low);
    for (const [hi, out, sg] of [[true, res, 1], [false, sup, -1]]) {
      if (!piv(j, hi)) continue;
      const a = j + LW + 1; if (a - 21 < 0 || a > n - 1) continue;
      let Rc = 0; for (let k = a - 21; k < a - 1; k++) Rc += c[k].high - c[k].low; Rc /= 20; if (!(Rc > 0)) continue;
      const P = hi ? c[j].high : c[j].low, lo = P - sg * LZ / 2 * Rc, hiE = P + sg * LZ / 2 * Rc;
      let broken = false; for (let k = a; k < n; k++) if (sg * c[k].close > sg * hiE) { broken = true; break; }
      if (broken) continue;
      let nth = 0; for (let k = a; k < n; k++) { const x = sg * (hi ? c[k].high : c[k].low), xp = sg * (hi ? c[k - 1].high : c[k - 1].low); if (x >= sg * lo && xp < sg * lo) nth++; }
      out.push([lo, hiE, nth]);
    }
  }
  return { R, res, sup, pl, ph, n };
}
function levelTouch(c, i, p = {}) {
  if (!isLive(c, i)) return { dir: 0, reason: 'сигнал только в момент касания (живая свеча)' };
  if (c[i - 1].time !== c[i].time - 60) return { dir: 0, reason: 'разрыв истории' };
  if (nowSec() - c[i].time < 1) return { dir: 0, reason: 'первая секунда минуты' };
  const zs = levelZones(c, i); if (!zs) return { dir: 0, reason: 'мало истории' };
  const R = zs.R; let best = null;
  for (const [side, lst, sg, ext, prev] of [['PUT', zs.res, 1, c[i].high, c[i - 1].high], ['CALL', zs.sup, -1, c[i].low, c[i - 1].low]]) {
    const hit = lst.filter(z => sg * prev < sg * z[0] && sg * z[0] <= sg * ext);
    if (!hit.length) continue;
    const z = hit.reduce((a, b) => (sg * b[0] < sg * a[0] ? b : a));
    if (!best) best = { side, sg, lo: z[0], hi: z[1], nth: z[2] };
  }
  if (!best) return { dir: 0, reason: 'нет касания зоны' };
  const { sg, lo, nth } = best;
  if (p.lvl_first !== false && nth > 0) return { dir: 0, reason: `не первое касание (${nth})` };
  let k = 0, ext = sg > 0 ? Infinity : -Infinity;
  for (let j = 0; j < LOOK; j++) { const v = sg > 0 ? c[i - LOOK + j].low : c[i - LOOK + j].high; if (sg > 0 ? v < ext : v > ext) { ext = v; k = j; } }
  const length = sg * (lo - ext) / R, dur = LOOK - k;
  let path = 0; for (let j = i - LOOK + k + 1; j < i; j++) path += Math.abs(c[j].close - c[j - 1].close);
  const er = path > 0 ? Math.abs(c[i - 1].close - c[i - LOOK + k].close) / path : 1;
  const price = c[i - 1].close, opp = (sg > 0 ? zs.pl : zs.ph).filter(v => sg * v < sg * price);
  const width = opp.length ? sg * (lo - (sg > 0 ? Math.max(...opp) : Math.min(...opp))) / R : Infinity;
  if (length < Number(p.lvl_len || 0)) return { dir: 0, reason: 'путь короче порога' };
  if (er < Number(p.lvl_er || 0)) return { dir: 0, reason: 'направленность ниже порога' };
  if (width < Number(p.lvl_width || 0)) return { dir: 0, reason: 'коридор уже порога' };
  if (sg * (lo - c[i].close) > 0.5 * R) return { dir: 0, reason: 'цена уже ушла от уровня' };
  return { dir: -sg, expiry: 60, entry: Math.floor(nowSec()), bar: c[i].time,
    reason: `⏰ вход сейчас — цена у ${sg > 0 ? 'сопротивления' : 'поддержки'} ${+lo.toPrecision(6)} · ${nth === 0 ? 'первое касание' : 'касание №' + (nth + 1)} · путь ${length.toFixed(1)} ср. свечи за ${dur} мин` };
}

// ---------- 4. Пересечение MA 2/5 внутри свечи (ma25_cross.py) ----------
function ma25(c, i, p = {}, tfMin = 2) {
  const period = tfMin * 60;
  if (!isLive(c, i, period)) return { dir: 0, reason: 'сигнал только внутри живой свечи' };
  const fast = Number(p.m25_fast || 2), slow = Number(p.m25_slow || 5), ft = p.m25_fast_type || 'SMA', st = p.m25_slow_type || 'SMA';
  const z = c.slice(0, i);                                   // закрытые свечи таймфрейма
  // The bot wanted 56 closed candles; PocketOption gives only ~150 M1 (≈74 M2, 49 M3), so take what is there (min. 5 × slow for the EMA).
  const need = Math.min(Math.max(56, 5 * slow), z.length);
  if (need < 5 * slow) return { dir: 0, reason: 'мало закрытой истории' };
  for (let j = z.length - need + 1; j < z.length; j++) if (z[j].time - z[j - 1].time !== period) return { dir: 0, reason: 'разрыв истории средних' };
  const zc = z.slice(-need).map(k => k.close);
  const lin = (n, kind) => {
    if (kind === 'SMA') { let s = 0; for (let j = zc.length - (n - 1); j < zc.length; j++) s += zc[j]; return [1 / n, n > 1 ? s / n : 0]; }
    const a = 2 / (n + 1); return [a, emaS(zc, n)[zc.length - 1] * (1 - a)];
  };
  const [af, bf] = lin(fast, ft), [az, bz] = lin(slow, st);
  const spread = x => (af * x + bf) - (az * x + bz);
  const prevClose = zc[zc.length - 1], now = c[i].close;
  const s0 = Math.sign(spread(prevClose)), s1 = Math.sign(spread(now));
  if (!s1 || !s0 || s0 === s1) return { dir: 0, reason: 'нет нового пересечения в этой свече' };
  if ((s1 > 0 && p.m25_buy === false) || (s1 < 0 && p.m25_sell === false)) return { dir: 0, reason: 'направление выключено' };
  const vmin = Number(p.m25_vol ?? 1);
  if (vmin) {
    const zz = z.slice(-need), tr = zz.map((k, j) => j === 0 ? k.high - k.low : Math.max(k.high - k.low, Math.abs(k.high - zz[j - 1].close), Math.abs(k.low - zz[j - 1].close)));
    const t50 = tr.slice(-50), a50 = t50.reduce((s, v) => s + v, 0) / t50.length, vr = tr.slice(-5).reduce((s, v) => s + v, 0) / 5 / a50;
    if (!(vr >= vmin)) return { dir: 0, reason: 'мелкие свечи — пропуск' };
  }
  return { dir: s1, expiry: Number(p.m25_expiry || 120), entry: Math.floor(nowSec()), bar: c[i].time,
    reason: `⏰ вход сейчас — ${ft} ${fast} пересекла ${st} ${slow} внутри свечи` };
}

module.exports = { bigFade, sharpSeries, levelTouch, levelZones, ma25, m5Trend, isLive };
