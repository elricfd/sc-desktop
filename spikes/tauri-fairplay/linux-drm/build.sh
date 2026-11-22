#!/usr/bin/env bash
# Builds what the Linux client plays Go+ with (WebKitGTK has no DRM):
# Sparkle-CDM's GStreamer decryptor and OpenCDM library, and the OpenCDM
# module that runs the Widevine library browsers download. Pinned to the
# commits these patches were made and tested against, installed into
# ../target/linux-drm (or $1). Needs meson, ninja, gstreamer1-devel,
# gstreamer1-plugins-base-devel and libuuid-devel.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=$(realpath -m "${1:-$here/../target/linux-drm}")
src=$out/src

# The last Sparkle-CDM before its 2026.0 plugin API, which the module doesn't speak.
SPARKLE=https://github.com/Sparkle-CDM/sparkle-cdm.git
SPARKLE_REV=827cf6d88002d44bb5b68a53d4af1b1edb1aaffc
WIDEVINE=https://github.com/SariskaIO/sparkle-cdm-widevine.git
WIDEVINE_REV=b7c12a89d9a7ca94ce6b3fab2a5121da74ca647d

fetch() { # url rev dir patch
  if [ ! -d "$3/.git" ]; then git clone -q "$1" "$3"; fi
  git -C "$3" fetch -q origin "$2" 2>/dev/null || git -C "$3" fetch -q origin
  git -C "$3" checkout -q --force "$2"
  git -C "$3" apply "$4"
}
mkdir -p "$src"
fetch "$SPARKLE" "$SPARKLE_REV" "$src/sparkle-cdm" "$here/sparkle-cdm.patch"
fetch "$WIDEVINE" "$WIDEVINE_REV" "$src/sparkle-cdm-widevine" "$here/sparkle-cdm-widevine.patch"

# rpath: the decryptor plugin finds libocdm here, wherever it's loaded from
export LDFLAGS="-Wl,-rpath,$out/lib64"
build() { # dir builddir meson-args...
  local dir=$1 b=$2; shift 2
  [ -d "$b" ] || meson setup "$b" "$dir" --prefix="$out" --libdir=lib64 "$@" >/dev/null
  ninja -C "$b" install >/dev/null
}
build "$src/sparkle-cdm" "$out/build/sparkle-cdm" -Dsample-player=disabled -Dclearkey-module=disabled
PKG_CONFIG_PATH="$out/lib64/pkgconfig" build "$src/sparkle-cdm-widevine" "$out/build/sparkle-cdm-widevine"
echo "Built into $out"
