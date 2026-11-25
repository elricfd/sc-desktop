// Windows: the exe's icon, and "SoundCloud" for Task Manager, the volume mixer and media controls.
fn main() {
    #[cfg(windows)]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("../../assets/icons/soundcloud-win.ico")
            .set("FileDescription", "SoundCloud")
            .set("ProductName", "SoundCloud")
            .set("OriginalFilename", "SoundCloud.exe");
        res.compile().expect("Windows resources");
    }
}
