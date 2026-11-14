# Core

The companion core: transport to the addon, game-state cache, the MCP servers `wow` and `memory`, the built-in agent and the ACP client. It is written in TypeScript and compiled with Bun into a single binary that the desktop app starts. See [ADR 0001](../docs/adr/0001-architecture-addon-companion-and-brains.md) and [ADR 0002](../docs/adr/0002-desktop-app-tauri-shell-with-typescript-core.md).

So far it holds the transport ([ADR 0005](../docs/adr/0005-transport-addons-txt-lane-and-font-bank.md)) and `familiar`, a command-line app for development builds until the desktop app exists (FAM-6).

| Path                         | Job                                                                   |
| ---------------------------- | --------------------------------------------------------------------- |
| `src/transport/codec.ts`     | wire formats, shared with the addon                                   |
| `src/transport/lane.ts`      | up: reads the helpers' rows from every `AddOns.txt`                   |
| `src/transport/font.ts`      | down: fonts whose glyph widths carry a packet                         |
| `src/transport/bank.ts`      | down: the font bank and the doorbells                                 |
| `src/transport/transport.ts` | the app's end: confirms, welcomes and sends                           |
| `src/wow/client.ts`          | finds the client on Windows and under Wine or Proton, and its process |
| `src/wow/install.ts`         | installs the addon, its helpers, fonts and doorbells                  |
| `src/main.ts`                | the `familiar` command                                                |

## Run

```sh
bun install
cd core
bun run start             # install or update the addon, then answer with an echo until Ctrl+C
bun run start check       # show which client it found, without changing anything
bun run start uninstall   # remove the addon and its helpers; close WoW first
bun run build             # single executables for Windows and Linux in core/dist/
```

`--wow <folder>` names the `_forever_` client folder if `familiar` does not find it. The game sees new files only after a full restart, not after `/reload`, so restart WoW after the first install.

## How the transport works

Up, the addon sends a message as frames of 32 bytes: it switches 256 helper addons on and off and saves the addon list, and the app reads the bits from `AddOns.txt`. The app confirms each message by raising an ack doorbell, a `.wav` file that the addon plays. Without that confirmation the addon sends the message again.

Down, the app writes a message into the glyph widths of the next fonts in the bank, 492 bytes per font, and raises the next message doorbell. The addon hears it and measures the fonts.

The client loads each file once per game start. Per game start the transport therefore has 600 messages up, 600 messages down and 256 fonts. The app resets them when the game starts. Every `/reload` costs one font, for the welcome. A larger bank is FAM-25.

When the addon starts, it says hello, and the app answers with a welcome in the font bank. Only that welcome counts as a connection: it carries the session key, which is random per game start. Doorbells, in contrast, can still be raised from an earlier game if the app was not running when that game ended. If the app starts while the game is running, it adopts the addon's position from the hello and silences the doorbells after it.

## Limits

- One game client at a time. Clients started from the same installation share the bank and the doorbells.
- For now, the fonts and doorbells live in the main addon's folder, where the spike measured them. ADR 0005 wants them outside of it, so that an update of the main addon does not reset them. At every hello the addon checks whether the client reads files from the folder of an addon that never loads, and the app logs the answer (`files of an addon that never loads: font yes, sound yes`). Once that is confirmed, the desktop app moves them (FAM-6).
