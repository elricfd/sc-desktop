# Windows counterpart of release.sh: builds the exe, its installer (installer.iss,
# needs Inno Setup: winget install JRSoftware.InnoSetup) and the update zip in
# target\release\bundle. -Install runs the installer silently (only a copy
# outside target\ updates itself). -Publish adds both to the GitHub release
# rust-v<version> the updater reads (src/updater.rs), making that pre-release if
# the Mac hasn't yet. Bump `version` in Cargo.toml first.
param([switch]$Install, [switch]$Publish)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$version = (Select-String -Path Cargo.toml -Pattern '^version = "(.*)"' | Select-Object -First 1).Matches[0].Groups[1].Value
$out = 'target\release\bundle'
$zip = "$out\soundcloud-rust-$version-windows-x86_64.zip"
$setup = "$out\soundcloud-rust-$version-windows-x86_64-setup.exe"

cargo build --release
if ($LASTEXITCODE) { exit $LASTEXITCODE }
New-Item -ItemType Directory -Force $out | Out-Null
Remove-Item $zip, $setup -ErrorAction SilentlyContinue
# the updater takes the zip's one exe, whatever the installed copy is called
Copy-Item target\release\fairplay-spike.exe "$out\SoundCloud.exe" -Force
Compress-Archive -Path "$out\SoundCloud.exe" -DestinationPath $zip
Remove-Item "$out\SoundCloud.exe"

# the installer's pictures: the icon's logo on black, small (page corner) and tall (last page)
Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Image]::FromFile("$PSScriptRoot\src\icons\app.png")
foreach ($p in @(@{ n = 'wizard-small'; w = 256; h = 256; s = 256 }, @{ n = 'wizard'; w = 656; h = 1256; s = 600 })) {
    $bmp = New-Object System.Drawing.Bitmap $p.w, $p.h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::Black)
    $g.InterpolationMode = 'HighQualityBicubic'
    $g.DrawImage($icon, [int](($p.w - $p.s) / 2), [int](($p.h - $p.s) / 2), $p.s, $p.s)
    $bmp.Save("$PSScriptRoot\$out\$($p.n).png", [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
}
$icon.Dispose()
$iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw 'Inno Setup 6 not found: winget install JRSoftware.InnoSetup' }
& $iscc /Qp "/DVersion=$version" installer.iss
if ($LASTEXITCODE) { exit $LASTEXITCODE }
"built $zip and $setup"

if ($Install) {
    Start-Process $setup -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES' -Wait
    "installed $env:LOCALAPPDATA\Programs\SoundCloud\SoundCloud.exe, Start menu: SoundCloud"
}

if ($Publish) {
    $tag = "rust-v$version"
    # (through cmd: PowerShell 5.1 stops on gh's "release not found" on stderr)
    cmd /c "gh release view $tag -R elricfd/sc-desktop >nul 2>&1"
    if ($LASTEXITCODE) {
        gh release create $tag $zip $setup -R elricfd/sc-desktop --target main --prerelease --latest=false `
            --title "Rust client $version" --notes "Builds of the Rust client (spikes/tauri-fairplay). Installed copies update themselves."
    } else {
        gh release upload $tag $zip $setup -R elricfd/sc-desktop --clobber
    }
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
}
