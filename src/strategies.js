// Strategy re-implementations. Names and ids come from the original app; the original logic lives in a
// closed native library, so each strategy is rebuilt from its name, description and settings keys.
// A strategy gets closed candles (oldest first) and returns null or { dir: 1|-1, strength, reason, expiry? }.
const I = require('./indicators');
const { roomAhead } = require('./levels'); // room to the nearest level ahead (filter for trend strategies)
const { five5 } = require('./five_bot');    // "5 on 5" exactly as in the Telegram bot (five_bot: true)
const BP = require('./bot_ports');           // big candle, series, level touch, MA 2/5 as in the Telegram bot

// Text in three languages; the UI picks one.
const L = (ru, de, en) => ({ ru, de, en: en ?? de });

// id -> [display name, type]. type 'rev' = reversal (allowed against the trend), 'trend' = with the trend.
// Russian names are the original app's names.
const META = {
  n_sharp: [L('Глубокое падение/рост → отскок', 'Starker Fall/Anstieg → Rücksprung', 'Deep drop/rise → rebound'), 'rev'],
  n_big: [L('Откат после большой свечи', 'Rücklauf nach großer Kerze', 'Pullback after big candle'), 'rev'],
  n_level: [L('Подход к уровню → отскок', 'Annäherung an ein Niveau → Rücksprung', 'Approach to a level → rebound'), 'rev'],
  n_ma25: [L('Пересечение MA 2 / 5', 'Kreuzung MA 2 / 5', 'MA 2 / 5 cross'), 'trend'],
  n_pulse: [L('Сильный импульс → возможный отскок', 'Starker Impuls → möglicher Rücksprung', 'Strong impulse → possible rebound'), 'rev'],
  n_vdrop: [L('Импульсное падение → отскок', 'Impulsfall → Rücksprung', 'Impulse drop → rebound'), 'rev'],
  n_cgdrop: [L('Истощение падения (ранний разворот)', 'Erschöpfung des Falls (frühe Umkehr)', 'Drop exhaustion (early reversal)'), 'rev'],
  early: [L('Ранний разворот', 'Frühe Umkehr', 'Early reversal'), 'rev'],
  n_tri: [L('Три EMA + RSI', 'Drei EMA + RSI', 'Three EMA + RSI'), 'trend'],
  n_mafr: [L('MA 2/5 + RSI 13 + фракталы', 'MA 2/5 + RSI 13 + Fraktale', 'MA 2/5 + RSI 13 + fractals'), 'trend'],
  n_rsi8020: [L('RSI 14 · возврат из крайних зон', 'RSI 14 · Rückkehr aus Extremzonen', 'RSI 14 · return from extreme zones'), 'rev'],
  n_rsi13: [L('RSI 13 · крайние зоны', 'RSI 13 · Extremzonen', 'RSI 13 · extreme zones'), 'rev'],
  n_rsi2: [L('RSI 2 · перегрев', 'RSI 2 · Überhitzung', 'RSI 2 · overheated'), 'rev'],
  zzsar: [L('ZigZag + PSAR + Stochastic', 'ZigZag + PSAR + Stochastic'), 'rev'],
  n_stoch: [L('Just Stoch', 'Just Stoch'), 'rev'],
  n_macross: [L('EMA Cross', 'EMA Cross'), 'trend'],
  n_rsibreak: [L('RSI-Trend · пробой', 'RSI-Trend · Ausbruch', 'RSI trend · breakout'), 'trend'],
  n_rsitrend: [L('Отскок от тренда (EMA 20 + RSI)', 'Rücksprung am Trend (EMA 20 + RSI)', 'Trend bounce (EMA 20 + RSI)'), 'trend'],
  n_bbosc: [L('BBands + Oscillator', 'BBands + Oszillator', 'BBands + Oscillator'), 'rev'],
  n_fractal: [L('Fractal Reverse', 'Fraktal-Umkehr', 'Fractal Reverse'), 'rev'],
  n_sbs: [L('SBS', 'SBS'), 'trend'],
  n_5x5: [L('«5 на 5»', '„5 auf 5“', '"5 on 5"'), 'trend'],
  n_stochenv: [L('Stoch + Envelopes', 'Stoch + Envelopes'), 'rev'],
  n_vortex: [L('Vortex + MACD', 'Vortex + MACD'), 'trend'],
  n_mamacd: [L('MA + MACD', 'MA + MACD'), 'trend'],
  n_wave: [L('Импульс из флэта', 'Impuls aus Seitwärtsphase', 'Breakout from flat'), 'trend'],
  n_psar: [L('Supertrend + PSAR', 'Supertrend + PSAR'), 'trend'],
  n_bb2: [L('BB (два)', 'BB (doppelt)', 'BB (double)'), 'rev'],
  n_atrst: [L('ATR: тренд + откат', 'ATR: Trend + Rücklauf', 'ATR: trend + pullback'), 'trend'],
  n_m5pb: [L('Откат внутри M5 (строгий)', 'Rücklauf innerhalb M5 (streng)', 'Pullback inside M5 (strict)'), 'trend'],
  n_structure: [L('Структура рынка', 'Marktstruktur', 'Market structure'), 'trend'],
  n_impulse: [L('Импульсный возврат', 'Impuls-Rückkehr', 'Impulse return'), 'trend'],
  n_pa: [L('Price Action', 'Price Action'), 'rev'],
  n_smasar: [L('SMA Cross + SAR', 'SMA Cross + SAR'), 'trend'],
  n_ema5: [L('EMA 5 · серия и пересечение', 'EMA 5 · Serie und Kreuzung', 'EMA 5 · run and cross'), 'trend'],
  ma4813: [L('MA 4/8/13', 'MA 4/8/13'), 'trend'],
};
const NAMES = Object.fromEntries(Object.entries(META).map(([k, v]) => [k, v[0]]));

// Parameters per strategy: exactly the values the strategy (and the shared filters) really use – these are
// what the app shows. User values for other keys (the original app stored one long generic list for every
// strategy) are ignored. Reversal strategies get follow_move: true = trade with the move instead of against it;
// trend strategies get no_countertrend. Strategies with their own expiry key (sharp_expiry …) have no "expiry".
const FILTERS = { min_adx: 0, max_adx: 0, flat_pips: 0 };
const REV = { expiry: 60, ...FILTERS, follow_move: false };
// Trend strategies also get the level filter (no entry straight into a level, room in average candles).
const TREND = { expiry: 60, ...FILTERS, no_countertrend: false, room_check: true, room_min: 1 };
// Telegram-bot variants (bot: true / five_bot: true) – their own settings, shown next to the classic ones.
const BIG_BOT = { bot: false, preclose_sec: 8, big_m5: true, big_quiet: false, big_hours: false, big_away: false, big_rsiedge: false };
const SHARP_BOT = { bot: false, preclose_sec: 8, sharp_series: true, sharp_move: false, sharp_imp: 2, sharp_drop: 4, sharp_fresh: 5,
  sharp_m5: true, sharp_hours: false, sharp_adx: 0, sharp_day_only: false, sharp_buy: true, sharp_sell: true };
const FIVE_BOT = { five_bot: false, candle_ma: 5, five_er_min: 0.3, five_trend: true, five_adx_min: 20, five_sar: 4, five_confirm: true, five_room: 0.7 };
const DEFAULTS = {
  n_sharp: { sharp_expiry: 180, ...FILTERS, follow_move: false, sharp_min: 4, sharp_rsi: false, sharp_mirror: true, ...SHARP_BOT },
  n_big: { ...REV, big_body: 2.5, big_period: 20, ...BIG_BOT },
  n_level: { ...FILTERS, follow_move: false, lvl_first: true, lvl_len: 5, lvl_width: 3, lvl_er: 0.5 },
  n_ma25: { m25_expiry: 120, ...FILTERS, no_countertrend: false, room_check: false, room_min: 1, m25_fast: 2, m25_slow: 5, m25_fast_type: 'SMA', m25_slow_type: 'SMA', m25_buy: true, m25_sell: true, m25_vol: 1 },
  n_pulse: { ...REV, pulse_min: 3, pulse_early_max: 4, pulse_range: 1.5, pulse_fraction: 0.6, pulse_rise: true, pulse_fall: true, pulse_late: true },
  n_vdrop: { ...REV, min_impulse_candles: 4, max_impulse_candles: 10, minimum_total_drop_atr: 2.0, min_speed_atr: 1.0, max_reversal_wait_bars: 2, impulse_rsi_filter: true, send_mirror: true },
  n_cgdrop: { ...REV, minimum_total_drop_atr: 1.0, min_lower_wick_to_body: 1.5, min_reversal_body_atr: 0.25, send_mirror: true },
  early: { ...REV, early_min: 3, early_drop_atr: 1.5 },
  n_tri: { ...TREND, tri_fast: 9, tri_mid: 13, tri_slow: 21, tri_rsi_period: 5, tri_smooth_period: 3, tri_lower: 35, tri_upper: 65, min_adx: 15, max_adx: 45 },
  n_mafr: { ...TREND, mf_fast: 2, mf_slow: 5, mf_rsi: 13, mf_frac_on: true, mf_rsi_on: true, mf_frac_bars: 8 },
  n_rsi8020: { ...REV, rsi_period: 14, rsi_levels: '70/30' },
  n_rsi13: { rsi13_expiry: 180, ...FILTERS, follow_move: false, rsi13_period: 13, rsi13_low: 20, rsi13_buy: true, rsi13_sell: true },
  n_rsi2: { ...REV, rsi2_threshold: 5, rsi2_buy: true, rsi2_sell: true },
  zzsar: { ...REV, zz_bars: 6, stoch_zone: 20, sar_step: 0.02, sar_max: 0.2 },
  n_stoch: { ...REV, stoch_k: 14, stoch_d: 3, stoch_slow: 3, stoch_zone: 20 },
  n_macross: { ...TREND, ma_fast: 2, ma_slow: 9, ma_fast_type: 'EMA', ma_slow_type: 'EMA' },
  n_rsibreak: { ...TREND, rsi_period: 14, ema_trend: 20 },
  n_rsitrend: { ...TREND, ema_fast: 20, ema_slow: 50, rsi_period: 14 },
  n_bbosc: { ...REV, bb_period: 20, bb_mult: 2, rsi_period: 7, rsi_extreme: 25 },
  n_fractal: { ...REV, frac_lookback: 20 },
  n_sbs: { ...TREND, ma_fast: 5, ma_slow: 10, stoch_k: 14 },
  n_5x5: { ...TREND, ema_fast: 5, ema_slow: 13, ...FIVE_BOT },
  n_stochenv: { ...REV, env_period: 20, env_pct: 0.1, stoch_k: 5, stoch_zone: 20 },
  n_vortex: { ...TREND, vortex_period: 14, macd_fast: 12, macd_slow: 26, macd_signal: 9 },
  n_mamacd: { ...TREND, ema_period: 20, macd_fast: 6, macd_slow: 19, macd_signal: 6 },
  n_wave: { ...TREND, bb_period: 20, squeeze_pct: 0.25, squeeze_bars: 10 },
  n_psar: { ...TREND, st_period: 10, st_mult: 1.5, sar_step: 0.02, sar_max: 0.2, sar_window: 2 },
  n_bb2: { ...REV, bb_period: 20, bb_inner: 2, bb_outer: 3 },
  n_atrst: { ...TREND, ema_fast: 20, ema_slow: 50, atr_min: 0.6, atr_max: 2.0, min_adx: 20 },
  n_m5pb: { ...TREND, m5_ema: 20, pullback_min: 3, min_adx: 20 },
  n_structure: { ...TREND },
  n_impulse: { ...TREND, impulse_body: 1.5, pullback_max: 2 },
  n_pa: { ...REV, level_bars: 20, wick_ratio: 2.0 },
  n_smasar: { ...TREND, ma_fast: 6, ma_slow: 14, sar_step: 0.02, sar_max: 0.3, min_adx: 25 },
  n_ema5: { ema5_expiry: 120, ...FILTERS, no_countertrend: false, room_check: true, room_min: 1, ema5_ma: 'SMA6', ema5_run: 5, ema5_buy: true, ema5_sell: true },
  ma4813: { ...TREND, min_adx: 15 },
};

const clamp = v => Math.max(1, Math.min(99, Math.round(v)));
const avgBody = (c, n, end) => { let s = 0; for (let i = end - n + 1; i <= end; i++) s += I.body(c[i]); return s / n; };
const cross = (a, b, i) => {
  if ([a[i], b[i], a[i - 1], b[i - 1]].some(v => v === null || v === undefined)) return 0;
  return a[i - 1] <= b[i - 1] && a[i] > b[i] ? 1 : a[i - 1] >= b[i - 1] && a[i] < b[i] ? -1 : 0;
};
const arr = (n, v) => Array(n).fill(v);
function runLength(c, end) {
  const d = I.dirOf(c[end]); if (!d) return { d: 0, n: 0 };
  let n = 0; while (end - n >= 0 && I.dirOf(c[end - n]) === d) n++;
  return { d, n };
}
const sig = (dir, strength, reason, expiry) => ({ dir, strength, reason, expiry });
// Result of a Telegram-bot strategy → signal (entry/bar: entry "now" inside the candle, one signal per candle).
const botSig = r => {
  if (!r || !r.dir) return null;
  const out = sig(r.dir, 75, L(r.reason, r.reason, r.reason), r.expiry);
  if (r.entry) out.entry = r.entry;
  if (r.bar !== undefined) out.bar = r.bar;
  return out;
};
// Which candles a strategy gets: 'legacy' as before; 'closed' only closed candles (once per candle);
// 'live' only with the forming candle; 'both' before the close (live) plus a fallback right after it.
function liveMode(name, settings) {
  const p = paramsFor(name, settings);
  if (name === 'n_level' || name === 'n_ma25') return 'live';
  if ((name === 'n_big' || name === 'n_sharp') && p.bot) return 'both';
  if (name === 'n_5x5' && p.five_bot) return 'closed';
  return 'legacy';
}

function ctx(c) {
  const close = c.map(k => k.close), memo = {};
  const m = (key, f) => (memo[key] ??= f());
  return {
    c, close, last: c.length - 1,
    atr: m('atr', () => I.atr(c, 14)), adx: m('adx', () => I.adx(c, 14)),
    rsi: n => m('rsi' + n, () => I.rsi(close, n)),
    ema: n => m('ema' + n, () => I.ema(close, n)),
    sma: n => m('sma' + n, () => I.sma(close, n)),
    stoch: (k, d, s) => m(`st${k}-${d}-${s}`, () => I.stoch(c, k, s, d)),
    psar: (s, x) => m(`ps${s}-${x}`, () => I.psar(c, s, x)),
  };
}

const S = {
  n_sharp(x, p) {
    if (p.bot) return botSig(BP.sharpSeries(x.c, x.last, p)); // Telegram-bot logic
    const { d, n } = runLength(x.c, x.last), min = p.sharp_min || 4;
    if (n < min || (!p.sharp_mirror && d > 0)) return null;
    if (p.sharp_rsi) { const r = x.rsi(14)[x.last]; if (d < 0 ? r > 35 : r < 65) return null; }
    return sig(-d, 70 + (n - min) * 8, d < 0
      ? L(`${n} красных свечей подряд`, `${n} rote Kerzen in Folge`, `${n} red candles in a row`)
      : L(`${n} зелёных свечей подряд`, `${n} grüne Kerzen in Folge`, `${n} green candles in a row`), p.sharp_expiry);
  },
  n_level(x, p) { return botSig(BP.levelTouch(x.c, x.last, p)); },        // as in the Telegram bot
  n_ma25(x, p) { return botSig(BP.ma25(x.c, x.last, p, x.tfMin || 1)); }, // as in the Telegram bot
  n_big(x, p) {
    if (p.bot) return botSig(BP.bigFade(x.c, x.last, p)); // Telegram-bot logic
    const k = x.c[x.last], ab = avgBody(x.c, p.big_period || 20, x.last - 1), mult = p.big_body || 2.5;
    if (!ab || I.body(k) < mult * ab) return null;
    const r = I.body(k) / ab;
    return sig(-I.dirOf(k), 70 + (r - mult) * 10, L(`крупная свеча ${r.toFixed(1)}× от средней`, `große Kerze ${r.toFixed(1)}× Durchschnitt`, `big candle ${r.toFixed(1)}× average`));
  },
  n_pulse(x, p) {
    const { d, n } = runLength(x.c, x.last), min = p.pulse_min || 3;
    if (n < min || (!p.pulse_late && n > (p.pulse_early_max || 4))) return null;
    if ((d > 0 && !p.pulse_rise) || (d < 0 && !p.pulse_fall)) return null;
    const a = x.atr[x.last - n]; if (!a) return null;
    const move = Math.abs(x.c[x.last].close - x.c[x.last - n + 1].open);
    const strong = x.c.slice(x.last - n + 1).every(k => I.body(k) >= (p.pulse_fraction || 0.6) * (k.high - k.low || 1e-9));
    if (!strong || move < (p.pulse_range || 1.5) * a) return null;
    return sig(-d, 70 + (move / a - p.pulse_range) * 10, L(`импульс ${n} свечей = ${(move / a).toFixed(1)} ATR`, `Impuls ${n} Kerzen = ${(move / a).toFixed(1)} ATR`, `impulse ${n} candles = ${(move / a).toFixed(1)} ATR`));
  },
  // Impulse of N candles >= X ATR, then the first candle against it -> rebound.
  n_vdrop(x, p) {
    const a = x.atr[x.last - 1]; if (!a) return null;
    const rev = x.c[x.last], rd = I.dirOf(rev); if (!rd) return null;
    for (let wait = 1; wait <= (p.max_reversal_wait_bars || 2); wait++) {
      const end = x.last - wait;
      const { d, n } = runLength(x.c, end);
      if (d !== -rd || n < (p.min_impulse_candles || 4) || n > (p.max_impulse_candles || 10)) continue;
      if (d > 0 && !p.send_mirror) return null;
      const move = Math.abs(x.c[end].close - x.c[end - n + 1].open);
      if (move < (p.minimum_total_drop_atr || 2) * a || move / n < (p.min_speed_atr || 1) * a / 3) continue;
      if (p.impulse_rsi_filter) { const r = x.rsi(14)[end]; if (d < 0 ? r > 40 : r < 60) return null; }
      return sig(rd, 70 + (move / a - 2) * 8, L(`импульс ${(move / a).toFixed(1)} ATR за ${n} свечей, первая встречная свеча`,
        `Impuls ${(move / a).toFixed(1)} ATR in ${n} Kerzen, erste Gegenkerze`, `impulse ${(move / a).toFixed(1)} ATR in ${n} candles, first opposite candle`));
    }
    return null;
  },
  // Exhaustion: strong drop, then a candle with long lower wick closing up.
  n_cgdrop(x, p) {
    const a = x.atr[x.last - 1]; if (!a) return null;
    const k = x.c[x.last], b = I.body(k) || 1e-9;
    for (const d of [-1, 1]) { // d = direction of the preceding move
      if (d > 0 && !p.send_mirror) continue;
      const move = (x.c[x.last - 1].close - x.c[x.last - 5].open) * d;
      if (move < (p.minimum_total_drop_atr || 1) * a) continue;
      const wick = d < 0 ? Math.min(k.open, k.close) - k.low : k.high - Math.max(k.open, k.close);
      if (wick / b >= (p.min_lower_wick_to_body || 1.5) && I.dirOf(k) === -d && b >= (p.min_reversal_body_atr || 0.25) * a)
        return sig(-d, 72, d < 0
          ? L('истощение падения: длинная нижняя тень', 'Fall erschöpft: langer unterer Docht', 'drop exhausted: long lower wick')
          : L('истощение роста: длинная верхняя тень', 'Anstieg erschöpft: langer oberer Docht', 'rise exhausted: long upper wick'));
    }
    return null;
  },
  // Candle closes beyond the previous candle's extreme after a 3+ run.
  early(x, p) {
    const { d, n } = runLength(x.c, x.last - 1), k = x.c[x.last], prev = x.c[x.last - 1], a = x.atr[x.last - 1];
    if (n < (p.early_min || 3) || !a) return null;
    const move = Math.abs(prev.close - x.c[x.last - n].open);
    if (move < (p.early_drop_atr || 1.5) * a) return null;
    if (d < 0 && k.close > prev.high) return sig(1, 74, L('закрытие выше максимума свечи истощения', 'Schluss über dem Hoch der Erschöpfungskerze', 'close above the exhaustion candle high'));
    if (d > 0 && k.close < prev.low) return sig(-1, 74, L('закрытие ниже минимума свечи истощения', 'Schluss unter dem Tief der Erschöpfungskerze', 'close below the exhaustion candle low'));
    return null;
  },
  n_tri(x, p) {
    const i = x.last, f = x.ema(p.tri_fast)[i], m = x.ema(p.tri_mid)[i], s = x.ema(p.tri_slow)[i];
    const r = I.sma(x.rsi(p.tri_rsi_period).map(v => v ?? 50), p.tri_smooth_period || 3);
    if (f > m && m > s && r[i - 1] < p.tri_lower && r[i] >= p.tri_lower) return sig(1, 76, L('три EMA вверх, RSI выходит из перепроданности', 'drei EMA aufwärts, RSI verlässt überverkauft', 'three EMAs up, RSI leaves oversold'));
    if (f < m && m < s && r[i - 1] > p.tri_upper && r[i] <= p.tri_upper) return sig(-1, 76, L('три EMA вниз, RSI выходит из перекупленности', 'drei EMA abwärts, RSI verlässt überkauft', 'three EMAs down, RSI leaves overbought'));
    return null;
  },
  n_mafr(x, p) {
    const i = x.last, d = cross(x.ema(p.mf_fast || 2), x.ema(p.mf_slow || 5), i); if (!d) return null;
    if (p.mf_rsi_on !== false) { const r = x.rsi(p.mf_rsi || 13)[i]; if (d > 0 ? r < 50 : r > 50) return null; }
    if (p.mf_frac_on !== false) {
      const fr = I.fractals(x.c).filter(f => f.i >= i - (p.mf_frac_bars || 8) && f.type === (d > 0 ? 'low' : 'high'));
      if (!fr.length) return null;
    }
    return sig(d, 75, L(`EMA ${p.mf_fast}/${p.mf_slow} пересеклись, RSI ${p.mf_rsi} и фрактал подтверждают`,
      `EMA ${p.mf_fast}/${p.mf_slow} gekreuzt, RSI ${p.mf_rsi} und Fraktal bestätigen`, `EMA ${p.mf_fast}/${p.mf_slow} crossed, RSI ${p.mf_rsi} and fractal confirm`));
  },
  n_rsi8020(x, p) {
    const [hi, lo] = String(p.rsi_levels || '70/30').split('/').map(Number), r = x.rsi(p.rsi_period || 14), i = x.last;
    if (r[i - 1] < lo && r[i] >= lo) return sig(1, 72, L(`RSI вернулся выше ${lo}`, `RSI zurück über ${lo}`, `RSI back above ${lo}`));
    if (r[i - 1] > hi && r[i] <= hi) return sig(-1, 72, L(`RSI вернулся ниже ${hi}`, `RSI zurück unter ${hi}`, `RSI back below ${hi}`));
    return null;
  },
  n_rsi13(x, p) {
    const r = x.rsi(p.rsi13_period || 13)[x.last], low = p.rsi13_low || 20;
    if (r <= low && p.rsi13_buy !== false) return sig(1, 70 + (low - r), L(`RSI ${r.toFixed(0)} — перепроданность`, `RSI ${r.toFixed(0)} – überverkauft`, `RSI ${r.toFixed(0)} – oversold`), p.rsi13_expiry);
    if (r >= 100 - low && p.rsi13_sell !== false) return sig(-1, 70 + (r - 100 + low), L(`RSI ${r.toFixed(0)} — перекупленность`, `RSI ${r.toFixed(0)} – überkauft`, `RSI ${r.toFixed(0)} – overbought`), p.rsi13_expiry);
    return null;
  },
  n_rsi2(x, p) {
    const r = x.rsi(2)[x.last], t = p.rsi2_threshold || 5;
    if (r <= t && p.rsi2_buy !== false) return sig(1, 72, `RSI(2) = ${r.toFixed(1)}`);
    if (r >= 100 - t && p.rsi2_sell !== false) return sig(-1, 72, `RSI(2) = ${r.toFixed(1)}`);
    return null;
  },
  zzsar(x, p) {
    const i = x.last, ps = x.psar(p.sar_step || 0.02, p.sar_max || 0.2);
    if (!ps[i] || !ps[i - 1] || ps[i].up === ps[i - 1].up) return null;
    const d = ps[i].up ? 1 : -1, n = p.zz_bars || 6, st = x.stoch(14, 3, 3).k, z = p.stoch_zone || 20;
    const seg = x.c.slice(i - n, i + 1), ext = d > 0 ? Math.min(...seg.map(k => k.low)) : Math.max(...seg.map(k => k.high));
    if (!seg.some(k => (d > 0 ? k.low : k.high) === ext)) return null;
    const wasZone = st.slice(i - n, i).some(v => v !== null && (d > 0 ? v < z : v > 100 - z));
    if (!wasZone || (d > 0 ? st[i] <= st[i - 1] : st[i] >= st[i - 1])) return null;
    return sig(d, 76, L('разворот PSAR от экстремума ZigZag, Stochastic разворачивается', 'PSAR dreht am ZigZag-Extrem, Stochastic dreht', 'PSAR flips at ZigZag extreme, Stochastic turns'));
  },
  n_stoch(x, p) {
    const { k, d } = x.stoch(p.stoch_k || 14, p.stoch_d || 3, p.stoch_slow || 3), i = x.last, z = p.stoch_zone || 20, c = cross(k, d, i);
    if (c > 0 && k[i - 1] < z) return sig(1, 72, L(`Stochastic %K пересёк %D вверх из зоны ${z}`, `Stochastic %K kreuzt %D aufwärts aus Zone ${z}`, `Stochastic %K crossed %D up from zone ${z}`));
    if (c < 0 && k[i - 1] > 100 - z) return sig(-1, 72, L(`Stochastic %K пересёк %D вниз из зоны ${100 - z}`, `Stochastic %K kreuzt %D abwärts aus Zone ${100 - z}`, `Stochastic %K crossed %D down from zone ${100 - z}`));
    return null;
  },
  n_macross(x, p) {
    const d = cross(I.ma(x.close, p.ma_fast, p.ma_fast_type), I.ma(x.close, p.ma_slow, p.ma_slow_type), x.last);
    const a = `${p.ma_fast_type || 'EMA'} ${p.ma_fast}`, b = `${p.ma_slow_type || 'EMA'} ${p.ma_slow}`;
    return d ? sig(d, 72, L(`${a} пересекла ${b}`, `${a} kreuzt ${b}`, `${a} crossed ${b}`)) : null;
  },
  n_rsibreak(x, p) {
    const i = x.last, r = x.rsi(p.rsi_period || 14), e = x.ema(p.ema_trend || 20), d = cross(r, arr(r.length, 50), i);
    if (!d || (d > 0 ? x.close[i] < e[i] : x.close[i] > e[i])) return null;
    return sig(d, 72, d > 0
      ? L(`RSI пересёк 50 вверх по тренду EMA ${p.ema_trend}`, `RSI kreuzt 50 aufwärts im Trend EMA ${p.ema_trend}`, `RSI crossed 50 up with EMA ${p.ema_trend} trend`)
      : L(`RSI пересёк 50 вниз по тренду EMA ${p.ema_trend}`, `RSI kreuzt 50 abwärts im Trend EMA ${p.ema_trend}`, `RSI crossed 50 down with EMA ${p.ema_trend} trend`));
  },
  n_rsitrend(x, p) {
    const i = x.last, f = x.ema(p.ema_fast || 20), s = x.ema(p.ema_slow || 50), r = x.rsi(p.rsi_period || 14), k = x.c[i];
    const trend = f[i] > s[i] ? 1 : -1;
    const touched = trend > 0 ? k.low <= f[i] : k.high >= f[i];
    const turn = trend > 0 ? r[i - 1] < 50 && r[i] > r[i - 1] : r[i - 1] > 50 && r[i] < r[i - 1];
    if (!touched || !turn || I.dirOf(k) !== trend) return null;
    return sig(trend, 74, L(`касание EMA ${p.ema_fast}, RSI разворачивается по тренду`, `Berührung EMA ${p.ema_fast}, RSI dreht mit dem Trend`, `touch of EMA ${p.ema_fast}, RSI turns with the trend`));
  },
  n_bbosc(x, p) {
    const i = x.last, bb = I.bollinger(x.close, p.bb_period || 20, p.bb_mult || 2), r = x.rsi(p.rsi_period || 7), e = p.rsi_extreme || 25;
    if (!bb[i - 1]) return null;
    if (x.close[i - 1] < bb[i - 1].lo && x.close[i] > bb[i].lo && r[i - 1] < e) return sig(1, 75, L('выход под нижнюю Bollinger при крайнем RSI и возврат в канал', 'unter das untere Bollinger-Band bei extremem RSI und zurück', 'below lower Bollinger band at extreme RSI and back inside'));
    if (x.close[i - 1] > bb[i - 1].up && x.close[i] < bb[i].up && r[i - 1] > 100 - e) return sig(-1, 75, L('выход над верхней Bollinger при крайнем RSI и возврат в канал', 'über das obere Bollinger-Band bei extremem RSI und zurück', 'above upper Bollinger band at extreme RSI and back inside'));
    return null;
  },
  n_fractal(x, p) {
    const i = x.last, k = x.c[i], fr = I.fractals(x.c).filter(f => f.i >= i - (p.frac_lookback || 20) && f.i <= i - 3);
    const lo = fr.filter(f => f.type === 'low').pop(), hi = fr.filter(f => f.type === 'high').pop();
    if (lo && k.low < lo.price && k.close > lo.price) return sig(1, 74, L('ложный пробой фрактала вниз и возврат', 'Fehlausbruch unter Fraktal und zurück', 'false break below fractal and back'));
    if (hi && k.high > hi.price && k.close < hi.price) return sig(-1, 74, L('ложный пробой фрактала вверх и возврат', 'Fehlausbruch über Fraktal und zurück', 'false break above fractal and back'));
    return null;
  },
  n_sbs(x, p) {
    const i = x.last, d = cross(x.sma(p.ma_fast || 5), x.sma(p.ma_slow || 10), i); if (!d) return null;
    const { k, d: dd } = x.stoch(p.stoch_k || 14, 3, 3);
    if (d > 0 ? k[i] < dd[i] : k[i] > dd[i]) return null;
    if (I.dirOf(x.c[i]) !== d) return null;
    return sig(d, 74, L(`MA ${p.ma_fast} пересекла MA ${p.ma_slow}, Stochastic согласен`, `MA ${p.ma_fast} kreuzt MA ${p.ma_slow}, Stochastic stimmt zu`, `MA ${p.ma_fast} crossed MA ${p.ma_slow}, Stochastic agrees`));
  },
  n_5x5(x, p) {
    if (p.five_bot) { // logic and filters of the Telegram bot
      const r = five5(x.c, x.last, p); if (!r.dir) return null;
      return sig(r.dir, 75, L(`«5 на 5» как в боте: ${r.reason}`, `„5 auf 5“ wie im Bot: ${r.reason}`, `"5 on 5" as in the bot: ${r.reason}`));
    }
    const i = x.last, d = cross(x.ema(p.ema_fast || 5), x.ema(p.ema_slow || 13), i);
    if (!d || I.dirOf(x.c[i]) !== d) return null;
    return sig(d, 72, L(`EMA ${p.ema_fast} пересекла EMA ${p.ema_slow}`, `EMA ${p.ema_fast} kreuzt EMA ${p.ema_slow}`, `EMA ${p.ema_fast} crossed EMA ${p.ema_slow}`));
  },
  n_stochenv(x, p) {
    const i = x.last, m = x.sma(p.env_period || 20), pct = (p.env_pct || 0.1) / 100, z = p.stoch_zone || 20;
    const { k } = x.stoch(p.stoch_k || 5, 3, 3); if (m[i - 1] === null) return null;
    const touchedLo = x.c.slice(i - 3, i + 1).some((c, j) => c.low < m[i - 3 + j] * (1 - pct));
    const touchedHi = x.c.slice(i - 3, i + 1).some((c, j) => c.high > m[i - 3 + j] * (1 + pct));
    if (touchedLo && k[i - 1] < z && k[i] >= z) return sig(1, 74, L('касание нижней Envelopes, Stochastic вышел из зоны 20', 'unteres Envelope berührt, Stochastic verlässt Zone 20', 'lower envelope touched, Stochastic leaves zone 20'));
    if (touchedHi && k[i - 1] > 100 - z && k[i] <= 100 - z) return sig(-1, 74, L('касание верхней Envelopes, Stochastic вышел из зоны 80', 'oberes Envelope berührt, Stochastic verlässt Zone 80', 'upper envelope touched, Stochastic leaves zone 80'));
    return null;
  },
  n_vortex(x, p) {
    const i = x.last, v = I.vortex(x.c, p.vortex_period || 14), mc = I.macd(x.close, p.macd_fast, p.macd_slow, p.macd_signal);
    const d = cross(v.map(q => q && q.plus), v.map(q => q && q.minus), i); if (!d) return null;
    if (d > 0 ? mc.line[i] < mc.signal[i] : mc.line[i] > mc.signal[i]) return null;
    return sig(d, 74, d > 0
      ? L('Vortex: VI+ пересёк VI- вверх, MACD подтверждает', 'Vortex: VI+ kreuzt VI- aufwärts, MACD bestätigt', 'Vortex: VI+ crossed VI- up, MACD confirms')
      : L('Vortex: VI+ пересёк VI- вниз, MACD подтверждает', 'Vortex: VI+ kreuzt VI- abwärts, MACD bestätigt', 'Vortex: VI+ crossed VI- down, MACD confirms'));
  },
  n_mamacd(x, p) {
    const i = x.last, e = x.ema(p.ema_period || 20), mc = I.macd(x.close, p.macd_fast || 6, p.macd_slow || 19, p.macd_signal || 6);
    const d = cross(x.close, e, i); if (!d) return null;
    if (d > 0 ? mc.line[i] < mc.signal[i] : mc.line[i] > mc.signal[i]) return null;
    return sig(d, 73, L(`цена пересекла EMA ${p.ema_period}, MACD по направлению`, `Kurs kreuzt EMA ${p.ema_period}, MACD in Richtung`, `price crossed EMA ${p.ema_period}, MACD agrees`));
  },
  n_wave(x, p) {
    const i = x.last, bb = I.bollinger(x.close, p.bb_period || 20, 2); if (!bb[i - 1]) return null;
    const widths = bb.slice(i - 60, i).filter(Boolean).map(b => b.width).sort((a, b) => a - b);
    const q = widths[Math.floor(widths.length * (p.squeeze_pct || 0.25))];
    const squeezed = bb.slice(i - (p.squeeze_bars || 10), i).every(b => b && b.width <= q);
    if (!squeezed) return null;
    if (x.close[i] > bb[i].up) return sig(1, 75, L('выход из сжатия Bollinger, пробой вверх', 'Ausbruch aus Bollinger-Enge nach oben', 'Bollinger squeeze breakout up'));
    if (x.close[i] < bb[i].lo) return sig(-1, 75, L('выход из сжатия Bollinger, пробой вниз', 'Ausbruch aus Bollinger-Enge nach unten', 'Bollinger squeeze breakout down'));
    return null;
  },
  n_psar(x, p) {
    const i = x.last, st = I.supertrend(x.c, p.st_period || 10, p.st_mult || 1.5), ps = x.psar(p.sar_step || 0.02, p.sar_max || 0.2);
    if (!st[i] || !st[i - 1] || st[i].up === st[i - 1].up) return null;
    const d = st[i].up ? 1 : -1;
    if (!ps[i] || ps[i].up !== (d > 0)) return null;
    const recent = ps.slice(i - (p.sar_window || 2), i + 1).some((q, j, a) => j > 0 && q && a[j - 1] && q.up !== a[j - 1].up);
    if (!recent) return null;
    return sig(d, 77, L('разворот Supertrend и PSAR', 'Supertrend und PSAR drehen', 'Supertrend and PSAR flip'));
  },
  n_bb2(x, p) {
    const i = x.last, inner = I.bollinger(x.close, p.bb_period || 20, p.bb_inner || 2), outer = I.bollinger(x.close, p.bb_period || 20, p.bb_outer || 3);
    if (!outer[i - 1]) return null;
    const k = x.c[i], prev = x.c[i - 1];
    if (prev.low <= outer[i - 1].lo && k.close > inner[i].lo) return sig(1, 76, L('касание внешней нижней BB и возврат за внутреннюю', 'äußeres unteres BB berührt, zurück über inneres', 'outer lower BB touched, back above inner'));
    if (prev.high >= outer[i - 1].up && k.close < inner[i].up) return sig(-1, 76, L('касание внешней верхней BB и возврат за внутреннюю', 'äußeres oberes BB berührt, zurück unter inneres', 'outer upper BB touched, back below inner'));
    return null;
  },
  n_atrst(x, p) {
    const i = x.last, f = x.ema(p.ema_fast || 20), s = x.ema(p.ema_slow || 50), a = x.atr;
    const avgA = a.slice(i - 30, i).reduce((t, v) => t + (v || 0), 0) / 30, rel = a[i] / avgA;
    if (rel < (p.atr_min || 0.6) || rel > (p.atr_max || 2)) return null;
    const trend = f[i] > s[i] && s[i] > s[i - 5] ? 1 : f[i] < s[i] && s[i] < s[i - 5] ? -1 : 0; if (!trend) return null;
    const pulled = x.c.slice(i - 3, i).some(k => (trend > 0 ? k.low <= f[i] : k.high >= f[i]));
    if (!pulled || I.dirOf(x.c[i]) !== trend || (trend > 0 ? x.close[i] < f[i] : x.close[i] > f[i])) return null;
    return sig(trend, 75, L(`откат к EMA ${p.ema_fast} и продолжение тренда, ATR ${rel.toFixed(1)}× от среднего`,
      `Rücklauf zur EMA ${p.ema_fast}, Trend geht weiter, ATR ${rel.toFixed(1)}× Durchschnitt`, `pullback to EMA ${p.ema_fast}, trend resumes, ATR ${rel.toFixed(1)}× average`));
  },
  n_m5pb(x, p) {
    const m5 = I.resample(x.c, 5); if (m5.length < 30) return null;
    const e = I.ema(m5.map(k => k.close), p.m5_ema || 20), j = m5.length - 1;
    const trend = m5[j].close > e[j] && e[j] > e[j - 2] ? 1 : m5[j].close < e[j] && e[j] < e[j - 2] ? -1 : 0; if (!trend) return null;
    const { d, n } = runLength(x.c, x.last - 1);
    if (d !== -trend || n < (p.pullback_min || 3) || I.dirOf(x.c[x.last]) !== trend) return null;
    return sig(trend, 76, L(`тренд M5, откат ${n} свечей M1 закончен`, `M5-Trend, Rücklauf ${n} M1-Kerzen beendet`, `M5 trend, ${n}-candle M1 pullback finished`));
  },
  n_structure(x, p) {
    const fr = I.fractals(x.c), lows = fr.filter(f => f.type === 'low').slice(-2), highs = fr.filter(f => f.type === 'high').slice(-2);
    if (lows.length < 2 || highs.length < 2) return null;
    const k = x.c[x.last];
    const up = lows[1].price > lows[0].price && highs[1].price > highs[0].price;
    const dn = lows[1].price < lows[0].price && highs[1].price < highs[0].price;
    if (up && I.dirOf(x.c[x.last - 1]) < 0 && I.dirOf(k) > 0 && k.low > lows[1].price) return sig(1, 74, L('структура HH/HL, откат закончен', 'Struktur HH/HL, Rücklauf beendet', 'HH/HL structure, pullback finished'));
    if (dn && I.dirOf(x.c[x.last - 1]) > 0 && I.dirOf(k) < 0 && k.high < highs[1].price) return sig(-1, 74, L('структура LH/LL, откат закончен', 'Struktur LH/LL, Rücklauf beendet', 'LH/LL structure, pullback finished'));
    return null;
  },
  n_impulse(x, p) {
    const i = x.last, a = x.atr[i - 1]; if (!a) return null;
    for (let back = 2; back <= (p.pullback_max || 2) + 1; back++) {
      const imp = x.c[i - back]; if (I.body(imp) < (p.impulse_body || 2) * a) continue;
      const d = I.dirOf(imp);
      const pull = x.c.slice(i - back + 1, i).every(k => I.dirOf(k) === -d && (d > 0 ? k.low > imp.open : k.high < imp.open));
      if (pull && I.dirOf(x.c[i]) === d) return sig(d, 75, L('импульсная свеча, короткий откат и возврат', 'Impulskerze, kurzer Rücklauf und Rückkehr', 'impulse candle, short pullback and return'));
    }
    return null;
  },
  n_pa(x, p) {
    const i = x.last, k = x.c[i], prev = x.c[i - 1], n = p.level_bars || 20, b = I.body(k) || 1e-9;
    const seg = x.c.slice(i - n, i), lo = Math.min(...seg.map(c => c.low)), hi = Math.max(...seg.map(c => c.high)), a = x.atr[i] || 0;
    const lowerW = Math.min(k.open, k.close) - k.low, upperW = k.high - Math.max(k.open, k.close);
    const nearLo = k.low <= lo + a * 0.3, nearHi = k.high >= hi - a * 0.3;
    const bullEng = I.dirOf(prev) < 0 && I.dirOf(k) > 0 && k.close > prev.open && k.open <= prev.close;
    const bearEng = I.dirOf(prev) > 0 && I.dirOf(k) < 0 && k.close < prev.open && k.open >= prev.close;
    if (nearLo && (lowerW / b >= (p.wick_ratio || 2) || bullEng)) return sig(1, 75, bullEng
      ? L('бычье поглощение у поддержки', 'bullisches Engulfing an Unterstützung', 'bullish engulfing at support')
      : L('пин-бар у поддержки', 'Pin-Bar an Unterstützung', 'pin bar at support'));
    if (nearHi && (upperW / b >= (p.wick_ratio || 2) || bearEng)) return sig(-1, 75, bearEng
      ? L('медвежье поглощение у сопротивления', 'bärisches Engulfing an Widerstand', 'bearish engulfing at resistance')
      : L('пин-бар у сопротивления', 'Pin-Bar an Widerstand', 'pin bar at resistance'));
    return null;
  },
  n_smasar(x, p) {
    const i = x.last, d = cross(x.sma(p.ma_fast || 6), x.sma(p.ma_slow || 14), i); if (!d) return null;
    const ps = x.psar(p.sar_step || 0.02, p.sar_max || 0.3);
    if (!ps[i] || ps[i].up !== (d > 0)) return null;
    return sig(d, 74, L(`SMA ${p.ma_fast}/${p.ma_slow} пересеклись, SAR подтверждает`, `SMA ${p.ma_fast}/${p.ma_slow} gekreuzt, SAR bestätigt`, `SMA ${p.ma_fast}/${p.ma_slow} crossed, SAR confirms`));
  },
  n_ema5(x, p) {
    const n = parseInt(String(p.ema5_ma || 'SMA6').replace(/\D/g, ''), 10) || 6;
    const m = String(p.ema5_ma || '').startsWith('E') ? x.ema(n) : x.sma(n), run = p.ema5_run || 5;
    const side = i => Math.sign(x.close[i] - m[i]), now = side(x.last); if (!now) return null;
    for (let i = 1; i <= run; i++) if (side(x.last - i) !== -now) return null;
    if ((now > 0 && p.ema5_buy === false) || (now < 0 && p.ema5_sell === false)) return null;
    return sig(now, 72, L(`пересечение MA ${n} после ${run} свечей`, `Kreuzung MA ${n} nach ${run} Kerzen`, `MA ${n} cross after ${run} candles`), p.ema5_expiry);
  },
  ma4813(x, p) {
    const i = x.last, d = cross(x.ema(4), x.ema(8), i); if (!d) return null;
    if (d > 0 ? x.ema(8)[i] < x.ema(13)[i] : x.ema(8)[i] > x.ema(13)[i]) return null;
    return sig(d, 72, L('EMA 4 пересекла EMA 8 по EMA 13', 'EMA 4 kreuzt EMA 8 im Sinne der EMA 13', 'EMA 4 crossed EMA 8 with EMA 13'));
  },
};

// Shared filters from the strategy settings.
function passesFilters(x, p, s, type) {
  const a = x.adx[x.last];
  if (p.min_adx && (!a || a.adx < p.min_adx)) return false;
  if (p.max_adx && a && a.adx > p.max_adx) return false;
  if (p.flat_pips) {
    const pip = x.close[x.last] > 20 ? 0.01 : 0.0001, seg = x.c.slice(-10);
    if ((Math.max(...seg.map(k => k.high)) - Math.min(...seg.map(k => k.low))) / pip < p.flat_pips) return false;
  }
  if (p.no_countertrend && type === 'trend' && a && a.adx >= 25 && s.dir !== (a.pdi > a.mdi ? 1 : -1)) return false;
  // Trend strategies: no CALL straight into resistance, no PUT straight into support (room in average candles).
  // Reversal strategies need no such filter – they trade against the move anyway.
  if (type === 'trend' && p.room_check) {
    const r = roomAhead(x.c, x.last, s.dir);
    if (r.dist < (Number(p.room_min) || 1)) return false;
  }
  return true;
}

// The strategy's own values: defaults overridden by the user's values – only for keys the strategy uses.
function paramsFor(name, settings) {
  const user = settings.strategy_settings?.[name] || {};
  const p = { ...DEFAULTS[name] };
  for (const k of Object.keys(p)) if (user[k] !== null && user[k] !== undefined) p[k] = user[k];
  return p;
}

// Appended to the reason so the card says what the signal expects.
const EXPECT = {
  reversal: L(' → ожидается разворот', ' → Rücksprung erwartet', ' → rebound expected'),
  follow: L(' → движение продолжится', ' → Bewegung geht weiter', ' → move continues'),
};
const addText = (reason, extra) => (reason && typeof reason === 'object'
  ? { ru: (reason.ru || '') + extra.ru, de: (reason.de || '') + extra.de, en: (reason.en || '') + extra.en }
  : String(reason || '') + extra.de);

// candlesByTf: { M1: [...], M2: [...] }; tfs: per-strategy timeframe lists.
function evaluate(candlesByTf, enabled, settings) {
  const out = [], ctxs = {};
  for (const name of enabled) {
    const fn = S[name]; if (!fn) continue;
    const p = paramsFor(name, settings);
    for (const tf of settings.strat_tfs?.[name] || ['M1']) {
      const c = candlesByTf[tf]; if (!c || c.length < 60) continue;
      const x = (ctxs[tf] ??= ctx(c)); x.tfMin = parseInt(tf.slice(1), 10) || 1;
      let s; try { s = fn(x, p); } catch { s = null; }
      if (!s || !s.dir || !passesFilters(x, p, s, META[name][1])) continue;
      // Reversal strategies bet against the last move; with follow_move they trade with it instead.
      let mode = 'trend';
      if (META[name][1] === 'rev') {
        mode = p.follow_move ? 'follow' : 'reversal';
        if (p.follow_move) s.dir = -s.dir;
        s.reason = addText(s.reason, EXPECT[mode]);
      }
      const n = parseInt(tf.slice(1), 10) || 1, tfSec = tf[0] === 'S' ? n : n * 60; // S10 = 10 s, M5 = 300 s
      let expiry = s.expiry || p.expiry; if (!expiry || expiry === 'auto') expiry = tfSec;
      out.push({ ...s, strategy: name, tf, mode, expiry: Number(expiry), strength: clamp(s.strength) });
    }
  }
  return out;
}

module.exports = { evaluate, NAMES, DEFAULTS, META, paramsFor, liveMode, list: Object.keys(META) };
