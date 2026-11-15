# Core

The companion core: transport to the addon, game-state cache, the MCP servers `wow` and `memory`, the built-in agent and the ACP client. It is written in TypeScript and compiled with Bun into a single binary that the desktop app starts. See [ADR 0001](../docs/adr/0001-architecture-addon-companion-and-brains.md) and [ADR 0002](../docs/adr/0002-desktop-app-tauri-shell-with-typescript-core.md).

So far it holds the transport ([ADR 0005](../docs/adr/0005-transport-addons-txt-lane-and-font-bank.md)), the ACP client for agents such as Hermes, and `familiar`, a command-line app for development builds until the desktop app exists (FAM-6).

| Path                         | Job                                                                       |
| ---------------------------- | ------------------------------------------------------------------------- |
| `src/transport/codec.ts`     | wire formats, shared with the addon                                       |
| `src/transport/lane.ts`      | up: reads the helpers' rows from every `AddOns.txt`                       |
| `src/transport/font.ts`      | down: fonts whose glyph widths carry a packet                             |
| `src/transport/bank.ts`      | down: the font bank and the doorbells                                     |
| `src/transport/transport.ts` | the app's end: confirms, welcomes and sends                               |
| `src/brain/chat.ts`          | the question from the addon, the prompt for the brain, the answer's limit |
| `src/brain/acp.ts`           | asks an agent through ACP: one session per character, nothing allowed     |
| `src/settings.ts`            | the settings file                                                         |
| `src/wow/client.ts`          | finds the client on Windows and under Wine or Proton, and its process     |
| `src/wow/install.ts`         | installs the addon, its helpers, fonts and doorbells                      |
| `src/main.ts`                | the `familiar` command                                                    |

## Run

```sh
bun install
cd core
bun run start             # install or update the addon, then answer questions until Ctrl+C
bun run start check       # show which client it found, without changing anything
bun run start uninstall   # remove the addon and its helpers; close WoW first
bun run build             # single executables for Windows and Linux in core/dist/
```

`--wow <folder>` names the `_forever_` client folder if `familiar` does not find it. The game sees new files only after a full restart, not after `/reload`, so restart WoW after the first install. `--echo` answers with an echo instead of the brain, to test the transport.

## Brain

`familiar` gives each question to the brain in its settings file and sends the answer back to the game. On the first start it writes the file with the defaults: `%APPDATA%\Familiar\settings.json` on Windows, `~/.config/familiar/settings.json` on Linux. `--settings <file>` uses another one.

```json
{
	"brain": {
		"name": "Hermes",
		"command": ["hermes", "--profile", "familiar", "acp"],
		"timeout": 120
	}
}
```

`command` starts an agent that speaks ACP on stdin and stdout. `familiar` starts it at the first question and keeps it running. Each character gets its own session, so a conversation goes on where it stopped. Each question carries the character's name, realm, level, race, class, faction, zone and game language (ADR 0001). A question that starts with `/` goes to the agent as typed, for the commands it offers. Answers longer than four fonts of the bank (1968 bytes) are cut.

### Hermes

Game text is data, never an instruction, so Familiar's sessions get no shell or file tools wherever the agent allows it ([ADR 0001](../docs/adr/0001-architecture-addon-companion-and-brains.md)). Familiar offers the agent no file or terminal access and declines every permission request, but Hermes brings its own tools: without a setting, an ACP session gets the editor tools, including the terminal, files, the browser and every MCP server of the profile. Hermes sets the tools per profile, so Familiar runs in a profile of its own that only searches the web:

```sh
hermes profile create familiar --no-alias   # no wrapper script: it would be called familiar too
hermes --profile familiar model             # choose the model and sign in
hermes --profile familiar config set platform_toolsets.acp '[web, no_mcp]'
```

In the game, `/familiar say /tools` shows what the session has: only `web_search` and `web_extract`.

For Hermes on another machine, start it through SSH: `"command": ["ssh", "<host>", "hermes", "--profile", "familiar", "acp"]`. Then set `"cwd"` to a folder that exists on that machine, such as your home folder there. By default the session works in the settings folder, and Hermes refuses a session in a folder it does not have.

## How the transport works

Up, the addon sends a message as frames of 32 bytes: it switches 256 helper addons on and off and saves the addon list, and the app reads the bits from `AddOns.txt`. The app polls these files instead of waiting for change events, which not every system delivers: the logged-in character's file every 2 ms, the others every 50 ms. So the first frame of each message stays 0.1 s, and that of a hello 0.4 s, because a hello may go into a file the client creates with it. The app confirms each message by raising an ack doorbell, a `.wav` file that the addon plays. Without that confirmation the addon sends the message again.

Down, the app writes a message into the glyph widths of the next fonts in the bank, 492 bytes per font, and raises the next message doorbell. The addon hears it and measures the fonts.

The client loads each file once per game start. Per game start the transport therefore has 600 messages up, 600 messages down and 256 fonts. The app resets them when the game starts. Every `/reload` costs one font, for the welcome. A larger bank is FAM-25.

When the addon starts, it says hello, and the app answers with a welcome in the font bank. Only that welcome counts as a connection: it carries the session key, which is random per game start. Doorbells, in contrast, can still be raised from an earlier game if the app was not running when that game ended. If the app starts while the game is running, it adopts the addon's position from the hello and silences the doorbells after it.

## Limits

- One game client at a time. Clients started from the same installation share the bank and the doorbells.
- For now, the fonts and doorbells live in the main addon's folder, where the spike measured them. ADR 0005 wants them outside of it, so that an update of the main addon does not reset them. At every hello the addon checks whether the client reads files from the folder of an addon that never loads, and the app logs the answer (`files of an addon that never loads: font yes, sound yes`). Once that is confirmed, the desktop app moves them (FAM-6).
