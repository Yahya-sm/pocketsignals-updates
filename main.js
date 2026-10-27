// Desktop app: a phone-sized, always-on-top window with the signal list,
// plus a PocketOption window that the PO button switches to the signal's asset.
const { app, BrowserWindow, shell, ipcMain, screen, Menu, Tray, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { applyUpdateFile, checkOnline, installOnline } = require('./src/updater');
const UPDATE_REPO = require('./package.json').updateRepo || '';

// Installed app: keep settings, session and history in the user's profile; seed them once from the bundled defaults.
// The app was called "Signal-App" before; its data folder is taken over on the first start as PocketSignals.
app.setName('PocketSignals');if (app.isPackaged) {
  const data = path.join(app.getPath('userData'), 'data');
  const old = path.join(app.getPath('appData'), 'Signal-App', 'data');
  if (!fs.existsSync(data) && fs.existsSync(old)) fs.cpSync(old, data, { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  for (const f of ['settings.json', 'config.json']) {
    const src = path.join(process.resourcesPath, 'defaults', f), dst = path.join(data, f);
    if (!fs.existsSync(dst) && fs.existsSync(src)) fs.copyFileSync(src, dst);
  }
  process.env.SIGNAL_DATA = data;
}

const Engine = require('./src/engine');
const { startServer } = require('./src/server');

const PORT = Number(process.env.PORT) || 7777;
let win, poWin, tray, poTarget, engine, port = PORT;

const { switchScript, poStartUrl, poModeOf } = require('./src/po-switch');

// Remembers whether the user was last on the demo or the real account page.
function rememberPoMode(url) {
  const mode = poModeOf(url);
  if (mode && mode !== engine.settings.po_last_mode) engine.updateSettings({ po_last_mode: mode });
}

// withTimeframe: the chart timeframe was saved into the account too; the page picks it up by reloading.
function openPocketOption(symbol, name, withTimeframe = false) {
  // If the list has no exact match, reload: the asset was already saved into the account chart.
  // Only a direct switch may reload, so a fresh page load never ends up in a reload loop.
  poTarget = name; // null: just open PocketOption (e.g. to log in)
  const run = (allowReload = false) => !poTarget ? Promise.resolve() : poWin.webContents.executeJavaScript(switchScript(poTarget))
    .then(r => { if (r === 'not-found' && allowReload) poWin.webContents.reload(); }).catch(() => {});
  if (poWin && !poWin.isDestroyed()) {
    poWin.show(); poWin.focus();
    if (withTimeframe) { setTimeout(() => poWin.webContents.reload(), 700); return; } // give the server time to store it
    if (/pocketoption\.com\/.+\/cabinet/.test(poWin.webContents.getURL()) && !poWin.webContents.isLoading()) run(true);
    return; // otherwise the did-finish-load listener below switches once the page is ready
  }
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  poWin = new BrowserWindow({
    width: Math.min(1400, width - 420), height: Math.min(900, height), x: 0, y: 0, title: 'PocketOption',
    autoHideMenuBar: true,
    webPreferences: { partition: 'persist:pocketoption', contextIsolation: true },
  });
  watchPoLogin(poWin);
  poWin.loadURL(poStartUrl(engine.settings)); // demo or real, as last time or as set in the settings
  poWin.webContents.on('did-navigate', (_e, url) => rememberPoMode(url));
  poWin.webContents.on('did-navigate-in-page', (_e, url) => rememberPoMode(url));
  // Wait for the trading UI (the user may need to log in once; the session is kept).
  poWin.webContents.on('did-finish-load', () => { if (/cabinet/.test(poWin.webContents.getURL())) run(); });
  poWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

// Reads the PocketOption page's own 42["auth",…] socket message (via the DevTools protocol), so the app
// uses the session of whoever logged in on this PC instead of the one it was built with.
function watchPoLogin(w) {
  const dbg = w.webContents.debugger;
  try { dbg.attach('1.3'); } catch { return; }
  dbg.sendCommand('Network.enable').catch(() => {});
  const urls = {}; // requestId -> socket URL, so the app uses the same server as the page
  dbg.on('message', (_e, method, params) => {
    if (method === 'Network.webSocketCreated') { urls[params.requestId] = params.url; return; }
    if (method !== 'Network.webSocketFrameSent') return;
    const msg = params.response && params.response.payloadData;
    if (typeof msg === 'string' && msg.startsWith('42["auth"') && msg.includes('"session"')) engine.setSsid(msg, urls[params.requestId], true);
  });
}

// Updater: the user picks a .signalupdate file (zip of the app code, built by tools/build-pc.js) or a
// PocketSignals-Setup.exe. Settings, session and history live in the profile and are not touched.
async function installUpdate() {
  if (!app.isPackaged) return { ok: false, error: 'update_dev' };
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'PocketSignals Update', extensions: ['signalupdate', 'exe'] }],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  const file = r.filePaths[0];

  if (/\.exe$/i.test(file)) {
    // Full setup: runs silently over the existing installation and starts the app again.
    spawn(file, ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CLOSEAPPLICATIONS'], { detached: true, stdio: 'ignore' }).unref();
    setTimeout(() => app.exit(0), 500);
    return { ok: true };
  }

  const res = applyUpdateFile(file, path.join(process.resourcesPath, 'app'));
  if (res.ok) setTimeout(() => { app.relaunch(); app.exit(0); }, 1200);
  return res;
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const w = 400, h = Math.min(820, height - 20);
  win = new BrowserWindow({
    width: w, height: h, x: width - w - 10, y: Math.round((height - h) / 2),
    minWidth: 320, minHeight: 480, frame: false, resizable: true, alwaysOnTop: true,
    // Transparent: the page draws the rounded window itself, and the mini view shows only the signal cards.
    skipTaskbar: false, transparent: true, backgroundColor: '#00000000', hasShadow: false, title: 'PocketSignals',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver'); // stays above full-screen apps and browser windows too
  win.setVisibleOnAllWorkspaces(true);
  win.loadURL(`http://127.0.0.1:${port}/?desktop=1`);
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; app.quit(); });
  // Mini view: only the header button shrinks to the current signals. A click on the mini view
  // (not on a star) restores the full window via the 'expand' message; the star pins a signal instead.
  // Focus from outside (taskbar, Alt+Tab, tray) opens the full window. A click inside the mini view also focuses
  // it – the page reports such clicks ('mini-pointer'), and then the mini view stays (star, drag grip).
  // Shrinking itself can make Windows report a focus, so focus right after shrinking is ignored.
  win.on('focus', () => {
    if (!compact || Date.now() - compactAt < 800) return;
    setTimeout(() => {
      if (win && compact && win.isFocused() && Date.now() - lastMiniPointer > 600) setCompact(false);
    }, 250);
  });
  // Dragging the mini view by its grip also focuses the window: that counts like a click inside, it stays small.
  win.on('will-move', () => { if (compact) lastMiniPointer = Date.now(); });
  // Dragging the mini view remembers that spot ("custom" position).
  win.on('moved', () => {
    if (!compact || placing) return;
    const b = win.getBounds();
    engine.updateSettings({ mini_pos: 'custom', mini_custom: { x: b.x, y: b.y } });
  });
}

let compact = false, fullBounds = null, miniH = 80, placing = false, lastPos = null, lastMiniPointer = 0, compactAt = 0;
const MINI_W = 300, GAP = 12;

// Puts the mini view at the chosen screen position (settings: mini_pos), keeping bottom positions anchored
// to the bottom when its height changes. 'custom' = where the user last dragged it.
function placeMini() {
  const s = engine.settings, pos = s.mini_pos || 'tr';
  const wa = screen.getDisplayMatching(fullBounds || win.getBounds()).workArea;
  let x, y;
  if (pos === 'custom' && s.mini_custom) {
    x = Math.min(Math.max(s.mini_custom.x, wa.x), wa.x + wa.width - MINI_W);
    y = Math.min(Math.max(s.mini_custom.y, wa.y), wa.y + wa.height - miniH);
  } else {
    x = pos.endsWith('l') ? wa.x + GAP : pos.endsWith('c') ? wa.x + Math.round((wa.width - MINI_W) / 2) : wa.x + wa.width - MINI_W - GAP;
    y = pos.startsWith('b') ? wa.y + wa.height - miniH - GAP : wa.y + GAP;
  }
  placing = true;
  win.setBounds({ x, y, width: MINI_W, height: miniH });
  setTimeout(() => { placing = false; }, 300);
}

// Only the "small" button in the window header shrinks the window (the user wants no automatic shrinking).
function setCompact(on, manual = false) {
  if (!win || on === compact) return;
  if (on && !manual) return;
  compact = on;
  if (on) {
    compactAt = Date.now();
    fullBounds = win.getBounds();
    win.setMinimumSize(200, 40);
    placeMini();
  } else {
    win.setMinimumSize(320, 480);
    if (fullBounds) win.setBounds(fullBounds);
  }
  win.webContents.send('compact', on);
}

// Only one instance: starting the app again (e.g. from the desktop shortcut) brings the open window to the front.
const firstInstance = app.requestSingleInstanceLock();
if (!firstInstance) app.exit(0);
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  setCompact(false); win.show(); win.focus();
});

app.whenReady().then(async () => {
  if (!firstInstance) return;
  Menu.setApplicationMenu(null);
  engine = new Engine();
  engine.start();
  ({ port } = await startServer(engine, { port: PORT, onOpenPO: openPocketOption }));

  ipcMain.on('win', (_e, cmd) => {
    if (!win) return;
    if (cmd === 'min') win.minimize();
    if (cmd === 'mini') setCompact(true, true);
    if (cmd === 'close') win.close();
    if (cmd === 'pin') { const on = !win.isAlwaysOnTop(); win.setAlwaysOnTop(on, 'screen-saver'); win.webContents.send('pinned', on); }
    if (cmd === 'opacity') { const o = win.getOpacity(); win.setOpacity(o > 0.9 ? 0.85 : o > 0.7 ? 0.65 : 1); }
  });
  ipcMain.on('open-external', (_e, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
  ipcMain.on('version', e => { e.returnValue = app.getVersion(); });
  // The mini view reports the height its content needs.
  ipcMain.on('expand', () => { if (win) { setCompact(false); win.focus(); } });
  ipcMain.on('mini-pointer', () => { lastMiniPointer = Date.now(); });
  ipcMain.on('mini-height', (_e, h) => {
    miniH = Math.max(40, Math.min(520, Math.round(h)));
    if (win && compact) placeMini();
  });
  // Position changed in the settings while the mini view is shown.
  engine.on('state', () => { if (win && compact && engine.settings.mini_pos !== lastPos) { lastPos = engine.settings.mini_pos; if (lastPos !== 'custom') placeMini(); } });
  ipcMain.handle('install-update', () => installUpdate());
  ipcMain.handle('check-online', () => checkOnline(UPDATE_REPO, app.getVersion()));
  ipcMain.handle('install-online', async (_e, url) => {
    if (!app.isPackaged) return { ok: false, error: 'update_dev' };
    if (!/^https:\/\/(github\.com|objects\.githubusercontent\.com)\//.test(url || '')) return { ok: false, error: 'update_invalid' };
    const res = await installOnline(url, path.join(process.resourcesPath, 'app'));
    if (res.ok) setTimeout(() => { app.relaunch(); app.exit(0); }, 1200);
    return res;
  });

  createWindow();
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'ui', 'icon.png')));
  tray.setToolTip('PocketSignals');
  tray.on('click', () => { if (!win) return; if (compact) { setCompact(false); win.focus(); } else if (win.isVisible()) win.hide(); else win.show(); });
});

app.on('window-all-closed', () => app.quit());
