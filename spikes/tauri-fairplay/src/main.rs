// SoundCloud in a Rust window (wry = the WKWebView Tauri uses on macOS), with
// FairPlay so Go+ tracks play (page fixes in fixes.js), SoundCloud's clutter
// hidden (clean.js), ad/tracker hosts blocked (adblock.rs) and the current
// track shown in Discord (nowplaying.js -> presence.rs). Env: ADBLOCK=0 and
// DISCORD=0 turn those off, TRACE=1 logs media/DRM/hls.js events to stdout.
// UI=custom swaps SoundCloud's site for our own page (custom.html), which
// talks to SoundCloud's API and plays streams itself, with our own title bar
// and settings panel (saved in settings.json; env vars above override it).
// Each stdin line is JavaScript run in the page, so tests can drive it.
mod adblock;
mod lastfm;
mod presence;

use tao::{
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::WindowBuilder,
};
use wry::WebViewBuilder;

// Present as the Safari installed on this Mac: SoundCloud then serves its
// FairPlay stream, and the version matches the WebKit we really run (a stale
// one is a mismatch bot checks can see).
fn safari_ua() -> String {
    let version = std::process::Command::new("defaults")
        .args(["read", "/Applications/Safari.app/Contents/Info.plist", "CFBundleShortVersionString"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "18.0".into());
    format!(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 \
         (KHTML, like Gecko) Version/{version} Safari/605.1.15"
    )
}

fn main() -> wry::Result<()> {
    let settings = load_settings();
    let setting = |k: &str| settings[k].as_bool().unwrap_or(true);
    let on = |k: &str, default: bool| std::env::var(k).map(|v| v != "0").unwrap_or(default);

    let url = std::env::args().nth(1).unwrap_or_else(|| "https://soundcloud.com".into());
    let adblock = on("ADBLOCK", setting("adblock"));
    let custom = std::env::var("UI").as_deref() == Ok("custom");
    // Discord can be switched off and on from the settings panel while running.
    let discord = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(on("DISCORD", setting("discord"))));
    let (np_tx, np_rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || presence::run(np_rx));
    let scrobbling = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(settings["lastfm"].as_bool().unwrap_or(false)));
    let (fm_tx, fm_rx) = std::sync::mpsc::channel::<String>();
    let fm_enabled = scrobbling.clone();
    std::thread::spawn(move || lastfm::run(fm_rx, fm_enabled));

    enum Ev {
        Js(String),
        Snap(String),
        Load,
        Drag,
        Zoom,
    }
    let event_loop = EventLoopBuilder::<Ev>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    let stdin_proxy = proxy.clone();
    std::thread::spawn(move || {
        for line in std::io::stdin().lines().map_while(Result::ok) {
            let ev = match line.strip_prefix("SNAP ") {
                Some(path) => Ev::Snap(path.to_string()),
                None => Ev::Js(line),
            };
            if stdin_proxy.send_event(ev).is_err() {
                break;
            }
        }
    });

    let mut window = WindowBuilder::new()
        .with_title("SoundCloud (Rust)")
        .with_inner_size(tao::dpi::LogicalSize::new(1200.0, 800.0));
    if custom {
        // Our page draws the title bar (custom.html, from the Electron app's
        // header.css); the traffic lights sit over its 32px bar.
        use tao::platform::macos::WindowBuilderExtMacOS;
        window = window
            .with_titlebar_transparent(true)
            .with_title_hidden(true)
            .with_fullsize_content_view(true)
            .with_traffic_light_inset(tao::dpi::LogicalPosition::new(12.0, 10.0));
    }
    let window = window.build(&event_loop).unwrap();
    let _menu = app_menu();
    let page_proxy = proxy.clone();
    let page_discord = discord.clone();
    let page_scrobbling = scrobbling.clone();

    let mut builder = WebViewBuilder::new()
        .with_user_agent(safari_ua())
        .with_initialization_script(include_str!("fixes.js"))
        .with_initialization_script_for_main_only(include_str!("clean.js"), false)
        .with_initialization_script(include_str!("nowplaying.js"))
        .with_ipc_handler(move |req| {
            use std::sync::atomic::Ordering;
            let body = req.body();
            // tells the settings panel how the Last.fm connection is going
            let lastfm_status = |v: serde_json::Value| {
                let _ = page_proxy.send_event(Ev::Js(format!("window.__lastfmStatus && window.__lastfmStatus({v})")));
            };
            if let Some(np) = body.strip_prefix("np:") {
                if page_discord.load(Ordering::Relaxed) {
                    let _ = np_tx.send(np.to_string());
                }
                let _ = fm_tx.send(np.to_string());
            } else if let Some(json) = body.strip_prefix("lastfm:connect:") {
                let v: serde_json::Value = serde_json::from_str(json).unwrap_or_default();
                let (key, secret) = (v["key"].as_str().unwrap_or("").trim().to_string(), v["secret"].as_str().unwrap_or("").trim().to_string());
                if key.is_empty() || secret.is_empty() {
                    return lastfm_status(serde_json::json!({ "state": "error", "message": "Enter your API key and secret first." }));
                }
                let (proxy, fm_tx) = (page_proxy.clone(), fm_tx.clone());
                lastfm::connect(key, secret, move |v| {
                    if v["state"] == "connected" {
                        let _ = fm_tx.send(lastfm::RELOAD.into());
                    }
                    let _ = proxy.send_event(Ev::Js(format!("window.__lastfmStatus && window.__lastfmStatus({v})")));
                });
            } else if body == "lastfm:disconnect" {
                lastfm::disconnect();
                let _ = fm_tx.send(lastfm::RELOAD.into());
                lastfm_status(serde_json::json!({ "state": "disconnected", "connected": false }));
            } else if let Some(styles) = body.strip_prefix("styles:") {
                save_styles(styles);
            } else if let Some(json) = body.strip_prefix("settings:") {
                let Ok(new) = serde_json::from_str::<serde_json::Value>(json) else { return };
                page_scrobbling.store(new["lastfm"].as_bool().unwrap_or(false), Ordering::Relaxed);
                let enabled = new["discord"].as_bool().unwrap_or(true);
                if page_discord.swap(enabled, Ordering::Relaxed) && !enabled {
                    let _ = np_tx.send(presence::CLEAR.into());
                }
                save_settings(&new);
            } else if let Some(url) = body.strip_prefix("open:") {
                // links meant for the browser (the page itself never navigates away)
                if url.starts_with("https://") {
                    let _ = std::process::Command::new("open").arg(url).spawn();
                }
            } else if body == "drag" {
                let _ = page_proxy.send_event(Ev::Drag);
            } else if body == "zoom" {
                let _ = page_proxy.send_event(Ev::Zoom);
            } else {
                println!("[page] {body}");
            }
        })
        .with_devtools(true)
        .with_autoplay(true);
    if on("TRACE", false) {
        builder = builder.with_initialization_script(include_str!("trace.js"));
    }
    let webview = builder.build(&window)?;
    // Rules first, then the page, so its first requests are filtered too.
    if adblock {
        adblock::install(&webview, move || {
            let _ = proxy.send_event(Ev::Load);
        });
    } else {
        let _ = proxy.send_event(Ev::Load);
    }

    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(Ev::Js(js)) => {
                let _ = webview.evaluate_script(&js);
            }
            Event::UserEvent(Ev::Snap(path)) => snapshot(&webview, path),
            Event::UserEvent(Ev::Load) if custom => load_custom(&webview, &settings),
            // From a mousedown/double-click on our title bar.
            Event::UserEvent(Ev::Drag) => {
                let _ = window.drag_window();
            }
            Event::UserEvent(Ev::Zoom) => window.set_maximized(!window.is_maximized()),
            Event::UserEvent(Ev::Load) => {
                let _ = webview.load_url(&url);
            }
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => *flow = ControlFlow::Exit,
            _ => {}
        }
    });
}

// Our page, served as https://soundcloud.com/ so SoundCloud's API, license
// server and session cookie accept it (wry's load_html gives it no origin).
fn load_custom(webview: &wry::WebView, settings: &serde_json::Value) {
    use objc2_foundation::{NSString, NSURL};
    use wry::WebViewExtMacOS;
    // SoundCloud's own component CSS, cached by save_styles(), and the build of
    // their site it came from (so the page knows when to collect it again).
    let cached: serde_json::Value = std::fs::read_to_string(styles_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let css = cached["css"].as_str().unwrap_or("").replace("</style", "<\\/style");
    let version = serde_json::to_string(cached["version"].as_str().unwrap_or("")).unwrap();
    let icons = cached["icons"].to_string().replace("</script", "<\\/script");
    let lastfm = lastfm::status().to_string().replace("</script", "<\\/script");
    let html = include_str!("custom.html")
        .replacen("/*SC_STYLES*/", &css, 1)
        .replacen(
            "<script>/*HLS_JS*/</script>",
            &format!(
                "<script>window.__scStylesVersion = {version}; window.__scIcons = {icons}; window.__settings = {settings}; window.__lastfm = {lastfm};</script><script>{}</script>",
                include_str!("../vendor/hls.min.js")
            ),
            1,
        );
    let base = NSURL::URLWithString(&NSString::from_str("https://soundcloud.com/"));
    unsafe { webview.webview().loadHTMLString_baseURL(&NSString::from_str(&html), base.as_deref()) };
}

// "SNAP <path>" on stdin: save a PNG of the page (for checking the UI without
// screen-recording permission).
fn snapshot(webview: &wry::WebView, path: String) {
    use block2::RcBlock;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError, NSString};
    use wry::WebViewExtMacOS;
    let done = RcBlock::new(move |image: *mut NSImage, _err: *mut NSError| {
        let png = unsafe { image.as_ref() }
            .and_then(|i| i.TIFFRepresentation())
            .and_then(|tiff| NSBitmapImageRep::imageRepWithData(&tiff))
            .and_then(|rep| unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) });
        match png {
            Some(data) => {
                data.writeToFile_atomically(&NSString::from_str(&path), true);
                println!("[snap] saved {path}");
            }
            None => println!("[snap] failed"),
        }
    });
    unsafe { webview.webview().takeSnapshotWithConfiguration_completionHandler(None, &done) };
}

fn data_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    std::path::Path::new(&home).join("Library/Application Support/fairplay-spike")
}

fn styles_path() -> std::path::PathBuf {
    data_dir().join("sc-styles.json")
}

// The settings panel's choices; anything missing falls back to the default.
fn load_settings() -> serde_json::Value {
    let mut s = serde_json::json!({ "navButtons": true, "theme": "dark", "discord": true, "adblock": true, "lastfm": false });
    if let Some(saved) = std::fs::read_to_string(data_dir().join("settings.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
    {
        for (k, v) in saved {
            s[k] = v;
        }
    }
    s
}

fn save_settings(s: &serde_json::Value) {
    let _ = std::fs::create_dir_all(data_dir());
    if let Err(e) = std::fs::write(data_dir().join("settings.json"), s.to_string()) {
        eprintln!("settings: could not save: {e}");
    }
}

fn save_styles(json: &str) {
    let path = styles_path();
    let _ = std::fs::create_dir_all(path.parent().unwrap());
    match std::fs::write(&path, json) {
        Ok(()) => eprintln!("styles: cached {} KB", json.len() / 1024),
        Err(e) => eprintln!("styles: could not cache: {e}"),
    }
}

// The standard macOS menu bar. Without an Edit menu, text fields get no
// Cmd+A/C/V/X/Z (macOS routes them through its key equivalents), and without
// the app menu there's no Cmd+Q/H.
fn app_menu() -> muda::Menu {
    use muda::{Menu, PredefinedMenuItem as P, Submenu};
    let sep = || P::separator();
    let menu = Menu::new();
    let app = Submenu::with_items(
        "SoundCloud",
        true,
        &[&P::about(None, None), &sep(), &P::services(None), &sep(), &P::hide(None), &P::hide_others(None), &P::show_all(None), &sep(), &P::quit(None)],
    )
    .unwrap();
    let edit = Submenu::with_items(
        "Edit",
        true,
        &[&P::undo(None), &P::redo(None), &sep(), &P::cut(None), &P::copy(None), &P::paste(None), &P::select_all(None)],
    )
    .unwrap();
    let window = Submenu::with_items("Window", true, &[&P::minimize(None), &P::maximize(None), &P::fullscreen(None), &sep(), &P::close_window(None)]).unwrap();
    menu.append_items(&[&app, &edit, &window]).unwrap();
    menu.init_for_nsapp();
    menu
}
