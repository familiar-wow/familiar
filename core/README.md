# Core

The companion core: transport to the addon, game-state cache, the MCP servers `wow` and `memory`, the built-in agent and the ACP client. It is written in TypeScript and compiled with Bun into a single binary that the desktop app starts. See [ADR 0001](../docs/adr/0001-architecture-addon-companion-and-brains.md) and [ADR 0002](../docs/adr/0002-desktop-app-tauri-shell-with-typescript-core.md).

So far it holds the transport ([ADR 0005](../docs/adr/0005-transport-addons-txt-lane-and-font-bank.md)), the bridge to agents that speak ACP, and `familiar`, a command-line app for development builds until the desktop app exists (FAM-6).

| Path                         | Job                                                                       |
| ---------------------------- | ------------------------------------------------------------------------- |
| `src/transport/codec.ts`     | wire formats, shared with the addon                                       |
| `src/transport/lane.ts`      | up: reads the helpers' rows from every `AddOns.txt`                       |
| `src/transport/font.ts`      | down: fonts whose glyph widths carry a packet                             |
| `src/transport/bank.ts`      | down: the font bank and the doorbells                                     |
| `src/transport/transport.ts` | the app's end: confirms, welcomes and sends                               |
| `src/brain/chat.ts`          | the question from the addon, the prompt for the brain, the answer's limit |
| `src/brain/acp.ts`           | the bridge to an ACP agent: one session per character                     |
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

`familiar` is a bridge: it hands each question to an agent that speaks ACP and sends the answer back to the game ([ADR 0006](../docs/adr/0006-brains-a-bridge-to-the-players-agent.md)). Set the agent up in the agent itself, as you use it anyway: model, tools, skills, MCP servers and what it may do without asking. Familiar changes none of that.

On the first start, `familiar` writes its settings with the defaults: `%APPDATA%\Familiar\settings.json` on Windows, `~/.config/familiar/settings.json` on Linux. `--settings <file>` uses another file.

```json
{
	"brain": {
		"command": ["hermes", "acp"],
		"permissions": "deny",
		"timeout": 120
	}
}
```

| Setting       | Meaning                                                          |
| ------------- | ---------------------------------------------------------------- |
| `command`     | starts the agent, which must speak ACP on stdin and stdout       |
| `permissions` | the answer when the agent asks for permission: `deny` or `allow` |
| `timeout`     | seconds until Familiar cancels a question                        |
| `cwd`         | the agent's working folder, by default the settings folder       |

`allow` allows the one request the agent asks about. Familiar never answers "always", so the agent's own settings stay as they are. Until the chat window can ask the player (FAM-23), the default is `deny`.

| Agent                    | `command`                                                |
| ------------------------ | -------------------------------------------------------- |
| Hermes                   | `["hermes", "acp"]`                                      |
| Codex                    | `["npx", "-y", "@agentclientprotocol/codex-acp"]`        |
| Claude Code              | `["npx", "-y", "@agentclientprotocol/claude-agent-acp"]` |
| an agent on another host | `["ssh", "<host>", "~/.local/bin/hermes", "acp"]`        |

Hermes takes `--profile <name>` before `acp` for another profile. Codex and Claude Code speak ACP through adapters from the ACP project, which `npx` starts until Familiar ships them itself. Claude Code works only with an Anthropic API key in `ANTHROPIC_API_KEY`, not with a Claude subscription (ADR 0001).

For an agent on another host, set `cwd` to a folder on that host; Familiar itself starts `ssh` in its settings folder. SSH runs the command without your login profile, so give the agent's full path. Sign in with a key: Familiar cannot answer a password prompt, and `-o BatchMode=yes` after `ssh` turns a missing key into an error message instead of a wait.

`familiar` starts the agent at the first question and keeps it running. While the agent works, the console shows each tool it calls, such as `> web_search: …`, and each one that fails. Each character gets its own session, so a conversation goes on where it stopped. Each question carries the character's name, realm, level, race, class, faction, zone and game language. A question that starts with `/` goes to the agent as typed, for the commands it offers, such as `/tools` in Hermes. Answers longer than four fonts of the bank (1968 bytes) are cut.

## How the transport works

Up, the addon sends a message as frames of 32 bytes: it switches 256 helper addons on and off and saves the addon list, and the app reads the bits from `AddOns.txt`. The app polls these files instead of waiting for change events, which not every system delivers: the logged-in character's file every 2 ms, the others every 50 ms. So the first frame of each message stays 0.1 s, and that of a hello 0.4 s, because a hello may go into a file the client creates with it. The app confirms each message by raising an ack doorbell, a `.wav` file that the addon plays. Without that confirmation the addon sends the message again.

Down, the app writes a message into the glyph widths of the next fonts in the bank, 492 bytes per font, and raises the next message doorbell. The addon hears it and measures the fonts.

The client loads each file once per game start, and it sees only the files that existed when it started. Per game start the transport therefore has 4096 messages up, 4096 messages down and 8192 fonts, about 4 MB. The app resets them when the game starts. Every `/reload` costs one font, for the welcome. An empty font takes 25 KB, so the unused names of the bank are hard links to nine empty fonts in `bank/base` (Windows allows 1023 names per file), and the bank takes less than 1 MB on disk. Where the file system has no hard links, such as exFAT, the app copies them, about 200 MB.

When the addon starts, it says hello, and the app answers with a welcome in the font bank. Only that welcome counts as a connection: it carries the session key, which is random per game start. Doorbells, in contrast, can still be raised from an earlier game if the app was not running when that game ended. If the app starts while the game is running, it adopts the addon's position from the hello and silences the doorbells after it.

## Limits

- One game client at a time. Clients started from the same installation share the bank and the doorbells.
- For now, the fonts and doorbells live in the main addon's folder, where the spike measured them. ADR 0005 wants them outside of it, so that an update of the main addon does not reset them. At every hello the addon checks whether the client reads files from the folder of an addon that never loads, and the app logs the answer (`files of an addon that never loads: font yes, sound yes`). Once that is confirmed, the desktop app moves them (FAM-6).
