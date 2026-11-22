# Rust client (work in progress)

An experiment in replacing the Electron app with something lighter: a small Rust program around the system webview,
using [wry](https://github.com/tauri-apps/wry) and [tao](https://github.com/tauri-apps/tao) (WKWebView on macOS, WebView2
on Windows). It shows soundcloud.com under its own title bar, like the Electron app does.

The point is Go+ playback without Electron's Widevine signing: on macOS, WKWebView plays it through FairPlay, and on
Windows, WebView2 plays it through PlayReady.

On Linux it runs on WebKitGTK, which has no DRM. In the custom UI (`UI=custom`, the lightest: about 430 MB playing
a free track and 570 MB once Go+ has played, against 700+ MB for the Electron app), Go+ and other Widevine-only tracks play in the app itself instead
(`src/goplus.rs`): GStreamer, with Sparkle-CDM's decryptor running the Widevine library a browser on the machine has
downloaded (Chrome, Helium, Brave, Vivaldi, Edge or Firefox; `WIDEVINE_CDM_BLOB` points at one). Build those pieces once
with `linux-drm/build.sh` (needs meson, ninja, `gstreamer1-devel`, `gstreamer1-plugins-base-devel` and
`libuuid-devel`); `SC_DRM_DIR` points at a build elsewhere. `./install-linux.sh` builds and installs it all for
you under `~/.local/opt/soundcloud-rust`, with a "SoundCloud" launcher that opens the custom UI. Without a
tray (GNOME needs an AppIndicator extension), closing the window quits instead of hiding it. That runs Google's Widevine library outside a browser, which
is fine for trying on your own machine but not something to ship. With soundcloud.com in the window (the default), Go+
doesn't play on Linux. `ENGINE=browser` shows SoundCloud in an installed Chromium-family browser's own app window
instead (`SC_BROWSER` picks one), on a separate profile, playing Go+ through its Widevine, at several times the memory;
there the browser keeps its window frame, there is one tab, and closing the window quits. Building needs the
`webkit2gtk4.1`, `gtk3`, `libsoup3` and `libayatana-appindicator-gtk3` development packages.

It already has the title bar with search suggestions, settings, Discord Rich Presence, Last.fm, ad blocking, downloads
(yt-dlp), more than one account, a tray icon and updates. While playing it uses less than half the CPU of the
Electron app, and less memory.

## Running it

You need [Rust](https://rustup.rs/).

```bash
cargo run --release
```

The first time, sign in to SoundCloud in the window. A few environment variables help while working on it:
`ADBLOCK=0`, `DISCORD=0`, `LASTFM=0` and `UPDATES=0` turn those parts off, and `TRACE=1` logs media and DRM events.
Each line on stdin runs as JavaScript in the page, which is handy for testing.

On macOS, sign the binary (any Apple Development certificate) so the Keychain remembers its Last.fm items between
builds:

```bash
codesign --force --sign "Apple Development: …" --identifier com.elricfd.fairplay-spike target/release/fairplay-spike
```

## Releases

`./release.sh` builds and signs `SoundCloud.app` and its zip; `./release.sh --publish` also creates the GitHub release
(tagged `rust-v<version>`, marked as a pre-release so the Electron app's updater ignores it). On Windows,
`.\release.ps1` builds the exe's zip, `-Install` puts it in `%LOCALAPPDATA%\Programs\SoundCloud` with a Start menu
shortcut (it takes the Electron app's place, so uninstall that first), and `-Publish` adds the zip to the same release
(whichever platform publishes first creates it). Bump `version` in `Cargo.toml` first. Installed copies check for those
releases at launch and every 6 hours and update themselves when you quit; a build run from `target/` never updates.

## Layout

- `src/main.rs`: the window, the webview and the messages from the page
- `src/browser.rs`: Linux, the page in a browser's app window, driven over the DevTools pipe
- `src/goplus.rs`, `linux-drm/`: Linux, Go+ for the custom UI: the native player, and the build of its Widevine decryptor
  (pinned upstream commits plus patches: thread safety, message framing, sessions from the MP4's own key data, timers)
- `src/chrome.js`: the title bar, settings, downloads panel and tweaks drawn over soundcloud.com
- `src/clean.js`, `src/fixes.js`: hiding SoundCloud's clutter, and two WebKit playback fixes
- `src/downloads.rs`, `src/accounts.rs`, `src/updater.rs`, `src/tray.rs`, `src/lastfm.rs`, `src/presence.rs`,
  `src/adblock.rs`: one feature each
- `src/custom.html`: a fully custom UI built on SoundCloud's API (`UI=custom`); it lacks the newer bar's downloads,
  tabs and settings
