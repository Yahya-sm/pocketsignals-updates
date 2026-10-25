# PocketSignals – notes for Claude

Signal app for PocketOption binary options: a **Windows desktop app** (Electron, phone-sized always-on-top window
with a mini view) and an **Android app** (WebView + small Java shell). Both run the same JavaScript engine and UI.
The user speaks **German** (sometimes Russian); answer in German unless asked otherwise. The UI is German/Russian/English.

## Layout
- `src/` – shared engine (runs in Node on the PC **and** in the phone's WebView):
  - `po-client.js` PocketOption socket.io client (raw Engine.IO v4 over WebSocket, binary frames follow a `451-[event…]` frame).
  - `engine.js` scanning, strategies, signals, results, settings/config/signals JSON in a data folder.
  - `strategies.js` 34 strategies (names from the original app, Russian/German/English via `L(ru, de, en)`), `indicators.js`.
  - `assets.js` TradingView symbol mapping, `po-switch.js` script that switches the asset inside the PocketOption page,
    start URL demo/real, `updater.js` PC updates (.signalupdate files + GitHub releases), `server.js` local HTTP/WS server (PC).
- `ui/` – one UI for desktop, phone browser and Android: `index.html`, `app.js`, `i18n.js` (all texts, 3 languages), `style.css`.
- `main.js` / `preload.js` – Electron: window, mini view, PocketOption window (+ DevTools hook that takes over the login), updater.
- `android/` – `MainActivity.java` (3 WebViews: signals, PocketOption, TradingView; JS bridge `AndroidApp`), `PoSocket.java`
  (own WebSocket client so the Origin header can be `https://pocketoption.com`), `SignalService.java` (foreground service).
- `tools/build-mobile.js` bundles `src/*` + shims (fs→localStorage, ws→PoSocket/WebSocket, events, process) into
  `android/app/src/main/assets/www/engine.bundle.js`; `tools/mobile-local.js` is appended and exposes `window.LocalEngine`.
- `defaults/settings.json` – start settings for new installs (no secrets).

## Releases (how updates are made)
- **Push to `main` = new version.** `.github/workflows/release.yml` sets version = package.json patch + run number, builds
  `updates/PocketSignals-Update-<v>.signalupdate` (`tools/build-update.js`) and the APK (`android/build-apk.sh`, signing key
  from secret `APK_KEYSTORE_B64`), then `tools/publish.js … --apk` creates the GitHub release. Apps find it under
  Settings → Update. Docs-only changes (README, ANLEITUNG, CLAUDE.md) don't build.
- Never change the APK package id `com.signalapp.mobile` or the signing key, or phones cannot update.
- Never rename `"name": "signal-app"` in package.json (the PC updater checks it). The visible name is **PocketSignals**.
- The setup .exe (new installs) is built only on the Windows PC: `node tools/build-pc.js` (Inno Setup).

## Security – never commit or publish secrets
- No PocketOption session (`42["auth",{"session":…}]`), API keys, `.github-token`, `*.keystore`, `data/`, `signal-zugang.txt`.
- The APK and update files must contain **no built-in session**; each device takes over its own login
  (PocketOption window/tab) or the user pastes one (Settings → PocketOption session; PC has "Sitzung fürs Handy kopieren").
- `tools/publish.js` and `tools/github-sync.js` scan files for known secrets – keep that.

## Pitfalls we already hit (do not repeat)
- **The phone has no Node:** `src/*` must not use `process`, `Buffer`, `require('fs'|'os'|'child_process')` outside the shims.
  A single `process.env` crashed the phone engine for many versions (empty log, nothing worked). Test the bundle like a phone:
  `node tools/test-bundle.js` (runs it with `process`/`Buffer` undefined) – and ideally in a real browser (`tools/serve-mobile.js`).
- PocketOption accepts the socket only with `Origin: https://pocketoption.com`; servers differ per account/region – use the URL the
  page itself used (`config.poUrl`). Real-account sessions contain IP and user agent; other networks may be rejected.
- `loadHistoryPeriod` returns at most ~150 candles; request indexes must be unique (counter), answers are matched by index.
- PocketOption search finds nothing with " OTC" in the query – search the bare name, click the exact label.
- `chartPeriod` index list is `[5,15,30,60,120,180,300,600,900,1800,3600,14400,86400]` (index 3 = M1, checked by the user).
- Saving chart settings: send `saveCharts` with `settings` as an **object** (a string gets double-encoded).
- PowerShell 5.1 `Get-Content/Set-Content` without `-Encoding` breaks umlauts/Cyrillic – edit files with the editor tools.
- Electron: `transparent: true` window; on `html` keep `overflow:hidden` + a background image, else the body's
  rounded corners are not clipped (CSS propagation). Single-instance lock; server falls back to the next free port.
- Android: notification small icon must be a white silhouette (`res/drawable-*/ic_stat_notify.png`). TradingView sign-in needs
  popups/third-party cookies; by default TradingView opens externally.

## Design rules
- Dark, minimal, rounded: colors are CSS variables in `style.css` (`--bg #0a0e16`, `--card`, `--call` green, `--put` red,
  `--accent` blue). Cards 16 px radius, chips, slim dark scrollbar, bottom tab bar, no white or default controls.
- Every signal card shows: pair icon (AUD over USD), payout, CALL/PUT, **which strategy found it** + reason, timeframe button
  (opens PocketOption on that timeframe), trend badge (clickable), entry/expiry/strength, countdown + progress, PO and TV buttons, star.
- Signals sorted strongest first (starred on top); they disappear at expiry.
- Every new text goes into `ui/i18n.js` in **all three** languages (de, ru, en).
- Give clear feedback on actions (button turns green "✓ Gespeichert", red on error) – the user must see that something happened.
- Keep the mini view (desktop, another app focused) to just the signal rows, no frame.

## Working style the user expects
- Do the whole thing, test it for real (connect to PocketOption, run the bundle phone-like), then report honestly what was and
  was not tested. Don't guess causes – look at logs (Settings → Verbindungsprotokoll) and test hypotheses.
- Don't install/update the user's apps unless asked; give them the update (push → online update).
