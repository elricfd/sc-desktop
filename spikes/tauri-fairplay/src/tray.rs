// The tray icon, as the Electron app's setupTray: SoundCloud (show the
// window), Settings, Quit. On macOS a click opens the menu, as menu bar items
// do; on Windows a click shows the window and a right-click opens the menu.
use tray_icon::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};

pub enum Action {
    Show,
    Settings,
    Quit,
}

// Our PNGs are 8-bit RGBA (src/icons, made from assets/icons/soundcloud.png).
pub fn rgba(png: &[u8]) -> (Vec<u8>, u32, u32) {
    let mut reader = png::Decoder::new(std::io::Cursor::new(png)).read_info().expect("icon png");
    let mut buf = vec![0; reader.output_buffer_size().expect("icon size")];
    let info = reader.next_frame(&mut buf).expect("icon png");
    assert_eq!(info.color_type, png::ColorType::Rgba, "icons must be RGBA");
    buf.truncate(info.buffer_size());
    (buf, info.width, info.height)
}

pub fn build(send: impl Fn(Action) + Send + Sync + 'static) -> TrayIcon {
    let show = MenuItem::new("SoundCloud", true, None);
    let settings = MenuItem::new("Settings", true, None);
    let quit = MenuItem::new("Quit", true, None);
    let menu = Menu::new();
    menu.append_items(&[&show, &settings, &PredefinedMenuItem::separator(), &quit]).unwrap();

    let send = std::sync::Arc::new(send);
    let (show_id, settings_id, quit_id) = (show.id().clone(), settings.id().clone(), quit.id().clone());
    let on_menu = send.clone();
    MenuEvent::set_event_handler(Some(move |e: MenuEvent| {
        if e.id == show_id {
            on_menu(Action::Show)
        } else if e.id == settings_id {
            on_menu(Action::Settings)
        } else if e.id == quit_id {
            on_menu(Action::Quit)
        }
    }));
    TrayIconEvent::set_event_handler(Some(move |e: TrayIconEvent| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
            send(Action::Show)
        }
    }));

    // macOS: a template image, drawn black or white to suit the menu bar.
    let icon = |png| {
        let (rgba, w, h) = rgba(png);
        tray_icon::Icon::from_rgba(rgba, w, h).unwrap()
    };
    let builder = TrayIconBuilder::new().with_tooltip("SoundCloud").with_menu(Box::new(menu)).with_menu_on_left_click(cfg!(target_os = "macos"));
    let builder = if cfg!(target_os = "macos") {
        builder.with_icon_templated(icon(include_bytes!("icons/tray-template.png")))
    } else {
        builder.with_icon(icon(include_bytes!("icons/tray-color.png")))
    };
    builder.build().unwrap()
}

// The Dock icon (the binary runs outside an .app bundle, so macOS has none).
#[cfg(target_os = "macos")]
pub fn set_dock_icon() {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;
    let Some(mtm) = MainThreadMarker::new() else { return };
    let data = NSData::with_bytes(include_bytes!("icons/app.png"));
    if let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) {
        unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(Some(&image)) };
    }
}
