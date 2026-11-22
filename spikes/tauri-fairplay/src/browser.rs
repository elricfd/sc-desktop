// Linux: SoundCloud in the app window of an installed Chromium-family browser
// (Helium, Chrome, Brave, ...), for its Widevine. WebKitGTK has no DRM, so Go+
// and other encrypted tracks only play this way. The browser runs on its own
// profile beside our settings and is driven over the DevTools pipe (commands
// on its fd 3, events on fd 4, JSON ended by a NUL): our scripts go in before
// each page's own, JavaScript is run in the page, and the page's ipc messages
// come back through a long poll. Runtime.enable is never sent: pages can
// detect it, and SoundCloud's bot checks look.
use serde_json::{Value, json};
use std::io::{BufRead, Write};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

const NAMES: [&str; 8] =
    ["helium", "google-chrome-stable", "google-chrome", "brave-browser", "microsoft-edge-stable", "vivaldi-stable", "chromium-browser", "chromium"];

/// window.ipc as wry gives it, kept in a queue that `__ipcNext` hands over.
const IPC: &str = "(() => {
  if (window.top !== window) { try { window.ipc = window.top.ipc; } catch {} return; }
  const q = []; let wake = null;
  window.ipc = { postMessage: m => { q.push(String(m)); if (wake) wake(); } };
  window.__ipcNext = () => new Promise(r => { wake = () => { if (q.length) { wake = null; r(q.splice(0)); } }; wake(); });
})();";

/// The browser to use, with ENGINE=browser: $SC_BROWSER, else the first known
/// one on PATH. None otherwise: the WebKitGTK window is the default, lighter
/// and without DRM.
pub fn found() -> Option<&'static Path> {
    static FOUND: OnceLock<Option<PathBuf>> = OnceLock::new();
    FOUND
        .get_or_init(|| {
            if std::env::var("ENGINE").as_deref() != Ok("browser") {
                return None;
            }
            if let Some(b) = std::env::var_os("SC_BROWSER") {
                return Some(b.into());
            }
            let path = std::env::var_os("PATH")?;
            NAMES.iter().find_map(|n| std::env::split_paths(&path).map(|d| d.join(n)).find(|p| p.is_file()))
        })
        .as_deref()
}

// A new profile has no Widevine until the browser's component updater fetches
// it, which Helium only does once asked in its settings. Chromium loads the CDM
// its hint file names, so point ours at the copy the user's own profile has.
// ponytail: takes the first browser that has one, not the one being launched
fn seed_widevine(profile: &Path) {
    const HINT: &str = "WidevineCdm/latest-component-updated-widevine-cdm";
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(&std::env::var("HOME").unwrap_or_default()).join(".config"));
    let source = ["net.imput.helium", "chromium", "BraveSoftware/Brave-Browser", "vivaldi"].iter().map(|d| config.join(d).join(HINT)).find(|p| p.exists());
    if let Some(source) = source {
        let _ = std::fs::create_dir_all(profile.join("WidevineCdm"));
        let _ = std::fs::copy(source, profile.join(HINT));
    }
}

#[derive(Default)]
struct State {
    // the app window's page, once attached; its commands wait until then
    session: Option<String>,
    queued: Vec<(&'static str, Value)>,
}

struct Inner {
    pipe: Mutex<std::io::PipeWriter>,
    next: AtomicU64,
    state: Mutex<State>,
}

/// The page in the browser's app window.
#[derive(Clone)]
pub struct Page(Arc<Inner>);

impl Page {
    fn raw(&self, method: &str, params: Value, session: Option<&str>) -> u64 {
        let id = self.0.next.fetch_add(1, Ordering::Relaxed);
        let mut msg = json!({ "id": id, "method": method, "params": params });
        if let Some(s) = session {
            msg["sessionId"] = s.into();
        }
        let mut bytes = msg.to_string().into_bytes();
        bytes.push(0);
        let _ = self.0.pipe.lock().unwrap().write_all(&bytes);
        id
    }

    /// A DevTools command for the page.
    pub fn send(&self, method: &'static str, params: Value) -> u64 {
        let mut state = self.0.state.lock().unwrap();
        match &state.session {
            Some(s) => self.raw(method, params, Some(s)),
            None => {
                state.queued.push((method, params));
                0
            }
        }
    }

    pub fn eval(&self, js: &str) {
        self.send("Runtime.evaluate", json!({ "expression": js }));
    }

    pub fn load(&self, url: &str) {
        self.send("Page.navigate", json!({ "url": url }));
    }

    pub fn front(&self) {
        self.send("Page.bringToFront", json!({}));
    }
}

fn poll() -> Value {
    json!({ "expression": "window.__ipcNext()", "awaitPromise": true, "returnByValue": true })
}

/// Starts the browser on `profile` with an empty app window. `scripts` run
/// in every page before its own; `on_ipc` gets each window.ipc message and
/// `on_exit` is called once the browser has gone (its window was closed).
pub fn open(
    browser: &Path,
    profile: &Path,
    scripts: Vec<String>,
    on_ipc: impl Fn(String) + Send + 'static,
    on_exit: impl Fn() + Send + 'static,
) -> std::io::Result<Page> {
    seed_widevine(profile);
    let (commands, pipe) = std::io::pipe()?;
    let (events, replies) = std::io::pipe()?;
    let (r, w) = (commands.as_raw_fd(), replies.as_raw_fd());
    let mut cmd = Command::new(browser);
    cmd.arg(format!("--user-data-dir={}", profile.display()))
        .args(["--remote-debugging-pipe", "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required", "--window-size=1200,800"])
        // the pipe marks the page as automated (navigator.webdriver), which
        // SoundCloud's bot checks would act on; a person is using this window
        // --test-type keeps the browser from drawing a warning strip about that flag
        .args(["--disable-blink-features=AutomationControlled", "--test-type"])
        // an empty dark page until the first load; app mode refuses about:blank
        .arg("--app=data:text/html,<html style=background:%23121212><title>SoundCloud</title>")
        // the Claude desktop app's value (in its terminal) crashes Chromium's zygote
        .env_remove("CHROME_DESKTOP")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    unsafe {
        cmd.pre_exec(move || {
            // through high numbers first: r or w may itself be 3 or 4
            let (r, w) = (libc::fcntl(r, libc::F_DUPFD_CLOEXEC, 10), libc::fcntl(w, libc::F_DUPFD_CLOEXEC, 10));
            if r < 0 || w < 0 || libc::dup2(r, 3) < 0 || libc::dup2(w, 4) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        })
    };
    let mut child = cmd.spawn()?;
    drop((commands, replies));

    let page = Page(Arc::new(Inner { pipe: Mutex::new(pipe), next: AtomicU64::new(1), state: Mutex::default() }));
    let p = page.clone();
    std::thread::spawn(move || {
        let mut reader = std::io::BufReader::new(events);
        let (mut buf, mut window, mut polling) = (Vec::new(), None::<String>, 0);
        p.raw("Target.setDiscoverTargets", json!({ "discover": true }), None);
        loop {
            buf.clear();
            if reader.read_until(0, &mut buf).unwrap_or(0) == 0 {
                break; // the browser has gone
            }
            let Ok(m) = serde_json::from_slice::<Value>(buf.strip_suffix(&[0]).unwrap_or(&buf)) else { continue };
            let target = &m["params"]["targetInfo"];
            match m["method"].as_str() {
                // the first page is the app window's
                Some("Target.targetCreated") if window.is_none() && target["type"] == "page" => {
                    p.raw("Target.attachToTarget", json!({ "targetId": target["targetId"], "flatten": true }), None);
                    window = target["targetId"].as_str().map(String::from);
                }
                Some("Target.attachedToTarget") => {
                    let Some(session) = m["params"]["sessionId"].as_str() else { continue };
                    let mut state = p.0.state.lock().unwrap();
                    p.raw("Page.enable", json!({}), Some(session));
                    for source in std::iter::once(&IPC.to_string()).chain(&scripts) {
                        p.raw("Page.addScriptToEvaluateOnNewDocument", json!({ "source": source }), Some(session));
                    }
                    for (method, params) in state.queued.drain(..) {
                        p.raw(method, params, Some(session));
                    }
                    polling = p.raw("Runtime.evaluate", poll(), Some(session));
                    state.session = Some(session.to_string());
                }
                // its window closed while a popup's is still open: that ends the app too
                Some("Target.targetDestroyed") if m["params"]["targetId"].as_str() == window.as_deref() => {
                    p.raw("Browser.close", json!({}), None);
                }
                None if m["id"] == polling => {
                    match m["result"]["result"]["value"].as_array() {
                        Some(messages) => messages.iter().filter_map(Value::as_str).for_each(|s| on_ipc(s.to_string())),
                        // not a page of ours yet, or it went to another address: ask its next one
                        None => std::thread::sleep(std::time::Duration::from_millis(200)),
                    }
                    polling = p.send("Runtime.evaluate", poll());
                }
                None if !m["error"].is_null() => eprintln!("browser: {}", m["error"]["message"]),
                _ => {}
            }
        }
        let _ = child.wait();
        on_exit();
    });
    Ok(page)
}
