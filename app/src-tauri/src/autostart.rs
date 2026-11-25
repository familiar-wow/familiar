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
        super::nameable(program)?;
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir)
                .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
        }
        fs::write(&file, super::desktop_entry(program))
            .map_err(|e| format!("Could not write {}: {e}", file.display()))
    }

    /// `~/.config/autostart/Familiar.desktop`, or under `$XDG_CONFIG_HOME`.
    fn entry() -> Result<PathBuf, String> {
        // Only an absolute XDG_CONFIG_HOME counts, as the XDG spec says.
        let config = match std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from) {
            Some(dir) if dir.is_absolute() => dir,
            _ => PathBuf::from(std::env::var_os("HOME").ok_or("No home folder.")?).join(".config"),
        };
        Ok(config.join("autostart").join("Familiar.desktop"))
    }
}

/// Whether an autostart entry can name `program`. A desktop expands `%` in Exec at launch, and
/// GLib refuses `%%` because it checks that the program exists before it expands it, so a path
/// with a `%` cannot be written either way.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn nameable(program: &str) -> Result<(), String> {
    if program.contains('%') {
        return Err(format!(
            "Familiar is in a folder whose name has a %, which an autostart entry cannot hold: {program}. Move it to a folder without one."
        ));
    }
    Ok(())
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

/// A program path for `Exec`, in the two layers the Desktop Entry spec reads it with.
/// 1. The argument: in double quotes, with `"`, `` ` ``, `$` and `\` behind a backslash.
///    A path with `%` never gets here (`set` refuses it).
/// 2. The value: a key's value is a string first, where `\` is itself an escape, so every
///    backslash from step 1 (and in the path) is doubled once more; control characters, which a
///    value cannot hold, as `\n`, `\t`, `\r`.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn exec_quote(path: &str) -> String {
    let mut arg = String::from("\"");
    for ch in path.chars() {
        match ch {
            '"' | '`' | '$' | '\\' => {
                arg.push('\\');
                arg.push(ch);
            }
            _ => arg.push(ch),
        }
    }
    arg.push('"');
    let mut value = String::with_capacity(arg.len());
    for ch in arg.chars() {
        match ch {
            '\\' => value.push_str("\\\\"),
            '\n' => value.push_str("\\n"),
            '\t' => value.push_str("\\t"),
            '\r' => value.push_str("\\r"),
            _ => value.push(ch),
        }
    }
    value
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
    fn special_characters_are_escaped_in_both_layers() {
        // `$` is `\$` as an argument, and that backslash is doubled in the value.
        assert_eq!(exec_quote("/g/$Games"), r#""/g/\\$Games""#);
        // A backslash: `\\` as an argument, `\\\\` in the value.
        assert_eq!(exec_quote(r"/a\b"), r#""/a\\\\b""#);
        assert_eq!(exec_quote(r#"/q"x"#), r#""/q\\"x""#);
        assert_eq!(exec_quote("/a\nb"), r#""/a\nb""#);
    }

    #[test]
    fn a_path_with_a_percent_sign_is_refused() {
        assert!(nameable("/home/me/100%/Familiar").is_err());
        assert!(nameable("/home/me/My Apps/Familiar").is_ok());
    }

    #[test]
    fn the_entry_names_the_program_without_hidden() {
        let entry = desktop_entry("/usr/bin/Familiar");
        assert!(entry.contains("\nExec=\"/usr/bin/Familiar\"\n"));
        assert!(!entry.contains(HIDDEN));
    }

    /// Writes the entry for odd paths to `FAMILIAR_DESKTOP_DIR` for a desktop parser (GLib) to
    /// read back; see app/README.md. Does nothing without it.
    #[cfg(target_os = "linux")]
    #[test]
    fn entries_for_a_desktop_parser() {
        let Some(dir) = std::env::var_os("FAMILIAR_DESKTOP_DIR") else {
            return;
        };
        // Real programs under `dir`: a desktop only takes an entry whose program exists.
        let names = [
            "My Apps/Familiar.AppImage",
            "$Games/Familiar.AppImage",
            r#"say "hi"/Familiar"#,
            r"back\slash/Familiar",
            "`tick`/Familiar",
        ];
        let mut list = String::new();
        for (i, name) in names.iter().enumerate() {
            let program = std::path::Path::new(&dir).join("p").join(name);
            std::fs::create_dir_all(program.parent().unwrap()).unwrap();
            // Leaves a mark next to itself, so a check can see that it was started.
            std::fs::write(&program, "#!/bin/sh\n: > \"$0.ran\"\n").unwrap();
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
            let path = program.to_str().unwrap();
            let file = std::path::Path::new(&dir).join(format!("e{i}.desktop"));
            std::fs::write(&file, desktop_entry(path)).unwrap();
            list.push_str(&format!("{}\t{path}\n", file.display()));
        }
        std::fs::write(std::path::Path::new(&dir).join("list.tsv"), list).unwrap();
    }
}
