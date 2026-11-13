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
  impulse_bot_forex: [1926, 976, 751, 365], range_bot_forex: [378, 196, 170, 96], fractal_bot_forex: [420, 193, 196, 98], overheat_bot_forex: [161, 76, 81, 42],
  impulse_bot_otc: [2080, 1057, 798, 383], range_bot_otc: [378, 196, 170, 96], fractal_bot_otc: [420, 193, 196, 98], trap_bot_otc: [5443, 2689, 2321, 1170], overheat_bot_otc: [204, 96, 102, 51],
};
for (const [id, [isN, isW, oosN, oosW]] of Object.entries(BACKTEST)) BY_ID_TMP(id).backtest = { date: '2026-11-13', data: '12 forex pairs × 20 000 M1', is: { n: isN, w: isW }, oos: { n: oosN, w: oosW } };
function BY_ID_TMP(id) { return CATALOG.find(c => c.id === id); }

// Default parameters (all "strong/narrow" words are numbers here; user changes go through the parameter journal).
const PARAMS = {
  impulse: { accel_range_atr: 1.5, min_directional_closes: 2, prev_range_atr: 1.0, max_opposite_wick_pct: 30, min_level_distance_atr: 0.5, exhaustion_streak: 5, rsi_hi: 85, rsi_lo: 15, forex_close_extreme_pct: 25 },
  range: { window: 30, touch_tol_atr: 0.15, min_touches: 2, width_min_atr: 2, width_max_atr: 6, max_slope_atr: 0.05, zone_pct: 15, break_body_atr: 0.8, rejection_wick_pct: 50 },
  fractal: { min_amp_atr: 0.3, level_tol_atr: 0.15, min_reactions: 2, room_atr: 1.0, break_atr: 0.2, lookback: 60 },
  trap: { lookback: 20, poke_min_atr: 0.1, poke_max_atr: 0.6, body_pct: 40 },
  overheat: { z_period: 20, z_level: 2.5, extreme_window: 20, wick_pct: 50, atr_pct_lo: 20, atr_pct_hi: 80, forex_adx: 30 },
};
const COMMON = { cooldown_candles: 2, daily_signal_limit: 20 };
const EXPIRY_SEC = { impulse: 60, range: 60, fractal: 120, trap: 60, overheat: 60 };

// ---------- reason / reject texts (3 languages, numbers filled in) ----------
const T = {
  wrong_asset_type: v => L(`актив ${v.t}, стратегия только для ${v.want}`, `Asset ${v.t}, Strategie nur für ${v.want}`, `asset is ${v.t}, strategy is for ${v.want} only`),
  stale: v => L(`данные устарели: ${v.s} с`, `Daten veraltet: ${v.s} s`, `stale data: ${v.s} s`),
  no_data: v => L(`мало свечей (${v.n})`, `zu wenige Kerzen (${v.n})`, `not enough candles (${v.n})`),
  no_acceleration: v => L(`диапазон ${v.r}×ATR < ${v.min}`, `Spanne ${v.r}×ATR < ${v.min}`, `range ${v.r}×ATR < ${v.min}`),
  price_acceleration: v => L(`диапазон свечи ${v.r}×ATR`, `Kerzenspanne ${v.r}×ATR`, `candle range ${v.r}×ATR`),
  closes_not_aligned: v => L(`по направлению ${v.k} из 3 закрытий`, `${v.k} von 3 Schlüssen in Richtung`, `${v.k} of 3 closes in direction`),
  momentum_confirmed: v => L(`${v.k} из 3 закрытий по направлению`, `${v.k} von 3 Schlüssen in Richtung`, `${v.k} of 3 closes in direction`),
  single_spike: v => L(`одиночный всплеск: прошлая свеча ${v.r}×ATR`, `Einzelspitze: Vorkerze ${v.r}×ATR`, `single spike: previous candle ${v.r}×ATR`),
  opposite_wick: v => L(`противоположная тень ${v.w} %`, `Gegendocht ${v.w} %`, `opposite wick ${v.w} %`),
  level_too_close: v => L(`до уровня ${v.d}×ATR`, `bis zum Level ${v.d}×ATR`, `level only ${v.d}×ATR away`),
  exhaustion: v => L(`истощение: ${v.s} свечей подряд, RSI 7 = ${v.r}`, `Erschöpfung: ${v.s} Kerzen in Folge, RSI 7 = ${v.r}`, `exhaustion: ${v.s} candles in a row, RSI 7 = ${v.r}`),
  no_exhaustion: v => L(`истощения нет (серия ${v.s}, RSI 7 = ${v.r})`, `keine Erschöpfung (Serie ${v.s}, RSI 7 = ${v.r})`, `no exhaustion (streak ${v.s}, RSI 7 = ${v.r})`),
  close_not_extreme: v => L(`закрытие не в крайних ${v.p} % (${v.x} %)`, `Schluss nicht in äußeren ${v.p} % (${v.x} %)`, `close not in the outer ${v.p} % (${v.x} %)`),
  no_range: v => L(`нет диапазона: ${v.why}`, `keine Range: ${v.why}`, `no range: ${v.why}`),
  range_found: v => L(`диапазон ${v.w}×ATR, касаний ${v.a}/${v.b}`, `Range ${v.w}×ATR, Berührungen ${v.a}/${v.b}`, `range ${v.w}×ATR, touches ${v.a}/${v.b}`),
  at_bound: v => L(`цена у  границы, пробоя нет`, `Preis an der  Grenze, kein Ausbruch`, `price at the  bound, no breakout`),
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

// ---------- the five logics ----------
// Each returns { dir, score, stage results, reasons/rejects with numbers }. A failed stage ends the run.
function run(logic, c, p, asset) {
  const i = c.length - 1, atrA = I.atr(c, 14), a = atrA[i], out = { stages: ['SKIPPED', 'SKIPPED', 'SKIPPED'], reasons: [], rejects: [], feats: {} };
  const fail = (st, code, v = {}) => { out.stages[st] = 'FAIL'; out.rejects.push({ code, v }); out.status = 'NO_TRADE'; out.stage = st + 1; return out; };
  const pass = (st, code, v = {}) => { out.stages[st] = 'PASS'; out.reasons.push({ code, v }); };
  if (c.length < 60 || !(a > 0)) { out.status = 'NO_DATA'; out.rejects.push({ code: 'no_data', v: { n: c.length } }); out.stage = 0; return out; }
  const k = c[i];
  out.feats.atr = a;
  if (logic === 'impulse') {
    const r = rng(k) / a, d = dirOf(k); out.feats.range_atr = r;
    if (r < p.accel_range_atr || !d) return fail(0, 'no_acceleration', { r: f1(r), min: p.accel_range_atr });
    let same = 0; for (let j = i - 2; j <= i; j++) if (dirOf(c[j]) === d) same++;
    if (same < p.min_directional_closes) return fail(0, 'closes_not_aligned', { k: same });
    pass(0, 'price_acceleration', { r: f1(r) }); out.dir = d;
    const pr = rng(c[i - 1]) / a, ow = oppWickPct(k, d), lv = levelAhead(c, i, d, k.close, a), st = streak(c, i), rs = I.rsi(c.map(x => x.close), 7)[i] || 50;
    Object.assign(out.feats, { prev_range_atr: pr, opp_wick_pct: ow, level_atr: lv, streak: st, rsi7: rs });
    if (pr < p.prev_range_atr) return fail(1, 'single_spike', { r: f1(pr) });
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
    const e = I.ema(c.map(x => x.close), 20), slope = Math.abs(e[i - 1] - e[i - 6]) / 5 / a;
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
    const pc = atrPct(atrA, i); out.feats.atr_pct = pc;
    if (pc === null) return fail(2, 'no_data', { n: c.length });
    if (pc < p.atr_pct_lo || pc > p.atr_pct_hi) return fail(2, 'atr_out_of_band', { p: f0(pc), lo: p.atr_pct_lo, hi: p.atr_pct_hi });
    if (p.forex) { const ad = I.adx(c, 14)[i]; if (ad && ad.adx > p.forex_adx && (ad.pdi > ad.mdi ? 1 : -1) !== d) return fail(2, 'strong_trend_against', { a: f0(ad.adx) }); }
    pass(2, 'atr_ok', { p: f0(pc) }); out.dir = d;
    out.score = Math.round(55 + 20 * Math.min(1, (Math.abs(zz) - 2.5) / 1) + 25 * Math.min(1, (wick - 50) / 40));
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
    const age = Date.now() / 1000 - (x.c[x.last].time + 60);
    if (STALE.sec > 0 && age > STALE.sec) { note(s.id, asset, { status: 'STALE_DATA', stage: 0, rejects: [{ code: 'stale', v: { s: f1(age) } }] }); return null; }
    const p = { ...PARAMS[s.impl], ...(user || {}), forex };
    const r = run(s.impl, x.c, p, asset);
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
  const p = { ...PARAMS[s.impl], ...(opt.params || {}), forex: s.asset_type === 'FOREX' };
  const expC = Math.max(1, Math.round((opt.expirySec || EXPIRY_SEC[s.impl]) / 60)), payout = opt.payout ?? 0.8, win = opt.window || 300;
  const cut = Math.floor(c.length * (opt.isShare ?? 0.7)), trades = [];
  let next = 0;
  for (let i = 210; i < c.length - expC - 1; i++) {
    if (i < next) continue;
    const r = run(s.impl, c.slice(Math.max(0, i - win + 1), i + 1), p);
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

module.exports = { setStale, setupKey, backtest, CATALOG, BY_ID, PARAMS, COMMON, EXPIRY_SEC, STRAT, run, wilson, breakEven, ev, verdict, riskCheck, manualLimits, statsFor, lastDecisions, RISK_DEFAULTS, VERSION, T };
