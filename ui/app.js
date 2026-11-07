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
  if (m.type === 'state') { state = m.state; render(); }
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
function render() {
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

  renderLive();
  $('#liveCount').textContent = open || '';
  // No (working) PocketOption session yet: ask to log in; the app takes the session over automatically.
  $('#loginBox').hidden = !['no_ssid', 'expired'].includes(state.status) || (!isDesktop && !isAndroid);

  $('#allStats').hidden = histView !== 'all';
  const sigs = state.signals.filter(s => !s.manual); // own trades without a signal are not signal statistics
  if (histView === 'all') $('#allStats').innerHTML = `<div class="stats">${statTiles(sigs)}</div>${strategyStats(sigs)}`;
  $('#hist').hidden = histView !== 'list'; $('#stratStats').hidden = histView !== 'stats'; $('#myStats').hidden = histView !== 'mine'; $('#archStats').hidden = histView !== 'archive';
  $('#hist').innerHTML = state.signals.map(row).join('') || `<p class="empty">${t('no_history')}</p>`;
  $('#stratStats').innerHTML = strategyStats(sigs);
  if (histView === 'mine') $('#myStats').innerHTML = myStats();
  $('#clearBtn').textContent = t(histView === 'mine' ? 'clear_mine' : 'clear_history'); $('#clearBtn').hidden = histView === 'archive';
  if (histView === 'archive' && $('#archStats').dataset.done !== LANG) { $('#archStats').innerHTML = archiveStats(); $('#archStats').dataset.done = LANG; }

  const s = state.settings;
  if (!$('#settings').contains(document.activeElement) || document.activeElement.tagName === 'BUTTON') {
    $('#sOn').checked = s.signals_on; $('#sSound').checked = s.sound; $('#sAuto').checked = s.auto_po; $('#sRegimeMode').value = s.regime_mode || 'off'; document.querySelectorAll('[data-rg]').forEach(i => { i.value = s[i.dataset.rg]; }); $('#sChaos').checked = s.chaos_skip; $('#sPoClick').checked = s.po_click_toggle; $('#sMini').checked = s.mini_on_blur; $('#sM5').checked = s.show_m5;
    $('#sPoStart').value = s.po_start_mode || 'last'; $('#sTvOpen').value = s.tv_open || 'external'; $('#sTrendTf').value = s.trend_tf || 'M5'; $('#sTrendFilter').checked = s.trend_filter;
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
  const list = state.signals.filter(isVisible);
  const pinned = pins.map(id => list.find(s => s.id === id)).filter(Boolean);
  // Starred first, then newest on top (user, 04.11.2026: every fresh signal must be seen at once).
  const rest = list.filter(s => !pins.includes(s.id)).sort((a, b) => (b.created || 0) - (a.created || 0) || b.strength - a.strength);
  return [...pinned, ...rest];
}
// Trend badge; clicking it opens the pair in PocketOption on the trend timeframe.
const m5Badge = s => {
  if (!state.settings.show_m5 || !s.m5) return '';
  const tf = state.settings.trend_tf || 'M5';
  return `<button class="m5 ${s.m5}" data-po="${esc(s.id)}" data-potf="${tf}" title="${t('m5_title', { tf })} – ${t('open_tf')}">${tf} ${s.m5 === 'CALL' ? '▲' : s.m5 === 'PUT' ? '▼' : '◆'}</button>`;
};
const resultBadge = s => (s.result ? `<span class="res ${s.result}">${I18N.de['res_' + s.result] ? t('res_' + s.result) : s.result}</span>` : '');

// Rebuilds cards and mini rows only when something visible changes (list, finished state, result, M5, stars),
// so timers and progress bars keep running smoothly. Called on every state update and twice a second.
function renderLive() {
  if (!state) return;
  const all = visibleSignals();
  const sig = s => [s.id, isDone(s) ? 1 : 0, s.result || '', s.m5 || '', pins.includes(s.id) ? 1 : 0].join(':');
  let live = all.filter(s => dirFilter === 'all' || s.dir === dirFilter);
  // Scrolled down to a signal: the order is held, new signals wait behind the "↑ N new" pill (no jumping cards).
  // At the top, after the pill or the Signals tab: newest first again.
  const main = $('main'), scrolled = main.scrollTop > 40 && $('#signals').classList.contains('active');
  let fresh = 0;
  if (scrolled && heldOrder) { fresh = live.filter(s => !heldOrder.includes(s.id)).length; live = heldOrder.map(id => live.find(s => s.id === id)).filter(Boolean); }
  else heldOrder = live.map(s => s.id);
  $('#newPill').hidden = !fresh; if (fresh) $('#newPill').textContent = t('new_signals', { n: fresh });
  const liveKey = [LANG, state.settings.show_m5, state.settings.trend_tf, ...live.map(sig)].join('|');
  if ($('#live').dataset.key !== liveKey) { const top = main.scrollTop; $('#live').innerHTML = live.map(card).join(''); $('#live').dataset.key = liveKey; main.scrollTop = top; }
  $('#liveEmpty').hidden = live.length > 0;
  updateAdxBoxes();

  const top = all.slice(0, state.settings.mini_count || 2);
  const miniKey = [LANG, state.settings.show_m5, state.settings.trend_tf, ...top.map(sig)].join('|');
  if ($('#mini').dataset.key === miniKey) return;
  $('#mini').dataset.key = miniKey;
  $('#mini').innerHTML = top.map(s => `<div class="mrow ${s.dir}${isDone(s) ? ' done' : ''}" data-expand="1">
      <span class="grip" title="${t('drag')}">⋮⋮</span>
      <button class="star${pins.includes(s.id) ? ' on' : ''}" data-pin="${esc(s.id)}" title="${t('pin')}">${pins.includes(s.id) ? '★' : '☆'}</button>
      <span class="md">${s.dir === 'CALL' ? '▲' : '▼'} ${s.dir}</span>
      <span class="mi"><b>${esc(s.name)} ${m5Badge(s)}</b><small>${esc(tr(s.strategyName))} · ${fmtExp(s.expiry)}</small></span>
      <button class="tag mtf" data-po="${esc(s.id)}" data-potf="${s.tf || 'M1'}" title="${t('open_tf')}">${s.tf || 'M1'}</button>
      ${isDone(s) && s.result ? resultBadge(s) : `<span class="timer" data-id="${esc(s.id)}" data-entry="${s.entryTime}" data-exp="${s.expiry}">${timerText(s.entryTime, s.expiry)}</span>`}
    </div>`).join('') || `<div class="mempty" data-expand="1"><span class="grip">⋮⋮</span><img src="icon.png" width="18" height="18" alt="">${t('waiting')}</div>`;
  if (document.body.classList.contains('compact')) reportMiniHeight();
}
function reportMiniHeight() {
  if (isDesktop && window.desktop.miniHeight) requestAnimationFrame(() => window.desktop.miniHeight($('#mini').scrollHeight));
}

const seen = new Set();
function card(s) {
  const fresh = !seen.has(s.id); seen.add(s.id);
  const created = Math.floor((s.created || Date.now()) / 1000), tp = timeProgress(s.entryTime, s.expiry, created);
  const done = isDone(s), pinned = pins.includes(s.id);
  return `<div class="sig ${s.dir}${fresh && !done ? ' new' : ''}${done ? ' done' : ''}">
    <div class="sig-top">
      <button class="star${pinned ? ' on' : ''}" data-pin="${esc(s.id)}" title="${t('pin')}">${pinned ? '★' : '☆'}</button>
      <div class="pairbox"><div class="pair">${esc(s.name)}</div>
        <div class="pairmeta">${t('payout')} <b>${s.payout}%</b> · ${s.otc ? t('otc') : t('real_market')} ${m5Badge(s)}</div></div>
      ${done && s.result ? resultBadge(s) : `<div class="dir ${s.dir}"><span class="arrow">${s.dir === 'CALL' ? '▲' : '▼'}</span>${s.dir}</div>`}
    </div>
    <div class="strategy">
      <div style="flex:1;min-width:0"><div class="lbl">${t('found_by')}</div>
        <div class="nm">${esc(tr(s.strategyName))}</div><div class="why">${esc(tr(s.reason))}</div></div>
      <button class="tag" data-po="${esc(s.id)}" data-potf="${s.tf || 'M1'}" title="${t('open_tf')}">${s.tf || 'M1'} ↗</button>
    </div>
    <div class="grid3">
      <div><small>${t('entry')}</small><b>${fmtTime(s.entryTime)}</b></div>
      <div><small>${t('expiry')}</small><b>${fmtExp(s.expiry)}</b></div>
      <div><small>${t('strength')}</small><b>${s.strength}</b></div>
    </div>
    ${done ? '' : `<div class="trendbox" data-trend-id="${esc(s.id)}">${trendBox(s)}</div><div class="adxbox" data-adx-id="${esc(s.id)}">${adxBox(s)}</div>`}
    <div class="timebar${tp.run ? ' run' : ''}" data-entry="${s.entryTime}" data-exp="${s.expiry}" data-created="${created}"><i style="width:${tp.pct}%"></i></div>
    <div class="timer" data-id="${esc(s.id)}" data-entry="${s.entryTime}" data-exp="${s.expiry}">${timerText(s.entryTime, s.expiry)}</div>
    ${done ? '' : recBtn(s)}
    <div class="btns">
      <button class="po" data-po="${esc(s.id)}" data-poexp="60">PocketOption ↗</button>
      <button class="tv" data-tv="${esc(s.id)}">TradingView ↗</button>
    </div>
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
    <div class="info"><b>${esc(s.name)}</b><small>${esc(tr(s.strategyName))} · ${s.tf || 'M1'}</small>
      <small>${fmtTime(s.entryTime)} · ${fmtExp(s.expiry)} · ${t('strength')} ${s.strength}</small></div>${res}
    <button class="mini mine${s.mine ? ' on' : ''}" data-mine="${esc(s.id)}" title="${t('my_mark')}">${s.mine ? '✓' : '＋'}</button>
    <button class="mini po" data-po="${esc(s.id)}">PO</button><button class="mini" data-tv="${esc(s.id)}">TV</button>
    ${open ? `<div class="why">${esc(tr(s.reason) || '')}${s.entryPrice ? ` · ${s.entryPrice}${s.exitPrice ? ' → ' + s.exitPrice : ''}` : ''}</div>` : ''}</div>`;
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
    ${strategyStats(mine)}${mine.map(row).join('')}`;
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
function paramRows(x) {
  const row = k => k in x.params ? `<label class="prow"><span>${esc(x.labels && x.labels[k] ? tr(x.labels[k]) : paramLabel(k))}</span>${paramInput(x.key, k, x.params[k])}</label>` : '';
  // Every block is folded (user, 07.11.2026); only the open block's rows are drawn. Same open/closed state as the tables.
  const used = new Set((x.groups || []).flatMap(g => g.keys)), rest = Object.keys(x.params).filter(k => !used.has(k));
  const fold = (title, desc, keys, id) => {
    const body = keys.map(row).join(''); if (!body) return '';
    const key = `${x.key}:p${id}`, open = openTests.has(key);
    return `<div class="tests"><button class="tests-h" data-tests="${key}" aria-expanded="${open}">${open ? '▾' : '▸'} ${esc(title)}</button>${open ? `<div class="tests-b pfold">${desc ? `<small>${esc(desc)}</small>` : ''}${body}</div>` : ''}</div>`;
  };
  return (x.groups || []).map((g, n) => fold(tr(g.title), tr(g.desc), g.keys, n)).join('') + fold(t(x.groups ? 'params_other' : 'params_all'), '', rest, 'r');
}
// Parameters with a fixed choice are shown as a select.
const PARAM_CHOICES = { bs_mode: ['A', 'C'] };
function paramInput(key, name, v) {
  const id = `data-sp="${key}" data-param="${name}"`;
  if (PARAM_CHOICES[name]) return `<select ${id}>${PARAM_CHOICES[name].map(o => `<option value="${o}"${o === v ? ' selected' : ''}>${o === 'STOCH' ? 'Stochastic' : o}</option>`).join('')}</select>`;
  if (typeof v === 'boolean') return `<input type="checkbox" class="sw" ${id} ${v ? 'checked' : ''}>`;
  if (typeof v === 'number') return `<input type="number" step="any" ${id} value="${v}">`;
  return `<input type="text" ${id} value="${esc(v)}">`;
}
function renderStrategies(s) {
  const q = stratQuery.toLowerCase();
  const list = s.allStrategies.filter(x =>
    (stratFilter === 'all' || (stratFilter === 'on' ? s.strategies.includes(x.key) : s.favorites.includes(x.key))) &&
    (!q || Object.values(x.names || { n: x.name }).some(n => String(n).toLowerCase().includes(q)) || x.key.includes(q)));
  $('#stratCount').textContent = t('active_of', { a: s.strategies.length, n: s.allStrategies.length });
  document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b.dataset.filter === stratFilter));
  $('#strats').innerHTML = list.map(x => `<div class="strat${openStrats.has(x.key) ? ' open' : ''}">
    <div class="strat-head"><input type="checkbox" class="sw" data-strat="${x.key}" ${s.strategies.includes(x.key) ? 'checked' : ''}>
      <button class="strat-name" data-open="${x.key}">${s.favorites.includes(x.key) ? '★ ' : ''}${esc(tr(x.names || x.name))}<small>${x.tfs.join(' · ')} · ${x.type === 'rev' ? (x.params.follow_move ? t('follow') : t('reversal')) : t('trend')}</small></button>
      <button class="strat-arrow" data-open="${x.key}">${openStrats.has(x.key) ? '▴' : '▾'}</button></div>
    <div class="strat-body">
      <div class="tfs">${TFS.map(t => `<label><input type="checkbox" data-tf="${x.key}" value="${t}" ${x.tfs.includes(t) ? 'checked' : ''}><span>${t}</span></label>`).join('')}</div>
      <label class="prow"><span>🔔 ${t('sound_pick')}</span><select data-sound="${x.key}">${(window.SOUND_KEYS || []).map(k => `<option value="${k}"${soundOf(x.key) === k ? ' selected' : ''}>${t('snd_' + k)}</option>`).join('')}</select></label>
      ${(x.presets || []).length ? `<div class="presets"><small>${t('presets')} · ${t('presets_multi')}</small>${x.presets.map((pr, n) =>
        `<button class="chip${(x.activePresets || []).includes(n) ? ' active' : ''}" data-preset="${x.key}" data-pn="${n}">${(x.activePresets || []).includes(n) ? '✓ ' : ''}${n + 1} · ${esc(tr(pr.name))}</button>`).join('')}</div>` : ''}
      ${testTable(x)}
      ${paramRows(x)}
      <button class="btn ghost wide" data-reset="${x.key}">${t('defaults')}</button>
    </div></div>`).join('') || `<p class="empty">${t('no_strategy')}</p>`;
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
async function openPO(id, tf, auto, exp) {
  const sig = state.signals.find(s => s.id === id);
  const r = await call({ action: 'openPO', id, tf, auto: !!auto, exp: exp || 0, lang: LANG });
  const name = r.name || (sig && sig.name) || '';
  if (isDesktop) { toast(t('toast_po', { name }) + (tf ? ' · ' + tf : '')); return; }
  if (isAndroid) {
    if (tf && window.AndroidApp.openPocketOptionReload) window.AndroidApp.openPocketOptionReload(name);
    else window.AndroidApp.openPocketOption(name, r.symbol || (sig && sig.symbol) || '');
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
  if (el.dataset.pin) togglePin(el.dataset.pin);
  if (el.dataset.po) openPO(el.dataset.po, el.dataset.potf, false, +el.dataset.poexp || 0);
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
  if (el.id === 'sRegimeMode') patch.regime_mode = el.value;
  if (el.dataset.rg && el.value !== '' && Number.isFinite(+el.value)) patch[el.dataset.rg] = +el.value;
  if (el.id === 'sChaos') patch.chaos_skip = el.checked;
  if (el.id === 'sPoClick') patch.po_click_toggle = el.checked;
  if (el.id === 'sMini') patch.mini_on_blur = el.checked;
  if (el.id === 'sM5') patch.show_m5 = el.checked;
  if (el.id === 'sPoStart') patch.po_start_mode = el.value;
  if (el.id === 'sTvOpen') patch.tv_open = el.value;
  if (el.id === 'sTrendTf') patch.trend_tf = el.value;
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
    const v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    call({ action: 'strategy', name: el.dataset.sp, patch: { [el.dataset.param]: v } });
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
$('#copyLogBtn').onclick = async () => {
  const lines = [...(window.__bootErrors || []).map(e => '⚠ ' + e), ...((state && state.log) || [])];
  const text = `PocketSignals ${updater ? updater.version : ''} (${isAndroid ? 'Handy' : isDesktop ? 'PC' : 'Browser'})\n` + lines.join('\n');
  if (await copyText(text)) flash($('#copyLogBtn'), '✓ ' + t('log_copied'));
  else flash($('#copyLogBtn'), '✗ ' + t('copy_failed'), false);
};
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
  const snd = soundOf(s.strategy);
  // The phone plays the strategy's sound with the notification (its own channel); the app only on the PC/browser.
  if (state && state.settings.sound && !isAndroid) beep(snd);
  if (navigator.vibrate) navigator.vibrate([150, 80, 150]);
  const body = `${tr(s.strategyName)} · ${fmtExp(s.expiry)} · ${t('strength')} ${s.strength}`;
  const title = `${s.dir === 'CALL' ? '🟢⬆️' : '🔴⬇️'} ${s.dir} · ${s.name}`;
  if (isAndroid && window.AndroidApp.notifySound) window.AndroidApp.notifySound(title, body, s.name, s.symbol, s.tv, state.settings.sound ? snd : 'none');
  else if (isAndroid) window.AndroidApp.notify(title, body, s.name, s.symbol, s.tv);
  else if (window.Notification && Notification.permission === 'granted' && document.hidden)
    new Notification(`${s.dir} ${s.name}`, { body, icon: 'icon.png' });
  // Auto switch PocketOption to the newest signal (at most once every 10 s).
  if (state && state.settings.auto_po && (isDesktop || isAndroid) && Date.now() - lastAuto > 10000) { lastAuto = Date.now(); setTimeout(() => openPO(s.id, undefined, true), 300); }
}
document.addEventListener('click', () => { if (!isAndroid && window.Notification && Notification.permission === 'default') Notification.requestPermission(); }, { once: true });

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
