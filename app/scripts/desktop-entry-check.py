"""Reads Familiar's autostart entries the way a GNOME session does (GLib's GDesktopAppInfo),
checks that each Exec gives back exactly the program path it was written for, then launches each
one and waits for the program's mark: parsing alone misses what a launch expands.

    FAMILIAR_DESKTOP_DIR=<dir> cargo test autostart   # in app/src-tauri, writes the entries
    python3 app/scripts/desktop-entry-check.py <dir>  # needs PyGObject (python3-gi)
"""

import os
import sys
import time

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
    ok, argv = GLib.shell_parse_argv(key.get_string("Desktop Entry", "Exec"))
    try:
        info = Gio.DesktopAppInfo.new_from_filename(file)
    except TypeError:
        info = None
    ran = False
    if info is not None:
        # A mark from an earlier run would pass a launch that did nothing.
        if os.path.exists(f"{want}.ran"):
            os.remove(f"{want}.ran")
        info.launch([], None)
        for _ in range(50):
            if os.path.exists(f"{want}.ran"):
                ran = True
                break
            time.sleep(0.1)
    good = ok and argv == [want] and ran
    bad += not good
    print("ok  " if good else "BAD ", repr(want), "->", argv, "| launched:", ran)
sys.exit(1 if bad else 0)
