// Downloads with yt-dlp, as the Electron app's downloadManager.ts: a button
// under every track, album and playlist (chrome.js) queues the URL here, at
// most two run at once, and the page's downloads panel gets the whole list a
// few times a second. Signed in, yt-dlp gets the account's token (Go+ streams,
// uploaders' original files) on stdin, never on its command line. On top of
// the Electron one: every track of an album or playlist is listed with its
// own state, and each saved file says its size and quality, low quality
// (under 160 kbps, what's left when nothing better is offered) marked.
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

const MAX_RUNNING: usize = 2;
const TEMPLATE: &str = "%(uploader)s - %(title)s.%(ext)s";
const SET_FOLDER: &str = "%(playlist_uploader)s - %(playlist_title)s";
// The uploader's original file when there is one (only for a signed-in
// account), else the best full stream; never a Go+ preview.
const FORMAT: &str = "download/bestaudio[format_id!*=preview]";
const PROGRESS: &str = "SCRPC_PROGRESS ";
const FILE: &str = "SCRPC_FILE ";

#[derive(Default)]
struct Track {
    id: String,
    title: String,
    status: &'static str, // waiting, downloading, done, skipped, failed
    downloaded: Option<f64>,
    total: Option<f64>,
    file: String,
    size: u64,
    format: String,
    abr: Option<f64>,
    ext: String,
    reason: String,
}

struct Item {
    id: u32,
    url: String,
    title: String,
    status: &'static str, // queued, downloading, processing, done, error, cancelled
    is_set: bool,
    speed: Option<f64>,
    eta: Option<f64>,
    tracks: Vec<Track>,
    error: String,
    token: Option<String>,
    child: Option<Arc<Mutex<Child>>>,
}

#[derive(Default)]
struct State {
    items: Vec<Item>,
    next: u32,
    dirty: bool,
}

#[derive(Clone)]
pub struct Downloads(Arc<Mutex<State>>);

fn quality(t: &Track) -> Value {
    let label = match (t.format.as_str(), t.abr) {
        ("download", _) => format!("Original file ({})", t.ext.to_uppercase()),
        (f, Some(abr)) => {
            let codec = if f.contains("mp3") { "MP3" } else if f.contains("opus") { "Opus" } else { "AAC" };
            format!("{} kbps {codec}", abr.round())
        }
        _ => t.ext.to_uppercase(),
    };
    // 160 kbps AAC is SoundCloud's normal stream; less is what's left when that isn't offered
    json!({ "label": label, "low": t.format != "download" && t.abr.is_some_and(|a| a < 159.0) })
}

impl Item {
    fn json(&self) -> Value {
        let tracks: Vec<Value> = self
            .tracks
            .iter()
            .map(|t| {
                let done = t.status == "done";
                json!({ "title": t.title, "status": t.status, "downloaded": t.downloaded, "total": t.total,
                        "size": t.size, "reason": t.reason, "hasFile": !t.file.is_empty(),
                        "quality": if done { quality(t) } else { Value::Null } })
            })
            .collect();
        json!({ "id": self.id, "title": self.title, "status": self.status, "isSet": self.is_set, "speed": self.speed,
                "eta": self.eta, "error": self.error, "tracks": tracks })
    }
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default())
}

/// A download setting from the settings panel; empty means the default.
fn setting(key: &str) -> Option<String> {
    crate::load_settings()[key].as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

pub fn folder() -> PathBuf {
    setting("downloadFolder").map(PathBuf::from).unwrap_or_else(|| home().join("Downloads"))
}

// A GUI app gets a bare PATH on macOS, so the usual install places are added;
// yt-dlp gets the same list so it finds ffmpeg (HLS streams, covers, tags).
fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    dirs.push(home().join(".local/bin"));
    dirs
}

fn find(name: &str) -> Option<PathBuf> {
    let exe = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    search_dirs().into_iter().map(|d| d.join(&exe)).find(|p| p.exists())
}

/// The account's token as yt-dlp options. It comes from a cookie, so anything
/// but a plain token is refused: these lines are parsed as options.
fn auth_config(token: &str) -> Option<String> {
    let ok = !token.is_empty() && token.len() <= 256 && token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    ok.then(|| format!("--username oauth\n--password {token}\n"))
}

fn args(url: &str, is_set: bool, auth: bool, items: &[usize], tags: bool) -> Vec<String> {
    let progress = format!(
        "download:{PROGRESS}{{\"status\":%(progress.status|null)j,\"downloaded\":%(progress.downloaded_bytes|null)j,\"total\":%(progress.total_bytes|null)j,\"estimate\":%(progress.total_bytes_estimate|null)j,\"speed\":%(progress.speed|null)j,\"eta\":%(progress.eta|null)j,\"index\":%(info.playlist_index|null)j,\"title\":%(info.title|null)j}}"
    );
    // printed before the cover and tags go in, so a file that can't take them still counts
    let file = format!("post_process:{FILE}{{\"file\":%(filepath)j,\"index\":%(playlist_index|null)j,\"id\":%(id)j,\"format\":%(format_id|null)j,\"abr\":%(abr|null)j,\"ext\":%(ext|null)j,\"title\":%(title|null)j}}");
    let mut a: Vec<String> = Vec::new();
    if auth {
        a.extend(["--config-locations", "-"].map(String::from));
    }
    if !items.is_empty() {
        a.extend(["--playlist-items".into(), items.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",")]);
    }
    if tags {
        a.extend(["--embed-thumbnail", "--embed-metadata"].map(String::from));
    }
    let template = setting("downloadTemplate").unwrap_or(TEMPLATE.into());
    let out = if is_set { format!("{}/{template}", setting("downloadPlaylistFolder").unwrap_or(SET_FOLDER.into())) } else { template };
    a.extend(["--newline", "--progress", "--progress-template", &progress, "--print", &file, "-f", FORMAT, "-P"].map(String::from));
    a.push(folder().to_string_lossy().into_owned());
    a.extend(["-o".into(), out, "--".into(), url.into()]);
    a
}

/// Why yt-dlp left a track out, or None for any other line.
fn skip_reason(line: &str) -> Option<&'static str> {
    let l = line.to_lowercase();
    if l.contains("drm protected") {
        Some("DRM-protected")
    } else if l.contains("requested format is not available") {
        Some("Go+ only") // only previews were left for FORMAT to refuse
    } else if line.contains("HTTP Error 401") || line.contains("HTTP Error 403") {
        Some("not authorized")
    } else {
        None
    }
}

fn num(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite())
}

impl Downloads {
    /// `push` gets the list as JSON whenever it changed, at most 5 times a second.
    pub fn new(push: impl Fn(String) + Send + 'static) -> Self {
        let d = Downloads(Arc::new(Mutex::new(State::default())));
        let s = d.0.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_millis(200));
            let mut st = s.lock().unwrap();
            if st.dirty {
                st.dirty = false;
                let list = Value::Array(st.items.iter().map(Item::json).collect()).to_string();
                drop(st);
                push(list);
            }
        });
        d
    }

    fn changed(st: &mut State) {
        st.dirty = true;
    }

    /// From the page: `{ url, token, title, tracks: [{ id, title }] }`.
    pub fn start(&self, req: &Value) {
        let Some(url) = req["url"].as_str().filter(|u| u.starts_with("https://soundcloud.com/")) else { return };
        let url = url.split(['?', '#']).next().unwrap().to_string(); // "?in=<playlist>" etc. only say where it was opened
        let tracks: Vec<Track> = req["tracks"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|t| Track { id: t["id"].as_u64().map(|i| i.to_string()).unwrap_or_default(), title: t["title"].as_str().unwrap_or("").into(), status: "waiting", ..Default::default() })
            .collect();
        let mut st = self.0.lock().unwrap();
        st.next += 1;
        let item = Item {
            id: st.next,
            title: req["title"].as_str().filter(|t| !t.is_empty()).unwrap_or(&url).into(),
            is_set: url.contains("/sets/"),
            url,
            status: "queued",
            speed: None,
            eta: None,
            tracks,
            error: String::new(),
            token: req["token"].as_str().and_then(auth_config),
            child: None,
        };
        st.items.insert(0, item);
        Self::changed(&mut st);
        drop(st);
        self.run_queued();
    }

    fn run_queued(&self) {
        let mut st = self.0.lock().unwrap();
        let running = st.items.iter().filter(|i| matches!(i.status, "downloading" | "processing")).count();
        // oldest first
        let ids: Vec<u32> = st.items.iter().rev().filter(|i| i.status == "queued").map(|i| i.id).take(MAX_RUNNING.saturating_sub(running)).collect();
        for id in &ids {
            if let Some(i) = st.items.iter_mut().find(|i| i.id == *id) {
                i.status = "downloading";
            }
        }
        Self::changed(&mut st);
        drop(st);
        for id in ids {
            let d = self.clone();
            std::thread::spawn(move || {
                d.run(id);
                d.run_queued();
            });
        }
    }

    fn with<R>(&self, id: u32, f: impl FnOnce(&mut Item) -> R) -> Option<R> {
        let mut st = self.0.lock().unwrap();
        let r = st.items.iter_mut().find(|i| i.id == id).map(f);
        Self::changed(&mut st);
        r
    }

    fn run(&self, id: u32) {
        let Some(binary) = find("yt-dlp") else {
            self.with(id, |i| {
                i.status = "error";
                i.error = "yt-dlp was not found. Install it (brew install yt-dlp, winget install yt-dlp or pip install yt-dlp).".into();
            });
            return;
        };
        let tags = find("ffmpeg").is_some();
        let Some((url, is_set, auth)) = self.with(id, |i| (i.url.clone(), i.is_set, i.token.take())) else { return };
        let mut items: Vec<usize> = Vec::new();
        for pass in 0..2 {
            let failed = self.pass(id, &binary, &args(&url, is_set, auth.is_some(), &items, tags), auth.as_deref());
            let again = self.with(id, |i| {
                if i.status == "cancelled" || !failed || pass == 1 {
                    return None;
                }
                // a failure yt-dlp didn't call final is often SoundCloud timing
                // out: one more go at whatever is still missing
                let missing: Vec<usize> = i.tracks.iter().enumerate().filter(|(_, t)| t.status == "failed" || t.status == "waiting").map(|(n, _)| n + 1).collect();
                if missing.is_empty() && !i.tracks.is_empty() {
                    return None;
                }
                for t in i.tracks.iter_mut().filter(|t| t.status == "failed") {
                    t.status = "waiting";
                    t.reason.clear();
                }
                i.error.clear();
                Some(if is_set { missing } else { Vec::new() })
            });
            match again.flatten() {
                Some(m) => items = m,
                None => break,
            }
        }
        self.with(id, |i| {
            // sizes once the covers and tags are in
            for t in i.tracks.iter_mut().filter(|t| !t.file.is_empty()) {
                t.size = std::fs::metadata(&t.file).map(|m| m.len()).unwrap_or(t.size);
            }
            for t in i.tracks.iter_mut().filter(|t| t.status == "waiting" || t.status == "downloading") {
                t.status = "failed";
            }
            i.child = None;
            i.speed = None;
            i.eta = None;
            if i.status == "cancelled" {
                return;
            }
            let saved = i.tracks.iter().filter(|t| t.status == "done").count();
            i.status = if saved > 0 { "done" } else { "error" };
            if saved == 0 && i.error.is_empty() {
                let reasons: Vec<&str> = i.tracks.iter().map(|t| t.reason.as_str()).filter(|r| !r.is_empty()).collect();
                i.error = if reasons.is_empty() { "yt-dlp couldn't download this".into() } else { format!("Can't be downloaded ({})", reasons.join(", ")) };
            }
        });
    }

    /// One yt-dlp run; true if something failed for a reason worth a retry.
    fn pass(&self, id: u32, binary: &PathBuf, args: &[String], auth: Option<&str>) -> bool {
        let path = std::env::join_paths(search_dirs()).unwrap_or_default();
        let mut cmd = Command::new(binary);
        cmd.args(args).env("PATH", path).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                self.with(id, |i| i.error = format!("yt-dlp didn't start: {e}"));
                return false;
            }
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(auth.unwrap_or("").as_bytes());
        }
        let (stdout, stderr) = (child.stdout.take().unwrap(), child.stderr.take().unwrap());
        let child = Arc::new(Mutex::new(child));
        self.with(id, |i| i.child = Some(child.clone()));

        // one ERROR line per track yt-dlp gave up on; it carries on with the rest
        let d = self.clone();
        let errors = std::thread::spawn(move || {
            let mut retry = false;
            for line in std::io::BufReader::new(stderr).lines().map_while(Result::ok) {
                let Some(msg) = line.strip_prefix("ERROR:") else { continue };
                if msg.trim_start().starts_with("Postprocessing:") {
                    continue; // saved all the same, without its cover or tags
                }
                let reason = skip_reason(&line);
                retry |= reason.is_none();
                // "ERROR: [soundcloud] 12345: ..." names the track by id
                let track_id = msg.trim_start().strip_prefix("[soundcloud] ").and_then(|r| r.split(':').next()).unwrap_or("").to_string();
                d.with(id, |i| {
                    let single = i.tracks.len() == 1;
                    let n = i.tracks.iter().position(|t| !t.id.is_empty() && t.id == track_id).or(single.then_some(0));
                    match n.map(|n| &mut i.tracks[n]) {
                        Some(t) => {
                            t.status = if reason.is_some() { "skipped" } else { "failed" };
                            t.reason = reason.unwrap_or("failed").into();
                        }
                        None if reason.is_none() => i.error = msg.trim().to_string(),
                        None => {}
                    }
                });
            }
            retry
        });

        for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(json) = line.strip_prefix(PROGRESS) {
                let Ok(p) = serde_json::from_str::<Value>(json) else { continue };
                self.with(id, |i| {
                    if i.status == "cancelled" {
                        return;
                    }
                    let n = p["index"].as_u64().unwrap_or(1) as usize;
                    while i.tracks.len() < n {
                        let k = i.tracks.len() + 1;
                        i.tracks.push(Track { title: format!("Track {k}"), status: "waiting", ..Default::default() });
                    }
                    let t = &mut i.tracks[n - 1];
                    if let Some(title) = p["title"].as_str().filter(|_| t.title.is_empty() || t.title.starts_with("Track ")) {
                        t.title = title.into();
                    }
                    let (done, total) = (num(&p["downloaded"]), num(&p["total"]).or(num(&p["estimate"])));
                    t.status = "downloading";
                    (t.downloaded, t.total) = (done, total);
                    i.speed = num(&p["speed"]);
                    // no ETA from yt-dlp for HLS streams, which SoundCloud mostly serves
                    i.eta = num(&p["eta"]).or_else(|| Some((total? - done?).max(0.0) / i.speed.filter(|s| *s > 0.0)?));
                    i.status = if p["status"] == "finished" { "processing" } else { "downloading" };
                });
            } else if let Some(json) = line.strip_prefix(FILE) {
                let Ok(f) = serde_json::from_str::<Value>(json) else { continue };
                self.with(id, |i| {
                    if i.status == "cancelled" {
                        return;
                    }
                    let n = f["index"].as_u64().unwrap_or(1) as usize;
                    while i.tracks.len() < n {
                        let k = i.tracks.len() + 1;
                        i.tracks.push(Track { title: format!("Track {k}"), status: "waiting", ..Default::default() });
                    }
                    let t = &mut i.tracks[n - 1];
                    t.file = f["file"].as_str().unwrap_or("").into();
                    t.size = std::fs::metadata(&t.file).map(|m| m.len()).unwrap_or(0);
                    t.format = f["format"].as_str().unwrap_or("").into();
                    t.abr = num(&f["abr"]);
                    t.ext = f["ext"].as_str().unwrap_or("").into();
                    if t.id.is_empty() {
                        t.id = f["id"].as_str().unwrap_or("").into();
                    }
                    if t.title.is_empty() || t.title.starts_with("Track ") {
                        t.title = f["title"].as_str().unwrap_or(&t.title).to_string();
                    }
                    t.status = "done";
                    t.reason.clear();
                    i.status = "downloading";
                });
            }
        }
        let retry = errors.join().unwrap_or(false);
        let ok = child.lock().unwrap().wait().map(|s| s.success()).unwrap_or(false);
        !ok && retry
    }

    pub fn cancel(&self, id: u32) {
        self.with(id, |i| {
            if matches!(i.status, "queued" | "downloading" | "processing") {
                i.status = "cancelled";
                if let Some(c) = &i.child {
                    kill_tree(&mut c.lock().unwrap());
                }
            }
        });
    }

    /// Stops every yt-dlp, which would otherwise outlive the app.
    pub fn cancel_all(&self) {
        let ids: Vec<u32> = self.0.lock().unwrap().items.iter().map(|i| i.id).collect();
        ids.into_iter().for_each(|id| self.cancel(id));
    }

    pub fn clear(&self) {
        let mut st = self.0.lock().unwrap();
        st.items.retain(|i| matches!(i.status, "queued" | "downloading" | "processing"));
        Self::changed(&mut st);
    }

    /// The page names a download (and a track of it), never a path.
    pub fn file(&self, id: u32, track: Option<usize>) -> Option<PathBuf> {
        let st = self.0.lock().unwrap();
        let i = st.items.iter().find(|i| i.id == id)?;
        let t = match track {
            Some(n) => i.tracks.get(n)?,
            None => i.tracks.iter().rev().find(|t| !t.file.is_empty())?,
        };
        (!t.file.is_empty()).then(|| PathBuf::from(&t.file))
    }

    pub fn list(&self) -> String {
        let st = self.0.lock().unwrap();
        Value::Array(st.items.iter().map(Item::json).collect()).to_string()
    }
}

/// Stops yt-dlp and what it started. On Windows yt-dlp.exe is a launcher
/// whose own child does the download (and runs ffmpeg), so kill the tree.
fn kill_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill").args(["/T", "/F", "/PID", &child.id().to_string()]).creation_flags(0x0800_0000).status();
    }
    let _ = child.kill();
}

/// Shows a file in Finder / Explorer, or opens a folder.
pub fn reveal(path: &std::path::Path, select: bool) {
    #[cfg(target_os = "macos")]
    let _ = if select { Command::new("open").arg("-R").arg(path).spawn() } else { Command::new("open").arg(path).spawn() };
    #[cfg(target_os = "windows")]
    let _ = if select { Command::new("explorer").arg(format!("/select,{}", path.display())).spawn() } else { Command::new("explorer").arg(path).spawn() };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_is_a_plain_token_only() {
        assert!(auth_config("2-123_abcDEF").is_some());
        assert!(auth_config("x\n--exec rm").is_none());
        assert!(auth_config("").is_none());
    }

    #[test]
    fn quality_labels() {
        let t = |format: &str, abr: Option<f64>, ext: &str| Track { format: format.into(), abr, ext: ext.into(), ..Default::default() };
        assert_eq!(quality(&t("hls_aac_96k", Some(96.0), "m4a")), json!({ "label": "96 kbps AAC", "low": true }));
        assert_eq!(quality(&t("hls_aac_160k", Some(160.0), "m4a")), json!({ "label": "160 kbps AAC", "low": false }));
        assert_eq!(quality(&t("http_mp3_128", Some(128.0), "mp3")), json!({ "label": "128 kbps MP3", "low": true }));
        assert_eq!(quality(&t("download", None, "wav")), json!({ "label": "Original file (WAV)", "low": false }));
    }

    #[test]
    fn skips() {
        assert_eq!(skip_reason("ERROR: [soundcloud] 1: This video is DRM protected"), Some("DRM-protected"));
        assert_eq!(skip_reason("ERROR: [soundcloud] 1: Requested format is not available"), Some("Go+ only"));
        assert_eq!(skip_reason("ERROR: timed out"), None);
    }
}
