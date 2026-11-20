// Several SoundCloud accounts, as the Electron app has them: each extra one
// signs in inside its own WebKit data store (its own WebView2 folder on
// Windows), and switching relaunches the app on the other one. The first
// account ("default") is the store the app always had, so nobody signs in
// again. Kept in accounts.json: { accounts: [{ id, name, avatar }], current }.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn file(dir: &Path) -> PathBuf {
    dir.join("accounts.json")
}

pub fn load(dir: &Path) -> Value {
    let mut v = std::fs::read_to_string(file(dir)).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(Value::Null);
    if !v["accounts"].is_array() {
        v = json!({ "accounts": [{ "id": "default", "name": "", "avatar": "" }], "current": "default" });
    }
    v
}

fn save(dir: &Path, v: &Value) {
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(file(dir), v.to_string());
}

pub fn current(dir: &Path) -> String {
    load(dir)["current"].as_str().unwrap_or("default").to_string()
}

/// The WebKit data store of an extra account (its id is that store's UUID).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // tests use it everywhere
pub fn store_id(id: &str) -> Option<[u8; 16]> {
    if id == "default" || id.len() != 32 {
        return None;
    }
    let mut out = [0u8; 16];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&id[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// Who is signed in on the current account, as the page saw it.
pub fn set_me(dir: &Path, me: &Value) {
    let mut v = load(dir);
    let cur = v["current"].clone();
    if let Some(a) = v["accounts"].as_array_mut().and_then(|a| a.iter_mut().find(|a| a["id"] == cur)) {
        if a["name"] == me["name"] && a["avatar"] == me["avatar"] {
            return;
        }
        a["name"] = me["name"].clone();
        a["avatar"] = me["avatar"].clone();
    }
    save(dir, &v);
}

pub fn switch(dir: &Path, id: &str) {
    let mut v = load(dir);
    if v["accounts"].as_array().is_some_and(|a| a.iter().any(|a| a["id"] == id)) {
        v["current"] = id.into();
        save(dir, &v);
    }
}

/// A new account, made current; it starts signed out.
pub fn add(dir: &Path) {
    let seed = format!("{:?}{}", std::time::SystemTime::now(), std::process::id());
    let id = format!("{:x}", md5::compute(seed));
    let mut v = load(dir);
    v["accounts"].as_array_mut().unwrap().push(json!({ "id": id, "name": "", "avatar": "" }));
    v["current"] = id.into();
    save(dir, &v);
}

/// Forgets an extra account that isn't in use; returns its store to delete.
pub fn remove(dir: &Path, id: &str) -> Option<String> {
    let mut v = load(dir);
    if id == "default" || v["current"] == id {
        return None;
    }
    v["accounts"].as_array_mut()?.retain(|a| a["id"] != id);
    save(dir, &v);
    Some(id.to_string())
}

/// Drops extra accounts that were added but never signed in (not the one in
/// use); returns their stores to delete. Run at startup, when none is open.
pub fn prune(dir: &Path) -> Vec<String> {
    let mut v = load(dir);
    let cur = v["current"].clone();
    let unused = |a: &Value| a["id"] != "default" && a["id"] != cur && a["name"].as_str().unwrap_or("").is_empty();
    let gone: Vec<String> = v["accounts"].as_array().into_iter().flatten().filter(|a| unused(a)).filter_map(|a| a["id"].as_str().map(String::from)).collect();
    if !gone.is_empty() {
        v["accounts"].as_array_mut().unwrap().retain(|a| !unused(a));
        save(dir, &v);
    }
    gone
}

/// Starts this app again (on whichever account is now current) and lets
/// the caller exit.
pub fn relaunch() {
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::process::Command::new(exe).args(std::env::args().skip(1)).spawn();
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn accounts() {
        let dir = std::env::temp_dir().join(format!("accounts-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(super::current(&dir), "default");
        super::add(&dir);
        let id = super::current(&dir);
        assert!(super::store_id(&id).is_some() && super::store_id("default").is_none());
        assert_eq!(super::remove(&dir, &id), None, "the current account stays");
        super::switch(&dir, "default");
        super::set_me(&dir, &serde_json::json!({ "name": "elric", "avatar": "a.jpg" }));
        assert_eq!(super::load(&dir)["accounts"][0]["name"], "elric");
        assert_eq!(super::remove(&dir, &id), Some(id.clone()));
        assert_eq!(super::load(&dir)["accounts"].as_array().unwrap().len(), 1);
        // added, never signed in, switched away from: gone at the next start
        super::add(&dir);
        let unused = super::current(&dir);
        assert!(super::prune(&dir).is_empty(), "not while it's in use");
        super::switch(&dir, "default");
        assert_eq!(super::prune(&dir), vec![unused]);
        assert_eq!(super::load(&dir)["accounts"].as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
