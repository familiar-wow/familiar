# App

The desktop app: a window with the overview and a panel above the tray icon, built with Tauri 2 and Svelte 5 ([ADR 0002](../docs/adr/0002-desktop-app-tauri-shell-with-typescript-core.md)). It starts the core as a sidecar (`familiar-core sidecar`) and talks to it over stdin and stdout, so it opens no network port. The protocol is in [docs/sidecar.md](../docs/sidecar.md).

## How it is split

- `src-tauri/`: the Rust shell, kept thin. It owns the core process (start, restart, quit, and a generation number on every event so an old process's exit never marks a new one dead), the tray icon and the close button's behaviour.
- `src/`: the pages. Only the main window talks to the core; the tray panel gets snapshots from it. The logic lives in `src/lib/*.ts` without Tauri, so `bun test` covers it; `src/lib/tauri.ts` is the one file that touches the Tauri API.
- `scripts/sidecar.ts` builds the core for the target and copies it to `src-tauri/binaries/familiar-core-<target>`, which the installer bundles. The name is not `familiar`, because Windows would not tell `familiar.exe` from `Familiar.exe`. `FAMILIAR_SIDECAR=<file>` copies a core built before, as CI does.
- `scripts/licenses.ts` collects the license texts of the bundled fonts into the installer.

## Develop

Rust 1.90 or newer, and on Linux the WebKitGTK packages: on Debian or Ubuntu `libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev build-essential`.

```sh
cd app
bun run tauri dev                        # window with live reload; builds the core first
bun run tauri build --debug --no-bundle  # target/debug/Familiar with the pages built in
bun run tauri build                      # installers: NSIS on Windows, deb and AppImage on Linux
bunx vite                                # the pages alone in a browser, on made-up data (?mock=connected, &lang=de)
```

`FAMILIAR_SETTINGS=<file>` makes the core use another settings file instead of the usual one.

Checks, besides the repository's `bun run check`, `bun run typecheck` and `bun test`:

```sh
cd app/src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
```

CI builds the Windows installer, installs it silently, starts the app against an empty client folder and checks that the addon arrives and that the core goes away with the app. The installer is not signed yet (FAM-18), so Windows SmartScreen warns before it runs.
