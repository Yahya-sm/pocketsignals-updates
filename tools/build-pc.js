// Builds the installed desktop app: PocketSignals.exe in %LOCALAPPDATA%\Programs\PocketSignals,
// plus desktop and start-menu shortcuts. Current settings and the PocketOption session become the defaults.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { packager } = require('@electron/packager');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build-pc');
const TARGET = path.join(process.env.LOCALAPPDATA, 'Programs', 'PocketSignals');

// ICO file with a single embedded PNG (supported since Windows Vista).
function writeIco(png, out) {
  const img = fs.readFileSync(png), h = Buffer.alloc(22);
  h.writeUInt16LE(0, 0); h.writeUInt16LE(1, 2); h.writeUInt16LE(1, 4);
  h[6] = 0; h[7] = 0; h[8] = 0; h[9] = 0; // 0 = 256 px
  h.writeUInt16LE(1, 10); h.writeUInt16LE(32, 12); h.writeUInt32LE(img.length, 14); h.writeUInt32LE(22, 18);
  fs.writeFileSync(out, Buffer.concat([h, img]));
}

function defaults() {
  const dir = path.join(BUILD, 'defaults');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'defaults', 'settings.json'), path.join(dir, 'settings.json'));
  // No built-in PocketOption session: a new installation takes over the login from its PocketOption window.
  // Existing installations keep their own session (their config.json is not overwritten).
  return dir;
}

// Every build gets the next patch version (1.0.3 -> 1.0.4), shown in the app and in the update file name.
function bumpVersion() {
  const file = path.join(ROOT, 'package.json'), pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const v = pkg.version.split('.').map(Number); v[2]++;
  pkg.version = v.join('.');
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  return pkg.version;
}

(async () => {
  const version = bumpVersion();
  console.log('Version', version);
  fs.rmSync(BUILD, { recursive: true, force: true });
  fs.mkdirSync(BUILD, { recursive: true });
  writeIco(path.join(ROOT, 'ui', 'icon.png'), path.join(BUILD, 'icon.ico'));
  const [out] = await packager({
    dir: ROOT, out: BUILD, name: 'PocketSignals', executableName: 'PocketSignals', platform: 'win32', arch: 'x64',
    // No asar: the code stays a plain folder (resources/app) so the in-app updater can replace it.
    icon: path.join(BUILD, 'icon.ico'), overwrite: true, asar: false, prune: true, appVersion: version,
    extraResource: [defaults()],
    // Keep earlier build outputs (zip, setup, apk) out of the app.
    ignore: [/^\/android/, /^\/build-pc/, /^\/data/, /^\/tools/, /^\/installer/, /^\/updates/, /^\/\.github-token/, /\.apk$/, /\.idsig$/, /\.zip$/, /\.exe$/, /\.bat$/, /\.md$/],
    win32metadata: { CompanyName: 'PocketSignals', ProductName: 'PocketSignals', FileDescription: 'PocketSignals' },
  });
  // Portable package for other PCs: PocketSignals-PC.zip with the app and an installer script.
  const pkg = path.join(BUILD, 'PocketSignals-PC');
  fs.mkdirSync(pkg, { recursive: true });
  fs.cpSync(out, path.join(pkg, 'PocketSignals'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'Installieren.bat'), [
    '@echo off',
    'rem Installs PocketSignals for the current user and creates desktop and start-menu shortcuts.',
    'set "T=%LOCALAPPDATA%\\Programs\\PocketSignals"',
    'taskkill /im PocketSignals.exe /f >nul 2>&1',
    'robocopy "%~dp0PocketSignals" "%T%" /MIR /NFL /NDL /NJH /NJS /NP >nul',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=New-Object -ComObject WScript.Shell; foreach($d in @([Environment]::GetFolderPath(\'Desktop\'), (Join-Path $env:APPDATA \'Microsoft\\Windows\\Start Menu\\Programs\'))){ $l=$s.CreateShortcut((Join-Path $d \'PocketSignals.lnk\')); $l.TargetPath=$env:T+\'\\PocketSignals.exe\'; $l.WorkingDirectory=$env:T; $l.Save() }"',
    'start "" "%T%\\PocketSignals.exe"',
    '',
  ].join('\r\n'));
  const zip = path.join(ROOT, 'PocketSignals-PC.zip');
  fs.rmSync(zip, { force: true });
  execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${pkg}\\*' -DestinationPath '${zip}'`]);
  console.log('Paket für andere PCs:', zip);

  // Small update file for the in-app updater: a zip of resources/app, named .signalupdate.
  const updates = path.join(ROOT, 'updates');
  fs.mkdirSync(updates, { recursive: true });
  const upd = path.join(updates, `PocketSignals-Update-${version}.signalupdate`), tmpZip = path.join(BUILD, 'update.zip');
  execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${path.join(out, 'resources', 'app')}\\*' -DestinationPath '${tmpZip}'`]);
  fs.copyFileSync(tmpZip, upd);
  console.log('Update-Datei:', upd, Math.round(fs.statSync(upd).size / 1024) + ' KB');

  // Real installer (wizard with folder choice, shortcuts, uninstall) if Inno Setup is available.
  const iscc = path.join(process.env.USERPROFILE, 'Android', 'innosetup', 'ISCC.exe');
  if (fs.existsSync(iscc)) {
    execFileSync(iscc, ['/Q', `/DSourceDir=${out}`, `/DOutDir=${ROOT}`, `/DAppVer=${version}`, path.join(ROOT, 'installer', 'signal-app.iss')], { stdio: 'inherit' });
    console.log('Setup-Datei:', path.join(ROOT, 'PocketSignals-Setup.exe'));
  }

  // The installed app is updated by the user through the in-app updater; `--install` installs right away instead.
  if (process.argv.includes('--install')) {
    const setup = path.join(ROOT, 'PocketSignals-Setup.exe');
    execFileSync(setup, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS']);
    console.log('Installiert:', path.join(TARGET, 'PocketSignals.exe'));
  }
})().catch(e => { console.error(e); process.exit(1); });
