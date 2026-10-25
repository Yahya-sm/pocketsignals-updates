// Builds the PC update file (updates/PocketSignals-Update-<version>.signalupdate): a zip of the app code that the
// installed app copies into resources\app. Works on Windows and Linux (GitHub Actions), no Electron needed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function buildUpdate(version) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  version = version || pkg.version;
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-update-'));
  // App code + its only runtime dependency; the package.json carries the version the updater reports.
  for (const f of ['main.js', 'preload.js']) fs.copyFileSync(path.join(ROOT, f), path.join(stage, f));
  for (const d of ['src', 'ui']) fs.cpSync(path.join(ROOT, d), path.join(stage, d), { recursive: true });
  fs.cpSync(path.join(ROOT, 'node_modules', 'ws'), path.join(stage, 'node_modules', 'ws'), { recursive: true });
  const { devDependencies, ...appPkg } = pkg;
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ ...appPkg, version }, null, 2));

  const outDir = path.join(ROOT, 'updates');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `PocketSignals-Update-${version}.signalupdate`), zip = path.join(stage, '..', `ps-${version}-${Date.now()}.zip`);
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zip}'`]);
  } else {
    execFileSync('zip', ['-qr', zip, '.'], { cwd: stage });
  }
  fs.copyFileSync(zip, out);
  fs.rmSync(zip, { force: true });
  fs.rmSync(stage, { recursive: true, force: true });
  console.log('Update-Datei:', out, Math.round(fs.statSync(out).size / 1024) + ' KB');
  return out;
}

module.exports = { buildUpdate };
if (require.main === module) buildUpdate(process.argv[2]);
