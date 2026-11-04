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
  const blocks = [...document.querySelectorAll('[class*="expiration"], [class*="Expiration"]')].filter(b => b.offsetParent);
  const parse = t => { const m = /(\\d{1,2}):(\\d{2}):(\\d{2})/.exec(t || ''); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null; };
  const block = blocks.find(b => parse(b.textContent) !== null && b.querySelector('[class*="plus"], [class*="minus"]'))
    || blocks.find(b => parse(b.textContent) !== null);
  if (!block) { hint('⏱ ' + label + ' — ' + T[2], false); return 'no-ui'; }
  const read = () => { const v = [...block.querySelectorAll('*')].map(x => x.childElementCount ? null : parse(x.textContent)).find(x => x !== null); return v ?? parse(block.textContent); };
  const btn = k => block.querySelector('[class*="' + k + '"]');
  const plus = btn('plus'), minus = btn('minus');
  if (!plus || !minus) { hint('⏱ ' + label + ' — ' + T[2], false); return 'no-buttons'; }
  for (let i = 0; i < 40; i++) {
    const v = read(); if (v === null) break;
    if (v === target) { hint('⏱ ' + fmt(target) + ' ✓', true); return 'ok'; }
    (v < target ? plus : minus).click(); await wait(150);
    const v2 = read(); if (v2 === v) { await wait(250); if (read() === v) break; }
    if (v < target && v2 > target || v > target && v2 < target) break; // no exact step for this time
  }
  hint('⏱ ' + label + ' — ' + T[2], false); return 'fail';
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
