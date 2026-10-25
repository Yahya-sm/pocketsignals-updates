// Script that runs inside the PocketOption page: open the asset list, search the bare name
// (PocketOption finds nothing when " OTC" is part of the query) and click the exact match.
// Resolves to 'ok', 'already', 'not-found', 'no-ui' or 'no-search'. Used by the desktop and Android app.
function switchScript(name) {
  const q = JSON.stringify(name.replace(/\s*OTC$/i, '')), n = JSON.stringify(name);
  return `(async () => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  for (let i = 0; i < 40 && !document.querySelector('.pair-number-wrap'); i++) await wait(500);
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
})()`;
}

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
