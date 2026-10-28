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
  n_levelrev: [L('Разворот от уровня (пин-бар / V-разворот)', 'Umkehr am Level (Pinbar / V-Umkehr)', 'Reversal at a level (pin bar / V-turn)'), 'rev'],
  n_vrev: [L('V-разворот (без уровней)', 'V-Umkehr (ohne Levels)', 'V-reversal (no levels)'), 'rev'],
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
  // Reversal at a level (user's prompt of 28.10.2026): structure first (support/resistance from the history), the side
  // decides the direction (at resistance only PUT, at support only CALL), then model A (pin bar from the level) or
  // model B (vertical impulse into the level → big opposite candle). SD = average candle range of lr_sd_period candles.
  n_levelrev: { expiry: 60, lr_min_strength: 4, lr_model_a: true, lr_model_b: true, lr_buy: true, lr_sell: true,
    lr_use_corridor: true, lr_use_beyond: true, lr_use_flat: true, lr_use_space: true,
    lr_a_prior: true, lr_a_touch: true, lr_a_tail: true, lr_a_body: true, lr_a_nose: true, lr_a_size: true,
    lr_b_count: true, lr_b_move: true, lr_b_avgbody: true, lr_b_steps: true, lr_b_zone: true, lr_b_body: true, lr_b_cover: true,
    lr_sd_period: 20, lr_lvl_len: 50, lr_lvl_skip: 2, lr_min_touches: 2, lr_zone_sd: 1, lr_zone_pad: 0.25, lr_near_sd: 1.5, lr_corridor_sd: 3,
    lr_space_sd: 2, lr_flat_bars: 10, lr_flat_sd: 2,
    lr_prior_bars: 2, lr_tail_pct: 60, lr_body_pct: 30, lr_nose_pct: 15, lr_pin_min_sd: 1,
    lr_imp_min: 3, lr_imp_max: 6, lr_imp_move_sd: 3, lr_vbody_pct: 60, lr_b_early: false, lr_b_early_pct: 60 },
  // V-reversal anywhere (model B of n_levelrev without the levels): a vertical run of candles, then a big candle against it.
  // Default = the user's examples: one big candle, then an opposite one at least as big (spike). The multi-candle run is
  // still possible (vr_imp_min > 1) but gave signals the user called junk.
  n_vrev: { expiry: 120, vr_buy: true, vr_sell: true, vr_min_bp: 1, vr_sd_period: 20, vr_imp_min: 1, vr_imp_max: 1, vr_move_sd: 0,
    vr_avgbody: false, vr_steps: false, vr_body_pct: 55, vr_cover: true, vr_extreme: 0, vr_last_big: 1.5, vr_answer_pct: 100,
    vr_spike: true, vr_swing: false, vr_swing_bars: 8, vr_tip_bars: 3, vr_w_move: 3, vr_w_extreme: 10, vr_w_body_pct: 50, vr_rev_big: 1 },
  n_ma25: { m25_expiry: 120, ...FILTERS, no_countertrend: false, room_check: false, room_min: 1, m25_fast: 2, m25_slow: 5, m25_fast_type: 'SMA', m25_slow_type: 'SMA', m25_buy: true, m25_sell: true, m25_vol: 0,
    m25_quiet: 0, m25_gap: 0, m25_trend: 0, m25_body: 0, m25_rsi: false, m25_rsi_max: 70 },
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
  ma4813: { ...TREND, min_adx: 15, ma3_fast: 4, ma3_mid: 8, ma3_slow: 13, ma3_type: 'EMA' },
};

// Ready-made setting combinations (one tap in the app).
const PRESETS = {
  // Level 3 = exactly the user's prompt. Measured 28.10.2026 on 17 pairs / ~1.5 h: strict 0–2, medium ~8, soft ~14 signals.
  n_levelrev: [
    { name: L('Мягко', 'Locker', 'Loose'), values: { lr_min_strength: 4, lr_min_touches: 2, lr_near_sd: 2, lr_space_sd: 1.5, lr_corridor_sd: 2,
      lr_flat_sd: 1.5, lr_prior_bars: 1, lr_tail_pct: 50, lr_body_pct: 35, lr_nose_pct: 25, lr_pin_min_sd: 0.7,
      lr_imp_min: 2, lr_imp_move_sd: 2, lr_vbody_pct: 50 } },
    { name: L('Средне', 'Mittel', 'Medium'), values: { lr_min_strength: 4, lr_min_touches: 2, lr_near_sd: 1.5, lr_space_sd: 2, lr_corridor_sd: 3,
      lr_flat_sd: 2, lr_prior_bars: 1, lr_tail_pct: 50, lr_body_pct: 35, lr_nose_pct: 25, lr_pin_min_sd: 0.7,
      lr_imp_min: 2, lr_imp_move_sd: 2, lr_vbody_pct: 50 } },
    { name: L('Строго (как в промте)', 'Streng (wie im Prompt)', 'Strict (as in the prompt)'), values: { lr_min_strength: 4, lr_min_touches: 2,
      lr_near_sd: 1.5, lr_space_sd: 2, lr_corridor_sd: 3, lr_flat_sd: 2, lr_prior_bars: 2, lr_tail_pct: 60, lr_body_pct: 30, lr_nose_pct: 15,
      lr_pin_min_sd: 1, lr_imp_min: 3, lr_imp_move_sd: 3, lr_vbody_pct: 60 } },
  ],
  // V-reversal, measured 28.10.2026 (17 OTC pairs, 2 h, M1): loose 35 signals 63 %, medium 17 / 71 %, strict 13 / 69 % at 2 min
  // (1 min ~56 %, 3 min ~53 % – the bounce is short, so expiry 120 s).
  n_vrev: [
    { name: L('Шип мягко (обратная ≥ 80 %)', 'Spitze locker (Gegenkerze ≥ 80 %)', 'Spike loose (opposite ≥ 80 %)'),
      values: { expiry: 120, vr_min_bp: 1, vr_imp_min: 1, vr_imp_max: 1, vr_move_sd: 0, vr_body_pct: 55, vr_steps: false, vr_avgbody: false, vr_extreme: 0, vr_cover: true, vr_last_big: 1.5, vr_answer_pct: 80 } },
    { name: L('Шип строго (свеча ≥ 2× средней)', 'Spitze streng (Kerze ≥ 2× Durchschnitt)', 'Spike strict (candle ≥ 2× average)'),
      values: { expiry: 120, vr_min_bp: 1, vr_imp_min: 1, vr_imp_max: 1, vr_move_sd: 0, vr_body_pct: 60, vr_steps: false, vr_avgbody: false, vr_extreme: 0, vr_cover: true, vr_last_big: 2, vr_answer_pct: 100 } },
    // Wave turn (user's CHF/NOK example on M2): catches the visible turns 19:54 PUT and 20:08 CALL, but measured on all
    // pairs it lost on M1 (41 signals, 39–46 %); on M2 only 5 signals (75 % at 1 candle) – too few to trust.
    { name: L('Шип + волна (оба режима)', 'Spitze + Welle (beide Modi)', 'Spike + wave (both modes)'),
      values: { expiry: 120, vr_min_bp: 1, vr_spike: true, vr_imp_min: 1, vr_imp_max: 1, vr_move_sd: 0, vr_body_pct: 55, vr_steps: false, vr_avgbody: false, vr_extreme: 0,
        vr_cover: true, vr_last_big: 1.5, vr_answer_pct: 100, vr_swing: true, vr_swing_bars: 8, vr_tip_bars: 3, vr_w_move: 3, vr_w_extreme: 10, vr_w_body_pct: 50, vr_rev_big: 1 } },
    // The user's examples (USD/COP, CHF/JPY): one big candle (≥ 1.5 × average), right after it an opposite one at least as
    // big; anywhere, also inside a trend. Measured: 13 signals in 2 h on 17 pairs, 62 % / 85 % / 85 % at 1 / 2 / 3 min.
    { name: L('Шип (большая свеча → такая же обратная)', 'Spitze (große Kerze → gleich große Gegenkerze)', 'Spike (big candle → equally big opposite)'),
      values: { expiry: 120, vr_imp_min: 1, vr_imp_max: 1, vr_move_sd: 0, vr_body_pct: 55, vr_steps: false, vr_avgbody: false, vr_extreme: 0, vr_cover: true, vr_last_big: 1.5, vr_answer_pct: 100 } },
  ],
  // MA 2/5: fewer and better crosses. Measured 28.10.2026 (17 OTC pairs, 90 min, 2 min expiry): only "calm before" raised
  // the win rate (none 291 signals 52 %, 8 → 53 / 56 %, 10 → 33 / 72 %, 12 → 17 / 81 %); trend EMA, RSI, body, ADX did not.
  n_ma25: [
    { name: L('Мягко', 'Locker', 'Loose'), values: { m25_quiet: 8, m25_gap: 0, m25_trend: 0, m25_body: 0, m25_rsi: false, m25_vol: 0, min_adx: 0, room_check: false } },
    { name: L('Средне', 'Mittel', 'Medium'), values: { m25_quiet: 10, m25_gap: 0, m25_trend: 0, m25_body: 0, m25_rsi: false, m25_vol: 0, min_adx: 0, room_check: false } },
    { name: L('Строго', 'Streng', 'Strict'), values: { m25_quiet: 12, m25_gap: 0, m25_trend: 0, m25_body: 0, m25_rsi: false, m25_vol: 0, min_adx: 0, room_check: false } },
  ],
};

// Settings shown in blocks: each block says what it decides and which way is stricter. Keys not listed go to the end.
const GROUPS = {
  n_levelrev: [
    { title: L('1 · Основное', '1 · Grundlegendes', '1 · Basics'),
      desc: L('Направления, модели и минимальная сила. Сила 5 = только самые сильные сигналы (меньше, но качественнее).',
        'Richtungen, Modelle und Mindeststärke. Stärke 5 = nur die stärksten Signale (weniger, aber besser).',
        'Directions, models and minimum strength. Strength 5 = only the strongest signals (fewer, better).'),
      keys: ['expiry', 'lr_min_strength', 'lr_buy', 'lr_sell', 'lr_model_a', 'lr_model_b'] },
    { title: L('2 · Уровни', '2 · Levels', '2 · Levels'),
      desc: L('Как ищутся поддержка и сопротивление. SD = средний размер свечи. Больше касаний = надёжнее уровни, меньше сигналов. «Близко к уровню» меньше = цена должна подойти вплотную.',
        'Wie Unterstützung und Widerstand gefunden werden. SD = durchschnittliche Kerzengröße. Mehr Berührungen = verlässlichere Levels, weniger Signale. „Nähe zum Level“ kleiner = Preis muss ganz heran.',
        'How support and resistance are found. SD = average candle size. More touches = more reliable levels, fewer signals. Smaller "near level" = price must come right up to it.'),
      keys: ['lr_sd_period', 'lr_lvl_len', 'lr_lvl_skip', 'lr_min_touches', 'lr_zone_sd', 'lr_zone_pad', 'lr_near_sd'] },
    { title: L('3 · Запреты (где не торговать)', '3 · Verbote (wo nicht handeln)', '3 · Bans (where not to trade)'),
      desc: L('Отсекают плохие места: узкий коридор между уровнями, закрытие за уровнем, флэт, нет места до противоположного уровня. Включено = строже. Чем больше числа, тем строже.',
        'Sortieren schlechte Stellen aus: enger Korridor, Schluss hinter dem Level, Seitwärtsphase, kein Platz bis zum Gegenlevel. Ein = strenger. Größere Zahlen = strenger.',
        'Drop bad spots: narrow corridor, close beyond the level, flat market, no room to the opposite level. On = stricter. Bigger numbers = stricter.'),
      keys: ['lr_use_corridor', 'lr_corridor_sd', 'lr_use_beyond', 'lr_use_flat', 'lr_flat_bars', 'lr_flat_sd', 'lr_use_space', 'lr_space_sd'] },
    { title: L('4 · Модель A — пин-бар от уровня', '4 · Modell A — Pinbar am Level', '4 · Model A — pin bar at the level'),
      desc: L('Свеча с длинной тенью, которая коснулась уровня и отбилась. Строже: тень % больше, тело % меньше, «нос» % меньше, размер больше.',
        'Kerze mit langem Docht, die das Level berührt und abprallt. Strenger: Docht % größer, Körper % kleiner, „Nase“ % kleiner, Größe größer.',
        'Candle with a long wick that touched the level and bounced. Stricter: bigger wick %, smaller body %, smaller "nose" %, bigger size.'),
      keys: ['lr_a_prior', 'lr_prior_bars', 'lr_a_touch', 'lr_a_tail', 'lr_tail_pct', 'lr_a_body', 'lr_body_pct', 'lr_a_nose', 'lr_nose_pct', 'lr_a_size', 'lr_pin_min_sd'] },
    { title: L('5 · Модель B — V-разворот', '5 · Modell B — V-Umkehr', '5 · Model B — V-reversal'),
      desc: L('Вертикальное движение в уровень, затем большая свеча в обратную сторону. Строже: больше свечей импульса, больше движение (SD), тело разворотной свечи % больше.',
        'Senkrechte Bewegung ins Level, dann große Gegenkerze. Strenger: mehr Impulskerzen, größere Bewegung (SD), größerer Körper % der Umkehrkerze.',
        'Vertical move into the level, then a big opposite candle. Stricter: more impulse candles, bigger move (SD), bigger body % of the reversal candle.'),
      keys: ['lr_b_count', 'lr_imp_min', 'lr_imp_max', 'lr_b_move', 'lr_imp_move_sd', 'lr_b_avgbody', 'lr_b_steps', 'lr_b_zone', 'lr_b_body', 'lr_vbody_pct', 'lr_b_cover'] },
    { title: L('6 · Ранний вход', '6 · Früher Einstieg', '6 · Early entry'),
      desc: L('Сигнал по модели B ещё до закрытия свечи. Раньше вход, но больше ложных сигналов. Для качества — выключить.',
        'Signal nach Modell B schon vor dem Kerzenschluss. Früherer Einstieg, aber mehr Fehlsignale. Für Qualität aus.',
        'Model B signal before the candle closes. Earlier entry, more false signals. Off for quality.'),
      keys: ['lr_b_early', 'lr_b_early_pct'] },
  ],
  n_vrev: [
    { title: L('1 · Основное', '1 · Grundlegendes', '1 · Basics'),
      desc: L('Направления и экспирация. По замеру лучше всего 2 минуты (120 с): отскок короткий.', 'Richtungen und Ablaufzeit. Gemessen am besten 2 Minuten (120 s): der Rücksprung ist kurz.', 'Directions and expiry. Measured best at 2 minutes (120 s): the bounce is short.'),
      keys: ['expiry', 'vr_buy', 'vr_sell', 'vr_min_bp', 'vr_spike', 'vr_swing'] },
    { title: L('Режим «волна»', 'Modus „Welle“', '"Wave" mode'),
      desc: L('Работает вместе с шипом (оба переключателя в блоке 1). Волна из нескольких свечей (могут быть разного цвета) прошла ход в SD к новому экстремуму, и первая сильная свеча разворачивает. По замеру на M1 проигрывала, на M2 сигналов пока мало для вывода.',
        'Läuft zusammen mit der Spitze (beide Schalter in Block 1). Eine Welle aus mehreren Kerzen (auch gemischt) läuft … SD zu einem neuen Extrem, die erste starke Kerze dreht. Gemessen auf M1 verlustreich, auf M2 noch zu wenige Signale.',
        'Runs together with the spike (both switches in block 1). A wave of several candles (mixed colours allowed) runs … SD to a new extreme, the first strong candle turns. Measured: losing on M1, too few signals on M2 yet.'),
      keys: ['vr_w_move', 'vr_w_extreme', 'vr_swing_bars', 'vr_tip_bars', 'vr_w_body_pct', 'vr_rev_big'] },
    { title: L('2 · Импульс (вертикаль)', '2 · Impuls (senkrecht)', '2 · Impulse (vertical)'),
      desc: L('Резкое движение перед разворотом: сколько свечей подряд и насколько далеко (в SD — средних свечах). Больше = реже, но движение сильнее. «Ровные шаги»: каждая свеча закрывается дальше предыдущей. «Крупнее среднего»: тела импульса больше обычных.',
        'Die steile Bewegung vor der Umkehr: wie viele Kerzen in Folge und wie weit (in SD = Durchschnittskerzen). Größer = seltener, aber stärker. „Saubere Schritte“: jede Kerze schließt weiter. „Größer als normal“: Impulskörper größer als üblich.',
        'The steep move before the turn: how many candles in a row and how far (in SD = average candles). Bigger = rarer but stronger. "Clean steps": each candle closes further. "Bigger than average": impulse bodies above normal.'),
      keys: ['vr_imp_min', 'vr_imp_max', 'vr_move_sd', 'vr_sd_period', 'vr_steps', 'vr_avgbody', 'vr_extreme'] },
    { title: L('3 · Свеча разворота', '3 · Umkehrkerze', '3 · Reversal candle'),
      desc: L('Большая свеча против импульса. Тело % от всей свечи: больше = решительнее разворот. «Перекрывает»: больше последней свечи импульса или закрывается за её серединой. «Шип»: последняя свеча импульса крупная (× средней) и свеча разворота отвечает ей телом не меньше X % — как на картинке «большая вверх → большая вниз».',
        'Große Kerze gegen den Impuls. Körper % der ganzen Kerze: größer = entschlossener. „Überdeckt“: größer als die letzte Impulskerze oder schließt hinter deren Mitte. „Spitze“: letzte Impulskerze groß (× Durchschnitt), Umkehrkerze antwortet mit mindestens X % ihres Körpers.',
        'Big candle against the impulse. Body % of the whole candle: bigger = more decisive. "Covers": bigger than the last impulse candle or closes past its middle. "Spike": last impulse candle big (× average), the reversal candle answers with at least X % of its body.'),
      keys: ['vr_body_pct', 'vr_cover', 'vr_last_big', 'vr_answer_pct'] },
  ],
  n_ma25: [
    { title: L('1 · Основное', '1 · Grundlegendes', '1 · Basics'),
      desc: L('Какие средние пересекаются, направления и экспирация.', 'Welche Durchschnitte sich kreuzen, Richtungen und Ablaufzeit.', 'Which averages cross, directions and expiry.'),
      keys: ['m25_expiry', 'm25_fast', 'm25_fast_type', 'm25_slow', 'm25_slow_type', 'm25_buy', 'm25_sell'] },
    { title: L('2 · Против пилы', '2 · Gegen Sägezahn', '2 · Against the saw'),
      desc: L('Главное против «бешеного потока». «Спокойно перед»: столько свечей линии не пересекались — убирает пилу во флэте. «Сила пересечения» (ATR): быстрая линия уже ушла от медленной, а не просто коснулась. Больше = меньше сигналов, но чище.',
        'Das Wichtigste gegen die Signalflut. „Ruhe davor“: so viele Kerzen ohne Kreuzung – entfernt das Hin und Her in Seitwärtsphasen. „Stärke der Kreuzung“ (ATR): die schnelle Linie ist schon weg von der langsamen. Größer = weniger, aber sauberer.',
        'Main tool against the flood. "Calm before": that many candles without a cross – removes the saw in flat markets. "Cross strength" (ATR): the fast line is already away from the slow one. Bigger = fewer but cleaner.'),
      keys: ['m25_quiet', 'm25_gap', 'm25_vol', 'flat_pips'] },
    { title: L('3 · По тренду', '3 · Mit dem Trend', '3 · With the trend'),
      desc: L('Сигнал только по направлению большого движения: цена с правильной стороны EMA (обычно 50) и EMA смотрит туда же. ADX — сила тренда (20+ = есть тренд). 0 = выкл.',
        'Signal nur in Richtung der großen Bewegung: Preis auf der richtigen Seite der EMA (meist 50), die EMA zeigt dorthin. ADX = Trendstärke (20+ = Trend). 0 = aus.',
        'Only in the direction of the bigger move: price on the right side of the EMA (usually 50) and the EMA pointing that way. ADX = trend strength (20+ = trend). 0 = off.'),
      keys: ['m25_trend', 'min_adx', 'max_adx', 'no_countertrend'] },
    { title: L('4 · Подтверждение', '4 · Bestätigung', '4 · Confirmation'),
      desc: L('Свеча сигнала уже идёт в сторону сигнала с телом не меньше X % (40–60). RSI выше 50 для CALL / ниже 50 для PUT, но не перегрет (макс. 70) — чтобы не входить на самом конце движения.',
        'Die Signalkerze läuft schon in Signalrichtung, Körper mindestens X % (40–60). RSI über 50 für CALL / unter 50 für PUT, aber nicht überhitzt (max. 70) – kein Einstieg am Ende der Bewegung.',
        'The signal candle already moves the signal way with a body of at least X % (40–60). RSI above 50 for CALL / below 50 for PUT but not overheated (max 70) – no entry at the end of the move.'),
      keys: ['m25_body', 'm25_rsi', 'm25_rsi_max'] },
    { title: L('5 · Место до уровня', '5 · Platz bis zum Level', '5 · Room to the level'),
      desc: L('Не входить прямо в уровень: до ближайшего уровня должно быть хотя бы столько средних свечей. Больше = строже.',
        'Nicht direkt in ein Level einsteigen: bis zum nächsten Level mindestens so viele Durchschnittskerzen. Größer = strenger.',
        'No entry straight into a level: at least that many average candles of room. Bigger = stricter.'),
      keys: ['room_check', 'room_min'] },
  ],
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
  // Only the last fully closed candle counts – unless the early V-reversal is on (then also inside the forming candle).
  if (name === 'n_levelrev') return p.lr_b_early ? 'both' : 'closed';
  if (name === 'n_vrev') return 'closed';
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
  n_levelrev(x, p) {
    // Diagnosis: a test sets globalThis.__lrWhy = [] to collect why there was no signal.
    const no = why => { if (globalThis.__lrWhy) globalThis.__lrWhy.push(why); return null; };
    const c = x.c, i = x.last, k = c[i], N = Number(p.lr_sd_period) || 20, len = Number(p.lr_lvl_len) || 50;
    if (i < len + 5) return no('history');
    const rng = j => c[j].high - c[j].low, bod = j => Math.abs(c[j].close - c[j].open);
    let sd = 0, ab = 0; for (let j = i - N + 1; j <= i; j++) { sd += rng(j); ab += bod(j); } sd /= N; ab /= N;
    if (!(sd > 0)) return no('sd');
    // --- Step 1: structure. Levels only from the history before the last lr_lvl_skip candles (a level must already exist).
    const from = i - len, to = i - Number(p.lr_lvl_skip ?? 2) - 1, zoneW = (Number(p.lr_zone_sd) || 1) * sd;
    const zones = (side) => {
      const pts = [];
      for (let j = from + 2; j <= to - 2; j++) {
        const v = side > 0 ? c[j].high : c[j].low;
        let ok = true; for (let q = j - 2; q <= j + 2; q++) if (q !== j && (side > 0 ? c[q].high > v : c[q].low < v)) ok = false;
        if (ok) pts.push(v);
      }
      pts.sort((a, b) => a - b);
      const out = [];
      for (const v of pts) { const z = out[out.length - 1]; if (z && v - z.lo <= zoneW) { z.hi = v; z.n++; } else out.push({ lo: v, hi: v, n: 1 }); }
      // The extreme of the whole stretch also counts as a level.
      let ext = side > 0 ? -Infinity : Infinity; for (let j = from; j <= to; j++) ext = side > 0 ? Math.max(ext, c[j].high) : Math.min(ext, c[j].low);
      const minT = Number(p.lr_min_touches) || 2;
      // A level is a zone, not one price: widen it by lr_zone_pad × SD on both sides (a close one pip past it is still "at" it).
      const pad = Number(p.lr_zone_pad ?? 0.25) * sd;
      return out.filter(z => z.n >= minT).concat([{ lo: ext, hi: ext, n: 1, ext: true }]).map(z => ({ ...z, rlo: z.lo, rhi: z.hi, lo: z.lo - pad, hi: z.hi + pad })); // rlo/rhi: the level itself
    };
    const close = k.close;
    const res = zones(1).filter(z => z.hi >= close - zoneW).sort((a, b) => a.lo - b.lo)[0];      // nearest above (or at) the price
    const sup = zones(-1).filter(z => z.lo <= close + zoneW).sort((a, b) => b.hi - a.hi)[0];     // nearest below (or at)
    const near = Number(p.lr_near_sd ?? 1.5) * sd;
    let atRes = !!res && (k.high >= res.lo || res.lo - close <= near);
    let atSup = !!sup && (k.low <= sup.hi || close - sup.hi <= near);
    // Every filter can be switched off (lr_use_* / lr_a_* / lr_b_*: false); only the levels and the side stay.
    const on = key => p[key] !== false;
    if (on('lr_use_corridor') && res && sup && res.rlo - sup.rhi < (Number(p.lr_corridor_sd) || 3) * sd) return no('corridor');
    // Both "near" (happens with loose settings): the level the candle really touched wins, otherwise the closer one.
    if (atRes && atSup) {
      const tRes = k.high >= res.lo, tSup = k.low <= sup.hi;
      if (tRes !== tSup) { atRes = tRes; atSup = tSup; }
      else if (res.lo - close < close - sup.hi) atSup = false; else atRes = false;
    }
    // --- Step 2: allowed direction from the place.
    if (!atRes && !atSup) return no('middle');                                                           // middle
    const dir = atSup ? 1 : -1, lvl = dir > 0 ? sup : res;
    if ((dir > 0 && p.lr_buy === false) || (dir < 0 && p.lr_sell === false)) return no('side_off');
    // Bans: closed beyond the level without coming back; flat market.
    if (on('lr_use_beyond') && (dir > 0 ? close < lvl.lo : close > lvl.hi)) return no('beyond_level');
    if (on('lr_use_flat')) {
      const fb = Number(p.lr_flat_bars) || 10;
      let fh = -Infinity, fl = Infinity; for (let j = i - fb + 1; j <= i; j++) { fh = Math.max(fh, c[j].high); fl = Math.min(fl, c[j].low); }
      if (fh - fl < (Number(p.lr_flat_sd) || 2) * sd) return no('flat');
    }
    // --- Step 3: room to the opposite level.
    const opp = dir > 0 ? res : sup;
    if (on('lr_use_space') && opp && (dir > 0 ? opp.rlo - close : close - opp.rhi) < (Number(p.lr_space_sd) || 2) * sd) return no('no_space');
    // --- Step 4: models (mirror for PUT: "tail" = wick on the level's side, "nose" = the other one).
    const r = rng(i), b = bod(i);
    // Early V-reversal (lr_b_early): c[i] is the forming candle – only model B, and its body must already reach
    // lr_b_early_pct % of the candle against the impulse. Entry now; the same signal is not sent again at the close.
    const live = k.time + 60 * (x.tfMin || 1) > Date.now() / 1000;
    if (live && !p.lr_b_early) return no('live_off');
    if (live && !(I.dirOf(k) === dir && b >= Number(p.lr_b_early_pct ?? 60) / 100 * r)) return no('early_body');
    const tail = dir > 0 ? Math.min(k.open, k.close) - k.low : k.high - Math.max(k.open, k.close);
    const nose = dir > 0 ? k.high - Math.max(k.open, k.close) : Math.min(k.open, k.close) - k.low;
    let A = false;
    if (!live && p.lr_model_a !== false && r > 0) {
      const pb = Number(p.lr_prior_bars) || 2;
      let against = 0; for (let j = i - 3; j < i; j++) if (I.dirOf(c[j]) === -dir) against++;
      const moved = dir > 0 ? c[i - 1].close < c[i - 3].open : c[i - 1].close > c[i - 3].open;
      const bodyEdge = dir > 0 ? Math.min(k.open, k.close) >= k.low + r * 2 / 3 : Math.max(k.open, k.close) <= k.high - r * 2 / 3;
      const touches = dir > 0 ? k.low <= lvl.hi : k.high >= lvl.lo;
      A = (!on('lr_a_prior') || (against >= pb && moved))
        && (!on('lr_a_touch') || touches)
        && (!on('lr_a_tail') || tail >= (Number(p.lr_tail_pct) || 60) / 100 * r)
        && (!on('lr_a_body') || (b <= (Number(p.lr_body_pct) || 30) / 100 * r && bodyEdge))
        && (!on('lr_a_nose') || nose <= Number(p.lr_nose_pct ?? 15) / 100 * r)
        && (!on('lr_a_size') || r >= (Number(p.lr_pin_min_sd) || 1) * sd)
        && tail > nose; // without any filter: at least the long wick on the level's side
    }
    let B = false;
    if (p.lr_model_b !== false && I.dirOf(k) === dir && (live || !on('lr_b_body') || b >= (Number(p.lr_vbody_pct) || 60) / 100 * r)) {
      // Vertical impulse against the trade ending right before the signal candle, in the level zone.
      const iMin = Number(p.lr_imp_min) || 3, iMax = Number(p.lr_imp_max) || 6;
      let n = 0, opposite = 0, small = 0, ok = true, sum = 0, prevClose = null;
      for (let j = i - 1; j >= i - iMax && j > 0; j--) {
        const d = I.dirOf(c[j]);
        const steps = on('lr_b_steps'); // each close further on, no pause of 2+ small candles
        if (d === -dir) { n++; sum += bod(j); if (bod(j) < 0.3 * sd) small++; else small = 0; if (steps && small >= 2) { ok = false; break; } }
        else if (opposite === 0 && bod(j) < 0.3 * sd && n > 0) { opposite++; continue; }
        else break;
        if (steps && prevClose !== null && (dir > 0 ? c[j].close <= prevClose : c[j].close >= prevClose)) { ok = false; break; }
        prevClose = c[j].close;
      }
      const startJ = i - n - opposite, last = c[i - 1];
      const move = dir > 0 ? c[startJ].open - last.close : last.close - c[startJ].open;
      const inZone = dir > 0 ? last.low <= lvl.hi + zoneW : last.high >= lvl.lo - zoneW;
      const lastBody = bod(i - 1), mid = (last.open + last.close) / 2;
      B = ok && n >= 1 && I.dirOf(last) === -dir
        && (!on('lr_b_count') || (n >= iMin && n <= iMax))
        && (!on('lr_b_move') || move >= (Number(p.lr_imp_move_sd) || 3) * sd)
        && (!on('lr_b_avgbody') || sum / n > ab)
        && (!on('lr_b_zone') || inZone)
        && (!on('lr_b_cover') || b >= lastBody || (dir > 0 ? close > mid : close < mid));
    }
    if (!A && !B) return no('no_model');
    // --- Step 5: strength 4 or 5.
    const pierced = dir > 0 ? k.low < lvl.lo : k.high > lvl.hi;
    const strong = (lvl.n >= 2 || lvl.ext) && (pierced || (A && B) || lvl.n >= 3);
    const power = strong ? 5 : 4;
    if (power < (Number(p.lr_min_strength) || 4)) return no('strength');
    const model = A && B ? 'A+B' : A ? 'A' : 'B';
    const lvlTxt = lvl.ext ? 'экстремум' : `${lvl.n} касания`, lvlDe = lvl.ext ? 'Extrem' : `${lvl.n} Berührungen`, lvlEn = lvl.ext ? 'extreme' : `${lvl.n} touches`;
    const s = sig(dir, power * 20, L(
      `${power}/5 · ${dir > 0 ? 'у поддержки' : 'у сопротивления'} (${lvlTxt})${pierced ? ', прокол с возвратом' : ''} · модель ${model}${A ? `, тень ${Math.round(100 * tail / r)}%` : ''}`,
      `${power}/5 · ${dir > 0 ? 'an Unterstützung' : 'an Widerstand'} (${lvlDe})${pierced ? ', durchstochen und zurück' : ''} · Modell ${model}${A ? `, Docht ${Math.round(100 * tail / r)}%` : ''}`,
      `${power}/5 · ${dir > 0 ? 'at support' : 'at resistance'} (${lvlEn})${pierced ? ', pierced and back' : ''} · model ${model}${A ? `, wick ${Math.round(100 * tail / r)}%` : ''}`), Number(p.expiry) || 60);
    s.model = model; // win rate per model in the statistics
    s.bar = k.time; // one signal per signal candle: an early one is not repeated after the close
    if (live) { s.entry = Math.floor(Date.now() / 1000); s.reason = addText(s.reason, L(' · рано (свеча ещё идёт)', ' · früh (Kerze läuft noch)', ' · early (candle still running)')); }
    return s;
  },
  n_vrev(x, p) {
    const c = x.c, i = x.last, k = c[i], N = Number(p.vr_sd_period) || 20;
    if (i < N + 12) return null;
    const rng = j => c[j].high - c[j].low, bod = j => Math.abs(c[j].close - c[j].open);
    let sd = 0, ab = 0; for (let j = i - N + 1; j <= i; j++) { sd += rng(j); ab += bod(j); } sd /= N; ab /= N;
    const dir = I.dirOf(k), r = rng(i), b = bod(i);
    if (!dir || !(sd > 0) || !(r > 0)) return null;
    // Dead pairs (USD/MYR, gold OTC: candles of a few hundredths of a basis point) – "big" there is still nothing.
    if (sd / k.close * 10000 < Number(p.vr_min_bp ?? 1)) return null;
    if ((dir > 0 && p.vr_buy === false) || (dir < 0 && p.vr_sell === false)) return null;
    // Modes can run together: wave first, then spike/run (vr_spike).
    const wave = () => {
      if (b < (Number(p.vr_w_body_pct) || 0) / 100 * r) return null;
      const W = Number(p.vr_swing_bars) || 8, tb = Number(p.vr_tip_bars) || 3, ex = Number(p.vr_w_extreme) || 10;
      if (b < (Number(p.vr_rev_big) || 1) * ab) return null;
      let tip = dir > 0 ? Infinity : -Infinity, tipAt = -1;
      for (let j = i - tb; j <= i; j++) if (dir > 0 ? c[j].low < tip : c[j].high > tip) { tip = dir > 0 ? c[j].low : c[j].high; tipAt = j; }
      for (let j = Math.max(0, i - ex); j < i - tb; j++) if (dir > 0 ? c[j].low < tip : c[j].high > tip) return null; // not a new extreme
      let from = dir > 0 ? -Infinity : Infinity;
      for (let j = Math.max(0, tipAt - W); j < tipAt; j++) from = dir > 0 ? Math.max(from, c[j].high) : Math.min(from, c[j].low);
      const move = Math.abs(from - tip) / sd;
      if (!(move >= (Number(p.vr_w_move) || 3))) return null;
      // Only the first strong candle of the turn (no second signal on the next one).
      for (let j = tipAt + 1; j < i; j++) if (I.dirOf(c[j]) === dir && bod(j) >= (Number(p.vr_rev_big) || 1) * ab) return null;
      // The turn has started: the close is back from the extreme by at least a third of the reversal candle's range.
      if ((dir > 0 ? k.close - tip : tip - k.close) < r / 3) return null;
      const s = sig(dir, Math.min(99, 60 + move * 5), L(`V-разворот волны: ход ${move.toFixed(1)} SD к экстремуму → свеча ${Math.round(100 * b / r)}%`,
        `V-Umkehr der Welle: ${move.toFixed(1)} SD zum Extrem → Kerze ${Math.round(100 * b / r)}%`,
        `Wave V-reversal: ${move.toFixed(1)} SD to the extreme → candle ${Math.round(100 * b / r)}%`), Number(p.expiry) || 60);
      s.bar = k.time; s.model = 'wave';
      return s;
    };
    if (p.vr_swing) { const w = wave(); if (w) return w; }
    if (p.vr_spike === false) return null;
    // Reversal candle: big body against the run.
    if (b < (Number(p.vr_body_pct) || 0) / 100 * r) return null;
    // The run before it: candles against the trade, each closing further on (vr_steps), at most one tiny pause candle.
    const iMin = Number(p.vr_imp_min) || 3, iMax = Number(p.vr_imp_max) || 6;
    let n = 0, pause = 0, sum = 0, prev = null;
    for (let j = i - 1; j >= i - iMax - 1 && j > 0; j--) {
      const d = I.dirOf(c[j]);
      if (d === -dir) {
        if (p.vr_steps !== false && prev !== null && (dir > 0 ? c[j].close <= prev : c[j].close >= prev)) break;
        n++; sum += bod(j); prev = c[j].close;
        if (n >= iMax) break;
      } else if (!pause && n > 0 && bod(j) < 0.3 * sd) pause++;
      else break;
    }
    if (n < iMin || I.dirOf(c[i - 1]) !== -dir) return null;
    const start = c[i - n - pause], last = c[i - 1];
    const move = (dir > 0 ? start.open - last.close : last.close - start.open) / sd;
    if (move < (Number(p.vr_move_sd) || 0)) return null;
    if (p.vr_avgbody !== false && !(sum / n > ab)) return null;
    // Spike shape (user's picture 28.10.2026): the last run candle is a big one (≥ vr_last_big × average body) and the
    // reversal candle answers it with a body of at least vr_answer_pct % of it – big up, big down (Λ) or the mirror (V).
    const lb = Number(p.vr_last_big) || 0, ans = Number(p.vr_answer_pct) || 0;
    if (lb && !(bod(i - 1) >= lb * ab)) return null;
    if (ans && !(b >= ans / 100 * bod(i - 1))) return null;
    // Covers the last run candle: bigger body or closes past its middle.
    if (p.vr_cover !== false && !(b >= bod(i - 1) || (dir > 0 ? k.close > (last.open + last.close) / 2 : k.close < (last.open + last.close) / 2))) return null;
    // The run made a new extreme of the last vr_extreme candles (a real end of a move, not a dip inside a range).
    const ex = Number(p.vr_extreme) || 0;
    if (ex) {
      const tip = dir > 0 ? Math.min(last.low, k.low) : Math.max(last.high, k.high);
      for (let j = Math.max(0, i - ex); j < i - n - pause; j++) if (dir > 0 ? c[j].low < tip : c[j].high > tip) return null;
    }
    const s = sig(dir, Math.min(99, 60 + move * 5), L(`V-разворот: ${n} св. импульса, ${move.toFixed(1)} SD → свеча ${Math.round(100 * b / r)}%`,
      `V-Umkehr: ${n} Impulskerzen, ${move.toFixed(1)} SD → Kerze ${Math.round(100 * b / r)}%`,
      `V-reversal: ${n} impulse candles, ${move.toFixed(1)} SD → candle ${Math.round(100 * b / r)}%`), Number(p.expiry) || 60);
    s.bar = k.time; s.model = 'spike';
    return s;
  },
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
    const t = p.ma3_type || 'EMA', f = Number(p.ma3_fast) || 4, m = Number(p.ma3_mid) || 8, s = Number(p.ma3_slow) || 13;
    const a = I.ma(x.close, f, t), b = I.ma(x.close, m, t), c = I.ma(x.close, s, t);
    const i = x.last, d = cross(a, b, i); if (!d || c[i] === null) return null;
    if (d > 0 ? b[i] < c[i] : b[i] > c[i]) return null; // middle MA must be on the right side of the slow one
    return sig(d, 72, L(`${t} ${f} пересекла ${t} ${m} по ${t} ${s}`, `${t} ${f} kreuzt ${t} ${m} im Sinne der ${t} ${s}`, `${t} ${f} crossed ${t} ${m} with ${t} ${s}`));
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

module.exports = { evaluate, NAMES, DEFAULTS, META, PRESETS, GROUPS, paramsFor, liveMode, list: Object.keys(META) };
