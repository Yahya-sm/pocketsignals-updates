'use strict';
// Strategy Lab, stage 1 (user prompt v7, 13.11.2026).
// - CATALOG: configs of all 27 strategies (19 logics; OTC/FOREX variants have their own id and statistics).
// - Five logics fully built in OTC + FOREX variants: Impulse, Range, Fractal, Trap, Overheat. Each runs three stages in
//   order and stops at the first failed one; every decision carries reason/reject codes, numbers and signal_score.
// - Statistics helpers: break-even 1/(1+p), EV, Wilson 95 % interval, verdict colour.
// - Risk checks for delivered signals (cooldown, daily signal limit, minimum payout, duplicate setup key) and the
//   manual-trading limits computed from "My trades" (daily loss, trades per day, loss streak) – a banner, never a block
//   at the broker.
// Only closed candles are used (x.c ends with the last closed candle) – no look-ahead (tools/test-lab.js checks it).
const I = require('./indicators');

const L = (ru, de, en) => ({ ru, de, en: en ?? de });
const VERSION = '1.0.0';

// ---------- statistics ----------
const breakEven = p => 1 / (1 + p);                       // p as a fraction (0.8)
const ev = (w, p) => w * p - (1 - w);
function wilson(wins, n, z = 1.96) {
  if (!n) return null;
  const w = wins / n, d = 1 + z * z / n;
  const c = (w + z * z / (2 * n)) / d, h = z * Math.sqrt(w * (1 - w) / n + z * z / (4 * n * n)) / d;
  return { rate: w, lo: Math.max(0, c - h), hi: Math.min(1, c + h), n };
}
// grey: n < 100 · red: upper bound below break-even · yellow: crosses it · green: lower bound above it.
function verdict(wins, n, payout) {
  const be = breakEven(payout), ci = wilson(wins, n);
  if (!ci || n < 100) return { v: 'few', ci, be };
  if (ci.hi < be) return { v: 'below', ci, be };
  if (ci.lo > be) return { v: 'above', ci, be };
  return { v: 'unproven', ci, be };
}

// ---------- catalog (27 strategies) ----------
// impl: built in stage 1. Other entries are configs only (status DRAFT) until stage 2.
const C = (id, name, cat, type, expiry, target, risk, stages, extra = {}) => ({ id, name, category: cat, asset_type: type, expiry, target_win_rate: target, risk_level: risk, stages, version: VERSION, status: 'DRAFT', mode: 'SIGNAL_ONLY', allow_live_execution: false, ...extra });
const ST = (a, b, c) => [a, b, c];
const CATALOG = [
  C('mini_vip_otc', 'Mini VIP', 'complex', 'OTC', ['1M', '2M', '3M'], { min: 42, max: 60 }, 'MEDIUM', ST(L('Индикаторы: EMA 9/21, RSI 14, ATR-перцентиль, уровень', 'Indikatoren: EMA 9/21, RSI 14, ATR-Perzentil, Level', 'Indicators: EMA 9/21, RSI 14, ATR percentile, level'), L('Свеча: паттерн, тело ≥ 50 %', 'Kerze: Muster, Körper ≥ 50 %', 'Candle: pattern, body ≥ 50 %'), L('Согласование: 4 из 5, score ≥ 70', 'Abgleich: 4 von 5, Score ≥ 70', 'Agreement: 4 of 5, score ≥ 70'))),
  C('mini_vip_forex', 'Mini VIP Forex', 'complex', 'FOREX', ['1M', '2M', '3M'], { min: 42, max: 60 }, 'MEDIUM', ST(L('Индикаторы: EMA 9/21, RSI 14, ATR-перцентиль, уровень', 'Indikatoren: EMA 9/21, RSI 14, ATR-Perzentil, Level', 'Indicators: EMA 9/21, RSI 14, ATR percentile, level'), L('Свеча: паттерн, тело ≥ 50 %', 'Kerze: Muster, Körper ≥ 50 %', 'Candle: pattern, body ≥ 50 %'), L('Согласование: 4 из 5, score ≥ 70', 'Abgleich: 4 von 5, Score ≥ 70', 'Agreement: 4 of 5, score ≥ 70'))),
  C('pro_bot_otc', 'Pro Bot', 'multifactor', 'OTC', ['1M', '3M', '5M'], { min: 55, max: 60 }, 'MEDIUM', ST(L('Контекст: EMA 50 на 5M, ADX', 'Kontext: EMA 50 auf 5M, ADX', 'Context: EMA 50 on 5M, ADX'), L('Сила движения', 'Bewegungsstärke', 'Move strength'), L('Качество входа: откат к EMA 20 или пробой', 'Einstiegsqualität: Rücksetzer zur EMA 20 oder Ausbruch', 'Entry quality: pullback to EMA 20 or breakout'))),
  C('impulse_bot_otc', 'Impulse Bot', 'momentum', 'OTC', ['1M'], { min: 55, max: 70 }, 'HIGH', ST(L('Поиск ускорения цены', 'Beschleunigung suchen', 'Find price acceleration'), L('Фильтр слабых движений и истощения', 'Filter: schwache Bewegung, Erschöpfung', 'Filter weak moves and exhaustion'), L('Вход по направлению импульса', 'Einstieg in Impulsrichtung', 'Entry in impulse direction')), { impl: 'impulse' }),
  C('impulse_bot_forex', 'Impulse Bot Forex', 'momentum', 'FOREX', ['1M'], { min: 55, max: 70 }, 'HIGH', ST(L('Поиск ускорения цены', 'Beschleunigung suchen', 'Find price acceleration'), L('Фильтр + закрытие в крайних 25 %', 'Filter + Schluss in äußeren 25 %', 'Filter + close in the outer 25 %'), L('Вход по направлению импульса', 'Einstieg in Impulsrichtung', 'Entry in impulse direction')), { impl: 'impulse' }),
  C('range_bot_otc', 'Range Bot', 'range', 'OTC', ['1M'], { min: 45, max: 60 }, 'MEDIUM', ST(L('Границы диапазона (30 свечей)', 'Range-Grenzen (30 Kerzen)', 'Range bounds (30 candles)'), L('Касание границы без пробоя', 'Berührung der Grenze ohne Ausbruch', 'Touch of a bound, no breakout'), L('Свеча отказа, вход к центру', 'Ablehnungskerze, Einstieg zur Mitte', 'Rejection candle, entry to the centre')), { impl: 'range' }),
  C('range_bot_forex', 'Range Bot Forex', 'range', 'FOREX', ['1M'], { min: 45, max: 60 }, 'MEDIUM', ST(L('Границы диапазона (30 свечей)', 'Range-Grenzen (30 Kerzen)', 'Range bounds (30 candles)'), L('Касание границы без пробоя', 'Berührung der Grenze ohne Ausbruch', 'Touch of a bound, no breakout'), L('Свеча отказа, вход к центру', 'Ablehnungskerze, Einstieg zur Mitte', 'Rejection candle, entry to the centre')), { impl: 'range' }),
  C('fractal_bot_otc', 'Fractal Bot', 'structure', 'OTC', ['2M'], { min: 60, max: 70 }, 'MEDIUM', ST(L('Структура фракталов 2+2', 'Fraktalstruktur 2+2', 'Fractal structure 2+2'), L('Уровень с ≥ 2 реакциями', 'Level mit ≥ 2 Reaktionen', 'Level with ≥ 2 reactions'), L('Пробой с закреплением', 'Ausbruch mit Bestätigung', 'Breakout that holds')), { impl: 'fractal' }),
  C('fractal_bot_forex', 'Fractal Bot Forex', 'structure', 'FOREX', ['2M'], { min: 60, max: 70 }, 'MEDIUM', ST(L('Структура фракталов 2+2', 'Fraktalstruktur 2+2', 'Fractal structure 2+2'), L('Уровень с ≥ 2 реакциями', 'Level mit ≥ 2 Reaktionen', 'Level with ≥ 2 reactions'), L('Пробой с закреплением', 'Ausbruch mit Bestätigung', 'Breakout that holds')), { impl: 'fractal' }),
  C('candle_bot_otc', 'Candle Bot', 'price_action', 'OTC', ['1M'], { min: 55, max: 70 }, 'HIGH', ST(L('Последние 3–5 свечей', 'Letzte 3–5 Kerzen', 'Last 3–5 candles'), L('Давление: 3 из 4 закрытий', 'Druck: 3 von 4 Schlüssen', 'Pressure: 3 of 4 closes'), L('Сигнал за 10–15 с до закрытия минуты', 'Signal 10–15 s vor Minutenschluss', 'Signal 10–15 s before the minute closes')), { manual_hard: true }),
  C('candle_bot_forex', 'Candle Bot Forex', 'price_action', 'FOREX', ['1M'], { min: 55, max: 70 }, 'HIGH', ST(L('Последние 3–5 свечей', 'Letzte 3–5 Kerzen', 'Last 3–5 candles'), L('Давление: 3 из 4 закрытий', 'Druck: 3 von 4 Schlüssen', 'Pressure: 3 of 4 closes'), L('Сигнал за 10–15 с до закрытия минуты', 'Signal 10–15 s vor Minutenschluss', 'Signal 10–15 s before the minute closes')), { manual_hard: true }),
  C('meanrev_bot_forex', 'MeanRev Bot Forex', 'mean_reversion', 'FOREX', ['2M'], { min: 55, max: 65 }, 'MEDIUM', ST(L('Среднее SMA 20, ADX < 20', 'Mittel SMA 20, ADX < 20', 'Mean SMA 20, ADX < 20'), L('Цена за полосой Боллинджера', 'Preis jenseits des Bollinger-Bands', 'Price beyond the Bollinger band'), L('Свеча ослабления, вход к SMA', 'Schwächekerze, Einstieg zur SMA', 'Weakening candle, entry to the SMA'))),
  C('ludo_bot_otc', 'Ludo Bot', 'ultra_short', 'OTC', ['15s'], null, 'VERY_HIGH', ST(L('Микродвижения 20 тиков', 'Mikrobewegungen 20 Ticks', 'Micro moves, 20 ticks'), L('Серия ≥ 4 движений', 'Serie ≥ 4 Bewegungen', 'Series ≥ 4 moves'), L('Вход при сохранении направления', 'Einstieg, wenn Richtung hält', 'Entry while direction holds')), { mode: 'PAPER', manual_hard: true }),
  C('scanner_bot_otc', 'Scanner Bot', 'scanner', 'OTC', ['1M'], { min: 50, max: 70 }, 'MEDIUM', ST(L('Пул активов', 'Asset-Pool', 'Asset pool'), L('Выбор лучшего кандидата', 'Bester Kandidat', 'Best candidate'), L('Подтверждение перед свечой', 'Bestätigung vor der Kerze', 'Confirmation before the candle'))),
  C('volatility_bot_otc', 'Volatility Bot', 'volatility', 'OTC', ['25s'], { min: 50, max: 75 }, 'HIGH', ST(L('Сжатие ATR 5/50 < 0,7', 'Kompression ATR 5/50 < 0,7', 'Squeeze ATR 5/50 < 0.7'), L('Расширение ≥ 2×ATR 50', 'Ausdehnung ≥ 2×ATR 50', 'Expansion ≥ 2×ATR 50'), L('Вход по направлению', 'Einstieg in Richtung', 'Entry in direction')), { mode: 'PAPER', manual_hard: true }),
  C('overheat_bot_otc', 'Overheat Bot', 'counter_trend', 'OTC', ['1M', '10M', '15M'], { min: 45, max: 70 }, 'MEDIUM', ST(L('Z-score(20) ≥ 2,5 у экстремума', 'Z-Score(20) ≥ 2,5 am Extrem', 'Z-score(20) ≥ 2.5 at an extreme'), L('Свеча отказа', 'Ablehnungskerze', 'Rejection candle'), L('ATR-фильтр 20–80 перцентиль', 'ATR-Filter 20.–80. Perzentil', 'ATR filter 20–80 percentile')), { impl: 'overheat' }),
  C('overheat_bot_forex', 'Overheat Forex Bot', 'counter_trend', 'FOREX', ['1M', '10M', '15M'], { min: 45, max: 70 }, 'MEDIUM', ST(L('Z-score(20) ≥ 2,5 у экстремума', 'Z-Score(20) ≥ 2,5 am Extrem', 'Z-score(20) ≥ 2.5 at an extreme'), L('Свеча отказа', 'Ablehnungskerze', 'Rejection candle'), L('ATR-фильтр + не против тренда при ADX > 30', 'ATR-Filter + nicht gegen Trend bei ADX > 30', 'ATR filter + not against the trend at ADX > 30')), { impl: 'overheat' }),
  C('smart_money_otc', 'Smart Money Bot', 'smc', 'OTC', ['1M', '5M'], { min: 45, max: 70 }, 'MEDIUM', ST(L('Ликвидность и структура', 'Liquidität und Struktur', 'Liquidity and structure'), L('Зона FVG / Order Block', 'Zone FVG / Order Block', 'FVG / order block zone'), L('BOS и реакция в зоне', 'BOS und Reaktion in der Zone', 'BOS and reaction in the zone'))),
  C('smart_money_5m_otc', 'Smart Money 5M Bot', 'smc', 'OTC', ['5M'], { min: 45, max: 70 }, 'MEDIUM', ST(L('Свинги 5M/15M', 'Swings 5M/15M', 'Swings 5M/15M'), L('Зона FVG / Order Block', 'Zone FVG / Order Block', 'FVG / order block zone'), L('BOS и реакция в зоне', 'BOS und Reaktion in der Zone', 'BOS and reaction in the zone'))),
  C('smart_money_forex', 'Smart Money Forex Bot', 'smc', 'FOREX', ['1M', '5M'], { min: 45, max: 70 }, 'MEDIUM', ST(L('Ликвидность и структура', 'Liquidität und Struktur', 'Liquidity and structure'), L('Зона FVG / Order Block', 'Zone FVG / Order Block', 'FVG / order block zone'), L('BOS и реакция в зоне', 'BOS und Reaktion in der Zone', 'BOS and reaction in the zone'))),
  C('neuro_bot_otc', 'Neuro Bot', 'ml', 'OTC', ['1M', '3M', '5M'], { min: 60, max: 75 }, 'HIGH', ST(L('Признаки и качество данных', 'Merkmale und Datenqualität', 'Features and data quality'), L('Модель (логистическая регрессия / бустинг)', 'Modell (logistische Regression / Boosting)', 'Model (logistic regression / boosting)'), L('Порог и неопределённость', 'Schwelle und Unsicherheit', 'Threshold and uncertainty'))),
  C('trap_bot_otc', 'Trap Bot', 'false_breakout', 'OTC', ['1M'], { min: 45, max: 65 }, 'MEDIUM', ST(L('Выход за экстремум на 0,1–0,6×ATR', 'Ausbruch über Extrem um 0,1–0,6×ATR', 'Poke beyond the extreme by 0.1–0.6×ATR'), L('Возврат в диапазон за 1–2 свечи', 'Rückkehr in die Range in 1–2 Kerzen', 'Back inside within 1–2 candles'), L('Свеча против пробоя', 'Kerze gegen den Ausbruch', 'Candle against the breakout')), { impl: 'trap' }),
  C('spring_bot_otc', 'Spring Bot', 'squeeze', 'OTC', ['1M'], { min: 45, max: 65 }, 'MEDIUM', ST(L('Сжатие ≥ 5 свечей', 'Kompression ≥ 5 Kerzen', 'Squeeze ≥ 5 candles'), L('Выход из зоны', 'Ausbruch aus der Zone', 'Exit from the zone'), L('Подтверждение', 'Bestätigung', 'Confirmation'))),
  C('candle_pressure_otc', 'Candle Pressure Bot', 'pressure', 'OTC', ['1M'], { min: 45, max: 65 }, 'MEDIUM', ST(L('Закрытия в крайней трети', 'Schlüsse im äußeren Drittel', 'Closes in the outer third'), L('HH/HL, короткие тени', 'HH/HL, kurze Dochte', 'HH/HL, short wicks'), L('Доминирование ≥ 65/35', 'Dominanz ≥ 65/35', 'Dominance ≥ 65/35'))),
  C('correction_bot_otc', 'Correction Bot', 'correction', 'OTC', ['1M'], null, 'MEDIUM', ST(L('Импульс ≥ 3×ATR', 'Impuls ≥ 3×ATR', 'Impulse ≥ 3×ATR'), L('Уровень с реакциями', 'Level mit Reaktionen', 'Level with reactions'), L('Откат 38–62 %, продолжение', 'Rücksetzer 38–62 %, Fortsetzung', 'Pullback 38–62 %, continuation'))),
  C('double_strike_otc', 'Double Strike Bot', 'double_impulse', 'OTC', ['1M'], { min: 45, max: 65 }, 'MEDIUM', ST(L('Первый импульс ≥ 2×ATR', 'Erster Impuls ≥ 2×ATR', 'First impulse ≥ 2×ATR'), L('Пауза 1–4 свечи', 'Pause 1–4 Kerzen', 'Pause 1–4 candles'), L('Второй импульс', 'Zweiter Impuls', 'Second impulse'))),
  C('fun_bot_5s_otc', 'Fun Bot 5S', 'ultra_short', 'OTC', ['5s'], null, 'CRITICAL', ST(L('Микротренд 10–20 тиков', 'Mikrotrend 10–20 Ticks', 'Micro trend 10–20 ticks'), L('Скорость, шум, задержка ≤ 150 мс', 'Tempo, Rauschen, Latenz ≤ 150 ms', 'Speed, noise, latency ≤ 150 ms'), L('Вход при сохранении микронаправления', 'Einstieg, wenn Mikrorichtung hält', 'Entry while the micro direction holds')), { mode: 'PAPER', manual_hard: true }),
];
const BY_ID = Object.fromEntries(CATALOG.map(s => [s.id, s]));
for (const s of CATALOG) if (s.impl) s.status = 'BACKTEST';
// Last backtest (13.11.2026): 12 regular forex pairs, last 20 000 M1 candles each (~14 days), entry at the next open,
// payout 80 %, in-sample = first 70 %, out-of-sample = last 30 %. OTC variants ran on the same forex data (no OTC history).
const BACKTEST = {
  impulse_bot_forex: [777, 397, 295, 136], range_bot_forex: [36, 17, 19, 11], fractal_bot_forex: [320, 145, 154, 73], overheat_bot_forex: [161, 76, 81, 42],
  impulse_bot_otc: [844, 430, 316, 144], range_bot_otc: [36, 17, 19, 11], fractal_bot_otc: [320, 145, 154, 73], trap_bot_otc: [5443, 2689, 2321, 1170],
  mini_vip_otc: [18125, 8972, 7709, 3793], mini_vip_forex: [18125, 8972, 7709, 3793], pro_bot_otc: [1783, 911, 798, 412], candle_bot_otc: [3881, 1921, 1718, 857], candle_bot_forex: [3881, 1921, 1718, 857], meanrev_bot_forex: [1016, 528, 430, 214],
  scanner_bot_otc: [6394, 3165, 2700, 1334], smart_money_otc: [4749, 2384, 2253, 1095], smart_money_forex: [4749, 2384, 2253, 1095], smart_money_5m_otc: [2177, 1041, 932, 439], spring_bot_otc: [63, 37, 22, 7],
  candle_pressure_otc: [871, 432, 390, 193], correction_bot_otc: [1661, 817, 712, 353], double_strike_otc: [6153, 3101, 2664, 1300], neuro_bot_otc: [31789, 15767, 13822, 6745], overheat_bot_otc: [204, 96, 102, 51],
};
for (const [id, [isN, isW, oosN, oosW]] of Object.entries(BACKTEST)) BY_ID_TMP(id).backtest = { date: '2026-11-13', data: '12 forex pairs × 20 000 M1', is: { n: isN, w: isW }, oos: { n: oosN, w: oosW } };
function BY_ID_TMP(id) { return CATALOG.find(c => c.id === id); }

// Default parameters (all "strong/narrow" words are numbers here; user changes go through the parameter journal).
const PARAMS = {
  impulse: { accel_range_atr: 1.5, min_directional_closes: 2, prev_range_atr: 1.0, prev_same_dir: true, max_opposite_wick_pct: 30, min_level_distance_atr: 0.5, exhaustion_streak: 5, rsi_hi: 85, rsi_lo: 15, forex_close_extreme_pct: 25 },
  // 13.11.2026 user: stricter flat check (a PUT came at the top of a rising market: EMA slope 0.049 passed 0.05, 2 touches).
  range: { window: 30, touch_tol_atr: 0.15, min_touches: 3, width_min_atr: 2, width_max_atr: 6, max_slope_atr: 0.03, zone_pct: 15, break_body_atr: 0.8, rejection_wick_pct: 50 },
  fractal: { min_amp_atr: 0.3, level_tol_atr: 0.15, min_reactions: 2, room_atr: 1.0, break_atr: 0.2, lookback: 60 },
  trap: { lookback: 20, poke_min_atr: 0.1, poke_max_atr: 0.6, body_pct: 40 },
  overheat: { z_period: 20, z_level: 2.5, extreme_window: 20, wick_pct: 50, atr_pct_lo: 20, atr_pct_hi: 80, forex_adx: 30 },
};
Object.assign(PARAMS, {
  mini_vip: { rsi_call: 55, rsi_put: 45, atr_pct_lo: 20, atr_pct_hi: 80, min_level_distance_atr: 0.5, body_pct: 50, max_opposite_wick_pct: 30, min_factors: 4, min_score: 70 },
  pro_bot: { adx_min: 20, min_body_atr: 0.6, min_closes: 3, pullback_atr: 0.3, break_atr: 0.2 },
  candle_bot: { sec_from: 45, sec_to: 50, min_closes: 3, max_opposite_wick_pct: 50, min_level_distance_atr: 0.5 },
  meanrev: { adx_max: 20, atr_pct_lo: 20, atr_pct_hi: 80, bb_mult: 2, max_body_atr: 1, wick_pct: 50 },
  ludo: { window: 20, max_chaos: 0.6, min_series: 4, min_candles: 30 },
  fun5s: { window: 15, max_chaos: 0.6, min_series: 3, min_candles: 30 },
  volatility: { squeeze: 0.7, min_squeeze: 5, expansion_atr: 2, max_expansion: 3 },
  scanner: {},
  smart_money: { fvg_atr: 0.3, ob_atr: 1.5, m5: false },
  smart_money_5m: { fvg_atr: 0.3, ob_atr: 1.5, m5: true },
  spring: { zone_atr: 1.2, spike_atr: 0.8, min_candles_zone: 5, break_body_atr: 1.2, max_opposite_wick_pct: 25 },
  pressure: { window: 10, third_share: 0.7, min_sequence: 3, max_opposite_wick_pct: 30, dominance: 0.65 },
  correction: { imp_atr: 3, min_reactions: 2, depth_min: 0.38, depth_max: 0.62 },
  double_strike: { imp_atr: 2, max_retrace: 0.38 },
  neuro: { threshold: 0.56 },
});
// EMA 20/50 confirmation on by default for the logics that follow the move; off for reversal / structure / micro ones.
const MA_ON = ['impulse', 'fractal', 'pro_bot', 'candle_bot', 'spring', 'pressure', 'correction', 'double_strike'];
const PERIODS = { impulse: { rsi_period: 7 }, range: { range_ema: 20 }, overheat: { adx_period: 14, atr_pct_window: 200 }, mini_vip: { vip_ema_fast: 9, vip_ema_slow: 21, rsi_period: 14 },
  pro_bot: { trend_ema: 50, entry_ema: 20, adx_period: 14 }, meanrev: { bb_period: 20, adx_period: 14 }, volatility: { atr_fast: 5, atr_slow: 50 }, spring: { atr_slow: 50 }, smart_money: {}, smart_money_5m: {} };
for (const [k, p] of Object.entries(PARAMS)) Object.assign(p, PERIODS[k] || {}, k === 'neuro' ? {} : { atr_period: 14 }, { ma_filter: MA_ON.includes(k), ma_fast: 20, ma_slow: 50 });
const EXPIRY_SEC = { impulse: 60, range: 60, fractal: 120, trap: 60, overheat: 60 };
Object.assign(EXPIRY_SEC, { mini_vip: 60, pro_bot: 60, candle_bot: 60, meanrev: 120, ludo: 15, fun5s: 5, volatility: 25, scanner: 60, smart_money: 60, smart_money_5m: 300, spring: 60, pressure: 60, correction: 60, double_strike: 60, neuro: 60 });
// Catalog id → parameter set (impl) and run logic (when they differ).
const IMPL = { mini_vip_otc: 'mini_vip', mini_vip_forex: 'mini_vip', pro_bot_otc: 'pro_bot', candle_bot_otc: 'candle_bot', candle_bot_forex: 'candle_bot', meanrev_bot_forex: 'meanrev',
  ludo_bot_otc: ['ludo', 'micro'], fun_bot_5s_otc: ['fun5s', 'micro'], volatility_bot_otc: 'volatility', scanner_bot_otc: 'scanner', smart_money_otc: 'smart_money', smart_money_forex: 'smart_money',
  smart_money_5m_otc: ['smart_money_5m', 'smart_money'], spring_bot_otc: 'spring', candle_pressure_otc: 'pressure', correction_bot_otc: 'correction', double_strike_otc: 'double_strike', neuro_bot_otc: 'neuro' };
for (const [id, v] of Object.entries(IMPL)) { const s = CATALOG.find(c => c.id === id); if (!s) continue; s.impl = Array.isArray(v) ? v[0] : v; if (Array.isArray(v)) s.logic = v[1]; s.status = 'BACKTEST'; }
// Second-candle strategies run on S5 candles; the candle bot on the forming M1 candle.
const SECOND_TF = { ludo: 'S5', fun5s: 'S5', volatility: 'S5' };
// Readable parameter names for the settings (3 languages).
const PARAM_LABELS = {
  expiry: L('Экспирация, с', 'Ablauf, s', 'Expiry, s'),
  accel_range_atr: L('Мин. диапазон свечи, ×ATR', 'Min. Kerzenspanne, ×ATR', 'Min candle range, ×ATR'),
  min_directional_closes: L('Мин. закрытий по направлению (из 3)', 'Min. Schlüsse in Richtung (von 3)', 'Min closes in direction (of 3)'),
  rsi_call: L('RSI 14 для CALL выше', 'RSI 14 für CALL über', 'RSI 14 for CALL above'), rsi_put: L('RSI 14 для PUT ниже', 'RSI 14 für PUT unter', 'RSI 14 for PUT below'),
  body_pct: L('Тело свечи от, %', 'Kerzenkörper ab, %', 'Candle body from, %'), min_factors: L('Мин. факторов «за» (из 5)', 'Min. Faktoren dafür (von 5)', 'Min factors for (of 5)'), min_score: L('Мин. score', 'Min. Score', 'Min score'),
  adx_min: L('ADX тренда от', 'Trend-ADX ab', 'Trend ADX from'), min_body_atr: L('Среднее тело 5 свечей от, ×ATR', 'Mittl. Körper 5 Kerzen ab, ×ATR', 'Avg body of 5 candles from, ×ATR'),
  min_closes: L('Мин. закрытий по направлению', 'Min. Schlüsse in Richtung', 'Min closes in direction'), pullback_atr: L('Откат к EMA 20 в пределах, ×ATR', 'Rücksetzer zur EMA 20 innerhalb, ×ATR', 'Pullback to EMA 20 within, ×ATR'),
  sec_from: L('Сигнал с секунды минуты', 'Signal ab Sekunde', 'Signal from second'), sec_to: L('Сигнал до секунды минуты', 'Signal bis Sekunde', 'Signal up to second'),
  adx_max: L('ADX флэта ниже', 'Seitwärts-ADX unter', 'Flat ADX below'), bb_mult: L('Боллинджер: ширина (σ)', 'Bollinger: Breite (σ)', 'Bollinger width (σ)'), max_body_atr: L('Тело последней свечи меньше, ×ATR', 'Körper letzte Kerze unter, ×ATR', 'Last body below, ×ATR'),
  max_chaos: L('Макс. доля разворотов (хаос)', 'Max. Anteil Wechsel (Chaos)', 'Max share of reversals (chaos)'), min_series: L('Мин. серия в одну сторону', 'Min. Serie in eine Richtung', 'Min series one way'), min_candles: L('Мин. свечей истории', 'Min. Kerzen Historie', 'Min candles of history'),
  squeeze: L('Сжатие: ATR 5 / ATR 50 ниже', 'Kompression: ATR 5 / ATR 50 unter', 'Squeeze: ATR 5 / ATR 50 below'), min_squeeze: L('Сжатие не меньше, свечей', 'Kompression mindestens, Kerzen', 'Squeeze at least, candles'),
  expansion_atr: L('Расширение от, ×ATR 50', 'Ausdehnung ab, ×ATR 50', 'Expansion from, ×ATR 50'), max_expansion: L('Истощение после, свечей', 'Erschöpfung nach, Kerzen', 'Exhaustion after, candles'),
  fvg_atr: L('FVG от, ×ATR', 'FVG ab, ×ATR', 'FVG from, ×ATR'), ob_atr: L('Импульс после Order Block от, ×ATR', 'Impuls nach Order Block ab, ×ATR', 'Impulse after order block from, ×ATR'), m5: L('Анализ на 5M', 'Analyse auf 5M', 'Analysis on 5M'),
  zone_atr: L('Зона сжатия не шире, ×ATR 50', 'Kompressionszone höchstens, ×ATR 50', 'Squeeze zone at most, ×ATR 50'), spike_atr: L('Без выбросов больше, ×ATR 50', 'Ohne Ausreißer über, ×ATR 50', 'No spikes above, ×ATR 50'),
  min_candles_zone: L('Мин. свечей в зоне', 'Min. Kerzen in der Zone', 'Min candles in the zone'), third_share: L('Доля закрытий в крайней трети', 'Anteil Schlüsse im äußeren Drittel', 'Share of closes in the outer third'),
  min_sequence: L('Мин. HH/HL подряд', 'Min. HH/HL in Folge', 'Min HH/HL in a row'), dominance: L('Перевес свечей от', 'Kerzen-Übergewicht ab', 'Candle dominance from'),
  imp_atr: L('Импульс от, ×ATR', 'Impuls ab, ×ATR', 'Impulse from, ×ATR'), depth_min: L('Откат от (доля импульса)', 'Rücksetzer ab (Anteil)', 'Pullback from (share)'), depth_max: L('Откат до (доля импульса)', 'Rücksetzer bis (Anteil)', 'Pullback up to (share)'),
  max_retrace: L('Пауза: откат не больше (доля)', 'Pause: Rücksetzer höchstens (Anteil)', 'Pause: pullback at most (share)'), threshold: L('Порог уверенности модели', 'Modell-Schwelle', 'Model threshold'),
  atr_period: L('ATR: период', 'ATR: Periode', 'ATR period'), rsi_period: L('RSI: период', 'RSI: Periode', 'RSI period'), adx_period: L('ADX: период', 'ADX: Periode', 'ADX period'),
  range_ema: L('EMA наклона диапазона: период', 'EMA für Range-Neigung: Periode', 'Range slope EMA period'), atr_pct_window: L('ATR-перцентиль: окно, свечей', 'ATR-Perzentil: Fenster, Kerzen', 'ATR percentile window, candles'),
  vip_ema_fast: L('Быстрая EMA направления: период', 'Schnelle Richtungs-EMA: Periode', 'Fast direction EMA period'), vip_ema_slow: L('Медленная EMA направления: период', 'Langsame Richtungs-EMA: Periode', 'Slow direction EMA period'),
  trend_ema: L('EMA тренда на 5M: период', 'Trend-EMA auf 5M: Periode', 'Trend EMA on 5M period'), entry_ema: L('EMA отката: период', 'Rücksetzer-EMA: Periode', 'Pullback EMA period'),
  bb_period: L('Боллинджер: период', 'Bollinger: Periode', 'Bollinger period'), atr_fast: L('Короткий ATR: период', 'Kurzer ATR: Periode', 'Short ATR period'), atr_slow: L('Длинный ATR: период', 'Langer ATR: Periode', 'Long ATR period'),
  ma_filter: L('Подтверждение скользящими EMA 20/50', 'Bestätigung durch EMA 20/50', 'Confirmation by EMA 20/50'),
  ma_fast: L('Быстрая EMA, период', 'Schnelle EMA, Periode', 'Fast EMA period'), ma_slow: L('Медленная EMA, период', 'Langsame EMA, Periode', 'Slow EMA period'),
  prev_same_dir: L('Прошлая свеча того же цвета', 'Vorkerze gleiche Farbe', 'Previous candle same colour'),
  prev_range_atr: L('Прошлая свеча не меньше, ×ATR', 'Vorkerze mindestens, ×ATR', 'Previous candle at least, ×ATR'),
  max_opposite_wick_pct: L('Макс. противоположная тень, %', 'Max. Gegendocht, %', 'Max opposite wick, %'),
  min_level_distance_atr: L('Мин. расстояние до уровня, ×ATR', 'Min. Abstand zum Level, ×ATR', 'Min distance to level, ×ATR'),
  exhaustion_streak: L('Истощение: свечей подряд', 'Erschöpfung: Kerzen in Folge', 'Exhaustion: candles in a row'),
  rsi_hi: L('Истощение: RSI 7 выше', 'Erschöpfung: RSI 7 über', 'Exhaustion: RSI 7 above'), rsi_lo: L('Истощение: RSI 7 ниже', 'Erschöpfung: RSI 7 unter', 'Exhaustion: RSI 7 below'),
  forex_close_extreme_pct: L('FOREX: закрытие в крайних, %', 'FOREX: Schluss in äußeren, %', 'FOREX: close in the outer, %'),
  window: L('Окно диапазона, свечей', 'Range-Fenster, Kerzen', 'Range window, candles'),
  touch_tol_atr: L('Допуск касания, ×ATR', 'Toleranz Berührung, ×ATR', 'Touch tolerance, ×ATR'),
  min_touches: L('Мин. касаний каждой границы', 'Min. Berührungen je Grenze', 'Min touches of each bound'),
  width_min_atr: L('Ширина диапазона от, ×ATR', 'Range-Breite ab, ×ATR', 'Range width from, ×ATR'), width_max_atr: L('Ширина диапазона до, ×ATR', 'Range-Breite bis, ×ATR', 'Range width up to, ×ATR'),
  max_slope_atr: L('Макс. наклон EMA 20, ×ATR за свечу (меньше = строже боковик)', 'Max. Neigung EMA 20, ×ATR je Kerze (kleiner = strenger)', 'Max EMA 20 slope, ×ATR per candle (lower = stricter flat)'),
  zone_pct: L('Зона у границы, % ширины', 'Zone an der Grenze, % der Breite', 'Zone at the bound, % of width'),
  break_body_atr: L('Пробойная свеча: тело больше, ×ATR', 'Ausbruchskerze: Körper über, ×ATR', 'Breakout candle: body above, ×ATR'),
  rejection_wick_pct: L('Свеча отказа: тень от, %', 'Ablehnungskerze: Docht ab, %', 'Rejection candle: wick from, %'),
  min_amp_atr: L('Мин. амплитуда фрактала, ×ATR', 'Min. Fraktal-Amplitude, ×ATR', 'Min fractal amplitude, ×ATR'),
  level_tol_atr: L('Допуск уровня, ×ATR', 'Level-Toleranz, ×ATR', 'Level tolerance, ×ATR'), min_reactions: L('Мин. реакций уровня', 'Min. Reaktionen am Level', 'Min level reactions'),
  room_atr: L('Мин. место до следующего уровня, ×ATR', 'Min. Platz zum nächsten Level, ×ATR', 'Min room to next level, ×ATR'), break_atr: L('Пробой не меньше, ×ATR', 'Ausbruch mindestens, ×ATR', 'Breakout at least, ×ATR'),
  lookback: L('История, свечей', 'Rückblick, Kerzen', 'Lookback, candles'), poke_min_atr: L('Выход за экстремум от, ×ATR', 'Stich über Extrem ab, ×ATR', 'Poke from, ×ATR'), poke_max_atr: L('Выход за экстремум до, ×ATR', 'Stich über Extrem bis, ×ATR', 'Poke up to, ×ATR'),
  body_pct: L('Тело свечи против пробоя от, %', 'Körper gegen Ausbruch ab, %', 'Counter body from, %'),
  z_period: L('Z-score: период', 'Z-Score: Periode', 'Z-score period'), z_level: L('Z-score: уровень', 'Z-Score: Schwelle', 'Z-score level'), extreme_window: L('Окно экстремума, свечей', 'Extrem-Fenster, Kerzen', 'Extreme window, candles'),
  wick_pct: L('Свеча отказа: тень от, %', 'Ablehnungskerze: Docht ab, %', 'Rejection wick from, %'), atr_pct_lo: L('ATR-перцентиль от', 'ATR-Perzentil ab', 'ATR percentile from'), atr_pct_hi: L('ATR-перцентиль до', 'ATR-Perzentil bis', 'ATR percentile up to'),
  forex_adx: L('FOREX: не против тренда при ADX выше', 'FOREX: nicht gegen Trend bei ADX über', 'FOREX: not against trend at ADX above'),
};
const COMMON = { cooldown_candles: 2, daily_signal_limit: 20 };

// ---------- reason / reject texts (3 languages, numbers filled in) ----------
const T = {
  wrong_asset_type: v => L(`актив ${v.t}, стратегия только для ${v.want}`, `Asset ${v.t}, Strategie nur für ${v.want}`, `asset is ${v.t}, strategy is for ${v.want} only`),
  stale: v => L(`данные устарели: ${v.s} с`, `Daten veraltet: ${v.s} s`, `stale data: ${v.s} s`),
  no_data: v => L(`мало свечей (${v.n})`, `zu wenige Kerzen (${v.n})`, `not enough candles (${v.n})`),
  no_acceleration: v => L(`диапазон ${v.r}×ATR < ${v.min}`, `Spanne ${v.r}×ATR < ${v.min}`, `range ${v.r}×ATR < ${v.min}`),
  price_acceleration: v => L(`диапазон свечи ${v.r}×ATR`, `Kerzenspanne ${v.r}×ATR`, `candle range ${v.r}×ATR`),
  closes_not_aligned: v => L(`по направлению ${v.k} из 3 закрытий`, `${v.k} von 3 Schlüssen in Richtung`, `${v.k} of 3 closes in direction`),
  momentum_confirmed: v => L(`${v.k} из 3 закрытий по направлению`, `${v.k} von 3 Schlüssen in Richtung`, `${v.k} of 3 closes in direction`),
  factors_weak: v => L(`факторов «за» ${v.n} (цена или RSI не по направлению EMA)`, `${v.n} Faktoren dafür (Preis oder RSI nicht mit der EMA)`, `${v.n} factors for (price or RSI not with the EMA)`),
  factors: v => L(`факторов «за» ${v.n} из 5`, `${v.n} von 5 Faktoren dafür`, `${v.n} of 5 factors for`),
  candle_weak: v => L(`свеча слабая: тело ${v.b} %, тень ${v.w} %`, `Kerze schwach: Körper ${v.b} %, Docht ${v.w} %`, `weak candle: body ${v.b} %, wick ${v.w} %`),
  candle_ok: v => L(`свеча: тело ${v.b} %, тень ${v.w} %`, `Kerze: Körper ${v.b} %, Docht ${v.w} %`, `candle: body ${v.b} %, wick ${v.w} %`),
  agreement_low: v => L(`согласование слабое: ${v.n} из 5, score ${v.s}`, `Abgleich schwach: ${v.n} von 5, Score ${v.s}`, `weak agreement: ${v.n} of 5, score ${v.s}`),
  agreement: v => L(`согласование ${v.n} из 5, score ${v.s}`, `Abgleich ${v.n} von 5, Score ${v.s}`, `agreement ${v.n} of 5, score ${v.s}`),
  no_trend_m5: v => L(`нет тренда на 5M (ADX ${v.a})`, `kein Trend auf 5M (ADX ${v.a})`, `no 5M trend (ADX ${v.a})`),
  trend_m5: v => L(`тренд 5M ${v.d}, ADX ${v.a}`, `Trend 5M ${v.d}, ADX ${v.a}`, `5M trend ${v.d}, ADX ${v.a}`),
  weak_force: v => L(`движение слабое: тело ${v.b}×ATR, закрытий ${v.n} из 5`, `Bewegung schwach: Körper ${v.b}×ATR, ${v.n} von 5 Schlüssen`, `weak move: body ${v.b}×ATR, ${v.n} of 5 closes`),
  force: v => L(`сила: тело ${v.b}×ATR, ${v.n} из 5 закрытий`, `Kraft: Körper ${v.b}×ATR, ${v.n} von 5 Schlüssen`, `force: body ${v.b}×ATR, ${v.n} of 5 closes`),
  entry_weak: () => L('нет качественной точки входа', 'kein guter Einstiegspunkt', 'no good entry point'),
  pullback_entry: () => L('откат к EMA 20, закрытие в крайней трети', 'Rücksetzer zur EMA 20, Schluss im äußeren Drittel', 'pullback to EMA 20, close in the outer third'),
  break_entry: () => L('пробой уровня 20 свечей', 'Ausbruch über das 20-Kerzen-Level', 'breakout of the 20-candle level'),
  not_in_window: v => L(`не время: ${v.s} с от начала минуты`, `nicht die Zeit: ${v.s} s nach Minutenbeginn`, `not the time: ${v.s} s into the minute`),
  no_pressure: v => L(`нет давления (${v.n})`, `kein Druck (${v.n})`, `no pressure (${v.n})`),
  pressure: v => L(`давление: ${v.n}`, `Druck: ${v.n}`, `pressure: ${v.n}`),
  structure_changed: () => L('структура изменилась до открытия', 'Struktur vor der Eröffnung geändert', 'structure changed before the open'),
  new_candle: () => L('новая свеча продолжает', 'neue Kerze setzt fort', 'new candle continues'),
  not_flat: v => L(`не флэт (ADX ${v.a})`, `kein Seitwärtsmarkt (ADX ${v.a})`, `not flat (ADX ${v.a})`),
  flat: v => L(`флэт, ADX ${v.a}`, `seitwärts, ADX ${v.a}`, `flat, ADX ${v.a}`),
  no_deviation: () => L('нет выхода за полосу Боллинджера', 'kein Ausbruch über das Bollinger-Band', 'no move beyond the Bollinger band'),
  deviation: () => L('цена за полосой Боллинджера', 'Preis jenseits des Bollinger-Bands', 'price beyond the Bollinger band'),
  chaos: v => L(`хаос: ${v.c} % разворотов`, `Chaos: ${v.c} % Wechsel`, `chaos: ${v.c} % reversals`),
  calm: v => L(`шум ${v.c} %`, `Rauschen ${v.c} %`, `noise ${v.c} %`),
  no_series: v => L(`серия ${v.n} — мало`, `Serie ${v.n} – zu kurz`, `series ${v.n} – too short`),
  counter_move: () => L('контрдвижение больше половины серии', 'Gegenbewegung über die Hälfte der Serie', 'counter move over half the series'),
  series: v => L(`серия ${v.n} в одну сторону`, `Serie ${v.n} in eine Richtung`, `series of ${v.n} one way`),
  direction_holds: () => L('направление сохраняется', 'Richtung hält', 'direction holds'),
  no_squeeze: v => L(`нет сжатия (${v.n} свечей)`, `keine Kompression (${v.n} Kerzen)`, `no squeeze (${v.n} candles)`),
  squeeze: v => L(`сжатие ${v.n} свечей`, `Kompression ${v.n} Kerzen`, `squeeze ${v.n} candles`),
  no_expansion: () => L('нет расширения', 'keine Ausdehnung', 'no expansion'),
  expansion: v => L(`расширение ${v.r}×ATR 50`, `Ausdehnung ${v.r}×ATR 50`, `expansion ${v.r}×ATR 50`),
  no_setup: () => L('ни один детектор не нашёл сетап', 'kein Detektor fand ein Setup', 'no detector found a setup'),
  detector: v => L(`детектор: ${v.d}`, `Detektor: ${v.d}`, `detector: ${v.d}`),
  detector_score: v => L(`лучший score ${v.s}`, `bester Score ${v.s}`, `best score ${v.s}`),
  confirmed_before_candle: () => L('подтверждено перед свечой', 'vor der Kerze bestätigt', 'confirmed before the candle'),
  no_zone: () => L('цена не в зоне FVG / Order Block', 'Preis nicht in FVG / Order Block', 'price not in an FVG / order block'),
  zone: v => L(`реакция в зоне ${v.z}`, `Reaktion in der Zone ${v.z}`, `reaction in the ${v.z} zone`),
  smc_weak: v => L(`согласовано элементов ${v.n} из 3`, `${v.n} von 3 Elementen stimmen`, `${v.n} of 3 elements agree`),
  smc: v => L(`FVG / OB / BOS: согласовано ${v.n}`, `FVG / OB / BOS: ${v.n} stimmen`, `FVG / OB / BOS: ${v.n} agree`),
  back_in_zone: () => L('цена вернулась в зону', 'Preis zurück in der Zone', 'price back in the zone'),
  held: () => L('следующая свеча удержалась', 'Folgekerze hielt', 'next candle held'),
  no_dominance: v => L(`перевес ${v.n} %`, `Übergewicht ${v.n} %`, `dominance ${v.n} %`),
  dominance: v => L(`перевес ${v.n} %`, `Übergewicht ${v.n} %`, `dominance ${v.n} %`),
  no_impulse: () => L('нет импульса', 'kein Impuls', 'no impulse'),
  impulse_found: v => L(`импульс ${v.r}×ATR`, `Impuls ${v.r}×ATR`, `impulse ${v.r}×ATR`),
  no_correction: v => L(`нет правильной коррекции (откат ${v.p} %)`, `keine saubere Korrektur (Rücksetzer ${v.p} %)`, `no clean correction (pullback ${v.p} %)`),
  correction: v => L(`коррекция ${v.p} %, реакция по импульсу`, `Korrektur ${v.p} %, Reaktion mit dem Impuls`, `correction ${v.p} %, reaction with the impulse`),
  pause: v => L(`пауза ${v.n} св., откат ${v.p} %`, `Pause ${v.n} Kerzen, Rücksetzer ${v.p} %`, `pause ${v.n} candles, pullback ${v.p} %`),
  second_impulse: () => L('второй импульс обновил экстремум', 'zweiter Impuls über das Extrem', 'second impulse beyond the extreme'),
  no_double: () => L('нет двойного импульса', 'kein Doppelimpuls', 'no double impulse'),
  model_not_trained: () => L('модель не обучена', 'Modell nicht trainiert', 'model not trained'),
  features_ok: () => L('признаки посчитаны', 'Merkmale berechnet', 'features computed'),
  out_of_distribution: () => L('рынок вне обучающих данных', 'Markt außerhalb der Trainingsdaten', 'market outside the training data'),
  model: v => L(`модель: вверх ${v.p} %`, `Modell: aufwärts ${v.p} %`, `model: up ${v.p} %`),
  low_confidence: v => L(`уверенность мала (вверх ${v.p} %)`, `Sicherheit gering (aufwärts ${v.p} %)`, `low confidence (up ${v.p} %)`),
  confident: v => L(`уверенность ${v.p} %`, `Sicherheit ${v.p} %`, `confidence ${v.p} %`),
  ma_against: v => L(`EMA ${v.f} / EMA ${v.s} против сигнала`, `EMA ${v.f} / EMA ${v.s} gegen das Signal`, `EMA ${v.f} / EMA ${v.s} against the signal`),
  ma_confirmed: v => L(`EMA ${v.f} / EMA ${v.s} подтверждают`, `EMA ${v.f} / EMA ${v.s} bestätigen`, `EMA ${v.f} / EMA ${v.s} confirm`),
  prev_against: () => L('прошлая свеча в другую сторону — это качели, не импульс', 'Vorkerze in die Gegenrichtung – Schaukel, kein Impuls', 'previous candle the other way – a whipsaw, not an impulse'),
  single_spike: v => L(`одиночный всплеск: прошлая свеча ${v.r}×ATR`, `Einzelspitze: Vorkerze ${v.r}×ATR`, `single spike: previous candle ${v.r}×ATR`),
  opposite_wick: v => L(`противоположная тень ${v.w} %`, `Gegendocht ${v.w} %`, `opposite wick ${v.w} %`),
  level_too_close: v => L(`до уровня ${v.d}×ATR`, `bis zum Level ${v.d}×ATR`, `level only ${v.d}×ATR away`),
  exhaustion: v => L(`истощение: ${v.s} свечей подряд, RSI 7 = ${v.r}`, `Erschöpfung: ${v.s} Kerzen in Folge, RSI 7 = ${v.r}`, `exhaustion: ${v.s} candles in a row, RSI 7 = ${v.r}`),
  no_exhaustion: v => L(`истощения нет (серия ${v.s}, RSI 7 = ${v.r})`, `keine Erschöpfung (Serie ${v.s}, RSI 7 = ${v.r})`, `no exhaustion (streak ${v.s}, RSI 7 = ${v.r})`),
  close_not_extreme: v => L(`закрытие не в крайних ${v.p} % (${v.x} %)`, `Schluss nicht in äußeren ${v.p} % (${v.x} %)`, `close not in the outer ${v.p} % (${v.x} %)`),
  no_range: v => L(`нет диапазона: ${v.why}`, `keine Range: ${v.why}`, `no range: ${v.why}`),
  range_found: v => L(`диапазон ${v.w}×ATR, касаний ${v.a}/${v.b}`, `Range ${v.w}×ATR, Berührungen ${v.a}/${v.b}`, `range ${v.w}×ATR, touches ${v.a}/${v.b}`),
  at_bound: v => L(`цена у ${v.b === 'top' ? 'верхней' : 'нижней'} границы, пробоя нет`, `Preis an der ${v.b === 'top' ? 'oberen' : 'unteren'} Grenze, kein Ausbruch`, `price at the ${v.b === 'top' ? 'upper' : 'lower'} bound, no breakout`),
  not_at_bound: () => L('цена не у границы', 'Preis nicht an der Grenze', 'price not at a bound'),
  breakout_candle: v => L(`пробойная свеча, тело ${v.b}×ATR`, `Ausbruchskerze, Körper ${v.b}×ATR`, `breakout candle, body ${v.b}×ATR`),
  no_rejection: v => L(`нет свечи отказа (тень ${v.w} %)`, `keine Ablehnungskerze (Docht ${v.w} %)`, `no rejection candle (wick ${v.w} %)`),
  rejection: v => L(`свеча отказа, тень ${v.w} %, закрытие внутри`, `Ablehnungskerze, Docht ${v.w} %, Schluss innen`, `rejection candle, wick ${v.w} %, close inside`),
  no_structure: () => L('нет структуры HH/HL или LH/LL', 'keine Struktur HH/HL oder LH/LL', 'no HH/HL or LH/LL structure'),
  structure: v => L(`структура ${v.s}`, `Struktur ${v.s}`, `structure ${v.s}`),
  weak_level: v => L(`у уровня ${v.n} реакций`, `Level mit ${v.n} Reaktionen`, `level has ${v.n} reactions`),
  level: v => L(`уровень с ${v.n} реакциями`, `Level mit ${v.n} Reaktionen`, `level with ${v.n} reactions`),
  no_room: v => L(`до следующего уровня ${v.d}×ATR`, `bis zum nächsten Level ${v.d}×ATR`, `next level only ${v.d}×ATR away`),
  no_breakout: () => L('нет пробоя с закреплением', 'kein bestätigter Ausbruch', 'no breakout that holds'),
  breakout: v => L(`пробой ${v.b}×ATR, следующая свеча удержалась`, `Ausbruch ${v.b}×ATR, Folgekerze hielt`, `breakout ${v.b}×ATR, next candle held`),
  no_poke: () => L('нет выхода за экстремум', 'kein Stich über das Extrem', 'no poke beyond the extreme'),
  real_breakout: v => L(`выход ${v.d}×ATR — похоже на настоящий пробой`, `Ausbruch ${v.d}×ATR – wohl echter Ausbruch`, `poke ${v.d}×ATR – looks like a real breakout`),
  poke: v => L(`выход за экстремум на ${v.d}×ATR`, `Stich über das Extrem um ${v.d}×ATR`, `poke beyond the extreme by ${v.d}×ATR`),
  no_return: () => L('нет возврата в диапазон', 'keine Rückkehr in die Range', 'no return into the range'),
  returned: () => L('закрытие обратно в диапазоне', 'Schluss zurück in der Range', 'close back inside the range'),
  weak_counter: v => L(`тело свечи против пробоя ${v.b} %`, `Körper gegen den Ausbruch ${v.b} %`, `body against the breakout ${v.b} %`),
  counter_candle: v => L(`свеча против пробоя, тело ${v.b} %`, `Kerze gegen den Ausbruch, Körper ${v.b} %`, `candle against the breakout, body ${v.b} %`),
  no_overheat: v => L(`Z-score ${v.z}`, `Z-Score ${v.z}`, `Z-score ${v.z}`),
  overheat: v => L(`Z-score ${v.z} у экстремума 20 свечей`, `Z-Score ${v.z} am 20-Kerzen-Extrem`, `Z-score ${v.z} at the 20-candle extreme`),
  atr_out_of_band: v => L(`ATR-перцентиль ${v.p}, нужно ${v.lo}–${v.hi}`, `ATR-Perzentil ${v.p}, nötig ${v.lo}–${v.hi}`, `ATR percentile ${v.p}, needs ${v.lo}–${v.hi}`),
  atr_ok: v => L(`ATR-перцентиль ${v.p}`, `ATR-Perzentil ${v.p}`, `ATR percentile ${v.p}`),
  strong_trend_against: v => L(`ADX ${v.a} — сильный тренд против`, `ADX ${v.a} – starker Trend dagegen`, `ADX ${v.a} – strong trend against`),
};
const joinL = parts => L(parts.map(p => p.ru).join(' · '), parts.map(p => p.de).join(' · '), parts.map(p => p.en).join(' · '));
const f1 = v => (Math.round(v * 10) / 10).toString(), f0 = v => String(Math.round(v));

// ---------- helpers on closed candles ----------
const rng = k => k.high - k.low;
const body = k => Math.abs(k.close - k.open);
const dirOf = k => (k.close > k.open ? 1 : k.close < k.open ? -1 : 0);
function oppWickPct(k, d) { const r = rng(k); if (!(r > 0)) return 100; return 100 * (d > 0 ? k.high - Math.max(k.open, k.close) : Math.min(k.open, k.close) - k.low) / r; }
function streak(c, i) { const d = dirOf(c[i]); let n = 0; while (i - n >= 0 && d && dirOf(c[i - n]) === d) n++; return n; }
function atrPct(atr, i, win = 200) { const v = atr[i]; if (!(v > 0)) return null; const a = []; for (let j = Math.max(0, i - win + 1); j <= i; j++) if (atr[j] > 0) a.push(atr[j]); if (a.length < 50) return null; return 100 * a.filter(x => x <= v).length / a.length; }
// Fractals 2+2 that are fully confirmed by candle i (so j ≤ i − 2).
function fractalsUpTo(c, i, from) {
  const hi = [], lo = [];
  for (let j = Math.max(2, from); j <= i - 2; j++) {
    const h = c[j].high, l = c[j].low;
    if (h > c[j - 1].high && h > c[j - 2].high && h >= c[j + 1].high && h >= c[j + 2].high) hi.push({ j, v: h, amp: h - Math.min(c[j - 2].low, c[j + 2].low) });
    if (l < c[j - 1].low && l < c[j - 2].low && l <= c[j + 1].low && l <= c[j + 2].low) lo.push({ j, v: l, amp: Math.max(c[j - 2].high, c[j + 2].high) - l });
  }
  return { hi, lo };
}
// Nearest swing level ahead in direction d (fractal extreme), distance in ATR.
function levelAhead(c, i, d, price, atr) {
  const f = fractalsUpTo(c, i, i - 60), pts = (d > 0 ? f.hi : f.lo).map(p => p.v).filter(v => (d > 0 ? v > price : v < price));
  if (!pts.length) return Infinity;
  return Math.min(...pts.map(v => Math.abs(v - price))) / atr;
}

// ---------- stage 2 logics (13.11.2026) ----------
// Same contract: return fail(...) to stop, or set out.dir + out.score and return nothing. Only closed candles,
// except candle_bot which runs on the forming candle (liveMode 'live').
const closes = c => c.map(x => x.close);
const swings = (c, i, n, from) => { // swing points n+n, confirmed by candle i
  const hi = [], lo = [];
  for (let j = Math.max(n, from); j <= i - n; j++) {
    let h = true, l = true;
    for (let q = j - n; q <= j + n; q++) { if (q === j) continue; if (c[q].high >= c[j].high) h = false; if (c[q].low <= c[j].low) l = false; }
    if (h) hi.push({ j, v: c[j].high }); if (l) lo.push({ j, v: c[j].low });
  }
  return { hi, lo };
};
const chaosShare = (c, i, n) => { let ch = 0; for (let j = i - n + 2; j <= i; j++) if (dirOf(c[j]) && dirOf(c[j - 1]) && dirOf(c[j]) !== dirOf(c[j - 1])) ch++; return ch / (n - 1); };
const MORE = {
  mini_vip({ c, p, i, a, atrA, k, fail, pass, out }) {
    const cl = closes(c), e9 = I.ema(cl, p.vip_ema_fast || 9)[i], e21 = I.ema(cl, p.vip_ema_slow || 21)[i], rs = I.rsi(cl, p.rsi_period || 14)[i], pc = atrPct(atrA, i), d = e9 > e21 ? 1 : -1;
    const f = { dir: true, rsi: d > 0 ? rs > p.rsi_call : rs < p.rsi_put, atr: pc != null && pc >= p.atr_pct_lo && pc <= p.atr_pct_hi, side: d > 0 ? k.close > e21 : k.close < e21, room: levelAhead(c, i, d, k.close, a) >= p.min_level_distance_atr };
    const n = Object.values(f).filter(Boolean).length;
    Object.assign(out.feats, { ema9: e9, ema21: e21, rsi14: rs, atr_pct: pc, factors: n });
    if (!f.side || !f.rsi) return fail(0, 'factors_weak', { n, need: p.min_factors });
    pass(0, 'factors', { n }); out.dir = d;
    const bp = 100 * body(k) / (rng(k) || 1), ow = oppWickPct(k, d);
    if (dirOf(k) !== d || bp < p.body_pct || ow > p.max_opposite_wick_pct) return fail(1, 'candle_weak', { b: f0(bp), w: f0(ow) });
    pass(1, 'candle_ok', { b: f0(bp), w: f0(ow) });
    const score = Math.round(40 + 8 * n + 10 * Math.min(1, (bp - 50) / 40) + 10 * (1 - ow / 30));
    if (n < p.min_factors || score < p.min_score) return fail(2, 'agreement_low', { n, s: score });
    pass(2, 'agreement', { n, s: score }); out.score = score;
  },
  pro_bot({ c, p, i, a, k, fail, pass, out }) {
    const m5 = I.resample(c, 5, false), j = m5.length - 1; if (j < 55) return fail(0, 'no_data', { n: m5.length });
    const e50 = I.ema(closes(m5), p.trend_ema || 50), sl = (e50[j] - e50[j - 3]) / a, d = sl > 0 && m5[j].close > e50[j] ? 1 : sl < 0 && m5[j].close < e50[j] ? -1 : 0;
    const ad = I.adx(c, p.adx_period || 14)[i], adx = ad ? ad.adx : 0; Object.assign(out.feats, { m5_slope_atr: sl, adx });
    if (!d || adx < p.adx_min) return fail(0, 'no_trend_m5', { a: f0(adx) });
    pass(0, 'trend_m5', { d: d > 0 ? '▲' : '▼', a: f0(adx) }); out.dir = d;
    const last5 = c.slice(i - 4, i + 1), avgB = last5.reduce((s, x) => s + body(x), 0) / 5 / a, same = last5.filter(x => dirOf(x) === d).length;
    const r3 = c.slice(i - 2, i + 1).reduce((s, x) => s + rng(x), 0), r3p = c.slice(i - 5, i - 2).reduce((s, x) => s + rng(x), 0);
    if (avgB < p.min_body_atr || same < p.min_closes || r3 <= r3p) return fail(1, 'weak_force', { b: f1(avgB), n: same });
    pass(1, 'force', { b: f1(avgB), n: same });
    const e20 = I.ema(closes(c), p.entry_ema || 20)[i], third = d > 0 ? k.close >= k.high - rng(k) / 3 : k.close <= k.low + rng(k) / 3;
    const pull = Math.abs((d > 0 ? k.low : k.high) - e20) <= p.pullback_atr * a;
    const hi20 = Math.max(...c.slice(i - 21, i).map(x => x.high)), lo20 = Math.min(...c.slice(i - 21, i).map(x => x.low));
    const brk = d > 0 ? k.close >= hi20 + p.break_atr * a : k.close <= lo20 - p.break_atr * a;
    if (!third || !(pull || brk)) return fail(2, 'entry_weak');
    pass(2, pull ? 'pullback_entry' : 'break_entry'); out.score = Math.round(55 + 15 * Math.min(1, adx / 40) + 15 * Math.min(1, avgB) + 15 * (same / 5));
  },
  candle_bot({ c, p, i, a, k, fail, pass, out }) {
    // c ends with the forming candle (live). Signal only in the window sec_from…sec_to of the minute.
    const sec = Math.floor(Date.now() / 1000) - k.time;
    if (!p.backtest && (sec < p.sec_from || sec > p.sec_to)) return fail(0, 'not_in_window', { s: sec });
    const cl = c.slice(i - 4, i), d0 = dirOf(cl[3]), same = cl.filter(x => dirOf(x) === d0).length;
    if (!d0 || same < p.min_closes) return fail(0, 'no_pressure', { n: same });
    pass(0, 'pressure', { n: same }); out.dir = d0;
    const seq = d0 > 0 ? cl[3].high > cl[2].high && cl[2].high > cl[1].high && cl[3].low > cl[2].low : cl[3].low < cl[2].low && cl[2].low < cl[1].low && cl[3].high < cl[2].high;
    if (!seq || oppWickPct(cl[3], d0) > p.max_opposite_wick_pct) return fail(1, 'no_structure');
    pass(1, 'structure', { s: d0 > 0 ? 'HH/HL' : 'LH/LL' });
    if (dirOf(k) === -d0 || levelAhead(c, i - 1, d0, k.close, a) < p.min_level_distance_atr) return fail(2, 'structure_changed');
    pass(2, 'new_candle'); out.score = Math.round(55 + 10 * (same - 3) + 20 * Math.min(1, levelAhead(c, i - 1, d0, k.close, a) / 2));
  },
  meanrev({ c, p, i, a, atrA, k, fail, pass, out }) {
    const ad = I.adx(c, p.adx_period || 14)[i], adx = ad ? ad.adx : 99, pc = atrPct(atrA, i); Object.assign(out.feats, { adx, atr_pct: pc });
    if (adx >= p.adx_max || pc == null || pc < p.atr_pct_lo || pc > p.atr_pct_hi) return fail(0, 'not_flat', { a: f0(adx) });
    pass(0, 'flat', { a: f0(adx) });
    const bb = I.bollinger(closes(c), p.bb_period || 20, p.bb_mult)[i]; if (!bb) return fail(1, 'no_data', { n: c.length });
    const up = k.high > bb.up, dn = k.low < bb.lo, d = up ? -1 : dn ? 1 : 0;
    if (!d || body(k) >= p.max_body_atr * a) return fail(1, 'no_deviation');
    pass(1, 'deviation'); out.dir = d;
    const wick = 100 * (d < 0 ? k.high - Math.max(k.open, k.close) : Math.min(k.open, k.close) - k.low) / (rng(k) || 1);
    if (wick < p.wick_pct || (d < 0 ? k.close > bb.up : k.close < bb.lo)) return fail(2, 'no_rejection', { w: f0(wick) });
    pass(2, 'rejection', { w: f0(wick) }); out.score = Math.round(55 + 25 * Math.min(1, (wick - 50) / 40) + 20 * (1 - adx / p.adx_max));
  },
  micro({ c, p, i, a, k, fail, pass, out }) { // Ludo 15 s / Fun 5 s on second candles
    const ch = chaosShare(c, i, p.window); out.feats.chaos = ch;
    if (ch > p.max_chaos) return fail(0, 'chaos', { c: f0(ch * 100) });
    pass(0, 'calm', { c: f0(ch * 100) });
    const st = streak(c, i), d = dirOf(k);
    if (!d || st < p.min_series) return fail(1, 'no_series', { n: st });
    const ser = c.slice(i - st + 1, i + 1), mv = Math.abs(ser[ser.length - 1].close - ser[0].open), back = Math.max(...ser.map(x => oppWickPct(x, d) / 100 * rng(x)));
    if (back > 0.5 * mv) return fail(1, 'counter_move');
    pass(1, 'series', { n: st }); out.dir = d;
    pass(2, 'direction_holds'); out.score = Math.round(50 + 10 * Math.min(3, st - p.min_series) + 20 * (1 - ch));
  },
  volatility({ c, p, i, a, k, fail, pass, out }) {
    const a5 = I.atr(c, p.atr_fast || 5), a50 = I.atr(c, p.atr_slow || 50); let sq = 0;
    for (let j = i - 2; j > i - 30 && j > 50; j--) { if (a5[j] / a50[j] < p.squeeze) sq++; else break; }
    out.feats.squeeze_candles = sq;
    if (sq < p.min_squeeze) return fail(0, 'no_squeeze', { n: sq });
    pass(0, 'squeeze', { n: sq });
    const e = c[i - 1], d = dirOf(e);
    if (!d || rng(e) < p.expansion_atr * a50[i - 1] || dirOf(k) !== d) return fail(1, 'no_expansion');
    pass(1, 'expansion', { r: f1(rng(e) / a50[i - 1]) }); out.dir = d;
    if (streak(c, i) > p.max_expansion) return fail(2, 'exhaustion', { s: streak(c, i), r: '-' });
    pass(2, 'direction_holds'); out.score = Math.round(55 + 5 * Math.min(5, sq - p.min_squeeze) + 20 * Math.min(1, rng(e) / a50[i - 1] / 4));
  },
  scanner(ctx) { // best of the Impulse, Range, Fractal and Trap detectors on this pair
    const { c, p, out, fail, pass } = ctx; let best = null;
    for (const det of ['impulse', 'range', 'fractal', 'trap']) {
      const r = run(det, c, { ...PARAMS[det], forex: false });
      if (r.status === 'SIGNAL' && (!best || r.score > best.r.score)) best = { det, r };
    }
    if (!best) return fail(0, 'no_setup');
    pass(0, 'detector', { d: best.det }); pass(1, 'detector_score', { s: best.r.score }); pass(2, 'confirmed_before_candle');
    out.dir = best.r.dir; out.score = best.r.score; out.feats.detector = best.det; out.reasons.push(...best.r.reasons);
  },
  smart_money({ c, p, i, a, k, fail, pass, out }) {
    const cc = p.m5 ? I.resample(c, 5, false) : c, n = cc.length - 1; if (n < 40) return fail(0, 'no_data', { n: cc.length });
    const A = I.atr(cc, p.atr_period || 14)[n] || a, sw = swings(cc, n, 3, n - 60), H = sw.hi.slice(-2), Lw = sw.lo.slice(-2);
    let d = 0; if (H.length === 2 && Lw.length === 2) { if (H[1].v > H[0].v && Lw[1].v > Lw[0].v) d = 1; else if (H[1].v < H[0].v && Lw[1].v < Lw[0].v) d = -1; }
    if (!d) return fail(0, 'no_structure');
    pass(0, 'structure', { s: d > 0 ? 'HH/HL' : 'LH/LL' }); out.dir = d;
    const K = cc[n]; let fvg = null, ob = null;
    for (let j = n - 1; j >= n - 20 && j >= 2; j--) {
      if (!fvg && d > 0 && cc[j].low - cc[j - 2].high >= p.fvg_atr * A) fvg = { lo: cc[j - 2].high, hi: cc[j].low };
      if (!fvg && d < 0 && cc[j - 2].low - cc[j].high >= p.fvg_atr * A) fvg = { lo: cc[j].high, hi: cc[j - 2].low };
      if (!ob && j + 3 <= n && dirOf(cc[j]) === -d && d * (cc[j + 3].close - cc[j].close) >= p.ob_atr * A) ob = { lo: cc[j].low, hi: cc[j].high };
    }
    const inZone = z => z && K.low <= z.hi && K.high >= z.lo;
    const last = d > 0 ? sw.hi[sw.hi.length - 1] : sw.lo[sw.lo.length - 1];
    let bos = false; for (let j = n; j > n - 10; j--) if (last && j > last.j && d * (cc[j].close - last.v) > 0) bos = true;
    const agree = [inZone(fvg), inZone(ob), bos].filter(Boolean).length;
    if (!inZone(fvg) && !inZone(ob)) return fail(1, 'no_zone');
    pass(1, 'zone', { z: inZone(fvg) ? 'FVG' : 'OB' });
    if (agree < 2 || dirOf(K) !== d) return fail(2, 'smc_weak', { n: agree });
    pass(2, 'smc', { n: agree }); out.score = Math.round(55 + 15 * (agree - 1) + 15 * Math.min(1, body(K) / A));
  },
  spring({ c, p, i, a, k, fail, pass, out }) {
    const a50 = I.atr(c, p.atr_slow || 50)[i - 2]; let n = 0, hi = -Infinity, lo = Infinity;
    for (let j = i - 2; j > i - 30; j--) { const h2 = Math.max(hi, c[j].high), l2 = Math.min(lo, c[j].low); if (h2 - l2 > p.zone_atr * a50 || rng(c[j]) > p.spike_atr * a50) break; hi = h2; lo = l2; n++; }
    out.feats.squeeze_candles = n;
    if (n < p.min_candles_zone) return fail(0, 'no_squeeze', { n });
    pass(0, 'squeeze', { n });
    const b = c[i - 1], d = b.close > hi ? 1 : b.close < lo ? -1 : 0;
    if (!d || body(b) < p.break_body_atr * a || oppWickPct(b, d) > p.max_opposite_wick_pct) return fail(1, 'no_breakout');
    pass(1, 'breakout', { b: f1(body(b) / a) }); out.dir = d;
    if (dirOf(k) !== d || (d > 0 ? k.low <= hi : k.high >= lo)) return fail(2, 'back_in_zone');
    pass(2, 'held'); out.score = Math.round(55 + 5 * Math.min(5, n - 5) + 20 * Math.min(1, body(b) / a / 2.4));
  },
  pressure({ c, p, i, a, k, fail, pass, out }) {
    const w = c.slice(i - p.window + 1, i + 1), top = w.filter(x => x.close >= x.high - rng(x) / 3).length / w.length, bot = w.filter(x => x.close <= x.low + rng(x) / 3).length / w.length;
    const d = top >= p.third_share ? 1 : bot >= p.third_share ? -1 : 0; Object.assign(out.feats, { top_share: top, bottom_share: bot });
    if (!d) return fail(0, 'no_pressure', { n: f0(Math.max(top, bot) * 100) });
    pass(0, 'pressure', { n: f0((d > 0 ? top : bot) * 100) }); out.dir = d;
    let seq = 0; for (let j = i; j > i - 6; j--) { if (d > 0 ? c[j].high > c[j - 1].high && c[j].low > c[j - 1].low : c[j].high < c[j - 1].high && c[j].low < c[j - 1].low) seq++; else break; }
    const ow = w.reduce((s, x) => s + oppWickPct(x, d), 0) / w.length;
    if (seq < p.min_sequence || ow > p.max_opposite_wick_pct) return fail(1, 'no_structure');
    pass(1, 'structure', { s: d > 0 ? 'HH/HL' : 'LH/LL' });
    const dom = w.filter(x => dirOf(x) === d).length / w.length;
    if (dom < p.dominance || (dirOf(k) === -d && body(k) > a)) return fail(2, 'no_dominance', { n: f0(dom * 100) });
    pass(2, 'dominance', { n: f0(dom * 100) }); out.score = Math.round(50 + 20 * dom + 10 * Math.min(3, seq - 2) + 10 * (1 - ow / 30));
  },
  correction({ c, p, i, a, k, fail, pass, out }) {
    // Impulse ≥ imp_atr × ATR within ≤ 5 candles that ended 2…12 candles ago; pullback 38–62 % with shrinking bodies; reaction candle.
    let best = null;
    for (let e = i - 2; e >= i - 12; e--) for (let s = e - 1; s >= e - 5; s--) {
      const mv = c[e].close - c[s].open; if (Math.abs(mv) >= p.imp_atr * a && (!best || Math.abs(mv) > Math.abs(best.mv))) best = { s, e, mv };
    }
    if (!best) return fail(0, 'no_impulse');
    const d = best.mv > 0 ? 1 : -1, ext = d > 0 ? Math.max(...c.slice(best.s, best.e + 1).map(x => x.high)) : Math.min(...c.slice(best.s, best.e + 1).map(x => x.low));
    pass(0, 'impulse_found', { r: f1(Math.abs(best.mv) / a) }); out.dir = d;
    const pb = c.slice(best.e + 1, i), deep = d > 0 ? Math.min(...pb.map(x => x.low)) : Math.max(...pb.map(x => x.high));
    const depth = Math.abs(ext - deep) / Math.abs(ext - c[best.s].open);
    const f = fractalsUpTo(c, i, i - 80), lv = (d > 0 ? f.lo : f.hi).filter(x => Math.abs(x.v - deep) <= 0.3 * a).length + 1;
    out.feats.depth = depth;
    if (lv < p.min_reactions) return fail(1, 'weak_level', { n: lv });
    pass(1, 'level', { n: lv });
    const shrink = pb.length >= 2 && body(pb[pb.length - 1]) < body(pb[0]);
    if (depth < p.depth_min || depth > p.depth_max || !shrink || dirOf(k) !== d) return fail(2, 'no_correction', { p: f0(depth * 100) });
    pass(2, 'correction', { p: f0(depth * 100) }); out.score = Math.round(55 + 20 * (1 - Math.abs(depth - 0.5) / 0.12) * 0.5 + 15 * Math.min(1, body(k) / a));
  },
  double_strike({ c, p, i, a, k, fail, pass, out }) {
    for (let pz = 1; pz <= 4; pz++) {
      const e = i - pz - 1; if (e < 6) break;
      for (let s = e - 1; s >= e - 4; s--) {
        const mv = c[e].close - c[s].open; if (Math.abs(mv) < p.imp_atr * a) continue;
        const d = mv > 0 ? 1 : -1, ext = d > 0 ? Math.max(...c.slice(s, e + 1).map(x => x.high)) : Math.min(...c.slice(s, e + 1).map(x => x.low));
        const pause = c.slice(e + 1, i), back = Math.max(0, ...pause.map(x => d > 0 ? ext - x.low : x.high - ext)) / Math.abs(mv);
        if (back > p.max_retrace || pause.some(x => d * (x.close - c[s].open) < 0)) continue;
        if (d * (k.close - ext) <= 0 || dirOf(k) !== d) continue;
        pass(0, 'impulse_found', { r: f1(Math.abs(mv) / a) }); pass(1, 'pause', { n: pz, p: f0(back * 100) }); pass(2, 'second_impulse');
        out.dir = d; out.score = Math.round(55 + 15 * Math.min(1, Math.abs(mv) / a / 4) + 15 * (1 - back / p.max_retrace)); return;
      }
    }
    return fail(0, 'no_double');
  },
  neuro({ c, p, i, a, atrA, k, fail, pass, out }) {
    const W = NEURO(); if (!W) return fail(1, 'model_not_trained');
    const x = neuroFeatures(c, i, atrA); if (!x) return fail(0, 'no_data', { n: c.length });
    pass(0, 'features_ok');
    if (x.some((v, j) => Math.abs((v - W.mean[j]) / (W.sd[j] || 1)) > 4)) return fail(1, 'out_of_distribution');
    const z = W.b + x.reduce((s, v, j) => s + W.w[j] * (v - W.mean[j]) / (W.sd[j] || 1), 0), pr = 1 / (1 + Math.exp(-z));
    pass(1, 'model', { p: f0(pr * 100) }); out.feats.p_up = pr;
    const d = pr >= p.threshold ? 1 : pr <= 1 - p.threshold ? -1 : 0;
    if (!d) return fail(2, 'low_confidence', { p: f0(pr * 100) });
    pass(2, 'confident', { p: f0(Math.max(pr, 1 - pr) * 100) }); out.dir = d; out.score = Math.round(50 + 100 * (Math.max(pr, 1 - pr) - 0.5));
  },
};
// Neuro Bot features (closed candles only): trend, momentum, volatility, candle shape, structure.
function neuroFeatures(c, i, atrA) {
  if (i < 60) return null;
  const cl = closes(c), a = atrA[i]; if (!(a > 0)) return null;
  const e9 = I.ema(cl, 9), e21 = I.ema(cl, 21), s20 = I.sma(cl, 20), r14 = I.rsi(cl, 14), r7 = I.rsi(cl, 7), ad = I.adx(c, 14)[i] || { adx: 20, pdi: 20, mdi: 20 };
  const k = c[i], n3 = (cl[i] - cl[i - 3]) / a, n10 = (cl[i] - cl[i - 10]) / a;
  return [(e9[i] - e21[i]) / a, (cl[i] - s20[i]) / a, (r14[i] || 50) - 50, (r7[i] || 50) - 50, ad.adx, (ad.pdi - ad.mdi), n3, n10,
    (k.close - k.open) / a, oppWickPct(k, 1) / 100, oppWickPct(k, -1) / 100, a / (atrA.slice(i - 49, i + 1).reduce((s, v) => s + (v || 0), 0) / 50), streak(c, i) * dirOf(k), chaosShare(c, i, 10)];
}
let NEURO_W;
function NEURO() { if (NEURO_W === undefined) { try { NEURO_W = require('./lab-neuro'); } catch { NEURO_W = null; } } return NEURO_W && NEURO_W.w ? NEURO_W : null; }

// ---------- the five logics ----------
// Each returns { dir, score, stage results, reasons/rejects with numbers }. A failed stage ends the run.
function run(logic, c, p, asset) {
  const i = c.length - 1, atrA = I.atr(c, p.atr_period || 14), a = atrA[i], out = { stages: ['SKIPPED', 'SKIPPED', 'SKIPPED'], reasons: [], rejects: [], feats: {} };
  const fail = (st, code, v = {}) => { out.stages[st] = 'FAIL'; out.rejects.push({ code, v }); out.status = 'NO_TRADE'; out.stage = st + 1; return out; };
  const pass = (st, code, v = {}) => { out.stages[st] = 'PASS'; out.reasons.push({ code, v }); };
  if (c.length < (p.min_candles || 60) || !(a > 0)) { out.status = 'NO_DATA'; out.rejects.push({ code: 'no_data', v: { n: c.length } }); out.stage = 0; return out; }
  const k = c[i];
  out.feats.atr = a;
  if (MORE[logic]) { const r = MORE[logic]({ c, p, i, a, atrA, k, out, fail, pass }); if (r) return r; }
  else if (logic === 'impulse') {
    const r = rng(k) / a, d = dirOf(k); out.feats.range_atr = r;
    if (r < p.accel_range_atr || !d) return fail(0, 'no_acceleration', { r: f1(r), min: p.accel_range_atr });
    let same = 0; for (let j = i - 2; j <= i; j++) if (dirOf(c[j]) === d) same++;
    if (same < p.min_directional_closes) return fail(0, 'closes_not_aligned', { k: same });
    pass(0, 'price_acceleration', { r: f1(r) }); out.dir = d;
    const pr = rng(c[i - 1]) / a, ow = oppWickPct(k, d), lv = levelAhead(c, i, d, k.close, a), st = streak(c, i), rs = I.rsi(c.map(x => x.close), p.rsi_period || 7)[i] || 50;
    Object.assign(out.feats, { prev_range_atr: pr, opp_wick_pct: ow, level_atr: lv, streak: st, rsi7: rs });
    if (pr < p.prev_range_atr) return fail(1, 'single_spike', { r: f1(pr) });
    // 13.11.2026 (user, USD/CLP CALL 23:38): the previous big candle must go the same way – a big red candle followed
    // by a big green one is a whipsaw, not an impulse up (streak was 1).
    if (p.prev_same_dir !== false && dirOf(c[i - 1]) !== d) return fail(1, 'prev_against', {});
    if (ow > p.max_opposite_wick_pct) return fail(1, 'opposite_wick', { w: f0(ow) });
    if (lv < p.min_level_distance_atr) return fail(1, 'level_too_close', { d: f1(lv) });
    if (st >= p.exhaustion_streak || rs > p.rsi_hi || rs < p.rsi_lo) return fail(1, 'exhaustion', { s: st, r: f0(rs) });
    if (p.forex) { const x = 100 * (d > 0 ? k.high - k.close : k.close - k.low) / rng(k); if (x > p.forex_close_extreme_pct) return fail(1, 'close_not_extreme', { p: p.forex_close_extreme_pct, x: f0(x) }); }
    pass(1, 'momentum_confirmed', { k: same }); pass(2, 'no_exhaustion', { s: st, r: f0(rs) });
    out.score = Math.round(50 + 15 * Math.min(1, (r - p.accel_range_atr) / 1.5) + 10 * (same === 3) + 10 * (1 - ow / p.max_opposite_wick_pct) + 15 * Math.min(1, lv / 2));
  } else if (logic === 'range') {
    const w0 = i - p.window, seg = c.slice(w0, i); if (w0 < 0) return fail(0, 'no_data', { n: c.length });
    const hi = Math.max(...seg.map(x => x.high)), lo = Math.min(...seg.map(x => x.low)), w = (hi - lo) / a;
    const tol = p.touch_tol_atr * a, th = seg.filter(x => x.high >= hi - tol).length, tl = seg.filter(x => x.low <= lo + tol).length;
    const e = I.ema(c.map(x => x.close), p.range_ema || 20), slope = Math.abs(e[i - 1] - e[i - 6]) / 5 / a;
    Object.assign(out.feats, { width_atr: w, touches_hi: th, touches_lo: tl, ema_slope_atr: slope });
    if (th < p.min_touches || tl < p.min_touches) return fail(0, 'no_range', { why: `${th}/${tl}` });
    if (w < p.width_min_atr || w > p.width_max_atr) return fail(0, 'no_range', { why: `${f1(w)}×ATR` });
    if (slope >= p.max_slope_atr) return fail(0, 'no_range', { why: `EMA ${slope.toFixed(3)}×ATR` });
    pass(0, 'range_found', { w: f1(w), a: th, b: tl });
    const zone = p.zone_pct / 100 * (hi - lo), atTop = k.high >= hi - zone, atBot = k.low <= lo + zone;
    if (atTop === atBot) return fail(1, 'not_at_bound');
    for (let j = i - 2; j <= i; j++) if (body(c[j]) > p.break_body_atr * a && (c[j].close > hi || c[j].close < lo)) return fail(1, 'breakout_candle', { b: f1(body(c[j]) / a) });
    pass(1, 'at_bound', { b: atTop ? 'top' : 'bottom' });
    const d = atTop ? -1 : 1, wick = 100 * (d < 0 ? k.high - Math.max(k.open, k.close) : Math.min(k.open, k.close) - k.low) / (rng(k) || 1);
    out.feats.rejection_wick_pct = wick;
    if (wick < p.rejection_wick_pct || k.close > hi || k.close < lo) return fail(2, 'no_rejection', { w: f0(wick) });
    pass(2, 'rejection', { w: f0(wick) }); out.dir = d;
    out.score = Math.round(55 + 10 * Math.min(1, (Math.min(th, tl) - 2) / 2) + 20 * Math.min(1, (wick - 50) / 40) + 15 * (1 - slope / p.max_slope_atr));
  } else if (logic === 'fractal') {
    const f = fractalsUpTo(c, i - 1, i - p.lookback), big = arr => arr.filter(x => x.amp >= p.min_amp_atr * a);
    const H = big(f.hi), Lo = big(f.lo);
    let d = 0;
    const lastTwo = arr => arr.slice(-2);
    const [h1, h2] = lastTwo(H), [l1, l2] = lastTwo(Lo);
    if (h1 && h2 && l1 && l2) { if (h2.v > h1.v && l2.v > l1.v) d = 1; else if (h2.v < h1.v && l2.v < l1.v) d = -1; }
    if (!d) return fail(0, 'no_structure');
    pass(0, 'structure', { s: d > 0 ? 'HH/HL' : 'LH/LL' });
    const lvl = d > 0 ? h2.v : l2.v, tol = p.level_tol_atr * a, reac = (d > 0 ? f.hi : f.lo).filter(x => Math.abs(x.v - lvl) <= tol).length;
    out.feats.reactions = reac;
    // The breakout candle is i−1, candle i must hold beyond the level (signal after the hold, never on a future candle).
    const b = c[i - 1], beyond = d * (b.close - lvl) / a;
    if (reac < p.min_reactions) return fail(1, 'weak_level', { n: reac });
    const room = levelAhead(c, i, d, k.close, a);
    if (room < p.room_atr) return fail(1, 'no_room', { d: f1(room) });
    pass(1, 'level', { n: reac });
    if (!(beyond >= p.break_atr && d * (c[i - 2].close - lvl) <= 0 && d * (k.close - lvl) > 0)) return fail(2, 'no_breakout');
    pass(2, 'breakout', { b: f1(beyond) }); out.dir = d; out.feats.breakout_atr = beyond;
    out.score = Math.round(55 + 10 * Math.min(1, reac - 1) + 15 * Math.min(1, beyond / 0.6) + 20 * Math.min(1, room / 3));
  } else if (logic === 'trap') {
    const seg = c.slice(i - p.lookback - 2, i - 1); // extreme before the two poke candles
    const hi = Math.max(...seg.map(x => x.high)), lo = Math.min(...seg.map(x => x.low));
    const up = Math.max(c[i - 1].high, k.high) - hi, dn = lo - Math.min(c[i - 1].low, k.low);
    let d = 0, poke = 0;
    if (up > 0 && up >= dn) { d = -1; poke = up / a; } else if (dn > 0) { d = 1; poke = dn / a; }
    out.feats.poke_atr = poke;
    if (!d || poke < p.poke_min_atr) return fail(0, 'no_poke');
    if (poke > p.poke_max_atr) return fail(0, 'real_breakout', { d: f1(poke) });
    pass(0, 'poke', { d: f1(poke) });
    if (d < 0 ? k.close >= hi : k.close <= lo) return fail(1, 'no_return');
    pass(1, 'returned');
    const bp = 100 * body(k) / (rng(k) || 1); out.feats.body_pct = bp;
    if (dirOf(k) !== d || bp < p.body_pct) return fail(2, 'weak_counter', { b: f0(bp) });
    pass(2, 'counter_candle', { b: f0(bp) }); out.dir = d;
    out.score = Math.round(55 + 20 * (1 - Math.abs(poke - 0.3) / 0.3) * 0.5 + 25 * Math.min(1, (bp - 40) / 40) + 10);
  } else if (logic === 'overheat') {
    const cl = c.map(x => x.close), n = p.z_period;
    const z = j => { const s = cl.slice(j - n + 1, j + 1), m = s.reduce((t, v) => t + v, 0) / n, sd = Math.sqrt(s.reduce((t, v) => t + (v - m) ** 2, 0) / n); return sd > 0 ? (cl[j] - m) / sd : 0; };
    const zz = Math.abs(z(i - 1)) > Math.abs(z(i)) ? z(i - 1) : z(i); out.feats.z = zz;
    const win = c.slice(i - p.extreme_window + 1, i + 1), mx = Math.max(...win.map(x => x.high)), mn = Math.min(...win.map(x => x.low));
    let d = 0;
    if (zz >= p.z_level && Math.max(k.high, c[i - 1].high) >= mx) d = -1;
    else if (zz <= -p.z_level && Math.min(k.low, c[i - 1].low) <= mn) d = 1;
    if (!d) return fail(0, 'no_overheat', { z: f1(zz) });
    pass(0, 'overheat', { z: f1(zz) });
    const wick = 100 * (d < 0 ? k.high - Math.max(k.open, k.close) : Math.min(k.open, k.close) - k.low) / (rng(k) || 1);
    out.feats.wick_pct = wick;
    if (wick < p.wick_pct || dirOf(k) === -d) return fail(1, 'no_rejection', { w: f0(wick) });
    pass(1, 'rejection', { w: f0(wick) });
    const pc = atrPct(atrA, i, p.atr_pct_window || 200); out.feats.atr_pct = pc;
    if (pc === null) return fail(2, 'no_data', { n: c.length });
    if (pc < p.atr_pct_lo || pc > p.atr_pct_hi) return fail(2, 'atr_out_of_band', { p: f0(pc), lo: p.atr_pct_lo, hi: p.atr_pct_hi });
    if (p.forex) { const ad = I.adx(c, p.adx_period || 14)[i]; if (ad && ad.adx > p.forex_adx && (ad.pdi > ad.mdi ? 1 : -1) !== d) return fail(2, 'strong_trend_against', { a: f0(ad.adx) }); }
    pass(2, 'atr_ok', { p: f0(pc) }); out.dir = d;
    out.score = Math.round(55 + 20 * Math.min(1, (Math.abs(zz) - 2.5) / 1) + 25 * Math.min(1, (wick - 50) / 40));
  }
  // Moving-average confirmation (user 13.11.2026): EMA fast (20) above EMA slow (50) for CALL, below for PUT.
  // On by default for the move-following logics (impulse, fractal); off for the reversal ones, which trade against the move.
  if (p.ma_filter) {
    const cl = c.map(x => x.close), ef = I.ema(cl, Number(p.ma_fast) || 20)[i], es = I.ema(cl, Number(p.ma_slow) || 50)[i];
    out.feats.ema_fast = ef; out.feats.ema_slow = es;
    if (!(ef > 0 && es > 0) || (out.dir > 0 ? ef <= es : ef >= es)) { out.reasons = out.reasons.slice(0, 2); out.stages[2] = 'FAIL'; out.rejects.push({ code: 'ma_against', v: { f: p.ma_fast || 20, s: p.ma_slow || 50 } }); out.status = 'NO_TRADE'; out.stage = 3; return out; }
    out.reasons.push({ code: 'ma_confirmed', v: { f: p.ma_fast || 20, s: p.ma_slow || 50 } });
  }
  out.score = Math.max(0, Math.min(100, out.score || 0));
  out.status = 'SIGNAL';
  return out;
}

// ---------- decision log for the "no signal" block ----------
const LAST = {}; // id -> { status, stage, code, text, at, asset }
function note(id, asset, r) {
  const rej = r.rejects[0];
  LAST[id] = { status: r.status, stage: r.stage || 0, code: rej ? rej.code : null, text: rej && T[rej.code] ? T[rej.code](rej.v) : null, at: Date.now(), asset };
}
const lastDecisions = () => LAST;

// ---------- strategy functions for strategies.js (x = ctx of closed candles) ----------
const STRAT = {};
// Stale-data limit in seconds (setting stale_sec, default 5; the prompt's 2 s is below the delay of PocketOption's candle
// history, which would block every signal). 0 = off. Set by the engine.
const STALE = { sec: 5 };
const setStale = v => { STALE.sec = Number(v ?? 5); };
for (const s of CATALOG.filter(s => s.impl)) {
  const forex = s.asset_type === 'FOREX';
  STRAT[s.id] = (x, user) => {
    const asset = x.asset || '?';
    if (!!x.otc === forex) { note(s.id, asset, { status: 'NO_TRADE', stage: 0, rejects: [{ code: 'wrong_asset_type', v: { t: x.otc ? 'OTC' : 'FOREX', want: s.asset_type } }] }); return null; }
    // Fresh data: the last closed candle must have closed at most STALE seconds ago (live only; backtests call run()).
    const step = x.last > 0 ? x.c[x.last].time - x.c[x.last - 1].time : 60, age = Date.now() / 1000 - (x.c[x.last].time + (step > 0 && step < 60 ? step : 60));
    if (STALE.sec > 0 && age > STALE.sec) { note(s.id, asset, { status: 'STALE_DATA', stage: 0, rejects: [{ code: 'stale', v: { s: f1(age) } }] }); return null; }
    const p = { ...PARAMS[s.impl], ...(user || {}), forex };
    const r = run(s.logic || s.impl, x.c, p, asset);
    note(s.id, asset, r);
    if (r.status !== 'SIGNAL') return null;
    const why = joinL(r.reasons.map(q => T[q.code](q.v)));
    return {
      dir: r.dir, strength: r.score, reason: why, expiry: Number(user && user.expiry) || EXPIRY_SEC[s.impl], noFlip: true, bar: x.c[x.last].time,
      lab: { id: s.id, v: VERSION, score: r.score, stages: r.stages, reasons: r.reasons.map(q => q.code), feats: roundFeats(r.feats), type: s.asset_type },
    };
  };
}
function roundFeats(f) { const o = {}; for (const [k, v] of Object.entries(f)) o[k] = typeof v === 'number' && isFinite(v) ? +v.toPrecision(4) : v; return o; }

// Setup key: strategy + asset + direction + formation candle (one trade per setup).
const setupKey = s => `${s.strategy}|${s.asset}|${s.dir}|${s.candle.time}`;

// ---------- backtest on closed M1 candles ----------
// Decision on candles ≤ i only; entry at the open of i+1 (+ delaySec as a share of the candle move), exit at the close of
// the candle where the expiry ends. Time split: first isShare = in-sample, rest = out-of-sample (used once).
function backtest(c, id, opt = {}) {
  const s = BY_ID[id]; if (!s || !s.impl) throw new Error('not built: ' + id);
  const p = { ...PARAMS[s.impl], ...(opt.params || {}), forex: s.asset_type === 'FOREX', backtest: true };
  const expC = Math.max(1, Math.round((opt.expirySec || EXPIRY_SEC[s.impl]) / 60)), payout = opt.payout ?? 0.8, win = opt.window || 300;
  const cut = Math.floor(c.length * (opt.isShare ?? 0.7)), trades = [];
  let next = 0;
  for (let i = 210; i < c.length - expC - 1; i++) {
    if (i < next) continue;
    const r = run(s.logic || s.impl, c.slice(Math.max(0, i - win + 1), i + 1), p);
    if (r.status !== 'SIGNAL') continue;
    const entry = c[i + 1].open, exit = c[i + expC].close, m = (exit - entry) * r.dir;
    trades.push({ i, t: c[i].time, dir: r.dir, score: r.score, res: m > 0 ? 'WIN' : m < 0 ? 'LOSS' : 'DRAW', oos: i >= cut });
    next = i + 1 + COMMON.cooldown_candles;
  }
  const rep = list => {
    const w = list.filter(x => x.res === 'WIN').length, l = list.filter(x => x.res === 'LOSS').length, n = w + l;
    let eq = 0, peak = 0, dd = 0, ls = 0, mls = 0;
    for (const x of list) { if (x.res === 'WIN') { eq += payout; ls = 0; } else if (x.res === 'LOSS') { eq -= 1; ls++; mls = Math.max(mls, ls); } peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
    const ci = wilson(w, n);
    return { n, w, l, draws: list.length - n, rate: n ? w / n : null, ci, be: breakEven(payout), ev: n ? ev(w / n, payout) : null, maxLossStreak: mls, maxDrawdown: dd, verdict: verdict(w, n, payout).v };
  };
  return { id, is: rep(trades.filter(x => !x.oos)), oos: rep(trades.filter(x => x.oos)), all: rep(trades), trades };
}

// ---------- descriptions for the settings (user 14.11.2026): how it works + which indicators form the signal ----------
const DESC = {
  impulse: [L('Ищет сильную свечу и входит по её направлению, пока движение не выдохлось. Сигнал на закрытой минутной свече, вход со следующей.', 'Sucht eine starke Kerze und steigt in ihre Richtung ein, solange die Bewegung nicht erschöpft ist. Signal auf der geschlossenen Minutenkerze, Einstieg mit der nächsten.', 'Looks for a strong candle and enters in its direction while the move is not exhausted. Signal on the closed minute candle, entry with the next.'),
    L('ATR (размер свечи и до уровня), RSI (истощение), фракталы (ближайший уровень), EMA 20/50 (подтверждение, включено).', 'ATR (Kerzengröße, Abstand zum Level), RSI (Erschöpfung), Fraktale (nächstes Level), EMA 20/50 (Bestätigung, an).', 'ATR (candle size, room to level), RSI (exhaustion), fractals (next level), EMA 20/50 (confirmation, on).')],
  range: [L('Находит боковой диапазон и продаёт у верхней границы / покупает у нижней после свечи отказа. Против тренда не работает — проверяет, что рынок плоский.', 'Findet eine Seitwärts-Range und verkauft an der oberen / kauft an der unteren Grenze nach einer Ablehnungskerze. Prüft, dass der Markt flach ist.', 'Finds a sideways range and sells at the top / buys at the bottom after a rejection candle. Checks that the market is flat.'),
    L('ATR (ширина и допуски), EMA наклона (боковик), касания границ, тень свечи. EMA 20/50 — выключено (разворотная стратегия).', 'ATR (Breite, Toleranzen), Neigungs-EMA (seitwärts), Berührungen, Kerzendocht. EMA 20/50 aus (Umkehrstrategie).', 'ATR (width, tolerances), slope EMA (flat), bound touches, candle wick. EMA 20/50 off (reversal strategy).')],
  fractal: [L('Строит структуру по фракталам 2+2 (повышающиеся или понижающиеся вершины и впадины) и входит на пробое уровня, если следующая свеча удержалась за ним.', 'Baut die Struktur aus Fraktalen 2+2 (steigende oder fallende Hochs/Tiefs) und steigt beim Ausbruch ein, wenn die Folgekerze dahinter hält.', 'Builds structure from 2+2 fractals (rising or falling highs/lows) and enters on a breakout when the next candle holds beyond it.'),
    L('Фракталы, ATR (амплитуда, пробой, место до следующего уровня), EMA 20/50 (подтверждение, включено).', 'Fraktale, ATR (Amplitude, Ausbruch, Platz), EMA 20/50 (Bestätigung, an).', 'Fractals, ATR (amplitude, breakout, room), EMA 20/50 (confirmation, on).')],
  trap: [L('Ловит ложный пробой: цена чуть вышла за экстремум 20 свечей и сразу вернулась — вход против пробоя.', 'Fängt einen Fehlausbruch: Preis sticht knapp über das 20-Kerzen-Extrem und kehrt sofort zurück – Einstieg gegen den Ausbruch.', 'Catches a false breakout: price pokes just beyond the 20-candle extreme and returns at once – entry against the breakout.'),
    L('Экстремум 20 свечей, ATR (размер выхода), тело свечи. EMA 20/50 — выключено.', '20-Kerzen-Extrem, ATR (Stichgröße), Kerzenkörper. EMA 20/50 aus.', '20-candle extreme, ATR (poke size), candle body. EMA 20/50 off.')],
  overheat: [L('Цена слишком далеко ушла от средней (Z-score) и дала свечу отказа — вход обратно к средней.', 'Preis zu weit vom Mittel (Z-Score) und Ablehnungskerze – Einstieg zurück zum Mittel.', 'Price too far from the mean (Z-score) with a rejection candle – entry back to the mean.'),
    L('Z-score по закрытиям, экстремум окна, ATR-перцентиль (нормальная волатильность), для FOREX — ADX/DI (не против сильного тренда). EMA 20/50 — выключено.', 'Z-Score der Schlüsse, Fenster-Extrem, ATR-Perzentil, für FOREX ADX/DI. EMA 20/50 aus.', 'Z-score of closes, window extreme, ATR percentile, for FOREX ADX/DI. EMA 20/50 off.')],
  mini_vip: [L('Вход только когда согласны несколько факторов: направление EMA, RSI, волатильность, сторона цены и место до уровня, плюс хорошая свеча.', 'Einstieg nur, wenn mehrere Faktoren stimmen: EMA-Richtung, RSI, Volatilität, Preisseite, Platz zum Level, dazu eine gute Kerze.', 'Entry only when several factors agree: EMA direction, RSI, volatility, price side, room to level, plus a good candle.'),
    L('EMA 9 / EMA 21, RSI 14, ATR-перцентиль, фракталы (уровень), тело и тени свечи.', 'EMA 9 / EMA 21, RSI 14, ATR-Perzentil, Fraktale, Körper und Dochte.', 'EMA 9 / EMA 21, RSI 14, ATR percentile, fractals, body and wicks.')],
  pro_bot: [L('Сначала тренд на 5M, потом сила движения на 1M, потом точка входа: откат к EMA или пробой с закрытием в крайней трети свечи.', 'Erst Trend auf 5M, dann Bewegungsstärke auf 1M, dann Einstieg: Rücksetzer zur EMA oder Ausbruch mit Schluss im äußeren Drittel.', 'First the 5M trend, then the move strength on 1M, then the entry: pullback to the EMA or breakout with a close in the outer third.'),
    L('EMA 50 на 5M (наклон), ADX, тела 5 свечей и ATR, EMA 20 (откат), уровень 20 свечей, EMA 20/50 (подтверждение, включено).', 'EMA 50 auf 5M, ADX, Körper von 5 Kerzen und ATR, EMA 20, 20-Kerzen-Level, EMA 20/50 (an).', 'EMA 50 on 5M, ADX, bodies of 5 candles and ATR, EMA 20, 20-candle level, EMA 20/50 (on).')],
  candle_bot: [L('Оценивает последние свечи перед концом минуты и даёт сигнал на 45–50-й секунде, вход с новой свечи. Вручную успеть трудно.', 'Bewertet die letzten Kerzen vor Minutenende, Signal in Sekunde 45–50, Einstieg mit der neuen Kerze. Manuell schwer.', 'Rates the last candles before the minute ends, signal at second 45–50, entry with the new candle. Hard by hand.'),
    L('Направление закрытий, HH/HL, тени, фракталы (уровень), EMA 20/50 (подтверждение, включено).', 'Schlussrichtung, HH/HL, Dochte, Fraktale, EMA 20/50 (an).', 'Close direction, HH/HL, wicks, fractals, EMA 20/50 (on).')],
  meanrev: [L('Во флэте цена выходит за полосу Боллинджера и возвращается свечой с длинной тенью — вход к средней.', 'Im Seitwärtsmarkt geht der Preis über das Bollinger-Band und kehrt mit langem Docht zurück – Einstieg zur Mitte.', 'In a flat market price leaves the Bollinger band and returns with a long wick – entry to the mean.'),
    L('Полосы Боллинджера (средняя SMA), ADX (флэт), ATR-перцентиль, тень свечи.', 'Bollinger-Bänder (Mitte SMA), ADX, ATR-Perzentil, Docht.', 'Bollinger bands (SMA middle), ADX, ATR percentile, wick.')],
  ludo: [L('Сверхкороткая (15 с) на 5-секундных свечах: спокойный рынок и серия движений в одну сторону. Вручную почти невозможно успеть.', 'Ultrakurz (15 s) auf 5-Sekunden-Kerzen: ruhiger Markt und Serie in eine Richtung. Manuell kaum machbar.', 'Ultra short (15 s) on 5-second candles: calm market and a series one way. Hardly possible by hand.'),
    L('Доля разворотов (шум), длина серии, тени свечей.', 'Anteil Wechsel (Rauschen), Serienlänge, Dochte.', 'Share of reversals (noise), series length, wicks.')],
  fun5s: [L('Экспирация 5 с на 5-секундных свечах: микротренд без хаоса. Критически высокий риск.', 'Ablauf 5 s auf 5-Sekunden-Kerzen: Mikrotrend ohne Chaos. Kritisch hohes Risiko.', '5 s expiry on 5-second candles: micro trend without chaos. Critical risk.'),
    L('Доля разворотов (шум), длина серии.', 'Anteil Wechsel, Serienlänge.', 'Share of reversals, series length.')],
  volatility: [L('Сжатие волатильности, затем резкое расширение — вход по направлению (25 с, 5-секундные свечи).', 'Kompression der Volatilität, dann scharfe Ausdehnung – Einstieg in Richtung (25 s, 5-Sekunden-Kerzen).', 'Volatility squeeze, then a sharp expansion – entry in its direction (25 s, 5-second candles).'),
    L('Короткий ATR / длинный ATR (сжатие), размер свечи в ATR (расширение), серия свечей (истощение).', 'Kurzer / langer ATR, Kerzengröße in ATR, Kerzenserie.', 'Short / long ATR, candle size in ATR, candle series.')],
  scanner: [L('Прогоняет детекторы Impulse, Range, Fractal и Trap по паре и берёт сетап с лучшим score.', 'Lässt die Detektoren Impulse, Range, Fractal und Trap laufen und nimmt das Setup mit dem besten Score.', 'Runs the Impulse, Range, Fractal and Trap detectors and takes the setup with the best score.'),
    L('Индикаторы этих четырёх стратегий с их настройками по умолчанию.', 'Indikatoren dieser vier Strategien mit Standardwerten.', 'The indicators of those four strategies with their defaults.')],
  smart_money: [L('Smart Money: структура по свингам, зона FVG или Order Block по направлению, возврат цены в зону и пробой структуры (BOS). Нужны минимум 2 элемента.', 'Smart Money: Swing-Struktur, FVG- oder Order-Block-Zone, Rückkehr in die Zone und Strukturbruch (BOS). Mindestens 2 Elemente.', 'Smart Money: swing structure, FVG or order block zone, return into the zone and break of structure (BOS). At least 2 elements.'),
    L('Свинги 3+3, разрывы FVG, Order Block, BOS, ATR (размеры). На 5M-версии всё на 5-минутных свечах.', 'Swings 3+3, FVG, Order Block, BOS, ATR. 5M-Version auf 5-Minuten-Kerzen.', 'Swings 3+3, FVG, order block, BOS, ATR. The 5M version on 5-minute candles.')],
  spring: [L('Узкое сжатие минимум из 5 свечей, затем сильная пробойная свеча и подтверждение следующей свечой.', 'Enge Kompression aus mindestens 5 Kerzen, dann starke Ausbruchskerze und Bestätigung durch die nächste.', 'A tight squeeze of at least 5 candles, then a strong breakout candle confirmed by the next.'),
    L('Длинный ATR (ширина зоны), ATR (тело пробоя), тени, EMA 20/50 (подтверждение, включено).', 'Langer ATR, ATR, Dochte, EMA 20/50 (an).', 'Long ATR, ATR, wicks, EMA 20/50 (on).')],
  pressure: [L('Давление покупателей или продавцов: закрытия в крайней трети, повышающиеся вершины и впадины, перевес свечей.', 'Druck der Käufer oder Verkäufer: Schlüsse im äußeren Drittel, steigende Hochs/Tiefs, Kerzenübergewicht.', 'Buyer or seller pressure: closes in the outer third, rising highs/lows, candle dominance.'),
    L('Положение закрытий, HH/HL, тени, ATR, EMA 20/50 (подтверждение, включено).', 'Schlusslage, HH/HL, Dochte, ATR, EMA 20/50 (an).', 'Close position, HH/HL, wicks, ATR, EMA 20/50 (on).')],
  correction: [L('После сильного импульса ждёт коррекцию 38–62 % с уменьшающимися свечами у уровня и входит по направлению импульса.', 'Nach starkem Impuls wartet sie auf eine Korrektur 38–62 % mit kleiner werdenden Kerzen am Level und steigt mit dem Impuls ein.', 'After a strong impulse it waits for a 38–62 % correction with shrinking candles at a level and enters with the impulse.'),
    L('ATR (размер импульса), фракталы (уровень), глубина отката, тела свечей, EMA 20/50 (подтверждение, включено).', 'ATR, Fraktale, Rücksetzertiefe, Körper, EMA 20/50 (an).', 'ATR, fractals, pullback depth, bodies, EMA 20/50 (on).')],
  double_strike: [L('Два импульса подряд: первый, короткая пауза с небольшим откатом, второй обновляет экстремум — вход на продолжение.', 'Zwei Impulse: der erste, kurze Pause mit kleinem Rücksetzer, der zweite über das Extrem – Einstieg auf Fortsetzung.', 'Two impulses: the first, a short pause with a small pullback, the second beyond the extreme – continuation entry.'),
    L('ATR (размер импульса), глубина паузы, EMA 20/50 (подтверждение, включено).', 'ATR, Pausentiefe, EMA 20/50 (an).', 'ATR, pause depth, EMA 20/50 (on).')],
  neuro: [L('Обученная модель (логистическая регрессия) считает вероятность того, что следующая свеча закроется вверх. Сигнал только при уверенности выше порога. На проверке преимущества не нашла (около 50 %).', 'Trainiertes Modell (logistische Regression) schätzt die Wahrscheinlichkeit, dass die nächste Kerze steigt. Signal nur über der Schwelle. Im Test kein Vorteil (~50 %).', 'A trained model (logistic regression) estimates the chance the next candle closes up. Signal only above the threshold. No edge in the test (~50 %).'),
    L('EMA 9/21, SMA 20, RSI 14 и 7, ADX и DI, движение за 3 и 10 свечей, тело и тени, ATR к среднему, серия, шум. Периоды зашиты в модель — менять можно только порог.', 'EMA 9/21, SMA 20, RSI 14 und 7, ADX/DI, Bewegung 3/10 Kerzen, Körper, Dochte, ATR-Verhältnis, Serie, Rauschen. Perioden fest im Modell – nur die Schwelle ist einstellbar.', 'EMA 9/21, SMA 20, RSI 14 and 7, ADX/DI, 3/10-candle move, body, wicks, ATR ratio, streak, noise. Periods are fixed in the model – only the threshold can change.')],
};
DESC.smart_money_5m = DESC.smart_money;
const HELP_TITLE = [L('Как работает', 'So funktioniert es', 'How it works'), L('Индикаторы сигнала', 'Indikatoren des Signals', 'Signal indicators'), L('Логика по этапам', 'Logik in Stufen', 'Logic by stage')];
function helpFor(c) {
  const d = DESC[c.impl]; if (!d) return null;
  const stages = c.stages.map((x, n) => L(`${n + 1}. ${x.ru}`, `${n + 1}. ${x.de}`, `${n + 1}. ${x.en}`));
  return [{ title: L('Описание стратегии', 'Strategiebeschreibung', 'Strategy description'), body: [
    L(`${HELP_TITLE[0].ru}: ${d[0].ru}`, `${HELP_TITLE[0].de}: ${d[0].de}`, `${HELP_TITLE[0].en}: ${d[0].en}`),
    L(`${HELP_TITLE[1].ru}: ${d[1].ru}`, `${HELP_TITLE[1].de}: ${d[1].de}`, `${HELP_TITLE[1].en}: ${d[1].en}`),
    L(`${HELP_TITLE[2].ru}:`, `${HELP_TITLE[2].de}:`, `${HELP_TITLE[2].en}:`), ...stages,
    L('Все периоды индикаторов и пороги — в параметрах ниже. MACD в этой стратегии не используется.', 'Alle Indikatorperioden und Schwellen stehen in den Parametern unten. MACD wird hier nicht verwendet.', 'All indicator periods and thresholds are in the parameters below. MACD is not used here.'),
  ] }];
}

// ---------- adaptive timeframe (user 13.11.2026) ----------
// For the chart: which timeframe shows this pair's move most clearly right now. From closed M1 candles each candidate
// (M1, M2, M3, M5, M15) is built and rated on the last 20 candles:
//   structure  – efficiency ratio |net move| / sum of candle moves (1 = straight line, 0 = noise) and how many of the
//                last swing steps go the same way (higher highs + higher lows, or the mirror);
//   strength   – ADX 14 (25+ = trend) and +DI/−DI agreeing with the move;
//   volatility – ATR 14 of that timeframe vs its own 50-candle average (too calm < 0.6 or wild > 2 lowers the score).
// Score = 0.4 × structure + 0.35 × strength + 0.25 × volatility; ties go to the shorter timeframe. Needs ≥ 30 candles
// on the timeframe (≥ 20 for M15). The weights are judgement, not tested.
function adaptiveTf(m1, dirWanted) {
  const out = [];
  for (const m of [1, 2, 3, 5, 15]) {
    const c = m === 1 ? m1 : I.resample(m1, m, false);
    if (c.length < (m === 15 ? 20 : 30)) continue;
    const i = c.length - 1, n = 20, seg = c.slice(-n);
    const net = seg[n - 1].close - seg[0].open, path = seg.reduce((a, k) => a + Math.abs(k.close - k.open), 0);
    const er = path > 0 ? Math.abs(net) / path : 0, dir = net > 0 ? 1 : net < 0 ? -1 : 0;
    let steps = 0, same = 0;
    for (let j = 4; j < n; j += 4) { const a = seg.slice(j - 4, j), b = seg.slice(j, j + 4); if (!b.length) break; steps++;
      const hh = Math.max(...b.map(k => k.high)) > Math.max(...a.map(k => k.high)), hl = Math.min(...b.map(k => k.low)) > Math.min(...a.map(k => k.low));
      if (dir > 0 ? hh && hl : dir < 0 ? !hh && !hl : false) same++; }
    const structure = 0.6 * er + 0.4 * (steps ? same / steps : 0);
    const ad = I.adx(c, 14)[i], adx = ad ? ad.adx : 0, diOk = ad ? (ad.pdi > ad.mdi ? 1 : -1) === dir : false;
    const strength = Math.min(1, adx / 40) * (diOk ? 1 : 0.5);
    const atr = I.atr(c, 14); let s = 0, k = 0; for (let j = Math.max(14, i - 49); j <= i; j++) if (atr[j] > 0) { s += atr[j]; k++; }
    const ratio = k && atr[i] > 0 ? atr[i] / (s / k) : 1;
    const vol = ratio < 0.6 ? ratio / 0.6 : ratio > 2 ? Math.max(0, 1 - (ratio - 2)) : 1;
    let score = 0.4 * structure + 0.35 * strength + 0.25 * vol;
    if (dirWanted && dir && dir !== dirWanted) score *= 0.8; // the move on this timeframe goes against the signal
    out.push({ tf: 'M' + m, score: +score.toFixed(3), er: +er.toFixed(2), adx: +adx.toFixed(1), atrRatio: +ratio.toFixed(2), dir: dir > 0 ? 'UP' : dir < 0 ? 'DOWN' : 'FLAT', steps: `${same}/${steps}` });
  }
  if (!out.length) return null;
  const best = out.reduce((a, b) => (b.score > a.score + 0.02 ? b : a));
  const dirTxt = { UP: L('вверх', 'aufwärts', 'up'), DOWN: L('вниз', 'abwärts', 'down'), FLAT: L('боком', 'seitwärts', 'sideways') }[best.dir];
  const why = L(`${best.tf}: движение ${dirTxt.ru}, чистота ${Math.round(best.er * 100)} %, ступени ${best.steps}, ADX ${best.adx}, ATR ${best.atrRatio}× от среднего`,
    `${best.tf}: Bewegung ${dirTxt.de}, Sauberkeit ${Math.round(best.er * 100)} %, Stufen ${best.steps}, ADX ${best.adx}, ATR ${best.atrRatio}× vom Mittel`,
    `${best.tf}: move ${dirTxt.en}, clean ${Math.round(best.er * 100)} %, steps ${best.steps}, ADX ${best.adx}, ATR ${best.atrRatio}× of average`);
  return { tf: best.tf, score: best.score, why, all: out };
}

// ---------- risk ----------
const RISK_DEFAULTS = { risk_daily_loss_units: 3, risk_max_trades: 20, risk_max_losses: 4, risk_min_payout: 80, risk_stake_pct: 1 };
// Checks for a new signal before it is shown. signals = the engine's list (newest first).
function riskCheck(sig, signals, settings, payout) {
  const id = sig.strategy, now = Date.now(), dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const minPay = Number(settings.risk_min_payout ?? RISK_DEFAULTS.risk_min_payout);
  if (payout != null && payout < minPay) return { status: 'BLOCKED_BY_RISK', reason: 'min_payout' };
  const mine = signals.filter(s => s.strategy === id);
  const limit = Number(settings.daily_signal_limit ?? COMMON.daily_signal_limit);
  if (mine.filter(s => s.created >= dayStart.getTime()).length >= limit) return { status: 'BLOCKED_BY_RISK', reason: 'daily_signal_limit' };
  const cd = Number(settings.cooldown_candles ?? COMMON.cooldown_candles) * 60 * 1000;
  if (cd && mine.some(s => s.symbol === sig.asset && now - (s.created || 0) < cd)) return { status: 'BLOCKED_BY_RISK', reason: 'cooldown' };
  return null;
}
// Manual-trading limits from "My trades" (today, the chosen account): banner + dimmed cards.
function manualLimits(signals, settings, account) {
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const t = signals.filter(s => s.mine && s.trade && (s.trade.at || 0) * 1000 >= dayStart.getTime() && (account === 'REAL' ? !s.trade.demo : !!s.trade.demo));
  const res = s => s.trade.result || (s.manual ? s.result : null);
  let lossUnits = 0, streakL = 0;
  const done = t.filter(res).sort((a, b) => a.trade.at - b.trade.at);
  for (const s of done) { const r = res(s); if (r === 'LOSS') { lossUnits += 1; streakL++; } else if (r === 'WIN') { lossUnits -= (s.payout || 80) / 100; streakL = 0; } }
  const g = k => Number(settings[k] ?? RISK_DEFAULTS[k]);
  const lim = { loss: g('risk_daily_loss_units'), trades: g('risk_max_trades'), streak: g('risk_max_losses') };
  const cur = { loss: Math.max(0, lossUnits), trades: t.length, streak: streakL };
  const hit = cur.loss >= lim.loss ? 'daily_loss_limit' : cur.trades >= lim.trades ? 'max_trades' : cur.streak >= lim.streak ? 'loss_streak' : null;
  return { cur, lim, hit };
}

// ---------- statistics per strategy (Signals / My trades demo / real / Paper), OTC and FOREX apart ----------
function statsFor(signals) {
  const out = {};
  const add = (key, bucket, r) => { const o = (out[key] ||= {}); const b = (o[bucket] ||= { w: 0, n: 0, last: [] }); if (r === 'WIN' || r === 'LOSS') { b.n++; if (r === 'WIN') b.w++; if (b.last.length < 50) b.last.push(r === 'WIN' ? 1 : 0); } };
  for (const s of signals) {
    if (s.manual) continue; const key = s.strategy;
    if (s.result) add(key, 'signals', s.result);
    if (s.paper && s.paper.result) add(key, 'paper', s.paper.result);
    if (s.mine && s.trade && s.trade.result) add(key, s.trade.demo === false ? 'mine_real' : 'mine_demo', s.trade.result);
  }
  return out;
}

module.exports = { helpFor, _neuroFeatures: neuroFeatures, SECOND_TF, PARAM_LABELS, adaptiveTf, setStale, setupKey, backtest, CATALOG, BY_ID, PARAMS, COMMON, EXPIRY_SEC, STRAT, run, wilson, breakEven, ev, verdict, riskCheck, manualLimits, statsFor, lastDecisions, RISK_DEFAULTS, VERSION, T };
