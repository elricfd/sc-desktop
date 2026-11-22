// Linux: Go+ and other Widevine-only tracks play here rather than in the page,
// as WebKitGTK has no DRM. GStreamer plays SoundCloud's encrypted HLS, and
// Sparkle-CDM's decryptor runs the Widevine library a browser on this machine
// has downloaded, through the module linux-drm/build.sh builds. The custom
// UI's stand-in for its <audio> element sends play, pause, seek, volume and
// stop (main.rs), and gets every change back through `Emit`.
use gst::prelude::*;
use gstreamer as gst;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

const LICENSE: &str = "https://license.media-streaming.soundcloud.cloud/playback/widevine";

/// Events for the page's stand-in (as <audio> names them) and its state.
pub type Emit = Arc<dyn Fn(&[&str], Value) + Send + Sync>;

/// linux-drm/build.sh's output: $SC_DRM_DIR, else target/linux-drm beside this build.
fn drm_dir() -> Option<PathBuf> {
    let dir = match std::env::var_os("SC_DRM_DIR") {
        Some(d) => PathBuf::from(d),
        None => std::env::current_exe().ok()?.parent()?.parent()?.join("linux-drm"),
    };
    dir.join("lib64/gstreamer-1.0/libgstsprkl.so").is_file().then_some(dir)
}

/// The Widevine library a browser keeps: the version its hint file names, else any.
fn widevine_blob() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("WIDEVINE_CDM_BLOB") {
        return Some(p.into());
    }
    const LIB: &str = "_platform_specific/linux_x64/libwidevinecdm.so";
    let home = PathBuf::from(std::env::var_os("HOME")?);
    let config = std::env::var_os("XDG_CONFIG_HOME").filter(|d| !d.is_empty()).map(PathBuf::from).unwrap_or_else(|| home.join(".config"));
    let profiles = ["net.imput.helium", "google-chrome", "chromium", "BraveSoftware/Brave-Browser", "vivaldi", "microsoft-edge"];
    for dir in profiles.iter().map(|p| config.join(p).join("WidevineCdm")) {
        let hinted = std::fs::read_to_string(dir.join("latest-component-updated-widevine-cdm"))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v["Path"].as_str().map(PathBuf::from));
        let versions = std::fs::read_dir(&dir).into_iter().flatten().flatten().map(|e| e.path());
        if let Some(lib) = hinted.into_iter().chain(versions).map(|v| v.join(LIB)).find(|l| l.is_file()) {
            return Some(lib);
        }
    }
    // Chrome's own copy, then Firefox's (profile/gmp-widevinecdm/<version>/)
    let chrome = PathBuf::from("/opt/google/chrome/WidevineCdm").join(LIB);
    if chrome.is_file() {
        return Some(chrome);
    }
    let firefox = std::fs::read_dir(home.join(".mozilla/firefox")).into_iter().flatten().flatten();
    firefox
        .flat_map(|p| std::fs::read_dir(p.path().join("gmp-widevinecdm")).into_iter().flatten().flatten())
        .map(|v| v.path().join("libwidevinecdm.so"))
        .find(|l| l.is_file())
}

/// Called first thing in main, before any thread: the OpenCDM module reads
/// where it is and where Widevine is from the environment.
pub fn prepare_env() {
    if let (Some(drm), Some(blob)) = (drm_dir(), widevine_blob()) {
        // SAFETY: no other thread exists yet
        unsafe {
            std::env::set_var("WEBKIT_SPARKLE_CDM_MODULE_PATH", drm.join("lib64/libsparkle-cdm-widevine.so"));
            std::env::set_var("WIDEVINE_CDM_BLOB", blob);
        }
    }
}

/// GStreamer with the decryptor loaded, once; Err says what's missing.
fn ready() -> Result<(), String> {
    static READY: OnceLock<Result<(), String>> = OnceLock::new();
    READY
        .get_or_init(|| {
            let drm = drm_dir().ok_or("Go+ needs the Widevine decryptor: run linux-drm/build.sh")?;
            if std::env::var_os("WIDEVINE_CDM_BLOB").is_none() {
                return Err("Go+ needs Widevine: open a DRM video once in Chrome, Helium, Brave or Firefox".into());
            }
            gst::init().map_err(|e| e.to_string())?;
            // loaded into this process only, not GStreamer's shared registry
            gst::Plugin::load_file(drm.join("lib64/gstreamer-1.0/libgstsprkl.so")).map_err(|e| format!("decryptor: {e}"))?;
            Ok(())
        })
        .clone()
}

#[derive(Default)]
struct State {
    duration: Option<f64>,
    // what the page asked for, and what the pipeline has reached
    want_playing: bool,
    playing: bool,
    ended: bool,
    prerolled: bool,
    seeking: bool,
    pending_seek: Option<f64>,
    error: Option<String>,
}

/// One track playing; dropping it stops it.
pub struct Player {
    playbin: gst::Element,
    state: Arc<Mutex<State>>,
    started: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    playlist: PathBuf,
}

impl Player {
    /// Plays SoundCloud's encrypted HLS playlist `url` with its `token` (the
    /// stream's licenseAuthToken), at `volume` (0 to 1).
    pub fn play(url: String, token: String, volume: f64, emit: Emit) -> Result<Player, String> {
        ready()?;
        let playbin = gst::ElementFactory::make("playbin").build().map_err(|e| e.to_string())?;
        playbin.set_property_from_str("flags", "audio+soft-volume");
        playbin.set_property("volume", volume.clamp(0.0, 1.0));
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        let playlist = dir.join(format!("fairplay-spike-{}-{}.m3u8", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        let player = Player {
            playbin,
            state: Arc::new(Mutex::new(State { want_playing: true, ..State::default() })),
            started: Arc::new(AtomicBool::new(false)),
            stop: Arc::new(AtomicBool::new(false)),
            playlist,
        };
        let license = format!("{LICENSE}?license_token={}", encode(&token));
        player.watch(license, emit.clone());
        // the playlist is fetched off the event loop; then the pipeline starts
        let (pb, state, started, stop, path) = (player.playbin.clone(), player.state.clone(), player.started.clone(), player.stop.clone(), player.playlist.clone());
        std::thread::spawn(move || {
            let result = local_playlist(&url, &path);
            if stop.load(Ordering::Relaxed) {
                return;
            }
            if let Err(e) = result {
                fail(&state, &emit, &pb, format!("playlist: {e}"));
                return;
            }
            pb.set_property("uri", format!("file://{}", path.display()));
            let target = if state.lock().unwrap().want_playing { gst::State::Playing } else { gst::State::Paused };
            started.store(true, Ordering::Relaxed);
            if pb.set_state(target).is_err() {
                fail(&state, &emit, &pb, "the pipeline wouldn't start".into());
            }
        });
        Ok(player)
    }

    pub fn pause(&self) {
        self.state.lock().unwrap().want_playing = false;
        if self.started.load(Ordering::Relaxed) {
            let _ = self.playbin.set_state(gst::State::Paused);
        }
    }

    pub fn resume(&self) {
        let mut st = self.state.lock().unwrap();
        st.want_playing = true;
        // after the end, play starts the track again, as <audio> does
        if st.ended {
            st.ended = false;
            st.pending_seek = Some(0.0);
        }
        drop(st);
        if self.started.load(Ordering::Relaxed) {
            let _ = self.playbin.set_state(gst::State::Playing);
            self.flush_seek();
        }
    }

    pub fn seek(&self, seconds: f64) {
        let mut st = self.state.lock().unwrap();
        st.pending_seek = Some(seconds.max(0.0));
        st.ended = false;
        drop(st);
        self.flush_seek();
    }

    pub fn set_volume(&self, volume: f64) {
        self.playbin.set_property("volume", volume.clamp(0.0, 1.0));
    }

    // A seek waits for the pipeline to have prerolled.
    fn flush_seek(&self) {
        let mut st = self.state.lock().unwrap();
        if !st.prerolled {
            return;
        }
        if let Some(s) = st.pending_seek.take() {
            st.seeking = true;
            drop(st);
            let at = gst::ClockTime::from_nseconds((s * 1e9) as u64);
            let _ = self.playbin.seek_simple(gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE, at);
        }
    }

    /// The bus: the licence exchange, state changes for the page, and its
    /// position four times a second while playing.
    fn watch(&self, license: String, emit: Emit) {
        let (pb, state, stop) = (self.playbin.clone(), self.state.clone(), self.stop.clone());
        let bus = pb.bus().expect("playbin has a bus");
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let Some(msg) = bus.timed_pop(gst::ClockTime::from_mseconds(250)) else {
                    let st = state.lock().unwrap();
                    if st.playing && !st.seeking {
                        drop(st);
                        send(&emit, &["timeupdate"], &pb, &state);
                    }
                    continue;
                };
                use gst::MessageView as M;
                match msg.view() {
                    M::Element(e) => {
                        let Some(s) = e.structure() else { continue };
                        if s.name() == "spkl-challenge" {
                            if let (Ok(challenge), Some(src)) = (s.get::<gst::Buffer>("challenge"), msg.src()) {
                                answer_challenge(src.clone(), challenge, license.clone(), state.clone(), emit.clone(), pb.clone());
                            }
                        }
                    }
                    M::StateChanged(sc) if msg.src() == Some(pb.upcast_ref()) => {
                        let now = sc.current() == gst::State::Playing;
                        let was = std::mem::replace(&mut state.lock().unwrap().playing, now);
                        if now && !was {
                            send(&emit, &["play", "playing"], &pb, &state);
                        } else if was && !now {
                            send(&emit, &["pause"], &pb, &state);
                        }
                    }
                    M::AsyncDone(_) => {
                        let mut st = state.lock().unwrap();
                        let mut events = vec![];
                        if !st.prerolled {
                            st.prerolled = true;
                            st.duration = pb.query_duration::<gst::ClockTime>().map(secs);
                            events.extend(["durationchange", "loadedmetadata", "canplay"]);
                        }
                        if st.seeking {
                            st.seeking = false;
                            events.push("seeked");
                        }
                        let seek = st.pending_seek.take();
                        drop(st);
                        send(&emit, &events, &pb, &state);
                        if let Some(s) = seek {
                            state.lock().unwrap().seeking = true;
                            let _ = pb.seek_simple(gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE, gst::ClockTime::from_nseconds((s * 1e9) as u64));
                        }
                    }
                    M::DurationChanged(_) => {
                        state.lock().unwrap().duration = pb.query_duration::<gst::ClockTime>().map(secs);
                        send(&emit, &["durationchange"], &pb, &state);
                    }
                    M::Eos(_) => {
                        let mut st = state.lock().unwrap();
                        st.ended = true;
                        st.want_playing = false;
                        drop(st);
                        let _ = pb.set_state(gst::State::Paused);
                        send(&emit, &["pause", "ended"], &pb, &state);
                    }
                    M::Error(e) => fail(&state, &emit, &pb, format!("{} ({})", e.error(), e.debug().unwrap_or_default())),
                    _ => {}
                }
            }
        });
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.playbin.set_state(gst::State::Null);
        let _ = std::fs::remove_file(&self.playlist);
    }
}

fn secs(t: gst::ClockTime) -> f64 {
    t.nseconds() as f64 / 1e9
}

/// The page's view of the player, as <audio> properties.
fn send(emit: &Emit, events: &[&str], pb: &gst::Element, state: &Mutex<State>) {
    let st = state.lock().unwrap();
    let position = pb.query_position::<gst::ClockTime>().map(secs).unwrap_or(0.0);
    let snapshot = json!({
        "currentTime": position,
        "duration": st.duration.unwrap_or(f64::NAN),
        "paused": !st.want_playing,
        "ended": st.ended,
        "seeking": st.seeking,
        "readyState": if st.prerolled { 4 } else { 0 },
        "error": st.error.as_ref().map(|m| json!({ "code": 4, "message": m })),
    });
    drop(st);
    emit(events, snapshot);
}

fn fail(state: &Mutex<State>, emit: &Emit, pb: &gst::Element, message: String) {
    eprintln!("goplus: {message}");
    let mut st = state.lock().unwrap();
    st.error = Some(message);
    st.want_playing = false;
    drop(st);
    send(emit, &["error", "pause"], pb, state);
}

/// Widevine's licence request goes to SoundCloud's licence server, and its
/// answer back to the decryptor that asked (as an event from upstream of it).
fn answer_challenge(decryptor: gst::Object, challenge: gst::Buffer, url: String, state: Arc<Mutex<State>>, emit: Emit, pb: gst::Element) {
    std::thread::spawn(move || {
        let body = match challenge.map_readable() {
            Ok(m) => m.as_slice().to_vec(),
            Err(_) => return,
        };
        let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(15))).http_status_as_error(false).build().into();
        let licence = agent
            .post(&url)
            .header("Content-Type", "application/octet-stream")
            .send(&body[..])
            .map_err(|e| e.to_string())
            .and_then(|mut r| match r.status().as_u16() {
                200 => r.body_mut().read_to_vec().map_err(|e| e.to_string()),
                s => Err(format!("licence server answered {s}")),
            });
        let licence = match licence {
            Ok(l) => l,
            Err(e) => return fail(&state, &emit, &pb, format!("licence: {e}")),
        };
        let peer = decryptor.downcast::<gst::Element>().ok().and_then(|d| d.static_pad("sink")).and_then(|p| p.peer());
        let update = gst::Structure::builder("spkl-session-update").field("message", gst::Buffer::from_slice(licence)).build();
        if !peer.is_some_and(|p| p.push_event(gst::event::CustomDownstreamOob::new(update))) {
            fail(&state, &emit, &pb, "the decryptor didn't take the licence".into());
        }
    });
}

/// The playlist as GStreamer can play it, at `path`: its demuxers would fetch
/// EXT-X-KEY URIs as AES keys themselves, so those lines go (the decryptor
/// takes Widevine's data from the init segment), and addresses are made
/// absolute for a playlist that's now a local file.
fn local_playlist(url: &str, path: &Path) -> Result<(), String> {
    let mut res = ureq::get(url).call().map_err(|e| e.to_string())?;
    let text = res.body_mut().read_to_string().map_err(|e| e.to_string())?;
    if !text.starts_with("#EXTM3U") {
        return Err("not an HLS playlist".into());
    }
    let local = rewrite_playlist(&text, url);
    let mut opts = std::fs::OpenOptions::new();
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600); // signed segment addresses
    let mut file = opts.write(true).create(true).truncate(true).open(path).map_err(|e| e.to_string())?;
    std::io::Write::write_all(&mut file, local.as_bytes()).map_err(|e| e.to_string())
}

fn rewrite_playlist(text: &str, base: &str) -> String {
    let mut out = String::new();
    for line in text.lines() {
        if line.starts_with("#EXT-X-KEY:") {
            continue;
        }
        let line = if let Some(rest) = line.strip_prefix("#EXT-X-MAP:") {
            // URI="..." inside the tag's attributes
            match rest.split_once("URI=\"").and_then(|(a, b)| b.split_once('"').map(|(u, c)| (a, u, c))) {
                Some((a, u, c)) => format!("#EXT-X-MAP:{a}URI=\"{}\"{c}", absolute(base, u)),
                None => line.to_string(),
            }
        } else if !line.is_empty() && !line.starts_with('#') {
            absolute(base, line)
        } else {
            line.to_string()
        };
        out.push_str(&line);
        out.push('\n');
    }
    out
}

/// `reference` against `base`, for the forms playlists use: absolute,
/// host-relative (/...) and relative to the playlist's directory.
fn absolute(base: &str, reference: &str) -> String {
    if reference.contains("://") {
        return reference.to_string();
    }
    let base = base.split(['?', '#']).next().unwrap_or(base);
    let origin_end = base.find("://").map(|i| base[i + 3..].find('/').map_or(base.len(), |j| i + 3 + j)).unwrap_or(0);
    if reference.starts_with('/') {
        format!("{}{reference}", &base[..origin_end])
    } else {
        let dir = &base[..base.rfind('/').filter(|&i| i >= origin_end).map_or(base.len(), |i| i + 1)];
        let dir = if dir.ends_with('/') { dir.to_string() } else { format!("{dir}/") };
        format!("{dir}{reference}")
    }
}

/// Percent-encoding for a query value.
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn playlist_drops_keys_and_resolves_addresses() {
        let base = "https://cdn.example/media/abc/playlist.m3u8?sig=1";
        let text = "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"data:x\"\n#EXT-X-MAP:URI=\"init.mp4\",BYTERANGE=\"1@0\"\n#EXTINF:10,\nseg/1.m4s?t=2\n#EXTINF:10,\n/other/2.m4s\nhttps://x.example/3.m4s\n";
        let out = rewrite_playlist(text, base);
        assert!(!out.contains("EXT-X-KEY"));
        assert!(out.contains("#EXT-X-MAP:URI=\"https://cdn.example/media/abc/init.mp4\",BYTERANGE=\"1@0\""));
        assert!(out.contains("\nhttps://cdn.example/media/abc/seg/1.m4s?t=2\n"));
        assert!(out.contains("\nhttps://cdn.example/other/2.m4s\n"));
        assert!(out.contains("\nhttps://x.example/3.m4s\n"));
    }
    #[test]
    fn encodes_tokens() {
        assert_eq!(encode("a.b-c_d~e"), "a.b-c_d~e");
        assert_eq!(encode("x y/+="), "x%20y%2F%2B%3D");
    }
}
