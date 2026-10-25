// Uploads the source code to the GitHub repository (one commit on main, which starts the build) and, with
// --secret, stores the APK signing key as the Actions secret APK_KEYSTORE_B64 (encrypted, never readable again).
// Every file is checked for known sessions/keys first; secrets and build output are never uploaded (see .gitignore).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const repo = pkg.updateRepo;
const token = process.env.GITHUB_TOKEN || fs.readFileSync(path.join(ROOT, '.github-token'), 'utf8').trim();
const api = async (p, opts = {}) => {
  const r = await fetch(`https://api.github.com/repos/${repo}${p}`, {
    ...opts, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'PocketSignals', ...(opts.headers || {}) },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`GitHub ${r.status} ${p}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
};

// Local-only paths (same as .gitignore) plus anything outside the project's own files.
const SKIP = [/^\.github-token$/, /\.keystore$/, /^data\//, /^node_modules\//, /^build-pc\//, /^android\/build\//,
  /^android\/app\/src\/main\/assets\/www\//, /^updates\//, /\.(apk|idsig|exe|zip)$/i, /^ui\/icon-512\.png$/];

function files(dir = ROOT, rel = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (SKIP.some(re => re.test(r) || re.test(r + '/'))) return [];
    return e.isDirectory() ? files(path.join(dir, e.name), r) : [r];
  });
}

function knownSecrets() {
  const out = [token];
  for (const f of [path.join(ROOT, '..', 'signal-zugang.txt'), path.join(ROOT, 'data', 'config.json'), path.join(process.env.APPDATA || '', 'PocketSignals', 'data', 'config.json')]) {
    try { for (const m of fs.readFileSync(f, 'utf8').matchAll(/"session"\s*:\s*"([^"]{8,})"|(?:API_KEY|TOKEN)=([^\s'"]{12,})|session_id\\";s:\d+:\\"([0-9a-f]{16,})/g)) out.push(m[1] || m[2] || m[3]); } catch {}
  }
  return out.filter(Boolean);
}

async function setSecret() {
  const sodium = require('libsodium-wrappers');
  await sodium.ready;
  const key = await api('/actions/secrets/public-key');
  const value = fs.readFileSync(path.join(ROOT, 'android', 'signal-app.keystore')).toString('base64');
  const sealed = sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL));
  await api('/actions/secrets/APK_KEYSTORE_B64', { method: 'PUT', body: JSON.stringify({ encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL), key_id: key.key_id }) });
  console.log('Secret APK_KEYSTORE_B64 gespeichert');
}

async function push(message) {
  const list = files();
  const secrets = knownSecrets();
  for (const f of list) {
    const content = fs.readFileSync(path.join(ROOT, f)).toString('latin1');
    for (const s of secrets) if (content.includes(s)) throw new Error(`Abbruch: ${f} enthält eine Sitzung/einen Schlüssel`);
  }
  console.log(`${list.length} Dateien geprüft – keine der ${secrets.length} bekannten Sitzungen/Schlüssel enthalten`);
  const ref = await api('/git/ref/heads/main');
  const base = await api(`/git/commits/${ref.object.sha}`);
  const tree = [];
  for (const f of list) {
    const blob = await api('/git/blobs', { method: 'POST', body: JSON.stringify({ content: fs.readFileSync(path.join(ROOT, f)).toString('base64'), encoding: 'base64' }) });
    tree.push({ path: f, mode: f.endsWith('.sh') ? '100755' : '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await api('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: base.tree.sha, tree }) });
  const commit = await api('/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: newTree.sha, parents: [ref.object.sha] }) });
  await api('/git/refs/heads/main', { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) });
  console.log('Hochgeladen:', commit.html_url || commit.sha);
}

(async () => {
  if (process.argv.includes('--secret')) await setSecret();
  const msg = process.argv.find(a => !a.startsWith('--') && a !== process.argv[0] && a !== process.argv[1]);
  if (msg) await push(msg);
})().catch(e => { console.error(e.message); process.exit(1); });
