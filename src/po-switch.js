// Script that runs inside the PocketOption page: open the asset list, search the bare name
// (PocketOption finds nothing when " OTC" is part of the query) and click the exact match.
// Resolves to 'ok', 'already', 'not-found', 'no-ui' or 'no-search'. Used by the desktop and Android app.
// expSec > 0: afterwards set the trade expiry (time field of the trading panel) to that many seconds.
function switchScript(name, expSec = 0, lang = 'ru') {
  const q = JSON.stringify(name.replace(/\s*OTC$/i, '')), n = JSON.stringify(name);
  const exp = Math.max(0, Math.round(+expSec || 0));
  return `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 40 && !document.querySelector('.pair-number-wrap'); i++) await wait(500);
  const r = await (async () => {
  const cur = document.querySelector('.current-symbol');
  if (cur && cur.textContent.trim() === ${n}) return 'already';
  const open = document.querySelector('.pair-number-wrap'); if (!open) return 'no-ui';
  open.click(); await wait(700);
  const s = document.querySelector('.search__field'); if (!s) return 'no-search';
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(s, ${q});
  s.dispatchEvent(new Event('input', { bubbles: true }));
  let hit = null;
  for (let i = 0; i < 10 && !hit; i++) {
    await wait(300);
    hit = [...document.querySelectorAll('.alist__item')].find(li => li.querySelector('.alist__label')?.textContent.trim() === ${n});
  }
  if (!hit) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 'not-found'; }
  hit.querySelector('.alist__link').click();
  return 'ok';
  })();
  ${exp ? `if (r === 'ok') await wait(900);
  const e = await (${EXP_FN})(${exp}, ${JSON.stringify(EXP_TXT[lang] || EXP_TXT.en)});
  return r + '|exp-' + e;` : 'return r;'}
})()`;
}

// Sets the expiry in the trading panel with its +/− buttons until the shown time (HH:MM:SS) equals the target.
// The page layout is not documented: the expiry block is found by class name ("expiration") and the value by its
// time format; if anything is missing a hint stays on the page ("set N min yourself"), never a silent wrong time.
const EXP_TXT = { ru: ['мин', 'с', 'поставьте экспирацию вручную'], de: ['Min', 's', 'Ablaufzeit selbst einstellen'], en: ['min', 's', 'set the expiry yourself'] };
const EXP_FN = `async (target, T) => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const hint = (txt, ok) => {
    let h = document.getElementById('__psExpHint');
    if (!h) { h = document.createElement('div'); h.id = '__psExpHint'; document.body.appendChild(h); }
    h.style.cssText = 'position:fixed;left:50%;top:70px;transform:translateX(-50%);z-index:2147483647;padding:10px 16px;border-radius:12px;font:600 15px sans-serif;color:#fff;box-shadow:0 4px 18px #0008;background:' + (ok ? '#16a34a' : '#dc2626');
    h.textContent = txt; clearTimeout(h._t); h._t = setTimeout(() => h.remove(), ok ? 2500 : 7000);
  };
  const label = target >= 60 ? (target / 60) + ' ' + T[0] : target + ' ' + T[1];
  const fmt = s => [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(x => String(x).padStart(2, '0')).join(':');
  // Real layout (seen 04.11.2026): .block--expiration-inputs .value__val shows "00:03:00"; a click on .control__value
  // opens .expiration-inputs-list-modal with presets (.dops__timeframes-item S3…M1 M3 M5 M30 H1 H4) and three rows
  // (.rw: hours, minutes, seconds) each with .btn-plus / input / .btn-minus.
  const parse = t => { const m = /(\\d{1,2}):(\\d{2}):(\\d{2})/.exec(t || ''); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null; };
  const val = () => document.querySelector('.block--expiration-inputs .value__val');
  const read = () => { const v = val(); return v ? parse(v.textContent) : null; };
  const fail = why => { hint('⏱ ' + label + ' — ' + T[2], false); return why; };
  if (!val()) return fail('no-ui');
  if (read() === null) return fail('clock-mode'); // expiry set as clock time, not as duration
  if (read() === target) { hint('⏱ ' + fmt(target) + ' ✓', true); return 'ok'; }
  const modal = () => document.querySelector('.expiration-inputs-list-modal');
  const close = async () => { if (modal()) { document.querySelector('.block--expiration-inputs .control__value').click(); await wait(250); }
    if (modal()) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 27, bubbles: true })); await wait(200); } };
  if (!modal()) { document.querySelector('.block--expiration-inputs .control__value').click(); await wait(500); }
  const m = modal(); if (!m) return fail('no-modal');
  const tag = target % 3600 === 0 ? 'H' + target / 3600 : target % 60 === 0 ? 'M' + target / 60 : 'S' + target;
  const preset = [...m.querySelectorAll('.dops__timeframes-item')].find(x => x.textContent.trim() === tag);
  if (preset) { preset.click(); await wait(300); }
  else {
    const want = [Math.floor(target / 3600), Math.floor(target / 60) % 60, target % 60];
    const rows = [...m.querySelectorAll('.rw')];
    if (rows.length !== 3) { await close(); return fail('no-rows'); }
    for (let r = 0; r < 3; r++) {
      const inp = rows[r].querySelector('input'), plus = rows[r].querySelector('.btn-plus'), minus = rows[r].querySelector('.btn-minus');
      if (!inp || !plus || !minus) { await close(); return fail('no-buttons'); }
      for (let i = 0; i < 70 && +inp.value !== want[r]; i++) {
        const before = +inp.value; (before < want[r] ? plus : minus).click(); await wait(60);
        if (+inp.value === before) { await wait(200); if (+inp.value === before) break; }
      }
    }
    await wait(250);
  }
  await close();
  if (read() === target) { hint('⏱ ' + fmt(target) + ' ✓', true); return 'ok'; }
  return fail('fail:' + (val() ? val().textContent.trim() : '?'));
}`;

// PocketOption trading page for demo or real account. Setting po_start_mode: 'last' (default), 'demo' or 'real';
// po_last_mode is remembered from the page the user was on last.
function poStartUrl(settings, host = 'https://pocketoption.com') {
  const mode = settings.po_start_mode === 'demo' || settings.po_start_mode === 'real' ? settings.po_start_mode : settings.po_last_mode;
  return host + (mode === 'demo' ? '/en/cabinet/demo-quick-high-low/' : '/en/cabinet/quick-high-low/');
}

// 'demo' / 'real' for a PocketOption trading page URL, otherwise null.
function poModeOf(url) {
  if (!/pocketoption\.com\/[a-z-]+\/cabinet\//.test(url || '')) return null;
  if (/\/cabinet\/demo-/.test(url)) return 'demo';
  if (/\/cabinet\/(quick-high-low|high-low|digital|forex)/.test(url)) return 'real';
  return null;
}

module.exports = { switchScript, poStartUrl, poModeOf };
