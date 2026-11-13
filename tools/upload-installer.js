// Uploads PocketSignals-Setup.exe to a fixed release "installer" (stable download link). Token is read from the file, never printed.
const fs = require('fs');
const APP = 'C:/Users/ycher/Documents/signal-app/app';
const token = fs.readFileSync(APP + '/.github-token', 'utf8').trim();
const repo = 'Yahya-sm/pocketsignals-updates', ver = process.argv[2];
const H = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'PocketSignals-build' };
(async () => {
  let r = await fetch(`https://api.github.com/repos/${repo}/releases/tags/installer`, { headers: H });
  let rel;
  const body = `Установщик PocketSignals для Windows (версия ${ver}). Скачайте PocketSignals-Setup.exe и запустите. Дальнейшие обновления приходят в самой программе (Настройки → Обновление).\n\nPocketSignals installer for Windows (version ${ver}). Later updates arrive inside the app.`;
  if (r.status === 404) {
    r = await fetch(`https://api.github.com/repos/${repo}/releases`, { method: 'POST', headers: H, body: JSON.stringify({ tag_name: 'installer', target_commitish: 'main', name: 'PocketSignals – установщик для Windows', body, make_latest: 'false' }) });
    rel = await r.json(); if (!r.ok) throw new Error('create ' + r.status + ' ' + JSON.stringify(rel).slice(0, 200));
  } else {
    rel = await r.json();
    await fetch(`https://api.github.com/repos/${repo}/releases/${rel.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ body, make_latest: 'false' }) });
    for (const a of rel.assets || []) if (a.name === 'PocketSignals-Setup.exe') await fetch(`https://api.github.com/repos/${repo}/releases/assets/${a.id}`, { method: 'DELETE', headers: H });
  }
  const data = fs.readFileSync(APP + '/PocketSignals-Setup.exe');
  r = await fetch(`https://uploads.github.com/repos/${repo}/releases/${rel.id}/assets?name=PocketSignals-Setup.exe`, { method: 'POST', headers: { ...H, 'Content-Type': 'application/octet-stream', 'Content-Length': String(data.length) }, body: data });
  const a = await r.json(); if (!r.ok) throw new Error('upload ' + r.status + ' ' + JSON.stringify(a).slice(0, 200));
  console.log('ok', a.browser_download_url, Math.round(a.size / 1048576) + ' MB');
})().catch(e => { console.error(String(e.message).replace(token, '***')); process.exit(1); });
