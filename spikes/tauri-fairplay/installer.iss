; Windows installer of the Rust client (Inno Setup 6.6+); release.ps1 builds it.
; Per user, no admin: the app's updater replaces SoundCloud.exe in place.
; Silent: soundcloud-rust-<version>-windows-x86_64-setup.exe /VERYSILENT
[Setup]
AppId={{B6F3C1E2-5D0A-4B7E-9C1F-2A8E4D7F1A60}
AppName=SoundCloud
AppVersion={#Version}
AppPublisher=sc-desktop
AppPublisherURL=https://github.com/elricfd/sc-desktop
DefaultDirName={localappdata}\Programs\SoundCloud
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=target\release\bundle
OutputBaseFilename=soundcloud-rust-{#Version}-windows-x86_64-setup
SetupIconFile=..\..\assets\icons\soundcloud-win.ico
UninstallDisplayIcon={app}\SoundCloud.exe
UninstallDisplayName=SoundCloud
VersionInfoVersion={#Version}
Compression=lzma2/max
SolidCompression=yes
; we stop the app ourselves ([Code]): Restart Manager misses it hidden in the tray
CloseApplications=no
WizardStyle=modern dark
WizardBackColor=#121212
; made by release.ps1 from the app icon
WizardImageFile=target\release\bundle\wizard.png
WizardSmallImageFile=target\release\bundle\wizard-small.png

[Messages]
FinishedHeadingLabel=SoundCloud is installed
FinishedLabel=It's in the Start menu, and keeps itself up to date.

[Tasks]
Name: desktopicon; Description: "{cm:CreateDesktopIcon}"; Flags: unchecked

[Files]
Source: "target\release\fairplay-spike.exe"; DestDir: "{app}"; DestName: "SoundCloud.exe"; Flags: ignoreversion

[InstallDelete]
; the copy release.ps1 -Install made before there was an installer
Type: files; Name: "{app}\fairplay-spike.exe"
Type: files; Name: "{app}\fairplay-spike.old"

[UninstallDelete]
; left by the updater
Type: files; Name: "{app}\SoundCloud.old"

[Icons]
Name: "{autoprograms}\SoundCloud"; Filename: "{app}\SoundCloud.exe"
Name: "{autodesktop}\SoundCloud"; Filename: "{app}\SoundCloud.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\SoundCloud.exe"; Description: "{cm:LaunchProgram,SoundCloud}"; Flags: nowait postinstall skipifsilent

[Code]
// The running app from this folder, old name or new, so its exe can be replaced.
procedure StopApp;
var
  R: Integer;
begin
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -Command "Get-Process SoundCloud, fairplay-spike -ErrorAction SilentlyContinue | Where-Object Path -like ''' +
    ExpandConstant('{app}') + '\*'' | Stop-Process -Force"', '', SW_HIDE, ewWaitUntilTerminated, R);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopApp;
  Result := '';
end;

function InitializeUninstall: Boolean;
begin
  StopApp;
  Result := True;
end;
