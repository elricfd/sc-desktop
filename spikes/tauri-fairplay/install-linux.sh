#!/usr/bin/env bash
# Installs this build for the current user on Linux, to try it before a
# release: the binary and its Widevine decryptor (linux-drm/build.sh, built
# for where it's installed) under ~/.local/opt/soundcloud-rust, and an app
# launcher that opens the custom UI, the mode where Go+ plays on Linux.
set -euo pipefail
cd "$(dirname "$0")"
prefix=${PREFIX:-$HOME/.local/opt/soundcloud-rust}
share=${XDG_DATA_HOME:-$HOME/.local/share}

cargo build --release
install -Dm755 target/release/fairplay-spike "$prefix/bin/fairplay-spike"
# the app looks for it beside bin/; its libraries find each other by rpath
linux-drm/build.sh "$prefix/linux-drm"
# the Electron app's icon, as its SVG
install -Dm644 ../../assets/icons/soundcloud.svg "$share/icons/hicolor/scalable/apps/soundcloud-rust.svg"
rm -f "$share/icons/hicolor/512x512/apps/soundcloud-rust.png"
mkdir -p "$share/applications"
cat > "$share/applications/soundcloud-rust.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=SoundCloud
Comment=SoundCloud in the Rust client, with Go+
Exec=env UI=custom $prefix/bin/fairplay-spike
Icon=soundcloud-rust
Categories=AudioVideo;Audio;Music;
StartupWMClass=fairplay-spike
Terminal=false
EOF
update-desktop-database "$share/applications" 2>/dev/null || true
echo "Installed into $prefix; open SoundCloud from the app grid."
