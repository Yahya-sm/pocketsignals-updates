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
  n_ma25: [L('Пересечение MA 2 / 5', 'Kreuzung MA 2 / 5', 'MA 2 / 5 cross'), 'trend'],
  n_levelrev: [L('Разворот от уровня (пин-бар / V-разворот)', 'Umkehr am Level (Pinbar / V-Umkehr)', 'Reversal at a level (pin bar / V-turn)'), 'rev'],
  n_strongtrend: [L('Сильный тренд: вход в начале', 'Starker Trend: Einstieg am Anfang', 'Strong trend: entry at the start'), 'trend'],
  n_deeprev: [L('Разворот после глубокого падения (M15/M5/M1)', 'Umkehr nach tiefem Fall (M15/M5/M1)', 'Reversal after a deep fall (M15/M5/M1)'), 'rev'],
  early: [L('Ранний разворот', 'Frühe Umkehr', 'Early reversal'), 'rev'],
  n_rsi8020: [L('Возврат из крайних зон (стохастик / RSI)', 'Rückkehr aus Extremzonen (Stochastik / RSI)', 'Return from extreme zones (Stochastic / RSI)'), 'rev'],
  n_stochenv: [L('Stoch + Envelopes', 'Stoch + Envelopes'), 'rev'],
  n_vortex: [L('Vortex + MACD', 'Vortex + MACD'), 'trend'],
  n_psar: [L('Supertrend + PSAR', 'Supertrend + PSAR'), 'trend'],
  n_trendpull: [L('Откат по тренду', 'Rücklauf im Trend', 'Trend pullback'), 'trend'],
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
// Market rules for the reversal setups (see marketOk): volatile market only, no entry straight into a level.
const MARKET = { mk_vol: 1, mk_big: 1.8, mk_room: 1 };
const DEFAULTS = {
  // 04.11.2026 (user): the series of candles is only the setup; the signal is the Stochastic turning out of its zone
  // (%K crosses 20 upwards after a fall / 80 downwards after a rise) within sharp_wait candles after the series.
  n_sharp: { sharp_expiry: 180, ...FILTERS, follow_move: false, sharp_min: 4, sharp_rsi: false, sharp_mirror: true,
    sharp_stoch: true, sharp_low: 20, sharp_high: 80, sharp_wait: 10, sharp_k: 14, sharp_ks: 3, ...SHARP_BOT },
  // bs_*: big candle inside a slow trend (demo mode, user 06.11.2026). Off = the old rule. Backtest: no profit shown, see TESTS.n_big.
  n_big: { ...REV, big_body: 2.5, big_period: 20, ...BIG_BOT, bs_on: false, bs_mode: 'A', bs_lookback: 15, bs_body: 2, bs_use_range: false, bs_range: 1.8, bs_ratio: 0.6, bs_min_atr: 0,
    bs_trend: true, bs_against: false, bs_ema_fast: 20, bs_ema_slow: 50, bs_slope: 10, bs_max_slope: 0, bs_max_dist: 0, bs_gap: 1 },
  // Reversal at a level (user's prompt of 28.10.2026): structure first (support/resistance from the history), the side
  // decides the direction (at resistance only PUT, at support only CALL), then model A (pin bar from the level) or
  // model B (vertical impulse into the level → big opposite candle). SD = average candle range of lr_sd_period candles.
  n_levelrev: { expiry: 60, ...MARKET, lr_min_strength: 4, lr_model_a: true, lr_model_b: true, lr_buy: true, lr_sell: true,
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
  // Strong trend, entry at its start (user, 30.10.2026). Also the level filter of trend strategies (room_check).
  n_strongtrend: { expiry: 120, st_buy: true, st_sell: true, st_fade: false, st_use_m5: false, st_use_m15: false, st_adx: 25, st_fresh: 3, st_adx_max: 45, st_di_gap: 5,
    st_big_n: 3, st_big_k: 2, st_body_atr: 0.8, st_max_run: 5, st_ema: 20, st_max_ext: 2.5, room_check: true, room_min: 1,
    st_use_vortex: false, st_vortex_period: 14, st_use_macd: false, st_macd_fast: 12, st_macd_slow: 26, st_macd_signal: 9,
    st_use_rsi: false, st_rsi_period: 14, st_rsi_mid: 50, st_rsi_max: 0 },
  // Reversal after a deep fall (user's prompt of 29.10.2026), see deepRev(). Conservative: all rules on.
  n_deeprev: { expiry: 180, dr_buy: true, dr_sell: false, dr_min_conf: 6, dr_touches: 2, dr_zone_atr: 0.5, dr_near_atr: 0.7,
    dr_use_fall: true, dr_bear: 5, dr_imp_atr: 3, dr_use_pattern: true, dr_use_break: true, dr_break_atr: 1.2,
    dr_use_rsi: true, dr_rsi_lo: 30, dr_use_cross: true, dr_use_trend: true, dr_use_flat: true, dr_flat_atr: 3,
    dr_use_spike: true, dr_spike: 3, dr_use_m1: true },
  n_ma25: { m25_expiry: 120, ...FILTERS, no_countertrend: false, room_check: false, room_min: 1, m25_fast: 2, m25_slow: 5, m25_fast_type: 'SMA', m25_slow_type: 'SMA', m25_buy: true, m25_sell: true, m25_live: false, m25_vol: 0,
    m25_quiet: 0, m25_gap: 0, m25_trend: 0, m25_body: 0, m25_rsi: false, m25_rsi_max: 70 },
  early: { ...REV, early_min: 3, early_drop_atr: 1.5 },
  n_rsi8020: { ...REV, rx_osc: 'STOCH', rsi_levels: '80/20', rx_live: true, rx_k: 14, rx_ks: 3, rsi_period: 14 },
  n_stochenv: { ...REV, env_period: 20, env_pct: 0.1, stoch_k: 5, stoch_zone: 20 },
  n_vortex: { ...TREND, vx_use_vortex: true, vortex_period: 14, vx_use_macd: true, macd_fast: 12, macd_slow: 26, macd_signal: 9, vx_use_adx: false, vx_adx_period: 14, vx_adx_min: 25,
    vx_use_rsi: false, vx_rsi_period: 14, vx_rsi_mid: 50, vx_rsi_max: 70 },
  n_psar: { ...TREND, st_period: 10, st_mult: 1.5, sar_step: 0.02, sar_max: 0.2, sar_window: 2 },
  // Entry with the trend once the pullback has ended (see S.n_trendpull).
  n_trendpull: { ...TREND, expiry: 120, min_adx: 0, room_check: false, tp_buy: true, tp_sell: true, tp_right: 2, tp_depth_min: 38.2, tp_depth_max: 61.8,
    tp_bars_max: 5, tp_imp_atr: 2, tp_room_atr: 0.5, tp_candle_atr: 1.5, tp_ema: 20, tp_first: true, tp_return_max: 50 },
};

// Strong-trend presets start from "all extras off, no higher timeframes" so a preset never keeps a stray switch.
const ST_OFF = { st_use_vortex: false, st_use_macd: false, st_use_rsi: false, st_use_m5: false, st_use_m15: false };
// Ready-made setting combinations (one tap in the app).
const BS = { bs_on: true, bot: false, expiry: 120, bs_mode: 'A', bs_lookback: 15, bs_use_range: false, bs_range: 1.8, bs_ratio: 0.6, bs_min_atr: 0, bs_trend: true, bs_against: false, bs_max_slope: 0, bs_max_dist: 0, bs_gap: 1 };
const NM1 = L('Очень часто', 'Sehr oft', 'Very often'), NM2 = L('Часто', 'Oft', 'Often'), NM3 = L('Средне', 'Mittel', 'Medium'), NM4 = L('Строже', 'Strenger', 'Stricter'), NM5 = L('Строго', 'Streng', 'Strict');
const PRESETS = {
  n_rsi8020: [
    { name: NM1, values: { rsi_levels: '65/35' } },
    { name: NM2, values: { rsi_levels: '70/30' } },
    { name: NM3, values: { rsi_levels: '80/20' } },
    { name: NM4, values: { rsi_levels: '85/15' } },
    { name: NM5, values: { rsi_levels: '90/10' } },
  ],
  n_stochenv: [
    { name: NM1, values: { env_pct: 0.05, stoch_zone: 30 } },
    { name: NM2, values: { env_pct: 0.07, stoch_zone: 25 } },
    { name: NM3, values: { env_pct: 0.1, stoch_zone: 20 } },
    { name: NM4, values: { env_pct: 0.15, stoch_zone: 20 } },
    { name: NM5, values: { env_pct: 0.2, stoch_zone: 15 } },
  ],
  n_vortex: [
    { name: NM1, values: { vx_use_vortex: true, vx_use_macd: false, vx_use_adx: false, vx_use_rsi: false } },
    { name: NM2, values: { vx_use_vortex: true, vx_use_macd: true, macd_fast: 6, macd_slow: 13, macd_signal: 5, vx_use_adx: false, vx_use_rsi: false } },
    { name: NM3, values: { vx_use_vortex: true, vx_use_macd: true, macd_fast: 12, macd_slow: 26, macd_signal: 9, vx_use_adx: false, vx_use_rsi: false } },
    { name: NM4, values: { vx_use_vortex: true, vx_use_macd: true, macd_fast: 12, macd_slow: 26, macd_signal: 9, vx_use_adx: true, vx_adx_min: 20, vx_use_rsi: false } },
    { name: NM5, values: { vx_use_vortex: true, vx_use_macd: true, macd_fast: 12, macd_slow: 26, macd_signal: 9, vx_use_adx: true, vx_adx_min: 25, vx_use_rsi: true, vx_rsi_mid: 50, vx_rsi_max: 70 } },
  ],
  n_psar: [
    { name: NM1, values: { st_mult: 1.2, sar_window: 5 } },
    { name: NM2, values: { st_mult: 1.2, sar_window: 3 } },
    { name: NM3, values: { st_mult: 1.5, sar_window: 2 } },
    { name: NM4, values: { st_mult: 2, sar_window: 2 } },
    { name: NM5, values: { st_mult: 2.5, sar_window: 1 } },
  ],
  n_deeprev: [
    { name: NM1, values: { dr_min_conf: 5, dr_touches: 2, dr_use_cross: false, dr_use_m1: false } },
    { name: NM2, values: { dr_min_conf: 5, dr_touches: 2, dr_use_cross: false, dr_use_m1: true } },
    { name: NM3, values: { dr_min_conf: 6, dr_touches: 2, dr_use_cross: true, dr_use_m1: true } },
    { name: NM4, values: { dr_min_conf: 7, dr_touches: 2, dr_use_cross: true, dr_use_m1: true } },
    { name: NM5, values: { dr_min_conf: 8, dr_touches: 3, dr_use_cross: true, dr_use_m1: true } },
  ],
  // Strictness levels of the big-candle mode; every value is visible here and in the instruction.
  n_big: [
    { name: L('Очень часто', 'Sehr oft', 'Very often'), values: { ...BS, bs_body: 1.5, bs_ratio: 0.5, bs_trend: false, bs_gap: 0 } },
    { name: L('Часто', 'Oft', 'Often'), values: { ...BS, bs_body: 1.8, bs_ratio: 0.5 } },
    { name: L('Средне', 'Mittel', 'Medium'), values: { ...BS, bs_body: 2 } },
    { name: L('Строже', 'Strenger', 'Stricter'), values: { ...BS, bs_body: 2.5, bs_use_range: true, bs_max_dist: 3 } },
    { name: L('Строго', 'Streng', 'Strict'), values: { ...BS, bs_body: 3, bs_use_range: true, bs_max_slope: 1.5, bs_max_dist: 2.5 } },
    { name: L('С подтверждением', 'Mit Bestätigung', 'With confirmation'), values: { ...BS, bs_mode: 'C', bs_body: 2.5, bs_use_range: true, bs_max_slope: 1.5, bs_max_dist: 2.5 } },
  ],
  // Strictness levels (user, 06.11.2026). "Medium" = the strategy's defaults; expiry stays the user's. Results: TESTS.
  n_sharp: [
    { name: L('Очень часто', 'Sehr oft', 'Very often'), values: { bot: false, sharp_stoch: true, sharp_rsi: false, sharp_min: 3, sharp_low: 30, sharp_high: 70, sharp_wait: 15 } },
    { name: L('Часто', 'Oft', 'Often'), values: { bot: false, sharp_stoch: true, sharp_rsi: false, sharp_min: 3, sharp_low: 25, sharp_high: 75, sharp_wait: 10 } },
    { name: L('Средне', 'Mittel', 'Medium'), values: { bot: false, sharp_stoch: true, sharp_rsi: false, sharp_min: 4, sharp_low: 20, sharp_high: 80, sharp_wait: 10 } },
    { name: L('Строже', 'Strenger', 'Stricter'), values: { bot: false, sharp_stoch: true, sharp_rsi: false, sharp_min: 5, sharp_low: 20, sharp_high: 80, sharp_wait: 8 } },
    { name: L('Строго', 'Streng', 'Strict'), values: { bot: false, sharp_stoch: true, sharp_rsi: false, sharp_min: 5, sharp_low: 15, sharp_high: 85, sharp_wait: 5 } },
    { name: L('С подтверждением RSI', 'Mit RSI-Bestätigung', 'With RSI confirmation'), values: { bot: false, sharp_stoch: true, sharp_rsi: true, sharp_min: 4, sharp_low: 20, sharp_high: 80, sharp_wait: 10 } },
  ],
  early: [
    { name: L('Очень часто', 'Sehr oft', 'Very often'), values: { early_min: 2, early_drop_atr: 0.8 } },
    { name: L('Часто', 'Oft', 'Often'), values: { early_min: 2, early_drop_atr: 1.2 } },
    { name: L('Средне', 'Mittel', 'Medium'), values: { early_min: 3, early_drop_atr: 1.5 } },
    { name: L('Строже', 'Strenger', 'Stricter'), values: { early_min: 3, early_drop_atr: 2 } },
    { name: L('Строго', 'Streng', 'Strict'), values: { early_min: 4, early_drop_atr: 2.5 } },
  ],
  n_trendpull: [
    { name: L('Очень часто', 'Sehr oft', 'Very often'), values: { tp_depth_min: 23.6, tp_depth_max: 78.6, tp_bars_max: 8, tp_imp_atr: 1, tp_room_atr: 0.2, tp_candle_atr: 2.5, min_adx: 0 } },
    { name: L('Часто', 'Oft', 'Often'), values: { tp_depth_min: 30, tp_depth_max: 70, tp_bars_max: 6, tp_imp_atr: 1.5, tp_room_atr: 0.3, tp_candle_atr: 2, min_adx: 0 } },
    { name: L('Средне', 'Mittel', 'Medium'), values: { tp_depth_min: 38.2, tp_depth_max: 61.8, tp_bars_max: 5, tp_imp_atr: 2, tp_room_atr: 0.5, tp_candle_atr: 1.5, min_adx: 0 } },
    { name: L('Строже', 'Strenger', 'Stricter'), values: { tp_depth_min: 38.2, tp_depth_max: 61.8, tp_bars_max: 4, tp_imp_atr: 2.5, tp_room_atr: 0.7, tp_candle_atr: 1.2, min_adx: 0 } },
    { name: L('Строго', 'Streng', 'Strict'), values: { tp_depth_min: 38.2, tp_depth_max: 61.8, tp_bars_max: 3, tp_imp_atr: 3, tp_room_atr: 1, tp_candle_atr: 1.2, min_adx: 20 } },
  ],
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
  // Strong trend, measured 30.10.2026 (~5 days, 13 pairs): with the trend 37–41 % (loses); against the impulse with
  // candles ≥ 0.6 ATR 131 signals, 60 / 58 / 58 % at 1 / 2 / 3 min; M5/M15 agreement cut signals without a clear gain.
  // Combinations from the grid search of 30.10.2026 (chosen on 3 days, checked on 2 other days), see TESTS.
  n_strongtrend: [
    { name: L('Против импульса · база', 'Gegen den Impuls · Basis', 'Against the impulse · base'),
      values: { ...ST_OFF, expiry: 60, st_fade: true, st_body_atr: 0.6, st_adx: 25 } },
    { name: L('+ Vortex 7', '+ Vortex 7', '+ Vortex 7'),
      values: { ...ST_OFF, expiry: 60, st_fade: true, st_body_atr: 0.6, st_adx: 25, st_use_vortex: true, st_vortex_period: 7 } },
    { name: L('Строже: ADX 30 + MACD 12/26/9', 'Strenger: ADX 30 + MACD 12/26/9', 'Stricter: ADX 30 + MACD 12/26/9'),
      values: { ...ST_OFF, expiry: 60, st_fade: true, st_body_atr: 0.6, st_adx: 30, st_use_macd: true, st_macd_fast: 12, st_macd_slow: 26, st_macd_signal: 9 } },
    { name: L('Vortex 7 + MACD 6/13/5 · 3 мин', 'Vortex 7 + MACD 6/13/5 · 3 Min', 'Vortex 7 + MACD 6/13/5 · 3 min'),
      values: { ...ST_OFF, expiry: 180, st_fade: true, st_body_atr: 0.6, st_adx: 25, st_use_vortex: true, st_vortex_period: 7, st_use_macd: true, st_macd_fast: 6, st_macd_slow: 13, st_macd_signal: 5 } },
    { name: NM1, values: { ...ST_OFF, st_adx: 20, st_fresh: 5, st_di_gap: 2, st_big_k: 2, st_body_atr: 0.3, st_max_run: 8 } },
    { name: NM2, values: { ...ST_OFF, st_adx: 20, st_fresh: 5, st_di_gap: 3, st_big_k: 2, st_body_atr: 0.5, st_max_run: 7 } },
    { name: NM3, values: { ...ST_OFF, st_adx: 25, st_fresh: 4, st_di_gap: 4, st_big_k: 2, st_body_atr: 0.6, st_max_run: 6 } },
    { name: NM4, values: { ...ST_OFF, st_adx: 25, st_fresh: 3, st_di_gap: 5, st_big_k: 2, st_body_atr: 0.8, st_max_run: 5 } },
    { name: NM5, values: { ...ST_OFF, st_adx: 30, st_fresh: 3, st_di_gap: 7, st_big_k: 2, st_body_atr: 0.9, st_max_run: 5 } },
  ],
  // MA 2/5: fewer and better crosses. Measured 28.10.2026 (17 OTC pairs, 90 min, 2 min expiry): only "calm before" raised
  // the win rate (none 291 signals 52 %, 8 → 53 / 56 %, 10 → 33 / 72 %, 12 → 17 / 81 %); trend EMA, RSI, body, ADX did not.
  n_ma25: [
    { name: NM1, values: { m25_quiet: 5, m25_gap: 0, m25_trend: 0, m25_body: 0, m25_rsi: false, m25_vol: 0, min_adx: 0, room_check: false } },
    { name: NM2, values: { m25_quiet: 8, m25_gap: 0, m25_trend: 0, m25_body: 0, m25_rsi: false, m25_vol: 0, min_adx: 0, room_check: false } },
    { name: NM3, values: { m25_quiet: 10, m25_gap: 0, m25_trend: 0, m25_body: 0, m25_rsi: false, m25_vol: 0, min_adx: 0, room_check: false } },
    { name: NM4, values: { m25_quiet: 12, m25_gap: 0, m25_trend: 0, m25_body: 0, m25_rsi: false, m25_vol: 0, min_adx: 0, room_check: false } },
    { name: NM5, values: { m25_quiet: 15, m25_gap: 0, m25_trend: 0, m25_body: 0, m25_rsi: false, m25_vol: 0, min_adx: 0, room_check: false } },
  ],
};

// Backtest results shown in the strategy (folded, opened by a tap). Rows: [variant, ...values].
const PROFILE_NOTE = L('Winrate, %. M1, 12 пар, 8000 минут на пару, обычный рынок (не OTC), без задержек. Безубыток: 54 % при выплате 85 %. Это один период, выбор лучшей клетки завышает результат, а при малом числе сигналов цифры почти случайны; преимущество не доказано.', 'Trefferquote, %. M1, 12 Paare, 8000 Minuten je Paar, normaler Markt (kein OTC), ohne Verzögerung. Break-even: 54 % bei 85 % Auszahlung. Ein Zeitraum; die beste Zelle auszuwählen überschätzt das Ergebnis, bei wenigen Signalen sind die Zahlen fast Zufall; kein Vorteil belegt.', 'Win rate, %. M1, 12 pairs, 8000 minutes per pair, normal market (not OTC), no delays. Break-even: 54 % at 85 % payout. One period; picking the best cell overstates the result, and with few signals the numbers are almost random; no edge proven.');
const TESTS = {
  n_rsi8020: [{
    title: L('Проверка профилей на истории', 'Prüfung der Profile auf der Historie', 'Profile test on history'),
    cols: [L('Профиль', 'Profil', 'Profile'), L('Сигн./пара/день', 'Sign./Paar/Tag', 'Sign./pair/day'), '1 м', '2 м', '3 м', '5 м'],
    rows: [
      [L('1 Очень часто', '1 Sehr oft', '1 Very often'), '70', '49,6', '50,0', '49,6', '49,2'],
      [L('2 Часто', '2 Oft', '2 Often'), '69', '49,9', '50,3', '50,4', '49,8'],
      [L('3 Средне', '3 Mittel', '3 Medium'), '64', '51,3', '51,2', '50,7', '50,6'],
      [L('4 Строже', '4 Strenger', '4 Stricter'), '57', '50,3', '50,9', '50,5', '51,9'],
      [L('5 Строго', '5 Streng', '5 Strict'), '46', '50,1', '52,4', '52,0', '51,4'],
    ],
    note: PROFILE_NOTE,
  }],
  n_stochenv: [{
    title: L('Проверка профилей на истории', 'Prüfung der Profile auf der Historie', 'Profile test on history'),
    cols: [L('Профиль', 'Profil', 'Profile'), L('Сигн./пара/день', 'Sign./Paar/Tag', 'Sign./pair/day'), '1 м', '2 м', '3 м', '5 м'],
    rows: [
      [L('1 Очень часто', '1 Sehr oft', '1 Very often'), '21', '51,3', '52,6', '51,7', '51,5'],
      [L('2 Часто', '2 Oft', '2 Often'), '9,6', '52,8', '54,4', '52,2', '54,6'],
      [L('3 Средне', '3 Mittel', '3 Medium'), '3,4', '53,0', '57,9', '56,0', '54,1'],
      [L('4 Строже', '4 Strenger', '4 Stricter'), '0,8', '52,2', '62,3', '60,3', '60,3'],
      [L('5 Строго', '5 Streng', '5 Strict'), '0,2', '66,7', '73,3', '60,0', '73,3'],
    ],
    note: PROFILE_NOTE,
  }],
  n_vortex: [{
    title: L('Проверка профилей на истории', 'Prüfung der Profile auf der Historie', 'Profile test on history'),
    cols: [L('Профиль', 'Profil', 'Profile'), L('Сигн./пара/день', 'Sign./Paar/Tag', 'Sign./pair/day'), '1 м', '2 м', '3 м', '5 м'],
    rows: [
      [L('1 Очень часто', '1 Sehr oft', '1 Very often'), '49', '49,4', '49,2', '48,9', '48,2'],
      [L('2 Часто', '2 Oft', '2 Often'), '33', '49,7', '48,8', '48,1', '47,7'],
      [L('3 Средне', '3 Mittel', '3 Medium'), '31', '50,5', '49,1', '48,2', '47,6'],
      [L('4 Строже', '4 Strenger', '4 Stricter'), '7,1', '50,4', '48,0', '46,5', '47,3'],
      [L('5 Строго', '5 Streng', '5 Strict'), '2,9', '45,5', '41,1', '43,2', '46,1'],
    ],
    note: PROFILE_NOTE,
  }],
  n_psar: [{
    title: L('Проверка профилей на истории', 'Prüfung der Profile auf der Historie', 'Profile test on history'),
    cols: [L('Профиль', 'Profil', 'Profile'), L('Сигн./пара/день', 'Sign./Paar/Tag', 'Sign./pair/day'), '1 м', '2 м', '3 м', '5 м'],
    rows: [
      [L('1 Очень часто', '1 Sehr oft', '1 Very often'), '18', '50,2', '50,8', '49,7', '51,0'],
      [L('2 Часто', '2 Oft', '2 Often'), '16', '50,5', '50,3', '49,6', '50,7'],
      [L('3 Средне', '3 Mittel', '3 Medium'), '16', '47,8', '48,2', '48,6', '47,5'],
      [L('4 Строже', '4 Strenger', '4 Stricter'), '13', '47,1', '49,2', '49,0', '46,1'],
      [L('5 Строго', '5 Streng', '5 Strict'), '4,7', '50,9', '51,6', '49,8', '44,8'],
    ],
    note: PROFILE_NOTE,
  }],
  n_ma25: [{
    title: L('Проверка профилей на истории', 'Prüfung der Profile auf der Historie', 'Profile test on history'),
    cols: [L('Профиль', 'Profil', 'Profile'), L('Сигн./пара/день', 'Sign./Paar/Tag', 'Sign./pair/day'), '1 м', '2 м', '3 м', '5 м'],
    rows: [
      [L('1 Очень часто', '1 Sehr oft', '1 Very often'), '62', '49,1', '50,1', '49,9', '49,3'],
      [L('2 Часто', '2 Oft', '2 Often'), '26', '49,4', '51,3', '50,0', '48,6'],
      [L('3 Средне', '3 Mittel', '3 Medium'), '14', '49,1', '50,8', '49,3', '48,6'],
      [L('4 Строже', '4 Strenger', '4 Stricter'), '7,4', '50,2', '54,0', '50,7', '49,4'],
      [L('5 Строго', '5 Streng', '5 Strict'), '3,2', '50,5', '53,3', '50,7', '50,5'],
    ],
    note: PROFILE_NOTE,
  }],
  n_deeprev: [{
    title: L('Проверка профилей на истории', 'Prüfung der Profile auf der Historie', 'Profile test on history'),
    cols: [L('Профиль', 'Profil', 'Profile'), L('Сигн./пара/день', 'Sign./Paar/Tag', 'Sign./pair/day'), '1 м', '2 м', '3 м', '5 м'],
    rows: [
      [L('1 Очень часто', '1 Sehr oft', '1 Very often'), '6,1', '49,1', '49,8', '50,7', '48,7'],
      [L('2 Часто', '2 Oft', '2 Often'), '1,1', '51,0', '55,1', '53,1', '47,5'],
      [L('3 Средне', '3 Mittel', '3 Medium'), '0,3', '50,0', '59,3', '50,0', '43,3'],
      [L('4 Строже', '4 Strenger', '4 Stricter'), '0,3', '50,0', '54,5', '45,8', '44,0'],
      [L('5 Строго', '5 Streng', '5 Strict'), '0,1', '53,8', '58,3', '50,0', '38,5'],
    ],
    note: PROFILE_NOTE,
  }],
  n_sharp: [{
    title: L('Проверка профилей на истории', 'Prüfung der Profile auf der Historie', 'Profile test on history'),
    cols: [L('Профиль', 'Profil', 'Profile'), L('Сигн./пара/день', 'Sign./Paar/Tag', 'Sign./pair/day'), '1 м', '2 м', '3 м', '5 м'],
    rows: [
      [L('1 Очень часто', '1 Sehr oft', '1 Very often'), '56', '50,8', '50,9', '50,9', '50,6'],
      [L('2 Часто', '2 Oft', '2 Often'), '49', '51,3', '51,7', '51,5', '50,6'],
      [L('3 Средне', '3 Mittel', '3 Medium'), '30', '51,3', '52,5', '51,8', '50,6'],
      [L('4 Строже', '4 Strenger', '4 Stricter'), '15', '52,7', '52,1', '52,1', '50,3'],
      [L('5 Строго', '5 Streng', '5 Strict'), '12', '50,9', '53,5', '51,8', '51,2'],
      [L('6 С подтверждением RSI', '6 Mit RSI-Bestätigung', '6 With RSI confirmation'), '17', '53,5', '53,4', '52,8', '51,7'],
    ],
    note: PROFILE_NOTE,
  }],
  early: [{
    title: L('Проверка профилей на истории', 'Prüfung der Profile auf der Historie', 'Profile test on history'),
    cols: [L('Профиль', 'Profil', 'Profile'), L('Сигн./пара/день', 'Sign./Paar/Tag', 'Sign./pair/day'), '1 м', '2 м', '3 м', '5 м'],
    rows: [
      [L('1 Очень часто', '1 Sehr oft', '1 Very often'), '38', '50,1', '47,9', '49,8', '48,5'],
      [L('2 Часто', '2 Oft', '2 Often'), '27', '50,5', '47,9', '49,9', '47,9'],
      [L('3 Средне', '3 Mittel', '3 Medium'), '16', '50,6', '49,2', '50,4', '48,5'],
      [L('4 Строже', '4 Strenger', '4 Stricter'), '11', '51,0', '49,1', '51,4', '49,3'],
      [L('5 Строго', '5 Streng', '5 Strict'), '5,5', '50,3', '49,4', '52,6', '49,2'],
    ],
    note: PROFILE_NOTE,
  }],
  n_trendpull: [{
    title: L('Проверка профилей на истории', 'Prüfung der Profile auf der Historie', 'Profile test on history'),
    cols: [L('Профиль', 'Profil', 'Profile'), L('Сигн./пара/день', 'Sign./Paar/Tag', 'Sign./pair/day'), '1 м', '2 м', '3 м', '5 м'],
    rows: [
      [L('1 Очень часто', '1 Sehr oft', '1 Very often'), '1,7', '48,3', '49,7', '45,9', '46,4'],
      [L('2 Часто', '2 Oft', '2 Often'), '1,1', '49,5', '52,0', '47,4', '46,5'],
      [L('3 Средне', '3 Mittel', '3 Medium'), '0,6', '40,4', '42,9', '42,0', '44,2'],
      [L('4 Строже', '4 Strenger', '4 Stricter'), '0,4', '25,8', '38,2', '45,7', '47,2'],
      [L('5 Строго', '5 Streng', '5 Strict'), '0,2', '25,0', '30,8', '42,9', '50,0'],
    ],
    note: PROFILE_NOTE,
  }],
  n_big: [{
    title: L('Проверка профилей на истории', 'Prüfung der Profile auf der Historie', 'Profile test on history'),
    cols: [L('Профиль', 'Profil', 'Profile'), L('Сигн./пара/день', 'Sign./Paar/Tag', 'Sign./pair/day'), '1 м', '2 м', '3 м', '5 м'],
    rows: [
      [L('Прежнее правило', 'Bisherige Regel', 'Old rule'), '64', '49,3', '49,7', '50,5', '51,8'],
      [L('1 Очень часто', '1 Sehr oft', '1 Very often'), '258', '50,1', '50,6', '50,1', '50,8'],
      [L('2 Часто', '2 Oft', '2 Often'), '73', '49,7', '51,2', '50,6', '51,8'],
      [L('3 Средне', '3 Mittel', '3 Medium'), '61', '49,4', '51,1', '50,7', '52,2'],
      [L('4 Строже', '4 Strenger', '4 Stricter'), '16', '49,4', '50,4', '51,3', '53,9'],
      [L('5 Строго', '5 Streng', '5 Strict'), '9,5', '51,8', '50,7', '51,3', '53,9'],
      [L('6 С подтверждением', '6 Mit Bestätigung', '6 With confirmation'), '5,4', '52,9', '51,4', '52,0', '51,1'],
    ],
    note: L('Winrate, %. 12 пар, 8000 минут на пару, обычный рынок (не OTC), без задержек. Безубыток: 54 % при выплате 85 %. Это один период, выбор лучшей клетки из таблицы завышает результат; преимущество не доказано.', 'Trefferquote, %. 12 Paare, 8000 Minuten je Paar, normaler Markt (kein OTC), ohne Verzögerung. Break-even: 54 % bei 85 % Auszahlung. Ein Zeitraum; die beste Zelle auszuwählen überschätzt das Ergebnis; kein Vorteil belegt.', 'Win rate, %. 12 pairs, 8000 minutes per pair, normal market (not OTC), no delays. Break-even: 54 % at 85 % payout. One period; picking the best cell overstates the result; no edge proven.'),
  }],
  n_strongtrend: [{
    title: L('Проверка профилей на истории', 'Prüfung der Profile auf der Historie', 'Profile test on history'),
    cols: [L('Профиль', 'Profil', 'Profile'), L('Сигн./пара/день', 'Sign./Paar/Tag', 'Sign./pair/day'), '1 м', '2 м', '3 м', '5 м'],
    rows: [
      [L('5 Очень часто', '5 Sehr oft', '5 Very often'), '3,8', '50,2', '49,2', '47,0', '46,2'],
      [L('6 Часто', '6 Oft', '6 Often'), '2,3', '53,3', '50,3', '48,2', '44,1'],
      [L('7 Средне', '7 Mittel', '7 Medium'), '0,8', '53,2', '50,0', '50,0', '41,8'],
      [L('8 Строже', '8 Strenger', '8 Stricter'), '0,3', '56,0', '57,7', '65,4', '42,3'],
      [L('9 Строго', '9 Streng', '9 Strict'), '0,1', '42,9', '37,5', '44,4', '55,6'],
    ],
    note: PROFILE_NOTE,
  }, {
    title: L('Лучшие сочетания индикаторов (пресеты 1–4)', 'Beste Indikator-Kombinationen (Presets 1–4)', 'Best indicator combinations (presets 1–4)'),
    cols: [L('Пресет', 'Preset', 'Preset'), L('Настройки', 'Einstellungen', 'Settings'), L('Экспир.', 'Ablauf', 'Expiry'), L('Сигналов / 5 дн.', 'Signale / 5 T.', 'Signals / 5 d'), L('Отбор', 'Auswahl', 'Choice'), L('Проверка', 'Prüfung', 'Check')],
    rows: [
      ['1', L('M1 · против импульса · свечи ≥ 0,6 ATR · ADX ≥ 25 · без доп. индикаторов', 'M1 · gegen den Impuls · Kerzen ≥ 0,6 ATR · ADX ≥ 25 · ohne Zusatz', 'M1 · against the impulse · candles ≥ 0.6 ATR · ADX ≥ 25 · no extras'), '1 мин', '131', '58%', '62%'],
      ['2', L('как 1 + Vortex период 7', 'wie 1 + Vortex Periode 7', 'as 1 + Vortex period 7'), '1 мин', '128', '60%', '62%'],
      ['3', L('как 1, но ADX ≥ 30 + MACD 12/26/9', 'wie 1, aber ADX ≥ 30 + MACD 12/26/9', 'as 1 but ADX ≥ 30 + MACD 12/26/9'), '1 мин', '67', '61%', '65%'],
      ['4', L('как 1 + Vortex 7 + MACD 6/13/5', 'wie 1 + Vortex 7 + MACD 6/13/5', 'as 1 + Vortex 7 + MACD 6/13/5'), '3 мин', '120', '60%', '54%'],
    ],
    note: L('«Отбор» — первые 3 дня, на них сочетание выбрано; «Проверка» — 2 других дня, которые в выбор не входили (честная цифра). RSI ничего не добавил: после серии больших свечей он и так на стороне импульса. Пресет 1 — простой и надёжный, 3 — реже, но строже. Можно включить несколько пресетов сразу. По тренду (без «против импульса») на истории проигрывал. Это история, не гарантия.',
      '„Auswahl“ = die ersten 3 Tage, auf denen die Kombination gewählt wurde; „Prüfung“ = 2 andere Tage, die nicht in die Wahl eingingen (ehrliche Zahl). RSI brachte nichts: nach großen Kerzen steht er ohnehin auf der Seite des Impulses. Preset 1 einfach und verlässlich, 3 seltener, aber strenger. Mehrere Presets gleichzeitig möglich. Mit dem Trend verlor im Test. Historie, keine Garantie.',
      '"Choice" = the first 3 days the combination was chosen on; "Check" = 2 other days not used for the choice (the honest number). RSI added nothing: after big candles it is on the impulse side anyway. Preset 1 simple and reliable, 3 rarer but stricter. Several presets at once allowed. With the trend lost in the test. History, not a guarantee.'),
  }, {
    title: L('Результаты проверки на истории (30.10.2026, ~5 дней, 13 пар)', 'Testergebnisse auf der Historie (30.10.2026, ~5 Tage, 13 Paare)', 'Backtest results (30.10.2026, ~5 days, 13 pairs)'),
    cols: [L('Вариант', 'Variante', 'Variant'), L('Сигналов в день', 'Signale pro Tag', 'Signals per day'), ...[1, 2, 3, 5].map(m => L(`${m} мин`, `${m} Min`, `${m} min`))],
    rows: [
      [L('По тренду, без фильтров', 'Mit dem Trend, ohne Filter', 'With the trend, no filters'), '5,5', '37%', '41%', '30%', '48%'],
      [L('По тренду + M5 + M15', 'Mit dem Trend + M5 + M15', 'With the trend + M5 + M15'), '3,9', '42%', '32%', '37%', '58%'],
      [L('Против импульса, свечи 0,8 ATR', 'Gegen den Impuls, Kerzen 0,8 ATR', 'Against the impulse, candles 0.8 ATR'), '6,5', '66%', '56%', '69%', '50%'],
      [L('Против импульса + M15', 'Gegen den Impuls + M15', 'Against the impulse + M15'), '4,9', '63%', '63%', '67%', '46%'],
      [L('Против импульса, свечи 0,6 ATR', 'Gegen den Impuls, Kerzen 0,6 ATR', 'Against the impulse, candles 0.6 ATR'), '26,6', '60%', '58%', '58%', '50%'],
      [L('Против импульса 0,6 + M15', 'Gegen den Impuls 0,6 + M15', 'Against the impulse 0.6 + M15'), '15,6', '58%', '63%', '57%', '49%'],
    ],
    note: L('Выводы: по тренду проигрывает во всех вариантах, M5/M15 это не исправляют. Против импульса выигрывает на 1–3 минутах, на 5 минутах эффект пропадает. Самый надёжный — против импульса, свечи от 0,6 ATR (131 сигнал, ~58–60 %). Это история, не гарантия — проверяйте на демо.',
      'Fazit: mit dem Trend verliert in allen Varianten, M5/M15 ändern das nicht. Gegen den Impuls gewinnt auf 1–3 Minuten, auf 5 Minuten verschwindet der Effekt. Am verlässlichsten: gegen den Impuls, Kerzen ab 0,6 ATR (131 Signale, ~58–60 %). Historie, keine Garantie – auf Demo prüfen.',
      'Conclusion: with the trend loses in every variant, M5/M15 do not fix it. Against the impulse wins at 1–3 minutes, gone at 5 minutes. Most reliable: against the impulse, candles from 0.6 ATR (131 signals, ~58–60 %). History, not a guarantee – test on demo.'),
  }],
};

// Settings shown in blocks: each block says what it decides and which way is stricter. Keys not listed go to the end.
const MARKET_GROUP = { title: L('0 · Рынок (когда вообще давать сигналы)', '0 · Markt (wann überhaupt Signale)', '0 · Market (when to signal at all)'),
  desc: L('Сигнал только на живом рынке: последние 10 свечей в среднем не меньше X × обычного размера, и среди них есть большая свеча (≥ Y × обычной). И никогда CALL прямо под сопротивлением, PUT прямо над поддержкой: до уровня по ходу сделки должно быть не меньше Z средних свечей. 0 = выкл.',
    'Signal nur bei lebhaftem Markt: die letzten 10 Kerzen im Schnitt mindestens X × normal, darunter eine große (≥ Y × normal). Nie CALL direkt unter Widerstand, nie PUT direkt über Unterstützung: bis zum Level in Handelsrichtung mindestens Z Durchschnittskerzen. 0 = aus.',
    'Signal only on a lively market: the last 10 candles average at least X × normal, one of them big (≥ Y × normal). Never CALL right under resistance, never PUT right above support: at least Z average candles to the level in the trade direction. 0 = off.'),
  keys: ['mk_vol', 'mk_big', 'mk_room'] };
const GROUPS = {
  n_big: [
    { title: L('Режим большой свечи в слабом тренде', 'Modus große Kerze im schwachen Trend', 'Big candle in a slow trend'),
      desc: L('Выключено — прежнее правило (тело × среднее). Режим A — вход сразу после большой свечи, режим C — после свечи подтверждения. Профили сверху включают режим сами.', 'Aus = bisherige Regel (Körper × Durchschnitt). Modus A = Einstieg direkt nach der großen Kerze, C = nach einer Bestätigungskerze. Die Profile oben schalten den Modus selbst ein.', 'Off = the old rule (body × average). Mode A = entry right after the big candle, C = after a confirming candle. The profiles above switch this on themselves.'),
      keys: ['bs_on', 'bs_mode', 'expiry', 'bs_gap'] },
    { title: L('Большая свеча', 'Große Kerze', 'Big candle'), desc: L('Сравнение с медианой предыдущих свечей: больше множитель — строже.', 'Vergleich mit dem Median der vorigen Kerzen: größerer Faktor = strenger.', 'Compared with the median of the previous candles: bigger factor = stricter.'),
      keys: ['bs_lookback', 'bs_body', 'bs_use_range', 'bs_range', 'bs_ratio', 'bs_min_atr'] },
    { title: L('Тренд', 'Trend', 'Trend'), desc: L('Направление по EMA и наклону, сила отдельно. ADX здесь выключен (мин. и макс. ADX = 0).', 'Richtung nach EMA und Neigung, Stärke getrennt. ADX ist hier aus (Min. und Max. ADX = 0).', 'Direction from EMA and slope, strength separately. ADX is off here (min and max ADX = 0).'),
      keys: ['bs_trend', 'bs_against', 'bs_ema_fast', 'bs_ema_slow', 'bs_slope', 'bs_max_slope', 'bs_max_dist', 'min_adx', 'max_adx'] },
    { title: L('Прежнее правило', 'Bisherige Regel', 'Old rule'), desc: L('Работает, когда режим выключен.', 'Gilt, wenn der Modus aus ist.', 'Used when the mode is off.'), keys: ['big_body', 'big_period'] },
  ],
  n_levelrev: [
    MARKET_GROUP,
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
  n_strongtrend: [
    { title: L('1 · Основное', '1 · Grundlegendes', '1 · Basics'),
      desc: L('Вход по тренду в его начале. «Против импульса»: сигнал в обратную сторону — на откат после серии больших свечей. M5 / M15: тренд на старшем таймфрейме должен идти в ту же сторону, что и импульс на M1 (каждый можно включить или выключить).',
        'Einstieg mit dem Trend an seinem Anfang. „Gegen den Impuls“: Signal in die Gegenrichtung – auf den Rücklauf nach großen Kerzen. M5 / M15: der Trend auf dem höheren Zeitrahmen muss in dieselbe Richtung wie der M1-Impuls gehen (jeweils an/aus).',
        'Entry with the trend at its start. "Against the impulse": signal the other way – on the pullback after big candles. M5 / M15: the higher-timeframe trend must go the same way as the M1 impulse (each on/off).'),
      keys: ['expiry', 'st_buy', 'st_sell', 'st_fade', 'st_use_m5', 'st_use_m15'] },
    { title: L('2 · Сила тренда (ADX)', '2 · Trendstärke (ADX)', '2 · Trend strength (ADX)'),
      desc: L('ADX только что пробил порог (за последние N свечей) и растёт — тренд набирает силу. «ADX не выше» отсекает конец тренда, когда ADX уже очень высокий. Разрыв DI+/DI− — насколько ясно направление.',
        'ADX hat gerade die Schwelle überschritten (in den letzten N Kerzen) und steigt – der Trend wird stärker. „ADX höchstens“ schneidet das Trendende ab. Abstand DI+/DI− = wie klar die Richtung ist.',
        'ADX has just crossed the threshold (within the last N candles) and is rising. "ADX at most" cuts off the end of a trend. DI+/DI− gap = how clear the direction is.'),
      keys: ['st_adx', 'st_fresh', 'st_adx_max', 'st_di_gap'] },
    { title: L('3 · Большие свечи', '3 · Große Kerzen', '3 · Big candles'),
      desc: L('Из последних N свечей не меньше K идут по тренду с телом ≥ X × ATR; сигнальная свеча тоже большая и с плотным телом.',
        'Von den letzten N Kerzen mindestens K in Trendrichtung mit Körper ≥ X × ATR; die Signalkerze ebenfalls groß mit festem Körper.',
        'Of the last N candles at least K go the trend way with a body ≥ X × ATR; the signal candle too, with a solid body.'),
      keys: ['st_big_n', 'st_big_k', 'st_body_atr'] },
    { title: L('4 · Не опоздать', '4 · Nicht zu spät', '4 · Not too late'),
      desc: L('Не больше N трендовых свечей подряд и цена не дальше X ATR от EMA — чтобы не входить в конце движения. И не входить прямо в уровень.',
        'Höchstens N Trendkerzen in Folge und der Preis höchstens X ATR von der EMA – kein Einstieg am Ende der Bewegung. Und nicht direkt in ein Level.',
        'At most N trend candles in a row and price at most X ATR from the EMA – no entry at the end of the move. And not straight into a level.'),
      keys: ['st_max_run', 'st_ema', 'st_max_ext', 'room_check', 'room_min'] },
    { title: L('5 · Доп. индикаторы (по желанию)', '5 · Zusatz-Indikatoren (optional)', '5 · Extra indicators (optional)'),
      desc: L('Каждый включается отдельно и только подтверждает направление импульса: Vortex — VI+ выше VI− для роста; MACD — линия выше сигнальной; RSI — выше средней линии (50), «не выше» = 0 без ограничения. Готовые сочетания — в пресетах и в таблице результатов.',
        'Jeder einzeln schaltbar, bestätigt nur die Impulsrichtung: Vortex – VI+ über VI− bei Anstieg; MACD – Linie über Signal; RSI – über der Mittellinie (50), „höchstens“ 0 = ohne Grenze. Fertige Kombinationen in den Presets und der Ergebnistabelle.',
        'Each switchable, only confirms the impulse direction: Vortex – VI+ above VI− for up; MACD – line above signal; RSI – above the middle line (50), "at most" 0 = no limit. Ready combinations in the presets and the results table.'),
      keys: ['st_use_vortex', 'st_vortex_period', 'st_use_macd', 'st_macd_fast', 'st_macd_slow', 'st_macd_signal', 'st_use_rsi', 'st_rsi_period', 'st_rsi_mid', 'st_rsi_max'] },
  ],
  n_vortex: [
    { title: L('Индикаторы (включайте любые)', 'Indikatoren (beliebig an/aus)', 'Indicators (switch any on/off)'),
      desc: L('Можно оставить один, два или все три. Первый включённый даёт сигнал своим пересечением (Vortex: VI+/VI−, MACD: линия/сигнальная, ADX один: DI+/DI−), остальные должны смотреть в ту же сторону. ADX ещё проверяет силу тренда: не меньше заданного (25 = есть тренд). RSI только подтверждает: для CALL выше средней линии (50), но не выше «перегрева» (70); для PUT зеркально. Один RSI сигнал не даёт.',
        'Einer, zwei oder alle drei. Der erste eingeschaltete gibt das Signal mit seiner Kreuzung (Vortex: VI+/VI−, MACD: Linie/Signal, ADX allein: DI+/DI−), die anderen müssen in dieselbe Richtung zeigen. ADX prüft zusätzlich die Trendstärke (25 = Trend). RSI bestätigt nur: für CALL über der Mittellinie (50), aber unter „überhitzt“ (70); PUT gespiegelt. RSI allein gibt kein Signal.',
        'One, two or all three. The first one on gives the signal with its cross (Vortex: VI+/VI−, MACD: line/signal, ADX alone: DI+/DI−), the others must point the same way. ADX also checks trend strength (25 = trend). RSI only confirms: for CALL above the middle line (50) but below "overheated" (70); PUT mirrored. RSI alone gives no signal.'),
      keys: ['vx_use_vortex', 'vortex_period', 'vx_use_macd', 'macd_fast', 'macd_slow', 'macd_signal', 'vx_use_adx', 'vx_adx_period', 'vx_adx_min',
        'vx_use_rsi', 'vx_rsi_period', 'vx_rsi_mid', 'vx_rsi_max'] },
  ],
  n_deeprev: [
    { title: L('1 · Основное', '1 · Grundlegendes', '1 · Basics'),
      desc: L('Направления, экспирация и минимальная уверенность (1–10). CALL — разворот вверх после падения; PUT — зеркально после роста (по умолчанию выкл.). Уверенность 7–8 = только лучшие сигналы.',
        'Richtungen, Ablaufzeit und Mindest-Zuversicht (1–10). CALL = Umkehr nach oben nach einem Fall; PUT = gespiegelt nach einem Anstieg (standardmäßig aus). 7–8 = nur die besten.',
        'Directions, expiry and minimum confidence (1–10). CALL = turn up after a fall; PUT = mirror after a rise (off by default). 7–8 = only the best.'),
      keys: ['expiry', 'dr_buy', 'dr_sell', 'dr_min_conf'] },
    { title: L('2 · Уровень (M15 и M5)', '2 · Level (M15 und M5)', '2 · Level (M15 and M5)'),
      desc: L('Поддержка из разворотных точек M15 и M5. Без чёткого уровня сигнала нет (это правило не выключается). Больше касаний = надёжнее уровень.',
        'Unterstützung aus Wendepunkten von M15 und M5. Ohne klares Level kein Signal (nicht abschaltbar). Mehr Berührungen = verlässlicher.',
        'Support from M15 and M5 swing points. No clear level = no signal (cannot be switched off). More touches = more reliable.'),
      keys: ['dr_touches', 'dr_zone_atr', 'dr_near_atr'] },
    { title: L('3 · Падение и реакция (M5)', '3 · Fall und Reaktion (M5)', '3 · Fall and reaction (M5)'),
      desc: L('Перед уровнем 5+ медвежьих свечей подряд или импульс в ATR. Затем реакция: длинная нижняя тень, молот, бычье поглощение или закрытие обратно выше поддержки. Сильная медвежья свеча, закрывшаяся под уровнем, = пробой, сигнала нет.',
        'Vor dem Level 5+ rote Kerzen in Folge oder ein Impuls in ATR. Dann Reaktion: langer unterer Docht, Hammer, bullisches Engulfing oder Schluss zurück über der Unterstützung. Starke rote Kerze unter dem Level = Bruch, kein Signal.',
        'Before the level 5+ red candles in a row or an impulse in ATR. Then a reaction: long lower wick, hammer, bullish engulfing or close back above support. A strong red candle closing below = break, no signal.'),
      keys: ['dr_use_fall', 'dr_bear', 'dr_imp_atr', 'dr_use_pattern', 'dr_use_break', 'dr_break_atr'] },
    { title: L('4 · RSI 14 на M5', '4 · RSI 14 auf M5', '4 · RSI 14 on M5'),
      desc: L('RSI ниже 30 или бычья дивергенция — но не сигнал сам по себе. Нужен ещё возврат RSI выше 30 (пересечение снизу вверх).',
        'RSI unter 30 oder bullische Divergenz – aber kein Signal allein. Dazu muss RSI wieder über 30 kreuzen.',
        'RSI below 30 or bullish divergence – not a signal by itself. RSI must also cross back above 30.'),
      keys: ['dr_use_rsi', 'dr_rsi_lo', 'dr_use_cross'] },
    { title: L('5 · Когда пропускать', '5 · Wann auslassen', '5 · When to skip'),
      desc: L('Сильный нисходящий тренд M15 — только с дивергенцией. Боковик на M15 (диапазон 12 свечей меньше X ATR) — пропуск. Резкая свеча M1 (больше X средних) — пропуск. Новости — общий новостной фильтр программы.',
        'Starker Abwärtstrend M15 – nur mit Divergenz. Seitwärts auf M15 (Spanne 12 Kerzen unter X ATR) – auslassen. Heftige M1-Kerze (über X Durchschnitt) – auslassen. Nachrichten – allgemeiner Nachrichtenfilter.',
        'Strong M15 downtrend – only with divergence. Sideways M15 (12-candle range below X ATR) – skip. Violent M1 candle (above X average) – skip. News – the general news filter.'),
      keys: ['dr_use_trend', 'dr_use_flat', 'dr_flat_atr', 'dr_use_spike', 'dr_spike'] },
    { title: L('6 · Вход на M1', '6 · Einstieg auf M1', '6 · Entry on M1'),
      desc: L('Вход только когда свеча M1 закрылась выше максимума сигнальной свечи M5 или локального максимума M1.',
        'Einstieg erst, wenn eine M1-Kerze über dem Hoch der M5-Signalkerze oder dem lokalen M1-Hoch schließt.',
        'Entry only when an M1 candle closes above the M5 signal candle high or the local M1 high.'),
      keys: ['dr_use_m1'] },
  ],
  n_ma25: [
    { title: L('1 · Основное', '1 · Grundlegendes', '1 · Basics'),
      desc: L('Какие средние пересекаются, направления и экспирация.', 'Welche Durchschnitte sich kreuzen, Richtungen und Ablaufzeit.', 'Which averages cross, directions and expiry.'),
      keys: ['m25_expiry', 'm25_fast', 'm25_fast_type', 'm25_slow', 'm25_slow_type', 'm25_buy', 'm25_sell', 'm25_live'] },
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
  // 02.11.2026: the lines must really have crossed on the closed candle; the early tick-based signal is optional (m25_live).
  if (name === 'n_ma25') return p.m25_live ? 'live' : 'closed';
  if (name === 'n_big' && (p.bs_on || (settings.strat_presets?.n_big || []).length)) return 'closed'; // big-candle mode: closed candles only
  if (name === 'n_sharp' && (settings.strat_presets?.n_sharp || []).length) return 'legacy'; // profiles use the Stochastic rule, not the bot logic
  if ((name === 'n_big' || name === 'n_sharp') && p.bot) return 'both';
  // Only the last fully closed candle counts – unless the early V-reversal is on (then also inside the forming candle).
  // Stochastic zone return: at the touch inside the forming candle (rx_live) or after the candle closed.
  if (name === 'n_rsi8020') return (p.rx_osc || 'STOCH') === 'STOCH' && p.rx_live !== false ? 'live' : 'closed';
  if (name === 'n_levelrev') return p.lr_b_early ? 'both' : 'closed';
  if (name === 'n_deeprev' || name === 'n_strongtrend' || name === 'n_trendpull') return 'closed';
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

// Levels from swing points (2 candles on each side) of the given candles, clustered into zones of width zw.
function swingZones(cands, side, zw, skipLast) {
  const pts = [];
  for (let j = 2; j < cands.length - 2 - skipLast; j++) {
    const v = side > 0 ? cands[j].high : cands[j].low;
    let ok = true; for (let q = j - 2; q <= j + 2; q++) if (q !== j && (side > 0 ? cands[q].high > v : cands[q].low < v)) ok = false;
    if (ok) pts.push(v);
  }
  pts.sort((a, b) => a - b);
  const out = [];
  for (const v of pts) { const z = out[out.length - 1]; if (z && v - z.lo <= zw) { z.hi = v; z.n++; } else out.push({ lo: v, hi: v, n: 1 }); }
  return out;
}

// One direction of n_deeprev: dir 1 = CALL after a fall into support, −1 = PUT after a rise into resistance (mirror).
// Returns a signal, or { why } with the first rule that failed.
function deepRev(m1, m5, m15, p, dir, on) {
  const ru = dir > 0, i5 = m5.length - 1, k5 = m5[i5];
  const atr5 = I.atr(m5, 14)[i5], atr15 = I.atr(m15, 14)[m15.length - 1];
  if (!(atr5 > 0) || !(atr15 > 0)) return { why: 'ATR' };
  const lowOf = k => ru ? k.low : k.high, ext = (a, b) => ru ? Math.min(a, b) : Math.max(a, b);
  const beyond = (a, b) => ru ? a < b : a > b; // a is further in the fall direction than b
  // 1. Level: swing points of M15 (whole history) and M5 (not the last 8 candles – the level must already exist).
  const zw = (Number(p.dr_zone_atr) || 0.5) * atr5, side = ru ? -1 : 1;
  const zones = swingZones(m15, side, zw, 0).concat(swingZones(m5, side, zw, 8))
    .sort((a, b) => a.lo - b.lo).reduce((acc, z) => { const l = acc[acc.length - 1]; if (l && z.lo - l.hi <= zw) { l.hi = Math.max(l.hi, z.hi); l.n += z.n; } else acc.push({ ...z }); return acc; }, [])
    .filter(z => z.n >= (Number(p.dr_touches) || 2));
  let tip = lowOf(m5[i5]); for (let j = i5 - 3; j < i5; j++) tip = ext(tip, lowOf(m5[j]));
  const near = (Number(p.dr_near_atr) || 0.7) * atr5;
  const lvl = zones.map(z => ({ ...z, d: ru ? tip - z.hi : z.lo - tip })).filter(z => z.d <= near && z.d >= -3 * zw).sort((a, b) => Math.abs(a.d) - Math.abs(b.d))[0];
  if (!lvl) return { why: 'нет чёткого уровня рядом' };
  const Lv = ru ? lvl.hi : lvl.lo, Lfar = ru ? lvl.lo : lvl.hi;
  // 2. The fall: ≥ dr_bear opposite candles in a row on M5 before the reaction, or an impulse of ≥ dr_imp_atr × ATR.
  let rb = i5; // reaction candle: the last closed M5, or the one before it
  if (I.dirOf(m5[i5]) !== dir && I.dirOf(m5[i5 - 1]) === dir) rb = i5 - 1;
  let n = 0; for (let j = rb - 1; j > 0 && I.dirOf(m5[j]) === -dir; j--) n++;
  let top = -Infinity * dir; for (let j = Math.max(0, rb - 10); j < rb; j++) top = ru ? Math.max(top, m5[j].high) : Math.min(top, m5[j].low);
  const move = Math.abs(top - tip) / atr5;
  const fallOk = n >= (Number(p.dr_bear) || 5) || move >= (Number(p.dr_imp_atr) || 3);
  if (on('dr_use_fall') && !fallOk) return { why: `падение слабое (${n} св., ${move.toFixed(1)} ATR)` };
  // 3. Reaction on M5: long wick, hammer, engulfing, or close back past the level.
  const rc = m5[rb], pv = m5[rb - 1], rr = rc.high - rc.low, bd = Math.abs(rc.close - rc.open);
  const wick = ru ? Math.min(rc.open, rc.close) - rc.low : rc.high - Math.max(rc.open, rc.close);
  const nose = ru ? rc.high - Math.max(rc.open, rc.close) : Math.min(rc.open, rc.close) - rc.low;
  const pats = [];
  if (rr > 0 && wick >= 0.5 * rr) pats.push(ru ? 'длинная нижняя тень' : 'длинная верхняя тень');
  if (rr > 0 && wick >= 2 * bd && nose <= Math.max(bd, 0.15 * rr)) pats.push(ru ? 'молот' : 'падающая звезда');
  if (I.dirOf(rc) === dir && I.dirOf(pv) === -dir && (ru ? rc.close >= pv.open && rc.open <= pv.close : rc.close <= pv.open && rc.open >= pv.close)) pats.push(ru ? 'бычье поглощение' : 'медвежье поглощение');
  if (beyond(lowOf(rc), Lfar) && !beyond(rc.close, Lv)) pats.push(ru ? 'закрытие обратно выше поддержки' : 'закрытие обратно ниже сопротивления');
  if (on('dr_use_pattern') && !pats.length) return { why: 'нет реакции цены на M5' };
  // 7. Broken level: the last closed M5 is still beyond the level after a strong candle.
  if (on('dr_use_break')) for (let j = i5 - 2; j <= i5; j++) {
    const k = m5[j];
    if (I.dirOf(k) === -dir && Math.abs(k.close - k.open) >= (Number(p.dr_break_atr) || 1.2) * atr5 && beyond(k.close, Lfar) && beyond(m5[i5].close, Lfar))
      return { why: 'уровень пробит сильной свечой' };
  }
  // 4–5. RSI 14 on M5: below 30 (above 70) or divergence, and crossing 30 (70) back.
  const rs = I.rsi(m5.map(k => k.close), 14), lo = Number(p.dr_rsi_lo) || 30, lvlR = ru ? lo : 100 - lo;
  let rmin = ru ? 100 : 0; for (let j = Math.max(0, rb - 6); j <= i5; j++) if (rs[j] != null) rmin = ru ? Math.min(rmin, rs[j]) : Math.max(rmin, rs[j]);
  const rsiExt = ru ? rmin < lvlR : rmin > lvlR;
  // Divergence: the newest extreme (last 4 candles) beyond the previous one (6–24 candles back), RSI not.
  let j2 = i5; for (let j = i5 - 3; j <= i5; j++) if (beyond(lowOf(m5[j]), lowOf(m5[j2]))) j2 = j;
  let j1 = -1; for (let j = Math.max(1, i5 - 24); j <= i5 - 6; j++) if (j1 < 0 || beyond(lowOf(m5[j]), lowOf(m5[j1]))) j1 = j;
  const div = j1 > 0 && rs[j1] != null && rs[j2] != null && beyond(lowOf(m5[j2]), lowOf(m5[j1])) && (ru ? rs[j2] > rs[j1] + 2 : rs[j2] < rs[j1] - 2);
  if (on('dr_use_rsi') && !rsiExt && !div) return { why: `RSI ${rmin.toFixed(0)} без зоны и без дивергенции` };
  let cross = false; for (let j = Math.max(1, i5 - 2); j <= i5; j++) if (rs[j - 1] != null && (ru ? rs[j - 1] < lvlR && rs[j] >= lvlR : rs[j - 1] > lvlR && rs[j] <= lvlR)) cross = true;
  if (on('dr_use_cross') && !cross) return { why: `RSI ещё не пересёк ${lvlR} обратно` };
  // 8. Strong M15 trend against the trade: only with divergence as extra confirmation.
  const c15 = m15.map(k => k.close), e20 = I.ema(c15, 20), e50 = I.ema(c15, 50), q = m15.length - 1;
  const slope = (e20[q] - e20[q - 3]) / atr15;
  const strongTrend = e50[q] != null && (ru ? c15[q] < e50[q] && slope < -0.3 : c15[q] > e50[q] && slope > 0.3);
  if (on('dr_use_trend') && strongTrend && !div) return { why: 'сильный тренд M15 против сделки, нет дивергенции' };
  // 9. Sideways market on M15 / sharp move on M1.
  let fh = -Infinity, fl = Infinity; for (let j = q - 11; j <= q; j++) { fh = Math.max(fh, m15[j].high); fl = Math.min(fl, m15[j].low); }
  if (on('dr_use_flat') && fh - fl < (Number(p.dr_flat_atr) || 3) * atr15) return { why: 'боковик на M15' };
  const i1 = m1.length - 1; let a1 = 0; for (let j = i1 - 20; j < i1; j++) a1 += m1[j].high - m1[j].low; a1 /= 20;
  if (on('dr_use_spike') && m1[i1].high - m1[i1].low > (Number(p.dr_spike) || 3) * a1) return { why: 'резкое движение на M1' };
  // 6. M1 entry: the close breaks the reaction candle's high (low) or the last local M1 high (low), freshly.
  let loc = ru ? -Infinity : Infinity; for (let j = i1 - 4; j < i1; j++) loc = ru ? Math.max(loc, m1[j].high) : Math.min(loc, m1[j].low);
  const trig = ru ? Math.min(rc.high, loc) : Math.max(rc.low, loc);
  const m1ok = ru ? m1[i1].close > trig && m1[i1 - 1].close <= trig : m1[i1].close < trig && m1[i1 - 1].close >= trig;
  if (on('dr_use_m1') && !m1ok) return { why: 'нет пробоя на M1' };
  // Confidence 1–10.
  let conf = 5 + (div ? 1 : 0) + (rsiExt && (ru ? rmin < lvlR - 5 : rmin > lvlR + 5) ? 1 : 0) + (lvl.n >= 3 ? 1 : 0)
    + (pats.some(t => /поглощение/.test(t)) ? 1 : 0) + (!strongTrend ? 1 : 0) - (pats.length ? 0 : 2) - (m1ok ? 0 : 2);
  conf = Math.max(1, Math.min(10, conf));
  if (conf < (Number(p.dr_min_conf) || 0)) return { why: `уверенность ${conf}/10 ниже порога` };
  const dec = Math.max(2, -Math.floor(Math.log10(atr5)) + 2);
  const lines = [
    `${ru ? 'CALL ↑' : 'PUT ↓'} · уверенность ${conf}/10 · анализ M15/M5, вход M1`,
    `${ru ? 'поддержка' : 'сопротивление'} ${lvl.lo.toFixed(dec)}–${lvl.hi.toFixed(dec)} (${lvl.n} касания)`,
    `${ru ? 'медвежьих' : 'бычьих'} свечей подряд: ${n}, ход ${move.toFixed(1)} ATR`,
    `RSI M5 ${rs[i5] != null ? rs[i5].toFixed(0) : '–'} (экстремум ${rmin.toFixed(0)}), пересёк ${lvlR}: ${cross ? 'да' : 'нет'}, дивергенция: ${div ? 'есть' : 'нет'}`,
    `паттерн: ${pats.join(', ') || 'нет'}`,
    `M1: ${m1ok ? 'пробой ' + trig.toFixed(dec) : 'пробоя нет'}`,
    `тренд M15: ${strongTrend ? 'сильный против сделки' : 'не мешает'}`,
    'не гарантия · проверяйте на демо',
  ];
  const txt = lines.join(' · ');
  const s = sig(dir, conf * 10, L(txt, txt, txt), Number(p.expiry) || 180);
  s.bar = rc.time; // one signal per M5 reaction candle
  return s;
}

const S = {
  n_sharp(x, p) {
    if (p.bot) return botSig(BP.sharpSeries(x.c, x.last, p)); // Telegram-bot logic
    const min = p.sharp_min || 4;
    if (p.sharp_stoch !== false) {
      // Trigger: %K crosses the zone line on the last closed candle (from below 20 to ≥ 20 → CALL, from above 80 to ≤ 80 → PUT),
      // and a series of ≥ sharp_min candles against that direction ended within the last sharp_wait candles.
      const i = x.last, st = I.stoch(x.c, Number(p.sharp_k) || 14, Number(p.sharp_ks) || 3, 3).k;
      const lo = Number(p.sharp_low) || 20, hi = Number(p.sharp_high) || 80, k0 = st[i - 1], k1 = st[i];
      if (k0 === null || k1 === null) return null;
      const dir = k0 < lo && k1 >= lo ? 1 : k0 > hi && k1 <= hi ? -1 : 0;
      if (!dir || (!p.sharp_mirror && dir < 0)) return null;
      let best = 0;
      for (let j = i; j >= Math.max(1, i - (Number(p.sharp_wait) || 10)); j--) {
        const r = runLength(x.c, j); if (r.d === -dir && r.n > best) best = r.n;
      }
      if (best < min) return null;
      if (p.sharp_rsi) { const r = x.rsi(14)[i]; if (dir > 0 ? r > 45 : r < 55) return null; }
      return Object.assign(sig(dir, 70 + (best - min) * 8, dir > 0
        ? L(`${best} красных свечей, стохастик вышел вверх из зоны ${lo}`, `${best} rote Kerzen, Stochastik verlässt die ${lo}-Zone nach oben`, `${best} red candles, Stochastic turned up out of the ${lo} zone`)
        : L(`${best} зелёных свечей, стохастик вышел вниз из зоны ${hi}`, `${best} grüne Kerzen, Stochastik verlässt die ${hi}-Zone nach unten`, `${best} green candles, Stochastic turned down out of the ${hi} zone`), p.sharp_expiry), { noFlip: true });
    }
    const { d, n } = runLength(x.c, x.last);
    if (n < min || (!p.sharp_mirror && d > 0)) return null;
    if (p.sharp_rsi) { const r = x.rsi(14)[x.last]; if (d < 0 ? r > 35 : r < 65) return null; }
    return sig(-d, 70 + (n - min) * 8, d < 0
      ? L(`${n} красных свечей подряд`, `${n} rote Kerzen in Folge`, `${n} red candles in a row`)
      : L(`${n} зелёных свечей подряд`, `${n} grüne Kerzen in Folge`, `${n} green candles in a row`), p.sharp_expiry);
  },
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
  // Confirmed reversal after a deep fall (user's prompt of 29.10.2026). M15/M5 give the levels, the fall, the reaction
  // and RSI 14; M1 gives the entry (break of the signal candle's high). CALL; with dr_sell also the mirror (PUT after
  // a rise into resistance). Every rule can be switched off except the level. The card lists every check.
  // Strong trend, entry at its start (user, 30.10.2026): ADX has just crossed a strong threshold and is rising, but is
  // not yet so high that the trend is ending; DI+/DI− clearly apart; big candles in the trend direction one after the
  // other; not late (few trend candles so far, price not stretched far from the EMA). One signal per trend start.
  n_strongtrend(x, p) {
    const c = x.c, i = x.last, a = x.adx, atr = x.atr[i], k = c[i];
    if (!a[i] || !a[i - 3] || !(atr > 0)) return null;
    const thr = Number(p.st_adx) || 25, fresh = Number(p.st_fresh) || 3;
    // ADX crossed the threshold within the last st_fresh candles and keeps rising.
    let crossAt = -1; for (let j = i; j > i - fresh && j > 0; j--) if (a[j] && a[j - 1] && a[j].adx >= thr && a[j - 1].adx < thr) { crossAt = j; break; }
    if (crossAt < 0) return null;
    if (!(a[i].adx > a[i - 2].adx)) return null;
    if (p.st_adx_max && a[i].adx > p.st_adx_max) return null; // already very high: the trend may be ending
    const dir = Math.sign(a[i].pdi - a[i].mdi);
    if (!dir || Math.abs(a[i].pdi - a[i].mdi) < (Number(p.st_di_gap) || 0)) return null;
    // Extra confirmations of the impulse, each switchable with its own settings: Vortex (VI+ above VI− for up),
    // MACD (line above signal for up), RSI (above the middle line for up; optional upper limit, 0 = none).
    if (p.st_use_vortex) {
      const v = I.vortex(c, Number(p.st_vortex_period) || 14)[i];
      if (!v || Math.sign(v.plus - v.minus) !== dir) return null;
    }
    if (p.st_use_macd) {
      const mc = I.macd(x.close, Number(p.st_macd_fast) || 12, Number(p.st_macd_slow) || 26, Number(p.st_macd_signal) || 9);
      if (mc.line[i] == null || mc.signal[i] == null || Math.sign(mc.line[i] - mc.signal[i]) !== dir) return null;
    }
    if (p.st_use_rsi) {
      const r = x.rsi(Number(p.st_rsi_period) || 14)[i], mid = Number(p.st_rsi_mid ?? 50), mx = Number(p.st_rsi_max) || 0;
      if (r == null || (dir > 0 ? r <= mid : r >= 100 - mid)) return null;
      if (mx && (dir > 0 ? r >= mx : r <= 100 - mx)) return null;
    }
    // Big candles: of the last st_big_n, at least st_big_k go the trend way with a body ≥ st_body_atr × ATR;
    // the signal candle itself too, with a solid body (≥ 50 % of its range).
    const n = Number(p.st_big_n) || 3, need = Number(p.st_big_k) || 2, bmin = (Number(p.st_body_atr) || 0) * atr;
    let big = 0; for (let j = i - n + 1; j <= i; j++) if (I.dirOf(c[j]) === dir && I.body(c[j]) >= bmin) big++;
    if (big < need) return null;
    if (I.dirOf(k) !== dir || I.body(k) < bmin || I.body(k) < 0.5 * (k.high - k.low)) return null;
    // Not late: how many trend candles in a row so far, and how far the price is from the EMA.
    let run = 0; for (let j = i; j >= 0 && I.dirOf(c[j]) === dir; j--) run++;
    if (p.st_max_run && run > p.st_max_run) return null;
    const e = x.ema(Number(p.st_ema) || 20)[i], ext = e == null ? 0 : (k.close - e) * dir / atr;
    if (ext < 0) return null; // price on the wrong side of the EMA
    if (p.st_max_ext && ext > p.st_max_ext) return null;
    // Higher timeframes (switchable): the trend on M5 / M15 goes the same way as the impulse (close on the trend side
    // of EMA 20 and the EMA pointing that way).
    const htf = cands => {
      if (!cands || cands.length < 25) return 0;
      const cl = cands.map(q => q.close), e = I.ema(cl, 20), L = cl.length - 1;
      return cl[L] > e[L] && e[L] > e[L - 2] ? 1 : cl[L] < e[L] && e[L] < e[L - 2] ? -1 : 0;
    };
    const tf = [p.st_use_m5 && 'M5', p.st_use_m15 && 'M15'].filter(Boolean);
    for (const t of tf) if (htf(x.ctx?.[t]) !== dir) return null;
    // Against the impulse (st_fade): after such a run the price on OTC minutes more often snaps back – trade that.
    const fade = !!p.st_fade, out = fade ? -dir : dir;
    if ((out > 0 && p.st_buy === false) || (out < 0 && p.st_sell === false)) return null;
    const tfTxt = tf.length ? ` · ${tf.join('+')} в ту же сторону` : '', tfDe = tf.length ? ` · ${tf.join('+')} gleich` : '', tfEn = tf.length ? ` · ${tf.join('+')} same way` : '';
    const s = sig(out, Math.min(99, 60 + a[i].adx), L(
      `${fade ? 'против импульса: ' : ''}сильный тренд ${dir > 0 ? 'вверх' : 'вниз'}: ADX ${a[i].adx.toFixed(0)} (пробил ${thr}), ${big} из ${n} больших свечей, ${run} св. подряд, от EMA ${ext.toFixed(1)} ATR${tfTxt}`,
      `${fade ? 'gegen den Impuls: ' : ''}starker Trend ${dir > 0 ? 'aufwärts' : 'abwärts'}: ADX ${a[i].adx.toFixed(0)} (über ${thr}), ${big} von ${n} großen Kerzen, ${run} in Folge, ${ext.toFixed(1)} ATR von der EMA${tfDe}`,
      `${fade ? 'against the impulse: ' : ''}strong trend ${dir > 0 ? 'up' : 'down'}: ADX ${a[i].adx.toFixed(0)} (crossed ${thr}), ${big} of ${n} big candles, ${run} in a row, ${ext.toFixed(1)} ATR from the EMA${tfEn}`), Number(p.expiry) || 120);
    s.bar = c[crossAt].time; // one signal per trend start
    return s;
  },
  n_deeprev(x, p) {
    const no = why => { if (globalThis.__drWhy) globalThis.__drWhy.push(why); return null; };
    const m1 = x.c, m5 = x.ctx?.M5, m15 = x.ctx?.M15;
    if (!m5 || m5.length < 40 || !m15 || m15.length < 30) return no('нет истории M5/M15');
    const on = k => p[k] !== false;
    for (const dir of [1, -1]) {
      if (dir > 0 && p.dr_buy === false) continue;
      if (dir < 0 && !p.dr_sell) continue;
      const r = deepRev(m1, m5, m15, p, dir, on);
      if (r && r.dir) return r;
      if (r && r.why) no(r.why);
    }
    return null;
  },
  n_ma25(x, p) { return botSig(BP.ma25(x.c, x.last, p, x.tfMin || 1)); }, // as in the Telegram bot
  n_big(x, p) {
    if (p.bs_on) return bigSlow(x, p);
    if (p.bot) return botSig(BP.bigFade(x.c, x.last, p)); // Telegram-bot logic
    const k = x.c[x.last], ab = avgBody(x.c, p.big_period || 20, x.last - 1), mult = p.big_body || 2.5;
    if (!ab || I.body(k) < mult * ab) return null;
    const r = I.body(k) / ab;
    return sig(-I.dirOf(k), 70 + (r - mult) * 10, L(`крупная свеча ${r.toFixed(1)}× от средней`, `große Kerze ${r.toFixed(1)}× Durchschnitt`, `big candle ${r.toFixed(1)}× average`));
  },
  // Impulse of N candles >= X ATR, then the first candle against it -> rebound.
  // Exhaustion: strong drop, then a candle with long lower wick closing up.
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
  n_rsi8020(x, p) {
    const [hi, lo] = String(p.rsi_levels || '70/30').split('/').map(Number), i = x.last;
    // 04.11.2026 (user): Stochastic %K, signal the moment it crosses the lower line upwards (CALL) / the upper line
    // downwards (PUT). With rx_live the forming candle counts (entry now, one signal per candle).
    if ((p.rx_osc || 'STOCH') === 'STOCH') {
      const k = I.stoch(x.c, Number(p.rx_k) || 14, Number(p.rx_ks) || 3, 3).k, k0 = k[i - 1], k1 = k[i];
      if (k0 === null || k1 === null) return null;
      const d = k0 < lo && k1 >= lo ? 1 : k0 > hi && k1 <= hi ? -1 : 0;
      if (!d) return null;
      // No reason text on the card (user, 04.11.2026: "удали это").
      const out = Object.assign(sig(d, 72, ''), { noFlip: true, noReason: true });
      if (p.rx_live !== false) { out.entry = Math.floor(Date.now() / 1000); out.bar = x.c[i].time; }
      return out;
    }
    const r = x.rsi(p.rsi_period || 14);
    if (r[i - 1] < lo && r[i] >= lo) return sig(1, 72, L(`RSI вернулся выше ${lo}`, `RSI zurück über ${lo}`, `RSI back above ${lo}`));
    if (r[i - 1] > hi && r[i] <= hi) return sig(-1, 72, L(`RSI вернулся ниже ${hi}`, `RSI zurück unter ${hi}`, `RSI back below ${hi}`));
    return null;
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
  // Vortex, MACD and ADX can each be switched on or off (user, 30.10.2026). The first one on gives the trigger (its
  // cross: VI+/VI−, MACD/signal, or DI+/DI− for ADX alone); the others must point the same way (ADX also ≥ vx_adx_min).
  n_vortex(x, p) {
    const i = x.last, useV = p.vx_use_vortex !== false, useM = p.vx_use_macd !== false, useA = !!p.vx_use_adx, useR = !!p.vx_use_rsi;
    if (!useV && !useM && !useA) return null; // RSI alone gives no trigger, only a confirmation
    const ap = Number(p.vx_adx_period) || 14;
    const v = I.vortex(x.c, p.vortex_period || 14), mc = I.macd(x.close, p.macd_fast, p.macd_slow, p.macd_signal), a = ap === 14 ? x.adx : I.adx(x.c, ap);
    const vp = v.map(q => q && q.plus), vm = v.map(q => q && q.minus), dp = a.map(q => q && q.pdi), dm = a.map(q => q && q.mdi);
    const side = (u, w) => (u[i] == null || w[i] == null ? 0 : Math.sign(u[i] - w[i]));
    const d = useV ? cross(vp, vm, i) : useM ? cross(mc.line, mc.signal, i) : cross(dp, dm, i);
    if (!d) return null;
    if (useV && side(vp, vm) !== d) return null;
    if (useM && side(mc.line, mc.signal) !== d) return null;
    if (useA && (side(dp, dm) !== d || !a[i] || a[i].adx < (Number(p.vx_adx_min) || 0))) return null;
    // RSI: on the signal's side of the middle line, but not overheated (CALL below vx_rsi_max, PUT above 100 − it).
    let rv = null;
    if (useR) {
      rv = x.rsi(Number(p.vx_rsi_period) || 14)[i];
      const mid = Number(p.vx_rsi_mid ?? 50), mx = Number(p.vx_rsi_max) || 100;
      if (rv == null || (d > 0 ? !(rv > mid && rv < mx) : !(rv < 100 - mid && rv > 100 - mx))) return null;
    }
    const up = d > 0, parts = [useV && 'Vortex', useM && 'MACD', useA && `ADX ${a[i].adx.toFixed(0)}`, useR && `RSI ${rv.toFixed(0)}`].filter(Boolean).join(' + ');
    return sig(d, 74, L(`${parts}: ${up ? 'вверх' : 'вниз'}`, `${parts}: ${up ? 'aufwärts' : 'abwärts'}`, `${parts}: ${up ? 'up' : 'down'}`));
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
  // Trend pullback: only with the trend, after the pullback ended. Up (down = mirror): the last two confirmed swing highs
  // and lows rise and the last low is before the last high; the pullback from that high lasts at most tp_bars_max candles,
  // is tp_depth_min–tp_depth_max % of the impulse and keeps above the last low; entry = a candle with the trend closing
  // beyond the previous candle's high but not beyond the last high, on the right side of the EMA.
  n_trendpull(x, p) {
    const c = x.c, i = x.last, R = Math.max(1, Number(p.tp_right) || 2), atr = x.atr[i], ema = x.ema(Number(p.tp_ema) || 20)[i];
    if (!atr || ema == null) return null;
    // Swing points confirmed by R candles on each side, newest first. dir 1 = highs, -1 = lows (value × dir compares both alike).
    const swings = d => {
      const v = k => (d > 0 ? c[k].high : -c[k].low), out = [];
      for (let j = i - R; j >= Math.max(R, i - 80) && out.length < 2; j--) {
        let ok = true;
        for (let q = j - R; q <= j + R && ok; q++) if (q !== j && (q < j ? v(q) >= v(j) : v(q) > v(j))) ok = false;
        if (ok) out.push(j);
      }
      return out;
    };
    const H = swings(1), Lo = swings(-1); if (H.length < 2 || Lo.length < 2) return null;
    const dp = v => v.toFixed(v > 20 ? 3 : 5);
    for (const d of [1, -1]) {
      if (d > 0 ? p.tp_buy === false : p.tp_sell === false) continue;
      // Up: peak = last high, base = last low. Down: peak = last low, base = last high.
      const peaks = d > 0 ? H : Lo, bases = d > 0 ? Lo : H;
      const val = k => (d > 0 ? c[k].high : c[k].low), baseVal = k => (d > 0 ? c[k].low : c[k].high);
      if ((val(peaks[0]) - val(peaks[1])) * d <= 0 || (baseVal(bases[0]) - baseVal(bases[1])) * d <= 0) continue;
      if (bases[0] >= peaks[0]) continue;
      const bars = i - peaks[0]; if (bars > (Number(p.tp_bars_max) || 5)) continue;
      const peak = val(peaks[0]), base = baseVal(bases[0]), imp = (peak - base) * d;
      if (imp < (Number(p.tp_imp_atr) || 0) * atr) continue;
      let far = baseVal(peaks[0] + 1); // the far end of the pullback ("bottom" when going up)
      let farI = peaks[0] + 1;
      for (let k = peaks[0] + 1; k <= i; k++) { const v = baseVal(k); if ((far - v) * d >= 0 && (k === peaks[0] + 1 || (far - v) * d > 0)) { far = v; farI = k; } }
      const depth = (peak - far) * d / imp * 100;
      if (depth < Number(p.tp_depth_min) || depth > Number(p.tp_depth_max) || (far - base) * d <= 0) continue;
      const k = c[i], cl = k.close;
      if ((cl - k.open) * d <= 0 || (cl - (d > 0 ? c[i - 1].high : c[i - 1].low)) * d <= 0 || (cl - peak) * d > 0 || (cl - ema) * d <= 0) continue;
      // Not late (user, 06.11.2026): only the first candle closing with the trend from the pullback's far end, and at most
      // tp_return_max % of the pullback already won back when entering.
      if (p.tp_first !== false) { let turned = false; for (let q = farI; q < i; q++) if (I.dirOf(c[q]) === d) turned = true; if (turned) continue; }
      if (Number(p.tp_return_max) > 0 && (cl - far) * d > Number(p.tp_return_max) / 100 * (peak - far) * d) continue;
      if ((peak - cl) * d < (Number(p.tp_room_atr) || 0) * atr) continue;
      if ((cl - far) * d > (Number(p.tp_candle_atr) || Infinity) * atr) continue;
      const pct = depth.toFixed(0), stop = dp(far);
      return sig(d, 75, L(`откат ${pct} % закончился, вход по тренду; отмена ${stop}`, `Rücklauf ${pct} % beendet, Einstieg im Trend; Abbruch ${stop}`, `${pct} % pullback over, entry with the trend; cancel at ${stop}`));
    }
    return null;
  },
};

// Big candle in a slow trend (n_big, bs_on). Closed candles only, nothing after the signal candle is used.
// Why no signal: counted per reason in bigLog, shown in the strategy ("why no signal").
const bigLog = { checked: 0, small: 0, range: 0, ratio: 0, atr: 0, notrend: 0, side: 0, fast: 0, far: 0, pause: 0, noconfirm: 0, signals: 0 };
const median = a => { const s = [...a].sort((u, v) => u - v), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
// Returns the candle's direction when candle i is a valid spike, otherwise the reason it is not (a string).
function bigSpike(x, i, p) {
  const c = x.c, k = c[i], n = Number(p.bs_lookback) || 15, a = x.atr[i]; if (i < n + 1 || !a) return 'small';
  const body = I.body(k), rg = k.high - k.low, bodies = [], ranges = [];
  for (let j = i - n; j < i; j++) { bodies.push(I.body(c[j])); ranges.push(c[j].high - c[j].low); }
  if (!body || body < (Number(p.bs_body) || 2) * median(bodies)) return 'small';
  if (p.bs_use_range && rg < (Number(p.bs_range) || 1.8) * median(ranges)) return 'range';
  if (body / rg < Number(p.bs_ratio ?? 0.6)) return 'ratio';
  if (p.bs_min_atr && body < p.bs_min_atr * a) return 'atr';
  const cd = I.dirOf(k), f = x.ema(Number(p.bs_ema_fast) || 20), sl = x.ema(Number(p.bs_ema_slow) || 50), back = Number(p.bs_slope) || 10;
  if (p.bs_trend) {
    if (f[i] == null || sl[i] == null || f[i - back] == null) return 'notrend';
    const slope = (f[i] - f[i - back]) / a, td = f[i] > sl[i] && slope > 0 ? 1 : f[i] < sl[i] && slope < 0 ? -1 : 0;
    if (!td) return 'notrend';
    if ((td === cd) === !!p.bs_against) return 'side'; // normally with the trend; bs_against = the separately tested case
    if (p.bs_max_slope && Math.abs(slope) > p.bs_max_slope) return 'fast';
  }
  if (p.bs_max_dist && f[i] != null && Math.abs(k.close - f[i]) / a > p.bs_max_dist) return 'far';
  return cd;
}
function bigSlow(x, p) {
  const log = x.logOn, c = x.c, conf = p.bs_mode === 'C', i = conf ? x.last - 1 : x.last;
  if (log) bigLog.checked++;
  const r = bigSpike(x, i, p);
  if (typeof r === 'string') { if (log) bigLog[r]++; return null; }
  // One signal per impulse: an earlier spike within the pause blocks this one.
  for (let j = i - (Number(p.bs_gap) || 0); j < i; j++) if (typeof bigSpike(x, j, p) !== 'string') { if (log) bigLog.pause++; return null; }
  const d = -r;
  if (conf && I.dirOf(c[x.last]) !== d) { if (log) bigLog.noconfirm++; return null; }
  if (log) bigLog.signals++;
  const m = median(c.slice(i - (Number(p.bs_lookback) || 15), i).map(I.body)), ratio = m ? I.body(c[i]) / m : 0;
  return Object.assign(sig(d, 75, L(`большая свеча ${ratio.toFixed(1)}× медианы${conf ? ', откат подтверждён' : ''}`, `große Kerze ${ratio.toFixed(1)}× Median${conf ? ', Rücklauf bestätigt' : ''}`, `big candle ${ratio.toFixed(1)}× median${conf ? ', pullback confirmed' : ''}`)), { noFlip: true });
}

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

// Market rules for the reversal setups (user, 28.10.2026: "only on a volatile market; never CALL into resistance,
// never PUT into support"). mk_vol: the last 10 candles average at least mk_vol × the average of the last 60;
// mk_big: one of the last 10 candles is at least mk_big × that average; mk_room: room to the next level in the trade's
// direction in average candles (no CALL right under resistance, no PUT right above support). 0 = off.
function marketOk(x, p, dir) {
  const c = x.c, i = x.last;
  if (p.mk_vol || p.mk_big) {
    if (i < 60) return false;
    const rg = j => c[j].high - c[j].low;
    let a60 = 0, a10 = 0, big = 0;
    for (let j = i - 59; j <= i; j++) a60 += rg(j); a60 /= 60;
    for (let j = i - 9; j <= i; j++) { a10 += rg(j); big = Math.max(big, rg(j)); } a10 /= 10;
    if (p.mk_vol && a10 < p.mk_vol * a60) return false;
    if (p.mk_big && big < p.mk_big * a60) return false;
  }
  if (p.mk_room && roomAhead(c, i, dir).dist < p.mk_room) return false;
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
    const base = paramsFor(name, settings);
    // Several presets can be on at once (settings.strat_presets[name] = indexes): a signal when any of them fires,
    // the first one wins. None chosen = the strategy's own settings.
    const chosen = (settings.strat_presets?.[name] || []).map(n => PRESETS[name]?.[n]).filter(Boolean);
    const sets = chosen.length ? chosen.map(pr => ({ p: { ...base, ...pr.values }, pr })) : [{ p: base, pr: null }];
    for (const tf of settings.strat_tfs?.[name] || ['M1']) {
      const c = candlesByTf[tf]; if (!c || c.length < 60) continue;
      const x = (ctxs[tf] ??= ctx(c)); x.tfMin = parseInt(tf.slice(1), 10) || 1;
      x.ctx = candlesByTf.ctx; // higher timeframes from their own history (M5/M15), for multi-timeframe strategies
      let s = null, p = base, pr = null;
      for (const set of sets) {
        x.logOn = set === sets[0]; // with several profiles the log follows the first one
        let r; try { r = fn(x, set.p); } catch { r = null; }
        if (r && r.dir && passesFilters(x, set.p, r, META[name][1]) && marketOk(x, set.p, set.p.follow_move && !r.noFlip ? -r.dir : r.dir)) { s = r; p = set.p; pr = set.pr; break; }
      }
      if (!s) continue;
      // Market regime (I.regime): shown on the card; with regime_filter trend strategies only in TREND,
      // reversal strategies only in RANGE, nothing in CHAOS.
      if (x.rg === undefined) x.rg = I.regime(c, c.length - 1, settings);
      // Backtest 04.11.2026 (17 OTC pairs, 5 days M1): CHAOS 36 % (n 70, CI up to 47 %) → skipped by default (chaos_skip);
      // the type mapping gave no gain (trend strategies not better in TREND, reversal ones not better in RANGE) → opt-in.
      if (x.rg && x.rg.regime === 'CHAOS' && settings.chaos_skip !== false) continue;
      // Small candles (rg_vol, 0 = off): average size of the last 5 candles / average of the pair's other candles on this timeframe.
      const minVol = Number(settings.rg_vol ?? 0.7);
      if (minVol > 0) {
        if (x.volRatio === undefined) {
          const sz = k => k.high - k.low, n5 = c.length - 5;
          const a5 = c.slice(n5).reduce((t, k) => t + sz(k), 0) / 5, rest = c.slice(0, n5).reduce((t, k) => t + sz(k), 0) / n5;
          x.volRatio = rest > 0 ? a5 / rest : null;
        }
        if (x.volRatio !== null && x.volRatio < minVol) continue;
      }
      // regime_mode: off | auto (by strategy type) | trend (only in TREND) | range (only in RANGE, ADX below rg_range_adx).
      const rm = settings.regime_mode || (settings.regime_filter ? 'auto' : 'off');
      if (x.rg && rm !== 'off') {
        const want = rm === 'auto' ? (META[name][1] === 'trend' ? 'TREND' : 'RANGE') : rm.toUpperCase();
        if (x.rg.regime !== want) continue;
        if (want === 'RANGE' && x.rg.adx >= (Number(settings.rg_range_adx) || 25)) continue;
      }
      if (x.rg) s.regime = x.rg.regime;
      if (pr && chosen.length > 1) { s.reason = addText(s.reason, L(` · ${pr.name.ru}`, ` · ${pr.name.de}`, ` · ${pr.name.en}`)); if (!s.model) s.model = pr.name.ru; }
      // Reversal strategies bet against the last move; with follow_move they trade with it instead.
      let mode = 'trend';
      // The Stochastic trigger of n_sharp already gives the direction of the turn: "follow the move" must not flip it
      // (user, 04.11.2026: Stochastic turned up from 20, the card said PUT).
      if (META[name][1] === 'rev' && s.noFlip) { mode = 'reversal'; if (!s.noReason) s.reason = addText(s.reason, EXPECT.reversal); }
      else if (META[name][1] === 'rev') {
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

const HELP = {
  n_rsi8020: [{
    title: L('Инструкция: уровни строгости', 'Anleitung: Strenge-Stufen', 'Guide: strictness levels'),
    body: [
      L('Строже: дальше зоны, из которых выходит осциллятор.', 'Strenger: weiter außen liegende Zonen.', 'Stricter: zones further out.'),
      L('Как включить: нажмите один профиль вверху. Пока профиль включён, его значения заменяют такие же настройки ниже на странице; экспирация и таймфрейм остаются вашими. Без профиля работают ваши настройки. Несколько профилей дают сигнал, если сработал любой; для наблюдения лучше один.', 'Einschalten: oben ein Profil antippen. Solange es an ist, ersetzen seine Werte dieselben Einstellungen weiter unten; Ablaufzeit und Zeitrahmen bleiben Ihre. Ohne Profil gelten Ihre Einstellungen. Mehrere Profile geben ein Signal, wenn eines auslöst; zum Beobachten besser nur eines.', 'To switch on: tap one profile above. While it is on, its values replace the same settings further down; expiry and timeframe stay yours. Without a profile your settings apply. Several profiles signal when any fires; for observing use one.'),
      L('1 Очень часто: Зоны 65/35.', '1 Sehr oft: Zonen 65/35.', '1 Very often: Zones 65/35.'),
      L('2 Часто: Зоны 70/30.', '2 Oft: Zonen 70/30.', '2 Often: Zones 70/30.'),
      L('3 Средне: Зоны 80/20, обычная настройка.', '3 Mittel: Zonen 80/20, Standard.', '3 Medium: Zones 80/20, default.'),
      L('4 Строже: Зоны 85/15.', '4 Strenger: Zonen 85/15.', '4 Stricter: Zones 85/15.'),
      L('5 Строго: Зоны 90/10.', '5 Streng: Zonen 90/10.', '5 Strict: Zones 90/10.'),
      L('Строже — не значит прибыльнее: см. таблицу проверки. Проверяйте только на демо.', 'Strenger heißt nicht profitabler: siehe Prüftabelle. Nur auf Demo testen.', 'Stricter does not mean more profitable: see the test table. Test on demo only.'),
    ],
  }],
  n_stochenv: [{
    title: L('Инструкция: уровни строгости', 'Anleitung: Strenge-Stufen', 'Guide: strictness levels'),
    body: [
      L('Строже: цена дальше за Envelopes и уже зона стохастика.', 'Strenger: Preis weiter jenseits der Envelopes, engere Stochastik-Zone.', 'Stricter: price further beyond the envelopes, narrower Stochastic zone.'),
      L('Как включить: нажмите один профиль вверху. Пока профиль включён, его значения заменяют такие же настройки ниже на странице; экспирация и таймфрейм остаются вашими. Без профиля работают ваши настройки. Несколько профилей дают сигнал, если сработал любой; для наблюдения лучше один.', 'Einschalten: oben ein Profil antippen. Solange es an ist, ersetzen seine Werte dieselben Einstellungen weiter unten; Ablaufzeit und Zeitrahmen bleiben Ihre. Ohne Profil gelten Ihre Einstellungen. Mehrere Profile geben ein Signal, wenn eines auslöst; zum Beobachten besser nur eines.', 'To switch on: tap one profile above. While it is on, its values replace the same settings further down; expiry and timeframe stay yours. Without a profile your settings apply. Several profiles signal when any fires; for observing use one.'),
      L('1 Очень часто: Envelopes 0,05 %, зона 30.', '1 Sehr oft: Envelopes 0,05 %, Zone 30.', '1 Very often: Envelopes 0.05 %, zone 30.'),
      L('2 Часто: Envelopes 0,07 %, зона 25.', '2 Oft: Envelopes 0,07 %, Zone 25.', '2 Often: Envelopes 0.07 %, zone 25.'),
      L('3 Средне: Envelopes 0,1 %, зона 20, обычная настройка.', '3 Mittel: Envelopes 0,1 %, Zone 20, Standard.', '3 Medium: Envelopes 0.1 %, zone 20, default.'),
      L('4 Строже: Envelopes 0,15 %, зона 20.', '4 Strenger: Envelopes 0,15 %, Zone 20.', '4 Stricter: Envelopes 0.15 %, zone 20.'),
      L('5 Строго: Envelopes 0,2 %, зона 15.', '5 Streng: Envelopes 0,2 %, Zone 15.', '5 Strict: Envelopes 0.2 %, zone 15.'),
      L('Строже — не значит прибыльнее: см. таблицу проверки. Проверяйте только на демо.', 'Strenger heißt nicht profitabler: siehe Prüftabelle. Nur auf Demo testen.', 'Stricter does not mean more profitable: see the test table. Test on demo only.'),
    ],
  }],
  n_vortex: [{
    title: L('Инструкция: уровни строгости', 'Anleitung: Strenge-Stufen', 'Guide: strictness levels'),
    body: [
      L('Строже: больше индикаторов должны подтвердить пересечение Vortex.', 'Strenger: mehr Indikatoren müssen die Vortex-Kreuzung bestätigen.', 'Stricter: more indicators must confirm the Vortex cross.'),
      L('Как включить: нажмите один профиль вверху. Пока профиль включён, его значения заменяют такие же настройки ниже на странице; экспирация и таймфрейм остаются вашими. Без профиля работают ваши настройки. Несколько профилей дают сигнал, если сработал любой; для наблюдения лучше один.', 'Einschalten: oben ein Profil antippen. Solange es an ist, ersetzen seine Werte dieselben Einstellungen weiter unten; Ablaufzeit und Zeitrahmen bleiben Ihre. Ohne Profil gelten Ihre Einstellungen. Mehrere Profile geben ein Signal, wenn eines auslöst; zum Beobachten besser nur eines.', 'To switch on: tap one profile above. While it is on, its values replace the same settings further down; expiry and timeframe stay yours. Without a profile your settings apply. Several profiles signal when any fires; for observing use one.'),
      L('1 Очень часто: Только Vortex.', '1 Sehr oft: Nur Vortex.', '1 Very often: Vortex only.'),
      L('2 Часто: Vortex + быстрый MACD 6/13/5.', '2 Oft: Vortex + schneller MACD 6/13/5.', '2 Often: Vortex + fast MACD 6/13/5.'),
      L('3 Средне: Vortex + MACD 12/26/9, обычная настройка.', '3 Mittel: Vortex + MACD 12/26/9, Standard.', '3 Medium: Vortex + MACD 12/26/9, default.'),
      L('4 Строже: То же + ADX от 20.', '4 Strenger: Dazu ADX ab 20.', '4 Stricter: Plus ADX from 20.'),
      L('5 Строго: То же + ADX от 25 и RSI с нужной стороны от 50, не дальше 70.', '5 Streng: Dazu ADX ab 25 und RSI auf der richtigen Seite von 50, höchstens 70.', '5 Strict: Plus ADX from 25 and RSI on the right side of 50, at most 70.'),
      L('Строже — не значит прибыльнее: см. таблицу проверки. Проверяйте только на демо.', 'Strenger heißt nicht profitabler: siehe Prüftabelle. Nur auf Demo testen.', 'Stricter does not mean more profitable: see the test table. Test on demo only.'),
    ],
  }],
  n_psar: [{
    title: L('Инструкция: уровни строгости', 'Anleitung: Strenge-Stufen', 'Guide: strictness levels'),
    body: [
      L('Строже: больший множитель Supertrend и меньше окно совпадения с PSAR.', 'Strenger: größerer Supertrend-Faktor, kleineres Fenster für die Übereinstimmung mit PSAR.', 'Stricter: bigger Supertrend factor, smaller window for agreement with PSAR.'),
      L('Как включить: нажмите один профиль вверху. Пока профиль включён, его значения заменяют такие же настройки ниже на странице; экспирация и таймфрейм остаются вашими. Без профиля работают ваши настройки. Несколько профилей дают сигнал, если сработал любой; для наблюдения лучше один.', 'Einschalten: oben ein Profil antippen. Solange es an ist, ersetzen seine Werte dieselben Einstellungen weiter unten; Ablaufzeit und Zeitrahmen bleiben Ihre. Ohne Profil gelten Ihre Einstellungen. Mehrere Profile geben ein Signal, wenn eines auslöst; zum Beobachten besser nur eines.', 'To switch on: tap one profile above. While it is on, its values replace the same settings further down; expiry and timeframe stay yours. Without a profile your settings apply. Several profiles signal when any fires; for observing use one.'),
      L('1 Очень часто: Множитель 1,2, окно 5.', '1 Sehr oft: Faktor 1,2, Fenster 5.', '1 Very often: Factor 1.2, window 5.'),
      L('2 Часто: Множитель 1,2, окно 3.', '2 Oft: Faktor 1,2, Fenster 3.', '2 Often: Factor 1.2, window 3.'),
      L('3 Средне: Множитель 1,5, окно 2, обычная настройка.', '3 Mittel: Faktor 1,5, Fenster 2, Standard.', '3 Medium: Factor 1.5, window 2, default.'),
      L('4 Строже: Множитель 2, окно 2.', '4 Strenger: Faktor 2, Fenster 2.', '4 Stricter: Factor 2, window 2.'),
      L('5 Строго: Множитель 2,5, окно 1.', '5 Streng: Faktor 2,5, Fenster 1.', '5 Strict: Factor 2.5, window 1.'),
      L('Строже — не значит прибыльнее: см. таблицу проверки. Проверяйте только на демо.', 'Strenger heißt nicht profitabler: siehe Prüftabelle. Nur auf Demo testen.', 'Stricter does not mean more profitable: see the test table. Test on demo only.'),
    ],
  }],
  n_ma25: [{
    title: L('Инструкция: уровни строгости', 'Anleitung: Strenge-Stufen', 'Guide: strictness levels'),
    body: [
      L('Строже: дольше не было пересечения линий перед сигналом. Прежние профили 1–3 теперь 2–4.', 'Strenger: längere Zeit ohne Kreuzung vor dem Signal. Die früheren Profile 1–3 sind jetzt 2–4.', 'Stricter: longer time without a cross before the signal. The former profiles 1–3 are now 2–4.'),
      L('Как включить: нажмите один профиль вверху. Пока профиль включён, его значения заменяют такие же настройки ниже на странице; экспирация и таймфрейм остаются вашими. Без профиля работают ваши настройки. Несколько профилей дают сигнал, если сработал любой; для наблюдения лучше один.', 'Einschalten: oben ein Profil antippen. Solange es an ist, ersetzen seine Werte dieselben Einstellungen weiter unten; Ablaufzeit und Zeitrahmen bleiben Ihre. Ohne Profil gelten Ihre Einstellungen. Mehrere Profile geben ein Signal, wenn eines auslöst; zum Beobachten besser nur eines.', 'To switch on: tap one profile above. While it is on, its values replace the same settings further down; expiry and timeframe stay yours. Without a profile your settings apply. Several profiles signal when any fires; for observing use one.'),
      L('1 Очень часто: Спокойно 5 свечей.', '1 Sehr oft: Ruhe 5 Kerzen.', '1 Very often: Calm 5 candles.'),
      L('2 Часто: Спокойно 8 свечей.', '2 Oft: Ruhe 8 Kerzen.', '2 Often: Calm 8 candles.'),
      L('3 Средне: Спокойно 10 свечей.', '3 Mittel: Ruhe 10 Kerzen.', '3 Medium: Calm 10 candles.'),
      L('4 Строже: Спокойно 12 свечей.', '4 Strenger: Ruhe 12 Kerzen.', '4 Stricter: Calm 12 candles.'),
      L('5 Строго: Спокойно 15 свечей.', '5 Streng: Ruhe 15 Kerzen.', '5 Strict: Calm 15 candles.'),
      L('Строже — не значит прибыльнее: см. таблицу проверки. Проверяйте только на демо.', 'Strenger heißt nicht profitabler: siehe Prüftabelle. Nur auf Demo testen.', 'Stricter does not mean more profitable: see the test table. Test on demo only.'),
    ],
  }],
  n_deeprev: [{
    title: L('Инструкция: уровни строгости', 'Anleitung: Strenge-Stufen', 'Guide: strictness levels'),
    body: [
      L('Строже: выше минимальная уверенность и больше обязательных условий. Направления остаются вашими.', 'Strenger: höhere Mindest-Zuversicht und mehr Pflichtbedingungen. Die Richtungen bleiben Ihre.', 'Stricter: higher minimum confidence and more required conditions. Directions stay yours.'),
      L('Как включить: нажмите один профиль вверху. Пока профиль включён, его значения заменяют такие же настройки ниже на странице; экспирация и таймфрейм остаются вашими. Без профиля работают ваши настройки. Несколько профилей дают сигнал, если сработал любой; для наблюдения лучше один.', 'Einschalten: oben ein Profil antippen. Solange es an ist, ersetzen seine Werte dieselben Einstellungen weiter unten; Ablaufzeit und Zeitrahmen bleiben Ihre. Ohne Profil gelten Ihre Einstellungen. Mehrere Profile geben ein Signal, wenn eines auslöst; zum Beobachten besser nur eines.', 'To switch on: tap one profile above. While it is on, its values replace the same settings further down; expiry and timeframe stay yours. Without a profile your settings apply. Several profiles signal when any fires; for observing use one.'),
      L('1 Очень часто: Уверенность от 5, без возврата RSI и без входа на M1.', '1 Sehr oft: Zuversicht ab 5, ohne RSI-Rückkehr und M1-Einstieg.', '1 Very often: Confidence from 5, no RSI return, no M1 entry.'),
      L('2 Часто: Уверенность от 5, без возврата RSI.', '2 Oft: Zuversicht ab 5, ohne RSI-Rückkehr.', '2 Often: Confidence from 5, no RSI return.'),
      L('3 Средне: Уверенность от 6, все правила, обычная настройка.', '3 Mittel: Zuversicht ab 6, alle Regeln, Standard.', '3 Medium: Confidence from 6, all rules, default.'),
      L('4 Строже: Уверенность от 7.', '4 Strenger: Zuversicht ab 7.', '4 Stricter: Confidence from 7.'),
      L('5 Строго: Уверенность от 8, уровень от 3 касаний.', '5 Streng: Zuversicht ab 8, Level ab 3 Berührungen.', '5 Strict: Confidence from 8, level from 3 touches.'),
      L('Строже — не значит прибыльнее: см. таблицу проверки. Проверяйте только на демо.', 'Strenger heißt nicht profitabler: siehe Prüftabelle. Nur auf Demo testen.', 'Stricter does not mean more profitable: see the test table. Test on demo only.'),
    ],
  }],
  n_strongtrend: [{
    title: L('Инструкция: уровни строгости', 'Anleitung: Strenge-Stufen', 'Guide: strictness levels'),
    body: [
      L('Профили 1–4 — прежние проверенные сочетания, они работают против импульса. Профили 5–9 — уровни строгости: направление остаётся вашим (настройка «Против импульса»). Строже: выше ADX, больше разрыв DI, больше свечи, меньше свечей подряд.', 'Profile 1–4 sind die bisherigen geprüften Kombinationen, sie arbeiten gegen den Impuls. Profile 5–9 sind Strenge-Stufen: die Richtung bleibt Ihre (Einstellung „Gegen den Impuls“). Strenger: höherer ADX, größerer DI-Abstand, größere Kerzen, weniger Kerzen in Folge.', 'Profiles 1–4 are the former tested combinations, against the impulse. Profiles 5–9 are strictness levels: direction stays yours ("Against the impulse" setting). Stricter: higher ADX, bigger DI gap, bigger candles, fewer candles in a row.'),
      L('Как включить: нажмите один профиль вверху. Пока профиль включён, его значения заменяют такие же настройки ниже на странице; экспирация и таймфрейм остаются вашими. Без профиля работают ваши настройки. Несколько профилей дают сигнал, если сработал любой; для наблюдения лучше один.', 'Einschalten: oben ein Profil antippen. Solange es an ist, ersetzen seine Werte dieselben Einstellungen weiter unten; Ablaufzeit und Zeitrahmen bleiben Ihre. Ohne Profil gelten Ihre Einstellungen. Mehrere Profile geben ein Signal, wenn eines auslöst; zum Beobachten besser nur eines.', 'To switch on: tap one profile above. While it is on, its values replace the same settings further down; expiry and timeframe stay yours. Without a profile your settings apply. Several profiles signal when any fires; for observing use one.'),
      L('5 Очень часто: ADX от 20, DI от 2, тело от 0,3 ATR, до 8 свечей.', '5 Sehr oft: ADX ab 20, DI ab 2, Körper ab 0,3 ATR, bis 8 Kerzen.', '5 Very often: ADX from 20, DI from 2, body from 0.3 ATR, up to 8 candles.'),
      L('6 Часто: ADX от 20, DI от 3, тело от 0,5, до 7.', '6 Oft: ADX ab 20, DI ab 3, Körper ab 0,5, bis 7.', '6 Often: ADX from 20, DI from 3, body from 0.5, up to 7.'),
      L('7 Средне: ADX от 25, DI от 4, тело от 0,6, до 6.', '7 Mittel: ADX ab 25, DI ab 4, Körper ab 0,6, bis 6.', '7 Medium: ADX from 25, DI from 4, body from 0.6, up to 6.'),
      L('8 Строже: ADX от 25, DI от 5, тело от 0,8, до 5, обычная настройка.', '8 Strenger: ADX ab 25, DI ab 5, Körper ab 0,8, bis 5, Standard.', '8 Stricter: ADX from 25, DI from 5, body from 0.8, up to 5, default.'),
      L('9 Строго: ADX от 30, DI от 7, тело от 0,9, до 5.', '9 Streng: ADX ab 30, DI ab 7, Körper ab 0,9, bis 5.', '9 Strict: ADX from 30, DI from 7, body from 0.9, up to 5.'),
      L('Строже — не значит прибыльнее: см. таблицу проверки. Проверяйте только на демо.', 'Strenger heißt nicht profitabler: siehe Prüftabelle. Nur auf Demo testen.', 'Stricter does not mean more profitable: see the test table. Test on demo only.'),
    ],
  }],
  n_sharp: [{
    title: L('Инструкция: уровни строгости', 'Anleitung: Strenge-Stufen', 'Guide: strictness levels'),
    body: [
      L('Идея: серия свечей в одну сторону, затем стохастик выходит из зоны — сигнал на отскок. Строже: длиннее серия, дальше зона, меньше ожидание после серии.', 'Idee: Eine Kerzenserie in eine Richtung, dann verlässt der Stochastik seine Zone – Signal auf den Rücksprung. Strenger: längere Serie, weitere Zone, kürzere Wartezeit nach der Serie.', 'Idea: a series of candles one way, then the Stochastic leaves its zone – signal for a rebound. Stricter: longer series, wider zone, shorter wait after the series.'),
      L('Как включить: нажмите один профиль вверху. Пока профиль включён, его значения заменяют такие же настройки ниже на странице; экспирация и таймфрейм остаются вашими. Без профиля работают ваши настройки. Несколько профилей дают сигнал, если сработал любой; для наблюдения лучше один.', 'Einschalten: oben ein Profil antippen. Solange es an ist, ersetzen seine Werte dieselben Einstellungen weiter unten; Ablaufzeit und Zeitrahmen bleiben Ihre. Ohne Profil gelten Ihre Einstellungen. Mehrere Profile geben ein Signal, wenn eines auslöst; zum Beobachten besser nur eines.', 'To switch on: tap one profile above. While it is on, its values replace the same settings further down; expiry and timeframe stay yours. Without a profile your settings apply. Several profiles signal when any fires; for observing use one.'),
      L('1 Очень часто: серия от 3 свечей, зона 30/70, ожидание 15 свечей.', '1 Sehr oft: Serie ab 3 Kerzen, Zone 30/70, Wartezeit 15 Kerzen.', '1 Very often: series from 3 candles, zone 30/70, wait 15 candles.'),
      L('2 Часто: серия от 3, зона 25/75, ожидание 10.', '2 Oft: Serie ab 3, Zone 25/75, Wartezeit 10.', '2 Often: series from 3, zone 25/75, wait 10.'),
      L('3 Средне: серия от 4, зона 20/80, ожидание 10. Это обычные настройки стратегии, с него лучше начать.', '3 Mittel: Serie ab 4, Zone 20/80, Wartezeit 10. Die normalen Einstellungen, guter Start.', '3 Medium: series from 4, zone 20/80, wait 10. The usual settings, a good start.'),
      L('4 Строже: серия от 5, зона 20/80, ожидание 8.', '4 Strenger: Serie ab 5, Zone 20/80, Wartezeit 8.', '4 Stricter: series from 5, zone 20/80, wait 8.'),
      L('5 Строго: серия от 5, зона 15/85, ожидание 5.', '5 Streng: Serie ab 5, Zone 15/85, Wartezeit 5.', '5 Strict: series from 5, zone 15/85, wait 5.'),
      L('6 С подтверждением RSI: как «Средне», но для CALL RSI не выше 45, для PUT не ниже 55.', '6 Mit RSI-Bestätigung: wie „Mittel“, aber RSI für CALL höchstens 45, für PUT mindestens 55.', '6 With RSI confirmation: like "Medium" but RSI at most 45 for CALL, at least 55 for PUT.'),
      L('Строже — не значит прибыльнее: см. таблицу проверки. Проверяйте только на демо.', 'Strenger heißt nicht profitabler: siehe Prüftabelle. Nur auf Demo testen.', 'Stricter does not mean more profitable: see the test table. Test on demo only.'),
    ],
  }],
  early: [{
    title: L('Инструкция: уровни строгости', 'Anleitung: Strenge-Stufen', 'Guide: strictness levels'),
    body: [
      L('Идея: серия свечей в одну сторону, затем свеча закрывается за экстремумом последней свечи серии — сигнал на разворот. Строже: длиннее серия и больше пройденное движение в ATR.', 'Idee: Eine Kerzenserie in eine Richtung, dann schließt eine Kerze jenseits des Extrems der letzten Serienkerze – Signal auf die Umkehr. Strenger: längere Serie und größere Bewegung in ATR.', 'Idea: a series of candles one way, then a candle closes beyond the extreme of the last series candle – reversal signal. Stricter: longer series and bigger move in ATR.'),
      L('Как включить: нажмите один профиль вверху. Пока профиль включён, его значения заменяют такие же настройки ниже на странице; экспирация и таймфрейм остаются вашими. Без профиля работают ваши настройки. Несколько профилей дают сигнал, если сработал любой; для наблюдения лучше один.', 'Einschalten: oben ein Profil antippen. Solange es an ist, ersetzen seine Werte dieselben Einstellungen weiter unten; Ablaufzeit und Zeitrahmen bleiben Ihre. Ohne Profil gelten Ihre Einstellungen. Mehrere Profile geben ein Signal, wenn eines auslöst; zum Beobachten besser nur eines.', 'To switch on: tap one profile above. While it is on, its values replace the same settings further down; expiry and timeframe stay yours. Without a profile your settings apply. Several profiles signal when any fires; for observing use one.'),
      L('1 Очень часто: серия от 2 свечей, движение от 0,8 ATR.', '1 Sehr oft: Serie ab 2 Kerzen, Bewegung ab 0,8 ATR.', '1 Very often: series from 2 candles, move from 0.8 ATR.'),
      L('2 Часто: серия от 2, движение от 1,2 ATR.', '2 Oft: Serie ab 2, Bewegung ab 1,2 ATR.', '2 Often: series from 2, move from 1.2 ATR.'),
      L('3 Средне: серия от 3, движение от 1,5 ATR. Это обычные настройки стратегии, с него лучше начать.', '3 Mittel: Serie ab 3, Bewegung ab 1,5 ATR. Die normalen Einstellungen, guter Start.', '3 Medium: series from 3, move from 1.5 ATR. The usual settings, a good start.'),
      L('4 Строже: серия от 3, движение от 2 ATR.', '4 Strenger: Serie ab 3, Bewegung ab 2 ATR.', '4 Stricter: series from 3, move from 2 ATR.'),
      L('5 Строго: серия от 4, движение от 2,5 ATR.', '5 Streng: Serie ab 4, Bewegung ab 2,5 ATR.', '5 Strict: series from 4, move from 2.5 ATR.'),
      L('Строже — не значит прибыльнее: см. таблицу проверки. Проверяйте только на демо.', 'Strenger heißt nicht profitabler: siehe Prüftabelle. Nur auf Demo testen.', 'Stricter does not mean more profitable: see the test table. Test on demo only.'),
    ],
  }],
  n_trendpull: [{
    title: L('Инструкция: уровни строгости', 'Anleitung: Strenge-Stufen', 'Guide: strictness levels'),
    body: [
      L('Во всех профилях: сигнал только на первой свече по тренду от дна отката, и к входу цена вернула не больше половины отката (настройки «Только первая свеча» и «Вернул от отката не больше»). Идея: вход по тренду, когда откат закончился. Строже: уже допустимая глубина отката, короче откат, больше импульс, больше места до прошлого экстремума, меньше сигнальная свеча.', 'In allen Profilen: Signal nur auf der ersten Trendkerze vom Rücklauf-Ende, und beim Einstieg ist höchstens die Hälfte des Rücklaufs zurückgewonnen (Einstellungen „Nur erste Kerze“ und „Vom Rücklauf zurück höchstens“). Idee: Einstieg im Trend, wenn der Rücklauf beendet ist. Strenger: engere Rücklauftiefe, kürzerer Rücklauf, größerer Impuls, mehr Platz zum letzten Extrem, kleinere Signalkerze.', 'In all profiles: signal only on the first with-trend candle from the pullback end, with at most half of the pullback won back at entry (settings "First candle only" and "Won back at most"). Idea: entry with the trend once the pullback is over. Stricter: narrower pullback depth, shorter pullback, bigger impulse, more room to the last extreme, smaller signal candle.'),
      L('Как включить: нажмите один профиль вверху. Пока профиль включён, его значения заменяют такие же настройки ниже на странице; экспирация и таймфрейм остаются вашими. Без профиля работают ваши настройки. Несколько профилей дают сигнал, если сработал любой; для наблюдения лучше один.', 'Einschalten: oben ein Profil antippen. Solange es an ist, ersetzen seine Werte dieselben Einstellungen weiter unten; Ablaufzeit und Zeitrahmen bleiben Ihre. Ohne Profil gelten Ihre Einstellungen. Mehrere Profile geben ein Signal, wenn eines auslöst; zum Beobachten besser nur eines.', 'To switch on: tap one profile above. While it is on, its values replace the same settings further down; expiry and timeframe stay yours. Without a profile your settings apply. Several profiles signal when any fires; for observing use one.'),
      L('1 Очень часто: глубина 23,6–78,6 %, откат до 8 свечей, импульс от 1 ATR, место от 0,2 ATR, свеча до 2,5 ATR.', '1 Sehr oft: Tiefe 23,6–78,6 %, Rücklauf bis 8 Kerzen, Impuls ab 1 ATR, Platz ab 0,2 ATR, Kerze bis 2,5 ATR.', '1 Very often: depth 23.6–78.6 %, pullback up to 8 candles, impulse from 1 ATR, room from 0.2 ATR, candle up to 2.5 ATR.'),
      L('2 Часто: глубина 30–70 %, откат до 6, импульс от 1,5, место от 0,3, свеча до 2.', '2 Oft: Tiefe 30–70 %, Rücklauf bis 6, Impuls ab 1,5, Platz ab 0,3, Kerze bis 2.', '2 Often: depth 30–70 %, pullback up to 6, impulse from 1.5, room from 0.3, candle up to 2.'),
      L('3 Средне: глубина 38,2–61,8 %, откат до 5, импульс от 2, место от 0,5, свеча до 1,5. Это обычные настройки стратегии.', '3 Mittel: Tiefe 38,2–61,8 %, Rücklauf bis 5, Impuls ab 2, Platz ab 0,5, Kerze bis 1,5. Die normalen Einstellungen.', '3 Medium: depth 38.2–61.8 %, pullback up to 5, impulse from 2, room from 0.5, candle up to 1.5. The usual settings.'),
      L('4 Строже: откат до 4, импульс от 2,5, место от 0,7, свеча до 1,2.', '4 Strenger: Rücklauf bis 4, Impuls ab 2,5, Platz ab 0,7, Kerze bis 1,2.', '4 Stricter: pullback up to 4, impulse from 2.5, room from 0.7, candle up to 1.2.'),
      L('5 Строго: откат до 3, импульс от 3, место от 1, свеча до 1,2, ADX от 20. Сигналы очень редкие.', '5 Streng: Rücklauf bis 3, Impuls ab 3, Platz ab 1, Kerze bis 1,2, ADX ab 20. Sehr seltene Signale.', '5 Strict: pullback up to 3, impulse from 3, room from 1, candle up to 1.2, ADX from 20. Very rare signals.'),
      L('Строже — не значит прибыльнее: см. таблицу проверки. Проверяйте только на демо.', 'Strenger heißt nicht profitabler: siehe Prüftabelle. Nur auf Demo testen.', 'Stricter does not mean more profitable: see the test table. Test on demo only.'),
    ],
  }],
  n_big: [{
    title: L('Инструкция: большая свеча в слабом тренде', 'Anleitung: große Kerze im schwachen Trend', 'Guide: big candle in a slow trend'),
    body: [
      L('Идея: при медленном росте появляется большая зелёная свеча — сигнал PUT на короткий откат. При медленном падении и большой красной свече — CALL. Это ставка на откат, а не на разворот тренда, и откат не гарантирован.',
        'Idee: Bei langsamem Anstieg erscheint eine große grüne Kerze – Signal PUT auf einen kurzen Rücklauf. Bei langsamem Fall und großer roter Kerze – CALL. Das ist eine Wette auf den Rücklauf, nicht auf eine Trendwende, und er ist nicht garantiert.',
        'Idea: in a slow rise a big green candle appears – PUT signal for a short pullback. In a slow fall with a big red candle – CALL. It bets on the pullback, not on a trend reversal, and the pullback is not guaranteed.'),
      L('Как включить: нажмите один профиль вверху. Без профиля и без переключателя режима работает прежнее правило. Несколько профилей сразу дают сигнал, если сработал любой из них; для наблюдения лучше один.',
        'Einschalten: oben ein Profil antippen. Ohne Profil und ohne Modus-Schalter gilt die bisherige Regel. Mehrere Profile geben ein Signal, wenn eines auslöst; zum Beobachten besser nur eines.',
        'To switch on: tap one profile above. Without a profile or the mode switch the old rule applies. Several profiles signal when any fires; for observing use one.'),
      L('Значения профилей ниже применяются вместо настроек ниже на странице, пока профиль включён. Чтобы менять числа вручную, выключите профили и включите «Режим большой свечи в тренде».',
        'Die Profilwerte gelten statt der Einstellungen weiter unten, solange das Profil an ist. Um Zahlen selbst zu ändern: Profile aus und „Modus große Kerze im Trend“ ein.',
        'Profile values replace the settings further down while the profile is on. To change numbers yourself, turn profiles off and switch on "Big candle in a trend mode".'),
      L('1 Очень часто: тело ≥ 1,5 медианы, доля тела от 50 %, тренд не нужен, без паузы. Сигналов очень много.', '1 Sehr oft: Körper ≥ 1,5 Median, Anteil ab 50 %, kein Trend nötig, keine Pause. Sehr viele Signale.', '1 Very often: body ≥ 1.5 median, share from 50 %, no trend needed, no pause. Very many signals.'),
      L('2 Часто: тело ≥ 1,8, доля от 50 %, по тренду, пауза 1.', '2 Oft: Körper ≥ 1,8, Anteil ab 50 %, mit dem Trend, Pause 1.', '2 Often: body ≥ 1.8, share from 50 %, with the trend, pause 1.'),
      L('3 Средне: тело ≥ 2,0, доля от 60 %, по тренду, пауза 1. С него лучше начать.', '3 Mittel: Körper ≥ 2,0, Anteil ab 60 %, mit dem Trend, Pause 1. Guter Start.', '3 Medium: body ≥ 2.0, share from 60 %, with the trend, pause 1. A good start.'),
      L('4 Строже: тело ≥ 2,5, вся свеча ≥ 1,8, до EMA не дальше 3 ATR.', '4 Strenger: Körper ≥ 2,5, ganze Kerze ≥ 1,8, EMA höchstens 3 ATR entfernt.', '4 Stricter: body ≥ 2.5, whole candle ≥ 1.8, at most 3 ATR from the EMA.'),
      L('5 Строго: тело ≥ 3,0, вся свеча ≥ 1,8, тренд не быстрее 1,5 ATR, до EMA не дальше 2,5 ATR.', '5 Streng: Körper ≥ 3,0, ganze Kerze ≥ 1,8, Trend höchstens 1,5 ATR, EMA höchstens 2,5 ATR.', '5 Strict: body ≥ 3.0, whole candle ≥ 1.8, trend at most 1.5 ATR, at most 2.5 ATR from the EMA.'),
      L('6 С подтверждением: как «Строго», но тело ≥ 2,5 и вход только после следующей свечи в сторону отката. Вход на свечу позже.', '6 Mit Bestätigung: wie „Streng“, aber Körper ≥ 2,5 und Einstieg erst nach der nächsten Kerze in Rücklaufrichtung. Eine Kerze später.', '6 With confirmation: like "Strict" but body ≥ 2.5, entry only after the next candle in the pullback direction. One candle later.'),
      L('Строже — не значит прибыльнее: см. таблицу проверки. «Почему нет сигнала» показывает, какое условие отсеивает больше всего. Проверяйте только на демо.', 'Strenger heißt nicht profitabler: siehe Prüftabelle. „Warum kein Signal“ zeigt, welche Bedingung am meisten aussortiert. Nur auf Demo testen.', 'Stricter does not mean more profitable: see the test table. "Why no signal" shows which condition rejects most. Test on demo only.'),
    ],
  }],
}, LABELS = {}, OWN_LOGIC = ['n_levelrev', 'n_deeprev', 'n_strongtrend', 'n_trendpull'];

module.exports = { evaluate, NAMES, DEFAULTS, META, PRESETS, GROUPS, TESTS, HELP, LABELS, OWN_LOGIC, paramsFor, liveMode, bigLog, list: Object.keys(META) };
