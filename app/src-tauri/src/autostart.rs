// Starting with the system. Windows (and macOS) through tauri-plugin-autostart: a value under the
// user's Run key, which also honours "Startup apps" in Windows' settings. Linux through our own
// XDG autostart file: the plugin writes the program's path unquoted, which breaks an AppImage in a
// folder with a space in its name.
//
// Only the main window may change it, and only when the player asks: Familiar never turns it back
// on by itself, so a player who switched it off in the system keeps it off.

use tauri::{AppHandle, Runtime, Window};

/// The argument the system's entry passes: start without the window, only the tray icon.
pub const HIDDEN: &str = "--hidden";

#[tauri::command]
pub fn autostart_enabled<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    imp::enabled(&app)
}

#[tauri::command]
pub fn set_autostart<R: Runtime>(
    window: Window<R>,
    app: AppHandle<R>,
    on: bool,
) -> Result<(), String> {
    if window.label() != crate::MAIN {
        return Err("Only the main window changes this.".into());
    }
    imp::set(&app, on)
}

#[cfg(not(target_os = "linux"))]
mod imp {
    use tauri::{AppHandle, Runtime};
    use tauri_plugin_autostart::ManagerExt;

    pub fn enabled<R: Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
        app.autolaunch()
            .is_enabled()
            .map_err(|e| format!("Could not read the autostart entry: {e}"))
    }

    pub fn set<R: Runtime>(app: &AppHandle<R>, on: bool) -> Result<(), String> {
        let manager = app.autolaunch();
        let done = if on {
            manager.enable()
        } else {
            manager.disable()
        };
        done.map_err(|e| format!("Could not write the autostart entry: {e}"))
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use std::fs;
    use std::path::PathBuf;

    use tauri::{AppHandle, Runtime};

    pub fn enabled<R: Runtime>(_app: &AppHandle<R>) -> Result<bool, String> {
        Ok(entry()?.exists())
    }

    pub fn set<R: Runtime>(_app: &AppHandle<R>, on: bool) -> Result<(), String> {
        let file = entry()?;
        if !on {
            return match fs::remove_file(&file) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(format!("Could not remove {}: {e}", file.display())),
            };
        }
        // An AppImage runs from a mount that changes each start: its own path is in $APPIMAGE.
        let program = match std::env::var_os("APPIMAGE") {
            Some(path) => PathBuf::from(path),
            None => std::env::current_exe().map_err(|e| format!("Where is Familiar? {e}"))?,
        };
        let program = program
            .to_str()
            .ok_or("Familiar's path is not valid text, so no autostart entry can name it.")?;
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir)
                .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
        }
        fs::write(&file, super::desktop_entry(program))
            .map_err(|e| format!("Could not write {}: {e}", file.display()))
    }

    /// `~/.config/autostart/Familiar.desktop`, or under `$XDG_CONFIG_HOME`.
    fn entry() -> Result<PathBuf, String> {
        let config = match std::env::var_os("XDG_CONFIG_HOME") {
            Some(dir) if !dir.is_empty() => PathBuf::from(dir),
            _ => PathBuf::from(std::env::var_os("HOME").ok_or("No home folder.")?).join(".config"),
        };
        Ok(config.join("autostart").join("Familiar.desktop"))
    }
}

/// The autostart file for `program`. No `--hidden` on Linux: whether a tray host is there to show
/// the icon cannot be told at login, and a hidden window without an icon could not be reached.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn desktop_entry(program: &str) -> String {
    format!(
        "[Desktop Entry]\nType=Application\nName=Familiar\nComment=Familiar, the WoW companion\nExec={}\nStartupNotify=false\nTerminal=false\n",
        exec_quote(program)
    )
}

/// A program path as the Desktop Entry spec wants it in `Exec`: in double quotes, with `"`, `` ` ``,
/// `$` and `\` escaped by a backslash, and `%` doubled since it starts a field code.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn exec_quote(path: &str) -> String {
    let mut out = String::from("\"");
    for ch in path.chars() {
        match ch {
            '"' | '`' | '$' | '\\' => {
                out.push('\\');
                out.push(ch);
            }
            '%' => out.push_str("%%"),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_with_spaces_stays_one_word() {
        assert_eq!(
            exec_quote("/home/me/My Apps/Familiar.AppImage"),
            "\"/home/me/My Apps/Familiar.AppImage\""
        );
    }

    #[test]
    fn special_characters_are_escaped() {
        assert_eq!(
            exec_quote("/a/\"b\"/$c/`d`/e\\f/100%"),
            "\"/a/\\\"b\\\"/\\$c/\\`d\\`/e\\\\f/100%%\""
        );
    }

    #[test]
    fn the_entry_names_the_program_without_hidden() {
        let entry = desktop_entry("/usr/bin/Familiar");
        assert!(entry.contains("\nExec=\"/usr/bin/Familiar\"\n"));
        assert!(!entry.contains(HIDDEN));
    }
}
