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
  n_deeprev: [L('Разворот после глубокого падения (M15/M5/M1)', 'Umkehr nach tiefem Fall (M15/M5/M1)', 'Reversal after a deep fall (M15/M5/M1)'), 'rev'],
  early: [L('Ранний разворот', 'Frühe Umkehr', 'Early reversal'), 'rev'],
  n_rsi8020: [L('RSI 14 · возврат из крайних зон', 'RSI 14 · Rückkehr aus Extremzonen', 'RSI 14 · return from extreme zones'), 'rev'],
  n_rsi2: [L('RSI 2 · перегрев', 'RSI 2 · Überhitzung', 'RSI 2 · overheated'), 'rev'],
  n_sbs: [L('SBS', 'SBS'), 'trend'],
  n_stochenv: [L('Stoch + Envelopes', 'Stoch + Envelopes'), 'rev'],
  n_vortex: [L('Vortex + MACD', 'Vortex + MACD'), 'trend'],
  n_mamacd: [L('MA + MACD', 'MA + MACD'), 'trend'],
  n_psar: [L('Supertrend + PSAR', 'Supertrend + PSAR'), 'trend'],
  n_impulse: [L('Импульсный возврат', 'Impuls-Rückkehr', 'Impulse return'), 'trend'],
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
// Market rules for the reversal setups (see marketOk): volatile market only, no entry straight into a level.
const MARKET = { mk_vol: 1, mk_big: 1.8, mk_room: 1 };
const DEFAULTS = {
  n_sharp: { sharp_expiry: 180, ...FILTERS, follow_move: false, sharp_min: 4, sharp_rsi: false, sharp_mirror: true, ...SHARP_BOT },
  n_big: { ...REV, big_body: 2.5, big_period: 20, ...BIG_BOT },
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
  // Reversal after a deep fall (user's prompt of 29.10.2026), see deepRev(). Conservative: all rules on.
  n_deeprev: { expiry: 180, dr_buy: true, dr_sell: false, dr_min_conf: 6, dr_touches: 2, dr_zone_atr: 0.5, dr_near_atr: 0.7,
    dr_use_fall: true, dr_bear: 5, dr_imp_atr: 3, dr_use_pattern: true, dr_use_break: true, dr_break_atr: 1.2,
    dr_use_rsi: true, dr_rsi_lo: 30, dr_use_cross: true, dr_use_trend: true, dr_use_flat: true, dr_flat_atr: 3,
    dr_use_spike: true, dr_spike: 3, dr_use_m1: true },
  n_ma25: { m25_expiry: 120, ...FILTERS, no_countertrend: false, room_check: false, room_min: 1, m25_fast: 2, m25_slow: 5, m25_fast_type: 'SMA', m25_slow_type: 'SMA', m25_buy: true, m25_sell: true, m25_vol: 0,
    m25_quiet: 0, m25_gap: 0, m25_trend: 0, m25_body: 0, m25_rsi: false, m25_rsi_max: 70 },
  early: { ...REV, early_min: 3, early_drop_atr: 1.5 },
  n_rsi8020: { ...REV, rsi_period: 14, rsi_levels: '70/30' },
  n_rsi2: { ...REV, rsi2_threshold: 5, rsi2_buy: true, rsi2_sell: true },
  n_sbs: { ...TREND, ma_fast: 5, ma_slow: 10, stoch_k: 14 },
  n_stochenv: { ...REV, env_period: 20, env_pct: 0.1, stoch_k: 5, stoch_zone: 20 },
  n_vortex: { ...TREND, vortex_period: 14, macd_fast: 12, macd_slow: 26, macd_signal: 9 },
  n_mamacd: { ...TREND, ema_period: 20, macd_fast: 6, macd_slow: 19, macd_signal: 6 },
  n_psar: { ...TREND, st_period: 10, st_mult: 1.5, sar_step: 0.02, sar_max: 0.2, sar_window: 2 },
  n_impulse: { ...TREND, impulse_body: 1.5, pullback_max: 2 },
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
  // MA 2/5: fewer and better crosses. Measured 28.10.2026 (17 OTC pairs, 90 min, 2 min expiry): only "calm before" raised
  // the win rate (none 291 signals 52 %, 8 → 53 / 56 %, 10 → 33 / 72 %, 12 → 17 / 81 %); trend EMA, RSI, body, ADX did not.
  n_ma25: [
    { name: L('Мягко', 'Locker', 'Loose'), values: { m25_quiet: 8, m25_gap: 0, m25_trend: 0, m25_body: 0, m25_rsi: false, m25_vol: 0, min_adx: 0, room_check: false } },
    { name: L('Средне', 'Mittel', 'Medium'), values: { m25_quiet: 10, m25_gap: 0, m25_trend: 0, m25_body: 0, m25_rsi: false, m25_vol: 0, min_adx: 0, room_check: false } },
    { name: L('Строго', 'Streng', 'Strict'), values: { m25_quiet: 12, m25_gap: 0, m25_trend: 0, m25_body: 0, m25_rsi: false, m25_vol: 0, min_adx: 0, room_check: false } },
  ],
};

// Settings shown in blocks: each block says what it decides and which way is stricter. Keys not listed go to the end.
const MARKET_GROUP = { title: L('0 · Рынок (когда вообще давать сигналы)', '0 · Markt (wann überhaupt Signale)', '0 · Market (when to signal at all)'),
  desc: L('Сигнал только на живом рынке: последние 10 свечей в среднем не меньше X × обычного размера, и среди них есть большая свеча (≥ Y × обычной). И никогда CALL прямо под сопротивлением, PUT прямо над поддержкой: до уровня по ходу сделки должно быть не меньше Z средних свечей. 0 = выкл.',
    'Signal nur bei lebhaftem Markt: die letzten 10 Kerzen im Schnitt mindestens X × normal, darunter eine große (≥ Y × normal). Nie CALL direkt unter Widerstand, nie PUT direkt über Unterstützung: bis zum Level in Handelsrichtung mindestens Z Durchschnittskerzen. 0 = aus.',
    'Signal only on a lively market: the last 10 candles average at least X × normal, one of them big (≥ Y × normal). Never CALL right under resistance, never PUT right above support: at least Z average candles to the level in the trade direction. 0 = off.'),
  keys: ['mk_vol', 'mk_big', 'mk_room'] };
const GROUPS = {
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
  if (name === 'n_ma25') return 'live';
  if ((name === 'n_big' || name === 'n_sharp') && p.bot) return 'both';
  // Only the last fully closed candle counts – unless the early V-reversal is on (then also inside the forming candle).
  if (name === 'n_levelrev') return p.lr_b_early ? 'both' : 'closed';
  if (name === 'n_deeprev') return 'closed';
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
    const { d, n } = runLength(x.c, x.last), min = p.sharp_min || 4;
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
    const [hi, lo] = String(p.rsi_levels || '70/30').split('/').map(Number), r = x.rsi(p.rsi_period || 14), i = x.last;
    if (r[i - 1] < lo && r[i] >= lo) return sig(1, 72, L(`RSI вернулся выше ${lo}`, `RSI zurück über ${lo}`, `RSI back above ${lo}`));
    if (r[i - 1] > hi && r[i] <= hi) return sig(-1, 72, L(`RSI вернулся ниже ${hi}`, `RSI zurück unter ${hi}`, `RSI back below ${hi}`));
    return null;
  },
  n_rsi2(x, p) {
    const r = x.rsi(2)[x.last], t = p.rsi2_threshold || 5;
    if (r <= t && p.rsi2_buy !== false) return sig(1, 72, `RSI(2) = ${r.toFixed(1)}`);
    if (r >= 100 - t && p.rsi2_sell !== false) return sig(-1, 72, `RSI(2) = ${r.toFixed(1)}`);
    return null;
  },
  n_sbs(x, p) {
    const i = x.last, d = cross(x.sma(p.ma_fast || 5), x.sma(p.ma_slow || 10), i); if (!d) return null;
    const { k, d: dd } = x.stoch(p.stoch_k || 14, 3, 3);
    if (d > 0 ? k[i] < dd[i] : k[i] > dd[i]) return null;
    if (I.dirOf(x.c[i]) !== d) return null;
    return sig(d, 74, L(`MA ${p.ma_fast} пересекла MA ${p.ma_slow}, Stochastic согласен`, `MA ${p.ma_fast} kreuzt MA ${p.ma_slow}, Stochastic stimmt zu`, `MA ${p.ma_fast} crossed MA ${p.ma_slow}, Stochastic agrees`));
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
  n_psar(x, p) {
    const i = x.last, st = I.supertrend(x.c, p.st_period || 10, p.st_mult || 1.5), ps = x.psar(p.sar_step || 0.02, p.sar_max || 0.2);
    if (!st[i] || !st[i - 1] || st[i].up === st[i - 1].up) return null;
    const d = st[i].up ? 1 : -1;
    if (!ps[i] || ps[i].up !== (d > 0)) return null;
    const recent = ps.slice(i - (p.sar_window || 2), i + 1).some((q, j, a) => j > 0 && q && a[j - 1] && q.up !== a[j - 1].up);
    if (!recent) return null;
    return sig(d, 77, L('разворот Supertrend и PSAR', 'Supertrend und PSAR drehen', 'Supertrend and PSAR flip'));
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
        let r; try { r = fn(x, set.p); } catch { r = null; }
        if (r && r.dir && passesFilters(x, set.p, r, META[name][1]) && marketOk(x, set.p, set.p.follow_move ? -r.dir : r.dir)) { s = r; p = set.p; pr = set.pr; break; }
      }
      if (!s) continue;
      if (pr && chosen.length > 1) { s.reason = addText(s.reason, L(` · ${pr.name.ru}`, ` · ${pr.name.de}`, ` · ${pr.name.en}`)); if (!s.model) s.model = pr.name.ru; }
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
