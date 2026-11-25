// Automatic updates, as the Electron app's electron-updater does them: look
// for a newer release at launch and every 6 hours, download it in the
// background, and swap it in when the app quits. Releases of this client are
// the GitHub releases tagged `rust-v<version>` (pre-releases, so the Electron
// app's updater never sees them), with a zip per platform made by release.sh
// (and an AppImage, which updates from that instead).
// macOS installs a download only if it carries the running app's own code
// signature. Only a packaged app updates (SoundCloud.app on macOS, the exe
// on Windows); a dev binary in target/ never does.
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const FEED: &str = "https://api.github.com/repos/elricfd/sc-desktop/releases?per_page=30";
const TAG: &str = "rust-v";

/// The downloaded update waiting for the app to quit.
pub type Ready = Arc<Mutex<Option<PathBuf>>>;

fn asset_name() -> String {
    let os = if cfg!(target_os = "macos") { "macos" } else if cfg!(target_os = "linux") { "linux" } else { "windows" };
    // an AppImage updates from the release's AppImage, everything else from the zip
    let ext = if appimage().is_some() { "AppImage" } else { "zip" };
    format!("{os}-{}.{ext}", std::env::consts::ARCH)
}

/// The AppImage file we were started from (Linux).
fn appimage() -> Option<PathBuf> {
    if cfg!(target_os = "linux") { std::env::var_os("APPIMAGE").map(PathBuf::from) } else { None }
}

/// What gets replaced: the .app bundle on macOS, the exe on Windows, the
/// AppImage or the binary on Linux. None for a dev build (no bundle around it,
/// or still under target/).
fn installed() -> Option<PathBuf> {
    if let Some(file) = appimage() {
        return Some(file);
    }
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    if exe.components().any(|c| c.as_os_str() == "target") {
        return None;
    }
    if cfg!(target_os = "macos") {
        let app = exe.parent()?.parent()?.parent()?; // X.app/Contents/MacOS/exe
        (app.extension()? == "app").then(|| app.to_path_buf())
    } else {
        Some(exe)
    }
}

fn newer(tag: &str, current: &str) -> bool {
    let parse = |v: &str| v.split(['.', '-']).map(|n| n.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    parse(tag) > parse(current)
}

/// Checks now and every 6 hours, telling the page what happened.
pub fn start(dir: PathBuf, ready: Ready, notify: impl Fn(String) + Send + 'static) {
    let Some(target) = installed() else { return };
    cleanup(&target);
    std::thread::spawn(move || loop {
        if ready.lock().unwrap().is_none() {
            match check(&dir, &target) {
                Ok(Some((version, path))) => {
                    *ready.lock().unwrap() = Some(path);
                    notify(format!("Update {version} downloaded: it installs when you quit"));
                }
                Ok(None) => {}
                Err(e) => eprintln!("updater: {e}"),
            }
        }
        std::thread::sleep(std::time::Duration::from_secs(6 * 3600));
    });
}

fn get(url: &str) -> Result<ureq::Body, String> {
    let res = ureq::get(url).header("User-Agent", "sc-desktop-rust-updater").call().map_err(|e| format!("{url}: {e}"))?;
    Ok(res.into_body())
}

/// The newest release above ours, downloaded and checked: (version, path).
fn check(dir: &Path, target: &Path) -> Result<Option<(String, PathBuf)>, String> {
    let feed = std::env::var("UPDATE_FEED").unwrap_or_else(|_| FEED.into()); // for tests
    let releases: serde_json::Value = serde_json::from_str(&get(&feed)?.read_to_string().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let current = env!("CARGO_PKG_VERSION");
    let best = releases
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| !r["draft"].as_bool().unwrap_or(false))
        .filter_map(|r| Some((r["tag_name"].as_str()?.strip_prefix(TAG)?, r)))
        .filter(|(v, _)| newer(v, current))
        .max_by(|a, b| if newer(a.0, b.0) { std::cmp::Ordering::Greater } else { std::cmp::Ordering::Less });
    let Some((version, release)) = best else { return Ok(None) };
    let want = asset_name();
    let Some(url) = release["assets"].as_array().into_iter().flatten().find(|a| a["name"].as_str().is_some_and(|n| n.ends_with(&want))).and_then(|a| a["browser_download_url"].as_str()) else {
        return Err(format!("release {version} has no {want}"));
    };

    let work = dir.join("update");
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let out = work.join(version);
    if appimage().is_some() {
        // the download is the file to install
        std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
        download(url, &out.join("SoundCloud.AppImage"))?;
    } else {
        let zip = work.join("update.zip");
        download(url, &zip)?;
        unzip(&zip, &out)?;
    }
    // the app in the zip, whatever it's called (the installed copy may have been renamed);
    // the Linux binary has no extension: the zip's one file
    let want = if cfg!(target_os = "macos") { "app" } else { "exe" };
    let new = std::fs::read_dir(&out)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .find(|p| if cfg!(target_os = "linux") { p.is_file() } else { p.extension().is_some_and(|x| x == want) })
        .ok_or_else(|| format!("no .{want} in the update"))?;
    verify(target, &new)?;
    Ok(Some((version.to_string(), new)))
}

fn download(url: &str, to: &Path) -> Result<(), String> {
    let mut file = std::fs::File::create(to).map_err(|e| e.to_string())?;
    std::io::copy(&mut get(url)?.into_reader(), &mut file).map(|_| ()).map_err(|e| e.to_string())
}

fn run(cmd: &mut std::process::Command) -> Result<String, String> {
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(cmd, 0x0800_0000); // CREATE_NO_WINDOW
    let out = cmd.output().map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).into_owned() + &String::from_utf8_lossy(&out.stderr);
    if out.status.success() { Ok(text) } else { Err(text.trim().to_string()) }
}

fn unzip(zip: &Path, out: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    run(std::process::Command::new("ditto").arg("-x").arg("-k").arg(zip).arg(out))?;
    #[cfg(target_os = "windows")]
    {
        std::fs::create_dir_all(out).map_err(|e| e.to_string())?;
        run(std::process::Command::new("tar").arg("-xf").arg(zip).arg("-C").arg(out))?; // bsdtar, in Windows 10+
    }
    #[cfg(target_os = "linux")]
    run(std::process::Command::new("unzip").arg("-oq").arg(zip).arg("-d").arg(out))?;
    Ok(())
}

/// The update must be signed exactly as the running app is (same certificate
/// and identifier), so only our own builds are ever installed.
#[cfg(target_os = "macos")]
fn verify(current: &Path, new: &Path) -> Result<(), String> {
    let info = run(std::process::Command::new("codesign").args(["-d", "-r-"]).arg(current))?;
    let requirement = info.lines().find_map(|l| l.strip_prefix("designated => ")).ok_or("the running app isn't signed")?;
    run(std::process::Command::new("codesign").args(["--verify", "--deep", "--strict"]).arg(format!("-R={requirement}")).arg(new))
        .map(|_| ())
        .map_err(|e| format!("update rejected, not signed like this app: {e}"))
}

// Note: the Windows and Linux builds aren't signed, so this trusts HTTPS from
// GitHub; check a signature once they have one.
#[cfg(not(target_os = "macos"))]
fn verify(_current: &Path, _new: &Path) -> Result<(), String> {
    Ok(())
}

/// Called as the app quits: swap the downloaded update in.
pub fn install(ready: &Ready) {
    let (Some(new), Some(target)) = (ready.lock().unwrap().take(), installed()) else { return };
    let old = target.with_extension("old");
    let _ = remove(&old);
    // A running exe can be renamed but not overwritten (Windows); a bundle
    // moves in one step. The new one comes from our data folder, which may be
    // on another volume than the app, hence the copy.
    if let Err(e) = std::fs::rename(&target, &old) {
        return eprintln!("updater: could not move the old app aside: {e}");
    }
    if let Err(e) = std::fs::rename(&new, &target).or_else(|_| copy(&new, &target)) {
        eprintln!("updater: could not install: {e}");
        let _ = std::fs::rename(&old, &target);
        return;
    }
    // a zip made off Linux keeps no exec bit
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755));
    }
    let _ = remove(&old); // on Windows the old exe is still running: cleanup() gets it next time
    if let Some(work) = new.parent().and_then(Path::parent) {
        let _ = std::fs::remove_dir_all(work); // the zip and what's left of it
    }
    eprintln!("updater: installed {}", target.display());
}

fn copy(from: &Path, to: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return run(std::process::Command::new("ditto").arg(from).arg(to)).map(|_| ());
    #[cfg(not(target_os = "macos"))]
    return std::fs::copy(from, to).map(|_| ()).map_err(|e| e.to_string());
}

fn remove(p: &Path) -> std::io::Result<()> {
    if p.is_dir() { std::fs::remove_dir_all(p) } else { std::fs::remove_file(p) }
}

fn cleanup(target: &Path) {
    let _ = remove(&target.with_extension("old"));
}

#[cfg(test)]
mod tests {
    #[test]
    fn versions() {
        assert!(super::newer("0.1.1", "0.1.0"));
        assert!(super::newer("0.10.0", "0.9.9"));
        assert!(super::newer("1.0.0", "0.99.0"));
        assert!(!super::newer("0.1.0", "0.1.0"));
        assert!(!super::newer("0.0.9", "0.1.0"));
    }
}
