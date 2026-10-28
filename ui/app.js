// UI for the desktop overlay, the phone browser and the Android app.
// Transport: the Android app runs the engine inside the page (window.LocalEngine);
// desktop and phone browser talk to the PC server over WebSocket.
const isDesktop = !!window.desktop;
const isAndroid = !!window.AndroidApp;
const $ = s => document.querySelector(s);
let state = null, ws, reqId = 0, dirFilter = 'all', histView = 'list', stratFilter = 'all', stratQuery = '';
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

function render() {
  if (!state) return;
  $('#dot').className = 'dot' + (state.connected ? ' ok' : '');
  $('#mode').textContent = state.demo ? 'DEMO' : 'REAL';
  $('#mode').className = 'mode' + (state.demo ? '' : ' real');
  $('#statusline').textContent = jsError ? '⚠ ' + jsError
    : !state.connected && state.lastError ? `${statusText(state.status)} · ${state.lastError}`
    : `${statusText(state.status)} · ${t('pairs', { n: state.watching })}`;
  document.querySelectorAll('[data-lang]').forEach(b => b.classList.toggle('active', b.dataset.lang === LANG));
  $('#sLang').value = LANG;

  const st = state.stats, open = state.signals.filter(s => !s.result).length;
  $('#stats').innerHTML = `
    <div class="stat"><b>${st.total}</b><span>${t('evaluated')}</span></div>
    <div class="stat"><b style="color:var(--call)">${st.wins}</b><span>${t('won')}</span></div>
    <div class="stat"><b style="color:var(--put)">${st.total - st.wins}</b><span>${t('lost')}</span></div>
    <div class="stat"><b style="color:${st.rate == null ? 'inherit' : rateColor(st.rate)}">${st.rate == null ? '–' : st.rate + '%'}</b><span>${t('winrate')}</span></div>`;

  renderLive();
  $('#liveCount').textContent = open || '';
  // No (working) PocketOption session yet: ask to log in; the app takes the session over automatically.
  $('#loginBox').hidden = !['no_ssid', 'expired'].includes(state.status) || (!isDesktop && !isAndroid);

  $('#hist').hidden = histView !== 'list'; $('#stratStats').hidden = histView !== 'stats';
  $('#hist').innerHTML = state.signals.map(row).join('') || `<p class="empty">${t('no_history')}</p>`;
  $('#stratStats').innerHTML = strategyStats();

  const s = state.settings;
  if (!$('#settings').contains(document.activeElement) || document.activeElement.tagName === 'BUTTON') {
    $('#sOn').checked = s.signals_on; $('#sSound').checked = s.sound; $('#sAuto').checked = s.auto_po; $('#sMini').checked = s.mini_on_blur; $('#sM5').checked = s.show_m5;
    $('#sPoStart').value = s.po_start_mode || 'last'; $('#sTvOpen').value = s.tv_open || 'external'; $('#sTrendTf').value = s.trend_tf || 'M5'; $('#sTrendFilter').checked = s.trend_filter;
    $('#poLastInfo').textContent = s.po_last_mode ? t('po_last_was', { m: t(s.po_last_mode === 'demo' ? 'po_demo' : 'po_real') }) : '';
    $('#sMiniCount').value = String(s.mini_count || 2); $('#sMiniPos').value = s.mini_pos || 'tr'; $('#sMarket').value = s.market; $('#sInterval').value = String(s.scan_interval || 60);
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
const isVisible = s => Date.now() / 1000 < s.entryTime + s.expiry + LINGER;

// Starred signals stay on top (in the order they were starred). Kept per device.
let pins = [];
try { pins = JSON.parse(localStorage.getItem('pins') || '[]'); } catch {}
const savePins = () => { try { localStorage.setItem('pins', JSON.stringify(pins)); } catch {} };
function togglePin(id) {
  pins = pins.includes(id) ? pins.filter(p => p !== id) : [...pins, id];
  savePins(); renderLive();
}
function visibleSignals() {
  const list = state.signals.filter(isVisible);
  const pinned = pins.map(id => list.find(s => s.id === id)).filter(Boolean);
  // Starred first, then strongest to weakest (equal strength: newest first).
  const rest = list.filter(s => !pins.includes(s.id)).sort((a, b) => b.strength - a.strength || b.created - a.created);
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
  const live = all.filter(s => dirFilter === 'all' || s.dir === dirFilter);
  const liveKey = [LANG, state.settings.show_m5, state.settings.trend_tf, ...live.map(sig)].join('|');
  if ($('#live').dataset.key !== liveKey) { $('#live').innerHTML = live.map(card).join(''); $('#live').dataset.key = liveKey; }
  $('#liveEmpty').hidden = live.length > 0;

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
      <div class="ico">${assetIcon(s.name)}</div>
      <div class="pairbox"><div class="pair">${esc(s.name)}</div>
        <div class="pairmeta">${t('payout')} <b>${s.payout}%</b> · ${s.otc ? t('otc') : t('real_market')} ${m5Badge(s)}</div></div>
      ${done && s.result ? resultBadge(s) : `<div class="dir ${s.dir}">${s.dir === 'CALL' ? '▲ CALL' : '▼ PUT'}</div>`}
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
    <div class="timebar${tp.run ? ' run' : ''}" data-entry="${s.entryTime}" data-exp="${s.expiry}" data-created="${created}"><i style="width:${tp.pct}%"></i></div>
    <div class="timer" data-id="${esc(s.id)}" data-entry="${s.entryTime}" data-exp="${s.expiry}">${timerText(s.entryTime, s.expiry)}</div>
    <div class="btns">
      <button class="po" data-po="${esc(s.id)}">PocketOption ↗</button>
      <button class="tv" data-tv="${esc(s.id)}">TradingView ↗</button>
    </div>
  </div>`;
}
function row(s) {
  const res = s.result ? `<span class="res ${s.result}">${I18N.de['res_' + s.result] ? t('res_' + s.result) : s.result}</span>` : `<span class="res">${t('res_running')}</span>`;
  return `<div class="hist"><span class="d ${s.dir}">${s.dir === 'CALL' ? '▲' : '▼'}<br>${s.dir}</span>
    <div class="info"><b>${esc(s.name)}</b><small>${esc(tr(s.strategyName))} · ${s.tf || 'M1'}</small>
      <small>${fmtTime(s.entryTime)} · ${fmtExp(s.expiry)} · ${t('strength')} ${s.strength}</small></div>${res}
    <button class="mini po" data-po="${esc(s.id)}">PO</button><button class="mini" data-tv="${esc(s.id)}">TV</button></div>`;
}
function strategyStats() {
  const by = {};
  for (const s of state.signals) {
    const b = (by[s.strategy] ??= { name: s.strategyName, n: 0, w: 0, l: 0 });
    b.n++; if (s.result === 'WIN') b.w++; if (s.result === 'LOSS') b.l++;
  }
  const rows = Object.values(by).sort((a, b) => b.n - a.n);
  if (!rows.length) return `<p class="empty">${t('no_signals')}</p>`;
  return rows.map(b => {
    const done = b.w + b.l, r = done ? Math.round(100 * b.w / done) : null;
    return `<div class="srow"><div class="top"><b>${esc(tr(b.name))}</b><b style="color:${r == null ? 'var(--muted)' : rateColor(r)}">${r == null ? '–' : r + '%'}</b></div>
      <small>${t('stat_line', { n: b.n, w: b.w, l: b.l })}</small>
      <div class="meter"><i style="width:${r ?? 0}%;background:${r == null ? 'transparent' : rateColor(r)}"></i></div></div>`;
  }).join('');
}

const CATS = ['forex', 'otc', 'po_crypto', 'po_goods', 'po_indices', 'po_stocks'];
// Markets: a switch per market; a market that is on can be opened to choose its pairs one by one.
const openMarkets = new Set();
function renderMarkets(s) {
  const markets = s.markets || {};
  $('#cats').innerHTML = CATS.map(k => {
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
const openStrats = new Set();
function paramInput(key, name, v) {
  const id = `data-sp="${key}" data-param="${name}"`;
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
      ${(x.presets || []).length ? `<div class="presets"><small>${t('presets')}</small>${x.presets.map((pr, n) =>
        `<button class="chip${Object.entries(pr.values).every(([pk, pv]) => x.params[pk] === pv) ? ' active' : ''}" data-preset="${x.key}" data-pn="${n}">${n + 1} · ${esc(tr(pr.name))}</button>`).join('')}</div>` : ''}
      ${Object.entries(x.params).map(([k, v]) => `<label class="prow"><span>${esc(paramLabel(k))}</span>${paramInput(x.key, k, v)}</label>`).join('')}
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
async function openPO(id, tf) {
  const sig = state.signals.find(s => s.id === id);
  const r = await call({ action: 'openPO', id, tf });
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
  const el = e.target.closest('button'); if (!el) return;
  if (el.dataset.pin) togglePin(el.dataset.pin);
  if (el.dataset.po) openPO(el.dataset.po, el.dataset.potf);
  if (el.dataset.tv) { const s = state.signals.find(x => x.id === el.dataset.tv); if (s) openUrl(s.tv); }
  if (el.dataset.tab) {
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b === el));
    document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === el.dataset.tab));
    $('main').scrollTop = 0;
  }
  if (el.dataset.lang) changeLang(el.dataset.lang);
  if (el.dataset.dir) { dirFilter = el.dataset.dir; document.querySelectorAll('[data-dir]').forEach(b => b.classList.toggle('active', b === el)); render(); }
  if (el.dataset.hist) { histView = el.dataset.hist; document.querySelectorAll('[data-hist]').forEach(b => b.classList.toggle('active', b === el)); render(); }
  if (el.dataset.cmd && isDesktop) window.desktop.win(el.dataset.cmd);
  if (el.dataset.mkt) { const k = el.dataset.mkt; openMarkets.has(k) ? openMarkets.delete(k) : openMarkets.add(k); renderMarkets(state.settings); }
  if (el.dataset.pairsAll) setPairs((state.settings.markets[el.dataset.pairsAll] || []).map(p => p.key), []);
  if (el.dataset.pairsNone) setPairs([], (state.settings.markets[el.dataset.pairsNone] || []).map(p => p.key));
  if (el.dataset.open) { const k = el.dataset.open; openStrats.has(k) ? openStrats.delete(k) : openStrats.add(k); renderStrategies(state.settings); }
  if (el.dataset.filter) { stratFilter = el.dataset.filter; renderStrategies(state.settings); }
  if (el.dataset.preset) {
    const x = state.settings.allStrategies.find(s => s.key === el.dataset.preset), pr = x && x.presets[+el.dataset.pn];
    if (pr) { call({ action: 'strategy', name: x.key, patch: pr.values }); toast(t('preset_set', { name: tr(pr.name) })); }
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
  if (el.id === 'sMini') patch.mini_on_blur = el.checked;
  if (el.id === 'sM5') patch.show_m5 = el.checked;
  if (el.id === 'sPoStart') patch.po_start_mode = el.value;
  if (el.id === 'sTvOpen') patch.tv_open = el.value;
  if (el.id === 'sTrendTf') patch.trend_tf = el.value;
  if (el.id === 'sTrendFilter') patch.trend_filter = el.checked;
  if (el.id === 'sMiniCount') patch.mini_count = +el.value;
  if (el.id === 'sMiniPos') patch.mini_pos = el.value;
  if (el.id === 'sMarket') patch.market = el.value;
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
$('#clearBtn').onclick = () => { if (confirm(t('clear_confirm'))) call({ action: 'clear' }); };

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [880, 1175].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain(), t0 = ctx.currentTime + i * 0.15;
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(.18, t0); g.gain.exponentialRampToValueAtTime(.001, t0 + .25); o.start(t0); o.stop(t0 + .25);
    });
  } catch {}
}
let lastAuto = 0;
function onSignal(s) {
  if (state && state.settings.sound) beep();
  if (navigator.vibrate) navigator.vibrate([150, 80, 150]);
  const body = `${tr(s.strategyName)} · ${fmtExp(s.expiry)} · ${t('strength')} ${s.strength}`;
  if (isAndroid) window.AndroidApp.notify(`${s.dir === 'CALL' ? '▲' : '▼'} ${s.dir} ${s.name}`, body, s.name, s.symbol, s.tv);
  else if (window.Notification && Notification.permission === 'granted' && document.hidden)
    new Notification(`${s.dir} ${s.name}`, { body, icon: 'icon.png' });
  // Auto switch PocketOption to the newest signal (at most once every 10 s).
  if (state && state.settings.auto_po && (isDesktop || isAndroid) && Date.now() - lastAuto > 10000) { lastAuto = Date.now(); setTimeout(() => openPO(s.id), 300); }
}
document.addEventListener('click', () => { if (!isAndroid && window.Notification && Notification.permission === 'default') Notification.requestPermission(); }, { once: true });

// Phone: newest release with an .apk on GitHub (the API allows browser requests).
async function checkGithubApk(current) {
  const repo = window.UPDATE_REPO;
  if (!repo) return { ok: false, error: 'update_norepo' };
  const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=15`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) return { ok: false, error: 'update_offline', detail: 'GitHub ' + r.status };
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
