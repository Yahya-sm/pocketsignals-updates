// UI for the desktop overlay, the phone browser and the Android app.
// Transport: the Android app runs the engine inside the page (window.LocalEngine);
// desktop and phone browser talk to the PC server over WebSocket.
const isDesktop = !!window.desktop;
const isAndroid = !!window.AndroidApp;
const $ = s => document.querySelector(s);
let state = null, ws, reqId = 0, dirFilter = 'all', histView = 'mine', stratFilter = 'all', stratQuery = '';
const replies = {};
// Script errors are shown in the status line, so problems on a phone are visible without a debugger.
let jsError = (window.__bootErrors || [])[0] || null; // e.g. the signal engine failed to start
window.addEventListener('error', e => {
  jsError = e.message || String(e.error);
  const el = document.getElementById('statusline'); if (el) el.textContent = '⚠ ' + jsError;
  // Full error with place and call stack into the connection log (can be copied there), each one once.
  const where = `${(e.filename || '').split('/').pop() || '?'}:${e.lineno || 0}:${e.colno || 0}`;
  const stack = e.error && e.error.stack ? ' | ' + String(e.error.stack).split('\n').slice(1, 4).map(l => l.trim()).join(' | ') : '';
  const line = `${new Date().toTimeString().slice(0, 8)} ${jsError} @ ${where}${stack}`;
  const list = (window.__bootErrors = window.__bootErrors || []);
  if (!list.some(x => x.slice(9) === line.slice(9)) && list.length < 10) list.push(line);
});

function onMessage(m) {
  if (m.type === 'state') { if (m.state.catSame && state && state.settings && m.state.settings) m.state.settings.allStrategies = state.settings.allStrategies; state = m.state; render(); } // catalogue kept when not resent (22.11.2026)
  if (m.type === 'signal') onSignal(m.signal);
  if (m.type === 'reply' && replies[m.reqId]) { replies[m.reqId](m); delete replies[m.reqId]; }
}
function connect() {
  if (window.LocalEngine) { window.LocalEngine.subscribe(onMessage); return; }
  if (isAndroid) { // the engine is built into the app; without it nothing can work, so say why
    $('#statusline').textContent = '⚠ ' + (jsError || t('engine_failed'));
    $('#connLog').textContent = (window.__bootErrors || []).map(e => '⚠ ' + e).join('\n') || t('engine_failed');
    return;
  }
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onmessage = e => onMessage(JSON.parse(e.data));
  ws.onclose = () => { $('#dot').className = 'dot'; $('#statusline').textContent = t('no_connection'); setTimeout(connect, 2000); };
}
function call(msg) {
  if (window.LocalEngine) return Promise.resolve(window.LocalEngine.act(msg));
  return new Promise(res => {
    const id = ++reqId; replies[id] = res;
    ws.send(JSON.stringify({ ...msg, reqId: id, desktop: isDesktop }));
    setTimeout(() => { if (replies[id]) { delete replies[id]; res({ ok: false }); } }, 5000);
  });
}

// Short, clearly visible confirmation on the button itself (e.g. "✓ Gespeichert"), then back to its label.
function flash(btn, text, ok = true) {
  clearTimeout(btn._flash);
  btn.dataset.label ??= btn.textContent;
  btn.textContent = text;
  btn.classList.toggle('flash-ok', ok); btn.classList.toggle('flash-err', !ok);
  btn._flash = setTimeout(() => { btn.textContent = btn.dataset.label; btn.classList.remove('flash-ok', 'flash-err'); delete btn.dataset.label; }, 2500);
}
function toast(text) { const el = $('#toast'); el.textContent = text; el.classList.add('show'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 2600); }
const fmtTime = s => new Date(s * 1000).toLocaleTimeString(LANG, { hour: '2-digit', minute: '2-digit' });
const fmtExp = s => s >= 60 ? (s % 60 ? (s / 60).toFixed(1) : s / 60) + ' ' + t('min') : s + ' ' + t('sec');
const statusText = st => (I18N.de['st_' + st] ? t('st_' + st) : st);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Pair icon: currency pairs as both codes stacked (AUD over USD), other assets as a short name (GOLD, AAPL).
function assetIcon(name) {
  const n = String(name).replace(/\s*OTC$/i, '').trim();
  const pair = n.match(/^([A-Z]{3})\s*\/\s*([A-Z]{3})$/i);
  if (pair) return `<span class="ico2"><b>${esc(pair[1].toUpperCase())}</b><b>${esc(pair[2].toUpperCase())}</b></span>`;
  const word = n.split(/[\s/-]+/)[0].replace(/[^A-Za-z0-9#]/g, '').replace(/^#/, '').toUpperCase();
  const w = word.slice(0, 6);
  return w.length > 4 ? `<span class="ico-sm">${esc(w)}</span>` : esc(w);
}
const rateColor = r => r >= 60 ? 'var(--call)' : r >= 50 ? 'var(--warn)' : 'var(--put)';

// Android: "signals with the screen off" switch – green = keep scanning in the background, red = stop with the screen.
const hasBg = !!(window.AndroidApp && window.AndroidApp.setBackground);
function renderBg() {
  const b = $('#bgBtn'); if (!b || !hasBg) return;
  const on = window.AndroidApp.getBackground();
  b.hidden = false; b.className = 'bgbtn ' + (on ? 'on' : 'off');
  b.textContent = on ? t('bg_on') : t('bg_off'); b.title = t('bg_hint');
}
// "Why (last hour)" and the strategy lab (11.11.2026, user's 1.0.199 list).
function renderWhy() {
  const box = document.getElementById('whyBox'); if (!box || !state) return;
  const why = state.why || {}, names = Object.fromEntries((state.settings.allStrategies || []).map(x => [x.key, tr(x.names)]));
  const on = state.settings.strategies || [];
  const rows = on.filter(k => names[k]).map(k => { const w = why[k] || {}, f = w.found || 0, dl = w.delivered || 0;
    const rej = ['filters', 'chaos', 'mkt', 'small', 'regime'].filter(r => w[r]).map(r => t('why_' + r) + ' ' + w[r]);
    const engineDrop = Math.max(0, (w.passed || 0) - dl);
    if (engineDrop) rej.push(t('why_engine') + ' ' + engineDrop);
    return `<div class="whyrow"><b>${esc(names[k] || k)}</b><span>${t('why_line', { n: f, p: dl })}</span>${rej.length ? `<small>${t('why_dropped')}: ${esc(rej.join(' · '))}</small>` : ''}</div>`; });
  box.innerHTML = rows.join('') || `<small>${t('why_none')}</small>`;
}
function renderLab() {
  const box = document.getElementById('labBox'); if (!box || !state) return;
  const names = Object.fromEntries((state.settings.allStrategies || []).map(x => [x.key, tr(x.names)]));
  const agg = {};
  for (const s of state.signals || []) {
    if (s.manual || (s.result !== 'win' && s.result !== 'loss')) continue;
    const k = s.strategy + '|' + s.expiry, g = (agg[k] = agg[k] || { st: s.strategy, exp: s.expiry, w: 0, n: 0, mw: 0, mn: 0 });
    g.n++; if (s.result === 'win') g.w++; if (s.mine) { g.mn++; if (s.result === 'win') g.mw++; }
  }
  const list = Object.values(agg).sort((x, y) => y.n - x.n);
  if (!list.length) { box.innerHTML = `<small>${t('lab_empty')}</small>`; return; }
  const pc = (w, n) => (n ? Math.round(100 * w / n) + ' %' : '–');
  box.innerHTML = `<table class="lab"><tr><th>${t('lab_strat')}</th><th>${t('lab_exp')}</th><th>${t('lab_all')}</th><th>${t('lab_mine')}</th></tr>${list.map(g => `<tr><td>${esc(names[g.st] || g.st)}</td><td>${fmtExp(g.exp)}</td><td class="${g.w / g.n >= 0.55 ? 'good' : g.w / g.n < 0.5 ? 'bad' : ''}">${pc(g.w, g.n)} <small>(${g.n})</small></td><td>${pc(g.mw, g.mn)} <small>(${g.mn})</small></td></tr>`).join('')}</table><small>${t('lab_hint')}</small>`;
}
function render() {
  try { renderWhy(); renderLab(); } catch {}
  if (!state) return;
  renderBg();
  $('#dot').className = 'dot' + (state.connected ? ' ok' : '');
  $('#mode').textContent = state.demo ? 'DEMO' : 'REAL';
  $('#mode').className = 'mode' + (state.demo ? '' : ' real');
  $('#statusline').textContent = jsError ? '⚠ ' + jsError
    : !state.connected && state.lastError ? `${statusText(state.status)} · ${state.lastError}`
    : `${statusText(state.status)} · ${t('pairs', { n: state.watching })}`;
  document.querySelectorAll('[data-lang]').forEach(b => b.classList.toggle('active', b.dataset.lang === LANG));
  $('#sLang').value = LANG;

  // Main screen: only the user's own trades (user, 04.11.2026); the overall statistics are in History → "All signals".
  const open = state.signals.filter(s => !s.result).length;
  $('#stats').innerHTML = statTiles(mineList(), true);

  applyCards(); syncCards();
  try { renderWatch(); } catch {}
  try { renderSel(); } catch {}
  renderRadar();
  renderLive();
  if (window.labRender) window.labRender();
  $('#liveCount').textContent = open || '';
  // No (working) PocketOption session yet: ask to log in; the app takes the session over automatically.
  $('#loginBox').hidden = !['no_ssid', 'expired'].includes(state.status) || (!isDesktop && !isAndroid);

  $('#allStats').hidden = histView !== 'all';
  const sigs = state.signals.filter(s => !s.manual); // own trades without a signal are not signal statistics
  if (histView === 'all') $('#allStats').innerHTML = `<div class="stats">${statTiles(sigs)}</div>${strategyStats(sigs)}`;
  $('#hist').hidden = histView !== 'list'; $('#stratStats').hidden = histView !== 'stats'; $('#myStats').hidden = histView !== 'mine'; $('#archStats').hidden = histView !== 'archive';
  $('#hist').innerHTML = state.signals.map(row).join('') || `<p class="empty">${t('no_history')}</p>`;
  $('#stratStats').innerHTML = zoneStats(sigs) + strategyStats(sigs);
  if (histView === 'mine') $('#myStats').innerHTML = myStats();
  $('#clearBtn').textContent = t(histView === 'mine' ? 'clear_mine' : 'clear_history'); $('#clearBtn').hidden = histView === 'archive';
  if (histView === 'archive' && $('#archStats').dataset.done !== LANG) { $('#archStats').innerHTML = archiveStats(); $('#archStats').dataset.done = LANG; }

  const s = state.settings;
  if (!$('#settings').contains(document.activeElement) || document.activeElement.tagName === 'BUTTON') {
    $('#sOn').checked = s.signals_on; $('#sSound').checked = s.sound; $('#sAuto').checked = s.auto_po; $('#sQuick').checked = !!s.quick_trade; $('#sQuickReal').checked = !!s.quick_real; $('#sRegimeMode').value = s.regime_mode || 'off'; document.querySelectorAll('[data-rg]').forEach(i => { i.value = s[i.dataset.rg]; }); $('#sChaos').checked = s.chaos_skip; $('#sPoClick').checked = s.po_click_toggle; $('#sMini').checked = s.mini_on_blur; $('#sM5').checked = s.show_m5;
    $('#sPoStart').value = s.po_start_mode || 'last'; $('#sTvOpen').value = s.tv_open || 'external'; $('#sMiniTf').value = s.mini_tf || 'M5'; $('#sMktLevel').value = String(s.mkt_level || 0); $('#sQuotesDemo').checked = !!s.quotes_demo; document.querySelectorAll('[data-trendtf]').forEach(x => { x.checked = (s.trend_tfs || ['M5']).includes(x.value); }); $('#sTrendFilter').checked = s.trend_filter; $('#sOtcRec').checked = s.otc_record !== false;
    { const r = state.otcRec || {}; let extra = ''; if (isAndroid && window.AndroidApp.recInfo) { try { const a = JSON.parse(window.AndroidApp.recInfo()); extra = ' · ' + t('otc_rec_store', { d: a.days, mb: (a.bytes / 1048576).toFixed(1) }); } catch {} } else if (isDesktop && r.dir) extra = ' · ' + r.dir;
      $('#otcRecInfo').textContent = (r.error ? r.error + ' · ' : '') + t('otc_rec_info', { n: r.rows || 0, p: r.pairs || 0 }) + extra; $('#otcExportBtn').hidden = !(isAndroid && window.AndroidApp.recExport); }
    $('#poLastInfo').textContent = s.po_last_mode ? t('po_last_was', { m: t(s.po_last_mode === 'demo' ? 'po_demo' : 'po_real') }) : '';
    $('#sMiniCount').value = String(s.mini_count || 2); $('#sMiniPos').value = s.mini_pos || 'tr'; $('#sInterval').value = String(s.scan_interval || 60);
    $('#sMin').value = s.min_strength; $('#sMax').value = s.max_per_scan; $('#sPayout').value = s.min_payout;
    renderMarkets(s);
    renderStrategies(s);
  }
  const si = state.session;
  $('#sessionInfo').className = 'session-info ' + (si ? 'ok' : 'none');
  $('#sessionInfo').textContent = si
    ? t('session_stored', { type: si.demo ? 'Demo' : 'Real', n: si.length }) + ' · ' + (state.connected ? t('st_connected') : statusText(state.status))
    : t('session_none');
  const logText = [...(window.__bootErrors || []).map(e => '⚠ ' + e), ...(state.log || [])].join('\n') || '–';
  if ($('#connLog').textContent !== logText) { $('#connLog').textContent = logText; $('#connLog').scrollTop = 1e6; }
  $('#lanBox').hidden = isAndroid;
  $('#lan').innerHTML = (state.lan || []).map(u => `<a href="${u}">${u}</a>`).join('') || `<span class="hint">${t('no_network')}</span>`;
}

// A signal disappears as soon as its expiry is over.
const LINGER = 0;
const isDone = s => Date.now() / 1000 >= s.entryTime + s.expiry;
const isVisible = s => !s.manual && Date.now() / 1000 < s.entryTime + s.expiry + LINGER;
// "My trades": the user's real trades (Buy/Sell in PocketOption, engine.poTrade) count with the trade's own result.
const mineList = () => state.signals.filter(s => s.mine).map(s => (s.trade && s.trade.result ? { ...s, result: s.trade.result } : s));

// Starred signals stay on top (in the order they were starred). Kept per device.
let pins = [];
try { pins = JSON.parse(localStorage.getItem('pins') || '[]'); } catch {}
const savePins = () => { try { localStorage.setItem('pins', JSON.stringify(pins)); } catch {} };
function togglePin(id) {
  pins = pins.includes(id) ? pins.filter(p => p !== id) : [...pins, id];
  savePins(); renderLive();
}
let heldOrder = null;
function showFresh() { heldOrder = null; $('main').scrollTop = 0; renderLive(); }
// Four tiles: decided / won / lost / win rate of a list of signals (mine: the first tile says "my trades").
function statTiles(list, mine) {
  const w = list.filter(s => s.result === 'WIN').length, l = list.filter(s => s.result === 'LOSS').length, r = w + l ? Math.round(100 * w / (w + l)) : null;
  return `<div class="stat"><b>${w + l}</b><span>${t(mine ? 'my_trades' : 'evaluated')}</span></div>
    <div class="stat"><b style="color:var(--call)">${w}</b><span>${t('won')}</span></div>
    <div class="stat"><b style="color:var(--put)">${l}</b><span>${t('lost')}</span></div>
    <div class="stat"><b style="color:${r == null ? 'inherit' : rateColor(r)}">${r == null ? '–' : r + '%'}</b><span>${t('winrate')}</span></div>`;
}
function visibleSignals() {
  const list = state.signals.filter(isVisible).filter(s => !window.labFilter || window.labFilter(s));
  const pinned = pins.map(id => list.find(s => s.id === id)).filter(Boolean);
  // 17.11.2026 (user): newest signals on top; signals that came together (same 30 s) best first: with the M5 direction
  // above "M5 откат", then a still small move (start of the move), then strength.
  const sec = s => { const c = Number(s.created) || 0; return c > 1e12 ? c / 1000 : c; };
  const score = s => { const tdir = miniTrendDir(s); return (tdir === s.dir ? 100 : tdir && tdir !== 'flat' ? -100 : 0) - Math.min(50, Math.max(0, Number(s.live && s.live.off != null ? s.live.off : s.entryOff) || 0) * 40) + (Number(s.strength) || 0) / 10; };
  const rest = list.filter(s => !pins.includes(s.id)).sort((a, b) => Math.floor(sec(b) / 30) - Math.floor(sec(a) / 30) || score(b) - score(a) || sec(b) - sec(a));
  return [...pinned, ...rest];
}
// Trend badge; clicking it opens the pair in PocketOption on the trend timeframe.
const m5Badge = (s, plain) => {
  if (!state.settings.show_m5 || !s.trends) return '';
  // 17.11.2026 (user): signal against the trend of that timeframe = "M5 откат"; with the trend the arrow stays as before.
  const lab = (tf, dir) => (dir === 'CALL' || dir === 'PUT') && (s.dir === 'CALL' || s.dir === 'PUT') && dir !== s.dir ? `${tf} ${t('pullback')}` : `${tf} ${dir === 'CALL' ? '▲' : dir === 'PUT' ? '▼' : '◆'}`;
  if (plain) return s.trends.map(({ tf, dir }) => `<span class="m5 ${dir}">${lab(tf, dir)}</span>`).join('');
  return s.trends.map(({ tf, dir }) => `<button class="m5 ${dir}" data-po="${esc(s.id)}" data-potf="${tf}" title="${t('m5_title', { tf })} – ${t('open_tf')}">${lab(tf, dir)}</button>`).join('');
};
const resultBadge = s => (s.result ? `<span class="res ${s.result}">${I18N.de['res_' + s.result] ? t('res_' + s.result) : s.result}</span>` : '');

// Rebuilds cards and mini rows only when something visible changes (list, finished state, result, M5, stars),
// so timers and progress bars keep running smoothly. Called on every state update and twice a second.
function renderLive() {
  if (!state) return;
  const all = visibleSignals();
  const sig = s => [s.id, isDone(s) ? 1 : 0, s.result || '', (s.trends || []).map(x => x.tf + x.dir).join(), pins.includes(s.id) ? 1 : 0].join(':');
  let live = all.filter(s => dirFilter === 'all' || s.dir === dirFilter);
  // Scrolled down to a signal: the order is held, new signals wait behind the "↑ N new" pill (no jumping cards).
  // At the top, after the pill or the Signals tab: newest first again.
  const main = $('main'), scrolled = main.scrollTop > 40 && $('#signals').classList.contains('active');
  let fresh = 0;
  if (scrolled && heldOrder) { fresh = live.filter(s => !heldOrder.includes(s.id)).length; live = heldOrder.map(id => live.find(s => s.id === id)).filter(Boolean); }
  else heldOrder = live.map(s => s.id);
  $('#newPill').hidden = !fresh; if (fresh) $('#newPill').textContent = t('new_signals', { n: fresh });
  const lk = state.lab ? [state.lab.mode, state.lab.account, JSON.stringify(state.lab.stats || {}).length, live.map(s => (s.trade ? 1 : 0) + (s.paper ? (s.paper.result || 'p') : '')).join()] : [];
  const liveKey = [LANG, state.settings.show_m5, state.settings.trend_tfs, ...lk, ...live.map(sig)].join('|');
  if ($('#live').dataset.key !== liveKey) { const top = main.scrollTop; $('#live').innerHTML = live.map(card).join(''); $('#live').dataset.key = liveKey; main.scrollTop = top; }
  $('#liveEmpty').hidden = live.length > 0;
  updateAdxBoxes();

  const top = all.slice(0, state.settings.mini_count || 2);
  const miniKey = [LANG, state.settings.show_m5, state.settings.trend_tfs, ...top.map(sig)].join('|');
  if ($('#mini').dataset.key === miniKey) return;
  $('#mini').dataset.key = miniKey;
  $('#mini').innerHTML = top.map(s => `<div class="mrow ${s.dir}${isDone(s) ? ' done' : ''}" data-expand="1">
      <span class="grip" title="${t('drag')}">⋮⋮</span>
      <button class="star${pins.includes(s.id) ? ' on' : ''}" data-pin="${esc(s.id)}" title="${t('pin')}">${pins.includes(s.id) ? '★' : '☆'}</button>
      <span class="md">${s.dir === 'CALL' ? '▲' : '▼'} ${s.dir}</span>
      <span class="mi"><b>${esc(s.name)} ${m5Badge(s)}</b><small>${esc(cardName(tr(s.strategyName)))} · ${fmtExp(s.expiry)}</small></span>
      <button class="tag mtf" data-po="${esc(s.id)}" data-potf="${s.tf || 'M1'}" title="${t('open_tf')}">${s.tf || 'M1'}</button>
      ${isDone(s) && s.result ? resultBadge(s) : `<span class="timer" data-id="${esc(s.id)}" data-entry="${s.entryTime}" data-exp="${s.expiry}">${timerText(s.entryTime, s.expiry)}</span>`}
    </div>`).join('') || `<div class="mempty" data-expand="1"><span class="grip">⋮⋮</span><img src="icon.png" width="18" height="18" alt="">${t('waiting')}</div>`;
  if (document.body.classList.contains('compact')) reportMiniHeight();
}
function reportMiniHeight() {
  if (isDesktop && window.desktop.miniHeight) requestAnimationFrame(() => window.desktop.miniHeight($('#mini').scrollHeight));
}

const seen = new Set(), openCards = new Set();
// Countdown only: where the price is against the signal's price.
function priceHint(s) {
  if (!s.live || Date.now() / 1000 >= s.entryTime) return '';
  return `<span class="pz ${s.live.zone}">${t('price_' + s.live.zone)}</span>`;
}
// Result per colour at the entry second, counted from the price at that second (not from the signal's price).
function zoneStats(list) {
  const row = z => {
    const x = list.filter(s => s.entryZone === z), w = x.filter(s => s.zoneResult === 'WIN').length, l = x.filter(s => s.zoneResult === 'LOSS').length;
    return `<div class="zrow"><span class="pz ${z}">${t('zone_' + z)}</span><span>${w + l}</span><b>${w + l ? Math.round(100 * w / (w + l)) + '%' : '–'}</b></div>`;
  };
  return `<div class="zones"><h3>${t('zone_title')}</h3>${['green', 'yellow', 'red'].map(row).join('')}<p class="hint">${t('zone_hint')}</p></div>`;
}
// Small M5 candle chart at signal time (s.m5 = [[o,h,l,c],…], last candle may be unfinished), EMA 9 line, dot = price at signal.
// Per-card timeframe (tabs on the chart), built from s.m1 = { t0, k: [[minute offset, o, h, l, c], …] }.
const cardTf = new Map(), MINI_TFS = ['M1', 'M3', 'M5', 'M15'];
function miniCandles(s, tf) {
  const m = parseInt(tf.slice(1), 10) || 5, sec = m * 60, out = [];
  for (const [dt, o, h, l, c] of s.m1.k) {
    const t = Math.floor((s.m1.t0 + dt * 60) / sec), last = out[out.length - 1];
    if (last && last.t === t) { last.q[1] = Math.max(last.q[1], h); last.q[2] = Math.min(last.q[2], l); last.q[3] = c; }
    else out.push({ t, q: [o, h, l, c] });
  }
  return out.slice(-24).map(x => x.q);
}
// Trend badge next to the pair (user 09.11.2026): follows the chart's timeframe tab, direction = slope of the chart's
// yellow EMA line over the last 3 candles. Falls back to the old trend badge when the signal has no chart data.
// Short strategy name on the signal card (user 17.11.2026: "Пин-бар 2 + Stochastic (погода рынка)" → "Пин-бар 2",
// "Глубокое падение/рост → отскок" → "Глубокое падение").
const cardName = n => String(n || '').split(' + ')[0].replace(/\s*\([^)]*\)\s*$/, '').split(' → ')[0].split('/')[0].trim() || String(n || '');
// Mode tag on the card for "Глубокое падение" (user 17.11.2026: it can trade with the trend or the reversal – say which).
// Taken from the reason text the engine adds ("движение продолжится" / "ожидается разворот").
function cardMode(s) {
  if (s.strategy !== 'n_sharp') return '';
  const r = String((s.reason && (s.reason.ru || s.reason.en)) || s.reason || '');
  const m = /продолжится|continues|geht weiter/.test(r) ? 'follow' : /разворот|rebound|Rücksprung/.test(r) ? 'rev' : '';
  return m ? `<span class="m5 ${m === 'follow' ? 'CALL' : 'flat'}" style="flex:none">${t(m === 'follow' ? 'mode_follow' : 'mode_rev')}</span>` : '';
}
// Direction of the card's chart (yellow EMA over the last 3 candles); M5 trend badge or null without chart data.
function miniTrendDir(s) {
  const tf = cardTf.get(s.id), canSwitch = !!(s.m1 && Array.isArray(s.m1.k) && s.m1.k.length > 10);
  const k = tf && canSwitch ? miniCandles(s, tf) : Array.isArray(s.m5) ? s.m5 : null;
  if (!k || k.length < 6) { const m = (s.trends || []).find(x => x.tf === 'M5'); return m ? m.dir : null; }
  let e = k[0][3]; const ema = k.map((q, i) => (e = i ? q[3] * 0.2 + e * 0.8 : q[3]));
  const n = ema.length - 1; return ema[n] > ema[n - 3] ? 'CALL' : ema[n] < ema[n - 3] ? 'PUT' : 'flat';
}
function miniTrendBadge(s) {
  const tf = cardTf.get(s.id), canSwitch = !!(s.m1 && Array.isArray(s.m1.k) && s.m1.k.length > 10);
  const k = tf && canSwitch ? miniCandles(s, tf) : Array.isArray(s.m5) ? s.m5 : null;
  if (!k || k.length < 6) return m5Badge(s, true);
  const dir = miniTrendDir(s);
  const cur = tf && canSwitch ? tf : (s.miniTf || 'M5');
  // 17.11.2026 (user): signal against this timeframe's direction = "M5 откат".
  const pull = (dir === 'CALL' || dir === 'PUT') && (s.dir === 'CALL' || s.dir === 'PUT') && dir !== s.dir;
  return `<span class="m5 ${dir}">${esc(cur)} ${pull ? t('pullback') : dir === 'CALL' ? '▲' : dir === 'PUT' ? '▼' : '◆'}</span>`;
}
function m5Chart(s) {
  const tf = cardTf.get(s.id), canSwitch = !!(s.m1 && Array.isArray(s.m1.k) && s.m1.k.length > 10);
  const k = tf && canSwitch ? miniCandles(s, tf) : Array.isArray(s.m5) ? s.m5 : null; if (!k || k.length < 3) return '';
  const cur = tf && canSwitch ? tf : (s.miniTf || 'M5');
  const tabs = canSwitch ? `<div class="m5tabs">${MINI_TFS.map(x => `<button data-ctf="${x}" data-cid="${esc(s.id)}" class="${x === cur ? 'on' : ''}">${x}</button>`).join('')}</div>` : '';
  const W = 240, H = 56, P = 3, n = k.length, cw = (W - 2 * P) / n;
  let lo = Infinity, hi = -Infinity; for (const q of k) { lo = Math.min(lo, q[2]); hi = Math.max(hi, q[1]); }
  const sp = hi - lo || 1, y = v => (P + (hi - v) / sp * (H - 2 * P)).toFixed(1);
  let body = '', e = k[0][3], pts = [];
  k.forEach((q, i) => {
    const [o, h, l, c] = q, x = P + i * cw + cw / 2, up = c >= o, col = up ? '#22c55e' : '#ef4444';
    const top = y(Math.max(o, c)), bh = Math.max(1, y(Math.min(o, c)) - top);
    body += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${y(h)}" y2="${y(l)}" stroke="${col}" stroke-width="1"/><rect x="${(x - cw * 0.35).toFixed(1)}" y="${top}" width="${(cw * 0.7).toFixed(1)}" height="${bh.toFixed(1)}" fill="${col}"/>`;
    e = i ? c * 0.2 + e * 0.8 : c; pts.push(`${x.toFixed(1)},${y(e)}`);
  });
  const last = k[n - 1], lx = P + (n - 1) * cw + cw / 2;
  return `<div class="m5chart">${tabs || `<span>${esc(cur)}</span>`}<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${body}<polyline points="${pts.join(' ')}" fill="none" stroke="#facc15" stroke-width="1.2"/><circle cx="${lx.toFixed(1)}" cy="${y(last[3])}" r="2.5" fill="#fff"/></svg></div>`;
}
function card(s) {
  const fresh = !seen.has(s.id); seen.add(s.id);
  const created = Math.floor((s.created || Date.now()) / 1000), tp = timeProgress(s.entryTime, s.expiry, created);
  const done = isDone(s), pinned = pins.includes(s.id);
  const more = openCards.has(s.id);
  return `<div class="sig ${s.dir}${fresh && !done ? ' new' : ''}${done ? ' done' : ''}">
    <div class="sig-top">
      <button class="star${pinned ? ' on' : ''}" data-pin="${esc(s.id)}" title="${t('pin')}">${pinned ? '★' : '☆'}</button>
      <div class="pairbox"><div class="pair">${esc(s.name)}</div>
        <div class="pairmeta" style="display:flex;align-items:center;gap:4px;white-space:nowrap;min-width:0"><span style="overflow:hidden;text-overflow:ellipsis;min-width:0">${esc(cardName(tr(s.strategyName)))}</span>${cardMode(s)}${miniTrendBadge(s)}<span style="flex:none">· ${s.tf || 'M1'}</span></div></div>
      ${done && s.result ? resultBadge(s) : `<div class="dir ${s.dir}"><span class="arrow">${s.dir === 'CALL' ? '▲' : '▼'}</span>${s.dir}</div>`}
    </div>
    <div class="sig-now"><div class="timer" data-id="${esc(s.id)}" data-entry="${s.entryTime}" data-exp="${s.expiry}">${timerText(s.entryTime, s.expiry)}</div>
      <span>${fmtExp(s.expiry)} · ${s.payout}%</span></div>
    ${window.labCard ? labCard(s) : ''}
    ${m5Chart(s)}
    ${done ? '' : `<div class="pricehint" data-zone-id="${esc(s.id)}">${priceHint(s)}</div>`}
    <div class="timebar${tp.run ? ' run' : ''}" data-entry="${s.entryTime}" data-exp="${s.expiry}" data-created="${created}"><i style="width:${tp.pct}%"></i></div>
    <div class="btns">
      <div class="posplit">${(() => { // two buttons (user 14.11.2026): adaptive timeframe + adaptive expiry, or the chart as it is
        const tf = s.adTf ? s.adTf.tf : (s.tf || 'M1'), exp = s.recExp && !s.recWeak ? s.recExp : s.expiry;
        return `<button class="po adtf" data-po="${esc(s.id)}" data-potf="${tf}" data-poexp="${exp}" title="${esc(tr(s.adTf ? s.adTf.why : '') || t('po_set_hint'))}"><small>${t('ad_btn')} ↗</small><b>${tf} · ⏱ ${fmtExp(exp)}</b></button>`; })()}<button class="po keep" data-po="${esc(s.id)}" title="${t('po_keep_hint')}"><small>PocketOption ↗</small><b>${t('po_keep')}</b></button></div>
      ${!done && state.settings.quick_trade && (isDesktop || isAndroid) ? `<button class="po quick ${s.dir}${quickArmed(s.id) ? ' armed' : ''}" data-quick="${esc(s.id)}"><small>⚡ ${quickArmed(s.id) ? t('quick_sure') : s.dir}</small><b>${fmtExp(s.expiry)}</b></button>` : ''}
      <button class="morebtn" data-more="${esc(s.id)}" aria-expanded="${more}" title="${t('card_more')}">${more ? '▴' : '▾'}</button>
    </div>
    ${more ? `<div class="sig-more"><div class="why">${esc(tr(s.reason))}</div>${s.adTf ? `<div class="why"><b>${t('ad_tf')}:</b> ${esc(tr(s.adTf.why))}<br><small>${(s.adTf.all || []).map(x => `${x.tf} ${Math.round(x.score * 100)}`).join(' · ')}</small></div>` : ''}
      ${done ? '' : `<div class="trendbox" data-trend-id="${esc(s.id)}">${trendBox(s)}</div><div class="adxbox" data-adx-id="${esc(s.id)}">${adxBox(s)}</div>`}
      <button class="tag" data-po="${esc(s.id)}" data-potf="${s.tf || 'M1'}" title="${t('open_tf')}">${s.tf || 'M1'} ↗</button>
      <button class="tag" data-tv="${esc(s.id)}">TradingView ↗</button></div>` : ''}
  </div>`;
}
// Recommended expiry (engine.recExpiry): a tap opens PocketOption on the pair and sets this expiry there.
function recBtn(s) {
  if (!s.recExp) return '';
  const long = s.recExp > 60;
  return `<button class="recexp${long ? ' long' : ''}${s.recWeak ? ' weak' : ''}" data-po="${esc(s.id)}" data-poexp="${s.recExp}" title="${esc(tr(s.recWhy) || '')}">
    <span class="re-l">⏱ <b>${fmtExp(s.recExp)}</b></span><small>${esc(tr(s.recShort || s.recWhy) || '')}</small><span class="re-go">PO ↗</span></button>`;
}
// Live ADX of the signal (engine samples every 5 s): number, rising/falling over the last ~30 s, strength scale,
// +DI/−DI and a small line of the last 3 minutes. Rising = the trend gets stronger (no early reversal entry).
function adxBox(s) {
  const a = s.adxLive, rgName = (a && a.regime) || s.regime;
  const rg = rgName ? `<span class="rg ${rgName}" title="${t('regime_filter_hint')}">${t('rg_' + rgName)}</span>` : '';
  if (!a) return `${rg}<div class="adx-wait">ADX · ${t('adx_wait')}</div>`;
  const h = a.hist || [a.adx], ref = h[Math.max(0, h.length - 7)], d = a.adx - ref;
  const trend = d > 0.3 ? 'up' : d < -0.3 ? 'down' : 'flat';
  const lvl = a.adx >= 40 ? 'vstrong' : a.adx >= 25 ? 'strong' : a.adx >= 20 ? 'mid' : 'weak';
  const lo = Math.min(...h), hi = Math.max(...h), span = hi - lo || 1, W = 90, H = 26;
  const pts = h.map((v, i) => `${h.length > 1 ? (i * W / (h.length - 1)).toFixed(1) : W},${(H - 2 - (v - lo) / span * (H - 4)).toFixed(1)}`).join(' ');
  return `<div class="adx-main"><small>ADX</small><b class="adx-val ${lvl}">${a.adx.toFixed(1)}</b>
      <span class="adx-trend ${trend}">${trend === 'up' ? '▲' : trend === 'down' ? '▼' : '◆'} ${d >= 0 ? '+' : ''}${d.toFixed(1)}</span></div>
    <div class="adx-mid"><div class="adx-scale"><i style="left:${Math.min(100, a.adx / 60 * 100)}%"></i></div>
      <div class="adx-txt ${trend}">${rg}${t('adx_' + trend)} · ${t('adx_' + lvl)}</div>
      <div class="adx-di">+DI ${a.pdi.toFixed(0)} · −DI ${a.mdi.toFixed(0)}${s.adx0 !== undefined ? ` · ${t('adx_at_signal')} ${Number(s.adx0).toFixed(1)}` : ''}</div></div>
    <svg class="adx-spark ${trend}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><polyline points="${pts}" fill="none" stroke-width="2"/></svg>`;
}
// Trend on the signal's own timeframe with a staircase icon; red warning when the signal goes against it.
function trendBox(s) {
  const tr = s.adxLive && s.adxLive.trend, tf = s.tf || 'M1';
  if (!tr) return `<span class="tr-lbl">${t('trend_on', { tf })}</span><span class="tr-val">…</span>`;
  const stairs = { UP: '4,22 4,16 10,16 10,10 16,10 16,4 22,4', DOWN: '4,4 4,10 10,10 10,16 16,16 16,22 22,22', FLAT: '3,13 9,10 15,16 21,13' }[tr];
  const against = (tr === 'UP' && s.dir === 'PUT') || (tr === 'DOWN' && s.dir === 'CALL');
  return `<svg class="tr-ico ${tr}" viewBox="0 0 26 26" width="30" height="30"><polyline points="${stairs}" fill="none" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/></svg>
    <span class="tr-lbl">${t('trend_on', { tf })}</span><b class="tr-val ${tr}">${t('trend_' + tr)}</b>
    ${against ? `<span class="tr-warn">⚠ ${t('trend_against')}</span>` : tr !== 'FLAT' ? `<span class="tr-ok">✓ ${t('trend_with')}</span>` : ''}`;
}
function updateAdxBoxes() {
  if (!state) return;
  document.querySelectorAll('[data-zone-id]').forEach(el => {
    const s = state.signals.find(x => x.id === el.dataset.zoneId), html = s ? priceHint(s) : '';
    if (el.dataset.h !== html) { el.innerHTML = html; el.dataset.h = html; }
  });
  document.querySelectorAll('[data-trend-id]').forEach(el => {
    const s = state.signals.find(x => x.id === el.dataset.trendId);
    if (s) { const html = trendBox(s); if (el.dataset.h !== html) { el.innerHTML = html; el.dataset.h = html; } }
  });
  document.querySelectorAll('[data-adx-id]').forEach(el => {
    const s = state.signals.find(x => x.id === el.dataset.adxId);
    if (s) { const html = adxBox(s); if (el.dataset.h !== html) { el.innerHTML = html; el.dataset.h = html; } }
  });
}
function row(s) {
  const res = s.result ? `<span class="res ${s.result}">${I18N.de['res_' + s.result] ? t('res_' + s.result) : s.result}</span>` : `<span class="res">${t('res_running')}</span>`;
  // Tap a row: it opens and shows the full strategy name and the reason (the narrow row cuts them off).
  const open = openHist.has(s.id);
  return `<div class="hist${open ? ' open' : ''}" data-hist-id="${esc(s.id)}"><span class="d ${s.dir}">${s.dir === 'CALL' ? '▲' : '▼'}<br>${s.dir}</span>
    <div class="info"><b>${esc(s.name)}${tradeNet(s) != null ? ` <span style="color:${tradeNet(s) > 0 ? 'var(--call)' : tradeNet(s) < 0 ? 'var(--put)' : 'inherit'}">${money(tradeNet(s))}${s.trade.demo ? ' · Demo' : ' · Real'}</span>` : ''}</b><small>${esc(tr(s.strategyName))} · ${s.tf || 'M1'}</small>
      <small>${fmtTime(s.entryTime)} · ${fmtExp(s.expiry)} · ${t('strength')} ${s.strength}</small></div>${res}
    <button class="mini mine${s.mine ? ' on' : ''}" data-mine="${esc(s.id)}" title="${t('my_mark')}">${s.mine ? '✓' : '＋'}</button>
    <button class="mini po" data-po="${esc(s.id)}">PO</button><button class="mini" data-tv="${esc(s.id)}">TV</button>
    ${open ? `<div class="why">${esc(tr(s.reason) || '')}${s.entryPrice ? ` · ${s.entryPrice}${s.exitPrice ? ' → ' + s.exitPrice : ''}` : ''}</div>` : ''}</div>`;
}
// Money per trade (user 14.11.2026: "after every trade count it, demo and real apart"). Only trades seen in the PO page carry
// an amount. Net result: loss = −amount; win = PO's profit (if it is larger than the stake it is the total return → minus stake),
// without profit the pair's payout %; draw = 0. null = no amount / not settled.
function tradeNet(s) {
  const tr = s.trade; if (!tr || !(tr.amount > 0) || !tr.result) return null;
  if (tr.result === 'LOSS') return -tr.amount;
  if (tr.result !== 'WIN') return 0;
  const p = Number(tr.profit) || 0;
  return p > 0 ? (p > tr.amount ? p - tr.amount : p) : tr.amount * (Number(s.payout) || 85) / 100;
}
const money = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2);
function moneyStats(mine) {
  const day = new Date(); day.setHours(0, 0, 0, 0); const d0 = day.getTime() / 1000;
  const box = demo => {
    const tr = mine.filter(s => s.trade && !!s.trade.demo === demo && tradeNet(s) != null);
    if (!tr.length) return '';
    const sum = a => a.reduce((x, s) => x + tradeNet(s), 0), today = tr.filter(s => (s.trade.at || s.entryTime) >= d0);
    const all = sum(tr), td = sum(today), col = v => v > 0 ? 'var(--call)' : v < 0 ? 'var(--put)' : 'inherit';
    return `<div class="stat"><b style="color:${col(td)}">${money(td)}</b><span>${t(demo ? 'pl_demo_day' : 'pl_real_day')} · ${today.length}</span></div>
      <div class="stat"><b style="color:${col(all)}">${money(all)}</b><span>${t(demo ? 'pl_demo_all' : 'pl_real_all')} · ${tr.length}</span></div>`;
  };
  const h = box(true) + box(false);
  const none = mine.filter(s => s.result && tradeNet(s) == null).length;
  return h ? `<div class="stats">${h}</div>${none ? `<p class="hint">${t('pl_none').replace('{n}', none)}</p>` : ''}` : '';
}
// The user's own trades (signals marked "taken"): summary, per strategy, and the list – apart from the bot's statistics.
function myStats() {
  const mine = mineList();
  if (!mine.length) return `<p class="empty">${t('my_none')}</p>`;
  const w = mine.filter(s => s.result === 'WIN').length, l = mine.filter(s => s.result === 'LOSS').length, r = w + l ? Math.round(100 * w / (w + l)) : null;
  return `<div class="stats">
      <div class="stat"><b>${mine.length}</b><span>${t('my_taken')}</span></div>
      <div class="stat"><b style="color:var(--call)">${w}</b><span>${t('won')}</span></div>
      <div class="stat"><b style="color:var(--put)">${l}</b><span>${t('lost')}</span></div>
      <div class="stat"><b style="color:${r == null ? 'inherit' : rateColor(r)}">${r == null ? '–' : r + '%'}</b><span>${t('winrate')}</span></div></div>
    ${moneyStats(mine)}${strategyStats(mine)}${mine.map(row).join('')}`;
}
// Statistics archived from the old Telegram bot (ui/bot_stats.js, counts only): by market, strategy and expiry, with the 95 % interval
// (Wilson) and the break-even rate at 85 % payout – a rate counts as proven only when the whole interval lies above break-even.
function archiveStats() {
  const D = window.BOT_STATS;
  if (!D) return `<p class="empty">${t('arch_none')}</p>`;
  const BE = 100 / 1.85;
  const wil = (w, n) => { const z = 1.96, p = w / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [100 * (c - m) / d, 100 * (c + m) / d]; };
  const names = {}; for (const x of (state.settings.allStrategies || [])) names[x.key] = tr(x.name);
  const agg = (f, rows) => { const m = {}; for (const r of rows) { const k = f(r); const a = (m[k] ??= { k, w: 0, l: 0 }); a.w += r.w; a.l += r.l; } return Object.values(m).map(a => ({ ...a, n: a.w + a.l })).filter(a => a.n); };
  const line = (label, a) => {
    const r = 100 * a.w / a.n, [lo, hi] = wil(a.w, a.n), proven = lo > BE;
    return `<div class="srow"><div class="top"><b>${esc(label)}</b><b style="color:${proven ? 'var(--call)' : r < BE ? 'var(--put)' : 'var(--muted)'}">${r.toFixed(1)}%</b></div>
      <small>${t('arch_line', { n: a.n, lo: lo.toFixed(0), hi: hi.toFixed(0) })}${proven ? ' · ' + t('arch_proven') : ''}</small>
      <div class="meter"><i style="width:${r}%;background:${rateColor(Math.round(r))}"></i></div></div>`;
  };
  const sec = (title, arr, labelOf, min) => `<h3>${t(title)}</h3>` + arr.filter(a => a.n >= (min || 1)).map(a => line(labelOf(a), a)).join('');
  const all = agg(() => 'all', D.rows)[0];
  const day = s => new Date(s * 1000).toLocaleDateString(LANG === 'ru' ? 'ru-RU' : LANG === 'en' ? 'en-GB' : 'de-DE');
  const mk = k => t(k === 'otc' ? 'arch_otc' : 'arch_real');
  return `<p class="note">${t('arch_intro', { from: day(D.from), to: day(D.to), be: BE.toFixed(1) })}</p>
    ${sec('arch_total', [all], () => t('arch_all'))}
    ${sec('arch_by_market', agg(r => r.m, D.rows).sort((a, b) => b.n - a.n), a => mk(a.k))}
    ${sec('arch_by_source', agg(r => r.src || '-', D.rows).sort((a, b) => b.n - a.n), a => t('arch_src_' + (a.k === '-' ? 'old' : a.k)), 20)}
    ${sec('arch_by_expiry', agg(r => r.e, D.rows).sort((a, b) => a.k - b.k), a => fmtExp(a.k), 50)}
    ${sec('arch_by_strategy', agg(r => (r.s || '-') + '|' + r.m, D.rows).sort((a, b) => b.n - a.n), a => { const [s, m] = a.k.split('|'); return (s === '-' ? t('arch_noname') : names[s] || s) + ' · ' + mk(m); }, 40)}
    <p class="note">${t('arch_warn')}</p>`;
}
function strategyStats(list) {
  const by = {};
  for (const s of list) {
    const b = (by[s.strategy] ??= { name: s.strategyName, n: 0, w: 0, l: 0 });
    b.n++; if (s.result === 'WIN') b.w++; if (s.result === 'LOSS') b.l++;
    // Strategies with several models (reversal at a level: A, B, A+B) also get one row per model.
    if (s.model) {
      const lbl = t('model_' + s.model), sub = lbl === 'model_' + s.model || !lbl ? s.model : lbl; // preset names have no text key
      const m = (by[s.strategy + '|' + s.model] ??= { name: s.strategyName, sub, n: 0, w: 0, l: 0 });
      m.n++; if (s.result === 'WIN') m.w++; if (s.result === 'LOSS') m.l++;
    }
  }
  // Model rows right under their strategy.
  const rows = Object.entries(by).filter(([k]) => !k.includes('|')).sort((a, b) => b[1].n - a[1].n)
    .flatMap(([k, v]) => [v, ...Object.entries(by).filter(([m]) => m.startsWith(k + '|')).map(([, x]) => x).sort((a, b) => b.n - a.n)]);
  if (!rows.length) return `<p class="empty">${t('no_signals')}</p>`;
  return rows.map(b => {
    const done = b.w + b.l, r = done ? Math.round(100 * b.w / done) : null;
    return `<div class="srow${b.sub ? ' sub' : ''}"><div class="top"><b>${esc(b.sub ? '↳ ' + b.sub : tr(b.name))}</b><b style="color:${r == null ? 'var(--muted)' : rateColor(r)}">${r == null ? '–' : r + '%'}</b></div>
      <small>${t('stat_line', { n: b.n, w: b.w, l: b.l })}</small>
      <div class="meter"><i style="width:${r ?? 0}%;background:${r == null ? 'transparent' : rateColor(r)}"></i></div></div>`;
  }).join('');
}

const CATS = ['forex', 'otc', 'po_crypto', 'po_goods', 'po_indices', 'po_stocks'];
// Markets: a switch per market; a market that is on can be opened to choose its pairs one by one.
const openMarkets = new Set();
function renderMarkets(s) {
  const markets = s.markets || {}, box = $('#cats');
  // The state arrives every second or two: rebuilding the list would throw a scrolled pair list back to the top.
  const html = CATS.map(k => {
    const on = !s.assets_off.includes(k), pairs = markets[k] || [], chosen = pairs.filter(p => p.on).length;
    const open = on && openMarkets.has(k);
    return `<div class="mkt${open ? ' open' : ''}">
      <div class="row"><span>${t('cat_' + k)}${on && pairs.length ? `<small>${t('pairs_chosen', { a: chosen, n: pairs.length })}</small>` : ''}</span>
        <span class="mkt-ctl">${on && pairs.length ? `<button class="strat-arrow" data-mkt="${k}">${open ? '▴' : '▾'}</button>` : ''}
        <input type="checkbox" class="sw" data-cat="${k}" ${on ? 'checked' : ''}></span></div>
      ${open ? `<div class="mkt-body">
        <div class="chips"><button class="chip" data-pairs-all="${k}">${t('all')}</button><button class="chip" data-pairs-none="${k}">${t('none')}</button></div>
        ${pairs.map(p => `<label class="prow"><span>${esc(p.name)} <small>${p.payout}%${p.open ? '' : ' · ' + t('closed')}</small></span>
          <input type="checkbox" class="sw" data-pair="${esc(p.key)}" ${p.on ? 'checked' : ''}></label>`).join('')}
      </div>` : ''}
    </div>`;
  }).join('');
  if (box.dataset.html === html) return;
  const scroll = [...box.querySelectorAll('.mkt-body')].map(b => b.scrollTop);
  box.innerHTML = html; box.dataset.html = html;
  box.querySelectorAll('.mkt-body').forEach((b, i) => { b.scrollTop = scroll[i] || 0; });
}
// Changes the chosen pairs locally (instant) and in the engine.
function setPairs(keysOn, keysOff) {
  if (!Array.isArray(state.settings.pairs)) return; // never overwrite the selection without knowing it
  const pairs = new Set(state.settings.pairs);
  keysOn.forEach(k => pairs.add(k)); keysOff.forEach(k => pairs.delete(k));
  state.settings.pairs = [...pairs];
  for (const list of Object.values(state.settings.markets || {})) for (const p of list) p.on = pairs.has(p.key);
  call({ action: 'settings', patch: { pairs: state.settings.pairs } });
  renderMarkets(state.settings);
}
const TFS = ['S10', 'S15', 'S30', 'M1', 'M2', 'M3', 'M5'];
const paramLabel = k => (PARAM_NAMES[k] ? PARAM_NAMES[k][{ de: 0, ru: 1, en: 2 }[LANG] ?? 0] : k);
const openStrats = new Set(), openHist = new Set(), openTests = new Set();
// Backtest table of a strategy: folded, a tap on the title opens or closes it.
// Folded sections of a strategy: result tables (x.tests) and the instruction (x.help), all closed by default.
function testTable(x) {
  const list = [...(x.tests ? (Array.isArray(x.tests) ? x.tests : [x.tests]) : []), ...(x.help || [])];
  const L = x.log; // "why no signal" counters of the big-candle mode
  if (L && L.checked) list.push({ title: t('bl_title'), cols: [t('bl_reason'), t('bl_count')], rows: ['checked', 'small', 'range', 'ratio', 'atr', 'notrend', 'side', 'fast', 'far', 'pause', 'noconfirm', 'signals'].filter(k => k === 'checked' || L[k]).map(k => [t('bl_' + k), String(L[k])]) });
  return list.map((T, n) => oneTest(T, `${x.key}:${n}`)).join('');
}
function oneTest(T, key) {
  const open = openTests.has(key), cell = v => esc(typeof v === 'string' ? v : tr(v));
  const body = T.rows
    ? `<table><tr>${T.cols.map(h => `<th>${cell(h)}</th>`).join('')}</tr>${T.rows.map(r => `<tr>${r.map((v, n) => `<td${n ? ' class="num"' : ''}>${cell(v)}</td>`).join('')}</tr>`).join('')}</table>`
    : (T.body || []).map(b => `<p>${cell(b)}</p>`).join('');
  return `<div class="tests"><button class="tests-h" data-tests="${key}" aria-expanded="${open}">${open ? '▾' : '▸'} ${cell(T.title)}</button>
    ${open ? `<div class="tests-b">${body}${T.note ? `<small>${cell(T.note)}</small>` : ''}</div>` : ''}</div>`;
}
// Settings as plain rows, or in blocks (title + what the block decides) when the strategy defines groups.
// Settings that work against the chosen way of trading are hidden (user 17.11.2026).
function hiddenParams(x) {
  if (x.key === 'n_run') { // a switched-off mode hides its settings except its own switch (19.11.2026)
    const g = { rs_m_run: x.params.rs_cross ? ['rs_min', 'rs_atr', 'rs_series'] : ['rs_tf', 'expiry', 'rs_buy', 'rs_sell', 'rs_min', 'rs_atr', 'rs_adx_on', 'rs_adx_min', 'rs_room', 'rs_series', 'rs_cross_fast', 'rs_cross_slow', 'rs_cross_after'], // 20.11.2026: the EMA cross switch stays visible with the series off
      rs_m_zone: ['rs_z_tf', 'rs_z_exp', 'rs_z_buy', 'rs_z_sell', 'rs_z_n', 'rs_z_touch', 'rs_z_width', 'rs_z_gap'],
      rs_m_pull: ['rs_p_tf', 'rs_p_exp', 'rs_p_buy', 'rs_p_sell', 'rs_p_trend', 'rs_p_max', 'rs_p_depth', 'rs_p_di', 'rs_p_adx'] };
    const hid = Object.entries(g).flatMap(([k, keys]) => x.params[k] === false || (k !== 'rs_m_run' && !x.params[k]) ? keys : []);
    if (x.params.rs_cross === false) hid.push('rs_cross_after', 'rs_cross_fast', 'rs_cross_slow');
    if (x.params.rs_cross === false) hid.push('rs_series');
    if (x.params.rs_cross !== false && x.params.rs_series === false) hid.push('rs_min', 'rs_atr'); // series filter off: its settings hidden
    if (x.params.rs_chaos_on === false) hid.push('rs_chaos', 'rs_chaos_n');
    return hid;
  }
  if (x.modes && x.params.ludo_mode && x.params.ludo_mode !== 'MANUAL') return Object.keys(x.modes[x.params.ludo_mode] || {}); // a ready mode: its values are in the spoiler
  if (x.key !== 'n_sharp') return [];
  return [...(x.params.sharp_on_rev === false ? ['sharp_min', 'sharp_wait', 'sharp_mirror', 'sharp_stoch', 'sharp_low', 'sharp_high', 'sharp_k', 'sharp_ks', 'sharp_k_late', 'sharp_rsi', 'sharp_rsi_back', 'sharp_trig', 'sharp_rv_adx'] : []),
    ...(!x.params.sharp_on_trend ? ['sharp_tr_deep', 'sharp_tr_opp', 'sharp_tr_atr', 'sharp_tr_new', 'sharp_tr_far', 'sharp_tr_di', 'sharp_tr_adx'] : [])];
}
function paramRows(x) {
  const hid = hiddenParams(x);
  const row = k => k in x.params && !hid.includes(k) ? `<label class="prow"><span>${esc(x.labels && x.labels[k] ? tr(x.labels[k]) : paramLabel(k))}</span>${paramInput(x.key, k, x.params[k])}</label>` : '';
  // Every block is folded (user, 07.11.2026); only the open block's rows are drawn. Same open/closed state as the tables.
  const used = new Set((x.groups || []).flatMap(g => g.keys)), rest = Object.keys(x.params).filter(k => !used.has(k) && !hid.includes(k));
  const fold = (title, desc, keys, id) => {
    const body = keys.map(row).join(''); if (!body) return '';
    const key = `${x.key}:p${id}`, open = openTests.has(key);
    return `<div class="tests"><button class="tests-h" data-tests="${key}" aria-expanded="${open}">${open ? '▾' : '▸'} ${esc(title)}</button>${open ? `<div class="tests-b pfold">${desc ? `<small>${esc(desc)}</small>` : ''}${body}</div>` : ''}</div>`;
  };
  return (x.groups || []).map((g, n) => fold(tr(g.title), tr(g.desc), g.keys, n)).join('') + fold(t(x.groups ? 'params_other' : 'params_all'), '', rest, 'r');
}
// Parameters with a fixed choice are shown as a select.
const PARAM_CHOICES = { ls_level_tf: ['PIN', 'M15'], sharp_trig: ['STOCH', 'RSI', 'ANY'], ax_dir: ['BOTH', 'UP', 'DOWN'], im_dir: ['WITH', 'AGAINST'], tr_cross_tf: ['ENTRY', 'M5'], tr_mode: ['BOUNCE', 'CROSS', 'TURN', 'TREND'], tr_tf: ['M1', 'M2', 'M3', 'M5'], ls_tf: ['M1', 'M2', 'M3', 'M4', 'M5'], ls_flat_tf: ['M1', 'M2', 'M3', 'M4', 'M5'], lw_adx_tf: ['M1', 'M2', 'M3', 'M4', 'M5'], tr_ma: ['EMA', 'SMA'], rk_ma: ['EMA', 'SMA'], rs_tf: ['M1', 'M5', 'M15'], rs_z_tf: ['M1', 'M5', 'M15'], rs_p_tf: ['M1', 'M5', 'M15'], pn_tf: ['M1', 'M5', 'M15'], tw_tf: ['M1', 'M2', 'M3', 'M5'], tw_trend: ['OFF', 'M2', 'M3', 'M4', 'M5', 'M10', 'M15'], es_mode: ['START', 'BOUNCE', 'TREND'], es_tf: ['M1', 'M2', 'M3', 'M5'], es_ma: ['EMA', 'SMA'], ludo_mode: ['MANUAL', 'A', 'B', 'C'] };
const CHOICE_TEXT = { PIN: 'levtf_pin', ANY: 'trig_any', BOTH: 'axdir_both', UP: 'axdir_up', DOWN: 'axdir_down', WITH: 'imdir_with', AGAINST: 'imdir_against', ENTRY: 'crosstf_entry', BOUNCE: 'trmode_bounce', CROSS: 'trmode_cross', TURN: 'trmode_turn', TREND: 'trmode_trend', START: 'esmode_start', MANUAL: 'mode_manual' };
// Step and minimum for the − / + buttons (19.11.2026). Known keys from the prompt; else 1 for whole numbers, 0.1 for fractions, min 0.
const NUM_STEP = { expiry: [60, 60], rs_z_exp: [60, 60], rs_p_exp: [60, 60], ludo_exp: [15, 15], rs_min: [1, 2], rs_atr: [0.1, 0], rs_adx_min: [1, 0], rs_room: [0.5, 0], rs_cross_fast: [1, 1], rs_cross_slow: [1, 2],
  rs_z_n: [1, 1], rs_z_touch: [1, 2], rs_z_width: [0.1, 0.1], rs_z_gap: [1, 1], rs_p_trend: [1, 2], rs_p_max: [1, 1], rs_p_depth: [5, 5], rs_p_adx: [1, 0],
  tw_tol: [0.05, 0.05], tw_ext: [1, 3], tw_early: [1, 0],
  pn_imp_n: [1, 1], pn_big_n: [1, 1], pn_big_atr: [0.1, 0], pn_min_atr: [0.1, 0], pn_stop: [0.1, 0.1], pn_tail: [5, 0], pn_early: [1, 0],
  rs_cross_after: [1, 0], ludo_cross_after: [1, 0], rs_chaos: [0.05, 0], rs_chaos_n: [1, 5], max_chaos: [0.05, 0.05], min_series: [1, 1], ser_body_atr: [0.1, 0], ludo_path: [0.1, 0], ludo_body_min: [0.1, 0], ludo_body_max: [0.1, 0], ludo_clean: [1, 0], ludo_wick: [5, 0], ludo_fast: [1, 1], ludo_slow: [1, 2],
  corr_body_min: [0.1, 0], corr_body_max: [0.1, 0], sp_early: [1, 0], sp_atr: [0.1, 0.1], sp_atr10: [0.1, 0.1], sp_atr15: [0.1, 0.1], sp_rev_exp: [60, 60], sp_rev_exp10: [60, 60], sp_rev_exp15: [60, 60],
  sp_after: [1, 1], sp_after10: [1, 1], sp_after15: [1, 1], sp_cont_exp: [60, 60], sp_cont_exp10: [60, 60], sp_cont_exp15: [60, 60] };
const numStep = (name, v) => NUM_STEP[name] || [Number.isInteger(v) ? 1 : 0.1, 0];
const parseNum = s => Number(String(s).trim().replace(',', '.'));
function paramInput(key, name, v) {
  const id = `data-sp="${key}" data-param="${name}"`;
  if (PARAM_CHOICES[name]) return `<select ${id}>${PARAM_CHOICES[name].map(o => `<option value="${o}"${o === v ? ' selected' : ''}>${o === 'STOCH' ? 'Stochastic' : CHOICE_TEXT[o] ? t(CHOICE_TEXT[o]) : o}</option>`).join('')}</select>`;
  if (typeof v === 'boolean') return `<input type="checkbox" class="sw" ${id} ${v ? 'checked' : ''}>`;
  if (typeof v === 'number') { const [st, mn] = numStep(name, v); return `<span class="numbox"><button type="button" class="nb" data-nb="-1">−</button><input type="text" inputmode="decimal" data-num data-step="${st}" data-min="${mn}" ${id} value="${v}"><button type="button" class="nb" data-nb="1">+</button></span>`; }
  return `<input type="text" ${id} value="${esc(v)}">`;
}
// Ludo ready modes (user 20.11.2026): every mode has a spoiler with its values; the chosen one is marked.
function modeSpoilers(x) {
  if (!x.modes) return '';
  // Always-visible buttons (user 20.11.2026): new mode on/off and the mode itself, no need to open a block.
  const on = !!x.params.ludo_new, cur = x.params.ludo_mode || 'MANUAL';
  const bar = `<div class="presets"><small>${esc(t('ludo_bar'))}</small><button class="chip${on ? ' active' : ''}" data-lnew="${x.key}">${on ? '✓ ' + t('ludo_new_on') : t('ludo_new_off')}</button>${on ? ['MANUAL', ...Object.keys(x.modes)].map(m => `<button class="chip${cur === m ? ' active' : ''}" data-lmode="${x.key}" data-m="${m}">${cur === m ? '✓ ' : ''}${m === 'MANUAL' ? t('mode_manual') : t('ludo_mode_btn', { m })}</button>`).join('') : ''}</div>`;
  return bar + Object.entries(x.modes).map(([m, vals]) => {
    const key = `${x.key}:mode${m}`, open = openTests.has(key), on = x.params.ludo_mode === m;
    const rows = Object.entries(vals).map(([k, v]) => `<div class="prow"><span>${esc(x.labels && x.labels[k] ? tr(x.labels[k]) : paramLabel(k))}</span><b>${typeof v === 'boolean' ? (v ? '✓' : '—') : v}</b></div>`).join('');
    return `<div class="tests"><button class="tests-h" data-tests="${key}" aria-expanded="${open}">${open ? '▾' : '▸'} ${on ? '✓ ' : ''}${esc(t('ludo_mode_n', { m }))}</button>${open ? `<div class="tests-b pfold">${rows}</div>` : ''}</div>`;
  }).join('');
}
function renderStrategies(s) {
  const q = stratQuery.toLowerCase();
  // Only the strategies starred in the Catalog are listed here (user 13.11.2026: no need to go to the Catalog each time).
  const list = s.allStrategies.filter(x => s.favorites.includes(x.key) &&
    (stratFilter === 'all' || (stratFilter === 'on' ? s.strategies.includes(x.key) : true)) &&
    (!q || Object.values(x.names || { n: x.name }).some(n => String(n).toLowerCase().includes(q)) || x.key.includes(q)));
  $('#stratCount').textContent = '★ ' + s.allStrategies.filter(x => s.favorites.includes(x.key)).length;
  document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === stratFilter));
  $('#strats').innerHTML = list.map(x => `<div class="strat${openStrats.has(x.key) ? ' open' : ''}">
    <div class="strat-head"><input type="checkbox" class="sw" data-strat="${x.key}" ${s.strategies.includes(x.key) ? 'checked' : ''}>
      <button class="favstar on" data-favstrat="${x.key}" title="${t('fav_remove')}">★</button>
      <button class="strat-name" data-open="${x.key}">${esc(tr(x.names || x.name))}<small>${x.tfs.join(' · ')} · ${x.key === 'n_sharp' ? [x.params.sharp_on_trend ? t('follow') : '', x.params.sharp_on_rev !== false ? t('reversal') : ''].filter(Boolean).join(' + ') || '—' : x.type === 'rev' ? (x.params.follow_move ? t('follow') : t('reversal')) : t('trend')}</small></button>
      <button class="strat-arrow" data-open="${x.key}">${openStrats.has(x.key) ? '▴' : '▾'}</button></div>
    <div class="strat-body">
      <div class="tfs">${TFS.map(t => `<label><input type="checkbox" data-tf="${x.key}" value="${t}" ${x.tfs.includes(t) ? 'checked' : ''}><span>${t}</span></label>`).join('')}</div>
      <label class="prow"><span>🔔 ${t('sound_pick')}</span><select data-sound="${x.key}">${(window.SOUND_KEYS || []).map(k => `<option value="${k}"${soundOf(x.key) === k ? ' selected' : ''}>${t('snd_' + k)}</option>`).join('')}</select></label>
      ${(x.presets || []).length && !(x.key === 'n_sharp' && x.params.sharp_on_rev === false) ? `<div class="presets"><small>${t('presets')} · ${t('presets_multi')}</small>${x.presets.map((pr, n) =>
        `<button class="chip${(x.activePresets || []).includes(n) ? ' active' : ''}" data-preset="${x.key}" data-pn="${n}">${(x.activePresets || []).includes(n) ? '✓ ' : ''}${n + 1} · ${esc(tr(pr.name))}</button>`).join('')}</div>` : ''}
      ${x.key === 'n_sharp' && x.params.sharp_on_rev === false ? '' : testTable(x)}
      ${modeSpoilers(x)}${paramRows(x)}
      <button class="btn ghost wide" data-reset="${x.key}">${t('defaults')}</button>
    </div></div>`).join('') || `<p class="empty">${t('fav_empty')}</p>`;
}

// Countdown + progress until entry, then until expiry. Also used when a card is (re)built,
// so the text is never empty between two ticks.
function timerText(entry, exp) {
  const now = Date.now() / 1000, x = entry + exp;
  return now < entry ? t('entry_in', { s: Math.ceil(entry - now) }) : now < x ? t('running', { s: Math.ceil(x - now) }) : t('finished');
}
function timeProgress(entry, exp, created) {
  const now = Date.now() / 1000, x = entry + exp, c = Math.min(created, entry - 1), run = now >= entry;
  const pct = run ? (now - entry) / (x - entry) : (now - c) / (entry - c);
  return { run, pct: Math.max(0, Math.min(100, pct * 100)) };
}
setInterval(() => {
  renderLive(); // shows the finished state and removes signals 10 s after expiry
  document.querySelectorAll('.timer').forEach(el => { el.textContent = timerText(+el.dataset.entry, +el.dataset.exp); });
  document.querySelectorAll('.timebar').forEach(el => {
    const p = timeProgress(+el.dataset.entry, +el.dataset.exp, +el.dataset.created);
    el.classList.toggle('run', p.run);
    el.firstChild.style.width = p.pct + '%';
  });
  const iv = (state && state.settings.scan_interval) || 60;
  const ns = $('#nextScan'); if (ns) ns.textContent = t('next_scan', { s: iv - (new Date().getSeconds() % iv) });
}, 500);
setInterval(render, 20000);

function openUrl(url) {
  if (isDesktop) window.desktop.openExternal(url);
  else if (isAndroid) window.AndroidApp.openTradingView(url);
  else window.open(url, '_blank');
}

// tf: also open the chart with this timeframe (click on the timeframe tag of a signal).
// exp: expiry in seconds to set in the trading panel (PO button = 1 min default, recommendation button = its value).
// Card button ⚡ (user, 08.11.2026): first tap arms it ("Sure?") for 4 s, the second opens the trade in PocketOption
// (pair, expiry, then its own Buy/Sell button). A signal whose entry is more than 20 s ago is not traded.
let quickArm = { id: null, until: 0 }; // kept outside the card: cards are redrawn on every scan
const quickArmed = id => quickArm.id === id && Date.now() < quickArm.until;
function quickTrade(el) {
  const s = state.signals.find(x => x.id === el.dataset.quick); if (!s) return;
  if (!quickArmed(s.id)) {
    quickArm = { id: s.id, until: Date.now() + 4000 };
    el.classList.add('armed'); el.querySelector('small').textContent = '⚡ ' + t('quick_sure');
    setTimeout(() => { const b = document.querySelector(`[data-quick="${CSS.escape(s.id)}"]`); if (b && !quickArmed(s.id)) { b.classList.remove('armed'); b.querySelector('small').textContent = '⚡ ' + s.dir; } }, 4050);
    return;
  }
  quickArm = { id: null, until: 0 };
  el.classList.remove('armed');
  if (Date.now() / 1000 - s.entryTime > 20) { toast(t('quick_late')); return; }
  toast(t('quick_on'));
  openPO(s.id, undefined, false, s.expiry, s.dir);
}

// Direction badge over the PocketOption chart (Android). Short (user: the badge was too big): arrow, direction, expiry.
function dirBadge(sig, exp) {
  if (!sig || !window.AndroidApp || !window.AndroidApp.setDirBadge) return;
  const up = sig.dir === 'CALL' || sig.dir > 0, e = Number(exp || sig.expiry) || 0;
  try { window.AndroidApp.setDirBadge(`${up ? '▲ CALL' : '▼ PUT'}${e ? ' ' + fmtExp(e) : ''}`, up, (e || 300) + 60); } catch {}
}
// Opened from the notification's PocketOption button (user 14.11.2026: the badge was missing on some pairs):
// the newest signal of that pair from the last 10 minutes.
window.__dirBadgeFor = sym => {
  const s = (state && state.signals || []).filter(x => x.symbol === sym && Date.now() - x.created < 600000).sort((a, b) => b.created - a.created)[0];
  dirBadge(s);
};
// Radar of active pairs (user 20.11.2026): folded block, own − / + settings, a row opens the pair in Pocket Option.
// Signal cards on/off (user 21.11.2026): to watch only the radar. Per viewer, kept in localStorage.
let cardsOff = (() => { try { return localStorage.getItem('cardsOff') === '1'; } catch { return false; } })();
function applyCards() { document.body.classList.toggle('nocards', cardsOff); const b = document.getElementById('cardsTgl');
  if (b) { b.textContent = (cardsOff ? '☐ ' : '☑ ') + (LANG === 'ru' ? 'Карточки' : LANG === 'de' ? 'Karten' : 'Cards'); b.classList.toggle('active', !cardsOff); } }
document.addEventListener('click', e => { if (!e.target.closest('#cardsTgl')) return; e.preventDefault(); cardsOff = !cardsOff;
  try { localStorage.setItem('cardsOff', cardsOff ? '1' : '0'); } catch {} applyCards();
  call({ action: 'settings', patch: { cards_off: cardsOff } }); }); // engine: no strategy scanning while cards are off (21.11.2026)
// Once after start: tell the engine the stored choice (it is kept per viewer in localStorage).
let cardsSynced = false;
function syncCards() { if (cardsSynced || typeof call !== 'function') return; cardsSynced = true; call({ action: 'settings', patch: { cards_off: cardsOff } }); }
let radarTab = (() => { try { return localStorage.getItem('radarTab') || 'pairs'; } catch { return 'pairs'; } })();
let patSetOpen = false;
// One "⚙ Settings" button in the radar header (user 21.11.2026): all radar settings and hints hidden until pressed.
let radarCfg = false;
document.addEventListener('click', e => { const b = e.target.closest('[data-rcfg]'); if (!b) return; e.preventDefault(); e.stopPropagation();
  const k = b.dataset.rcfg; if (k === 'pairs' || k === 'pat') { if (radarTab !== k) { radarTab = k; radarCfg = true; try { localStorage.setItem('radarTab', k); } catch {} } else radarCfg = !radarCfg; } else radarCfg = !radarCfg;
  if (!radarCfg) patSetOpen = false; const d = document.querySelector('.pradar'); if (d && !d.open) { d.open = true; radarOpen = true; } renderRadar(true); }, true);
let psetOpen = (() => { try { return localStorage.getItem('psetOpen') === '1'; } catch { return false; } })();
const pTg = (k, on) => `<button type="button" class="ptg${on ? ' on' : ''}" data-ptg="${k}">${on ? (LANG === 'ru' ? 'вкл' : 'on') : (LANG === 'ru' ? 'выкл' : 'off')}</button>`;
document.addEventListener('click', e => {
  const b = e.target.closest('[data-ptg]'); if (!b || !state.patRadar) return; e.preventDefault(); e.stopPropagation();
  const k = b.dataset.ptg, v = !b.classList.contains('on'); call({ action: 'settings', patch: { [k]: v } });
  if (k === 'radar_alert') { state.radar = { ...state.radar, alert: v }; renderRadar(true); return; }
  state.patRadar = { ...state.patRadar, [k === 'pat_atr_on' ? 'atrOn' : k === 'pat_pre' ? 'pre' : k === 'tw_trend_on' ? 'twOn' : k === 'pat_sold_rev' ? 'soldRev' : k === 'pat_alert' ? 'alert' : 'adxOn']: v }; renderRadar(true);
}, true);
// 22.11.2026 (user): a new pattern gives a signal like the strategies – sound + notification (switch + own sound in its settings).
// Only patterns that appeared within the last 90 s and were not in the list before; the first list after start is not announced.
let patSeen = null;
// Auto switch of the PO chart from the radar / patterns (user 23.11.2026), each with its own ⇄ button.
// Several new at once: the pattern that agrees most with the chart – ★ favourite, pattern direction = M5 trend and
// = M15 trend, ADX ≥ 25 (a trend is there), then payout. This is an order of preference, not a win probability.
function patScore(p) {
  return (p.fav ? 4 : 0) + (p.trend === p.dir ? 2 : 0) + (p.trend15 === p.dir ? 2 : 0) + ((p.adx || 0) >= 25 ? 1 : 0) + (p.payout || 0) / 1000;
}
let lastPairAuto = 0;
function autoOpenPair(sym, badge, up) {
  if (Date.now() - lastPairAuto < 10000 || Date.now() - (typeof lastAuto === 'number' ? lastAuto : 0) < 10000) return; // not more often than every 10 s, and not right after a signal switched it
  if (!(isDesktop || isAndroid)) return; lastPairAuto = Date.now(); radarPoSym = sym;
  call({ action: 'openPO', symbol: sym, tf: 'M1', lang: LANG }).then(x => {
    if (isAndroid && window.AndroidApp) { if (badge && window.AndroidApp.setDirBadge) { try { window.AndroidApp.setDirBadge(badge, !!up, 240); } catch {} } poOpen((x && x.name) || sym, (x && x.symbol) || sym, 'M1'); return; }
    if (x && x.name && typeof toast === 'function') toast('⇄ ' + t('toast_po', { name: x.name }) + ' · M1');
  });
}
function patAlerts(PR) {
  if (!PR || !Array.isArray(PR.list)) return;
  const keys = PR.list.map(p => `${p.symbol}|${p.id}|${p.time}`);
  if (!patSeen) { patSeen = new Set(keys); return; }
  // No own clock check (phone clock vs PocketOption clock may differ): the engine already lists only patterns whose entry
  // is still on time (<= 1 min), so every pattern new to the list rings (22.11.2026).
  const fresh = PR.list.filter((p, i) => !patSeen.has(keys[i]));
  keys.forEach(k => patSeen.add(k)); if (patSeen.size > 3000) patSeen = new Set(keys);
  if (PR.auto && fresh.length) { const b = fresh.slice().sort((x, y) => patScore(y) - patScore(x))[0]; autoOpenPair(b.symbol, `${b.dir === 'up' ? '▲' : '▼'} ${LANG === 'ru' ? b.ru : b.en} · ${LANG === 'ru' ? 'свеча' : 'candle'} ${new Date(b.time * 1000).toTimeString().slice(0, 5)}`, b.dir === 'up'); }
  if (!PR.alert || !fresh.length) return;
  const p = fresh[0], ru = LANG === 'ru', snd = PR.sound || 'bell';
  const title = `${p.name} ${p.dir === 'up' ? '▲ CALL' : '▼ PUT'}`;
  const body = `${ru ? 'Паттерн' : LANG === 'de' ? 'Muster' : 'Pattern'}:${ru ? p.ru : p.en}${fresh.length > 1 ? ` (+${fresh.length - 1})` : ''}`;
  ringAlert(title, body, p, snd);
}
// Sound played by the app itself (phone: native player – works even if the notification channel is muted), then a
// silent notification on the phone so it also shows in the shade.
function ringAlert(title, body, p, snd) {
  try { call({ action: 'polog', text: `🔔 ${title} – ${body} (Ton ${snd})` }); } catch {} // proof in the connection log that it rang
  if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
  beep(snd);
  if (isAndroid && window.AndroidApp.notifySound) window.AndroidApp.notifySound(title, body, p.name, p.symbol, '', window.AndroidApp.playSound ? 'none' : snd);
  else if (isAndroid) window.AndroidApp.notify(title, body, p.name, p.symbol, '');
  else if (window.Notification && Notification.permission === 'granted' && document.hidden) new Notification(title, { body, icon: 'icon.png' });
}
// 22.11.2026 (user): the pairs radar rings too (own switch + sound): a pair that newly entered the list, active < 90 s.
let radSeen = null;
function radarAlerts(R) {
  if (!R || !Array.isArray(R.list)) return;
  const keys = R.list.map(p => `${p.symbol}|${p.since}`);
  if (!radSeen) { radSeen = new Set(keys); return; }
  const fresh = R.list.filter((p, i) => !radSeen.has(keys[i]) && Date.now() / 1000 - p.since < 180);
  keys.forEach(k => radSeen.add(k)); if (radSeen.size > 3000) radSeen = new Set(keys);
  if (R.auto && fresh.length) { const b = fresh.slice().sort((x, y) => y.big - x.big || y.size - x.size || (y.payout || 0) - (x.payout || 0))[0]; autoOpenPair(b.symbol, '', b.dir === 'up'); }
  if (!R.alert || !fresh.length) return;
  const p = fresh[0], ru = LANG === 'ru';
  const title = `${p.name} ${p.dir === 'up' ? '▲' : p.dir === 'down' ? '▼' : ''}`;
  const body = `${ru ? 'Радар: пара стала активной' : LANG === 'de' ? 'Radar: Paar wurde aktiv' : 'Radar: pair became active'} (${p.big}/${p.n})${fresh.length > 1 ? ` (+${fresh.length - 1})` : ''}`;
  ringAlert(title, body, p, R.sound || 'double');
}
document.addEventListener('click', e => { const b = e.target.closest('[data-ptf]'); if (!b || !state.patRadar) return; e.preventDefault(); e.stopPropagation();
  const v = +b.dataset.ptf; call({ action: 'settings', patch: { pat_tf: v } }); state.patRadar = { ...state.patRadar, tf: v, list: [] }; patSeen = null; renderRadar(true); }, true);
document.addEventListener('change', e => {
  const el = e.target; if (!el.dataset) return;
  if (el.dataset.twtf !== undefined) { const v = +el.value; call({ action: 'settings', patch: { tw_trend_tf: v } }); if (state.patRadar) state.patRadar = { ...state.patRadar, twTf: v }; }
  if (el.dataset.psound || el.dataset.rsound) { window.__selChangedAt = Date.now(); setTimeout(() => { try { el.blur(); renderRadar(true); } catch {} }, 50); }
  if (el.dataset.psound) { call({ action: 'settings', patch: { pat_sound: el.value } }); beep(el.value); if (state.patRadar) state.patRadar = { ...state.patRadar, sound: el.value }; }
  if (el.dataset.rsound) { call({ action: 'settings', patch: { radar_sound: el.value } }); beep(el.value); if (state.radar) state.radar = { ...state.radar, sound: el.value }; }
});
let rsetOpen = (() => { try { return localStorage.getItem('rsetOpen') === '1'; } catch { return false; } })();
document.addEventListener('toggle', e => { const c = e.target.classList; if (!c) return;
  if (c.contains('psfold')) { psetOpen = e.target.open; try { localStorage.setItem('psetOpen', psetOpen ? '1' : '0'); } catch {} return; }
  if (c.contains('rsfold')) { rsetOpen = e.target.open; try { localStorage.setItem('rsetOpen', rsetOpen ? '1' : '0'); } catch {} return; }
  if (c.contains('pfold')) { patSetOpen = e.target.open; patSetAt = Date.now(); } }, true);
document.addEventListener('click', e => { if (e.target.closest && e.target.closest('#radar .pset')) patSetAt = Date.now(); }, true);
document.addEventListener('click', e => {
  const tb = e.target.closest('[data-rtab]'); if (!tb) return; e.preventDefault();
  radarTab = tb.dataset.rtab; try { localStorage.setItem('radarTab', radarTab); } catch {} const dd = document.querySelector('.pradar'); if (dd && !dd.open) { dd.open = true; radarOpen = true; try { localStorage.setItem('radarOpen', '1'); } catch {} } renderRadar(true);
});
document.addEventListener('click', e => {
  const st = e.target.closest('[data-pfav]'); if (!st || !state.patRadar) return; e.preventDefault(); e.stopPropagation();
  const f = new Set(state.patRadar.fav || []); f.has(st.dataset.pfav) ? f.delete(st.dataset.pfav) : f.add(st.dataset.pfav);
  const v = state.patRadar.all.map(p => p.id).filter(id => f.has(id));
  const list = state.patRadar.list.map(p => ({ ...p, fav: f.has(p.id) })).sort((p, q) => (q.fav ? 1 : 0) - (p.fav ? 1 : 0) || q.time - p.time);
  state.patRadar = { ...state.patRadar, fav: v, list };
  call({ action: 'settings', patch: { pat_fav: v } }); renderRadar(true);
}, true);
document.addEventListener('change', e => {
  const cb = e.target.closest('[data-pid]'); if (!cb || !state.patRadar) return;
  const ids = new Set(state.patRadar.ids); cb.checked ? ids.add(cb.dataset.pid) : ids.delete(cb.dataset.pid);
  const v = state.patRadar.all.map(p => p.id).filter(id => ids.has(id));
  state.patRadar = { ...state.patRadar, ids: v, list: state.patRadar.list.filter(p => ids.has(p.id)) };
  call({ action: 'settings', patch: { pat_ids: v } }); renderRadar(true);
});
let radarOpen = (() => { try { return localStorage.getItem('radarOpen') === '1'; } catch { return false; } })();
// 21.11.2026 (user): the radar must not jump while scrolling or ticking patterns. No refresh while the pattern list
// is open or the pointer is over the radar (unless the user clicked something there); scroll positions are kept.
let radarHover = false;
document.addEventListener('click', e => { const b = e.target.closest('[data-rauto]'); if (!b || !state) return; e.preventDefault(); e.stopPropagation();
  const k = b.dataset.rauto, v = !b.classList.contains('on'); call({ action: 'settings', patch: { [k]: v } });
  if (k === 'radar_auto') state.radar = { ...state.radar, auto: v }; else state.patRadar = { ...state.patRadar, auto: v };
  if (typeof toast === 'function') toast((v ? '⇄ ' : '') + (k === 'radar_auto' ? (LANG === 'ru' ? 'Радар' : 'Radar') : (LANG === 'ru' ? 'Паттерны' : 'Patterns')) + (LANG === 'ru' ? (v ? ': автопереключение графика включено' : ': автопереключение выключено') : (v ? ': auto switch on' : ': auto switch off')));
  renderRadar(true); }, true);
document.addEventListener('click', e => { const b = e.target.closest('[data-pwr]'); if (!b || !state) return; e.preventDefault(); e.stopPropagation();
  const k = b.dataset.pwr, v = !b.classList.contains('on'); call({ action: 'settings', patch: { [k]: v } });
  if (k === 'radar_on') state.radar = { ...state.radar, on: v, list: v ? state.radar.list : [] }; else state.patRadar = { ...state.patRadar, on: v, list: v ? state.patRadar.list : [] };
  if (k === 'pat_on') patSeen = null; else radSeen = null; renderRadar(true); }, true);
let radarPoSym = null; // pair last opened in Pocket Option from the app (radar or a card)
// 22.11.2026 (user: a 7-minute-old pattern stayed on the phone): a touch has no "leave", so after one tap the radar stayed
// frozen for good. Only a mouse pauses the redraw now, and never longer than 4 s after the last movement.
let radarHoverAt = 0;
document.addEventListener('pointerover', e => { radarHover = e.pointerType === 'mouse' && !!(e.target.closest && e.target.closest('#radar')); radarHoverAt = Date.now(); });
document.addEventListener('pointermove', e => { if (radarHover) radarHoverAt = Date.now(); }, { passive: true });
let patSetAt = 0;
function radarWrite(el, html, force) {
  if (el.dataset.html === html) return;
  // Pause only briefly (mouse over the list, or the pattern check list just touched); the list never stays frozen.
  if (!force && el.dataset.html && ((radarHover && Date.now() - radarHoverAt < 4000) || (patSetOpen && Date.now() - patSetAt < 8000))) return;
  // 23.11.2026 (user: the sound choice jumped back): never redraw while a select of the radar is open (phone picker),
  // and not for 1 s after it changed – the redraw destroyed the open picker with the user's choice.
  const ae = document.activeElement;
  if (ae && ae.tagName === 'SELECT' && el.contains(ae)) return;
  if (Date.now() - (window.__selChangedAt || 0) < 1000 && !force) return;
  const keep = [...el.querySelectorAll('.rlist, .pset')].map(x => x.scrollTop);
  el.innerHTML = html; el.dataset.html = html;
  el.querySelectorAll('.rlist, .pset').forEach((x, i) => { if (keep[i] != null) x.scrollTop = keep[i]; });
}
// 21.11.2026 (user): pattern age instead of the history win rate – ticks every second (pattern appeared when its candle closed).
// Mini chart in a pattern row (22.11.2026): the last candles; a thin arrow at the pattern candle – up = green under it,
// down = red above it. Drawn by the app itself, so the arrow is always on the right candle.
function patChart(p) {
  const k = p.k; if (!Array.isArray(k) || k.length < 3 || !(p.ki >= 0)) return '';
  const W = 240, H = 100, P = 9, n = k.length, cw = (W - 4) / n; let lo = Infinity, hi = -Infinity; // 22.11.2026: taller so candle sizes can be compared
  for (const q of k) { lo = Math.min(lo, q[2]); hi = Math.max(hi, q[1]); }
  const sp = hi - lo || 1, y = v => (P + (hi - v) / sp * (H - 2 * P)).toFixed(1); let s = '';
  k.forEach((q, i) => { const [o, h, l, c] = q, x = 2 + i * cw + cw / 2, col = c >= o ? '#22c55e' : '#ef4444', t = y(Math.max(o, c)), bh = Math.max(1, y(Math.min(o, c)) - t);
    s += `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${y(h)}" y2="${y(l)}" stroke="${col}" stroke-width="1"/><rect x="${(x - cw * 0.35).toFixed(1)}" y="${t}" width="${(cw * 0.7).toFixed(1)}" height="${bh.toFixed(1)}" fill="${col}" opacity="${i === p.ki ? 1 : 0.55}"/>`; });
  const q = k[p.ki], x = (2 + p.ki * cw + cw / 2).toFixed(1), up = p.dir === 'up', ac = up ? '#22c55e' : '#ef4444';
  const a = up ? [H - 0.5, +y(q[2]) + 1.5] : [0.5, +y(q[1]) - 1.5]; // tail → tip (tip next to the candle)
  const hd = up ? `${x - 2.5},${a[1] + 3} ${x},${a[1]} ${+x + 2.5},${a[1] + 3}` : `${x - 2.5},${a[1] - 3} ${x},${a[1]} ${+x + 2.5},${a[1] - 3}`;
  s += `<line x1="${x}" x2="${x}" y1="${a[0]}" y2="${a[1]}" stroke="${ac}" stroke-width="1.2"/><polyline points="${hd}" fill="none" stroke="${ac}" stroke-width="1.2"/>`;
  return `<svg class="pchart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${s}</svg>`;
}
function patAge(t) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - (Number(t) + 60)));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
setInterval(() => document.querySelectorAll('#radar .page[data-pt]').forEach(x => { x.textContent = patAge(x.dataset.pt); }), 1000);
function renderRadar(force) {
  if (state) { patAlerts(state.patRadar); radarAlerts(state.radar); }
  const el = document.getElementById('radar'), R = state && state.radar; if (!el || !R) return;
  const ru = LANG === 'ru', de = LANG === 'de';
  const T = (r, d, e) => ru ? r : de ? d : e;
  const step = (key, v, st, min) => `<span class="numbox"><button type="button" class="nb" data-rk="${key}" data-rs="${-st}" data-rm="${min}">−</button><b class="rv">${String(v).replace('.', ',')}</b><button type="button" class="nb" data-rk="${key}" data-rs="${st}" data-rm="${min}">+</button></span>`;
  const rows = R.list.map(p => `<button class="rrow" data-rsym="${esc(p.symbol)}"><b>${esc(p.name)}</b><span class="${p.dir}">${p.dir === 'up' ? '▲' : p.dir === 'down' ? '▼' : '•'}${p.trend ? `<em class="rtr ${p.trend}" title="${T('тренд M', 'Trend M', 'trend M')}${R.ttf || 5}">${p.trend === 'up' ? '▲' : p.trend === 'down' ? '▼' : '◆'}<sub>${R.ttf || 5}</sub></em>` : ''}${p.trend15 ? `<em class="rtr ${p.trend15}">${p.trend15 === 'up' ? '▲' : p.trend15 === 'down' ? '▼' : '◆'}<sub>15</sub></em>` : ''}</span><small>${p.since ? `⏱ <i class="page" data-pt="${p.since - 60}">${patAge(p.since - 60)}</i> · ` : ''}${T(`${p.big}/${p.n} кр ·${String(p.size).replace('.', ',')}× об`, `${p.big}/${p.n} gr · ${String(p.size).replace('.', ',')}× n`, `${p.big}/${p.n} big · ${p.size}× us`)}${p.atr ? ' · ATR ' + String(p.atr).replace('.', ',') : ''}${p.payout ? ' · ' + p.payout + ' %' : ''}</small></button>`).join('');
  const PR = state.patRadar || { list: [], all: [], ids: [] };
  // Settings row above the tabs (user 21.11.2026): name of the open tab + small arrow, like the radar header; no extra words.
  const cfgRow = `<button type="button" class="rcfgrow${radarCfg ? ' on' : ''}" data-rcfg="1">${radarTab === 'pat' ? T('Паттерны', 'Muster', 'Patterns') : T('Активные пары', 'Aktive Paare', 'Active pairs')}</button>`;
  // 21.11.2026 (user): header = "РАДАР N ⚙" (the active pairs) and "ПАТТЕРНЫ N ⚙" side by side; the ▾ arrow folds the radar,
  // a name switches the list, ⚙ opens that list's settings. No separate tab buttons or "Активные пары" line.
  const gear = k => `<button type="button" class="rgear${radarCfg && radarTab === k ? ' on' : ''}" data-rcfg="${k}" title="${T('Настройки', 'Einstellungen', 'Settings')}">⚙</button>`;
  // 22.11.2026 (user): each part has its own on/off (⏻ green = on); off = the engine does not compute it at all.
  const autoB = (k, on) => `<button type="button" class="rauto${on ? ' on' : ''}" data-rauto="${k}" title="${T('Автопереключение графика PO на новый', 'Auto-Wechsel des PO-Charts', 'Auto switch the PO chart')}">⇄</button>`;
  const pwr = (k, on) => `<button type="button" class="rpwr${on ? ' on' : ''}" data-pwr="${k}" title="${on ? T('Выключить', 'Ausschalten', 'Switch off') : T('Включить', 'Einschalten', 'Switch on')}">⏻</button>`;
  const rhead = `<summary><button type="button" class="rhead${radarTab === 'pairs' ? ' on' : ''}${R.on === false ? ' off' : ''}" data-rtab="pairs">${T('Радар', 'Radar', 'Radar')} <span class="cnt">${R.on === false ? '–' : R.list.length}</span></button>${pwr('radar_on', R.on !== false)}${autoB('radar_auto', !!R.auto)}${gear('pairs')}<i class="rbr"></i><button type="button" class="rhead${radarTab === 'pat' ? ' on' : ''}${PR.on === false ? ' off' : ''}" data-rtab="pat">${T('Паттерны', 'Muster', 'Patterns')} <span class="cnt">${PR.on === false ? '–' : PR.list.length}</span></button>${pwr('pat_on', PR.on !== false)}${autoB('pat_auto', !!PR.auto)}${gear('pat')}</summary>`;
  const tabs = `<div class="rtabs"><button type="button" data-rtab="pairs" class="${radarTab === 'pairs' ? 'on' : ''}">${T('Активные пары', 'Aktive Paare', 'Active pairs')} ${R.list.length}</button><button type="button" data-rtab="pat" class="${radarTab === 'pat' ? 'on' : ''}">${T('Паттерны', 'Muster', 'Patterns')} ${PR.list.length}</button></div>`;
  if (radarTab === 'pat') {
    const nm = p => ru ? p.ru : p.en;
    const prow = PR.list.map(p => `<button class="rrow${p.fav ? ' fav' : ''}" data-rsym="${esc(p.symbol)}" data-pbadge="${esc(`${p.dir === 'up' ? '▲' : '▼'} ${ru ? p.ru : p.en} · ${ru ? 'свеча' : 'candle'} ${new Date((p.time) * 1000).toTimeString().slice(0, 5)}`)}" data-pup="${p.dir === 'up' ? 1 : 0}"><b>${p.fav ? '★ ' : ''}${esc(p.name)} <span class="pnm">${p.pre ? `⏳ ${T('складывается', 'bildet sich', 'forming')} ${p.sleft} с · ` : ''}${esc(nm(p))}</span></b><span class="${p.dir}">${p.dir === 'up' ? '▲' : '▼'}${p.trend ? `<em class="rtr ${p.trend}">${p.trend === 'up' ? '▲' : p.trend === 'down' ? '▼' : '◆'}<sub>${R.ttf || 5}</sub></em>` : ''}${p.trend15 ? `<em class="rtr ${p.trend15}">${p.trend15 === 'up' ? '▲' : p.trend15 === 'down' ? '▼' : '◆'}<sub>15</sub></em>` : ''}</span><small>${p.tf > 1 ? `M${p.tf} · ` : ''}⏱ <i class="page" data-pt="${(p.at || p.time + 60) - 60}">${patAge((p.at || p.time + 60) - 60)}</i>${p.atr ? ' · ATR ' + String(p.atr).replace('.', ',') : ''}${p.adx ? ' · ADX ' + p.adx : ''}${p.payout ? ' · ' + p.payout + ' %' : ''}</small>${patChart(p)}</button>`).join('');
    const G = { c: T('Свечные', 'Kerzen', 'Candles'), g: T('Графические', 'Chartmuster', 'Chart'), v: T('Волатильность и индикаторы', 'Volatilität', 'Volatility') };
    const chk = ['c', 'g', 'v'].map(g => `<b class="pg">${G[g]}</b>` + PR.all.filter(p => p.g === g).map(p => `<label class="pchk"><button type="button" class="pstar${(PR.fav || []).includes(p.id) ? ' on' : ''}" data-pfav="${p.id}">${(PR.fav || []).includes(p.id) ? '★' : '☆'}</button><input type="checkbox" data-pid="${p.id}"${PR.ids.includes(p.id) ? ' checked' : ''}> ${esc(nm(p))}</label>`).join('')).join('');
    const html = `<details class="setfold pradar"${radarOpen ? ' open' : ''}>${rhead}
    ${radarCfg ? `<div class="rcfg"><div class="rset"><label>${T('Таймфрейм паттернов', 'Muster-Zeitrahmen', 'Pattern timeframe')} ${[1, 2, 3, 4, 5].map(m => `<button type="button" class="ptg${(PR.tf || 1) === m ? ' on' : ''}" data-ptf="${m}">M${m}</button>`).join('')}</label><small class="pnote">${T('Сигнал — на закрытии свечи этого таймфрейма; вход актуален одну такую свечу.', 'Signal beim Schluss einer Kerze dieses Zeitrahmens; Einstieg gilt eine Kerze lang.', 'Signal at the close of a candle of this timeframe; entry valid for one such candle.')}</small><div class="selrow pselrow"><span>${T('Чистота, мин. %', 'Sauberkeit, min. %', 'Cleanliness, min %')}</span><button type="button" data-psel="pat_clean_min" data-d="-5">−</button><b>${PR.cleanMin || T('выкл', 'aus', 'off')}</b><button type="button" data-psel="pat_clean_min" data-d="5">+</button></div><div class="selrow pselrow"><span>${T('Чистота: свечей M1', 'Sauberkeit: M1-Kerzen', 'Cleanliness: M1 candles')}</span><button type="button" data-psel="pat_clean_n" data-d="-1">−</button><b>${PR.cleanN || 10}</b><button type="button" data-psel="pat_clean_n" data-d="1">+</button></div><div class="selrow pselrow"><span>${T('Паттернов в час, макс.', 'Muster pro Stunde, max.', 'Patterns per hour, max')}</span><button type="button" data-psel="pat_per_hour" data-d="-5">−</button><b>${PR.perHour || '∞'}</b><button type="button" data-psel="pat_per_hour" data-d="5">+</button></div><small class="pnote">${T('Чистота — насколько прямо шла цена перед паттерном (100 % = все свечи одного цвета, около 0 % = пила); ниже порога паттерн не показывается и не звенит. Лимит в час — сколько новых паттернов может появиться за 60 минут; 0 (∞) = без лимита.', 'Sauberkeit = wie gerade der Kurs vor dem Muster lief; Limit = neue Muster pro 60 min, 0 = ohne.', 'Cleanliness = how straight price went before the pattern; limit = new patterns per 60 min, 0 = none.')}</small><label>${pTg('pat_alert', PR.alert)} ${T('Сигнал о новом паттерне', 'Signal bei neuem Muster', 'Signal on a new pattern')} <select data-psound>${(window.SOUND_KEYS || ['default']).map(k => `<option value="${k}"${k === (PR.sound || 'bell') ? ' selected' : ''}>${t('snd_' + k)}</option>`).join('')}</select></label></div><details class="pfold psfold"${psetOpen ? ' open' : ''}><summary>${T('Фильтры ATR и ADX', 'ATR- und ADX-Filter', 'ATR and ADX filters')} (ATR ${PR.atrOn ? '≥' + String(PR.atrMin).replace('.', ',') + ' %' : T('выкл', 'aus', 'off')} · ADX ${PR.adxOn ? '≥' + PR.adxMin : T('выкл', 'aus', 'off')})</summary><div class="rset">
      <label>${pTg('pat_atr_on', PR.atrOn)} ${T('ATR не меньше, % от цены', 'ATR mindestens, % vom Preis', 'ATR at least, % of price')} ${step('pat_atr', PR.atrMin, 0.005, 0)}</label>
      <label>${pTg('pat_pre', !!PR.pre)} ${T('Ранний сигнал (эксперимент): до закрытия свечи — 15 с на M1, 1 мин на M5. Может не подтвердиться', 'Früher Hinweis (Experiment) vor Kerzenschluss – kann ausbleiben', 'Early warning (experiment) before the candle closes – may not confirm')}</label>
      <label>${pTg('tw_trend_on', !!PR.twOn)} ${T('Пинцет только по тренду', 'Pinzette nur mit dem Trend', 'Tweezers only with the trend')} <select class="twtf" data-twtf>${[2, 3, 4, 5, 10, 15].map(m => `<option value="${m}"${(PR.twTf || 5) === m ? ' selected' : ''}>M${m}</option>`).join('')}</select></label>
      <label>${T('Три солдата: импульсная свеча — тело от … ATR', 'Drei Soldaten: Impulskerze – Körper ab … ATR', 'Three soldiers: impulse candle – body from … ATR')} ${step('pat_sold_atr', PR.soldAtr != null ? PR.soldAtr : 1, 0.1, 0.1)}</label>
      <label>${T('Три солдата: импульсных из трёх, минимум', 'Drei Soldaten: Impulskerzen von drei, mindestens', 'Three soldiers: impulse candles of three, at least')} ${step('pat_sold_big', PR.soldBig || 1, 1, 1)}</label>
      <label>${pTg('pat_sold_rev', !!PR.soldRev)} ${T('Три солдата: сигнал на разворот (выкл = по движению)', 'Drei Soldaten: Umkehrsignal (aus = mit der Bewegung)', 'Three soldiers: reversal signal (off = with the move)')}</label>
      <label>${pTg('pat_adx_on', PR.adxOn)} ${T('ADX не меньше (сила тренда M1)', 'ADX mindestens (Trendstärke M1)', 'ADX at least (M1 trend strength)')} ${step('pat_adx', PR.adxMin, 1, 0)}</label>
      <small class="pnote">${T('ATR — размер свечей (живость пары). ADX — есть ли движение: до 20 флэт, 20–25 начало тренда, от 25 тренд, от 40 сильный. Подсказка по ATR — в «Активных парах».', 'ATR = candle size. ADX: below 20 flat, 20–25 starting trend, above 25 trend, above 40 strong.', 'ATR = candle size. ADX: below 20 flat, 20–25 starting trend, above 25 trend, above 40 strong.')}</small></div></details>
    <details class="rleg"><summary>${T('Что значат стрелки', 'Was die Pfeile bedeuten', 'What the arrows mean')}</summary>${T(`Стрелки: первая — направление паттерна (куда он обещает цену); вторая с цифрой — тренд старшего ТФ (₅ = M5, выбирается в «Активных парах»). ◆ = флэт.`, 'Arrows: first = pattern direction; second with number = higher-TF trend.', 'Arrows: first = pattern direction; second with number = higher-TF trend.')}</details>
    <details class="pfold"${patSetOpen ? ' open' : ''}><summary>${T('Какие паттерны показывать', 'Welche Muster anzeigen', 'Which patterns to show')} (${PR.ids.length}/${PR.all.length})</summary><div class="pset">${chk}</div></details></div>` : ''}
    <div class="rlist">${prow || `<p class="empty">${PR.on === false ? T('Паттерны выключены — включите кнопкой ⏻ рядом с «Паттерны»', 'Muster aus – mit ⏻ einschalten', 'Patterns off – switch on with ⏻') : T('Сейчас нет действующих паттернов', 'Zurzeit keine aktiven Muster', 'No active patterns right now')}</p>`}</div></details>`;
    radarWrite(el, html, force);
    return;
  }
  const html = `<details class="setfold pradar"${radarOpen ? ' open' : ''}>${rhead}
    ${radarCfg ? `<div class="rcfg"><div class="rset"><label>${pTg('radar_alert', R.alert)} ${T('Сигнал о новой активной паре', 'Signal bei neuem aktivem Paar', 'Signal on a new active pair')} <select data-rsound>${(window.SOUND_KEYS || ['default']).map(k => `<option value="${k}"${k === (R.sound || 'double') ? ' selected' : ''}>${t('snd_' + k)}</option>`).join('')}</select></label></div><details class="rleg"><summary>${T('Что значат стрелки', 'Was die Pfeile bedeuten', 'What the arrows mean')}</summary>${T(`Стрелки: первая — куда шла цена за ${R.dn || R.n} свеч. M1; вторая с цифрой — тренд старшего ТФ (₅ = M5). ◆ = флэт.`, 'Pfeile: erster = Kursrichtung im Fenster; zweiter mit Zahl = Trend des höheren TF. ◆ = flach.', 'Arrows: first = price move in the window; second with number = higher-TF trend. ◆ = flat.')}</details>
    <details class="pfold rsfold"${rsetOpen ? ' open' : ''}><summary>${T('Настройки активных пар', 'Einstellungen aktive Paare', 'Active pairs settings')} (${R.n} / ${String(R.x).replace('.', ',')} / ${R.k}${R.pay ? ` · ≥${R.pay} %` : ''} · ${T('тренд', 'Trend', 'trend')} M${R.ttf || 5})</summary><div class="rset"><label>${T('Окно, свечей M1', 'Fenster, M1-Kerzen', 'Window, M1 candles')} ${step('radar_n', R.n, 1, 3)}</label>
    <label>${T('Крупная = тело от … обычной свечи', 'Groß = Körper ab … der normalen Kerze', 'Big = body from … of the usual candle')} ${step('radar_x', R.x, 0.1, 0.1)}</label>
    <label>${T('Крупных в окне не меньше', 'Große im Fenster mindestens', 'Big ones in the window at least')} ${step('radar_k', R.k, 1, 1)}</label>
    <label>${T('Первая стрелка: направление цены за … свечей M1', 'Erster Pfeil: Kursrichtung über … M1-Kerzen', 'First arrow: price move over … M1 candles')} ${step('radar_dn', R.dn || R.n, 1, 1)}</label>
    <label>${T('Старший таймфрейм для тренда (цифра у второй стрелки)', 'Höherer Zeitrahmen für den Trend', 'Higher timeframe for the trend')} <span class="ttfbox">${[2, 3, 4, 5, 10, 15].map(m => `<button type="button" class="ttfb${(R.ttf || 5) === m ? ' on' : ''}" data-ttf="${m}">${m}</button>`).join('')}</span></label>
    <label>${T('ATR не меньше, % от цены (0 = все)', 'ATR mindestens, % vom Preis (0 = alle)', 'ATR at least, % of price (0 = all)')} ${step('radar_atr', R.atr || 0, 0.005, 0)}</label>
    <details class="atrhelp"><summary>${T('Что значит ATR и какой ставить', 'Was ist ATR', 'What ATR means')}</summary><div>${T(`ATR — средний размер минутной свечи в % от цены. Видно в каждой строке («ATR 0,045 %»).<br>
      <b>0</b> — фильтр выключен, показываются все пары.<br>
      <b>до 0,005 %</b> — мёртвые пары: цена почти стоит, свечи-точки, ловить нечего.<br>
      <b>0,005–0,03 %</b> — неподвижные: движение слабое, выплата часто съедается шумом.<br>
      <b>0,03–0,1 %</b> — нормальные подвижные пары, обычный выбор.<br>
      <b>от 0,1 %</b> — очень подвижные: быстрые сильные свечи, больше возможностей и больше риска.<br>
      Совет: <b>0,02</b> — убрать мёртвые; <b>0,05</b> — только живые; <b>0,1</b> — только самые резкие.`, 'ATR = average M1 candle size in % of price. 0 = off; below 0.005 % dead; 0.005–0.03 % slow; 0.03–0.1 % normal; above 0.1 % very volatile.', 'ATR = average M1 candle size in % of price. 0 = off; below 0.005 % dead; 0.005–0.03 % slow; 0.03–0.1 % normal; above 0.1 % very volatile.')}</div></details>
    <label>${T('Выплата не меньше, % (0 = все)', 'Auszahlung mindestens, % (0 = alle)', 'Payout at least, % (0 = all)')} ${step('radar_pay', R.pay || 0, 5, 0)}</label></div></details></div>` : ''}
    <div class="rlist">${rows || `<p class="empty">${R.on === false ? T('Радар выключен — включите кнопкой ⏻ рядом с «Радар»', 'Radar aus – mit ⏻ einschalten', 'Radar off – switch on with ⏻') : T('Сейчас нет пар с крупными свечами по этим настройкам', 'Zurzeit keine Paare mit großen Kerzen', 'No pairs with big candles right now')}</p>`}</div></details>`;
  radarWrite(el, html, force);
}
document.addEventListener('toggle', e => { if (e.target.classList && e.target.classList.contains('pradar')) { radarOpen = e.target.open; try { localStorage.setItem('radarOpen', radarOpen ? '1' : '0'); } catch {} } }, true);
document.addEventListener('click', e => {
  const b = e.target.closest('[data-rk]');
  if (b && (b.dataset.rk === 'pat_atr' || b.dataset.rk === 'pat_adx' || b.dataset.rk === 'pat_sold_atr' || b.dataset.rk === 'pat_sold_big')) { e.preventDefault(); const k = b.dataset.rk, P = state.patRadar, f = k === 'pat_atr' ? 'atrMin' : k === 'pat_sold_atr' ? 'soldAtr' : k === 'pat_sold_big' ? 'soldBig' : 'adxMin';
    const v = k === 'pat_sold_big' ? Math.min(3, Math.max(1, (P.soldBig || 1) + +b.dataset.rs)) : Math.max(+b.dataset.rm, Math.round((P[f] + +b.dataset.rs) * 1000) / 1000); call({ action: 'settings', patch: { [k]: v } }); state.patRadar = { ...P, [f]: v }; renderRadar(true); return; }
  if (b) { e.preventDefault(); const k = b.dataset.rk, R = state.radar, cur = { radar_n: R.n, radar_x: R.x, radar_k: R.k, radar_pay: R.pay || 0, radar_atr: R.atr || 0, radar_dn: R.dn || R.n }[k], st = +b.dataset.rs;
    const v = Math.max(+b.dataset.rm, Math.round((cur + st) * 1000) / 1000); call({ action: 'settings', patch: { [k]: v } }); state.radar = { ...R, [k.slice(6)]: v }; renderRadar(true); return; }
  const tf = e.target.closest('[data-ttf]');
  if (tf) { e.preventDefault(); const v = +tf.dataset.ttf; call({ action: 'settings', patch: { radar_ttf: v } }); state.radar = { ...state.radar, ttf: v }; renderRadar(true); return; }
  const r = e.target.closest('[data-rsym]');
  // Phone: switch to the Pocket Option tab like the signal cards do (user 21.11.2026); PC: toast as before.
  // Phone, same pair as the last radar tap (user 21.11.2026): the chart already shows it – just switch to the PO tab, no reload.
  if (r && isAndroid && window.AndroidApp && window.AndroidApp.showPocketOption && radarPoSym === r.dataset.rsym) { if (r.dataset.pbadge && window.AndroidApp.setDirBadge) { try { window.AndroidApp.setDirBadge(r.dataset.pbadge, r.dataset.pup === '1', 240); } catch {} } window.AndroidApp.showPocketOption(); return; }
  if (r) radarPoSym = r.dataset.rsym;
  if (r) call({ action: 'openPO', symbol: r.dataset.rsym, tf: 'M1', lang: LANG }).then(x => {
    if (isAndroid && window.AndroidApp) { const nm = (x && x.name) || r.dataset.rsym;
      // Pattern row (22.11.2026): plaque over the PO chart with direction, pattern and candle time; a touch hides it.
      if (r.dataset.pbadge && window.AndroidApp.setDirBadge) { try { window.AndroidApp.setDirBadge(r.dataset.pbadge, r.dataset.pup === '1', 240); } catch {} }
      poOpen(nm, (x && x.symbol) || r.dataset.rsym, 'M1'); return; }
    if (x && x.name && typeof toast === 'function') toast(t('toast_po', { name: x.name }) + ' · M1'); });
});
// 22.11.2026 (user: switching the pair took a minute): the PO tab is reloaded only when the chart timeframe really changes;
// otherwise the pair is switched inside the already open page (fast). poTf = timeframe the PO page was last loaded with.
let poTf = null;
function poOpen(name, symbol, tf) {
  const A = window.AndroidApp;
  if (tf && tf !== poTf && A.openPocketOptionReload) { poTf = tf; A.openPocketOptionReload(name); }
  else A.openPocketOption(name, symbol || '');
}
async function openPO(id, tf, auto, exp, trade) {
  const sig = state.signals.find(s => s.id === id);
  radarPoSym = sig ? sig.symbol : null; // the chart now shows the card's pair
  const r = await call({ action: 'openPO', id, tf, auto: !!auto, exp: exp || 0, lang: LANG, ...(trade ? { trade } : {}) });
  const name = r.name || (sig && sig.name) || '';
  if (isDesktop) { toast(t('toast_po', { name }) + (tf ? ' · ' + tf : '')); return; }
  if (isAndroid) {
    // Direction badge over the PocketOption chart (user 14.11.2026): ▲ CALL / ▼ PUT, pair, expiry; hides after expiry + 1 min.
    dirBadge(sig, exp);
    poOpen(name, r.symbol || (sig && sig.symbol) || '', tf);
    return;
  }
  // Phone browser: the asset was saved into the account's chart, so PocketOption opens on it.
  try { await navigator.clipboard.writeText(name.replace(/ OTC$/, '')); } catch {}
  toast(r.ok ? t('toast_po_set', { name }) : t('toast_pair', { name }));
  setTimeout(() => { location.href = 'https://pocketoption.com/en/cabinet/'; }, 400);
}

function changeLang(l) {
  setLang(l);
  if (isAndroid && window.AndroidApp.setLabels) window.AndroidApp.setLabels(t('back'));
  render();
}

// − / + next to number settings: step from data-step, never below data-min (19.11.2026).
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('[data-nb]'); if (!b) return;
  const inp = b.parentElement.querySelector('input[data-num]'); if (!inp) return;
  const st = Number(inp.dataset.step) || 1, mn = Number(inp.dataset.min) || 0, cur = parseNum(inp.value);
  const nv = Math.max(mn, Math.round(((Number.isFinite(cur) ? cur : mn) + st * Number(b.dataset.nb)) * 1000) / 1000);
  inp.value = nv; inp.dispatchEvent(new Event('change', { bubbles: true }));
});
document.addEventListener('click', e => {
  // Mini view: a star toggles the pin; a click anywhere else on it opens the full window.
  if (document.body.classList.contains('compact')) {
    const star = e.target.closest('[data-pin]'), tfBtn = e.target.closest('[data-potf]');
    if (star) togglePin(star.dataset.pin);
    else if (tfBtn) openPO(tfBtn.dataset.po, tfBtn.dataset.potf);
    else if (e.target.closest('[data-expand]') && window.desktop.expand) window.desktop.expand();
    return;
  }
  const hr = !e.target.closest('button') && e.target.closest('[data-hist-id]');
  if (hr) { const k = hr.dataset.histId; openHist.has(k) ? openHist.delete(k) : openHist.add(k); render(); return; }
  const el = e.target.closest('button'); if (!el) return;
  if (el.id === 'bgBtn' && hasBg) {
    const on = !window.AndroidApp.getBackground();
    window.AndroidApp.setBackground(on);
    toast(on ? t('bg_on_toast') : t('bg_off_toast'));
    setTimeout(renderBg, 150);
    return;
  }
  if (el.dataset.mine) {
    const s = state.signals.find(x => x.id === el.dataset.mine);
    if (s) { s.mine = !s.mine; call({ action: 'mine', id: s.id, on: s.mine }); render(); }
    return;
  }
  if (el.dataset.ctf) { cardTf.set(el.dataset.cid, el.dataset.ctf); $('#live').dataset.key = ''; renderLive(); return; }
  if (el.dataset.more) { const k = el.dataset.more; openCards.has(k) ? openCards.delete(k) : openCards.add(k); $('#live').dataset.key = ''; renderLive(); return; }
  if (el.dataset.pin) togglePin(el.dataset.pin);
  if (el.dataset.po) openPO(el.dataset.po, el.dataset.potf, false, +el.dataset.poexp || 0);
  if (el.dataset.quick) quickTrade(el);
  if (el.dataset.tv) { const s = state.signals.find(x => x.id === el.dataset.tv); if (s) openUrl(s.tv); }
  if (el.dataset.tab) {
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b === el));
    document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === el.dataset.tab));
    $('main').scrollTop = 0;
    if (el.dataset.tab === 'signals') showFresh();
  }
  if (el.id === 'newPill') showFresh();
  if (el.id === 'rgReset') call({ action: 'settings', patch: { rg_adx: 25, rg_slope: 0.08, rg_dist: 2, rg_range_adx: 25, rg_chaos_atr: 2, rg_spike: 3.5, rg_vol: 0.7 } });
  if (el.dataset.lang) changeLang(el.dataset.lang);
  if (el.dataset.dir) { dirFilter = el.dataset.dir; document.querySelectorAll('[data-dir]').forEach(b => b.classList.toggle('active', b === el)); render(); }
  if (el.dataset.hist) { histView = el.dataset.hist; document.querySelectorAll('[data-hist]').forEach(b => b.classList.toggle('active', b === el)); render(); }
  if (el.dataset.cmd && isDesktop) window.desktop.win(el.dataset.cmd);
  if (el.dataset.mkt) { const k = el.dataset.mkt; openMarkets.has(k) ? openMarkets.delete(k) : openMarkets.add(k); renderMarkets(state.settings); }
  if (el.dataset.pairsAll) setPairs((state.settings.markets[el.dataset.pairsAll] || []).map(p => p.key), []);
  if (el.dataset.pairsNone) setPairs([], (state.settings.markets[el.dataset.pairsNone] || []).map(p => p.key));
  if (el.dataset.lnew || el.dataset.lmode) { // Ludo buttons: save and redraw at once
    const k = el.dataset.lnew || el.dataset.lmode, x = (state.settings.allStrategies || []).find(q => q.key === k); if (!x) return;
    const patch = el.dataset.lnew ? { ludo_new: !x.params.ludo_new } : { ludo_mode: el.dataset.m };
    Object.assign(x.params, patch); call({ action: 'strategy', name: k, patch }); renderStrategies(state.settings); return;
  }
  if (el.dataset.tests) { const k = el.dataset.tests; openTests.has(k) ? openTests.delete(k) : openTests.add(k); renderStrategies(state.settings); }
  if (el.dataset.open) { const k = el.dataset.open; openStrats.has(k) ? openStrats.delete(k) : openStrats.add(k); renderStrategies(state.settings); }
  if (el.dataset.filter) { stratFilter = el.dataset.filter; renderStrategies(state.settings); }
  if (el.dataset.preset) {
    const x = state.settings.allStrategies.find(s => s.key === el.dataset.preset), pr = x && x.presets[+el.dataset.pn];
    // Presets are switches: several can be on, a signal comes when any of them fires.
    if (pr) {
      const n = +el.dataset.pn, on = new Set(x.activePresets || []);
      on.has(n) ? on.delete(n) : on.add(n);
      x.activePresets = [...on].sort();
      call({ action: 'strategy', name: x.key, presets: x.activePresets });
      renderStrategies(state.settings);
    }
  }
  if (el.dataset.reset && confirm(t('defaults_confirm'))) call({ action: 'resetStrategy', name: el.dataset.reset });
  if (el.id === 'scanBtn') { call({ action: 'scan' }); toast(t('toast_scan')); }
});
$('#stratSearch').addEventListener('input', e => { stratQuery = e.target.value; renderStrategies(state.settings); });

document.addEventListener('change', e => {
  const el = e.target, patch = {};
  if (el.id === 'sLang') changeLang(el.value);
  if (el.id === 'sOn') patch.signals_on = el.checked;
  if (el.id === 'sSound') patch.sound = el.checked;
  if (el.id === 'sAuto') patch.auto_po = el.checked;
  if (el.id === 'sQuick') patch.quick_trade = el.checked;
  if (el.id === 'sQuickReal') patch.quick_real = el.checked;
  if (el.id === 'sRegimeMode') patch.regime_mode = el.value;
  if (el.dataset.rg && el.value !== '' && Number.isFinite(+el.value)) patch[el.dataset.rg] = +el.value;
  if (el.id === 'sChaos') patch.chaos_skip = el.checked;
  if (el.id === 'sPoClick') patch.po_click_toggle = el.checked;
  if (el.id === 'sMini') patch.mini_on_blur = el.checked;
  if (el.id === 'sM5') patch.show_m5 = el.checked;
  if (el.id === 'sPoStart') patch.po_start_mode = el.value;
  if (el.id === 'sTvOpen') patch.tv_open = el.value;
  if (el.id === 'sMiniTf') patch.mini_tf = el.value;
  if (el.id === 'sMktLevel') patch.mkt_level = Number(el.value) || 0;
  if (el.id === 'sQuotesDemo') patch.quotes_demo = el.checked;
  if (el.id === 'sSmartExp') patch.smart_exp = el.checked;
  if (el.id === 'sOtcRec') patch.otc_record = el.checked;
  if (el.dataset.trendtf !== undefined) { // at least one timeframe stays on
    const tfs = [...document.querySelectorAll('[data-trendtf]:checked')].map(x => x.value);
    if (tfs.length) patch.trend_tfs = tfs; else el.checked = true;
  }
  if (el.id === 'sTrendFilter') patch.trend_filter = el.checked;
  if (el.id === 'sMiniCount') patch.mini_count = +el.value;
  if (el.id === 'sMiniPos') patch.mini_pos = el.value;
  if (el.id === 'sInterval') patch.scan_interval = +el.value;
  if (el.id === 'sMin') patch.min_strength = +el.value;
  if (el.id === 'sMax') patch.max_per_scan = +el.value;
  if (el.id === 'sPayout') patch.min_payout = +el.value;
  if (el.dataset.cat) {
    patch.assets_off = CATS.filter(k => !document.querySelector(`[data-cat="${k}"]`).checked);
    state.settings.assets_off = patch.assets_off;          // hide/show the pair list right away
    if (!el.checked) openMarkets.delete(el.dataset.cat);
    renderMarkets(state.settings);
  }
  if (el.dataset.pair) { el.checked ? setPairs([el.dataset.pair], []) : setPairs([], [el.dataset.pair]); return; }
  if (el.dataset.strat) {
    const on = new Set(state.settings.strategies);
    el.checked ? on.add(el.dataset.strat) : on.delete(el.dataset.strat);
    patch.strategies = [...on];
  }
  if (el.dataset.sound) { // sound of a strategy: save it and play it once as a sample
    const map = { ...(state.settings.strat_sounds || {}), [el.dataset.sound]: el.value };
    state.settings.strat_sounds = map; beep(el.value);
    call({ action: 'settings', patch: { strat_sounds: map } });
  }
  if (el.dataset.sp) {
    let v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    if (el.dataset.num !== undefined) { // comma or point; below the minimum / not a number → minimum
      const mn = Number(el.dataset.min) || 0, n = parseNum(el.value);
      v = Number.isFinite(n) ? Math.max(mn, n) : mn; el.value = v;
    }
    call({ action: 'strategy', name: el.dataset.sp, patch: { [el.dataset.param]: v } });
    // A switch can show/hide other settings (n_run modes, n_sharp blocks): update the local copy and redraw at once.
    if (el.type === 'checkbox' || el.dataset.param === 'ludo_mode') { const x = (state.settings.allStrategies || []).find(q => q.key === el.dataset.sp); if (x && x.params) { x.params[el.dataset.param] = v; renderStrategies(state.settings); } }
  }
  if (el.dataset.tf) {
    const tfs = [...document.querySelectorAll(`[data-tf="${el.dataset.tf}"]:checked`)].map(x => x.value);
    call({ action: 'strategy', name: el.dataset.tf, tfs });
  }
  if (Object.keys(patch).length) call({ action: 'settings', patch });
});
$('#loginBtn').onclick = () => {
  if (isAndroid && window.AndroidApp.showPocketOption) window.AndroidApp.showPocketOption();
  else call({ action: 'login' });
};
// Accepts a raw 42["auth",…] message or a transfer code from the PC ("PSX1:…" = session + server).
$('#ssidBtn').onclick = async () => {
  const btn = $('#ssidBtn');
  // Messengers may wrap long text or add words around it: take the 42["auth",…] part and drop line breaks.
  let v = $('#ssid').value.replace(/\s*[\r\n]+\s*/g, '').trim();
  if (!v) { flash(btn, t('paste_first'), false); return; }
  let msg;
  const code = v.match(/PSX1:([A-Za-z0-9+/=]+)/);
  if (code) {
    try { const d = JSON.parse(atob(code[1])); msg = { action: 'ssid', ssid: d.ssid, url: d.url }; }
    catch { flash(btn, '✗ ' + t('code_invalid'), false); return; }
  } else {
    const a = v.indexOf('42["auth"'), b = v.lastIndexOf(']');
    if (a < 0 || b < a) { flash(btn, '✗ ' + t('code_invalid'), false); return; }
    msg = { action: 'ssid', ssid: v.slice(a, b + 1) };
  }
  const r = await call(msg);
  if (r && r.ok === false) { flash(btn, '✗ ' + t('save_failed'), false); return; }
  $('#ssid').value = '';
  flash(btn, '✓ ' + t('saved'));
  toast(t('toast_session'));
};
async function copyText(text) {
  if (isAndroid && window.AndroidApp.copyText) { window.AndroidApp.copyText(text); return true; }
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
const logText = () => {
  const lines = [...(window.__bootErrors || []).map(e => '⚠ ' + e), ...((state && state.log) || [])];
  return `PocketSignals ${updater ? updater.version : ''} (${isAndroid ? 'Handy' : isDesktop ? 'PC' : 'Browser'})\n` + lines.join('\n');
};
$('#copyLogBtn').onclick = async () => {
  if (await copyText(logText())) flash($('#copyLogBtn'), '✓ ' + t('log_copied'));
  else flash($('#copyLogBtn'), '✗ ' + t('copy_failed'), false);
};
// 22.11.2026 (user): watchdog warning – sound + notification once, and a red bar on the main screen with
// "Copy log" (paste it into the chat with Claude) and ✕. The bar goes away by itself once the problem is gone.
// 23.11.2026 (user): "Signal selection" – minimum score (50 weak / 70 working / 85 strong) and signals per hour, each with
// − / + (score in steps of 5, per hour in steps of 5, 0 = no limit), explanation in a spoiler. Applies to all strategies.
let selOpen = (() => { try { return localStorage.getItem('selOpen') === '1'; } catch { return false; } })();
function renderSel() {
  const el = document.getElementById('selBox'); if (!el || !state || !state.settings) return;
  const s = state.settings, ru = LANG === 'ru', de = LANG === 'de', T = (r, d, e) => ru ? r : de ? d : e;
  const sc = Number(s.sig_score_min ?? 50), ph = Number(s.sig_per_hour) || 0, cl = Number(s.sig_clean_min) || 0, cn = Number(s.sig_clean_n) || 10;
  const lvl = sc >= 85 ? T('только сильные', 'nur starke', 'strong only') : sc >= 70 ? T('рабочие и сильные', 'brauchbare + starke', 'working + strong') : sc >= 50 ? T('слабые, рабочие, сильные', 'schwache, brauchbare, starke', 'weak, working, strong') : T('все, даже отклонённые', 'alle', 'all');
  const hour = (state.signals || []).filter(x => !x.manual && Date.now() - (x.created || 0) < 3600000).length;
  const html = `<details class="setfold selfold"${selOpen ? ' open' : ''}><summary><h3>${T('Отбор сигналов', 'Signalauswahl', 'Signal selection')}</h3><small>score ≥ ${sc} · ${ph ? T(`≤ ${ph} в час`, `≤ ${ph}/h`, `≤ ${ph}/h`) : T('без лимита', 'ohne Limit', 'no limit')} · ${cl ? T(`чистота ≥ ${cl} %`, `Sauberkeit ≥ ${cl} %`, `clean ≥ ${cl} %`) : T('чистота выкл', 'Sauberkeit aus', 'clean off')} · ${T('за час', 'letzte Std.', 'last hour')}: ${hour}</small></summary>
    <div class="selrow"><span>${T('Мин. score', 'Min. Score', 'Min score')}</span><button type="button" data-sel="sig_score_min" data-d="-5">−</button><b>${sc}</b><button type="button" data-sel="sig_score_min" data-d="5">+</button><em>${lvl}</em></div>
    <div class="selrow"><span>${T('Сигналов в час, макс.', 'Signale pro Stunde, max.', 'Signals per hour, max')}</span><button type="button" data-sel="sig_per_hour" data-d="-5">−</button><b>${ph || '∞'}</b><button type="button" data-sel="sig_per_hour" data-d="5">+</button><em>${ph ? T('сильнейшие первыми', 'stärkste zuerst', 'strongest first') : T('0 = без лимита', '0 = ohne Limit', '0 = no limit')}</em></div><div class="selrow"><span>${T('Чистота, мин. %', 'Sauberkeit, min. %', 'Cleanliness, min %')}</span><button type="button" data-sel="sig_clean_min" data-d="-5">−</button><b>${cl || T('выкл', 'aus', 'off')}</b><button type="button" data-sel="sig_clean_min" data-d="5">+</button></div><div class="selrow"><span>${T('Чистота: свечей M1', 'Sauberkeit: M1-Kerzen', 'Cleanliness: M1 candles')}</span><button type="button" data-sel="sig_clean_n" data-d="-1">−</button><b>${cn}</b><button type="button" data-sel="sig_clean_n" data-d="1">+</button></div>
    <details class="pfold"><summary>${T('Как это работает', 'Wie es funktioniert', 'How it works')}</summary><div class="selhelp">${T(
      `<p><b>Score</b> — оценка сигнала от 0 до 100, её ставит стратегия за то, насколько полно выполнены её условия.</p><p>50–69 — <b>слабый</b> сетап · 70–84 — <b>рабочий</b> · 85–100 — <b>сильный</b>. Ниже 50 — отклонён.</p><p><b>Мин. score</b>: сигналы ниже порога не приходят. 50 = приходят слабые, рабочие и сильные (по умолчанию). 70 = слабые отсеяны. 85 = только сильные. Шаг 5.</p><p><b>Сигналов в час</b>: если за последние 60 минут пришло столько сигналов, новые не приходят, пока час не освободится. Из одновременных первым проходит сильнейший. 0 (∞) = без лимита. Шаг 5.</p><p><b>Чистота</b> — насколько прямо шла цена за последние N минутных свечей перед сигналом: итоговое движение ÷ сумма тел всех свечей. 100 % = все свечи одного цвета (ровная линия), 50 % = половина хода съедена откатами, около 0 % = пила (зелёная-красная). Сигнал приходит, только если чистота не ниже порога. Пример: 10 свечей, 8 зелёных и 2 маленькие красные — около 70–80 %. Выкл (0) = не проверяется. Шаг 5 %; число свечей — от 3 до 30.</p><p>Важно: высокий score — это «ситуация похожа на учебный пример», а не доказанно больше выигрышей. Порог уменьшает поток сигналов; проверяйте на демо.</p>`,
      `<p><b>Score</b> 0–100: wie vollständig die Bedingungen der Strategie erfüllt sind. 50–69 schwach · 70–84 brauchbar · 85–100 stark.</p><p><b>Min. Score</b>: Signale darunter kommen nicht. <b>Signale pro Stunde</b>: Limit über die letzten 60 min, stärkste zuerst, 0 = ohne Limit.</p><p>Hoher Score ist kein Beweis für mehr Gewinne.</p>`,
      `<p><b>Score</b> 0–100: how fully the strategy's conditions are met. 50–69 weak · 70–84 working · 85–100 strong.</p><p><b>Min score</b>: signals below do not come. <b>Signals per hour</b>: limit over the last 60 min, strongest first, 0 = no limit.</p><p>A high score is no proof of more wins.</p>`)}</div></details></details>`;
  if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
}
document.addEventListener('toggle', e => { if (e.target.classList && e.target.classList.contains('selfold')) { selOpen = e.target.open; try { localStorage.setItem('selOpen', selOpen ? '1' : '0'); } catch {} } }, true);
document.addEventListener('click', e => { // pattern selection (23.11.2026)
  const b = e.target.closest('[data-psel]'); if (!b || !state.patRadar) return; e.preventDefault(); e.stopPropagation();
  const k = b.dataset.psel, P = state.patRadar, f = { pat_clean_min: 'cleanMin', pat_clean_n: 'cleanN', pat_per_hour: 'perHour' }[k];
  const lim = { pat_clean_min: [0, 100], pat_clean_n: [3, 30], pat_per_hour: [0, 500] }[k], cur = Number(P[f]) || (k === 'pat_clean_n' ? 10 : 0);
  const v = Math.max(lim[0], Math.min(lim[1], cur + +b.dataset.d)); call({ action: 'settings', patch: { [k]: v } }); state.patRadar = { ...P, [f]: v }; renderRadar(true);
}, true);
document.addEventListener('click', e => {
  const b = e.target.closest('[data-sel]'); if (!b || !state || !state.settings) return; e.preventDefault();
  const k = b.dataset.sel, S = state.settings, cur = k === 'sig_score_min' ? Number(S.sig_score_min ?? 50) : k === 'sig_clean_n' ? Number(S.sig_clean_n) || 10 : Number(S[k]) || 0;
  const lim = { sig_score_min: [0, 100], sig_per_hour: [0, 500], sig_clean_min: [0, 100], sig_clean_n: [3, 30] }[k] || [0, 500];
  const v = Math.max(lim[0], Math.min(lim[1], cur + +b.dataset.d));
  state.settings = { ...state.settings, [k]: v }; call({ action: 'settings', patch: { [k]: v } }); renderSel();
});
let watchSeen = null, watchClosed = 0;
function renderWatch() {
  const el = document.getElementById('watchBox'); if (!el || !state) return;
  const w = state.watch, ru = LANG === 'ru';
  const gone = !w || (w.kind === 'stale' && state.radar && (state.radar.list || []).length) || (w.kind === 'offline' && state.connected) || ((w.kind === 'expired' || w.kind === 'nossid') && state.connected);
  if (watchSeen === null) watchSeen = w ? w.id : 0; // a warning already there when the page loads: no sound
  if (w && watchSeen !== w.id) {
    if (!gone) ringAlert('⚠ PocketSignals', ru ? w.ru : w.de, { name: '', symbol: '' }, 'alarm');
    watchSeen = w.id;
  }
  if (gone || watchClosed === w.id) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<span>⚠ ${esc(ru ? w.ru : w.de)}</span><button type="button" data-wcopy>${ru ? 'Скопировать журнал' : 'Protokoll kopieren'}</button><button type="button" data-wclose>✕</button>`;
}
document.addEventListener('click', async e => {
  if (e.target.closest('[data-wclose]')) { watchClosed = state && state.watch ? state.watch.id : 0; renderWatch(); return; }
  const b = e.target.closest('[data-wcopy]'); if (!b) return;
  if (await copyText(logText())) flash(b, '✓ ' + t('log_copied')); else flash(b, '✗ ' + t('copy_failed'), false);
});
$('#exportSessionBtn').onclick = async () => {
  const btn = $('#exportSessionBtn');
  const r = await call({ action: 'exportSession' });
  if (!r.ok) { flash(btn, '✗ ' + t('no_session_yet'), false); return; }
  if (await copyText(r.code)) { flash(btn, '✓ ' + t('session_copied')); }
  else { $('#ssid').value = r.code; flash(btn, t('toast_export_field'), false); }
};
// Import accepts the bot's JSON even when it is wrapped in other text (e.g. a copied Telegram message).
function parseSettings(text) {
  try { return JSON.parse(text); } catch {}
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) try { return JSON.parse(text.slice(a, b + 1)); } catch {}
  return null;
}
$('#importPick').onclick = () => $('#importFile').click();
$('#importFile').onchange = async e => { const f = e.target.files[0]; if (f) $('#importText').value = await f.text(); e.target.value = ''; };
$('#importBtn').onclick = async () => {
  const data = parseSettings($('#importText').value.trim());
  if (!data) { toast(t('toast_no_json')); return; }
  const r = await call({ action: 'import', data });
  if (r.ok) { $('#importText').value = ''; toast(t('toast_imported', { s: r.strategies, a: r.active })); }
  else toast(r.error ? t(r.error) : t('toast_import_fail'));
};
$('#otcExportBtn').onclick = () => {
  const p = window.AndroidApp.recExport();
  toast(p ? t('otc_export_ok', { p }) : t('otc_export_fail'));
};
$('#exportBtn').onclick = async () => {
  const r = await call({ action: 'export' }); if (!r.ok) return;
  const text = JSON.stringify(r.data, null, 1);
  try { await navigator.clipboard.writeText(text); toast(t('toast_exported')); }
  catch { $('#importText').value = text; toast(t('toast_export_field')); }
};
$('#clearBtn').onclick = () => {
  if (histView === 'mine') { if (confirm(t('clear_mine_confirm'))) call({ action: 'clear_mine' }); } // own trades: marks removed, counting starts anew
  else if (confirm(t('clear_confirm'))) call({ action: 'clear' });
};

// Plays one of the signal sounds (ui/sounds.js).
function beep(key) {
  if (isAndroid && window.AndroidApp && window.AndroidApp.playSound) { try { window.AndroidApp.playSound(key || 'default'); return; } catch {} } // phone: native player (22.11.2026)
  const tones = (window.SOUNDS || {})[key] || (window.SOUNDS || {}).default || [];
  if (!tones.length) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    for (const [f, t, d, v, type] of tones) {
      const o = ctx.createOscillator(), g = ctx.createGain(), t0 = ctx.currentTime + t;
      o.type = type || 'sine'; o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(v, t0); g.gain.exponentialRampToValueAtTime(.001, t0 + d); o.start(t0); o.stop(t0 + d);
    }
  } catch {}
}
const soundOf = name => (state && state.settings.strat_sounds && state.settings.strat_sounds[name]) || 'default';
let lastAuto = 0;
function onSignal(s) {
  // Notifications only for the chosen strategies (Strategy Lab settings; empty list = all).
  const ns = state && state.lab && state.lab.notify_strats;
  if (ns && ns.length && !ns.includes(s.strategy)) return;
  const snd = soundOf(s.strategy);
  // The phone plays the strategy's sound with the notification (its own channel); the app only on the PC/browser.
  if (state && state.settings.sound && !isAndroid) beep(snd);
  if (navigator.vibrate) navigator.vibrate([150, 80, 150]);
  const left = s.expiresAt ? Math.max(0, Math.round(s.expiresAt - Date.now() / 1000)) : null;
  const body = `${tr(s.strategyName)} · ${fmtExp(s.expiry)} · ${s.lab ? 'score ' + s.lab.score : t('strength') + ' ' + s.strength}${left != null ? ' · ' + t('notif_left', { s: left }) : ''}`;
  // Pair first (user 08.11.2026: the collapsed phone notification showed only the emojis and two letters of the pair).
  const title = isAndroid ? `${s.name} ${s.dir === 'CALL' ? '▲' : '▼'} ${s.dir}` : `${s.dir === 'CALL' ? '🟢⬆️' : '🔴⬇️'} ${s.dir} · ${s.name}`;
  if (isAndroid && window.AndroidApp.notifySound) window.AndroidApp.notifySound(title, body, s.name, s.symbol, s.tv, state.settings.sound ? snd : 'none');
  else if (isAndroid) window.AndroidApp.notify(title, body, s.name, s.symbol, s.tv);
  else if (window.Notification && Notification.permission === 'granted' && document.hidden)
    new Notification(`${s.dir} ${s.name}`, { body, icon: 'icon.png' });
  // Auto switch PocketOption to the newest signal (at most once every 10 s).
  if (state && state.settings.auto_po && (isDesktop || isAndroid) && Date.now() - lastAuto > 10000) { lastAuto = Date.now(); setTimeout(() => openPO(s.id, undefined, true), 300); }
}
document.addEventListener('click', () => { if (!isAndroid && window.Notification && Notification.permission === 'default') Notification.requestPermission(); }, { once: true });
// Phone: a double tap on an empty spot of the signals page goes back to PocketOption (user, 08.11.2026; the PocketOption tab
// does the reverse). Not on buttons, fields, links or the settings, so quick taps on controls never switch.
if (isAndroid && window.AndroidApp.showPo) {
  let lt = 0, lx = 0, ly = 0;
  document.addEventListener('touchend', e => {
    if (e.changedTouches.length !== 1 || e.target.closest('button,input,select,textarea,a,label,[data-po],[data-quick],[data-more],[data-tab],#settings,.modal')) { lt = 0; return; }
    const t = e.changedTouches[0], n = Date.now();
    if (n - lt < 350 && Math.abs(t.clientX - lx) < 40 && Math.abs(t.clientY - ly) < 40) { lt = 0; window.AndroidApp.showPo(); }
    else { lt = n; lx = t.clientX; ly = t.clientY; }
  }, true);
}

// Phone: newest release with an .apk on GitHub (the API allows browser requests).
async function checkGithubApk(current) {
  const repo = window.UPDATE_REPO;
  if (!repo) return { ok: false, error: 'update_norepo' };
  const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=15`, { headers: { Accept: 'application/vnd.github+json' } });
    // GitHub allows only 60 checks per hour per internet address – on mobile networks many people share one, so the
    // check often fails. Then offer the newest APK directly (this link always points to the latest release).
    if (!r.ok) return { ok: true, available: true, latest: t('update_newest'), url: `https://github.com/${repo}/releases/latest/download/PocketSignals.apk`, direct: true };
    const rel = (await r.json()).find(x => !x.draft && (x.assets || []).some(a => a.name.endsWith('.apk')));
    if (!rel) return { ok: true, available: false };
    const latest = String(rel.tag_name).replace(/^v/, ''), asset = rel.assets.find(a => a.name.endsWith('.apk'));
    return { ok: true, latest, available: newer(latest, current), url: asset.browser_download_url };
  } catch (e) { return { ok: false, error: 'update_offline', detail: String(e.message || e) }; }
}

// Updates: the PC installs .signalupdate files itself; the phone downloads the new APK and hands it to Android's installer.
const updater = isDesktop && window.desktop.installUpdate ? {
  version: window.desktop.version, check: () => window.desktop.checkOnline(), install: url => window.desktop.installOnline(url),
} : isAndroid && window.AndroidApp.getVersion ? {
  version: window.AndroidApp.getVersion(), check: () => checkGithubApk(window.AndroidApp.getVersion()),
  install: url => { window.AndroidApp.installApk(url); return Promise.resolve({ ok: true, android: true }); },
} : null;

if (updater) {
  $('#updateBox').hidden = false;
  $('#appVersion').textContent = updater.version;
  const updateResult = r => toast(r.android ? t('apk_downloading') : r.ok ? t('toast_update_ok', { v: r.version || '' }) : t(r.error || 'update_failed') + (r.detail ? ': ' + r.detail : ''));
  // Picking a file by hand exists only on the PC.
  if (isDesktop) $('#updateBtn').onclick = async () => { const r = await window.desktop.installUpdate(); if (!r.canceled) updateResult(r); };
  else { $('#updateBtn').hidden = true; document.querySelector('#updateBox [data-i18n="update_hint"]').hidden = true; }
  // Online updates (GitHub): check, then offer the newest version.
  let online = null;
  const check = async quiet => {
    $('#onlineStatus').textContent = '· ' + t('checking');
    const r = await updater.check();
    online = r.ok && r.available ? r : null;
    $('#installBtn').hidden = !online;
    if (online) $('#installBtn').textContent = t('install_version', { v: r.latest });
    $('#onlineStatus').textContent = !r.ok ? '· ' + t(r.error) : online ? '· ' + t('update_available', { v: r.latest }) : '· ' + t('up_to_date');
    document.querySelector('[data-tab=settings]').classList.toggle('dot-new', !!online);
    if (online && quiet) toast(t('update_available', { v: r.latest }));
    if (!r.ok && !quiet) toast(t(r.error) + (r.detail ? ': ' + r.detail : ''));
  };
  $('#checkBtn').onclick = () => check(false);
  $('#installBtn').onclick = async () => {
    if (!online) return;
    $('#installBtn').disabled = true; $('#installBtn').textContent = t('downloading');
    const r = await updater.install(online.url);
    $('#installBtn').disabled = false;
    if (!r.ok || r.android) $('#installBtn').textContent = t('install_version', { v: online.latest });
    updateResult(r);
  };
  setTimeout(() => check(true), 8000);           // on start
  setInterval(() => check(true), 3 * 3600 * 1000); // and every 3 hours
}
if (isAndroid && window.AndroidApp.showPo) { $('#poClickRow').hidden = false; $('#poClickRow').style.display = ''; } // double tap switching
if (isDesktop && window.desktop.onCompact) {
  $('#miniRow').hidden = false;
  $('#poClickRow').hidden = false; $('#poClickRow').style.display = '';
  document.querySelectorAll('.miniOpt').forEach(el => { el.hidden = false; });
  // Tell the window that the click came from inside the mini view, so focusing it keeps it small.
  if (window.desktop.miniPointer) $('#mini').addEventListener('pointerdown', () => window.desktop.miniPointer(), true);
  window.desktop.onCompact(on => {
    document.body.classList.toggle('compact', on);
    if (on) { $('#mini').dataset.key = ''; render(); reportMiniHeight(); }
  });
}
if (isDesktop) {
  $('#exportBox').hidden = false;
  document.documentElement.classList.add('desktop');
  $('#winctl').hidden = false;
  window.desktop.onPinned(on => $('#pinBtn').classList.toggle('on', on));
}
if (!isDesktop && !isAndroid) $('#autoRow').hidden = true;
if (isAndroid) { $('#sessionHint').dataset.i18n = 'session_hint_android'; $('#tvRow').hidden = false; }
applyI18n();
if (isAndroid && window.AndroidApp.setLabels) window.AndroidApp.setLabels(t('back'));
connect();
