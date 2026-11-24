# Windows counterpart of release.sh: builds the exe and its update zip in
# target\release\bundle. -Install copies it to %LOCALAPPDATA%\Programs\SoundCloud
# with a Start menu shortcut (only a copy outside target\ updates itself).
# -Publish adds the zip to the GitHub release rust-v<version> the updater reads
# (src/updater.rs), making that pre-release if the Mac hasn't yet.
# Bump `version` in Cargo.toml first.
param([switch]$Install, [switch]$Publish)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$version = (Select-String -Path Cargo.toml -Pattern '^version = "(.*)"' | Select-Object -First 1).Matches[0].Groups[1].Value
$out = 'target\release\bundle'
$zip = "$out\soundcloud-rust-$version-windows-x86_64.zip"

cargo build --release
if ($LASTEXITCODE) { exit $LASTEXITCODE }
New-Item -ItemType Directory -Force $out | Out-Null
Remove-Item $zip -ErrorAction SilentlyContinue
# the updater looks for fairplay-spike.exe at the zip's root
Compress-Archive -Path target\release\fairplay-spike.exe -DestinationPath $zip
"built $zip"

if ($Install) {
    $dir = "$env:LOCALAPPDATA\Programs\SoundCloud"
    New-Item -ItemType Directory -Force $dir | Out-Null
    Get-Process fairplay-spike -ErrorAction SilentlyContinue | Where-Object Path -eq "$dir\fairplay-spike.exe" | Stop-Process
    Copy-Item target\release\fairplay-spike.exe "$dir\fairplay-spike.exe" -Force
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\SoundCloud.lnk")
    $link.TargetPath = "$dir\fairplay-spike.exe"
    $link.WorkingDirectory = $dir
    $link.Save()
    "installed $dir\fairplay-spike.exe, Start menu: SoundCloud"
}

if ($Publish) {
    $tag = "rust-v$version"
    # (through cmd: PowerShell 5.1 stops on gh's "release not found" on stderr)
    cmd /c "gh release view $tag -R elricfd/sc-desktop >nul 2>&1"
    if ($LASTEXITCODE) {
        gh release create $tag $zip -R elricfd/sc-desktop --target rust-client --prerelease --latest=false `
            --title "Rust client $version" --notes "Builds of the Rust client (spikes/tauri-fairplay). Installed copies update themselves."
    } else {
        gh release upload $tag $zip -R elricfd/sc-desktop --clobber
    }
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
}
