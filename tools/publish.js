// Publishes the current version as a GitHub release, so the apps can update themselves online.
// Needs: "updateRepo": "owner/name" in package.json and a token (repo contents read/write) in
// app/.github-token or the GITHUB_TOKEN environment variable. Run after tools/build-pc.js.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const repo = pkg.updateRepo;
const tokenFile = path.join(ROOT, '.github-token');
const token = process.env.GITHUB_TOKEN || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '');
if (!repo || !token) { console.error('updateRepo in package.json und .github-token werden gebraucht.'); process.exit(1); }

const api = (url, opts = {}) => fetch(url.startsWith('http') ? url : `https://api.github.com/repos/${repo}${url}`, {
  ...opts, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'PocketSignals', ...(opts.headers || {}) },
});

// Refuses to publish a file that contains a known PocketOption session or API key.
function assertNoSecrets(file) {
  const secrets = [];
  const add = text => { for (const m of String(text).matchAll(/"session"\s*:\s*"([^"]{8,})"|(?:API_KEY|TOKEN)=([^\s'"]{12,})/g)) secrets.push(m[1] || m[2]); };
  for (const f of [path.join(ROOT, '..', 'signal-zugang.txt'), path.join(ROOT, 'data', 'config.json'), path.join(process.env.APPDATA || '', 'PocketSignals', 'data', 'config.json')]) {
    try { add(fs.readFileSync(f, 'utf8')); } catch {}
  }
  if (token) secrets.push(token);
  // The APK is a zip; the bundle is stored compressed, so unpack it for the check.
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ps-check-'));
  try {
    fs.copyFileSync(file, path.join(tmp, 'a.zip'));
    if (process.platform === 'win32') require('child_process').execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive '${path.join(tmp, 'a.zip')}' '${path.join(tmp, 'x')}'`]);
    else require('child_process').execFileSync('unzip', ['-q', path.join(tmp, 'a.zip'), '-d', path.join(tmp, 'x')]);
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    for (const f of walk(path.join(tmp, 'x'))) {
      const content = fs.readFileSync(f).toString('latin1');
      for (const s of secrets) if (content.includes(s)) throw new Error(`Abbruch: ${path.basename(file)} enthält eine Sitzung/einen Schlüssel (${path.basename(f)})`);
    }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  console.log(`geprüft: ${path.basename(file)} enthält keine der ${secrets.length} bekannten Sitzungen/Schlüssel`);
}

(async () => {
  const v = pkg.version, tag = 'v' + v;
  const files = [path.join(ROOT, 'updates', `PocketSignals-Update-${v}.signalupdate`)].filter(f => fs.existsSync(f));
  if (!files[0] || !files[0].endsWith('.signalupdate')) throw new Error(`Update-Datei für ${v} fehlt – zuerst node tools/build-pc.js`);
  // --apk: also publish the phone app (built for this version). It must not contain a PocketOption session.
  if (process.argv.includes('--apk')) {
    const apk = path.join(ROOT, 'PocketSignals.apk');
    if (!fs.existsSync(apk)) throw new Error('PocketSignals.apk fehlt – zuerst android\\build-apk.ps1');
    assertNoSecrets(apk);
    files.push(apk);
  }

  // GitHub needs at least one commit before a release can be created.
  const repoInfo = await (await api('')).json();
  if (!repoInfo.pushed_at || repoInfo.size === 0) {
    const readme = '# PocketSignals Updates\n\nUpdate-Dateien für die PocketSignals-App. Die App lädt sie selbst unter Einstellungen → Update.\n';
    const r = await api('/contents/README.md', { method: 'PUT', body: JSON.stringify({ message: 'README', content: Buffer.from(readme).toString('base64') }) });
    if (!r.ok && r.status !== 422) throw new Error(`README: ${r.status} ${await r.text()}`);
  }

  let rel = await api(`/releases/tags/${tag}`);
  if (rel.status === 404) {
    rel = await api('/releases', { method: 'POST', body: JSON.stringify({ tag_name: tag, name: `PocketSignals ${v}`, body: process.argv[2] || '' }) });
  }
  if (!rel.ok) throw new Error(`GitHub ${rel.status}: ${await rel.text()}`);
  rel = await rel.json();

  for (const f of files) {
    const name = path.basename(f);
    const old = (rel.assets || []).find(a => a.name === name);
    if (old) await api(`/releases/assets/${old.id}`, { method: 'DELETE' });
    const up = await api(rel.upload_url.replace(/\{.*\}$/, '') + '?name=' + encodeURIComponent(name), {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: fs.readFileSync(f),
    });
    if (!up.ok) throw new Error(`Upload ${name}: ${up.status} ${await up.text()}`);
    console.log('hochgeladen:', name);
  }
  console.log('Veröffentlicht:', rel.html_url);
})().catch(e => { console.error(e.message); process.exit(1); });
