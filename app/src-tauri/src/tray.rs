//! The tray icon, its menu, and the tray panel (the `tray` window) that a left click toggles.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_positioner::{Position, WindowExt};

use crate::sidecar::{self, lock};

pub const TRAY_ID: &str = "main";
pub const PANEL: &str = "tray";
const OPEN_ID: &str = "open";
const QUIT_ID: &str = "quit";
/// A click on the icon blurs an open panel first; a click this soon after means "close".
const BLUR_CLICK: Duration = Duration::from_millis(300);

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrayState {
    Connected,
    Waiting,
    Error,
}

impl TrayState {
    fn icon(self) -> tauri::Result<Image<'static>> {
        // Embedded, so the icons need no resource files next to the binary.
        Image::from_bytes(match self {
            TrayState::Connected => include_bytes!("../icons/tray-connected.png"),
            TrayState::Waiting => include_bytes!("../icons/tray-waiting.png"),
            TrayState::Error => include_bytes!("../icons/tray-error.png"),
        })
    }
}

/// What the tray code keeps between events.
pub struct Tray {
    open: MenuItem<Wry>,
    quit: MenuItem<Wry>,
    /// When the panel was last hidden because it lost focus.
    blur_hidden: Mutex<Option<Instant>>,
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, OPEN_ID, "Open Familiar", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT_ID, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(TrayState::Waiting.icon()?)
        .tooltip("Familiar")
        .menu(&menu)
        // The left click is ours (the panel); the right click opens the menu.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN_ID => crate::open_main(app),
            QUIT_ID => sidecar::quit(app.clone()),
            _ => {}
        })
        .on_tray_icon_event(on_icon_event)
        .build(app)?;
    app.manage(Tray {
        open,
        quit,
        blur_hidden: Mutex::new(None),
    });
    Ok(())
}

fn on_icon_event(icon: &TrayIcon, event: TrayIconEvent) {
    let app = icon.app_handle();
    // First, so the panel can be placed next to the icon.
    tauri_plugin_positioner::on_tray_event(app, &event);
    if let TrayIconEvent::Click {
        button: MouseButton::Left,
        button_state: MouseButtonState::Up,
        ..
    } = event
    {
        toggle_panel(app);
    }
}

fn toggle_panel(app: &AppHandle) {
    let Some(panel) = app.get_webview_window(PANEL) else {
        eprintln!("familiar: no tray window");
        return;
    };
    if panel.is_visible().unwrap_or(false) {
        // Some systems do not blur the panel on a click on the icon.
        hide_panel(app);
        return;
    }
    let recent = app
        .try_state::<Tray>()
        .is_some_and(|tray| lock(&tray.blur_hidden).is_some_and(|at| at.elapsed() < BLUR_CLICK));
    if recent {
        return;
    }
    // Above the icon and kept on screen; below it only for a taskbar at the top.
    if let Err(e) = panel.move_window_constrained(Position::TrayCenter) {
        eprintln!("familiar: cannot place the tray panel: {e}");
    }
    if let Err(e) = panel.show().and_then(|_| panel.set_focus()) {
        eprintln!("familiar: cannot show the tray panel: {e}");
    }
}

pub fn hide_panel(app: &AppHandle) {
    if let Some(panel) = app.get_webview_window(PANEL)
        && let Err(e) = panel.hide()
    {
        eprintln!("familiar: cannot hide the tray panel: {e}");
    }
}

/// The panel lost focus: hide it and remember when, for the click that may have caused it.
pub fn on_panel_blur(app: &AppHandle) {
    let Some(panel) = app.get_webview_window(PANEL) else {
        return;
    };
    // Hiding can blur it again; only a visible panel counts.
    if !panel.is_visible().unwrap_or(false) {
        return;
    }
    if let Some(tray) = app.try_state::<Tray>() {
        *lock(&tray.blur_hidden) = Some(Instant::now());
    }
    hide_panel(app);
}

pub fn update(app: &AppHandle, state: TrayState, tooltip: &str, open: &str, quit: &str) {
    // Missing when the system has no tray; `create` said so already.
    let Some(tray) = app.try_state::<Tray>() else {
        return;
    };
    if let Err(e) = tray
        .open
        .set_text(open)
        .and_then(|_| tray.quit.set_text(quit))
    {
        eprintln!("familiar: cannot set the tray menu: {e}");
    }
    let Some(icon) = app.tray_by_id(TRAY_ID) else {
        eprintln!("familiar: no tray icon");
        return;
    };
    let result = state
        .icon()
        .and_then(|image| icon.set_icon(Some(image)))
        .and_then(|_| icon.set_tooltip(Some(tooltip)));
    if let Err(e) = result {
        eprintln!("familiar: cannot update the tray icon: {e}");
    }
}
