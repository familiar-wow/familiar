// No console window next to the app in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod process;
mod sidecar;
mod tray;

use std::sync::Mutex;

use serde::Deserialize;
use tauri::{AppHandle, Manager, RunEvent, State, Window, WindowEvent};

use sidecar::{Sidecar, SidecarState, lock};
use tray::TrayState;

const MAIN: &str = "main";

/// What the main window's X does.
#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
enum CloseMode {
    #[default]
    Tray,
    Quit,
}

struct Close(Mutex<CloseMode>);

#[tauri::command]
fn sidecar_state(sidecar: State<'_, Sidecar>) -> SidecarState {
    sidecar.state()
}

// Sync on purpose: sync commands run on the main thread in arrival order, so lines reach the
// core in the order the page sent them. It only queues; the write happens on another thread.
#[tauri::command]
fn sidecar_send(window: Window, sidecar: State<'_, Sidecar>, line: String) -> Result<(), String> {
    // Only the main window owns the connection, so request ids never collide.
    if window.label() != MAIN {
        return Err("Only the main window talks to the core.".into());
    }
    sidecar.send(&line)
}

#[tauri::command]
async fn sidecar_restart(window: Window, app: AppHandle) -> Result<(), String> {
    if window.label() != MAIN {
        return Err("Only the main window restarts the core.".into());
    }
    sidecar::restart(app).await
}

#[tauri::command]
fn tray_update(app: AppHandle, state: TrayState, tooltip: String, open: String, quit: String) {
    tray::update(&app, state, &tooltip, &open, &quit);
}

#[tauri::command]
fn set_close_mode(close: State<'_, Close>, mode: CloseMode) {
    *lock(&close.0) = mode;
}

#[tauri::command]
fn show_main(app: AppHandle) {
    open_main(&app);
}

#[tauri::command]
async fn quit(app: AppHandle) {
    sidecar::quit(app);
    // The app exits; the page's promise is left pending on purpose.
    std::future::pending::<()>().await;
}

/// Shows, unminimizes and focuses the main window, and hides the tray panel.
pub fn open_main(app: &AppHandle) {
    tray::hide_panel(app);
    let Some(main) = app.get_webview_window(MAIN) else {
        eprintln!("familiar: no main window");
        return;
    };
    let result = main
        .show()
        .and_then(|_| main.unminimize())
        .and_then(|_| main.set_focus());
    if let Err(e) = result {
        eprintln!("familiar: cannot show the main window: {e}");
    }
}

fn on_window_event(window: &Window, event: &WindowEvent) {
    let app = window.app_handle();
    match (window.label(), event) {
        (MAIN, WindowEvent::CloseRequested { api, .. }) => {
            api.prevent_close();
            let mode = *lock(&app.state::<Close>().0);
            match mode {
                CloseMode::Tray => {
                    if let Err(e) = window.hide() {
                        eprintln!("familiar: cannot hide the main window: {e}");
                    }
                }
                CloseMode::Quit => sidecar::quit(app.clone()),
            }
        }
        // The panel is never destroyed, only hidden, so its page keeps listening.
        (tray::PANEL, WindowEvent::CloseRequested { api, .. }) => {
            api.prevent_close();
            tray::hide_panel(app);
        }
        (tray::PANEL, WindowEvent::Focused(false)) => tray::on_panel_blur(app),
        _ => {}
    }
}

fn main() {
    let app = tauri::Builder::default()
        // First, so a second start hands over to this one before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            open_main(app)
        }))
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .manage(Sidecar::new())
        .manage(Close(Mutex::new(CloseMode::default())))
        .invoke_handler(tauri::generate_handler![
            sidecar_state,
            sidecar_send,
            sidecar_restart,
            tray_update,
            set_close_mode,
            show_main,
            quit,
        ])
        .on_window_event(on_window_event)
        .setup(|app| {
            // Without a tray (no AppIndicator on Linux) the window still works.
            if let Err(e) = tray::create(app.handle()) {
                eprintln!("familiar: no tray icon: {e}");
            }
            sidecar::start(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!());
    let app = match app {
        Ok(app) => app,
        Err(e) => {
            eprintln!("familiar: cannot start the app: {e}");
            std::process::exit(1);
        }
    };
    app.run(|app, event| {
        if let RunEvent::Exit = event {
            sidecar::kill_on_exit(app);
        }
    });
}
