'use strict';
// Breakout + Retest + Confirmation from the user's spec of 02.11.2026, adapted to this app's engine (candles of M1…M5, no
// order execution). A pure function of the candles it gets – the "state machine" of the spec is derived from the history
// (stateless, no look-ahead), one signal per breakout through the `bar` key:
//   n_bor       Breakout + Retest + Confirmation
// The other two strategies of that spec (ADX/DMI Micro-Impulse, APC Pro) were removed on 02.11.2026: ~50 % in the tests.
// Shared parts: RSI filter (OFF / RANGE / OVERHEAT ONLY), MAM-lite (market activity from prices – the feed has no
// volume), AEI note (expiry stays manual – there is no verified per-expiry estimate). SET is the app's own entry
// countdown. Honest limits are written in HELP (shown folded in the strategy).
module.exports = function (h) {
  const { I, L, sig, roomAhead } = h;
  const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
  const nowSec = () => Date.now() / 1000;
  const sgn = Math.sign;
  const median = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const part = v => (typeof v === 'string' ? { ru: v, de: v, en: v } : v);
  const J = (...ps) => { const q = ps.filter(Boolean).map(part); return { ru: q.map(x => x.ru).join(' · '), de: q.map(x => x.de).join(' · '), en: q.map(x => x.en).join(' · ') }; };
  const expL = s => (s % 60 === 0 ? L(`${s / 60} мин`, `${s / 60} Min`, `${s / 60} min`) : L(`${s} с`, `${s} s`, `${s} s`));
  const decOf = a => (a > 0 ? Math.max(2, Math.min(6, Math.ceil(-Math.log10(a)) + 2)) : 5);
  const clampN = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------- shared: MAM-lite, RSI filter, AEI note ----------
  const MAM = { mam_on: false, mam_block: true, mam_min_act: 0.6, mam_max_stale: 0.3, mam_from: 0, mam_to: 24 };
  // Market activity from the prices (HIGH / NORMAL / LOW / UNKNOWN): recent range against the median of the last 100,
  // share of gaps and frozen quotes, hours (UTC). Volume is not delivered by PocketOption – never invented.
  function mamCheck(c, i, p, tfSec) {
    if (!p.mam_on) return { block: false, note: null };
    const rg = j => c[j].high - c[j].low, why = [];
    let state = 'NORMAL';
    if (i < 100) { state = 'UNKNOWN'; why.push(L('мало истории', 'zu wenig Historie', 'too little history')); }
    else {
      let gaps = 0, flat = 0;
      for (let j = i - 19; j <= i; j++) { if (c[j].time - c[j - 1].time !== tfSec) gaps++; if (rg(j) === 0) flat++; }
      const stale = (gaps + flat) / 20;
      if (stale > num(p.mam_max_stale, 0.3)) {
        state = 'UNKNOWN'; why.push(L(`плохие котировки ${Math.round(100 * stale)}%`, `schlechte Kurse ${Math.round(100 * stale)}%`, `poor quotes ${Math.round(100 * stale)}%`));
      } else {
        let a10 = 0; for (let j = i - 9; j <= i; j++) a10 += rg(j); a10 /= 10;
        const base = median(Array.from({ length: 100 }, (_, k) => rg(i - 99 + k)));
        if (!(base > 0)) state = 'UNKNOWN';
        else {
          const act = a10 / base;
          state = act >= 1.3 ? 'HIGH' : act < num(p.mam_min_act, 0.6) ? 'LOW' : 'NORMAL';
          why.push(L(`активность ${act.toFixed(1)}× обычной`, `Aktivität ${act.toFixed(1)}× normal`, `activity ${act.toFixed(1)}× normal`));
        }
      }
    }
    const from = num(p.mam_from, 0), to = num(p.mam_to, 24), hr = new Date(c[i].time * 1000).getUTCHours();
    const inSession = (from === 0 && to === 24) || (from < to ? hr >= from && hr < to : hr >= from || hr < to);
    if (!inSession) why.push(L(`вне часов ${from}–${to} UTC`, `außerhalb ${from}–${to} UTC`, `outside ${from}–${to} UTC`));
    const bad = state === 'LOW' || state === 'UNKNOWN' || !inSession;
    return { block: bad && p.mam_block !== false, note: J(`MAM ${state}`, why.length ? J(...why) : null, L('объём недоступен', 'Volumen nicht verfügbar', 'volume unavailable')) };
  }

  const RSI_F = { rsi_mode: 0, rsi_period: 14, rsi_min: 50, rsi_max: 70 };
  // rsi_mode 0 OFF · 1 RANGE (CALL inside [min, max], PUT inside [100−max, 100−min]) · 2 OVERHEAT ONLY (CALL blocked at ≥ max, PUT at ≤ 100−max)
  function rsiCheck(c, i, p, dir, rsiArr) {
    const m = num(p.rsi_mode, 0); if (!m) return { ok: true, v: null };
    const v = (rsiArr || I.rsi(c.map(k => k.close), num(p.rsi_period, 14)))[i];
    if (v == null) return { ok: false, v: null };
    const lo = num(p.rsi_min, 50), hi = num(p.rsi_max, 70);
    const ok = m === 1 ? (dir > 0 ? v >= lo && v <= hi : v <= 100 - lo && v >= 100 - hi) : (dir > 0 ? v < hi : v > 100 - hi);
    return { ok, v };
  }
  const aeiNote = p => (p.aei_on === false ? null : J(L('экспирация', 'Ablauf', 'expiry'), expL(num(p.expiry, 120)), L('вручную; проверенной оценки по срокам нет (AEI)', 'manuell; keine geprüfte Schätzung je Laufzeit (AEI)', 'manual; no verified per-expiry estimate (AEI)')));
  const AEI = { aei_on: true };

  // =====================================================================================================
  // 2. Breakout + Retest + Confirmation
  // =====================================================================================================
  const BR = {
    expiry: 120, br_buy: true, br_sell: true, br_lookback: 100, br_touches: 2, br_zone_atr: 0.5, br_atr_period: 14, br_margin_atr: 0,
    br_retest_bars: 8, br_confirm: 2, br_max_age: 12, br_filter: 1, br_min_rating: 0, ...RSI_F, ...MAM, ...AEI,
  };
  // Filter levels 0 OFF · 1 STANDARD · 2 STRICT: min touches · min breakout body (ATR) · max candle range (ATR) · min room to the next level (ATR-ish R)
  const BR_LEVELS = [{ touches: 0, body: 0, anom: 99, room: 0 }, { touches: 2, body: 0.5, anom: 3, room: 0.5 }, { touches: 3, body: 0.9, anom: 2.5, room: 1 }];

  // Swing points (2 candles on each side, confirmed) of c[from..to], clustered into zones of width zw (side +1 resistance, −1 support).
  function swingZones(c, from, to, zw, minT, side) {
    const pts = [];
    for (let j = Math.max(2, from + 2); j <= to - 2; j++) {
      const v = side > 0 ? c[j].high : c[j].low; let ok = true;
      for (let q = j - 2; q <= j + 2; q++) if (q !== j && (side > 0 ? c[q].high > v : c[q].low < v)) { ok = false; break; }
      if (ok) pts.push(v);
    }
    pts.sort((u, w) => u - w);
    const zs = [];
    for (const v of pts) { const z = zs[zs.length - 1]; if (z && v - z.lo <= zw) { z.hi = v; z.n++; z.sum += v; } else zs.push({ lo: v, hi: v, n: 1, sum: v }); }
    return zs.filter(z => z.n >= minT).map(z => { const mid = z.sum / z.n; return { lo: Math.min(z.lo, mid - zw / 2), hi: Math.max(z.hi, mid + zw / 2), n: z.n }; });
  }

  function bor(x, p) {
    const c = x.c, i = x.last, tfSec = (x.tfMin || 1) * 60;
    const K = clampN(Math.round(num(p.br_confirm, 2)), 1, 3), RB = Math.max(1, Math.round(num(p.br_retest_bars, 8)));
    const lb = num(p.br_lookback, 100), zwA = num(p.br_zone_atr, 0.5), mar = num(p.br_margin_atr, 0);
    const lvl = BR_LEVELS[clampN(Math.round(num(p.br_filter, 1)), 0, 2)], minT = Math.max(num(p.br_touches, 2), lvl.touches);
    if (i < 30 + K + RB) return null;
    const atrA = I.atr(c, num(p.br_atr_period, 14));
    const mam = mamCheck(c, i, p, tfSec); if (mam.block) return null;
    const r = i - K; // the retest candle; confirmations are r+1 … i (the latest closed candle is the last confirmation)
    for (const dir of [1, -1]) {
      if ((dir > 0 && p.br_buy === false) || (dir < 0 && p.br_sell === false)) continue;
      const up = dir > 0;
      for (let b = r - 1; b >= Math.max(12, r - RB); b--) { // b = breakout candle, at most RB candles before the retest
        if (i - b > num(p.br_max_age, RB + K + 2)) break;
        const A = atrA[b - 1]; if (!(A > 0)) continue;
        const zw = zwA * A, zones = swingZones(c, Math.max(0, b - lb), b - 1, zw, minT, up ? 1 : -1); // levels known BEFORE the breakout
        let z = null;
        for (const q of zones) {
          const beyond = up ? c[b].close > q.hi + mar * A && c[b - 1].close <= q.hi : c[b].close < q.lo - mar * A && c[b - 1].close >= q.lo;
          if (beyond && (!z || (up ? q.hi > z.hi : q.lo < z.lo))) z = q;
        }
        if (!z) continue;
        const near = up ? z.hi : z.lo, far = up ? z.lo : z.hi; // near edge = the one the breakout crossed
        let bad = false;
        for (let k = b + 1; k <= i; k++) if (up ? c[k].close < far : c[k].close > far) { bad = true; break; } // the zone must hold
        if (bad) continue;
        if (!(up ? c[r].low <= near : c[r].high >= near)) continue; // retest touches the zone
        for (let k = r + 1; k <= i && !bad; k++) if (!(up ? c[k].close > c[k].open && c[k].close > near : c[k].close < c[k].open && c[k].close < near)) bad = true;
        if (bad) continue;
        // quality filters
        const body = Math.abs(c[b].close - c[b].open);
        if (lvl.body && body < lvl.body * A) continue;
        let maxR = 0; for (let k = b; k <= i; k++) maxR = Math.max(maxR, c[k].high - c[k].low);
        if (maxR > lvl.anom * A) continue;
        const room = roomAhead(c.slice(0, i + 1), i, dir).dist; // R units; Infinity = nothing ahead
        if (lvl.room && room < lvl.room) continue;
        const rs = rsiCheck(c, i, p, dir); if (!rs.ok) continue;
        // rating 0–100 (documented in the help, NOT a win probability)
        const depth = clampN((up ? near - c[r].low : c[r].high - near) / Math.max(1e-12, z.hi - z.lo), 0, 1);
        let cb = 0; for (let k = r + 1; k <= i; k++) cb += Math.abs(c[k].close - c[k].open) / Math.max(1e-12, c[k].high - c[k].low); cb /= K;
        const rating = Math.round(Math.min(z.n, 5) / 5 * 20 + Math.min(body / A, 1.5) / 1.5 * 20 + Math.max(0, 1 - Math.abs(depth - 0.55) / 0.55) * 15
          + Math.min(1, cb / 0.6) * 15 + (maxR <= 2.5 * A ? 10 : maxR <= 3.5 * A ? 5 : 0) + Math.min(Number.isFinite(room) ? room : 3, 3) / 3 * 20);
        if (rating < num(p.br_min_rating, 0)) continue;
        const dec = decOf(A);
        const reason = J(
          L(`${up ? 'пробой вверх' : 'пробой вниз'} уровня ${z.lo.toFixed(dec)}–${z.hi.toFixed(dec)} (${z.n} касаний) → ретест → ${K} подтв.`, `${up ? 'Ausbruch nach oben' : 'Ausbruch nach unten'} Level ${z.lo.toFixed(dec)}–${z.hi.toFixed(dec)} (${z.n} Berührungen) → Retest → ${K} Best.`, `${up ? 'breakout up' : 'breakout down'} of ${z.lo.toFixed(dec)}–${z.hi.toFixed(dec)} (${z.n} touches) → retest → ${K} conf.`),
          L(`рейтинг ${rating}/100 (не вероятность)`, `Rating ${rating}/100 (keine Wahrscheinlichkeit)`, `rating ${rating}/100 (not a probability)`),
          L(`пробою ${i - b} св.`, `Ausbruch vor ${i - b} Kerzen`, `breakout ${i - b} candles ago`), rs.v != null ? `RSI ${rs.v.toFixed(0)}` : null, mam.note, aeiNote(p));
        const s = sig(dir, clampN(rating, 1, 99), reason, num(p.expiry, 120));
        s.bar = c[b].time; // one signal per breakout
        return s;
      }
    }
    return null;
  }

  // ---------- registration data ----------
  const META = {
    n_bor: [L('Пробой + ретест + подтверждение', 'Ausbruch + Retest + Bestätigung', 'Breakout + retest + confirmation'), 'trend'],
  };
  const DEFAULTS = { n_bor: BR };
  const S = { n_bor: bor };
  const liveMode = name => (name === 'n_bor' ? 'closed' : null);
  const OWN = ['n_bor'];

  // ---------- presets (one tap; several can be on at once, a signal when any fires) ----------
  // Starting hypotheses for testing – not optimal values and no promise of results.
  const PRESETS = {
    n_bor: [
      { name: L('Строго · 3 касания', 'Streng · 3 Berührungen', 'Strict · 3 touches'), values: { br_filter: 2, br_confirm: 2, br_touches: 3 } },
    ],
  };
  // ---------- labels of the parameters (DE / RU / EN) ----------
  const LB = {
    expiry: L('Экспирация (сек.)', 'Ablauf (Sek.)', 'Expiry (sec.)'),
    aei_on: L('AEI-подсказка на карточке (срок задан вручную)', 'AEI-Hinweis auf der Karte (Ablauf manuell)', 'AEI note on the card (expiry set manually)'),
    mam_on: L('MAM: монитор активности вкл.', 'MAM: Aktivitätsmonitor an', 'MAM: activity monitor on'),
    mam_block: L('MAM: блокировать (выкл. = только предупреждать)', 'MAM: blockieren (aus = nur warnen)', 'MAM: block (off = only warn)'),
    mam_min_act: L('MAM: активность не ниже … × обычной', 'MAM: Aktivität mindestens … × normal', 'MAM: activity at least … × normal'),
    mam_max_stale: L('MAM: макс. доля пропусков/замёрзших котировок', 'MAM: max. Anteil Lücken/eingefrorener Kurse', 'MAM: max. share of gaps/frozen quotes'),
    mam_from: L('MAM: часы с (UTC)', 'MAM: Stunden ab (UTC)', 'MAM: hours from (UTC)'),
    mam_to: L('MAM: часы до (UTC, 24 = без ограничения)', 'MAM: Stunden bis (UTC, 24 = unbegrenzt)', 'MAM: hours to (UTC, 24 = unlimited)'),
    rsi_mode: L('RSI-фильтр: 0 выкл · 1 диапазон · 2 только перегрев', 'RSI-Filter: 0 aus · 1 Bereich · 2 nur Überhitzung', 'RSI filter: 0 off · 1 range · 2 overheat only'),
    rsi_period: L('RSI: период', 'RSI: Periode', 'RSI: period'),
    rsi_min: L('RSI: нижняя граница диапазона (для CALL)', 'RSI: untere Bereichsgrenze (für CALL)', 'RSI: range lower bound (for CALL)'),
    rsi_max: L('RSI: верхняя граница / перегрев (для PUT зеркально)', 'RSI: obere Grenze / Überhitzung (PUT gespiegelt)', 'RSI: upper bound / overheat (PUT mirrored)'),
    br_buy: L('Пробой вверх → CALL', 'Ausbruch oben → CALL', 'Breakout up → CALL'), br_sell: L('Пробой вниз → PUT', 'Ausbruch unten → PUT', 'Breakout down → PUT'),
    br_filter: L('Фильтр качества: 0 OFF · 1 STANDARD · 2 STRICT', 'Qualitätsfilter: 0 OFF · 1 STANDARD · 2 STRICT', 'Quality filter: 0 OFF · 1 STANDARD · 2 STRICT'),
    br_min_rating: L('Минимальный рейтинг 0–100 (не вероятность)', 'Mindest-Rating 0–100 (keine Wahrscheinlichkeit)', 'Minimum rating 0–100 (not a probability)'),
    br_lookback: L('Уровни: сколько закрытых свечей смотреть', 'Level: wie viele geschlossene Kerzen betrachten', 'Levels: how many closed candles to look at'),
    br_touches: L('Уровни: минимум касаний', 'Level: mindestens Berührungen', 'Levels: minimum touches'),
    br_zone_atr: L('Ширина зоны (× ATR)', 'Zonenbreite (× ATR)', 'Zone width (× ATR)'), br_atr_period: L('ATR: период', 'ATR: Periode', 'ATR: period'),
    br_margin_atr: L('Пробой: отступ за зону (× ATR)', 'Ausbruch: Abstand über die Zone (× ATR)', 'Breakout: margin beyond the zone (× ATR)'),
    br_retest_bars: L('Ретест: ждать не больше … свечей после пробоя', 'Retest: höchstens … Kerzen nach dem Ausbruch warten', 'Retest: wait at most … candles after the breakout'),
    br_confirm: L('Подтверждающих свечей подряд (1–3)', 'Bestätigungskerzen in Folge (1–3)', 'Confirming candles in a row (1–3)'),
    br_max_age: L('Возраст пробоя не больше (свечей)', 'Alter des Ausbruchs höchstens (Kerzen)', 'Breakout age at most (candles)'),
  };
  const labelsOf = name => Object.fromEntries(Object.keys(DEFAULTS[name]).filter(k => LB[k]).map(k => [k, LB[k]]));
  const LABELS = { n_bor: labelsOf('n_bor') };

  // ---------- blocks of the settings ----------
  const G = (title, desc, keys) => ({ title, desc, keys });
  const g = (ru, de, en) => L(ru, de, en);
  const MAM_G = G(g('MAM · активность рынка (по желанию)', 'MAM · Marktaktivität (optional)', 'MAM · market activity (optional)'),
    g('По ценам: вялый рынок, пропуски и замёрзшие котировки, часы суток (UTC). Объёма в данных PocketOption нет — он не выдумывается. Выкл. = стратегия как есть; «блокировать» выкл. = только предупреждение в карточке.', 'Aus den Preisen: träger Markt, Lücken und eingefrorene Kurse, Tageszeit (UTC). Volumen liefert PocketOption nicht – es wird nicht erfunden. Aus = Strategie wie sie ist; „blockieren“ aus = nur Warnung in der Karte.', 'From prices: sluggish market, gaps and frozen quotes, hour of day (UTC). PocketOption sends no volume – none is invented. Off = strategy as is; "block" off = only a warning in the card.'),
    ['mam_on', 'mam_block', 'mam_min_act', 'mam_max_stale', 'mam_from', 'mam_to']);
  const RSI_G = G(g('RSI-фильтр (в ТЗ «RCI»)', 'RSI-Filter (in der Vorgabe „RCI“)', 'RSI filter (called "RCI" in the spec)'),
    g('0 — выкл.; 1 — диапазон (CALL при RSI 50–70, PUT зеркально 30–50); 2 — только перегрев (CALL блокируется при RSI ≥ 70, PUT при ≤ 30, нижней границы нет). Значения — для проверки, не универсальные.', '0 aus; 1 Bereich (CALL bei RSI 50–70, PUT gespiegelt 30–50); 2 nur Überhitzung (CALL gesperrt bei RSI ≥ 70, PUT bei ≤ 30, keine untere Grenze). Werte zum Testen, nicht universell.', '0 off; 1 range (CALL at RSI 50–70, PUT mirrored 30–50); 2 overheat only (CALL blocked at RSI ≥ 70, PUT at ≤ 30, no lower bound). Values are for testing, not universal.'),
    ['rsi_mode', 'rsi_period', 'rsi_min', 'rsi_max']);
  const AEI_G = G(g('AEI · экспирация', 'AEI · Ablauf', 'AEI · expiry'),
    g('Срок задаётся вручную. Подсказка на карточке честно пишет, что проверенной оценки по срокам нет (на истории все сроки выглядят одинаково). Автовыбор срока не включён: для него нужна независимая статистика.', 'Der Ablauf wird manuell gesetzt. Der Hinweis auf der Karte sagt ehrlich, dass es keine geprüfte Schätzung je Laufzeit gibt (im Test sehen alle Laufzeiten gleich aus). Automatische Wahl ist nicht aktiv: dafür braucht es unabhängige Statistik.', 'The expiry is set manually. The card note says honestly that there is no verified per-expiry estimate (all expiries look alike in the test). Automatic choice is not active: it needs independent statistics.'),
    ['aei_on']);
  const GROUPS = {
    n_bor: [
      G(g('1 · Основное', '1 · Grundlegendes', '1 · Basics'),
        g('Пробой уровня → ретест → подтверждение → сигнал на следующей свече. Фильтр: 0 OFF только обязательные условия; 1 STANDARD (качество уровня, сила пробоя, нет аномальных свечей, есть место до следующего уровня); 2 STRICT (3 касания, сильнее пробой, меньше места для ошибки). Строже не значит прибыльнее.', 'Ausbruch aus dem Level → Retest → Bestätigung → Signal auf der nächsten Kerze. Filter: 0 OFF nur Pflichtbedingungen; 1 STANDARD (Levelqualität, Ausbruchsstärke, keine Ausreißerkerzen, Platz bis zum nächsten Level); 2 STRICT (3 Berührungen, stärkerer Ausbruch). Strenger heißt nicht profitabler.', 'Level breakout → retest → confirmation → signal on the next candle. Filter: 0 OFF only the mandatory conditions; 1 STANDARD (level quality, breakout strength, no abnormal candles, room to the next level); 2 STRICT (3 touches, stronger breakout). Stricter does not mean more profitable.'),
        ['expiry', 'br_buy', 'br_sell', 'br_filter', 'br_min_rating']),
      G(g('2 · Уровни', '2 · Levels', '2 · Levels'),
        g('Уровни — по подтверждённым вершинам и впадинам (2 свечи с каждой стороны), только по закрытым свечам и только до пробоя. Близкие экстремумы сливаются в зону шириной в долю ATR. Нужно минимум 2 касания.', 'Level aus bestätigten Hochs und Tiefs (2 Kerzen je Seite), nur geschlossene Kerzen und nur vor dem Ausbruch. Nahe Extrema verschmelzen zu einer Zone mit Breite in ATR. Mindestens 2 Berührungen.', 'Levels from confirmed highs and lows (2 candles each side), closed candles only and only before the breakout. Close extremes merge into a zone with a width in ATR. At least 2 touches.'),
        ['br_lookback', 'br_touches', 'br_zone_atr', 'br_atr_period', 'br_margin_atr']),
      G(g('3 · Ретест и подтверждение', '3 · Retest und Bestätigung', '3 · Retest and confirmation'),
        g('После закрытия свечи за зоной цена должна вернуться к зоне (коснуться, не закрыться за дальней границей), затем 1–3 свечи подряд закрываются по направлению за зоной. Нарушение зоны, просроченный ретест или старый пробой — сценарий отменён. Один пробой — один сигнал.', 'Nach dem Schluss hinter der Zone muss der Preis zur Zone zurück (berühren, nicht hinter der fernen Grenze schließen), dann schließen 1–3 Kerzen in Folge in Richtung hinter der Zone. Zonenverletzung, abgelaufener Retest oder alter Ausbruch – Szenario abgebrochen. Ein Ausbruch – ein Signal.', 'After a close beyond the zone the price must return to it (touch, no close beyond the far edge), then 1–3 candles in a row close with the direction beyond the zone. Zone violated, retest expired or breakout too old – scenario cancelled. One breakout – one signal.'),
        ['br_retest_bars', 'br_confirm', 'br_max_age']),
      RSI_G, MAM_G, AEI_G,
    ],
  };
  // ---------- instruction (folded sections, all closed by default; texts apart from the trading logic) ----------
  const sec = (title, ...paras) => ({ title, body: paras });
  const COMMON_HELP = [
    sec(g('Экспирация и AEI', 'Ablauf und AEI', 'Expiry and AEI'),
      g('Экспирация — срок опциона, а не размер свечи: сигнал по закрытой свече M1 с экспирацией 2 мин значит «сделка закончится через 2 минуты после входа». Здесь срок задаётся вручную (параметр «Экспирация»).', 'Der Ablauf ist die Laufzeit der Option, nicht die Kerzengröße: ein Signal auf einer geschlossenen M1-Kerze mit 2 Min. Ablauf heißt „der Trade endet 2 Minuten nach dem Einstieg“. Hier wird er manuell gesetzt (Parameter „Ablauf“).', 'Expiry is the option\'s term, not the candle size: a signal on a closed M1 candle with a 2 min expiry means "the trade ends 2 minutes after entry". Here it is set manually (parameter "Expiry").'),
      g('AEI-подсказка в карточке честно пишет: проверенной оценки по срокам нет — на истории все сроки выглядят одинаково. Автовыбор срока («адаптивный» режим) не включён: ему нужна независимая статистика, а её нет. Срок никогда не меняется после выдачи сигнала.', 'Der AEI-Hinweis in der Karte sagt ehrlich: keine geprüfte Schätzung je Laufzeit – im Test sehen alle Laufzeiten gleich aus. Eine automatische Wahl („adaptiver“ Modus) ist nicht aktiv: sie braucht unabhängige Statistik, die es nicht gibt. Der Ablauf ändert sich nie nach dem Signal.', 'The AEI note in the card says honestly: no verified per-expiry estimate – all expiries look alike in the test. Automatic choice ("adaptive" mode) is not active: it needs independent statistics, which do not exist. The expiry never changes after a signal.'),
      g('Значения подбираются экспериментально; 60 или 120 секунд — стартовые примеры, не оптимум.', 'Werte werden experimentell gewählt; 60 oder 120 Sekunden sind Startbeispiele, kein Optimum.', 'Values are chosen experimentally; 60 or 120 seconds are starting examples, not an optimum.')),
    sec(g('MAM: активность рынка и объём', 'MAM: Marktaktivität und Volumen', 'MAM: market activity and volume'),
      g('MAM смотрит на цены: диапазон последних 10 свечей против медианы последних 100, долю пропусков и замёрзших котировок, часы суток (UTC). Состояния HIGH / NORMAL / LOW / UNKNOWN. Объём PocketOption не отдаёт, поэтому его нет и он не выдумывается — на карточке «объём недоступен». Tick volume и частота обновлений были бы лишь прокси, не настоящий объём.', 'MAM schaut auf die Preise: Spanne der letzten 10 Kerzen gegen den Median der letzten 100, Anteil Lücken und eingefrorener Kurse, Tageszeit (UTC). Zustände HIGH / NORMAL / LOW / UNKNOWN. Volumen liefert PocketOption nicht, also gibt es keins und es wird nicht erfunden – in der Karte „Volumen nicht verfügbar“. Tick-Volumen wäre nur ein Proxy, kein echtes Volumen.', 'MAM looks at the prices: range of the last 10 candles against the median of the last 100, share of gaps and frozen quotes, hour of day (UTC). States HIGH / NORMAL / LOW / UNKNOWN. PocketOption sends no volume, so there is none and none is invented – the card says "volume unavailable". Tick volume would only be a proxy, not real volume.'),
      g('Режимы: выключен (по умолчанию) / только предупреждать / блокировать. Пример: MAM LOW (активность 0,4× обычной) при блокировке — сигнала нет, причина видна. Спокойный рынок не всегда плох, поэтому фильтр не включён сам.', 'Modi: aus (Standard) / nur warnen / blockieren. Beispiel: MAM LOW (Aktivität 0,4× normal) mit Blockieren – kein Signal, der Grund ist sichtbar. Ein ruhiger Markt ist nicht immer schlecht, deshalb ist der Filter nicht von selbst an.', 'Modes: off (default) / only warn / block. Example: MAM LOW (activity 0.4× normal) with blocking – no signal, the reason is visible. A calm market is not always bad, so the filter is not on by itself.')),
    sec(g('Время входа (SET)', 'Einstiegszeit (SET)', 'Entry time (SET)'),
      g('В приложении уже есть время входа и обратный отсчёт на карточке. Сигнал по закрытой свече — вход на открытии следующей свечи; предварительный LIVE-сигнал — «сейчас». Отдельного модуля SET (планирование, перепроверка перед входом, режимы MANUAL / ADVISOR / AUTO-SCHEDULE) нет: приложение не открывает сделки, задержка уведомления на телефоне не измеряется, поэтому «точной секунды» оно не обещает.', 'Die App zeigt auf der Karte schon Einstiegszeit und Countdown. Signal auf geschlossener Kerze – Einstieg zur Öffnung der nächsten Kerze; vorläufiges LIVE-Signal – „jetzt“. Ein eigenes SET-Modul (Planung, Neuprüfung vor dem Einstieg, Modi MANUAL / ADVISOR / AUTO-SCHEDULE) gibt es nicht: die App eröffnet keine Trades und misst die Benachrichtigungsverzögerung am Handy nicht, daher verspricht sie keine „genaue Sekunde“.', 'The app already shows the entry time and a countdown on the card. A signal on a closed candle – entry at the next candle open; a provisional LIVE signal – "now". There is no separate SET module (planning, re-check before entry, MANUAL / ADVISOR / AUTO-SCHEDULE modes): the app opens no trades and does not measure the notification delay on the phone, so it promises no "exact second".'),
      g('Кнопка «Взял?» ведёт вашу собственную статистику, отдельную от статистики бота. Автоторговли и мартингейла в приложении нет.', 'Die Taste „Genommen?“ führt deine eigene Statistik, getrennt von der des Bots. Es gibt keinen Auto-Handel und kein Martingale.', 'The "Taken?" button keeps your own statistics, apart from the bot\'s. There is no auto trading and no martingale.')),
    sec(g('OTC и REAL', 'OTC und REAL', 'OTC and REAL'),
      g('Котировки OTC формирует сам брокер: у них нет внешнего объёма и новостей, они могут вести себя иначе, чем реальный рынок. Рынок и список пар выбираются в общих настройках. Все проверки этих стратегий сделаны на OTC-парах (другой истории у нас нет), поэтому о REAL ничего не утверждается. Разделение OTC/REAL в статистике приложения не сделано.', 'OTC-Kurse stellt der Broker selbst: sie haben kein externes Volumen und keine Nachrichten und können sich anders verhalten als der echte Markt. Markt und Paare werden in den allgemeinen Einstellungen gewählt. Alle Tests dieser Strategien liefen auf OTC-Paaren (andere Historie haben wir nicht), über REAL wird also nichts behauptet. Eine OTC/REAL-Trennung in der Statistik der App gibt es nicht.', 'OTC quotes are made by the broker itself: they have no external volume and no news and can behave differently from the real market. Market and pairs are chosen in the general settings. All tests of these strategies ran on OTC pairs (we have no other history), so nothing is claimed about REAL. The app statistics do not split OTC/REAL.')),
    sec(g('Ограничения и проверка', 'Grenzen und Prüfung', 'Limits and testing'),
      g('Проверка — на закрытых свечах реальных OTC-котировок за 5 дней (28.10–02.11.2026), без заглядывания в будущее; первые 3 дня — отбор, последние 2 — независимая проверка. Результаты — история, не обещание. Безубыточность при выплате 85 % — 54,05 %, при 80 % — 55,56 %; доверительный интервал показывает, насколько мало данных.', 'Geprüft wurde auf geschlossenen Kerzen echter OTC-Kurse von 5 Tagen (28.10.–02.11.2026), ohne Blick in die Zukunft; die ersten 3 Tage zur Auswahl, die letzten 2 zur unabhängigen Prüfung. Ergebnisse sind Historie, kein Versprechen. Break-even bei 85 % Auszahlung: 54,05 %, bei 80 %: 55,56 %; das Konfidenzintervall zeigt, wie wenig Daten es sind.', 'Tested on closed candles of real OTC quotes of 5 days (28.10–02.11.2026), without looking into the future; the first 3 days for selection, the last 2 as an independent check. Results are history, not a promise. Break-even at an 85 % payout is 54.05 %, at 80 % it is 55.56 %; the confidence interval shows how little data there is.'),
      g('Не проверено: режим LIVE (приложение не хранит тики), секундные 5-секундные снимки DI, реальный объём, задержка исполнения, работа в реальном времени дольше нескольких дней. Режим LIVE и 5-секундные данные нужно собирать и проверять отдельно (форвард-тест на демо).', 'Nicht geprüft: LIVE-Modus (die App speichert keine Ticks), 5-Sekunden-Schnappschüsse der DI, echtes Volumen, Ausführungsverzögerung, Echtzeitbetrieb über mehr als ein paar Tage. LIVE und 5-Sekunden-Daten müssen separat gesammelt und geprüft werden (Forward-Test auf Demo).', 'Not tested: LIVE mode (the app stores no ticks), 5-second DI snapshots, real volume, execution delay, real-time operation for more than a few days. LIVE and 5-second data have to be collected and tested separately (forward test on demo).')),
  ];
  const HELP = {
    n_bor: [
      sec(g('Как работает сигнал', 'Wie das Signal entsteht', 'How the signal works'),
        g('1) Находится зона сопротивления (для CALL) или поддержки (для PUT) по закрытым свечам — до пробоя. 2) Свеча закрывается за зоной (первое закрытие за ней). 3) Цена возвращается к зоне и касается её, но не закрывается за дальней границей — ретест. 4) Подряд 1–3 свечи (по умолчанию 2) закрываются по направлению за зоной. После последнего подтверждения — сигнал; вход на открытии следующей свечи. Один пробой — один сигнал.', '1) Es wird eine Widerstandszone (für CALL) oder Unterstützungszone (für PUT) aus geschlossenen Kerzen gefunden – vor dem Ausbruch. 2) Eine Kerze schließt hinter der Zone (erster Schluss dahinter). 3) Der Preis kehrt zur Zone zurück und berührt sie, schließt aber nicht hinter der fernen Grenze – Retest. 4) 1–3 Kerzen (Standard 2) in Folge schließen in Richtung hinter der Zone. Nach der letzten Bestätigung – Signal; Einstieg zur Öffnung der nächsten Kerze. Ein Ausbruch – ein Signal.', '1) A resistance zone (for CALL) or support zone (for PUT) is found from closed candles – before the breakout. 2) A candle closes beyond the zone (first close beyond it). 3) The price returns to the zone and touches it but does not close beyond the far edge – the retest. 4) 1–3 candles (default 2) in a row close with the direction beyond the zone. After the last confirmation – the signal; entry at the next candle open. One breakout – one signal.'),
        g('Сценарий отменяется, если цена закрылась за дальней границей зоны, ретест не случился за N свечей, пробой слишком старый или подтверждающая свеча идёт против. Нет сигнала по незакрытым свечам и нет будущих данных.', 'Das Szenario wird abgebrochen, wenn der Preis hinter der fernen Zonengrenze schloss, der Retest in N Kerzen nicht kam, der Ausbruch zu alt ist oder eine Bestätigungskerze gegenläuft. Kein Signal auf nicht geschlossenen Kerzen und keine Zukunftsdaten.', 'The scenario is cancelled if the price closed beyond the far edge of the zone, the retest did not come within N candles, the breakout is too old or a confirming candle goes against. No signal on unclosed candles and no future data.')),
      sec(g('Уровни и зоны', 'Level und Zonen', 'Levels and zones'),
        g('Уровень — это зона, а не одна цена: подтверждённые вершины и впадины (по 2 свечи с каждой стороны) за последние 100 закрытых свечей, близкие объединяются, ширина зоны — доля ATR (по умолчанию 0,5). Минимум 2 касания. Зоны ищутся только по свечам до пробоя и независимы по паре, рынку и таймфрейму.', 'Ein Level ist eine Zone, nicht ein Preis: bestätigte Hochs und Tiefs (je 2 Kerzen pro Seite) der letzten 100 geschlossenen Kerzen, nahe werden vereint, die Zonenbreite ist ein ATR-Anteil (Standard 0,5). Mindestens 2 Berührungen. Zonen werden nur aus Kerzen vor dem Ausbruch gesucht und sind je Paar, Markt und Zeitrahmen unabhängig.', 'A level is a zone, not one price: confirmed highs and lows (2 candles each side) of the last 100 closed candles, close ones are merged, the zone width is a share of ATR (default 0.5). At least 2 touches. Zones are looked for only in candles before the breakout and are independent per pair, market and timeframe.')),
      sec(g('Рейтинг 0–100 и фильтры качества', 'Rating 0–100 und Qualitätsfilter', 'Rating 0–100 and quality filters'),
        g('Рейтинг складывается из: касаний уровня (до 20), силы пробоя — тела свечи в ATR (до 20), глубины ретеста (до 15), плотности подтверждающих свечей (до 15), отсутствия аномальных свечей (до 10), места до следующего уровня (до 20). Это эвристика, НЕ вероятность: рейтинг 80 не значит 80 % выигрышей.', 'Das Rating setzt sich zusammen aus: Berührungen des Levels (bis 20), Ausbruchsstärke – Kerzenkörper in ATR (bis 20), Retesttiefe (bis 15), Dichte der Bestätigungskerzen (bis 15), keine Ausreißerkerzen (bis 10), Platz bis zum nächsten Level (bis 20). Das ist eine Heuristik, KEINE Wahrscheinlichkeit: Rating 80 heißt nicht 80 % Gewinne.', 'The rating adds up from: level touches (up to 20), breakout strength – candle body in ATR (up to 20), retest depth (up to 15), density of the confirming candles (up to 15), no abnormal candles (up to 10), room to the next level (up to 20). It is a heuristic, NOT a probability: rating 80 does not mean 80 % wins.'),
        g('Фильтр 0 OFF — только обязательные условия. 1 STANDARD — минимум 2 касания, тело пробоя ≥ 0,5 ATR, нет свечи шире 3 ATR, место до следующего уровня ≥ 0,5. 2 STRICT — 3 касания, тело ≥ 0,9 ATR, нет свечи шире 2,5 ATR, место ≥ 1. Строже не значит прибыльнее — проверяйте в таблице результатов.', 'Filter 0 OFF – nur Pflichtbedingungen. 1 STANDARD – mindestens 2 Berührungen, Ausbruchskörper ≥ 0,5 ATR, keine Kerze breiter als 3 ATR, Platz bis zum nächsten Level ≥ 0,5. 2 STRICT – 3 Berührungen, Körper ≥ 0,9 ATR, keine Kerze breiter als 2,5 ATR, Platz ≥ 1. Strenger heißt nicht profitabler – in der Ergebnistabelle prüfen.', 'Filter 0 OFF – only the mandatory conditions. 1 STANDARD – at least 2 touches, breakout body ≥ 0.5 ATR, no candle wider than 3 ATR, room to the next level ≥ 0.5. 2 STRICT – 3 touches, body ≥ 0.9 ATR, no candle wider than 2.5 ATR, room ≥ 1. Stricter does not mean more profitable – check the results table.')),
      sec(g('Таймфрейм', 'Zeitrahmen', 'Timeframe'),
        g('Таймфрейм сигнала выбирается вверху стратегии (M1, M2, M3, M5): это размер свечи, на которой ищутся пробой и ретест. Он не равен экспирации. На M1 пробоев много и они шумные, на M3/M5 их меньше. Какой таймфрейм лучше — решает только проверка (см. таблицу результатов).', 'Der Signal-Zeitrahmen wird oben in der Strategie gewählt (M1, M2, M3, M5): die Kerzengröße, auf der Ausbruch und Retest gesucht werden. Er ist nicht gleich dem Ablauf. Auf M1 gibt es viele, rauschige Ausbrüche, auf M3/M5 weniger. Welcher Zeitrahmen besser ist, entscheidet nur die Prüfung (siehe Ergebnistabelle).', 'The signal timeframe is chosen at the top of the strategy (M1, M2, M3, M5): the candle size on which the breakout and retest are looked for. It is not the expiry. On M1 breakouts are many and noisy, on M3/M5 fewer. Which timeframe is better is decided only by testing (see the results table).')),
      sec(g('Почему сигнала нет?', 'Warum kein Signal?', 'Why no signal?'),
        g('Нет пробоя уровня с нужным числом касаний; цена не вернулась к зоне; зона нарушена; нет подтверждающих свечей по направлению; пробой слишком старый; не прошёл фильтр качества, рейтинг, RSI или MAM. «Подходящих сигналов нет» — полноценный исход.', 'Kein Ausbruch eines Levels mit genug Berührungen; der Preis kam nicht zur Zone zurück; die Zone wurde verletzt; keine Bestätigungskerzen in Richtung; Ausbruch zu alt; Qualitätsfilter, Rating, RSI oder MAM nicht bestanden. „Keine passenden Signale“ ist ein vollwertiges Ergebnis.', 'No breakout of a level with enough touches; the price did not return to the zone; the zone was violated; no confirming candles with the direction; breakout too old; the quality filter, rating, RSI or MAM not passed. "No suitable signals" is a full outcome.')),
      ...COMMON_HELP,
    ],
  };
  // result tables of the walk-forward backtest (generated by tools/gen-pro-tests.js)
  const TESTS = require('./pro_tests_data');
  return { META, DEFAULTS, S, PRESETS, GROUPS, TESTS, HELP, LABELS, liveMode, OWN, mamCheck, rsiCheck, swingZones, helpers: { RSI_F, MAM, AEI, L, J } };
};
