# PocketSignals (PC + Handy)

## Handy (Android-App)
1. **`PocketSignals.apk`** aufs Handy kopieren (USB, Google Drive, Telegram an dich selbst …) und antippen.
2. Android fragt nach „Installation aus unbekannten Quellen“ → für diese Datei erlauben → Installieren.
3. App öffnen, Benachrichtigungen erlauben.
- Läuft **ohne PC**: die Signal-Engine steckt in der App und prüft jede Minute alle Paare, auch im Hintergrund.
- **PocketOption**-Knopf: öffnet PocketOption in der App und stellt das Paar des Signals ein (beim ersten Mal einloggen, der Login bleibt). Mit „⚡ Signale“ unten links zurück.
- **TradingView**-Knopf: öffnet den Chart in der App.
- Tipp: in den Android-Einstellungen für „PocketSignals“ den Akku-Sparmodus ausschalten, damit Android sie nicht im Hintergrund beendet.

## Neue Versionen (automatisch über GitHub)
Der Quellcode liegt in github.com/Yahya-sm/pocketsignals-updates. Jede Änderung auf `main` startet den Ablauf
`.github/workflows/release.yml`: GitHub baut die PC-Update-Datei und die Handy-APK, zählt die Version hoch
(Patch aus package.json + Laufnummer) und veröffentlicht beides. Die Apps finden es unter „Nach Updates suchen“.
- Ohne PC: in **claude.ai/code** das Repository verbinden und Änderungen beschreiben.
- Vom PC aus hochladen: `node tools/github-sync.js "Was ist neu"` (prüft vorher alle Dateien auf Geheimnisse).
- Den Bau beobachten: `node tools/watch-build.js`.
- Der APK-Signaturschlüssel liegt als Secret `APK_KEYSTORE_B64` bei GitHub (Original: `android/signal-app.keystore`, nicht im Repository – gut aufbewahren).
- Die Setup-Datei (`.exe`) für Neuinstallationen wird weiter am PC gebaut: `node tools/build-pc.js`.

## Updates (PC)
**Online:** Einstellungen → Update → „Nach Updates suchen“ → „Version … installieren“. Die App prüft auch beim Start selbst.
Neue Version veröffentlichen: `node tools/build-pc.js`, danach `node tools/publish.js "Was ist neu"`
(lädt nur die Update-Datei nach github.com/Yahya-sm/pocketsignals-updates; der Schlüssel liegt in `.github-token`).

**Ohne Internet:** In der App: **Einstellungen → Update → „Update-Datei wählen …“** und die Datei
`updates\PocketSignals-Update-<Version>.signalupdate` (ca. 100 KB) auswählen. Die App startet neu, Einstellungen und Verlauf bleiben.
Eine `PocketSignals-Setup.exe` kann dort ebenfalls gewählt werden. Neue Update-Datei bauen: `node tools/build-pc.js`.

## Sprache
Oben rechts **DE / RU / EN** antippen oder unter Einstellungen → Sprache wählen. Gilt für PC und Handy.

## Anderer PC
**`PocketSignals-Setup.exe`** schicken (WeTransfer, Drive, USB …) → doppelklicken → Ordner wählen → Installieren.
Bei „Der Computer wurde durch Windows geschützt“: „Weitere Informationen“ → „Trotzdem ausführen“.
Deinstallieren über Windows → Einstellungen → Apps. (Alternative ohne Setup: `PocketSignals-PC.zip` entpacken, `Installieren.bat`.)
Danach gibt es PocketSignals auf dem Desktop und im Startmenü. Im PocketOption-Fenster der App einloggen –
die Sitzung dieses PCs wird automatisch übernommen. (Nicht den ganzen `app`-Ordner kopieren, der ist zum Entwickeln.)

## PC
**PocketSignals** über die Desktop-Verknüpfung oder das Startmenü öffnen
(installiert in `%LOCALAPPDATA%\Programs\Signal-App`, Daten in `%APPDATA%\PocketSignals\data`).
Neu bauen und installieren: `node tools/build-pc.js` (App vorher schließen).
Zum Entwickeln geht weiterhin `Signal-App starten.bat`.
- Fenster im Handyformat, immer über anderen Apps (📌 schaltet das aus, ◐ macht es durchsichtig). Verschieben: oben an der Leiste ziehen.
- **PocketOption**-Knopf: öffnet ein PocketOption-Fenster und stellt dort das Paar ein.
- **PocketOption automatisch umschalten** (Einstellungen): bei jedem neuen Signal sofort aufs Paar wechseln.

## Einstellungen
Startwerte kommen aus `signal-app-einstellungen.json`. PC speichert in `data/settings.json`, das Handy in der App selbst.
Die PocketOption-Sitzung kommt aus `signal-zugang.txt`. Läuft sie ab, unter Einstellungen eine neue eintragen.

## Neu bauen
- Handy-APK: `powershell -ExecutionPolicy Bypass -File android\build-apk.ps1` (übernimmt die aktuellen PC-Einstellungen als Startwerte).
- Ohne Fenster (z. B. Server): `npm run server`.
