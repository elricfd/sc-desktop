// Last.fm scrobbling, ported from the Electron app's lastFmService.ts: your own
// API key and secret, approval on last.fm in the default browser (back through
// a one-off 127.0.0.1 address), then "now playing" + scrobbles signed with the
// secret. Secret and session key live in the macOS Keychain; only the user
// name is kept in a plain file, so the page can show it without a Keychain read.
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const API: &str = "https://ws.audioscrobbler.com/2.0/";
const SERVICE: &str = "fairplay-spike.lastfm";
/// Sent to `run` after connecting or disconnecting, to re-read credentials.
pub const RELOAD: &str = "__reload";

fn keychain(key: &str) -> Option<String> {
    keyring::Entry::new(SERVICE, key).ok()?.get_password().ok()
}
fn keychain_set(key: &str, value: &str) -> Result<(), String> {
    keyring::Entry::new(SERVICE, key).and_then(|e| e.set_password(value)).map_err(|e| e.to_string())
}
fn keychain_del(key: &str) {
    if let Ok(e) = keyring::Entry::new(SERVICE, key) {
        let _ = e.delete_credential();
    }
}

fn user_path() -> std::path::PathBuf {
    crate::data_dir().join("lastfm.json")
}
/// `{connected, name}` for the settings panel.
pub fn status() -> Value {
    std::fs::read_to_string(user_path())
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .map(|v| json!({ "connected": v["name"].is_string(), "name": v["name"] }))
        .unwrap_or(json!({ "connected": false }))
}

/// Last.fm's signature: md5 of the sorted key+value pairs, then the secret.
pub fn sign(params: &BTreeMap<String, String>, secret: &str) -> String {
    let mut s: String = params.iter().filter(|(k, _)| *k != "format").map(|(k, v)| format!("{k}{v}")).collect();
    s.push_str(secret);
    format!("{:x}", md5::compute(s))
}

fn call(method: &str, mut params: BTreeMap<String, String>, secret: &str) -> Result<Value, String> {
    params.insert("method".into(), method.into());
    let sig = sign(&params, secret);
    params.insert("api_sig".into(), sig);
    params.insert("format".into(), "json".into());
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(10)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut res = agent.post(API).send_form(params.iter().map(|(k, v)| (k.as_str(), v.as_str()))).map_err(|e| e.to_string())?;
    let text = res.body_mut().read_to_string().map_err(|e| e.to_string())?;
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    match v.get("error") {
        Some(_) => Err(v["message"].as_str().unwrap_or("Last.fm error").to_string()),
        None => Ok(v),
    }
}

/// Opens Last.fm's approval page and waits (up to 5 minutes) for it to send
/// the token back; `notify` gets `{state: waiting|connected|error, ...}`.
pub fn connect(api_key: String, secret: String, notify: impl Fn(Value) + Send + 'static) {
    std::thread::spawn(move || {
        let result = (|| -> Result<String, String> {
            let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();
            let cb = format!("http%3A%2F%2F127.0.0.1%3A{port}%2Flastfm");
            let url = format!("https://www.last.fm/api/auth/?api_key={api_key}&cb={cb}");
            std::process::Command::new("open").arg(&url).spawn().map_err(|e| e.to_string())?;
            notify(json!({ "state": "waiting" }));
            listener.set_nonblocking(true).map_err(|e| e.to_string())?;
            let deadline = Instant::now() + Duration::from_secs(300);
            let token = loop {
                if Instant::now() > deadline {
                    return Err("Timed out waiting for approval on last.fm".into());
                }
                let Ok((mut stream, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(200));
                    continue;
                };
                let _ = stream.set_nonblocking(false);
                let mut line = String::new();
                let _ = BufReader::new(&stream).read_line(&mut line);
                // "GET /lastfm?token=XYZ HTTP/1.1"
                let token = line.split_whitespace().nth(1).and_then(|p| p.split("token=").nth(1)).map(|t| t.split('&').next().unwrap_or("").to_string());
                let body = if token.is_some() { "Connected to Last.fm. You can close this tab." } else { "Not found" };
                let _ = write!(stream, "HTTP/1.1 {}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", if token.is_some() { "200 OK" } else { "404 Not Found" }, body.len());
                if let Some(t) = token.filter(|t| !t.is_empty()) {
                    break t;
                }
            };
            let params = BTreeMap::from([("api_key".to_string(), api_key.clone()), ("token".to_string(), token)]);
            let session = call("auth.getSession", params, &secret)?;
            let key = session["session"]["key"].as_str().ok_or("No session key from Last.fm")?;
            let name = session["session"]["name"].as_str().unwrap_or("").to_string();
            keychain_set("api_key", &api_key)?;
            keychain_set("secret", &secret)?;
            keychain_set("session", key)?;
            let _ = std::fs::create_dir_all(crate::data_dir());
            std::fs::write(user_path(), json!({ "name": name }).to_string()).map_err(|e| e.to_string())?;
            Ok(name)
        })();
        notify(match result {
            Ok(name) => json!({ "state": "connected", "connected": true, "name": name }),
            Err(message) => json!({ "state": "error", "message": message }),
        });
    });
}

pub fn disconnect() {
    for k in ["api_key", "secret", "session"] {
        keychain_del(k);
    }
    let _ = std::fs::remove_file(user_path());
}

struct Creds {
    api_key: String,
    secret: String,
    session: String,
}
fn creds() -> Option<Creds> {
    if !status()["connected"].as_bool().unwrap_or(false) {
        return None; // don't touch the Keychain until connected
    }
    Some(Creds { api_key: keychain("api_key")?, secret: keychain("secret")?, session: keychain("session")? })
}

fn send(c: &Creds, method: &str, artist: &str, track: &str, extra: &[(&str, String)]) {
    let mut p = BTreeMap::from([
        ("api_key".to_string(), c.api_key.clone()),
        ("sk".to_string(), c.session.clone()),
        ("artist".to_string(), artist.to_string()),
        ("track".to_string(), track.to_string()),
    ]);
    for (k, v) in extra {
        p.insert(k.to_string(), v.clone());
    }
    match call(method, p, &c.secret) {
        Ok(_) => eprintln!("lastfm: {method} {artist} - {track}"),
        Err(e) => eprintln!("lastfm: {method} failed: {e}"),
    }
}

/// The track being listened to, with time actually spent playing.
struct Listen {
    url: String,
    artist: String,
    track: String,
    duration: f64,
    played: f64,
    playing_since: Option<Instant>,
    started_unix: u64,
    scrobbled: bool,
    last_elapsed: f64,
}

/// Fed the same now-playing JSON as Discord. Scrobbles once a track over 30 s
/// has played for half its length or 4 minutes, whichever is first.
pub fn run(rx: Receiver<String>, enabled: Arc<AtomicBool>) {
    let mut creds_cache: Option<Option<Creds>> = None;
    let mut cur: Option<Listen> = None;
    loop {
        let msg = match rx.recv_timeout(Duration::from_secs(1)) {
            Ok(m) => Some(m),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => return,
        };
        let on = enabled.load(Ordering::Relaxed);
        if msg.as_deref() == Some(RELOAD) {
            creds_cache = None;
            continue;
        }
        let creds = creds_cache.get_or_insert_with(|| if on { creds() } else { None });
        if let Some(np) = msg.and_then(|m| serde_json::from_str::<Value>(&m).ok()) {
            let s = |k: &str| np[k].as_str().unwrap_or("").to_string();
            let playing = np["playing"].as_bool().unwrap_or(false);
            let elapsed = np["elapsed"].as_f64().unwrap_or(0.0) / 1000.0;
            let duration = np["duration"].as_f64().unwrap_or(0.0) / 1000.0;
            // a new track, or the same one started over (repeat)
            let restarted = cur.as_ref().is_some_and(|c| c.url == s("url") && c.scrobbled && elapsed < 3.0 && c.last_elapsed > 10.0);
            if cur.as_ref().is_none_or(|c| c.url != s("url")) || restarted {
                let (artist, track) = crate::presence::parse_title(&s("title"), &s("author"));
                let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
                cur = Some(Listen {
                    url: s("url"),
                    artist,
                    track,
                    duration,
                    played: 0.0,
                    playing_since: playing.then(Instant::now),
                    started_unix: now.saturating_sub(elapsed as u64),
                    scrobbled: false,
                    last_elapsed: elapsed,
                });
                if let (true, true, Some(c), Some(l)) = (on, playing, creds.as_ref(), cur.as_ref()) {
                    send(c, "track.updateNowPlaying", &l.artist, &l.track, &[("duration", (l.duration as u64).to_string())]);
                }
            } else if let Some(l) = cur.as_mut() {
                if duration > 0.0 {
                    l.duration = duration;
                }
                match (playing, l.playing_since) {
                    (true, None) => {
                        l.playing_since = Some(Instant::now());
                        if let (true, Some(c)) = (on, creds.as_ref()) {
                            send(c, "track.updateNowPlaying", &l.artist, &l.track, &[]);
                        }
                    }
                    (false, Some(t)) => {
                        l.played += t.elapsed().as_secs_f64();
                        l.playing_since = None;
                    }
                    _ => {}
                }
                l.last_elapsed = elapsed;
            }
        }
        // once a second, and after every message: scrobble when due
        if let (true, Some(c), Some(l)) = (on, creds.as_ref(), cur.as_mut()) {
            let played = l.played + l.playing_since.map_or(0.0, |t| t.elapsed().as_secs_f64());
            if !l.scrobbled && l.duration > 30.0 && played >= (l.duration / 2.0).min(240.0) {
                l.scrobbled = true;
                send(c, "track.scrobble", &l.artist, &l.track, &[("timestamp", l.started_unix.to_string()), ("duration", (l.duration as u64).to_string())]);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn signs_like_the_electron_app() {
        // md5("api_keyKmethodauth.getSessiontokenT" + "S"), as lastFmService.ts builds it
        let p = std::collections::BTreeMap::from([
            ("method".to_string(), "auth.getSession".to_string()),
            ("api_key".to_string(), "K".to_string()),
            ("token".to_string(), "T".to_string()),
            ("format".to_string(), "json".to_string()),
        ]);
        assert_eq!(super::sign(&p, "S"), format!("{:x}", md5::compute("api_keyKmethodauth.getSessiontokenTS")));
    }
}
