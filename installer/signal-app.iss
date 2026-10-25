; Inno Setup script for PocketSignals. Built by tools/build-pc.js (passes /DSourceDir, /DOutDir and /DAppVer).
#ifndef SourceDir
  #define SourceDir "..\build-pc\PocketSignals-win32-x64"
#endif
#ifndef OutDir
  #define OutDir ".."
#endif
#ifndef AppVer
  #define AppVer "1.0"
#endif

[Setup]
; Same AppId as the earlier "Signal-App" builds, so the setup updates those installations in place.
AppId={{6C1F3A52-8E4B-4D7A-9B2E-5A1D0C7F3E91}
AppName=PocketSignals
AppVersion={#AppVer}
AppPublisher=PocketSignals
DefaultDirName={autopf}\PocketSignals
DefaultGroupName=PocketSignals
DisableDirPage=no
DisableProgramGroupPage=yes
; Installs without admin rights into the user's programs folder; the dialog also allows "for all users".
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir={#OutDir}
OutputBaseFilename=PocketSignals-Setup
SetupIconFile=..\build-pc\icon.ico
UninstallDisplayIcon={app}\PocketSignals.exe
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "de"; MessagesFile: "compiler:Languages\German.isl"
Name: "ru"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; Older builds packed the code as app.asar; it would take precedence over the new resources\app folder.
Type: files; Name: "{app}\resources\app.asar"
; Leftovers from the "Signal-App" name.
Type: files; Name: "{app}\Signal-App.exe"
Type: files; Name: "{autoprograms}\Signal-App.lnk"
Type: files; Name: "{autodesktop}\Signal-App.lnk"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\PocketSignals"; Filename: "{app}\PocketSignals.exe"
Name: "{autodesktop}\PocketSignals"; Filename: "{app}\PocketSignals.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\PocketSignals.exe"; Description: "{cm:LaunchProgram,PocketSignals}"; Flags: nowait postinstall skipifsilent
; Started from the in-app updater (silent): open the app again afterwards.
Filename: "{app}\PocketSignals.exe"; Flags: nowait skipifnotsilent
