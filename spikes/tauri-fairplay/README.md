# Rust client (work in progress)

An experiment in replacing the Electron app with something lighter: a small Rust program around the system webview,
using [wry](https://github.com/tauri-apps/wry) and [tao](https://github.com/tauri-apps/tao) (WKWebView on macOS, WebView2
on Windows). It shows soundcloud.com under its own title bar, like the Electron app does.

The point is Go+ playback without Electron's Widevine signing: on macOS, WKWebView plays it through FairPlay, and on
Windows, WebView2 plays it through PlayReady. Linux isn't done yet.

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
(tagged `rust-v<version>`, marked as a pre-release so the Electron app's updater ignores it). Installed copies check
for those releases and update themselves when you quit.

## Layout

- `src/main.rs`: the window, the webview and the messages from the page
- `src/chrome.js`: the title bar, settings, downloads panel and tweaks drawn over soundcloud.com
- `src/clean.js`, `src/fixes.js`: hiding SoundCloud's clutter, and two WebKit playback fixes
- `src/downloads.rs`, `src/accounts.rs`, `src/updater.rs`, `src/tray.rs`, `src/lastfm.rs`, `src/presence.rs`,
  `src/adblock.rs`: one feature each
- `src/custom.html`: an older, fully custom UI built on SoundCloud's API (`UI=custom`), no longer worked on
