"""Reads Familiar's autostart entries the way a GNOME session does (GLib's GDesktopAppInfo) and
checks that each Exec gives back exactly the program path it was written for.

    FAMILIAR_DESKTOP_DIR=<dir> cargo test autostart   # in app/src-tauri, writes the entries
    python3 app/scripts/desktop-entry-check.py <dir>  # needs PyGObject (python3-gi)
"""

import sys

import gi

gi.require_version("Gio", "2.0")
gi.require_version("GLib", "2.0")
from gi.repository import Gio, GLib  # noqa: E402

folder = sys.argv[1]
bad = 0
for row in open(f"{folder}/list.tsv", encoding="utf-8"):
    file, want = row.rstrip("\n").split("\t")
    key = GLib.KeyFile()
    key.load_from_file(file, GLib.KeyFileFlags.NONE)
    exec_line = key.get_string("Desktop Entry", "Exec")
    ok, argv = GLib.shell_parse_argv(exec_line)
    info = Gio.DesktopAppInfo.new_from_filename(file)
    good = ok and argv == [want] and info is not None
    bad += not good
    print("ok  " if good else "BAD ", repr(want), "->", argv, "| app info:", info is not None)
sys.exit(1 if bad else 0)
