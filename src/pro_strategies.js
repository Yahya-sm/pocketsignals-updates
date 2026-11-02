'use strict';
// Three strategies from the user's specs of 02.11.2026, adapted to this app's engine (candles of M1…M5, no order
// execution). Pure functions of the candles they get – the "state machines" of the specs are derived from the history
// (stateless, no look-ahead), one signal per event through the `bar` key:
//   n_adxmicro  ADX / DMI Micro-Impulse, modes A BASE ADX · B ADX CROSS · C EARLY DI IMPULSE · D CUSTOM
//   n_bor       Breakout + Retest + Confirmation
//   n_apc       APC Pro – Adaptive Pullback Continuation (impulse → pullback → resumption)
// Shared parts: RSI filter (OFF / RANGE / OVERHEAT ONLY), MAM-lite (market activity from prices – the feed has no
// volume), AEI note (expiry stays manual – there is no verified per-expiry estimate). SET is the app's own entry
// countdown. Honest limits are written in HELP (shown folded in the strategy).
module.exports = function (h) {
  const { I, L, sig, roomAhead } = h;
  const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
  const nowSec = () => Date.now() / 1000;
  const sgn = Math.sign;
  const median = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const crossAt = (u, w, i) => {
    if ([u[i], w[i], u[i - 1], w[i - 1]].some(v => v == null)) return 0;
    return u[i - 1] <= w[i - 1] && u[i] > w[i] ? 1 : u[i - 1] >= w[i - 1] && u[i] < w[i] ? -1 : 0;
  };
  const isForming = (c, tfSec) => c.length > 0 && c[c.length - 1].time + tfSec > nowSec();
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

  // Trend of a higher timeframe: close on the right side of EMA 20 and the EMA pointing that way.
  const htfDir = cands => {
    if (!cands || cands.length < 25) return 0;
    const cl = cands.map(q => q.close), e = I.ema(cl, 20), n = cl.length - 1;
    return cl[n] > e[n] && e[n] > e[n - 2] ? 1 : cl[n] < e[n] && e[n] < e[n - 2] ? -1 : 0;
  };

  // =====================================================================================================
  // 1. ADX / DMI Micro-Impulse
  // =====================================================================================================
  const AM = {
    expiry: 120, am_mode: 'A', am_live: false, am_adx_period: 14, am_buy: true, am_sell: true,
    am_adx_thr: 25, am_hyst: 2, am_cooldown: 5, am_rearm_bars: 60,
    am_cross_mode: 'BOTH', am_conv_min: 1, am_use_speed: false, am_speed_min: 0.5, am_use_acc: false, am_acc_min: 0, am_dist_max: 15, am_confirm: 2, am_ttl: 4,
    am_t_dicross: true, am_t_adxcross: false, am_t_pre: false, am_logic: 'ANY',
    am_use_adx_min: false, am_adx_min: 25, am_use_adx_rise: false, am_adx_rise: 0.5, am_use_adx_max: false, am_adx_max: 45,
    am_use_di_gap: false, am_di_gap: 5, am_use_vortex: false, am_vortex_period: 14,
    am_use_price: false, am_use_imp: false, am_imp_min: 0.5, am_imp_max: 3, am_use_exh: false, am_exh_atr: 2.5,
    ...RSI_F, ...MAM, ...AEI,
  };

  function adxMicro(x, p) {
    const tfMin = x.tfMin || 1, tfSec = tfMin * 60, raw = x.c, formingNow = isForming(raw, tfSec);
    const live = !!p.am_live;
    // CLOSED (default): only confirmed candles – a candle that is still forming is dropped. LIVE (experimental): the
    // forming candle is the last bar, DI/ADX are recomputed from scratch on closed bars + this one (never accumulated).
    const c = live || !formingNow ? raw : raw.slice(0, -1), i = c.length - 1;
    if (i < 60) return null;
    const prov = live && formingNow;
    const per = num(p.am_adx_period, 14), a = per === 14 && c === x.c ? x.adx : I.adx(c, per);
    if (!a[i] || !a[i - 1]) return null;
    const dp = a.map(q => q && q.pdi), dm = a.map(q => q && q.mdi);
    const atr = I.atr(c, 14)[i], mode = String(p.am_mode || 'A').toUpperCase(), thr = num(p.am_adx_thr, 25);

    const trigDi = () => crossAt(dp, dm, i);
    const trigAdx = () => {
      if (!(a[i - 1].adx < thr && a[i].adx >= thr)) return 0;
      // re-arm (derived from the history): an earlier up-cross of the threshold must be at least `cooldown` candles ago
      // and ADX must have dipped to ≤ threshold − hysteresis since then – no repeated signal while ADX just stays high.
      const hyst = num(p.am_hyst, 2), cd = num(p.am_cooldown, 0), look = num(p.am_rearm_bars, 60);
      for (let j = i - 1; j > Math.max(1, i - look); j--) {
        if (a[j] && a[j - 1] && a[j - 1].adx < thr && a[j].adx >= thr) {
          if (i - j < cd) return 0;
          let mn = Infinity; for (let q = j; q < i; q++) if (a[q]) mn = Math.min(mn, a[q].adx);
          if (mn > thr - hyst) return 0;
          break;
        }
      }
      return sgn(a[i].pdi - a[i].mdi);
    };
    // Early DI impulse: the minority DI line closes in on the other one (+DI below −DI → CALL candidate, mirror → PUT).
    const elapsed = j => (j === i && prov ? Math.max(0.25, (nowSec() - c[j].time) / 60) : tfMin); // minutes between the two DI values
    const dist = j => Math.abs(dp[j] - dm[j]), conv = j => dist(j - 1) - dist(j);
    const preQual = j => {
      if (j < 2 || !a[j] || !a[j - 1] || !a[j - 2]) return 0;
      const s1 = sgn(dp[j] - dm[j]); if (!s1 || sgn(dp[j - 1] - dm[j - 1]) !== s1) return 0; // still on the same side: not crossed yet
      const cv = conv(j); if (!(cv >= num(p.am_conv_min, 1))) return 0;
      if (dist(j) > num(p.am_dist_max, 15)) return 0;
      if (p.am_use_speed && !(cv / elapsed(j) >= num(p.am_speed_min, 0.5))) return 0;
      if (p.am_use_acc && !(cv - conv(j - 1) >= num(p.am_acc_min, 0))) return 0;
      return s1 < 0 ? 1 : -1;
    };
    let preBar = null;
    const trigPre = () => {
      const d = preQual(i); if (!d) return 0;
      for (let q = 1; q < Math.max(1, num(p.am_confirm, 2)); q++) if (preQual(i - q) !== d) return 0;
      let s0 = i; while (s0 > 2 && preQual(s0 - 1) === d) s0--;
      if (i - s0 >= num(p.am_ttl, 4)) return 0; // the candidate expired (INVALIDATED)
      preBar = c[s0].time; return d;
    };
    const preRecent = d => { for (let q = 1; q <= num(p.am_ttl, 4) + num(p.am_confirm, 2); q++) if (preQual(i - q) === d) return true; return false; };

    let dir = 0, eventBar = c[i].time;
    if (mode === 'A') { const d = trigDi(); if (d && a[i].adx >= thr) dir = d; }
    else if (mode === 'B') dir = trigAdx();
    else if (mode === 'C') {
      const cm = String(p.am_cross_mode || 'BOTH').toUpperCase();
      if (cm !== 'CROSS') { dir = trigPre(); if (dir) eventBar = preBar; }
      if (!dir && cm !== 'PRE') { const d = trigDi(); if (d && !preRecent(d)) dir = d; } // one move – one signal
    } else {
      const on = [];
      if (p.am_t_dicross) on.push(trigDi());
      if (p.am_t_adxcross) on.push(trigAdx());
      if (p.am_t_pre) on.push(trigPre());
      if (!on.length) return null;
      const nz = on.filter(Boolean);
      if (String(p.am_logic || 'ANY').toUpperCase() === 'ALL') dir = nz.length === on.length && nz.every(d => d === nz[0]) ? nz[0] : 0;
      else dir = nz.length && nz.every(d => d === nz[0]) ? nz[0] : 0;
      if (dir && p.am_t_pre && preBar) eventBar = preBar;
    }
    if (!dir || (dir > 0 && p.am_buy === false) || (dir < 0 && p.am_sell === false)) return null;

    // Independent filters (each ON/OFF).
    if (p.am_use_adx_min && a[i].adx < num(p.am_adx_min, 25)) return null;
    if (p.am_use_adx_rise && !(a[i].adx - a[i - 1].adx >= num(p.am_adx_rise, 0.5))) return null;
    if (p.am_use_adx_max && a[i].adx > num(p.am_adx_max, 45)) return null;
    if (p.am_use_di_gap && Math.abs(a[i].pdi - a[i].mdi) < num(p.am_di_gap, 5)) return null;
    if (p.am_use_vortex) { const v = I.vortex(c, num(p.am_vortex_period, 14))[i]; if (!v || sgn(v.plus - v.minus) !== dir) return null; }
    const k = c[i];
    if (p.am_use_price && !(sgn(k.close - k.open) === dir && (dir > 0 ? k.close > c[i - 1].close : k.close < c[i - 1].close))) return null;
    if (p.am_use_imp && atr > 0) {
      const mv = (k.close - c[i - 3].open) * dir / atr;
      let w = 0; for (let j = i - 2; j <= i; j++) if (sgn(c[j].close - c[j].open) === dir) w++;
      if (w < 2 || mv < num(p.am_imp_min, 0.5) || mv > num(p.am_imp_max, 3)) return null;
    }
    if (p.am_use_exh && atr > 0) {
      const e = I.ema(c.map(q => q.close), 20)[i];
      if (e != null && (k.close - e) * dir / atr > num(p.am_exh_atr, 2.5)) return null;
    }
    const rs = rsiCheck(c, i, p, dir); if (!rs.ok) return null;
    const mam = mamCheck(c, i, p, tfSec); if (mam.block) return null;

    const dec = decOf(atr), up = dir > 0;
    const reason = J(
      L(`ADX/DMI ${mode}${mode === 'C' ? ' ' + String(p.am_cross_mode || 'BOTH').toUpperCase() : ''}: ${up ? 'вверх' : 'вниз'}`, `ADX/DMI ${mode}: ${up ? 'aufwärts' : 'abwärts'}`, `ADX/DMI ${mode}: ${up ? 'up' : 'down'}`),
      `ADX ${a[i].adx.toFixed(0)} · +DI ${a[i].pdi.toFixed(0)} / −DI ${a[i].mdi.toFixed(0)} · ${live ? 'LIVE' : 'CLOSED'}`,
      prov ? L('ПРЕДВАРИТЕЛЬНО (свеча не закрыта, может исчезнуть)', 'VORLÄUFIG (Kerze läuft, kann verschwinden)', 'PROVISIONAL (candle still forming, may vanish)') : null,
      rs.v != null ? `RSI ${rs.v.toFixed(0)}` : null, mam.note, aeiNote(p), atr > 0 ? `ATR ${atr.toFixed(dec)}` : null);
    const s = sig(dir, Math.round(50 + Math.min(40, a[i].adx)), reason, num(p.expiry, 120)); // strength = ADX score (not a probability)
    s.bar = eventBar;
    if (prov) s.entry = Math.floor(nowSec());
    return s;
  }

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

  // =====================================================================================================
  // 3. APC Pro – Adaptive Pullback Continuation
  // =====================================================================================================
  const APC = {
    expiry: 120, apc_buy: true, apc_sell: true, apc_atr_period: 14,
    apc_imp_min_n: 3, apc_imp_max_n: 8, apc_imp_min_atr: 2, apc_imp_max_atr: 6, apc_imp_speed: 0.4, apc_imp_cons: 0.6, apc_age: 12,
    apc_pb_min: 0.2, apc_pb_max: 0.6, apc_pb_bars: 6, apc_pb_acc: 1.5, apc_res_n: 2,
    apc_rsi_mode: 1, apc_rsi_hi: 70, apc_ext_mode: 1, apc_ext_atr: 6, apc_exh_on: true,
    apc_ctx_m5: false, apc_ctx_m15: false, ...RSI_F, ...MAM, ...AEI,
  };

  function apc(x, p) {
    const c = x.c, i = x.last, tfSec = (x.tfMin || 1) * 60;
    const resN = Math.max(1, Math.round(num(p.apc_res_n, 2))), pbMax = Math.max(1, Math.round(num(p.apc_pb_bars, 6)));
    const impMinN = Math.max(2, Math.round(num(p.apc_imp_min_n, 3))), impMaxN = Math.max(impMinN, Math.round(num(p.apc_imp_max_n, 8)));
    if (i < 40 + impMaxN + pbMax) return null;
    const atrA = I.atr(c, num(p.apc_atr_period, 14));
    const mam = mamCheck(c, i, p, tfSec); if (mam.block) return null;
    const close = c.map(k => k.close), rsiA = I.rsi(close, num(p.apc_rsi_period, 14));
    const pe = i - resN; // last pullback candle
    for (const dir of [1, -1]) {
      if ((dir > 0 && p.apc_buy === false) || (dir < 0 && p.apc_sell === false)) continue;
      const up = dir > 0;
      // IMPULSE end e: the most extreme candle shortly before the pullback; the pullback is e+1 … pe (at least one candle).
      let e = -1;
      for (let j = pe - pbMax; j <= pe; j++) if (e < 0 || (up ? c[j].high >= c[e].high : c[j].low <= c[e].low)) e = j;
      if (e < 0 || e >= pe || i - e > num(p.apc_age, 12)) continue;
      // impulse start s0: the opposite extreme within the last impMaxN candles up to e
      let s0 = -1;
      for (let j = e - impMaxN + 1; j <= e; j++) if (s0 < 0 || (up ? c[j].low < c[s0].low : c[j].high > c[s0].high)) s0 = j;
      const n = e - s0 + 1; if (n < impMinN) continue;
      const A = atrA[Math.max(1, s0 - 1)]; if (!(A > 0)) continue; // volatility BEFORE the impulse: a jump must not inflate its own yardstick
      const start = up ? c[s0].low : c[s0].high, top = up ? c[e].high : c[e].low, move = Math.abs(top - start), moveA = move / A;
      if (moveA < num(p.apc_imp_min_atr, 2) || moveA > num(p.apc_imp_max_atr, 6)) continue; // moderate impulse: not too small, not a jump
      if (moveA / n < num(p.apc_imp_speed, 0.4)) continue;
      let withDir = 0, big = 0, bodySum = 0;
      for (let j = s0; j <= e; j++) { if (sgn(c[j].close - c[j].open) === dir) withDir++; if (c[j].high - c[j].low > 2.5 * A) big++; bodySum += Math.abs(c[j].close - c[j].open); }
      if (withDir / n < num(p.apc_imp_cons, 0.6)) continue;
      // PULLBACK: depth as a share of the impulse, never through the impulse start, no strong counter candle
      let pbLo = up ? Infinity : -Infinity, pbHi = up ? -Infinity : Infinity, counter = false;
      for (let j = e + 1; j <= pe; j++) {
        pbLo = up ? Math.min(pbLo, c[j].low) : Math.max(pbLo, c[j].high);
        pbHi = up ? Math.max(pbHi, c[j].high) : Math.min(pbHi, c[j].low);
        if (sgn(c[j].close - c[j].open) === -dir && Math.abs(c[j].close - c[j].open) > num(p.apc_pb_acc, 1.5) * A) counter = true;
      }
      const retr = Math.abs(top - pbLo) / move;
      if (counter || retr < num(p.apc_pb_min, 0.2) || retr > num(p.apc_pb_max, 0.6) || (up ? pbLo <= start : pbLo >= start)) continue;
      // RESUMPTION: resN candles with the direction, each closing beyond the previous close; the last breaks the pullback's local extreme
      let res = true;
      for (let k = pe + 1; k <= i; k++) if (!(sgn(c[k].close - c[k].open) === dir && (up ? c[k].close > c[k - 1].close : c[k].close < c[k - 1].close))) res = false;
      if (!res || !(up ? c[i].high > pbHi && c[i].close > pbHi : c[i].low < pbHi && c[i].close < pbHi)) continue;
      // FINAL CHECK: RSI overheat, price extension, exhaustion, context
      const notes = [];
      const rsV = rsiA[i], hi = num(p.apc_rsi_hi, 70), rm = num(p.apc_rsi_mode, 1);
      if (rm && rsV != null && (up ? rsV >= hi : rsV <= 100 - hi)) { if (rm === 1) continue; notes.push(L(`⚠ RSI ${rsV.toFixed(0)} перегрев`, `⚠ RSI ${rsV.toFixed(0)} überhitzt`, `⚠ RSI ${rsV.toFixed(0)} overheated`)); }
      const ext = Math.abs(c[i].close - start) / A, em = num(p.apc_ext_mode, 1);
      if (em && ext > num(p.apc_ext_atr, 6)) { if (em === 1) continue; notes.push(L(`⚠ растяжение ${ext.toFixed(1)} ATR`, `⚠ Dehnung ${ext.toFixed(1)} ATR`, `⚠ extension ${ext.toFixed(1)} ATR`)); }
      if (p.apc_exh_on) {
        const rb = Math.abs(c[i].close - c[i].open), avgB = bodySum / n;
        const h2 = Math.min(2, Math.floor(n / 2));
        let b1 = 0, b2 = 0; for (let q = 0; q < h2; q++) { b1 += Math.abs(c[s0 + q].close - c[s0 + q].open); b2 += Math.abs(c[e - q].close - c[e - q].open); }
        if (big >= 2 || rb < 0.4 * avgB || (h2 >= 2 && b2 < 0.5 * b1)) continue; // oversized candles, weak resumption or a slowing impulse
      }
      const ctxs = [p.apc_ctx_m5 && 'M5', p.apc_ctx_m15 && 'M15'].filter(Boolean);
      if (ctxs.some(t => htfDir(x.ctx && x.ctx[t]) !== dir)) continue;
      const rs = rsiCheck(c, i, p, dir, rsiA); if (!rs.ok) continue;
      const dec = decOf(A);
      // heuristic score (documented in the help, NOT a probability): pullback depth in the sweet spot, clean impulse, calm RSI, context
      const score = Math.round(50 + (retr >= 0.3 && retr <= 0.5 ? 10 : 5) + (withDir / n >= 0.8 ? 10 : 5) + (rsV != null && (up ? rsV < hi - 10 : rsV > 110 - hi) ? 10 : 0) + (ctxs.length ? 10 : 0) + (ext <= num(p.apc_ext_atr, 6) / 2 ? 10 : 5));
      const reason = J(
        L(`APC: импульс ${n} св. ${moveA.toFixed(1)} ATR → откат ${(100 * retr).toFixed(0)}% за ${pe - e} св. → возобновление ${resN} св.`, `APC: Impuls ${n} Kerzen ${moveA.toFixed(1)} ATR → Rücklauf ${(100 * retr).toFixed(0)}% in ${pe - e} Kerzen → Wiederaufnahme ${resN}`, `APC: impulse ${n} candles ${moveA.toFixed(1)} ATR → pullback ${(100 * retr).toFixed(0)}% in ${pe - e} candles → resumption ${resN}`),
        L(`уровень ${pbHi.toFixed(dec)} пробит`, `Level ${pbHi.toFixed(dec)} durchbrochen`, `level ${pbHi.toFixed(dec)} broken`),
        rsV != null ? `RSI ${rsV.toFixed(0)}` : null, L(`растяжение ${ext.toFixed(1)} ATR`, `Dehnung ${ext.toFixed(1)} ATR`, `extension ${ext.toFixed(1)} ATR`),
        ctxs.length ? L(`контекст ${ctxs.join('+')} совпадает`, `Kontext ${ctxs.join('+')} passt`, `context ${ctxs.join('+')} agrees`) : null,
        ...notes, L('оценка эвристическая, не вероятность', 'Score heuristisch, keine Wahrscheinlichkeit', 'heuristic score, not a probability'), mam.note, aeiNote(p));
      const s = sig(dir, clampN(score, 1, 99), reason, num(p.expiry, 120));
      s.bar = c[e].time; // one signal per impulse
      return s;
    }
    return null;
  }

  // ---------- registration data ----------
  const META = {
    n_adxmicro: [L('ADX / DMI Micro-Impulse (режимы A/B/C/D)', 'ADX / DMI Micro-Impulse (Modi A/B/C/D)', 'ADX / DMI Micro-Impulse (modes A/B/C/D)'), 'trend'],
    n_bor: [L('Пробой + ретест + подтверждение', 'Ausbruch + Retest + Bestätigung', 'Breakout + retest + confirmation'), 'trend'],
    n_apc: [L('APC Pro: продолжение после отката', 'APC Pro: Fortsetzung nach Rücklauf', 'APC Pro: pullback continuation'), 'trend'],
  };
  const DEFAULTS = { n_adxmicro: AM, n_bor: BR, n_apc: APC };
  const S = { n_adxmicro: adxMicro, n_bor: bor, n_apc: apc };
  const liveMode = (name, p) => (name === 'n_adxmicro' ? (p.am_live ? 'live' : 'closed') : name === 'n_bor' || name === 'n_apc' ? 'closed' : null);
  const OWN = ['n_adxmicro', 'n_bor', 'n_apc'];

  // ---------- presets (one tap; several can be on at once, a signal when any fires) ----------
  // Starting hypotheses for testing – not optimal values and no promise of results.
  const AM_OFF = { am_use_adx_min: false, am_use_adx_rise: false, am_use_adx_max: false, am_use_di_gap: false, am_use_vortex: false, am_use_price: false,
    am_use_imp: false, am_use_exh: false, am_use_speed: false, am_use_acc: false, rsi_mode: 0, mam_on: false, am_t_dicross: false, am_t_adxcross: false, am_t_pre: false };
  const PRESETS = {
    n_adxmicro: [
      { name: L('A · BASE ADX (контроль)', 'A · BASE ADX (Kontrolle)', 'A · BASE ADX (control)'), values: { ...AM_OFF, am_mode: 'A', am_live: false, am_adx_thr: 25 } },
      { name: L('B · ADX CROSS', 'B · ADX CROSS', 'B · ADX CROSS'), values: { ...AM_OFF, am_mode: 'B', am_live: false, am_adx_thr: 25, am_hyst: 2, am_cooldown: 5 } },
      { name: L('C · EARLY DI IMPULSE (закрытые)', 'C · EARLY DI IMPULSE (geschlossen)', 'C · EARLY DI IMPULSE (closed)'), values: { ...AM_OFF, am_mode: 'C', am_live: false, am_cross_mode: 'BOTH', am_conv_min: 1, am_dist_max: 15, am_confirm: 2, am_ttl: 4 } },
      { name: L('C · EARLY DI IMPULSE · LIVE (эксперимент)', 'C · EARLY DI IMPULSE · LIVE (Experiment)', 'C · EARLY DI IMPULSE · LIVE (experimental)'), values: { ...AM_OFF, am_mode: 'C', am_live: true, am_cross_mode: 'BOTH', am_conv_min: 1, am_dist_max: 15, am_confirm: 2, am_ttl: 4 } },
      { name: L('D · CUSTOM: пример (ADX-cross + Vortex + RSI-перегрев)', 'D · CUSTOM: Beispiel (ADX-Cross + Vortex + RSI-Überhitzung)', 'D · CUSTOM: example (ADX cross + Vortex + RSI overheat)'),
        values: { ...AM_OFF, am_mode: 'D', am_live: false, am_t_adxcross: true, am_logic: 'ANY', am_use_vortex: true, rsi_mode: 2, rsi_max: 75, am_use_adx_max: true, am_adx_max: 45 } },
    ],
    n_bor: [
      { name: L('Без фильтров (OFF)', 'Ohne Filter (OFF)', 'No filters (OFF)'), values: { br_filter: 0, br_confirm: 2, br_touches: 2 } },
      { name: L('Стандарт · 2 подтверждения', 'Standard · 2 Bestätigungen', 'Standard · 2 confirmations'), values: { br_filter: 1, br_confirm: 2, br_touches: 2 } },
      { name: L('Строго · 3 касания', 'Streng · 3 Berührungen', 'Strict · 3 touches'), values: { br_filter: 2, br_confirm: 2, br_touches: 3 } },
      { name: L('Раньше · 1 подтверждение', 'Früher · 1 Bestätigung', 'Earlier · 1 confirmation'), values: { br_filter: 1, br_confirm: 1, br_touches: 2 } },
    ],
    n_apc: [
      { name: L('P1 CONSERVATIVE', 'P1 CONSERVATIVE', 'P1 CONSERVATIVE'), values: { apc_imp_min_atr: 2.5, apc_imp_max_atr: 6, apc_imp_cons: 0.75, apc_pb_min: 0.25, apc_pb_max: 0.5, apc_res_n: 2, apc_rsi_mode: 1, apc_rsi_hi: 70, apc_ext_mode: 1, apc_ext_atr: 5, apc_exh_on: true, apc_age: 8, mam_on: false } },
      { name: L('P2 BALANCED (по умолчанию)', 'P2 BALANCED (Standard)', 'P2 BALANCED (default)'), values: { apc_imp_min_atr: 2, apc_imp_max_atr: 6, apc_imp_cons: 0.6, apc_pb_min: 0.2, apc_pb_max: 0.6, apc_res_n: 2, apc_rsi_mode: 1, apc_rsi_hi: 70, apc_ext_mode: 1, apc_ext_atr: 6, apc_exh_on: true, apc_age: 12, mam_on: false } },
      { name: L('P3 EARLY ENTRY (эксперимент)', 'P3 EARLY ENTRY (Experiment)', 'P3 EARLY ENTRY (experimental)'), values: { apc_imp_min_atr: 1.8, apc_imp_max_atr: 6, apc_imp_cons: 0.6, apc_pb_min: 0.15, apc_pb_max: 0.6, apc_res_n: 1, apc_rsi_mode: 1, apc_rsi_hi: 70, apc_ext_mode: 1, apc_ext_atr: 6, apc_exh_on: false, apc_age: 12, mam_on: false } },
      { name: L('P4 TREND CONTINUATION', 'P4 TREND CONTINUATION', 'P4 TREND CONTINUATION'), values: { apc_imp_min_atr: 2.5, apc_imp_max_atr: 8, apc_imp_cons: 0.7, apc_pb_min: 0.15, apc_pb_max: 0.4, apc_res_n: 2, apc_rsi_mode: 2, apc_rsi_hi: 70, apc_ext_mode: 1, apc_ext_atr: 5, apc_exh_on: true, apc_age: 6, mam_on: false } },
      { name: L('P5 VOLATILITY ADAPTIVE', 'P5 VOLATILITY ADAPTIVE', 'P5 VOLATILITY ADAPTIVE'), values: { apc_imp_min_atr: 2, apc_imp_max_atr: 6, apc_imp_cons: 0.6, apc_pb_min: 0.2, apc_pb_max: 0.6, apc_res_n: 2, apc_rsi_mode: 1, apc_rsi_hi: 70, apc_ext_mode: 1, apc_ext_atr: 6, apc_exh_on: true, apc_age: 12, mam_on: true, mam_block: true, mam_min_act: 0.8, mam_max_stale: 0.2 } },
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
    am_mode: L('Режим: A / B / C / D', 'Modus: A / B / C / D', 'Mode: A / B / C / D'),
    am_live: L('Источник DI/ADX: текущая свеча (LIVE, эксперимент; выкл. = закрытые)', 'Quelle DI/ADX: laufende Kerze (LIVE, Experiment; aus = geschlossene)', 'DI/ADX source: forming candle (LIVE, experimental; off = closed)'),
    am_adx_period: L('ADX/DI: период', 'ADX/DI: Periode', 'ADX/DI: period'),
    am_buy: L('Сигналы CALL', 'CALL-Signale', 'CALL signals'), am_sell: L('Сигналы PUT', 'PUT-Signale', 'PUT signals'),
    am_adx_thr: L('Порог ADX (A: ADX ≥ порога · B: пробой порога)', 'ADX-Schwelle (A: ADX ≥ Schwelle · B: Durchbruch)', 'ADX threshold (A: ADX ≥ it · B: cross of it)'),
    am_hyst: L('B: гистерезис (повтор после ADX ≤ порог − …)', 'B: Hysterese (erneut nach ADX ≤ Schwelle − …)', 'B: hysteresis (re-arm after ADX ≤ threshold − …)'),
    am_cooldown: L('B: пауза между сигналами (свечей)', 'B: Pause zwischen Signalen (Kerzen)', 'B: pause between signals (candles)'),
    am_rearm_bars: L('B: сколько свечей назад искать прошлый сигнал', 'B: wie viele Kerzen zurück nach dem letzten Signal suchen', 'B: how many candles back to look for the last signal'),
    am_cross_mode: L('C: PRE / CROSS / BOTH', 'C: PRE / CROSS / BOTH', 'C: PRE / CROSS / BOTH'),
    am_conv_min: L('C: сближение DI за свечу не меньше (пунктов DI)', 'C: DI-Annäherung pro Kerze mindestens (DI-Punkte)', 'C: DI convergence per candle at least (DI points)'),
    am_use_speed: L('C: условие скорости сближения', 'C: Bedingung Annäherungsgeschwindigkeit', 'C: convergence speed condition'),
    am_speed_min: L('C: скорость сближения не меньше (пунктов DI в минуту)', 'C: Annäherungsgeschwindigkeit mindestens (DI-Punkte/Min.)', 'C: convergence speed at least (DI points/min)'),
    am_use_acc: L('C: условие ускорения сближения', 'C: Bedingung Beschleunigung', 'C: acceleration condition'),
    am_acc_min: L('C: ускорение не меньше', 'C: Beschleunigung mindestens', 'C: acceleration at least'),
    am_dist_max: L('C: макс. расстояние между DI для кандидата', 'C: max. Abstand der DI für den Kandidaten', 'C: max. DI distance for a candidate'),
    am_confirm: L('C: подряд свечей сближения (подтверждения)', 'C: aufeinanderfolgende Annäherungskerzen', 'C: consecutive converging candles'),
    am_ttl: L('C: срок жизни кандидата (свечей)', 'C: Lebensdauer des Kandidaten (Kerzen)', 'C: candidate lifetime (candles)'),
    am_t_dicross: L('D: триггер — пересечение DI', 'D: Auslöser – DI-Kreuzung', 'D: trigger – DI cross'),
    am_t_adxcross: L('D: триггер — пробой порога ADX', 'D: Auslöser – ADX-Schwellen-Durchbruch', 'D: trigger – ADX threshold cross'),
    am_t_pre: L('D: триггер — раннее сближение DI', 'D: Auslöser – frühe DI-Annäherung', 'D: trigger – early DI convergence'),
    am_logic: L('D: ANY (любой триггер) / ALL (все сразу)', 'D: ANY (ein Auslöser) / ALL (alle zugleich)', 'D: ANY (one trigger) / ALL (all at once)'),
    am_use_adx_min: L('Фильтр: ADX не ниже', 'Filter: ADX mindestens', 'Filter: ADX at least'), am_adx_min: L('ADX не ниже (значение)', 'ADX mindestens (Wert)', 'ADX at least (value)'),
    am_use_adx_rise: L('Фильтр: ADX растёт', 'Filter: ADX steigt', 'Filter: ADX rising'), am_adx_rise: L('Рост ADX за свечу не меньше', 'ADX-Anstieg pro Kerze mindestens', 'ADX rise per candle at least'),
    am_use_adx_max: L('Фильтр: ADX не выше (конец тренда)', 'Filter: ADX höchstens (Trendende)', 'Filter: ADX at most (trend end)'), am_adx_max: L('ADX не выше (значение)', 'ADX höchstens (Wert)', 'ADX at most (value)'),
    am_use_di_gap: L('Фильтр: разрыв +DI/−DI', 'Filter: Abstand +DI/−DI', 'Filter: +DI/−DI gap'), am_di_gap: L('Разрыв +DI/−DI не меньше', 'Abstand +DI/−DI mindestens', '+DI/−DI gap at least'),
    am_use_vortex: L('Фильтр: Vortex в ту же сторону', 'Filter: Vortex in dieselbe Richtung', 'Filter: Vortex the same way'), am_vortex_period: L('Vortex: период', 'Vortex: Periode', 'Vortex: period'),
    am_use_price: L('Фильтр: подтверждение ценой (свеча по направлению)', 'Filter: Preisbestätigung (Kerze in Richtung)', 'Filter: price confirmation (candle with the direction)'),
    am_use_imp: L('Фильтр: умеренный импульс цены (мин./макс.)', 'Filter: moderater Preisimpuls (min./max.)', 'Filter: moderate price impulse (min/max)'),
    am_imp_min: L('Импульс за 3 свечи не меньше (ATR)', 'Impuls über 3 Kerzen mindestens (ATR)', 'Impulse over 3 candles at least (ATR)'), am_imp_max: L('Импульс за 3 свечи не больше (ATR)', 'Impuls über 3 Kerzen höchstens (ATR)', 'Impulse over 3 candles at most (ATR)'),
    am_use_exh: L('Фильтр: не входить при истощении (далеко от EMA 20)', 'Filter: kein Einstieg bei Erschöpfung (weit von EMA 20)', 'Filter: no entry on exhaustion (far from EMA 20)'), am_exh_atr: L('Истощение: цена дальше … ATR от EMA 20', 'Erschöpfung: Preis weiter als … ATR von EMA 20', 'Exhaustion: price further than … ATR from EMA 20'),
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
    apc_buy: L('Сигналы CALL', 'CALL-Signale', 'CALL signals'), apc_sell: L('Сигналы PUT', 'PUT-Signale', 'PUT signals'), apc_atr_period: L('ATR: период (нормализация)', 'ATR: Periode (Normierung)', 'ATR: period (normalisation)'),
    apc_imp_min_n: L('Импульс: минимум свечей', 'Impuls: mindestens Kerzen', 'Impulse: at least candles'), apc_imp_max_n: L('Импульс: максимум свечей', 'Impuls: höchstens Kerzen', 'Impulse: at most candles'),
    apc_imp_min_atr: L('Импульс: ход не меньше (ATR до импульса)', 'Impuls: Weg mindestens (ATR vor dem Impuls)', 'Impulse: move at least (ATR before it)'), apc_imp_max_atr: L('Импульс: ход не больше (ATR) — без «скачков»', 'Impuls: Weg höchstens (ATR) – keine „Sprünge“', 'Impulse: move at most (ATR) – no jumps'),
    apc_imp_speed: L('Импульс: скорость не меньше (ATR на свечу)', 'Impuls: Tempo mindestens (ATR pro Kerze)', 'Impulse: speed at least (ATR per candle)'), apc_imp_cons: L('Импульс: доля свечей по направлению не меньше', 'Impuls: Anteil Kerzen in Richtung mindestens', 'Impulse: share of candles with the direction at least'),
    apc_age: L('Возраст импульса: откат начался не позже (свечей)', 'Alter des Impulses: Rücklauf spätestens nach (Kerzen)', 'Impulse age: pullback started within (candles)'),
    apc_pb_min: L('Откат: доля импульса не меньше', 'Rücklauf: Anteil des Impulses mindestens', 'Pullback: share of the impulse at least'), apc_pb_max: L('Откат: доля импульса не больше', 'Rücklauf: Anteil des Impulses höchstens', 'Pullback: share of the impulse at most'),
    apc_pb_bars: L('Откат: не дольше … свечей', 'Rücklauf: höchstens … Kerzen', 'Pullback: at most … candles'), apc_pb_acc: L('Откат: отмена при встречной свече с телом > … ATR', 'Rücklauf: Abbruch bei Gegenkerze mit Körper > … ATR', 'Pullback: cancel on a counter candle with body > … ATR'),
    apc_res_n: L('Возобновление: свечей подряд (1 = рано)', 'Wiederaufnahme: Kerzen in Folge (1 = früh)', 'Resumption: candles in a row (1 = early)'),
    apc_rsi_mode: L('RSI-перегрев: 0 выкл · 1 блок · 2 только предупреждать', 'RSI-Überhitzung: 0 aus · 1 Block · 2 nur warnen', 'RSI overheat: 0 off · 1 block · 2 advisory'), apc_rsi_hi: L('RSI-перегрев: CALL ≥ …, PUT ≤ 100 − …', 'RSI-Überhitzung: CALL ≥ …, PUT ≤ 100 − …', 'RSI overheat: CALL ≥ …, PUT ≤ 100 − …'),
    apc_ext_mode: L('Растяжение цены: 0 выкл · 1 блок · 2 только предупреждать', 'Preisdehnung: 0 aus · 1 Block · 2 nur warnen', 'Price extension: 0 off · 1 block · 2 advisory'), apc_ext_atr: L('Растяжение: путь от начала импульса не больше (ATR)', 'Dehnung: Weg seit Impulsbeginn höchstens (ATR)', 'Extension: path from the impulse start at most (ATR)'),
    apc_exh_on: L('Проверка истощения (крупные свечи, слабое возобновление, замедление)', 'Erschöpfungsprüfung (große Kerzen, schwache Wiederaufnahme, Verlangsamung)', 'Exhaustion check (oversized candles, weak resumption, slowing)'),
    apc_ctx_m5: L('Контекст M5 в ту же сторону', 'Kontext M5 in dieselbe Richtung', 'Context M5 the same way'), apc_ctx_m15: L('Контекст M15 в ту же сторону', 'Kontext M15 in dieselbe Richtung', 'Context M15 the same way'),
  };
  const labelsOf = name => Object.fromEntries(Object.keys(DEFAULTS[name]).filter(k => LB[k]).map(k => [k, LB[k]]));
  const LABELS = { n_adxmicro: labelsOf('n_adxmicro'), n_bor: labelsOf('n_bor'), n_apc: labelsOf('n_apc') };

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
    n_adxmicro: [
      G(g('1 · Режим и источник', '1 · Modus und Quelle', '1 · Mode and source'),
        g('A BASE ADX — пересечение DI при ADX ≥ порога (контроль). B ADX CROSS — ADX пробивает порог. C EARLY DI IMPULSE — раннее сближение DI до пересечения. D CUSTOM — свои триггеры и фильтры. Режим меняется нажатием на пресет A/B/C/D. LIVE — предварительный расчёт по формирующейся свече (может исчезнуть).', 'A BASE ADX – DI-Kreuzung bei ADX ≥ Schwelle (Kontrolle). B ADX CROSS – ADX durchbricht die Schwelle. C EARLY DI IMPULSE – frühe DI-Annäherung vor der Kreuzung. D CUSTOM – eigene Auslöser und Filter. Moduswechsel per Preset A/B/C/D. LIVE – vorläufige Berechnung mit laufender Kerze (kann verschwinden).', 'A BASE ADX – DI cross at ADX ≥ threshold (control). B ADX CROSS – ADX crosses the threshold. C EARLY DI IMPULSE – early DI convergence before the cross. D CUSTOM – own triggers and filters. Change mode by tapping preset A/B/C/D. LIVE – provisional calculation with the forming candle (may vanish).'),
        ['am_mode', 'am_live', 'am_adx_period', 'am_buy', 'am_sell', 'expiry']),
      G(g('2 · A и B: порог ADX', '2 · A und B: ADX-Schwelle', '2 · A and B: ADX threshold'),
        g('Порог 25 — гипотеза для проверки. B срабатывает один раз при пробое порога; повтор — только после того, как ADX опустился до порога минус гистерезис, и не раньше паузы.', 'Schwelle 25 ist eine Testhypothese. B löst einmal beim Durchbruch aus; erneut erst, wenn ADX auf Schwelle minus Hysterese gefallen ist und nach der Pause.', 'Threshold 25 is a hypothesis to test. B fires once when the threshold is crossed; again only after ADX fell to threshold minus hysteresis and after the pause.'),
        ['am_adx_thr', 'am_hyst', 'am_cooldown', 'am_rearm_bars']),
      G(g('3 · C: раннее сближение DI', '3 · C: frühe DI-Annäherung', '3 · C: early DI convergence'),
        g('Меньшая из линий DI быстро сближается с большей (+DI под −DI → CALL, зеркально PUT). PRE — сигнал до пересечения; CROSS — только пересечение; BOTH — раннее, а пересечение не повторяет уже выданный сигнал. Скорость в пунктах DI в минуту; для LIVE берётся реальное время с начала свечи.', 'Die kleinere DI-Linie nähert sich schnell der größeren (+DI unter −DI → CALL, gespiegelt PUT). PRE – Signal vor der Kreuzung; CROSS – nur die Kreuzung; BOTH – früh, und die Kreuzung wiederholt kein schon gegebenes Signal. Tempo in DI-Punkten pro Minute; bei LIVE zählt die echte Zeit seit Kerzenbeginn.', 'The smaller DI line closes in on the bigger one (+DI below −DI → CALL, mirrored PUT). PRE – signal before the cross; CROSS – only the cross; BOTH – early, and the cross does not repeat a signal already given. Speed in DI points per minute; for LIVE the real time since the candle start counts.'),
        ['am_cross_mode', 'am_conv_min', 'am_dist_max', 'am_confirm', 'am_ttl', 'am_use_speed', 'am_speed_min', 'am_use_acc', 'am_acc_min']),
      G(g('4 · D: свои триггеры', '4 · D: eigene Auslöser', '4 · D: own triggers'),
        g('Включите один или несколько триггеров. ANY — достаточно любого; ALL — все сразу и в одну сторону. Без триггера сигнала нет.', 'Einen oder mehrere Auslöser einschalten. ANY – einer genügt; ALL – alle zugleich und in dieselbe Richtung. Ohne Auslöser kein Signal.', 'Switch on one or more triggers. ANY – one is enough; ALL – all at once and the same way. No trigger – no signal.'),
        ['am_t_dicross', 'am_t_adxcross', 'am_t_pre', 'am_logic']),
      G(g('5 · Фильтры (каждый отдельно)', '5 · Filter (jeder einzeln)', '5 · Filters (each separately)'),
        g('Применяются ко всем режимам. По умолчанию выключены. Проверяйте сравнением с выключенными: не каждый фильтр улучшает результат.', 'Gelten für alle Modi. Standardmäßig aus. Durch Vergleich mit „aus“ prüfen: nicht jeder Filter verbessert das Ergebnis.', 'Apply to all modes. Off by default. Check by comparing with off: not every filter improves the result.'),
        ['am_use_adx_min', 'am_adx_min', 'am_use_adx_rise', 'am_adx_rise', 'am_use_adx_max', 'am_adx_max', 'am_use_di_gap', 'am_di_gap', 'am_use_vortex', 'am_vortex_period', 'am_use_price', 'am_use_imp', 'am_imp_min', 'am_imp_max', 'am_use_exh', 'am_exh_atr']),
      RSI_G, MAM_G, AEI_G,
    ],
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
    n_apc: [
      G(g('1 · Основное', '1 · Grundlegendes', '1 · Basics'),
        g('Импульс → контролируемый откат → подтверждённое возобновление. Всё измеряется в ATR, посчитанном до импульса, поэтому настройки одинаково работают на разных парах. Таймфрейм сигнала — M1…M5 (выбор вверху стратегии). Пресеты P1–P5 — стартовые гипотезы; P6 CUSTOM — это ваши настройки без пресета.', 'Impuls → kontrollierter Rücklauf → bestätigte Wiederaufnahme. Alles in ATR vor dem Impuls gemessen, daher gelten die Einstellungen für verschiedene Paare gleich. Signal-Zeitrahmen M1…M5 (Wahl oben in der Strategie). Presets P1–P5 sind Starthypothesen; P6 CUSTOM sind deine Einstellungen ohne Preset.', 'Impulse → controlled pullback → confirmed resumption. Everything is measured in ATR taken before the impulse, so settings work alike on different pairs. Signal timeframe M1…M5 (choose at the top of the strategy). Presets P1–P5 are starting hypotheses; P6 CUSTOM is your settings without a preset.'),
        ['expiry', 'apc_buy', 'apc_sell', 'apc_atr_period']),
      G(g('2 · Импульс', '2 · Impuls', '2 · Impulse'),
        g('Направленное движение: от … до … свечей, ход в ATR не меньше минимума и не больше максимума (скачок — не импульс), скорость и доля свечей по направлению. Возраст — сколько свечей назад закончился импульс.', 'Gerichtete Bewegung: von … bis … Kerzen, Weg in ATR zwischen Minimum und Maximum (ein Sprung ist kein Impuls), Tempo und Anteil der Kerzen in Richtung. Alter – wie viele Kerzen der Impuls zurückliegt.', 'Directional move: from … to … candles, move in ATR between minimum and maximum (a jump is no impulse), speed and share of candles with the direction. Age – how many candles ago the impulse ended.'),
        ['apc_imp_min_n', 'apc_imp_max_n', 'apc_imp_min_atr', 'apc_imp_max_atr', 'apc_imp_speed', 'apc_imp_cons', 'apc_age']),
      G(g('3 · Откат и возобновление', '3 · Rücklauf und Wiederaufnahme', '3 · Pullback and resumption'),
        g('Откат: доля импульса в заданных пределах, не дольше N свечей, не пробивает начало импульса, без сильной встречной свечи. Возобновление: N свечей подряд по направлению, и последняя пробивает локальный экстремум отката. Один импульс — один сигнал.', 'Rücklauf: Anteil des Impulses in Grenzen, höchstens N Kerzen, durchbricht den Impulsbeginn nicht, keine starke Gegenkerze. Wiederaufnahme: N Kerzen in Folge in Richtung, die letzte durchbricht das lokale Extrem des Rücklaufs. Ein Impuls – ein Signal.', 'Pullback: share of the impulse within limits, at most N candles, does not break the impulse start, no strong counter candle. Resumption: N candles in a row with the direction, the last breaks the pullback\'s local extreme. One impulse – one signal.'),
        ['apc_pb_min', 'apc_pb_max', 'apc_pb_bars', 'apc_pb_acc', 'apc_res_n']),
      G(g('4 · Защита от перегрева', '4 · Überhitzungsschutz', '4 · Overheat protection'),
        g('RSI-перегрев (CALL блокируется при RSI ≥ 70, PUT при ≤ 30), растяжение цены от начала импульса в ATR и проверка истощения. Режимы: 0 выкл · 1 блок · 2 только предупреждение в карточке. RSI может долго оставаться экстремальным при сильном движении — это фильтр риска, а не предсказание разворота.', 'RSI-Überhitzung (CALL gesperrt bei RSI ≥ 70, PUT bei ≤ 30), Preisdehnung seit Impulsbeginn in ATR und Erschöpfungsprüfung. Modi: 0 aus · 1 Block · 2 nur Warnung in der Karte. RSI kann bei starker Bewegung lange extrem bleiben – ein Risikofilter, keine Umkehrprognose.', 'RSI overheat (CALL blocked at RSI ≥ 70, PUT at ≤ 30), price extension from the impulse start in ATR and an exhaustion check. Modes: 0 off · 1 block · 2 only a warning in the card. RSI can stay extreme for long in a strong move – a risk filter, not a reversal forecast.'),
        ['apc_rsi_mode', 'apc_rsi_hi', 'apc_ext_mode', 'apc_ext_atr', 'apc_exh_on']),
      G(g('5 · Контекст (старший таймфрейм)', '5 · Kontext (höherer Zeitrahmen)', '5 · Context (higher timeframe)'),
        g('Необязательно: тренд на M5 / M15 (цена по нужную сторону EMA 20 и EMA в ту же сторону) должен совпадать с направлением сигнала. Без контекста стратегия работает как есть.', 'Optional: der Trend auf M5 / M15 (Preis auf der richtigen Seite der EMA 20 und EMA in dieselbe Richtung) muss zur Signalrichtung passen. Ohne Kontext läuft die Strategie wie sie ist.', 'Optional: the trend on M5 / M15 (price on the right side of EMA 20 and the EMA pointing that way) must match the signal direction. Without context the strategy runs as is.'),
        ['apc_ctx_m5', 'apc_ctx_m15']),
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
    n_adxmicro: [
      sec(g('Что делает стратегия?', 'Was macht die Strategie?', 'What does the strategy do?'),
        g('Ищет начало короткого импульса, а не длинный тренд. ADX измеряет силу движения, но не его направление; +DI и −DI показывают, чьё давление сильнее. Направление сигнала — по линиям DI: CALL, если +DI сильнее, PUT, если −DI.', 'Sucht den Beginn eines kurzen Impulses, nicht eines langen Trends. ADX misst die Stärke der Bewegung, nicht ihre Richtung; +DI und −DI zeigen, wessen Druck stärker ist. Die Signalrichtung folgt den DI-Linien: CALL wenn +DI stärker, PUT wenn −DI.', 'Looks for the start of a short impulse, not a long trend. ADX measures the strength of the move, not its direction; +DI and −DI show whose pressure is stronger. The signal direction follows the DI lines: CALL if +DI is stronger, PUT if −DI.'),
        g('Гарантий нет: ADX и пересечения DI запаздывают, поэтому есть режимы, которые пытаются поймать момент раньше. Это гипотезы для проверки.', 'Garantien gibt es nicht: ADX und DI-Kreuzungen hinken hinterher, deshalb gibt es Modi, die den Moment früher zu fangen versuchen. Das sind Testhypothesen.', 'There are no guarantees: ADX and DI crosses lag, so there are modes that try to catch the moment earlier. They are hypotheses to test.')),
      sec(g('Режимы A, B, C, D', 'Modi A, B, C, D', 'Modes A, B, C, D'),
        g('A BASE ADX — контроль: пересечение +DI/−DI при ADX ≥ порога (25), как «Vortex + ADX» с выключенным Vortex. B ADX CROSS — ADX пробивает порог снизу вверх между двумя соседними свечами; повтор только после падения ADX на гистерезис. C EARLY DI IMPULSE (экспериментальный) — линии DI быстро сближаются ещё до пересечения; ADX ≥ 25 не обязателен. D CUSTOM — свои триггеры (пересечение DI, пробой ADX, раннее сближение) и фильтры, логика ANY или ALL.', 'A BASE ADX – Kontrolle: Kreuzung +DI/−DI bei ADX ≥ Schwelle (25), wie „Vortex + ADX“ mit abgeschaltetem Vortex. B ADX CROSS – ADX durchbricht die Schwelle von unten zwischen zwei benachbarten Kerzen; erneut nur nach einem Fall des ADX um die Hysterese. C EARLY DI IMPULSE (experimentell) – DI-Linien nähern sich schnell schon vor der Kreuzung; ADX ≥ 25 nicht nötig. D CUSTOM – eigene Auslöser (DI-Kreuzung, ADX-Durchbruch, frühe Annäherung) und Filter, Logik ANY oder ALL.', 'A BASE ADX – control: +DI/−DI cross at ADX ≥ threshold (25), like "Vortex + ADX" with Vortex off. B ADX CROSS – ADX crosses the threshold upward between two neighbouring candles; again only after ADX fell by the hysteresis. C EARLY DI IMPULSE (experimental) – the DI lines close in fast even before the cross; ADX ≥ 25 not required. D CUSTOM – own triggers (DI cross, ADX cross, early convergence) and filters, logic ANY or ALL.'),
        g('Режим выбирается нажатием на пресет A / B / C / D. Параметры хранятся одним набором для стратегии (не отдельно по режимам): пресет возвращает значения нужного режима. Статистика пресетов ведётся отдельно, если включено несколько.', 'Der Modus wird per Tipp auf das Preset A / B / C / D gewählt. Die Parameter liegen als ein Satz je Strategie (nicht getrennt nach Modus): das Preset stellt die Werte des Modus wieder her. Die Statistik der Presets läuft getrennt, wenn mehrere an sind.', 'The mode is chosen by tapping preset A / B / C / D. Parameters are kept as one set per strategy (not separately per mode): the preset restores the values of that mode. Preset statistics are kept apart when several are on.')),
      sec(g('DI: закрытые свечи или текущая свеча?', 'DI: geschlossene oder laufende Kerze?', 'DI: closed candles or the forming candle?'),
        g('CLOSED (по умолчанию): DI и ADX считаются только по закрытым свечам; пока свеча идёт, значения не меняются, сигнал приходит после закрытия. LIVE (эксперимент): к закрытым свечам добавляется формирующаяся, DI/ADX пересчитываются заново каждый раз, но не накапливаются; сигнал ПРЕДВАРИТЕЛЬНЫЙ и может исчезнуть до закрытия свечи — выданный сигнал задним числом не меняется.', 'CLOSED (Standard): DI und ADX nur aus geschlossenen Kerzen; solange die Kerze läuft, ändern sich die Werte nicht, das Signal kommt nach dem Schluss. LIVE (Experiment): zu den geschlossenen Kerzen kommt die laufende, DI/ADX werden jedes Mal neu berechnet, aber nicht akkumuliert; das Signal ist VORLÄUFIG und kann vor dem Kerzenschluss verschwinden – ein gegebenes Signal wird nicht nachträglich geändert.', 'CLOSED (default): DI and ADX from closed candles only; while the candle runs the values do not change, the signal comes after the close. LIVE (experiment): the forming candle is added to the closed ones, DI/ADX are recomputed from scratch each time but never accumulated; the signal is PROVISIONAL and may vanish before the candle closes – an issued signal is not changed afterwards.'),
        g('Опрос каждые 5 секунд сам DI закрытых свечей не обновляет. Сравнение «снимков» одной свечи с точностью до секунд не реализовано: скорость сближения считается между предыдущей закрытой свечой и текущим значением с поправкой на прошедшее время. Режим LIVE на истории не проверялся.', 'Die Abfrage alle 5 Sekunden aktualisiert die DI geschlossener Kerzen nicht von selbst. Ein sekundengenauer Vergleich von „Schnappschüssen“ derselben Kerze ist nicht umgesetzt: die Annäherungsgeschwindigkeit wird zwischen der letzten geschlossenen Kerze und dem aktuellen Wert mit der vergangenen Zeit gerechnet. LIVE wurde auf der Historie nicht geprüft.', 'The 5-second polling does not update the DI of closed candles by itself. A second-accurate comparison of "snapshots" of one candle is not implemented: the convergence speed is taken between the last closed candle and the current value, corrected for the elapsed time. LIVE was not tested on history.')),
      sec(g('+DI / −DI: сближение и пересечение', '+DI / −DI: Annäherung und Kreuzung', '+DI / −DI: convergence and cross'),
        g('Расстояние = |+DI − −DI|. Сближение = на сколько расстояние сократилось за свечу. Раннее CALL-кандидат: +DI ниже −DI и догоняет; PUT — наоборот. Подряд нужно N свечей сближения, кандидат живёт ограниченное число свечей (TTL). Режимы PRE (до пересечения), CROSS (только пересечение), BOTH (раннее, пересечение не повторяет уже выданный сигнал).', 'Abstand = |+DI − −DI|. Annäherung = um wie viel der Abstand pro Kerze schrumpfte. Früher CALL-Kandidat: +DI unter −DI und holt auf; PUT umgekehrt. Es braucht N Annäherungskerzen in Folge, der Kandidat lebt begrenzt viele Kerzen (TTL). Modi PRE (vor der Kreuzung), CROSS (nur die Kreuzung), BOTH (früh, die Kreuzung wiederholt kein schon gegebenes Signal).', 'Distance = |+DI − −DI|. Convergence = by how much the distance shrank per candle. Early CALL candidate: +DI below −DI and catching up; PUT the other way. N converging candles in a row are needed, the candidate lives a limited number of candles (TTL). Modes PRE (before the cross), CROSS (only the cross), BOTH (early, the cross does not repeat a signal already given).'),
        g('Пример: +DI 18, −DI 26 (расстояние 8), на следующей свече +DI 21, −DI 25 (расстояние 4, сближение 4). Сближение не обязано закончиться пересечением — часть кандидатов гаснет.', 'Beispiel: +DI 18, −DI 26 (Abstand 8), nächste Kerze +DI 21, −DI 25 (Abstand 4, Annäherung 4). Die Annäherung muss nicht in einer Kreuzung enden – ein Teil der Kandidaten erlischt.', 'Example: +DI 18, −DI 26 (distance 8), next candle +DI 21, −DI 25 (distance 4, convergence 4). The convergence need not end in a cross – part of the candidates fade.')),
      sec(g('ADX, порог и гистерезис', 'ADX, Schwelle und Hysterese', 'ADX, threshold and hysteresis'),
        g('ADX показывает силу, а не направление. Порог 25 — исследуемая гипотеза, для микроимпульса он может быть поздним. Гистерезис: после сигнала ADX должен опуститься до «порог − гистерезис» (пример 25 и 2 → 23), прежде чем сигнал возможен снова; плюс пауза в свечах. Пока ADX просто остаётся выше порога, новых сигналов нет.', 'ADX zeigt die Stärke, nicht die Richtung. Die Schwelle 25 ist eine Testhypothese, für einen Mikroimpuls kann sie spät sein. Hysterese: nach einem Signal muss ADX auf „Schwelle − Hysterese“ fallen (Beispiel 25 und 2 → 23), bevor ein Signal wieder möglich ist; dazu eine Pause in Kerzen. Solange ADX nur über der Schwelle bleibt, gibt es keine neuen Signale.', 'ADX shows strength, not direction. The threshold 25 is a hypothesis under test, for a micro-impulse it may be late. Hysteresis: after a signal ADX must fall to "threshold − hysteresis" (example 25 and 2 → 23) before a signal is possible again; plus a pause in candles. While ADX just stays above the threshold there are no new signals.')),
      sec(g('RSI вместо «RCI»', 'RSI statt „RCI“', 'RSI instead of "RCI"'),
        g('В ТЗ написано «RCI». В приложении такого индикатора нет, есть RSI (по умолчанию период 14) — он и используется. Если нужен именно Rank Correlation Index, это другой индикатор, и его надо добавлять отдельно.', 'In der Vorgabe steht „RCI“. In der App gibt es diesen Indikator nicht, nur RSI (Standard Periode 14) – er wird benutzt. Wenn der Rank Correlation Index gemeint ist, ist das ein anderer Indikator und müsste separat ergänzt werden.', 'The spec says "RCI". The app has no such indicator, only RSI (default period 14) – that is what is used. If the Rank Correlation Index is meant, it is a different indicator and would have to be added separately.'),
        g('Режимы: OFF; RANGE — CALL только при RSI в диапазоне (50–70), PUT зеркально (30–50); OVERHEAT ONLY — не ждать 50: CALL блокируется лишь при RSI ≥ 70, PUT при ≤ 30. По умолчанию OFF во всех режимах. Ожидание 50 может запаздывать для короткого импульса — это гипотеза, не доказательство.', 'Modi: OFF; RANGE – CALL nur bei RSI im Bereich (50–70), PUT gespiegelt (30–50); OVERHEAT ONLY – nicht auf 50 warten: CALL wird nur bei RSI ≥ 70 gesperrt, PUT bei ≤ 30. Standard in allen Modi OFF. Das Warten auf 50 kann bei einem kurzen Impuls zu spät sein – eine Hypothese, kein Beweis.', 'Modes: OFF; RANGE – CALL only with RSI inside the range (50–70), PUT mirrored (30–50); OVERHEAT ONLY – do not wait for 50: CALL is blocked only at RSI ≥ 70, PUT at ≤ 30. OFF by default in all modes. Waiting for 50 can be late for a short impulse – a hypothesis, not a proof.')),
      sec(g('Почему сигнал пришёл или не пришёл?', 'Warum kam das Signal oder nicht?', 'Why did a signal come or not?'),
        g('Нет сигнала, если: нет триггера выбранного режима; повтор до гистерезиса/паузы; кандидат C старше TTL; не выполнен включённый фильтр (ADX мин./рост/макс., разрыв DI, Vortex, подтверждение ценой, умеренный импульс, истощение, RSI); MAM заблокировал; закрытая свеча ещё не закончилась (CLOSED). В карточке сигнала видно режим, ADX, +DI, −DI, источник CLOSED/LIVE и пометку ПРЕДВАРИТЕЛЬНО.', 'Kein Signal, wenn: kein Auslöser des Modus; Wiederholung vor Hysterese/Pause; C-Kandidat älter als TTL; ein eingeschalteter Filter nicht erfüllt (ADX min./Anstieg/max., DI-Abstand, Vortex, Preisbestätigung, moderater Impuls, Erschöpfung, RSI); MAM hat blockiert; die geschlossene Kerze ist noch nicht zu Ende (CLOSED). In der Signalkarte stehen Modus, ADX, +DI, −DI, Quelle CLOSED/LIVE und der Vermerk VORLÄUFIG.', 'No signal if: no trigger of the mode; a repeat before hysteresis/pause; a C candidate older than TTL; an enabled filter not met (ADX min/rise/max, DI gap, Vortex, price confirmation, moderate impulse, exhaustion, RSI); MAM blocked; the closed candle has not ended yet (CLOSED). The signal card shows the mode, ADX, +DI, −DI, source CLOSED/LIVE and the PROVISIONAL mark.')),
      ...COMMON_HELP,
    ],
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
    n_apc: [
      sec(g('Как работает APC?', 'Wie funktioniert APC?', 'How does APC work?'),
        g('Продолжение движения после контролируемого отката: ИМПУЛЬС → ОТКАТ → ВОЗОБНОВЛЕНИЕ. Сначала находится направленный импульс, затем неглубокая и недолгая коррекция, затем свечи снова идут по направлению и пробивают локальный экстремум отката. Один импульс — один сигнал.', 'Fortsetzung der Bewegung nach einem kontrollierten Rücklauf: IMPULS → RÜCKLAUF → WIEDERAUFNAHME. Zuerst wird ein gerichteter Impuls gefunden, dann eine flache, kurze Korrektur, dann laufen die Kerzen wieder in Richtung und durchbrechen das lokale Extrem des Rücklaufs. Ein Impuls – ein Signal.', 'Continuation of the move after a controlled pullback: IMPULSE → PULLBACK → RESUMPTION. First a directional impulse is found, then a shallow and short correction, then the candles go with the direction again and break the pullback\'s local extreme. One impulse – one signal.'),
        g('Приоритет — качество сигналов, а не их количество. Сигналов будет мало.', 'Priorität ist die Qualität der Signale, nicht ihre Zahl. Es wird wenige Signale geben.', 'The priority is signal quality, not their number. There will be few signals.')),
      sec(g('Что считается импульсом, откатом, возобновлением', 'Was gilt als Impuls, Rücklauf, Wiederaufnahme', 'What counts as impulse, pullback, resumption'),
        g('Импульс: от 3 до 8 свечей, ход от 2 до 6 ATR (ATR берётся ДО импульса, чтобы скачок не завышал собственную мерку), не меньше 0,4 ATR на свечу, не меньше 60 % свечей по направлению. Откат: 20–60 % импульса, не дольше 6 свечей, не пробивает начало импульса, без сильной встречной свечи. Возобновление: 2 свечи подряд по направлению, последняя закрывается за локальным экстремумом отката.', 'Impuls: 3 bis 8 Kerzen, Weg von 2 bis 6 ATR (ATR wird VOR dem Impuls genommen, damit ein Sprung nicht den eigenen Maßstab aufbläht), mindestens 0,4 ATR pro Kerze, mindestens 60 % der Kerzen in Richtung. Rücklauf: 20–60 % des Impulses, höchstens 6 Kerzen, durchbricht den Impulsbeginn nicht, keine starke Gegenkerze. Wiederaufnahme: 2 Kerzen in Folge in Richtung, die letzte schließt hinter dem lokalen Extrem des Rücklaufs.', 'Impulse: 3 to 8 candles, move 2 to 6 ATR (ATR is taken BEFORE the impulse so that a jump does not inflate its own yardstick), at least 0.4 ATR per candle, at least 60 % of the candles with the direction. Pullback: 20–60 % of the impulse, at most 6 candles, does not break the impulse start, no strong counter candle. Resumption: 2 candles in a row with the direction, the last closes beyond the pullback\'s local extreme.'),
        g('Откат или разворот? Если откат глубже максимума, пробил начало импульса или появилась сильная встречная свеча — это уже не откат, сценарий отменён. Пример: импульс 4 свечи = 4,8 ATR, откат 2 свечи = 23 % → допустим.', 'Rücklauf oder Umkehr? Ist der Rücklauf tiefer als das Maximum, durchbricht er den Impulsbeginn oder erscheint eine starke Gegenkerze, ist es kein Rücklauf mehr, das Szenario ist abgebrochen. Beispiel: Impuls 4 Kerzen = 4,8 ATR, Rücklauf 2 Kerzen = 23 % → zulässig.', 'Pullback or reversal? If the pullback is deeper than the maximum, broke the impulse start or a strong counter candle appeared, it is no longer a pullback and the scenario is cancelled. Example: impulse 4 candles = 4.8 ATR, pullback 2 candles = 23 % → allowed.')),
      sec(g('RSI 70/30, растяжение цены, истощение', 'RSI 70/30, Preisdehnung, Erschöpfung', 'RSI 70/30, price extension, exhaustion'),
        g('RSI-перегрев: CALL блокируется при RSI ≥ 70, PUT при ≤ 30 (альтернативы 65/35, 75/25, 80/20 — меняйте значение). Учитывается направление: не оба направления одинаково. RSI может долго оставаться экстремальным при сильном движении — это фильтр риска, не предсказание разворота.', 'RSI-Überhitzung: CALL gesperrt bei RSI ≥ 70, PUT bei ≤ 30 (Alternativen 65/35, 75/25, 80/20 – Wert ändern). Die Richtung wird beachtet: nicht beide Richtungen gleich. RSI kann bei starker Bewegung lange extrem bleiben – ein Risikofilter, keine Umkehrprognose.', 'RSI overheat: CALL blocked at RSI ≥ 70, PUT at ≤ 30 (alternatives 65/35, 75/25, 80/20 – change the value). The direction is respected: not both directions alike. RSI can stay extreme for long in a strong move – a risk filter, not a reversal forecast.'),
        g('Растяжение: путь цены от начала импульса в ATR не больше заданного. Истощение: две и более свечи шире 2,5 ATR в импульсе, слабая свеча возобновления (тело < 40 % среднего тела импульса) или замедление (последние свечи импульса вдвое слабее первых). Каждый фильтр: 0 выкл · 1 блок · 2 только предупреждение в карточке.', 'Dehnung: der Weg des Preises seit Impulsbeginn in ATR höchstens der eingestellte. Erschöpfung: zwei oder mehr Kerzen breiter als 2,5 ATR im Impuls, schwache Wiederaufnahmekerze (Körper < 40 % des mittleren Impulskörpers) oder Verlangsamung (letzte Impulskerzen halb so stark wie die ersten). Jeder Filter: 0 aus · 1 Block · 2 nur Warnung in der Karte.', 'Extension: the price path from the impulse start in ATR at most the set value. Exhaustion: two or more candles wider than 2.5 ATR in the impulse, a weak resumption candle (body < 40 % of the impulse\'s mean body) or slowing (the last impulse candles half as strong as the first). Each filter: 0 off · 1 block · 2 only a warning in the card.')),
      sec(g('Пресеты P1–P6 и CUSTOM', 'Presets P1–P6 und CUSTOM', 'Presets P1–P6 and CUSTOM'),
        g('P1 CONSERVATIVE — строже импульс и откат, фильтры включены, меньше сделок. P2 BALANCED — умеренные значения. P3 EARLY ENTRY — возобновление по одной свече, без проверки истощения, ЭКСПЕРИМЕНТАЛЬНО, больше ложных сигналов. P4 TREND CONTINUATION — более устойчивое движение, неглубокий откат, строгий предел растяжения. P5 VOLATILITY ADAPTIVE — как P2, плюс MAM: блокирует при вялом рынке и плохих котировках. P6 CUSTOM — ваши настройки без пресета.', 'P1 CONSERVATIVE – strengerer Impuls und Rücklauf, Filter an, weniger Trades. P2 BALANCED – moderate Werte. P3 EARLY ENTRY – Wiederaufnahme mit einer Kerze, ohne Erschöpfungsprüfung, EXPERIMENTELL, mehr Fehlsignale. P4 TREND CONTINUATION – stabilere Bewegung, flacher Rücklauf, strenge Dehnungsgrenze. P5 VOLATILITY ADAPTIVE – wie P2, plus MAM: blockiert bei trägem Markt und schlechten Kursen. P6 CUSTOM – deine Einstellungen ohne Preset.', 'P1 CONSERVATIVE – stricter impulse and pullback, filters on, fewer trades. P2 BALANCED – moderate values. P3 EARLY ENTRY – resumption with one candle, no exhaustion check, EXPERIMENTAL, more false signals. P4 TREND CONTINUATION – steadier move, shallow pullback, strict extension limit. P5 VOLATILITY ADAPTIVE – like P2 plus MAM: blocks on a sluggish market and poor quotes. P6 CUSTOM – your settings without a preset.'),
        g('Все значения — стартовые гипотезы «для тестирования», не оптимум. Можно включить несколько пресетов сразу (сигнал, если сработал любой).', 'Alle Werte sind Starthypothesen „zum Testen“, kein Optimum. Mehrere Presets können gleichzeitig an sein (Signal, wenn eines greift).', 'All values are starting hypotheses "for testing", not an optimum. Several presets can be on at once (a signal when any fires).')),
      sec(g('Таймфрейм, контекст и экспирация — три разные вещи', 'Zeitrahmen, Kontext und Ablauf – drei verschiedene Dinge', 'Timeframe, context and expiry – three different things'),
        g('Таймфрейм сигнала (M1…M5, выбирается вверху стратегии) — свеча, на которой найден паттерн. Контекст (M5 / M15, по желанию) — старший таймфрейм, тренд которого должен совпадать с направлением. Экспирация — срок опциона. Жёсткого правила «таймфрейм = экспирация» нет: M1 с экспирацией 120 с и M2 с экспирацией 120 с — разные варианты, и какой лучше, решает только проверка (см. таблицу результатов).', 'Der Signal-Zeitrahmen (M1…M5, oben in der Strategie gewählt) ist die Kerze, auf der das Muster gefunden wird. Der Kontext (M5 / M15, optional) ist der höhere Zeitrahmen, dessen Trend zur Richtung passen muss. Der Ablauf ist die Laufzeit der Option. Eine feste Regel „Zeitrahmen = Ablauf“ gibt es nicht: M1 mit 120 s und M2 mit 120 s sind verschiedene Varianten, welche besser ist, entscheidet nur die Prüfung (siehe Ergebnistabelle).', 'The signal timeframe (M1…M5, chosen at the top of the strategy) is the candle on which the pattern is found. The context (M5 / M15, optional) is the higher timeframe whose trend must match the direction. The expiry is the option\'s term. There is no hard rule "timeframe = expiry": M1 with 120 s and M2 with 120 s are different variants, and which is better is decided only by testing (see the results table).'),
        g('Интерактивный подбор «экспирация → таймфрейм» и обратно не сделан: без независимой статистики он выдавал бы выдуманные рекомендации. Вместо него — таблица измеренных результатов. Сигналы одного импульса на разных таймфреймах не склеиваются (у каждого таймфрейма свой сигнал), значит при включении нескольких таймфреймов возможны два сигнала по одному движению.', 'Eine interaktive Auswahl „Ablauf → Zeitrahmen“ und umgekehrt gibt es nicht: ohne unabhängige Statistik würde sie erfundene Empfehlungen liefern. Stattdessen gibt es die Tabelle der gemessenen Ergebnisse. Signale desselben Impulses auf verschiedenen Zeitrahmen werden nicht verschmolzen (jeder Zeitrahmen hat sein Signal), bei mehreren Zeitrahmen sind also zwei Signale zu einer Bewegung möglich.', 'An interactive choice "expiry → timeframe" and back is not built: without independent statistics it would give made-up recommendations. A table of measured results replaces it. Signals of one impulse on different timeframes are not merged (each timeframe has its own signal), so with several timeframes on, two signals for one move are possible.')),
      sec(g('Как читать карточку и почему нет сигнала', 'Karte lesen und warum kein Signal', 'Reading the card and why no signal'),
        g('В карточке: импульс (свечей, ход в ATR), откат (доля и длительность), пробитый уровень, RSI, растяжение, контекст, предупреждения («⚠ RSI перегрев» в режиме «только предупреждать»), MAM, экспирация. «Оценка» — эвристика (глубина отката, чистота импульса, спокойный RSI, контекст), НЕ вероятность выигрыша.', 'In der Karte: Impuls (Kerzen, Weg in ATR), Rücklauf (Anteil und Dauer), durchbrochenes Level, RSI, Dehnung, Kontext, Warnungen („⚠ RSI überhitzt“ im Modus „nur warnen“), MAM, Ablauf. Die „Bewertung“ ist eine Heuristik (Rücklauftiefe, saubere Impulse, ruhiger RSI, Kontext), KEINE Gewinnwahrscheinlichkeit.', 'In the card: impulse (candles, move in ATR), pullback (share and duration), broken level, RSI, extension, context, warnings ("⚠ RSI overheated" in advisory mode), MAM, expiry. The "score" is a heuristic (pullback depth, clean impulse, calm RSI, context), NOT a win probability.'),
        g('Нет сигнала, если: нет импульса нужной силы или он слишком резкий; откат слишком глубокий/долгий/пробил начало; встречная свеча; возобновление слабое или не пробило локальный экстремум; сработал RSI, растяжение, истощение, контекст или MAM.', 'Kein Signal, wenn: kein Impuls ausreichender Stärke oder zu heftig; Rücklauf zu tief/lang/durchbricht den Beginn; Gegenkerze; Wiederaufnahme schwach oder ohne Durchbruch des lokalen Extrems; RSI, Dehnung, Erschöpfung, Kontext oder MAM hat gegriffen.', 'No signal if: no impulse of enough strength or too violent; the pullback too deep/long/broke the start; a counter candle; the resumption weak or did not break the local extreme; RSI, extension, exhaustion, context or MAM kicked in.')),
      ...COMMON_HELP,
    ],
  };
  // result tables of the walk-forward backtest (generated by tools/gen-pro-tests.js)
  const TESTS = require('./pro_tests_data');
  return { META, DEFAULTS, S, PRESETS, GROUPS, TESTS, HELP, LABELS, liveMode, OWN, mamCheck, rsiCheck, swingZones, helpers: { RSI_F, MAM, AEI, L, J } };
};
