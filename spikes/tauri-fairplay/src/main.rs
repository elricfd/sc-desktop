// SoundCloud in a Rust window (wry = the webview Tauri uses: WKWebView on
// macOS, WebView2 on Windows), with FairPlay on macOS so Go+ tracks play (page
// fixes in fixes.js), SoundCloud's clutter hidden (clean.js), ad/tracker hosts
// blocked (adblock.rs) and the current track shown in Discord
// (nowplaying.js -> presence.rs). Env: ADBLOCK=0 and
// DISCORD=0 turn those off, TRACE=1 logs media/DRM/hls.js events to stdout.
// By default the window shows soundcloud.com under our own title bar and
// settings panel (chrome.js; settings saved in settings.json, env vars above
// override it). UI=custom swaps SoundCloud's site for our own page
// (custom.html), which talks to SoundCloud's API and plays streams itself.
// Each stdin line is JavaScript run in the page, so tests can drive it.
mod accounts;
mod adblock;
mod downloads;
mod lastfm;
mod presence;
mod tray;
mod updater;

use tao::{
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::WindowBuilder,
};
use wry::WebViewBuilder;

// Present as the Safari installed on this Mac: SoundCloud then serves its
// FairPlay stream, and the version matches the WebKit we really run (a stale
// one is a mismatch bot checks can see). Windows keeps WebView2's own Edge
// user agent: a Safari one would get FairPlay streams it can't play.
#[cfg(target_os = "macos")]
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

enum Ev {
    // run in every tab (statuses, the downloads list), or in the shown one (stdin)
    Js(String),
    JsActive(String),
    Snap(String),
    Place(f64, f64, f64, f64),
    // a tab's IPC message; handled here, where the window and tabs live
    Ipc(u32, String),
    // open a tab (shown or in the background), load one once its ad rules are in
    NewTab(String, bool),
    // a new tab that has drawn its page (or waited long enough) comes on
    ShowTab(u32),
    LoadTab(u32, String),
    Tray(tray::Action),
    // account switcher: start again on another account, drop an old one's store
    Relaunch,
    RemoveStore(String),
}

/// One page per tab, as the Electron app's BrowserViews; only the shown one is visible.
struct Tab {
    id: u32,
    view: wry::WebView,
    // what its title bar last reported: { title, path, icon }
    info: serde_json::Value,
}

// The webview profile every tab shares: WebView2's folder on Windows; macOS
// picks its data store per webview.
#[cfg(target_os = "windows")]
type Ctx = wry::WebContext;
#[cfg(target_os = "macos")]
type Ctx = ();

const HOME: &str = "https://soundcloud.com";

/// A soundcloud.com address, the only kind a tab opens.
fn soundcloud_url(url: &str) -> bool {
    url == HOME || url.starts_with("https://soundcloud.com/")
}

fn main() -> wry::Result<()> {
    let settings = load_settings();
    let setting = |k: &str| settings[k].as_bool().unwrap_or(true);
    let on = |k: &str, default: bool| std::env::var(k).map(|v| v != "0").unwrap_or(default);

    let url = std::env::args().nth(1).unwrap_or_else(|| HOME.into());
    let adblock = on("ADBLOCK", setting("adblock"));
    let custom = std::env::var("UI").as_deref() == Ok("custom");
    let trace = on("TRACE", false);
    // Discord can be switched off and on from the settings panel while running.
    let mut discord = on("DISCORD", setting("discord"));
    let (np_tx, np_rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || presence::run(np_rx));
    let scrobbling = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(settings["lastfm"].as_bool().unwrap_or(false)));
    let (fm_tx, fm_rx) = std::sync::mpsc::channel::<String>();
    let fm_enabled = scrobbling.clone();
    std::thread::spawn(move || lastfm::run(fm_rx, fm_enabled));

    let event_loop = EventLoopBuilder::<Ev>::with_user_event().build();
    let proxy = event_loop.create_proxy();
    for id in accounts::prune(&data_dir()) {
        let _ = proxy.send_event(Ev::RemoveStore(id));
    }
    let stdin_proxy = proxy.clone();
    std::thread::spawn(move || {
        for line in std::io::stdin().lines().map_while(Result::ok) {
            // `WINDOW x y w h` places the window (logical points), for side-by-side tests.
            let place: Option<Vec<f64>> = line.strip_prefix("WINDOW ").map(|r| r.split_whitespace().filter_map(|n| n.parse().ok()).collect());
            let ev = match (line.strip_prefix("SNAP "), place) {
                _ if line == "QUIT" => Ev::Tray(tray::Action::Quit), // quit as the tray's Quit does
                (Some(path), _) => Ev::Snap(path.to_string()),
                (_, Some(v)) if v.len() == 4 => Ev::Place(v[0], v[1], v[2], v[3]),
                _ => Ev::JsActive(line),
            };
            if stdin_proxy.send_event(ev).is_err() {
                break;
            }
        }
    });

    #[allow(unused_mut)]
    let mut window = WindowBuilder::new()
        .with_title("SoundCloud (Rust)")
        .with_inner_size(tao::dpi::LogicalSize::new(1200.0, 800.0))
        // SoundCloud's page is laid out for 960 and still holds together at 800
        // (its right column partly cut off); narrower falls apart
        .with_min_inner_size(tao::dpi::LogicalSize::new(800.0, 600.0))
        // shown once the first page has drawn (Ev::ShowTab), not as a blank window
        .with_visible(false);
    // Windows starts with the native frame and drops it once the page has drawn
    // its own window buttons ("frameless").
    #[cfg(target_os = "macos")]
    {
        // The page draws the title bar (chrome.js or custom.html, from the
        // Electron app's header.css); the traffic lights sit over its 32px bar.
        use tao::platform::macos::WindowBuilderExtMacOS;
        window = window
            .with_titlebar_transparent(true)
            .with_title_hidden(true)
            .with_fullsize_content_view(true);
        // The traffic lights stay where macOS puts them, which on current macOS
        // is centred on our 32px bar. Moving them (tao's inset, or by hand) made
        // AppKit move them back during resizes and when a tab's webview was added.
    }
    #[cfg(target_os = "windows")]
    {
        let (rgba, w, h) = tray::rgba(include_bytes!("icons/app.png"));
        window = window.with_window_icon(tao::window::Icon::from_rgba(rgba, w, h).ok());
    }
    let window = window.build(&event_loop).unwrap();
    let update_ready = updater::Ready::default();
    if setting("autoUpdate") && std::env::var("UPDATES").as_deref() != Ok("0") {
        let p = proxy.clone();
        updater::start(data_dir(), update_ready.clone(), move |msg| {
            eprintln!("updater: {msg}");
            let _ = p.send_event(Ev::Js(format!("window.__downloadStatus && window.__downloadStatus({})", serde_json::Value::from(msg))));
        });
    }
    let tray_proxy = proxy.clone();
    let mut _tray = None; // kept alive for the app's lifetime
    #[cfg(target_os = "macos")]
    let _menu = app_menu();
    let list_proxy = proxy.clone();
    let dls = downloads::Downloads::new(move |list| {
        let _ = list_proxy.send_event(Ev::Js(format!("window.__downloads && window.__downloads({list})")));
    });

    // WebView2's profile (cookies, the Widevine CDM) goes beside our settings
    // instead of next to the exe; every tab shares it.
    #[cfg(target_os = "windows")]
    let mut context: Ctx = wry::WebContext::new(Some(data_dir().join(match accounts::current(&data_dir()).as_str() {
        "default" => "webview".to_string(),
        id => format!("webview-{id}"),
    })));
    #[cfg(target_os = "macos")]
    let mut context: Ctx = ();
    let mut tabs: Vec<Tab> = Vec::new();
    let mut active = 0u32;
    let mut pending: Option<u32>; // a new tab (or the first page) waiting to come on
    let mut window_shown = false; // the window starts hidden
    let mut next_id = 0u32;
    // Rules first, then the page, so its first requests are filtered too.
    let tab_proxy = proxy.clone();
    let open_tab = move |id: u32, url: String, window: &tao::window::Window, context: &mut Ctx| -> wry::Result<Tab> {
        let view = build_tab(id, window, &tab_proxy, custom, trace, context)?;
        let p = tab_proxy.clone();
        let load = move || {
            let _ = p.send_event(Ev::LoadTab(id, url.clone()));
        };
        if adblock { adblock::install(&view, load) } else { load() }
        Ok(Tab { id, view, info: serde_json::json!({}) })
    };
    tabs.push(open_tab(next_id, url, &window, &mut context)?);
    let _ = tabs[0].view.set_bounds(tab_bounds(&window, true));
    pending = Some(next_id);
    let p = proxy.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(5));
        let _ = p.send_event(Ev::ShowTab(0));
    });
    next_id += 1;

    // Closing hides the window when "Minimize to tray" is on (the default, as
    // in the Electron app); the tray, the Dock or Quit bring it back or end it.
    let close = |window: &tao::window::Window, flow: &mut ControlFlow| {
        if load_settings()["minimizeToTray"].as_bool().unwrap_or(true) {
            window.set_visible(false);
        } else {
            *flow = ControlFlow::Exit;
        }
    };
    let show = |window: &tao::window::Window| {
        window.set_visible(true);
        window.set_minimized(false);
        window.set_focus();
    };
    // every tab's bar lists all of them
    let send_tabs = |tabs: &[Tab]| {
        let state = serde_json::json!({ "tabs": tabs.iter().map(|t| serde_json::json!({ "id": t.id, "info": t.info })).collect::<Vec<_>>() });
        for t in tabs {
            let _ = t.view.evaluate_script(&format!("window.__tabs && window.__tabs({state})"));
        }
    };
    // The others move off the window rather than hide: a hidden WebView2 stops
    // drawing and shows a blank frame when it comes back.
    let activate = |tabs: &[Tab], id: u32, window: &tao::window::Window| {
        for t in tabs {
            let _ = t.view.set_bounds(tab_bounds(window, t.id == id));
        }
        if let Some(t) = tabs.iter().find(|t| t.id == id) {
            let _ = t.view.focus();
        }
    };
    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        let shown = tabs.iter().find(|t| t.id == active).map(|t| &t.view);
        match event {
            // The tray (and the Dock icon) need the running app.
            Event::NewEvents(tao::event::StartCause::Init) => {
                let p = tray_proxy.clone();
                _tray = Some(tray::build(move |a| {
                    let _ = p.send_event(Ev::Tray(a));
                }));
                #[cfg(target_os = "macos")]
                tray::set_dock_icon();
            }
            Event::UserEvent(Ev::Tray(tray::Action::Show)) => show(&window),
            Event::UserEvent(Ev::Tray(tray::Action::Settings)) => {
                show(&window);
                if let Some(v) = shown {
                    let _ = v.evaluate_script("window.__openSettings && window.__openSettings()");
                }
            }
            Event::UserEvent(Ev::Tray(tray::Action::Quit)) => *flow = ControlFlow::Exit,
            Event::UserEvent(Ev::Relaunch) => {
                accounts::relaunch();
                *flow = ControlFlow::Exit;
            }
            Event::UserEvent(Ev::RemoveStore(id)) => {
                #[cfg(target_os = "macos")]
                if let Some(uuid) = accounts::store_id(&id) {
                    use wry::WebViewExtDarwin;
                    wry::WebView::remove_data_store(&uuid, |r| if let Err(e) = r { eprintln!("accounts: store not removed: {e}") });
                }
                #[cfg(target_os = "windows")]
                let _ = std::fs::remove_dir_all(data_dir().join(format!("webview-{id}")));
            }
            // a click on the Dock icon while the window is hidden
            Event::Reopen { .. } => show(&window),
            Event::LoopDestroyed => {
                dls.cancel_all();
                updater::install(&update_ready);
            }
            Event::UserEvent(Ev::Js(js)) => {
                for t in &tabs {
                    let _ = t.view.evaluate_script(&js);
                }
            }
            Event::UserEvent(Ev::JsActive(js)) => {
                if let Some(v) = shown {
                    let _ = v.evaluate_script(&js);
                }
            }
            Event::UserEvent(Ev::Snap(path)) => {
                if let Some(v) = shown {
                    snapshot(v, path);
                }
            }
            Event::UserEvent(Ev::Place(x, y, w, h)) => {
                window.set_outer_position(tao::dpi::LogicalPosition::new(x, y));
                window.set_inner_size(tao::dpi::LogicalSize::new(w, h));
            }
            Event::UserEvent(Ev::LoadTab(id, url)) => {
                if let Some(t) = tabs.iter().find(|t| t.id == id) {
                    if custom {
                        load_custom(&t.view, &settings);
                    } else {
                        let _ = t.view.load_url(&url);
                    }
                }
            }
            Event::UserEvent(Ev::ShowTab(id)) => {
                if !window_shown {
                    window_shown = true;
                    window.set_visible(true);
                    window.set_focus();
                }
                if pending == Some(id) && tabs.iter().any(|t| t.id == id) {
                    active = id;
                    activate(&tabs, active, &window);
                }
                if pending == Some(id) {
                    pending = None;
                }
            }
            Event::UserEvent(Ev::NewTab(url, focus)) => {
                if custom || !soundcloud_url(&url) {
                    return;
                }
                match open_tab(next_id, url, &window, &mut context) {
                    Ok(tab) => {
                        // right after the shown tab, as browsers place them
                        let at = tabs.iter().position(|t| t.id == active).map_or(tabs.len(), |i| i + 1);
                        tabs.insert(at, tab);
                        // It stays just off the window until SoundCloud's content
                        // has rendered (tab:drawn from chrome.js), or the window
                        // shows an empty page for a moment; after 5 s regardless.
                        if focus {
                            pending = Some(next_id);
                            let (p, id) = (proxy.clone(), next_id);
                            std::thread::spawn(move || {
                                std::thread::sleep(std::time::Duration::from_secs(5));
                                let _ = p.send_event(Ev::ShowTab(id));
                            });
                        }
                        next_id += 1;
                        activate(&tabs, active, &window);
                        send_tabs(&tabs);
                    }
                    Err(e) => eprintln!("tabs: could not open: {e}"),
                }
            }
            Event::UserEvent(Ev::Ipc(from, body)) => {
                use std::sync::atomic::Ordering;
                let reply = |js: String| {
                    if let Some(t) = tabs.iter().find(|t| t.id == from) {
                        let _ = t.view.evaluate_script(&js);
                    }
                };
                if let Some(np) = body.strip_prefix("np:") {
                    if discord {
                        let _ = np_tx.send(np.to_string());
                    }
                    let _ = fm_tx.send(np.to_string());
                } else if let Some(json) = body.strip_prefix("lastfm:connect:") {
                    let v: serde_json::Value = serde_json::from_str(json).unwrap_or_default();
                    let (key, secret) = (v["key"].as_str().unwrap_or("").trim().to_string(), v["secret"].as_str().unwrap_or("").trim().to_string());
                    if key.is_empty() || secret.is_empty() {
                        return reply(format!("window.__lastfmStatus && window.__lastfmStatus({})", serde_json::json!({ "state": "error", "message": "Enter your API key and secret first." })));
                    }
                    let (p, fm_tx) = (proxy.clone(), fm_tx.clone());
                    lastfm::connect(key, secret, move |v| {
                        if v["state"] == "connected" {
                            let _ = fm_tx.send(lastfm::RELOAD.into());
                        }
                        let _ = p.send_event(Ev::Js(format!("window.__lastfmStatus && window.__lastfmStatus({v})")));
                    });
                } else if body == "lastfm:disconnect" {
                    lastfm::disconnect();
                    let _ = fm_tx.send(lastfm::RELOAD.into());
                    let _ = proxy.send_event(Ev::Js(format!("window.__lastfmStatus && window.__lastfmStatus({})", serde_json::json!({ "state": "disconnected", "connected": false }))));
                } else if let Some(styles) = body.strip_prefix("styles:") {
                    save_styles(styles);
                } else if let Some(json) = body.strip_prefix("settings:") {
                    let Ok(new) = serde_json::from_str::<serde_json::Value>(json) else { return };
                    scrobbling.store(new["lastfm"].as_bool().unwrap_or(false), Ordering::Relaxed);
                    let enabled = new["discord"].as_bool().unwrap_or(true);
                    if discord && !enabled {
                        let _ = np_tx.send(presence::CLEAR.into());
                    }
                    discord = enabled;
                    save_settings(&new);
                    // the other tabs' panels and themes follow
                    for t in tabs.iter().filter(|t| t.id != from) {
                        let _ = t.view.evaluate_script(&format!("window.__chromeState && window.__chromeState({new}, {})", lastfm::status()));
                    }
                } else if let Some(url) = body.strip_prefix("open:") {
                    // links meant for the browser
                    if url.starts_with("https://") {
                        let _ = open_url(url);
                    }
                } else if let Some(req) = body.strip_prefix("download:") {
                    // the download buttons chrome.js puts under tracks, albums and playlists
                    if let Ok(req) = serde_json::from_str(req) {
                        dls.start(&req);
                    }
                } else if let Some(cmd) = body.strip_prefix("downloads:") {
                    let mut parts = cmd.split(':');
                    let (what, id, track) = (parts.next().unwrap_or(""), parts.next().and_then(|n| n.parse().ok()), parts.next().and_then(|n| n.parse().ok()));
                    match (what, id) {
                        ("cancel", Some(id)) => dls.cancel(id),
                        ("show", Some(id)) => {
                            if let Some(file) = dls.file(id, track) {
                                downloads::reveal(&file, true);
                            }
                        }
                        ("open-folder", _) => downloads::reveal(&downloads::folder(), false),
                        ("clear", _) => dls.clear(),
                        ("get", _) => reply(format!("window.__downloads && window.__downloads({})", dls.list())),
                        _ => {}
                    }
                } else if let Some(me) = body.strip_prefix("account:me:") {
                    if let Ok(me) = serde_json::from_str(me) {
                        accounts::set_me(&data_dir(), &me);
                    }
                } else if let Some(id) = body.strip_prefix("account:switch:") {
                    if id != accounts::current(&data_dir()) {
                        accounts::switch(&data_dir(), id);
                        let _ = proxy.send_event(Ev::Relaunch);
                    }
                } else if body == "account:add" {
                    accounts::add(&data_dir());
                    let _ = proxy.send_event(Ev::Relaunch);
                } else if let Some(id) = body.strip_prefix("account:remove:") {
                    if let Some(id) = accounts::remove(&data_dir(), id) {
                        let _ = proxy.send_event(Ev::RemoveStore(id));
                    }
                } else if body == "tab:drawn" {
                    let _ = proxy.send_event(Ev::ShowTab(from));
                } else if body == "chrome:ready" {
                    // chrome.js after a load: the settings saved since the launch, and the tabs
                    reply(format!("window.__chromeState && window.__chromeState({}, {})", load_settings(), lastfm::status()));
                    send_tabs(&tabs);
                } else if body == "reload" {
                    // signed in or out in an embedded SoundCloud page: start over with that session
                    let _ = proxy.send_event(Ev::LoadTab(from, HOME.into()));
                } else if body == "drag" {
                    let _ = window.drag_window();
                } else if body == "zoom" {
                    window.set_maximized(!window.is_maximized());
                } else if body == "minimize" {
                    window.set_minimized(true);
                } else if body == "close" {
                    close(&window, flow);
                } else if body == "frameless" {
                    // The page sends this once it draws its own window buttons, so the
                    // window is never left without a way to close it. macOS keeps its
                    // traffic lights over the page (see the window builder).
                    #[cfg(target_os = "windows")]
                    {
                        use tao::platform::windows::WindowExtWindows;
                        window.set_decorations(false);
                        window.set_undecorated_shadow(true);
                    }
                } else if let Some(dir) = body.strip_prefix("resize:").and_then(resize_direction) {
                    let _ = window.drag_resize_window(dir);
                // --- tabs: new (Ctrl+T, +), open in the background (middle-click),
                // close, switch, cycle (Ctrl+Tab), by number (Ctrl+1..9), and each
                // page's title and address for the others' bars
                } else if body == "tab:new" {
                    let _ = proxy.send_event(Ev::NewTab(HOME.into(), true));
                } else if let Some(url) = body.strip_prefix("tab:open:") {
                    let _ = proxy.send_event(Ev::NewTab(url.into(), false));
                } else if let Some(info) = body.strip_prefix("tab:info:") {
                    if let (Ok(info), Some(t)) = (serde_json::from_str(info), tabs.iter_mut().find(|t| t.id == from)) {
                        t.info = info;
                        send_tabs(&tabs);
                    }
                } else if let Some(which) = body.strip_prefix("tab:close") {
                    let id = which.strip_prefix(':').and_then(|n| n.parse().ok()).unwrap_or(from);
                    let Some(i) = tabs.iter().position(|t| t.id == id) else { return };
                    // the last tab is the window
                    if tabs.len() == 1 {
                        return close(&window, flow);
                    }
                    // the next tab (or the one before) comes on before this one
                    // goes, or the empty window flashes in between
                    if id == active {
                        active = tabs[if i + 1 < tabs.len() { i + 1 } else { i - 1 }].id;
                        activate(&tabs, active, &window);
                    }
                    tabs.remove(i); // dropping the webview closes its page
                    send_tabs(&tabs);
                } else if let Some(id) = body.strip_prefix("tab:switch:").and_then(|n| n.parse().ok()) {
                    if tabs.iter().any(|t| t.id == id) {
                        active = id;
                        pending = None;
                        activate(&tabs, active, &window);
                    }
                } else if let Some(step) = body.strip_prefix("tab:cycle:").and_then(|n| n.parse::<i64>().ok()) {
                    let n = tabs.len() as i64;
                    if let Some(i) = tabs.iter().position(|t| t.id == active) {
                        active = tabs[(i as i64 + step).rem_euclid(n) as usize].id;
                        activate(&tabs, active, &window);
                    }
                } else if let Some(n) = body.strip_prefix("tab:index:").and_then(|n| n.parse::<usize>().ok()) {
                    // 9 is the last tab, as in browsers
                    let i = if n >= 9 { tabs.len() - 1 } else { n.saturating_sub(1) };
                    if let Some(t) = tabs.get(i) {
                        active = t.id;
                        activate(&tabs, active, &window);
                    }
                } else {
                    println!("[page] {body}");
                }
                if let Some(t) = tabs.iter().find(|t| t.id == active) {
                    window.set_title(t.info["title"].as_str().unwrap_or("SoundCloud (Rust)"));
                }
            }
            // Child webviews don't follow the window by themselves; also so the
            // page can swap its maximize and restore icons.
            Event::WindowEvent { event: WindowEvent::Resized(_), .. } => {
                for t in &tabs {
                    let _ = t.view.set_bounds(tab_bounds(&window, t.id == active));
                    let _ = t.view.evaluate_script(&format!("window.__windowState && window.__windowState({{ maximized: {} }})", window.is_maximized()));
                }
            }
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => close(&window, flow),
            _ => {}
        }
    });
}

/// The whole window for the shown tab; the same size just left of it for the others.
fn tab_bounds(window: &tao::window::Window, shown: bool) -> wry::Rect {
    let size = window.inner_size();
    let x = if shown { 0 } else { -(size.width as i32) - 64 };
    wry::Rect { position: wry::dpi::PhysicalPosition::new(x, 0).into(), size: wry::dpi::PhysicalSize::new(size.width, size.height).into() }
}

/// A tab's webview over the whole window, with the page scripts and handlers
/// every tab has; its IPC messages go to the event loop tagged with its id.
fn build_tab(
    id: u32,
    window: &tao::window::Window,
    proxy: &tao::event_loop::EventLoopProxy<Ev>,
    custom: bool,
    trace: bool,
    #[allow(unused_variables)] context: &mut Ctx,
) -> wry::Result<wry::WebView> {
    // fixes.js works around WebKit bugs only.
    #[cfg(target_os = "macos")]
    let builder = WebViewBuilder::new().with_user_agent(safari_ua()).with_initialization_script(include_str!("fixes.js"));
    // an extra account signs in inside its own data store (macOS 14+)
    #[cfg(target_os = "macos")]
    let builder = match accounts::store_id(&accounts::current(&data_dir())) {
        Some(id) => wry::WebViewBuilderExtDarwin::with_data_store_identifier(builder, id),
        None => builder,
    };
    // Overlay scrollbars like macOS, instead of Windows' classic ones beside
    // every scrolling box (menus, queue, the page).
    // SoundCloud refuses WebView2's Widevine licence requests (403) but serves
    // PlayReady ones, so the page is told Widevine isn't there.
    #[cfg(target_os = "windows")]
    let builder = {
        use wry::{ScrollBarStyle, WebViewBuilderExtWindows};
        WebViewBuilder::new_with_web_context(context).with_scroll_bar_style(ScrollBarStyle::FluentOverlay).with_initialization_script(
            "(() => { const r = navigator.requestMediaKeySystemAccess?.bind(navigator); if (r) navigator.requestMediaKeySystemAccess = (ks, c) => /widevine/i.test(ks) ? Promise.reject(new DOMException('Unsupported keySystem or supportedConfigurations.', 'NotSupportedError')) : r(ks, c); })();",
        )
    };
    let (dl, nw, ipc) = (proxy.clone(), proxy.clone(), proxy.clone());
    let mut builder = builder
        .with_bounds(tab_bounds(window, false))
        .with_initialization_script_for_main_only(include_str!("clean.js"), false)
        .with_initialization_script(include_str!("nowplaying.js"))
        // SoundCloud's track page downloads by sending its frame to the file on
        // their CDN and relying on the attachment header. WebKit plays audio it
        // can show instead, so take those navigations and save the file.
        .with_navigation_handler(move |url| {
            let host = url.strip_prefix("https://").and_then(|r| r.split(['/', '?', '#']).next()).unwrap_or("");
            if !host.ends_with(".sndcdn.com") {
                return true;
            }
            let proxy = dl.clone();
            download(url, move |msg| {
                let _ = proxy.send_event(Ev::Js(format!("window.__downloadStatus && window.__downloadStatus({})", serde_json::Value::from(msg))));
            });
            false
        })
        // New windows: SoundCloud pages open as a tab, other sites in the
        // browser; sign-in popups stay, they post the result back to this page.
        .with_new_window_req_handler(move |url, _| {
            let host = url.split_once("://").map(|(_, r)| r.split(['/', '?', '#', ':']).next().unwrap_or("")).unwrap_or("");
            const SIGN_IN: [&str; 4] = ["secure.soundcloud.com", "accounts.google.com", "appleid.apple.com", "www.facebook.com"];
            if !url.starts_with("http") || SIGN_IN.contains(&host) {
                return wry::NewWindowResponse::Allow;
            }
            if soundcloud_url(&url) {
                let _ = nw.send_event(Ev::NewTab(url, true));
            } else {
                let _ = open_url(&url);
            }
            wry::NewWindowResponse::Deny
        })
        .with_ipc_handler(move |req| {
            let _ = ipc.send_event(Ev::Ipc(id, req.body().clone()));
        })
        .with_devtools(true)
        .with_autoplay(true);
    if !custom {
        // our title bar and settings over soundcloud.com, with the saved settings
        let state = format!(
            "window.__tabId = {id}; window.__settings = {}; window.__lastfm = {}; window.__appVersion = '{}'; window.__accounts = {}; window.__oledCss = {};",
            load_settings(),
            lastfm::status(),
            env!("CARGO_PKG_VERSION"),
            accounts::load(&data_dir()),
            serde_json::Value::from(include_str!("../../../themes/OLED.css"))
        );
        builder = builder.with_initialization_script_for_main_only(state, true).with_initialization_script_for_main_only(include_str!("chrome.js"), true);
    }
    if trace {
        builder = builder.with_initialization_script(include_str!("trace.js"));
    }
    builder.build_as_child(window)
}

/// "resize:<edge>" from the page's frameless-window edges: n, s, e, w, ne, nw, se, sw.
fn resize_direction(edge: &str) -> Option<tao::window::ResizeDirection> {
    use tao::window::ResizeDirection::*;
    Some(match edge {
        "n" => North,
        "s" => South,
        "e" => East,
        "w" => West,
        "ne" => NorthEast,
        "nw" => NorthWest,
        "se" => SouthEast,
        "sw" => SouthWest,
        _ => return None,
    })
}

/// Opens a link in the default browser.
#[cfg(target_os = "macos")]
fn open_url(url: &str) -> Result<(), String> {
    std::process::Command::new("open").arg(url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

// ShellExecute, not `cmd /C start`: cmd would run whatever follows an & in the URL.
#[cfg(target_os = "windows")]
fn open_url(url: &str) -> Result<(), String> {
    use windows::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
    use windows::core::{HSTRING, PCWSTR, w};
    let r = unsafe { ShellExecuteW(None, w!("open"), &HSTRING::from(url), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
    // "greater than 32" is success
    if r.0 as usize > 32 { Ok(()) } else { Err(format!("Could not open the browser (ShellExecute {})", r.0 as usize)) }
}

// custom.html with SoundCloud's cached styles, the settings and hls.js filled in.
fn custom_html(settings: &serde_json::Value) -> String {
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
    // clean.js for the page to run in embedded SoundCloud pages (see prepFrame)
    let clean = serde_json::to_string(include_str!("clean.js")).unwrap().replace("</script", "<\\/script");
    include_str!("custom.html")
        .replacen("/*SC_STYLES*/", &css, 1)
        .replacen(
            "<script>/*HLS_JS*/</script>",
            &format!(
                "<script>window.__scStylesVersion = {version}; window.__scIcons = {icons}; window.__settings = {settings}; window.__lastfm = {lastfm}; window.__cleanJs = {clean};</script><script>{}</script>",
                include_str!("../vendor/hls.min.js")
            ),
            1,
        )
}

// Our page, served as https://soundcloud.com/ so SoundCloud's API, license
// server and session cookie accept it (wry's load_html gives it no origin).
#[cfg(target_os = "macos")]
fn load_custom(webview: &wry::WebView, settings: &serde_json::Value) {
    use objc2_foundation::{NSString, NSURL};
    use wry::WebViewExtMacOS;
    let html = custom_html(settings);
    let base = NSURL::URLWithString(&NSString::from_str("https://soundcloud.com/"));
    unsafe { webview.webview().loadHTMLString_baseURL(&NSString::from_str(&html), base.as_deref()) };
}

// WebView2 can't load a string under a chosen origin (NavigateToString gives
// an opaque one), so answer one made-up soundcloud.com address with our page
// and navigate there. SoundCloud's service worker (scope /) would answer that
// navigation itself, so this webview bypasses service workers first.
#[cfg(target_os = "windows")]
fn load_custom(webview: &wry::WebView, settings: &serde_json::Value) {
    use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, WebResourceRequestedEventHandler, take_pwstr};
    use windows::Win32::UI::Shell::SHCreateMemStream;
    use windows::core::{HSTRING, PWSTR};
    use wry::WebViewExtWindows;
    const URL: &str = "https://soundcloud.com/__app";
    // The page served at URL; replaced on every load ("reload" after a sign-in
    // or sign-out), while the handler serving it is added only once.
    thread_local! {
        static HTML: std::cell::RefCell<Option<Vec<u8>>> = const { std::cell::RefCell::new(None) };
    }
    let first = HTML.with(|h| h.replace(Some(custom_html(settings).into_bytes())).is_none());
    let (wv, env) = (webview.webview(), webview.environment());
    let result = (|| -> windows::core::Result<()> {
        if first {
            add_filter(&wv, URL)?;
            let handler = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                unsafe {
                    let mut uri = PWSTR::null();
                    args.Request()?.Uri(&mut uri)?;
                    if take_pwstr(uri) == URL {
                        let headers = HSTRING::from("Content-Type: text/html; charset=utf-8\nCache-Control: no-store");
                        let body = HTML.with(|h| h.borrow().as_deref().and_then(|b| SHCreateMemStream(Some(b))));
                        args.SetResponse(&env.CreateWebResourceResponse(body.as_ref(), 200, &HSTRING::from("OK"), &headers)?)?;
                    }
                }
                Ok(())
            }));
            let mut token = 0;
            unsafe { wv.add_WebResourceRequested(&handler, &mut token)? };
        }
        // Network.enable, then the bypass (ignored without it), then navigate.
        let (wv2, nav) = (wv.clone(), wv.clone());
        let then_navigate = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |result, _| {
            if let Err(e) = result {
                eprintln!("custom ui: service workers not bypassed: {e}");
            }
            unsafe { nav.Navigate(&HSTRING::from(URL)) }
        }));
        let then_bypass = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |_, _| unsafe {
            wv2.CallDevToolsProtocolMethod(&HSTRING::from("Network.setBypassServiceWorker"), &HSTRING::from(r#"{"bypass":true}"#), &then_navigate)
        }));
        unsafe { wv.CallDevToolsProtocolMethod(&HSTRING::from("Network.enable"), &HSTRING::from("{}"), &then_bypass) }
    })();
    if let Err(e) = result {
        eprintln!("custom ui: could not load: {e}");
    }
}

/// Have WebResourceRequested handlers called for requests matching `filter`
/// (`*` and `?` wildcards), from pages, frames and workers.
#[cfg(target_os = "windows")]
fn add_filter(wv: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2, filter: &str) -> windows::core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL, COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL, ICoreWebView2_22,
    };
    use windows::core::{HSTRING, Interface};
    unsafe {
        wv.cast::<ICoreWebView2_22>()?.AddWebResourceRequestedFilterWithRequestSourceKinds(
            &HSTRING::from(filter),
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
            COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
        )
    }
}

// "SNAP <path>" on stdin: save a PNG of the page (for checking the UI without
// a human; on macOS without screen-recording permission).
#[cfg(target_os = "windows")]
fn snapshot(webview: &wry::WebView, path: String) {
    use webview2_com::{CapturePreviewCompletedHandler, Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG};
    use windows::Win32::{System::Com::{STGM_CREATE, STGM_SHARE_DENY_NONE, STGM_WRITE}, UI::Shell::SHCreateStreamOnFileW};
    use windows::core::HSTRING;
    use wry::WebViewExtWindows;
    let result = unsafe { SHCreateStreamOnFileW(&HSTRING::from(&path), (STGM_CREATE | STGM_WRITE | STGM_SHARE_DENY_NONE).0) }.and_then(|file| {
        let done = CapturePreviewCompletedHandler::create(Box::new(move |result| {
            match result {
                Ok(()) => println!("[snap] saved {path}"),
                Err(e) => println!("[snap] failed: {e}"),
            }
            Ok(())
        }));
        unsafe { webview.webview().CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &file, &done) }
    });
    if let Err(e) = result {
        println!("[snap] failed: {e}");
    }
}

#[cfg(target_os = "macos")]
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

/// Saves `url` to the Downloads folder under the server's file name, telling
/// the page when it starts and how it ended.
fn download(url: String, notify: impl Fn(String) + Send + 'static) {
    std::thread::spawn(move || {
        notify("Downloading…".into());
        let result = (|| -> Result<String, String> {
            let res = ureq::get(&url).call().map_err(|e| e.to_string())?;
            let header = res.headers().get("content-disposition").and_then(|v| v.to_str().ok()).unwrap_or("");
            let fallback = url.split(['?', '#']).next().unwrap_or("").rsplit('/').next().unwrap_or("");
            let name = safe_file_name(&disposition_name(header).unwrap_or_else(|| fallback.to_string()));
            let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
            let dir = std::path::Path::new(&home).join("Downloads");
            let (stem, ext) = match name.rfind('.') {
                Some(i) if i > 0 => (&name[..i], &name[i..]),
                _ => (name.as_str(), ""),
            };
            let path = (0..)
                .map(|n| dir.join(if n == 0 { name.clone() } else { format!("{stem} ({n}){ext}") }))
                .find(|p| !p.exists())
                .unwrap();
            // Written beside it first, so a failed download leaves no half file.
            let part = path.with_extension("part");
            let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
            let copied = std::io::copy(&mut res.into_body().into_reader(), &mut file);
            if let Err(e) = copied {
                let _ = std::fs::remove_file(&part);
                return Err(e.to_string());
            }
            std::fs::rename(&part, &path).map_err(|e| e.to_string())?;
            Ok(path.file_name().unwrap_or_default().to_string_lossy().into_owned())
        })();
        notify(match result {
            Ok(name) => format!("Downloaded {name}"),
            Err(e) => format!("Download failed: {e}"),
        });
    });
}

/// `filename*=UTF-8''…` (percent-encoded) or `filename="…"` from a
/// Content-Disposition header.
fn disposition_name(header: &str) -> Option<String> {
    for part in header.split(';').map(str::trim) {
        if let Some(v) = part.strip_prefix("filename*=") {
            let v = v.splitn(3, '\'').nth(2).unwrap_or(v);
            let mut bytes = Vec::new();
            let mut it = v.bytes();
            while let Some(b) = it.next() {
                let hex = |b: Option<u8>| b.and_then(|b| (b as char).to_digit(16));
                if b == b'%' {
                    match (hex(it.next()), hex(it.next())) {
                        (Some(h), Some(l)) => bytes.push((h * 16 + l) as u8),
                        _ => return None,
                    }
                } else {
                    bytes.push(b);
                }
            }
            return String::from_utf8(bytes).ok().filter(|s| !s.is_empty());
        }
    }
    header.split(';').map(str::trim).find_map(|p| p.strip_prefix("filename=")).map(|v| v.trim_matches('"').to_string()).filter(|s| !s.is_empty())
}

/// A name that can't leave the Downloads folder or be hidden.
fn safe_file_name(name: &str) -> String {
    let clean: String = name.chars().map(|c| if c.is_control() || "/\\:*?\"<>|".contains(c) { '_' } else { c }).collect();
    let clean = clean.trim().trim_start_matches('.').to_string();
    if clean.is_empty() { "download".into() } else { clean }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn download_names() {
        assert_eq!(disposition_name(r#"attachment; filename="Song - Mix.mp3""#).as_deref(), Some("Song - Mix.mp3"));
        assert_eq!(disposition_name("attachment; filename*=UTF-8''%E5%A7%8B%E7%A5%96%20(Sah).wav; filename=\"x.wav\"").as_deref(), Some("始祖 (Sah).wav"));
        assert_eq!(disposition_name("inline"), None);
        assert_eq!(safe_file_name("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(safe_file_name("a/b:c.mp3"), "a_b_c.mp3");
        assert_eq!(safe_file_name(".."), "download");
    }
}

#[cfg(target_os = "macos")]
fn data_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    std::path::Path::new(&home).join("Library/Application Support/fairplay-spike")
}

#[cfg(target_os = "windows")]
fn data_dir() -> std::path::PathBuf {
    std::path::Path::new(&std::env::var("APPDATA").unwrap_or_default()).join("fairplay-spike")
}

fn styles_path() -> std::path::PathBuf {
    data_dir().join("sc-styles.json")
}

// The settings panel's choices; anything missing falls back to the default.
fn load_settings() -> serde_json::Value {
    let mut s = serde_json::json!({ "navButtons": true, "downloadButton": true, "downloadUseAccount": true, "minimizeToTray": true, "autoUpdate": true, "theme": "dark", "discord": true, "adblock": true, "lastfm": false });
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
// the app menu there's no Cmd+Q/H. (WebView2 handles Ctrl+A/C/V itself.)
#[cfg(target_os = "macos")]
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
    let window = Submenu::with_items("Window", true, &[&P::minimize(None), &P::maximize(None), &P::fullscreen(None), ]).unwrap();
    menu.append_items(&[&app, &edit, &window]).unwrap();
    menu.init_for_nsapp();
    menu
}
