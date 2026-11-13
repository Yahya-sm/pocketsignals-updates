// Strategy Lab UI (13.11.2026): account/mode switch, risk tiles + limit banner, filters, win-rate block on signal cards,
// "Waiting for confirmation" and "No signal" blocks, side column (legend, last trades, today), Catalog, Backtest,
// Journal (import of broker history, day review, paper trades, parameter log) and Risk tabs.
// Uses the globals of app.js (state, t, tr, esc, call, fmtExp, $, renderLive, toast).
(function () {
  const loc = () => (LANG === 'en' ? 'en' : LANG);
  const pct = v => (Math.round(v * 1000) / 10).toLocaleString(loc(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  function wilson(w, n) {
    if (!n) return null; const z = 1.96, p = w / n, d = 1 + z * z / n;
    const c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
    return { rate: p, lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
  }
  const be = payout => 1 / (1 + (payout || 80) / 100);
  function verdict(b, payout) {
    const ci = b && b.n ? wilson(b.w, b.n) : null, B = be(payout);
    const v = !ci || b.n < 100 ? 'few' : ci.hi < B ? 'below' : ci.lo > B ? 'above' : 'unproven';
    return { v, ci, be: B };
  }
  const scoreTxt = s => t(s >= 85 ? 'sc_strong' : s >= 70 ? 'sc_work' : s >= 50 ? 'sc_weak' : 'sc_rej');
  const lab = () => (state && state.lab) || null;
  const cat = id => ((lab() && lab().catalog) || []).find(c => c.id === id);
  const fmtDT = ms => new Date(ms).toLocaleString(loc(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const setHtml = (el, html) => { if (el && el.dataset.h !== html) { el.innerHTML = html; el.dataset.h = html; } };
  const isActive = id => { const s = document.getElementById(id); return s && s.classList.contains('active'); };
  const editing = id => { const s = document.getElementById(id); return s && s.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName); };

  // ---------- filters ----------
  let F = { type: 'all', exp: 'all', noRisk: false };
  try { F = { ...F, ...JSON.parse(localStorage.getItem('labF') || '{}') }; } catch {}
  const saveF = () => { try { localStorage.setItem('labF', JSON.stringify(F)); } catch {} };
  window.labFilter = s => {
    if (F.type === 'otc' && !s.otc) return false;
    if (F.type === 'forex' && s.otc) return false;
    if (F.exp !== 'all' && String(s.expiry) !== F.exp) return false;
    if (F.noRisk && s.lab && cat(s.lab.id) && ['HIGH', 'VERY_HIGH', 'CRITICAL'].includes(cat(s.lab.id).risk_level)) return false;
    return true;
  };
  function renderFilters() {
    const el = document.getElementById('labFilters'); if (!el) return;
    const chip = (k, v, label) => `<button class="chip${F[k] === v ? ' active' : ''}" data-lf="${k}" data-lv="${v}">${label}</button>`;
    setHtml(el, `${chip('type', 'all', t('all'))}${chip('type', 'otc', 'OTC')}${chip('type', 'forex', 'Forex')}
      <select class="chipsel" data-lfsel="exp"><option value="all">${t('f_expiry')}</option>${[60, 120, 180, 300].map(s => `<option value="${s}"${F.exp === String(s) ? ' selected' : ''}>${fmtExp(s)}</option>`).join('')}</select>
      <button class="chip${F.noRisk ? ' active' : ''}" data-lf="noRisk" data-lv="toggle">${t('f_norisk')}</button>`);
  }

  // ---------- win-rate block ----------
  function wrBlock(id, payout) {
    const st = (lab().stats || {})[id] || {}, sg = st.signals || { w: 0, n: 0 }, vd = verdict(sg, payout);
    const mineB = lab().account === 'REAL' ? st.mine_real : st.mine_demo;
    const extra = [mineB && mineB.n ? `${t('wr_mine')}: ${pct(mineB.w / mineB.n)} % · n = ${mineB.n}` : '', st.paper && st.paper.n ? `${t('wr_paper')}: ${pct(st.paper.w / st.paper.n)} % · n = ${st.paper.n}` : ''].filter(Boolean);
    return `<div class="wrbox v-${vd.v}"><div class="wrhead"><span>${t('wr_title')}</span><b>${t('v_' + vd.v)}</b></div>
      <div class="wrmain"><span class="num">${vd.ci ? pct(vd.ci.rate) + ' %' : '–'}</span><span class="num n">n = ${sg.n}</span></div>
      ${vd.ci ? `<small>${t('wr_ci', { lo: pct(vd.ci.lo), hi: pct(vd.ci.hi), be: pct(vd.be) })}</small>` : `<small>${t('rk_be', { v: pct(vd.be) + ' %' })}</small>`}
      ${extra.map(x => `<small>${esc(x)}</small>`).join('')}</div>`;
  }

  // ---------- signal card extra ----------
  window.labCard = function (s) {
    if (!s.lab || !lab()) return '';
    const c = cat(s.lab.id) || {};
    const paper = lab().mode === 'PAPER';
    const stages = (s.lab.stages || []).map((x, i) => `<span class="stg ${x}">${t('stage', { n: i + 1 })}: ${t('st_' + x)}</span>`).join('');
    const tw = c.target_win_rate, B = be(s.payout);
    const target = tw ? `<small class="tgt">${t('target', { a: tw.min, b: tw.max })}${tw.min / 100 < B ? ' · ' + t('target_warn') : ''}</small>` : `<small class="tgt">${t('target_tbd')}</small>`;
    const trade = s.trade ? `<span class="mybadge">✓ ${t('my_trade')}${s.trade.delay != null ? ' · ' + t('entry_delay', { s: s.trade.delay }) : ''}${s.trade.ambiguous ? ' · ' + t('ambiguous') : ''}</span>` : '';
    const pap = s.paper ? `<span class="mybadge">${t('paper_done', { p: s.paper.price })}${s.paper.result ? ' · ' + s.paper.result : ''}</span>`
      : paper && !s.result ? `<button class="btn ghost paperbtn" data-paper="${esc(s.id)}">${t('paper_btn')}</button>` : '';
    const open = window.__labWhy.has(s.id), now = Date.now() / 1000;
    const win = s.expiresAt ? `<span class="entrywin num${s.expiresAt - now <= 15 ? ' soon' : ''}" data-entrywin="${s.expiresAt}">${winText(s.expiresAt)}</span>` : '';
    const real = lab().account === 'REAL' && c.status !== 'LIVE_READY' ? `<small class="tgt warnc">${t('real_unverified')}</small>` : '';
    return `<div class="labcard"><div class="labline"><span class="tag">${esc(s.lab.type)}</span><span>${t('score', { s: s.lab.score })} · ${scoreTxt(s.lab.score)}</span>${win}</div>
      ${wrBlock(s.strategy, s.payout)}${target}${real}${trade}${pap}
      <button class="linkbtn" data-labwhy="${esc(s.id)}">${t('why_btn')} ${open ? '▴' : '▾'}</button>
      ${open ? `<div class="labwhy"><div>${esc(tr(s.reason))}</div><div class="stgs">${stages}</div><small>${esc((s.lab.reasons || []).join(', '))}</small>
        <small class="feats">${esc(Object.entries(s.lab.feats || {}).map(([k, v]) => k + '=' + v).join(' · '))}</small></div>` : ''}</div>`;
  };
  function winText(exp) { const l = Math.round(exp - Date.now() / 1000); return l > 0 ? `${t('win_left')} 00:${String(l).padStart(2, '0')}` : t('win_over'); }
  setInterval(() => document.querySelectorAll('[data-entrywin]').forEach(el => { const e = +el.dataset.entrywin; el.textContent = winText(e); el.classList.toggle('soon', e - Date.now() / 1000 <= 15); }), 1000);

  // ---------- top: account + mode, risk tiles, banner ----------
  function renderTop() {
    const el = document.getElementById('labTop'); if (!el || !lab()) return;
    const L = lab(), lim = L.limits || { cur: {}, lim: {} }, real = L.account === 'REAL';
    document.body.classList.toggle('acct-real', real);
    const md = document.getElementById('mode'); if (md) { md.textContent = real ? t('acct_real') : t('acct_demo'); md.className = 'mode' + (real ? ' real' : ''); }
    const bar = (cur, max) => { const r = max ? Math.min(1, cur / max) : 0; return `<i class="rkbar ${r >= 0.8 ? 'red' : r >= 0.5 ? 'yel' : ''}"><i style="width:${Math.round(r * 100)}%"></i></i>`; };
    const lat = L.latency, latOk = lat != null && lat < (L.stale_sec || 5) * 1000 + 60000;
    const pays = (state.signals || []).filter(s => !s.result && s.payout).map(s => s.payout);
    const html = `${real ? `<div class="realbadge">${t('real_badge')}</div>` : ''}
      <div class="toprow"><div class="seg acct"><button data-acct="DEMO" class="${!real ? 'on' : ''}">${t('acct_demo')}</button><button data-acct="REAL" class="${real ? 'on real' : ''}">${t('acct_real')}</button></div>
      <div class="seg"><button data-tmode="SIGNAL_ONLY" class="${L.mode !== 'PAPER' ? 'on' : ''}">${t('mode_manual')}</button><button data-tmode="PAPER" class="${L.mode === 'PAPER' ? 'on' : ''}">${t('mode_paper')}</button></div></div>
      ${lim.hit ? `<div class="limitbanner">${t('limit_hit')} (${t('lim_' + lim.hit)})</div>` : ''}
      <div class="rktiles">
        <div class="rk"><span>${t('rk_loss')}</span><b class="num">${(lim.cur.loss || 0).toFixed(1)} / ${lim.lim.loss} ${t('rk_units')}</b>${bar(lim.cur.loss || 0, lim.lim.loss)}</div>
        <div class="rk"><span>${t('rk_trades')}</span><b class="num">${lim.cur.trades || 0} / ${lim.lim.trades}</b>${bar(lim.cur.trades || 0, lim.lim.trades)}</div>
        <div class="rk opt"><span>${t('rk_streak')}</span><b class="num">${lim.cur.streak || 0} / ${lim.lim.streak}</b>${bar(lim.cur.streak || 0, lim.lim.streak)}</div>
        <div class="rk"><span>${t('rk_lat')}</span><b class="num ${lat == null ? '' : latOk ? 'ok' : 'bad'}">${lat == null ? '–' : (lat / 1000).toFixed(1) + ' s'}</b></div>
        <div class="rk opt"><span>${t('rk_pay')}</span><b class="num">${pays.length ? Math.min(...pays) + '–' + Math.max(...pays) + ' %' : '–'}</b><small>${pays.length ? t('rk_be', { v: pct(be(Math.max(...pays))) + '–' + pct(be(Math.min(...pays))) + ' %' }) + ' · ' : ''}min ${L.risk.risk_min_payout} %</small></div>
      </div>`;
    setHtml(el, html);
    document.body.classList.toggle('limit-hit', !!lim.hit);
  }

  // ---------- waiting for confirmation / no signal ----------
  function renderWaitNoSig() {
    const L = lab(), on = new Set(state.settings.strategies || []), dec = L.decisions || {}, now = Date.now();
    const built = L.catalog.filter(c => c.impl && on.has(c.id));
    const wait = built.filter(c => { const d = dec[c.id]; return d && d.status === 'NO_TRADE' && d.stage >= 2 && now - d.at < 120000; });
    const wEl = document.getElementById('labWait');
    if (wEl) setHtml(wEl, wait.length ? `<h3 class="blk">${t('wait_title')} <span class="cnt yel">${wait.length}</span></h3>${wait.map(c => {
      const d = dec[c.id], st = (L.stats[c.id] || {}).signals || { w: 0, n: 0 }, vd = verdict(st, 80);
      return `<div class="waitrow"><div><b>${esc(c.name)}</b><small>${esc(String(d.asset || '').replace(/_otc$/i, ' OTC'))} · ${esc(c.asset_type)} · ${esc(c.expiry[0])}</small>
        <div class="stbar">${[1, 2, 3].map(n => `<i class="${n < d.stage ? 'on' : ''}"></i>`).join('')}<small>${t('stage_of', { n: d.stage })}</small></div>
        <small>${t('wait_for')}: ${esc(tr(d.text) || d.code || '')}</small></div><span class="num v-${vd.v}">${vd.ci ? pct(vd.ci.rate) + ' %' : '–'} <small>n = ${st.n}</small></span></div>`;
    }).join('')}` : '');
    const el = document.getElementById('labNoSig'); if (!el) return;
    const rows = built.filter(c => !wait.includes(c)).map(c => {
      const d = dec[c.id]; if (!d) return `<div class="nsrow"><b>${esc(c.name)}</b><small>${t('nosig_none')}</small></div>`;
      const txt = d.status === 'BLOCKED_BY_RISK' ? t('rb_' + d.code) : tr(d.text) || d.code || '';
      return `<div class="nsrow s-${d.status}"><b>${esc(c.name)}</b><small>${d.status} · ${t('status_' + d.status)}${txt ? ' · ' + esc(txt) : ''}${d.asset ? ' · ' + esc(String(d.asset).replace(/_otc$/i, ' OTC')) : ''}</small></div>`;
    });
    const wasOpen = !!el.querySelector('details[open]');
    const html = `<details class="setfold nosig"${wasOpen ? ' open' : ''}><summary><h3>${t('nosig_title')} <span class="cnt">${rows.length}</span></h3><small>${t('nosig_hint')}</small></summary>${rows.join('')}</details>`;
    setHtml(el, html);
  }

  // ---------- side column ----------
  function renderSide() {
    const el = document.getElementById('labSide'); if (!el) return;
    const done = state.signals.filter(s => s.mine || s.paper).slice(0, 5);
    const res = s => (s.trade && s.trade.result) || (s.paper && s.paper.result) || s.result || '…';
    const last = done.map(s => `<div class="lastrow"><span><b>${esc(tr(s.strategyName))}</b> · ${esc(s.name)}</span><span class="res ${res(s)}">${res(s)}</span>
      <small>${s.dir === 'CALL' ? '▲' : '▼'} ${s.dir} · ${fmtExp(s.expiry)} · ${s.paper && !s.trade ? 'Paper' : t('mode_manual')} · ${fmtDT(s.created)}</small></div>`).join('') || `<small>${t('none_yet')}</small>`;
    const day = new Date(); day.setHours(0, 0, 0, 0);
    const today = state.signals.filter(s => s.mine && s.trade && s.trade.at * 1000 >= day.getTime());
    const w = today.filter(s => s.trade.result === 'WIN').length, l = today.filter(s => s.trade.result === 'LOSS').length;
    const units = today.reduce((a, s) => a + (s.trade.result === 'WIN' ? (s.payout || 80) / 100 : s.trade.result === 'LOSS' ? -1 : 0), 0);
    setHtml(el, `<div class="sidebox"><b>${t('legend_title')}</b><div class="lg"><i class="v-above"></i>${t('v_above')}</div><div class="lg"><i class="v-unproven"></i>${t('v_unproven')}</div><div class="lg"><i class="v-below"></i>${t('v_below')}</div><div class="lg"><i class="v-few"></i>${t('v_few')}</div><p class="hint">${t('legend')}</p></div>
      <div class="sidebox"><b>${t('last_trades')}</b>${last}<button class="linkbtn" data-tab="history">${t('tab_journal')} →</button></div>
      <div class="sidebox"><b>${t('today_mine')}</b><p class="num">${today.length} · W ${w} / L ${l} · ${units >= 0 ? '+' : ''}${units.toFixed(2)} ${t('rk_units')}</p><p class="hint">${t('today_hint', { n: today.length })}</p></div>`);
  }

  // ---------- catalog ----------
  const openCat = new Set();
  // Star = favourite: the strategy then shows in Settings → Strategies (user 13.11.2026).
  const favBtn = id => { const on = (state.settings.favorites || []).includes(id); return `<button class="favstar${on ? ' on' : ''}" data-favstrat="${id}" title="${t(on ? 'fav_remove' : 'fav_add')}">${on ? '★' : '☆'}</button>`; };
  function renderCatalog() {
    const el = document.getElementById('catalogBox'); if (!el || !lab() || !isActive('catalog') || editing('catalog')) return;
    const L = lab(), on = new Set(state.settings.strategies || []);
    const legacy = (state.settings.allStrategies || []).filter(s => !L.catalog.some(c => c.id === s.key));
    const item = c => {
      const st = (L.stats || {})[c.id] || {}, sg = st.signals || { w: 0, n: 0 }, vd = verdict(sg, 80), open = openCat.has(c.id);
      const risk = ['HIGH', 'VERY_HIGH', 'CRITICAL'].includes(c.risk_level) && c.manual_hard ? ` <span class="hirisk">${t('hi_risk')}</span>` : '';
      return `<div class="catitem${c.impl ? '' : ' draft'}"><div class="cathead" data-cat="${c.id}">
          ${c.impl ? favBtn(c.id) : ''}<div class="catname"><b>${esc(c.name)}</b>${risk}<small>${esc(c.id)} · ${esc(c.asset_type)} · ${esc(c.expiry.join(' / '))}</small></div>
          <div class="catright"><span class="tag">${c.impl ? t('cat_impl') : t('cat_draft')}</span><span class="num v-${vd.v}">${vd.ci ? pct(vd.ci.rate) + ' %' : '–'} <small>n=${sg.n}</small></span></div></div>
        ${open ? `<div class="catbody">
          ${c.impl ? `<label class="row"><span>${t('cat_on')}</span><input type="checkbox" class="sw" data-caton="${c.id}" ${on.has(c.id) ? 'checked' : ''}></label>` : ''}
          ${c.manual_hard ? `<p class="hint warn">${t('manual_hard')}</p>` : ''}
          <p class="hint">${t('cat_status')}: ${c.status} · ${t('cat_mode')}: ${c.mode} · ${t('cat_risk')}: ${c.risk_level} · v${c.version}</p>
          <p class="hint">${c.target_win_rate ? t('target', { a: c.target_win_rate.min, b: c.target_win_rate.max }) + (c.target_win_rate.min < 55.6 ? ' · ' + t('target_warn') : '') : t('target_tbd')}</p>
          ${c.impl ? wrBlock(c.id, 80) : ''}
          ${c.impl ? `<h4>${t('bt_title')}</h4>${c.backtest ? ['is', 'oos'].map(k => { const b = c.backtest[k], v = verdict(b, 80); return `<p class="hint">${k === 'is' ? 'In-sample' : 'Out-of-sample'}: <span class="num v-${v.v}">${pct(b.w / b.n)} %</span> n = ${b.n}${v.ci ? ' · ' + t('wr_ci', { lo: pct(v.ci.lo), hi: pct(v.ci.hi), be: pct(v.be) }) : ''} · ${t('v_' + v.v)}</p>`; }).join('') + `<p class="hint">${esc(c.backtest.date)} · ${esc(c.backtest.data)}</p>` : `<p class="hint">${t('bt_none')}</p>`}` : ''}
          <h4>${t('cat_stages')}</h4><ol>${c.stages.map(x => `<li>${esc(tr(x))}</li>`).join('')}</ol>
          ${c.params ? `<h4>${t('cat_params')}</h4><div class="params">${Object.entries(c.params).map(([k, v]) => `<label class="row"><span>${esc(tr(((state.settings.allStrategies.find(a => a.key === c.id) || {}).labels || {})[k]) || k)}</span><input type="number" step="any" data-labp="${c.id}" data-k="${esc(k)}" value="${esc(v)}"></label>`).join('')}</div>` : ''}
          <p class="hint">${t('cat_note_wr')}</p></div>` : ''}</div>`;
    };
    const legacyHtml = legacy.map(s => `<div class="catitem"><div class="cathead">${favBtn(s.key)}<div class="catname"><b>${esc(tr(s.names))}</b><small>${esc(s.key)}</small></div>
      <div class="catright"><input type="checkbox" class="sw" data-caton="${s.key}" ${on.has(s.key) ? 'checked' : ''}></div></div></div>`).join('');
    setHtml(el, `<p class="hint">${t('cat_note_wr')}</p>${legacyHtml}${L.catalog.map(item).join('')}`);
  }

  // ---------- backtest tab ----------
  let btResult = null, btBusy = false;
  function renderBacktest() {
    const el = document.getElementById('btBox'); if (!el || !lab() || !isActive('backtest') || editing('backtest')) return;
    const built = lab().catalog.filter(c => c.impl), sel = el.querySelector('#btStrat') ? el.querySelector('#btStrat').value : built[0].id;
    const r = btResult;
    const part = (name, b) => { if (!b || !b.n) return `<p class="hint">${name}: n = 0</p>`; const v = verdict(b, r.payout); return `<div class="wrbox v-${v.v}"><div class="wrhead"><span>${name}</span><b>${t('v_' + v.v)}</b></div><div class="wrmain"><span class="num">${pct(b.w / b.n)} %</span><span class="num n">n = ${b.n}</span></div>${v.ci ? `<small>${t('wr_ci', { lo: pct(v.ci.lo), hi: pct(v.ci.hi), be: pct(v.be) })}</small>` : ''}<small>EV ${(b.w / b.n * r.payout / 100 - (1 - b.w / b.n)).toFixed(3)} ${t('per_stake')}</small></div>`; };
    setHtml(el, `<p class="hint">${t('bt_hint')}</p>
      <label class="row"><span>${t('lab_strat')}</span><select id="btStrat">${built.map(c => `<option value="${c.id}"${c.id === sel ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
      <label class="row"><span>${t('bt_days')}</span><input type="number" id="btDays" value="14" min="1" max="60"></label>
      <label class="row"><span>${t('bt_payout')}</span><input type="number" id="btPayout" value="80" min="50" max="100"></label>
      <label class="row"><span>${t('cat_expiry')} (s)</span><input type="number" id="btExp" placeholder="auto" min="60" step="60"></label>
      <button class="btn wide" id="btRun"${btBusy ? ' disabled' : ''}>${btBusy ? '…' : t('bt_run')}</button>
      ${r ? (r.ok ? `<h4>${esc(cat(r.id).name)} · ${t('bt_data', { p: r.pairs, c: r.candles })}</h4>${part('In-sample', r.is)}${part('Out-of-sample', r.oos)}
        <div class="btnrow"><button class="btn ghost" data-btexp="csv">CSV</button><button class="btn ghost" data-btexp="json">JSON</button></div>` : `<p class="hint warn">${esc(r.error || 'error')}</p>`) : ''}`);
  }

  // ---------- journal tab additions ----------
  let importMsg = '';
  function renderJournal() {
    const el = document.getElementById('labJournal'); if (!el || !lab() || !isActive('history') || editing('history')) return;
    const day = new Date(); day.setHours(0, 0, 0, 0);
    const todays = state.signals.filter(s => !s.manual && s.lab && (s.created || 0) >= day.getTime()).slice(0, 60);
    const amb = state.signals.filter(s => s.trade && s.trade.ambiguous && (s.created || 0) >= day.getTime());
    const outside = state.signals.filter(s => s.manual && s.mine).slice(0, 20);
    const paper = state.signals.filter(s => s.paper).slice(0, 30);
    const plog = (lab().paramLog || []).slice(0, 40).map(p => `<div class="plog"><span>${fmtDT(p.at)} · ${esc(p.who)}</span><b>${esc(p.scope)} · ${esc(p.key)}</b><span class="mono">${esc(JSON.stringify(p.old))} → ${esc(JSON.stringify(p.new))}</span></div>`).join('') || `<small>${t('plog_empty')}</small>`;
    const row = s => `<div class="revrow"><span>${fmtDT(s.created)} · <b>${esc(s.name)}</b> ${s.dir === 'CALL' ? '▲' : '▼'} ${s.dir} · ${esc(tr(s.strategyName))} · ${fmtExp(s.expiry)}${s.trade && s.trade.ambiguous ? ' · ' + t('ambiguous') : ''}</span>
      <button class="mini mine${s.mine ? ' on' : ''}" data-mine="${esc(s.id)}">${s.mine ? '✓' : '＋'}</button></div>`;
    setHtml(el, `<details class="setfold"><summary><h3>${t('import_title')}</h3></summary>
        <p class="hint">${t('import_hint')}</p><input type="file" id="histFile" accept=".csv,.txt,.html,.htm,.xls,text/csv,text/html" hidden>
        <button class="btn wide" id="histPick">${t('import_btn')}</button>${importMsg ? `<p class="hint">${esc(importMsg)}</p>` : ''}</details>
      <details class="setfold"><summary><h3>${t('review_title')} <span class="cnt">${todays.length}</span></h3></summary><p class="hint">${t('review_hint')}</p>
        ${amb.length ? `<h4>${t('ambiguous')}</h4>${amb.map(row).join('')}` : ''}${todays.map(row).join('') || `<small>${t('none_yet')}</small>`}
        ${outside.length ? `<h4>${t('outside_title')}</h4>${outside.map(s => `<div class="revrow"><span>${fmtDT(s.created)} · <b>${esc(s.name)}</b> ${s.dir} · ${s.result || '…'}</span></div>`).join('')}` : ''}</details>
      <details class="setfold"><summary><h3>${t('paper_title')} <span class="cnt">${paper.length}</span></h3></summary>${paper.map(s => `<div class="revrow"><span>${fmtDT(s.created)} · <b>${esc(s.name)}</b> ${s.dir} · ${esc(tr(s.strategyName))}</span><span class="res ${s.paper.result || ''}">${s.paper.result || '…'}</span></div>`).join('') || `<small>${t('none_yet')}</small>`}</details>
      <details class="setfold"><summary><h3>${t('plog_title')}</h3></summary>${plog}</details>`);
  }

  // ---------- risk tab ----------
  function renderRisk() {
    const el = document.getElementById('riskBox'); if (!el || !lab() || !isActive('risk') || editing('risk')) return;
    const R = lab().risk, inp = (k, label, v) => `<label class="row"><span>${t(label)}</span><input type="number" step="any" data-risk="${k}" value="${esc(v ?? R[k])}"></label>`;
    const ns = new Set(lab().notify_strats || []), names = (state.settings.allStrategies || []).filter(s => (state.settings.strategies || []).includes(s.key));
    setHtml(el, `<p class="hint">${t('risk_acct', { a: lab().account === 'REAL' ? t('acct_real') : t('acct_demo') })}</p>
      ${inp('risk_daily_loss_units', 'risk_loss')}${inp('risk_max_trades', 'risk_trades')}${inp('risk_max_losses', 'risk_streak')}${inp('risk_min_payout', 'risk_payout')}${inp('risk_stake_pct', 'risk_stake')}${inp('cooldown_candles', 'risk_cool')}${inp('daily_signal_limit', 'risk_daily')}${inp('stale_sec', 'risk_stale', lab().stale_sec)}
      <p class="hint">${t('risk_note')}</p>
      <h4>${t('notify_title')}</h4><p class="hint">${t('notify_hint')}</p>
      ${names.map(s => `<label class="row"><span>${esc(tr(s.names))}</span><input type="checkbox" class="sw" data-notify="${s.key}" ${!ns.size || ns.has(s.key) ? 'checked' : ''}></label>`).join('')}`);
  }

  window.labRender = function () { try { if (!lab()) return; renderTop(); renderFilters(); renderWaitNoSig(); renderSide(); renderCatalog(); renderBacktest(); renderJournal(); renderRisk(); } catch (e) { console.error(e); } };

  // ---------- broker history file → rows ----------
  function parseHistory(text) {
    let table = [];
    if (/<table/i.test(text)) {
      const doc = new DOMParser().parseFromString(text, 'text/html');
      table = [...doc.querySelectorAll('tr')].map(tr => [...tr.querySelectorAll('th,td')].map(td => td.textContent.trim()));
    } else {
      const sep = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : text.includes('\t') ? '\t' : ',';
      table = text.split(/\r?\n/).filter(Boolean).map(l => l.split(sep).map(x => x.replace(/^"|"$/g, '').trim()));
    }
    if (table.length < 2) return [];
    const head = table[0].map(h => h.toLowerCase());
    const col = re => head.findIndex(h => re.test(h));
    const ci = { time: col(/time|date|время|дата|open|откр|zeit/), asset: col(/asset|symbol|pair|актив|пара|instrument/), dir: col(/dir|type|direction|направ|call|тип|richtung/), amount: col(/amount|sum|сумма|ставк|betrag|invest/), exp: col(/expir|duration|экспир|длит|dauer|ablauf/), res: col(/result|результ|status|ergebnis/), profit: col(/profit|прибыл|доход|payout|gewinn/), demo: col(/demo|account|счёт|счет|konto/) };
    const parseT = v => { if (!v) return 0; if (/^\d{10}$/.test(v)) return +v; if (/^\d{13}$/.test(v)) return Math.floor(+v / 1000); const m = v.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?/); if (m) return Math.floor(new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)).getTime() / 1000); const d = Date.parse(v); return isNaN(d) ? 0 : Math.floor(d / 1000); };
    const parseE = v => { if (!v) return 60; const m = String(v).match(/(\d+):(\d{2})(?::(\d{2}))?/); if (m) return m[3] ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2]; const n = parseFloat(v); return /m|мин/i.test(v) ? n * 60 : n || 60; };
    return table.slice(1).map(r => ({ time: parseT(r[ci.time]), asset: r[ci.asset], dir: r[ci.dir], amount: parseFloat(String(r[ci.amount] || '').replace(',', '.')) || 0, expiry: parseE(r[ci.exp]), result: r[ci.res] || '', profit: parseFloat(String(r[ci.profit] || '').replace(',', '.')) || 0, demo: ci.demo >= 0 ? /demo|демо/i.test(r[ci.demo]) : undefined })).filter(r => r.time && r.asset);
  }

  // ---------- events ----------
  window.__labWhy = new Set();
  document.addEventListener('click', e => {
    const fb = e.target.closest('[data-favstrat]'); if (!fb || !state) return;
    e.stopPropagation();
    const id = fb.dataset.favstrat, list = new Set(state.settings.favorites || []);
    const add = !list.has(id); add ? list.add(id) : list.delete(id);
    state.settings.favorites = [...list]; call({ action: 'settings', patch: { favorite_strategies: [...list] } });
    toast(t(add ? 'fav_added' : 'fav_removed'));
    const cb = document.getElementById('catalogBox'); if (cb) cb.dataset.h = ''; renderCatalog(); renderStrategies(state.settings);
  }, true);
  document.addEventListener('click', async e => {
    const el = e.target.closest('[data-acct],[data-tmode],[data-paper],[data-labwhy],[data-cat],[data-lf],#btRun,[data-btexp],#histPick'); if (!el || !state || !state.lab) return;
    if (el.dataset.acct) {
      if (el.dataset.acct === state.lab.account) return;
      if (el.dataset.acct === 'REAL' && !confirm(t('real_confirm'))) return;
      state.lab.account = el.dataset.acct; call({ action: 'settings', patch: { account: el.dataset.acct } }); window.labRender();
    } else if (el.dataset.tmode) { state.lab.mode = el.dataset.tmode; call({ action: 'settings', patch: { trade_mode: el.dataset.tmode } }); window.labRender(); $('#live').dataset.key = ''; renderLive(); }
    else if (el.dataset.paper) { call({ action: 'paper', id: el.dataset.paper }); el.disabled = true; }
    else if (el.dataset.labwhy) { const k = el.dataset.labwhy; window.__labWhy.has(k) ? window.__labWhy.delete(k) : window.__labWhy.add(k); $('#live').dataset.key = ''; renderLive(); }
    else if (el.dataset.cat) { const k = el.dataset.cat; openCat.has(k) ? openCat.delete(k) : openCat.add(k); renderCatalog(); }
    else if (el.dataset.lf) { if (el.dataset.lf === 'noRisk') F.noRisk = !F.noRisk; else F[el.dataset.lf] = el.dataset.lv; saveF(); renderFilters(); $('#live').dataset.key = ''; renderLive(); }
    else if (el.id === 'btRun') {
      btBusy = true; renderBacktest();
      const r = await call({ action: 'lab_backtest', id: $('#btStrat').value, opt: { days: +$('#btDays').value, payout: +$('#btPayout').value, expiry: +$('#btExp').value || undefined } });
      btBusy = false; btResult = r && r.ok !== undefined ? r : { ok: false, error: t('bt_fail') }; document.getElementById('btBox').dataset.h = ''; renderBacktest();
    } else if (el.dataset.btexp && btResult && btResult.ok) {
      const r = btResult, rows = [['strategy', 'part', 'n', 'wins', 'win_rate', 'ci_lo', 'ci_hi', 'break_even', 'payout'], ...['is', 'oos'].map(k => { const b = r[k], v = verdict(b, r.payout); return [r.id, k, b.n, b.w, b.n ? (b.w / b.n).toFixed(4) : '', v.ci ? v.ci.lo.toFixed(4) : '', v.ci ? v.ci.hi.toFixed(4) : '', v.be.toFixed(4), r.payout]; })];
      const txt = el.dataset.btexp === 'csv' ? rows.map(x => x.join(',')).join('\n') : JSON.stringify(r, null, 1);
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([txt], { type: el.dataset.btexp === 'csv' ? 'text/csv' : 'application/json' })); a.download = `backtest-${r.id}.${el.dataset.btexp}`; a.click();
    } else if (el.id === 'histPick') $('#histFile').click();
  });
  document.addEventListener('change', async e => {
    const el = e.target; if (!state || !state.lab) return;
    if (el.dataset.caton) {
      const list = new Set(state.settings.strategies || []); el.checked ? list.add(el.dataset.caton) : list.delete(el.dataset.caton);
      state.settings.strategies = [...list]; call({ action: 'settings', patch: { strategies: [...list] } });
    } else if (el.dataset.risk) { const v = Number(el.value); if (isFinite(v)) call({ action: 'settings', patch: { [el.dataset.risk]: v } }); }
    else if (el.dataset.labp) { const v = Number(el.value); if (isFinite(v)) call({ action: 'strategy', name: el.dataset.labp, patch: { [el.dataset.k]: v } }); }
    else if (el.dataset.lfsel) { F[el.dataset.lfsel] = el.value; saveF(); $('#live').dataset.key = ''; renderLive(); }
    else if (el.dataset.notify) {
      const all = (state.settings.strategies || []).slice(), cur = new Set(state.lab.notify_strats && state.lab.notify_strats.length ? state.lab.notify_strats : all);
      el.checked ? cur.add(el.dataset.notify) : cur.delete(el.dataset.notify);
      const list = all.every(k => cur.has(k)) ? [] : [...cur]; state.lab.notify_strats = list; call({ action: 'settings', patch: { notify_strats: list } });
    } else if (el.id === 'histFile' && el.files[0]) {
      const text = await el.files[0].text(), rows = parseHistory(text);
      if (!rows.length) { importMsg = t('import_none'); }
      else { const r = await call({ action: 'import_history', rows, account: state.lab.account }); importMsg = r && r.ok ? t('import_done', { n: rows.length, m: r.matched, o: r.outside, a: r.ambiguous, s: r.skipped }) : t('import_none'); }
      el.value = ''; document.getElementById('labJournal').dataset.h = ''; renderJournal();
    }
  });
  setInterval(() => { try { renderCatalog(); renderBacktest(); renderJournal(); renderRisk(); } catch {} }, 3000);
  // The first state can arrive before this file is loaded (phone: the engine answers at once).
  if (typeof state !== 'undefined' && state) { window.labRender(); const lv = document.getElementById('live'); if (lv) { lv.dataset.key = ''; renderLive(); } }
  document.addEventListener('click', e => { if (e.target.closest('[data-tab]')) setTimeout(() => window.labRender(), 0); });
})();
