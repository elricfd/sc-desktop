// Discord Rich Presence over Discord's local IPC socket (frames of
// little-endian op + length + JSON). Same client ID and activity shape as the
// Electron app's presenceService.
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::mpsc::Receiver;
use std::time::{SystemTime, UNIX_EPOCH};

const CLIENT_ID: &str = "1090770350251458592";
/// Sent instead of now-playing JSON to clear the status (Discord switched off).
pub const CLEAR: &str = "__clear";

/// Runs until the sender is dropped. Each message is the page's now-playing JSON.
pub fn run(rx: Receiver<String>) {
    let mut conn: Option<UnixStream> = None;
    while let Ok(mut msg) = rx.recv() {
        // Discord allows 5 updates per 20 s: let a burst of skips settle and
        // send only the latest state.
        std::thread::sleep(std::time::Duration::from_secs(1));
        while let Ok(newer) = rx.try_recv() {
            msg = newer;
        }
        let activity = if msg == CLEAR {
            Value::Null
        } else {
            let Ok(np) = serde_json::from_str::<Value>(&msg) else { continue };
            activity(&np)
        };
        // Discord may have been closed or started since: reconnect on demand.
        for _ in 0..2 {
            if conn.is_none() {
                conn = connect();
            }
            let Some(c) = conn.as_mut() else { break };
            let cmd = json!({
                "cmd": "SET_ACTIVITY",
                "args": { "pid": std::process::id(), "activity": activity },
                "nonce": now_ms().to_string(),
            });
            if let Ok(reply) = send(c, 1, &cmd).and_then(|_| recv(c)) {
                eprintln!("discord: {} {}", reply["data"]["details"], reply["data"]["state"]);
                break;
            }
            conn = None;
        }
    }
}

fn activity(np: &Value) -> Value {
    let s = |k: &str| np[k].as_str().unwrap_or("").to_string();
    if !np["playing"].as_bool().unwrap_or(false) {
        return Value::Null; // clears the status, like the Electron default
    }
    let (artist, track) = parse_title(&s("title"), &s("author"));
    let start = now_ms() - np["elapsed"].as_u64().unwrap_or(0);
    let mut a = json!({
        "type": 2, // Listening
        "status_display_type": 1, // show the artist in the member list
        "name": artist,
        "details": pad(&track),
        "state": pad(&artist),
        "assets": { "large_image": s("artwork") },
        "instance": false,
    });
    if let Some(d) = np["duration"].as_u64().filter(|d| *d > 0) {
        a["timestamps"] = json!({ "start": start, "end": start + d });
    }
    a
}

// Discord rejects fields under 2 characters and over 128.
fn pad(s: &str) -> String {
    let mut s: String = s.chars().take(128).collect();
    while s.chars().count() < 2 {
        s.push('\u{2800}');
    }
    s
}

/// "Artist - Title" uploads (often by labels) name the real artist; else the
/// uploader is the artist. Port of src/utils/trackParser.ts.
pub fn parse_title(title: &str, uploader: &str) -> (String, String) {
    const DASHES: [char; 4] = ['-', '\u{2013}', '\u{2014}', '\u{2015}'];
    let title = title.lines().next().unwrap_or("").trim();
    let fallback = || (if uploader.is_empty() { "Unknown Artist".into() } else { uploader.to_string() }, if title.is_empty() { "Unknown Track".into() } else { title.to_string() });
    let invalid = |t: &str| {
        let c: Vec<char> = t.chars().collect();
        t.trim().is_empty()
            || c.first().is_some_and(|x| DASHES.contains(x))
            || c.last().is_some_and(|x| DASHES.contains(x))
            || c.windows(5).any(|w| w.iter().all(|x| *x == w[0]))
            || c.windows(2).any(|w| DASHES.contains(&w[0]) && DASHES.contains(&w[1]))
    };
    // First separator: whitespace + dashes + whitespace, or 2+ dashes.
    let c: Vec<char> = title.chars().collect();
    for i in 0..c.len() {
        let (start, end) = if c[i].is_whitespace() {
            let mut j = i + 1;
            while j < c.len() && DASHES.contains(&c[j]) { j += 1; }
            if j == i + 1 || j >= c.len() || !c[j].is_whitespace() { continue; }
            let mut k = j;
            while k < c.len() && c[k].is_whitespace() { k += 1; }
            (i, k)
        } else if DASHES.contains(&c[i]) && c.get(i + 1).is_some_and(|x| DASHES.contains(x)) {
            let mut j = i;
            while j < c.len() && DASHES.contains(&c[j]) { j += 1; }
            (i, j)
        } else {
            continue;
        };
        if start == 0 { break; }
        let artist: String = c[..start].iter().collect::<String>().trim().to_string();
        let track: String = c[end..].iter().collect::<String>().trim().to_string();
        if !artist.is_empty() && !track.is_empty() && !invalid(&artist) && !invalid(&track) {
            return (artist, track);
        }
        break;
    }
    fallback()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn connect() -> Option<UnixStream> {
    let dir = std::env::var("XDG_RUNTIME_DIR").or_else(|_| std::env::var("TMPDIR")).unwrap_or_else(|_| "/tmp".into());
    (0..10).find_map(|i| {
        let mut c = UnixStream::connect(format!("{}/discord-ipc-{i}", dir.trim_end_matches('/'))).ok()?;
        c.set_read_timeout(Some(std::time::Duration::from_secs(5))).ok()?;
        send(&mut c, 0, &json!({ "v": 1, "client_id": CLIENT_ID })).ok()?;
        recv(&mut c).ok()?; // READY
        Some(c)
    })
}

fn send(c: &mut UnixStream, op: u32, payload: &Value) -> std::io::Result<()> {
    let body = payload.to_string();
    let mut frame = Vec::with_capacity(8 + body.len());
    frame.extend_from_slice(&op.to_le_bytes());
    frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
    frame.extend_from_slice(body.as_bytes());
    c.write_all(&frame)
}

fn recv(c: &mut UnixStream) -> std::io::Result<Value> {
    let mut head = [0u8; 8];
    c.read_exact(&mut head)?;
    let op = u32::from_le_bytes(head[..4].try_into().unwrap());
    let len = u32::from_le_bytes(head[4..].try_into().unwrap()) as usize;
    let mut body = vec![0u8; len];
    c.read_exact(&mut body)?;
    let v: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    if op == 2 || v["evt"] == "ERROR" {
        eprintln!("discord: {v}");
        return Err(std::io::Error::other("discord error"));
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::parse_title;
    fn p(t: &str) -> (String, String) { parse_title(t, "Uploader") }
    #[test]
    fn parses_like_the_electron_track_parser() {
        let pair = |a: &str, b: &str| (a.to_string(), b.to_string());
        assert_eq!(p("Artist Name - Song Title"), pair("Artist Name", "Song Title"));
        assert_eq!(p("Artist Name -- Song Title"), pair("Artist Name", "Song Title"));
        assert_eq!(p("Artist Name — Song Title"), pair("Artist Name", "Song Title"));
        assert_eq!(p("Just a Song Title"), pair("Uploader", "Just a Song Title"));
        assert_eq!(p("- No Artist"), pair("Uploader", "- No Artist"));
        assert_eq!(p("No Song -"), pair("Uploader", "No Song -"));
        assert_eq!(p("Her head is so0o0o0o0 rolling (POST-MORTEM MIX)"), pair("Uploader", "Her head is so0o0o0o0 rolling (POST-MORTEM MIX)"));
        // the Electron source comments call this one invalid, but its regex parses it
        assert_eq!(p("FRONT DOOR ENTRY ONLY ---- until I cant feel a thing"), pair("FRONT DOOR ENTRY ONLY", "until I cant feel a thing"));
        assert_eq!(p("a - b"), pair("a", "b"));
        assert_eq!(p(""), pair("Uploader", "Unknown Track"));
        assert_eq!(parse_title("Boys Don't Cry (86 Mix)", ""), pair("Unknown Artist", "Boys Don't Cry (86 Mix)"));
    }
}
