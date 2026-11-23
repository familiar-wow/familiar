# Core

The companion core: transport to the addon, game-state cache, the MCP servers `wow` and `memory`, the built-in agent and the ACP client. It is written in TypeScript and compiled with Bun into a single binary that the desktop app starts. See [ADR 0001](../docs/adr/0001-architecture-addon-companion-and-brains.md) and [ADR 0002](../docs/adr/0002-desktop-app-tauri-shell-with-typescript-core.md).

So far it holds the transport ([ADR 0005](../docs/adr/0005-transport-addons-txt-lane-and-font-bank.md)), the bridge to agents that speak ACP, the `wow` server with its read-only tools ([ADR 0007](../docs/adr/0007-mcp-server-wow-over-http.md)), and `familiar`, a command-line app for development builds until the desktop app exists (FAM-6).

| Path                         | Job                                                                       |
| ---------------------------- | ------------------------------------------------------------------------- |
| `src/transport/codec.ts`     | wire formats, shared with the addon                                       |
| `src/transport/lane.ts`      | up: reads the helpers' rows from every `AddOns.txt`                       |
| `src/transport/font.ts`      | down: fonts whose glyph widths carry a packet                             |
| `src/transport/bank.ts`      | down: the font bank and the doorbells                                     |
| `src/transport/transport.ts` | the app's end: confirms, welcomes and sends                               |
| `src/brain/chat.ts`          | the question from the addon, the prompt for the brain, the answer's limit |
| `src/brain/acp.ts`           | the bridge to an ACP agent: one session per character                     |
| `src/game.ts`                | what the app knows about the game, for the tools                          |
| `src/mcp/server.ts`          | the MCP server `wow`: HTTP on `127.0.0.1`, guarded by a token             |
| `src/mcp/tools.ts`           | the tools the `wow` server offers                                         |
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

`--wow <folder>` names the `_forever_` client folder if `familiar` does not find it. The game sees new files only after a full restart, not after `/reload`, so restart WoW after the first install. `--echo` answers with an echo instead of the brain, to test the transport. Asked `tools`, the echo reports two tools first; asked `permission`, it asks the player.

## Brain

Two kinds of brain can answer, and `brain.use` picks one:

- `"agent"` (the default): an agent you already use, such as Hermes, Codex or Claude Code, through ACP. Familiar is only the bridge to it.
- `"model"`: Familiar's built-in agent with a model from a provider, by API key or on your own PC. See [The built-in agent](#the-built-in-agent).

On the first start, `familiar` writes its settings with the defaults: `%APPDATA%\Familiar\settings.json` on Windows, `~/.config/familiar/settings.json` on Linux. `--settings <file>` uses another file.

### Your own agent

`familiar` hands each question to an agent that speaks ACP and sends the answer back to the game ([ADR 0006](../docs/adr/0006-brains-a-bridge-to-the-players-agent.md)). Set the agent up in the agent itself, as you use it anyway: model, tools, skills, MCP servers and what it may do without asking. Familiar changes none of that.

```json
{
	"brain": {
		"use": "agent",
		"command": ["hermes", "acp"],
		"permissions": "ask",
		"timeout": 120
	},
	"mcp": {
		"port": 27495
	}
}
```

| Setting       | Meaning                                                                         |
| ------------- | ------------------------------------------------------------------------------- |
| `use`         | `agent` for your own agent, `model` for the built-in agent                      |
| `command`     | starts the agent, which must speak ACP on stdin and stdout                      |
| `permissions` | the answer when the agent asks for permission: `ask` (default), `deny`, `allow` |
| `timeout`     | seconds until Familiar cancels a question                                       |
| `cwd`         | the agent's working folder, by default the settings folder                      |

`ask` shows the request in the game window with _Allow once_ and _Deny_; `/familiar allow` and `/familiar deny` answer it too. A request still open when the question times out counts as cancelled. `allow` allows each request without asking. Every answer covers the one request: Familiar never answers "always", so the agent's own settings stay as they are. If an agent offers no way to allow a request once, Familiar denies it without asking and says so in the game window.

| Agent                    | `command`                                                |
| ------------------------ | -------------------------------------------------------- |
| Hermes                   | `["hermes", "acp"]`                                      |
| Codex                    | `["npx", "-y", "@agentclientprotocol/codex-acp"]`        |
| Claude Code              | `["npx", "-y", "@agentclientprotocol/claude-agent-acp"]` |
| an agent on another host | `["ssh", "<host>", "~/.local/bin/hermes", "acp"]`        |

Hermes takes `--profile <name>` before `acp` for another profile. Codex and Claude Code speak ACP through adapters from the ACP project, which `npx` starts until Familiar ships them itself. Claude Code works only with an Anthropic API key in `ANTHROPIC_API_KEY`, not with a Claude subscription (ADR 0001).

For an agent on another host, set `cwd` to a folder on that host; Familiar itself starts `ssh` in its settings folder. SSH runs the command without your login profile, so give the agent's full path. Sign in with a key: Familiar cannot answer a password prompt, and `-o BatchMode=yes` after `ssh` turns a missing key into an error message instead of a wait. Such an agent needs two more options to reach the game tools, see below.

`familiar` starts the agent at the first question and keeps it running. While the agent works, the console shows each tool it calls, such as `> web_search: …`, and each one that fails. The game window shows the tool too, at most one every four seconds, because each line costs a font of the bank. Each question carries the character's name, realm, level, race, class, faction, zone and game language. A question that starts with `/` goes to the agent as typed, for the commands it offers, such as `/tools` in Hermes. Familiar removes the Markdown marks models write anyway, such as `**bold**`, because the window shows plain text. Answers longer than four fonts of the bank (1968 bytes) are cut. If no answer reaches the game within the timeout and 30 seconds more, as when `familiar` was started again meanwhile, the window says that the question is lost and stops waiting.

Each character gets its own session in the agent, and it lasts as long as `familiar` runs: after `/reload` or a restart of WoW, the conversation goes on where it stopped. Another character starts its own session, and switching back continues the first one. Starting `familiar` again starts a new session, and so does the agent's next start after it quit or ignored a timeout. The agent keeps its sessions as it keeps any other, so Hermes, for example, lists them with the sessions from its other clients. The game window keeps the last 200 lines of each character, like its session, even after a new start, so it may then show lines the agent no longer knows.

### The built-in agent

For players without an agent of their own ([ADR 0008](../docs/adr/0008-built-in-agent.md)). Familiar asks the model itself and lets it call the [game tools](#game-tools) in the app: up to 8 rounds of tool calls per question, then the answer. It has no web, file or shell tools, so for facts beyond your character it answers from what the model knows and says when that may differ in Forever.

```json
{
	"brain": {
		"use": "model",
		"model": { "provider": "openrouter", "name": "openai/gpt-6-luna" },
		"timeout": 120
	}
}
```

| `provider`          | Key from the environment variable | Notes                                         |
| ------------------- | --------------------------------- | --------------------------------------------- |
| `openai`            | `OPENAI_API_KEY`                  |                                               |
| `anthropic`         | `ANTHROPIC_API_KEY`               | Claude only with an API key (ADR 0001)        |
| `google`            | `GOOGLE_GENERATIVE_AI_API_KEY`    | Google AI Studio                              |
| `openrouter`        | `OPENROUTER_API_KEY`              | many providers' models with one key           |
| `deepseek`          | `DEEPSEEK_API_KEY`                |                                               |
| `ollama`            | none                              | a local model, `http://127.0.0.1:11434/v1`    |
| `lmstudio`          | none                              | a local model, `http://127.0.0.1:1234/v1`     |
| `openai-compatible` | none, or `apiKey`                 | any OpenAI-compatible server; needs `baseUrl` |

`name` is the model's name at the provider. `baseUrl` overrides the provider's address, for example for Ollama on another PC. `apiKey` in the settings works too, but the environment variable keeps the key out of the file; the desktop app will keep it in the system keychain. Familiar sends the key only to the provider and never logs it. Without a key, the game window says which variable to set.

Pick a fast model that can call tools. A small model answers questions about your character in a few seconds; a large model with long reasoning takes much longer and costs more. What you pay is between you and the provider.

The built-in agent keeps the last 12 questions and answers of each character while `familiar` runs, so a follow-up question works; tool results are not kept, and the model fetches the game state again. Starting `familiar` again starts a fresh conversation. The log records the provider, model, duration, tool names and token counts of each answer, not its text. The `wow` server below does not start for the built-in agent: it calls the tools in the app itself.

## Game tools

`familiar` serves what it knows about the game to the agent as tools, through an MCP server named `wow` ([ADR 0007](../docs/adr/0007-mcp-server-wow-over-http.md)). It hands the server's address and a token to the agent with each new session, so there is nothing to install or set up in the agent. An agent that refuses a session with the server gets one without it, and the game window says so.

| Tool                            | Returns                                                                                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `character`                     | name, realm, level, race, class, faction, zone, subzone, map ID, coordinates, money and language, as of the last question                                                                                                             |
| `equipment`                     | equipped slots with item ID, name, item level, quality, enchant ID, gems and durability (optional `slot` filter)                                                                                                                      |
| `bags`                          | bag items grouped by item ID with count and quality, free/total bag slots and money (optional `search` filter)                                                                                                                        |
| `quests`                        | active quest log with ID, title, level, category, completion, watched flag and objectives (optional `questId` filter)                                                                                                                 |
| `talents`                       | points spent per tree, unspent points and allocated talents with rank, max rank and spell ID                                                                                                                                          |
| `stats`                         | character-sheet attributes, armor, resource, crit and avoidance                                                                                                                                                                       |
| `professions` / `reputation`    | visible skill and faction rows; filter by name or category with `search`                                                                                                                                                              |
| `spells`                        | learned spellbook entries; filter by `search` or set `includePassive: false`                                                                                                                                                          |
| `bank` / `merchant` / `trainer` | the most recent visit in this UI session, not live access to closed windows; `available: false` before a visit. Merchant `price` is the money part only, other costs are in `extendedCost`; a pet trainer's costs are training points |

The tools only read: none of them acts in the game or on your computer. Collector results are pulled from the addon on demand and cached per character by revision: if nothing changed since the last question, the app answers from its cache without touching the transport (ADR 0001). The revisions restart whenever the game loads its interface, so the app drops its cache when the addon says hello after a `/reload` or login. Opening a bank, merchant or trainer window captures a local snapshot; it is only sent on request. Results can be marked `truncated` when the 8 KB lane limit is reached. Collapsed skill or faction groups may not appear; Familiar does not expand them.

The server listens on `127.0.0.1` only, on port 27495; `mcp.port` in the settings changes it. The token is new at every start. The server refuses requests without the token, requests from a browser and requests under another host name. If the port is in use, `familiar` says so and runs on without the tools.

An agent on another host reaches the server only if that port on its host leads back to yours. Add two options to the `ssh` command:

```json
"command": ["ssh", "-o", "ExitOnForwardFailure=yes", "-R", "127.0.0.1:27495:127.0.0.1:27495", "<host>", "~/.local/bin/hermes", "acp"]
```

`-R` forwards port 27495 on the agent's host to `familiar`. `ExitOnForwardFailure=yes` makes `ssh` stop if that port is taken there; without it the agent would start anyway and send the token to whatever listens on the port. Every user on the agent's host can connect to the forwarded port, and the token keeps them out. Without `-R` the agent answers from the question alone, and after the first answer of a session the console says that the agent has not connected to the game tools.

The log has an event for each client that connects (`mcp-client`), each tool call (`mcp-call`) and the first refused request of each kind (`mcp-refused`).

Hermes and Codex took the server and called `character` on Linux on the same machine as `familiar`, and Hermes called it from Windows through `ssh -R` in the game. The second set of collectors has been exercised with the Lua stub client, not yet inside WoW Forever.

## How the transport works

Up, the addon sends a message as frames of 32 bytes: it switches 256 helper addons on and off and saves the addon list, and the app reads the bits from `AddOns.txt`. The app polls these files instead of waiting for change events, which not every system delivers: the logged-in character's file every 2 ms, the others every 50 ms. So the first frame of each message stays 0.1 s, and that of a hello 0.4 s, because a hello may go into a file the client creates with it. The app confirms each message by raising an ack doorbell, a `.wav` file that the addon plays. Without that confirmation the addon sends the message again, up to three times. Before each repeat it switches all helpers off, in case something else, such as an addon that manages addon sets, switched one on. If no confirmation comes at all, the addon checks the game sound, because without it no doorbell rings: it then says that the sound is off instead of blaming the app, and connects again once the sound is back.

Down, the app writes a message into the glyph widths of the next fonts in the bank, 492 bytes per font, and raises the next message doorbell. The addon hears it and measures the fonts.

The client loads each file once per game start, and it sees only the files that existed when it started. Per game start the transport therefore has 4096 messages up, 4096 messages down and 8192 fonts, about 4 MB. The app resets them when the game starts. Every `/reload` costs one font, for the welcome. An empty font takes 25 KB, so the unused names of the bank are hard links to nine empty fonts in `bank/base` (Windows allows 1023 names per file), and the bank takes less than 1 MB on disk. Where the file system has no hard links, such as exFAT, the app copies them, about 200 MB.

When the addon starts, it says hello, and the app answers with a welcome in the font bank. The welcome names the app and how long the window should wait for an answer. Only that welcome counts as a connection: it carries the session key, which is random per game start. Doorbells, in contrast, can still be raised from an earlier game if the app was not running when that game ended. If the app starts while the game is running, it adopts the addon's position from the hello and silences the doorbells after it.

## Limits

- One game client at a time. Clients started from the same installation share the bank and the doorbells.
- For now, the fonts and doorbells live in the main addon's folder, where the spike measured them. ADR 0005 wants them outside of it, so that an update of the main addon does not reset them. At every hello the addon checks whether the client reads files from the folder of an addon that never loads, and the app logs the answer (`files of an addon that never loads: font yes, sound yes`). Once that is confirmed, the desktop app moves them (FAM-6).
