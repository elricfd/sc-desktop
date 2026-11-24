#!/bin/zsh
# Builds SoundCloud.app (macOS; it replaces the Electron app of the same name),
# signed with the Apple Development identity, and its update zip in
# target/release/bundle. With --publish it also makes the
# GitHub release the updater reads (src/updater.rs): tag rust-v<version>,
# a pre-release, never "latest", so the Electron app's updater ignores it.
# Bump `version` in Cargo.toml first.
set -euo pipefail
cd "${0:A:h}"

version=$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
arch=$(uname -m | sed 's/arm64/aarch64/')
out=target/release/bundle
app="$out/SoundCloud.app"
zip=$out/soundcloud-rust-$version-macos-$arch.zip

cargo build --release
rm -rf "$out" && mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp target/release/fairplay-spike "$app/Contents/MacOS/"
cp ../../assets/icons/soundcloud-mac.icns "$app/Contents/Resources/app.icns"
# The bundle id stays fairplay-spike: WebKit keeps the sign-in under it
# (~/Library/WebKit/fairplay-spike, HTTPStorages/fairplay-spike.binarycookies).
cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>SoundCloud</string>
  <key>CFBundleDisplayName</key><string>SoundCloud</string>
  <key>CFBundleIdentifier</key><string>fairplay-spike</string>
  <key>CFBundleExecutable</key><string>fairplay-spike</string>
  <key>CFBundleIconFile</key><string>app</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
EOF
# Same signing identifier as the dev binary, so Keychain's "Always Allow"
# (Last.fm) carries over and the updater's signature check matches.
identity=$(security find-identity -v -p codesigning | grep -o '"Apple Development[^"]*"' | head -1 | tr -d '"')
codesign --force --sign "$identity" --identifier com.elricfd.fairplay-spike "$app"
codesign --verify --deep --strict "$app"
ditto -c -k --keepParent "$app" "$zip"
echo "built $app and $zip"

if [[ ${1:-} == --publish ]]; then
  # release.ps1 may have made the release already with the Windows zip
  if gh release view "rust-v$version" -R elricfd/sc-desktop >/dev/null 2>&1; then
    gh release upload "rust-v$version" "$zip" -R elricfd/sc-desktop --clobber
  else
    gh release create "rust-v$version" "$zip" -R elricfd/sc-desktop --target main \
      --prerelease --latest=false --title "Rust client $version" \
      --notes "Builds of the Rust client (spikes/tauri-fairplay). Installed copies update themselves."
  fi
fi
