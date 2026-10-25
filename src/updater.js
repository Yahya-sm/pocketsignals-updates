// Applies a .signalupdate file (zip of the app code, built by tools/build-pc.js) to the installed app folder.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Returns { ok, version } or { ok: false, error, detail }.
function applyUpdateFile(file, appDir) {
  const tmp = path.join(os.tmpdir(), 'signal-update-' + Date.now());
  const zip = tmp + '.zip';
  try {
    // Expand-Archive only accepts files ending in .zip, so unpack a .zip copy of the update file.
    fs.copyFileSync(file, zip);
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${tmp.replace(/'/g, "''")}' -Force`]);
    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, 'package.json'), 'utf8'));
    if (pkg.name !== 'signal-app' || !fs.existsSync(path.join(tmp, 'main.js'))) return { ok: false, error: 'update_invalid' };
    try {
      fs.cpSync(tmp, appDir, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      // Installed "for all users" (e.g. C:\Program Files): copy with admin rights; Windows asks once (UAC).
      const q = s => s.replace(/'/g, "''");
      const script = tmp + '-copy.ps1';
      fs.writeFileSync(script, `Copy-Item -Path '${q(tmp)}\\*' -Destination '${q(appDir)}' -Recurse -Force\r\n`);
      try {
        execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
          `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','"${q(script)}"'`]);
      } catch {
        return { ok: false, error: 'update_admin' }; // UAC prompt declined
      } finally {
        fs.rmSync(script, { force: true });
      }
      const now = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
      if (now.version !== pkg.version) return { ok: false, error: 'update_admin' };
    }
    return { ok: true, version: pkg.version };
  } catch (e) {
    return { ok: false, error: 'update_failed', detail: String(e.message || e).split('\n')[0].slice(0, 160) };
  } finally {
    fs.rmSync(zip, { force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- Online updates from GitHub Releases (repo set as "updateRepo": "owner/name" in package.json) ---

const newer = (a, b) => { // is version a newer than b?
  const x = String(a).replace(/^v/, '').split('.').map(Number), y = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

// Returns { ok, current, latest, available, url, notes } for the newest release that has a file ending in ext
// (.signalupdate for the PC; the phone uses .apk). Releases are newest first.
async function checkOnline(repo, current, ext = '.signalupdate') {
  if (!repo) return { ok: false, error: 'update_norepo' };
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=15`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PocketSignals' } });
    if (r.status === 404) return { ok: true, current, latest: null, available: false };
    if (!r.ok) return { ok: false, error: 'update_offline', detail: 'GitHub ' + r.status };
    const rel = (await r.json()).find(x => !x.draft && (x.assets || []).some(a => a.name.endsWith(ext)));
    if (!rel) return { ok: true, current, latest: null, available: false };
    const asset = rel.assets.find(a => a.name.endsWith(ext));
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    return { ok: true, current, latest, available: newer(latest, current), url: asset.browser_download_url, notes: rel.body || '' };
  } catch (e) {
    return { ok: false, error: 'update_offline', detail: String(e.message || e).slice(0, 120) };
  }
}

// Downloads the release's update file and applies it.
async function installOnline(url, appDir) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'PocketSignals' }, redirect: 'follow' });
    if (!r.ok) return { ok: false, error: 'update_offline', detail: 'Download ' + r.status };
    const file = path.join(os.tmpdir(), `pocketsignals-${Date.now()}.signalupdate`);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    try { return applyUpdateFile(file, appDir); } finally { fs.rmSync(file, { force: true }); }
  } catch (e) {
    return { ok: false, error: 'update_offline', detail: String(e.message || e).slice(0, 120) };
  }
}

module.exports = { applyUpdateFile, checkOnline, installOnline, newer };
