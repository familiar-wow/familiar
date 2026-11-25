# The sidecar protocol

The desktop app (FAM-6, [ADR 0002](adr/0002-desktop-app-tauri-shell-with-typescript-core.md)) starts the core as `familiar sidecar` and talks to it over stdin and stdout. No network port is opened for this. The command line app keeps working as before; both start Familiar the same way (`core/src/familiar.ts`).

Each line is one JSON object.

```text
app  → core   {"id": 1, "method": "game.find", "params": {}}
core → app    {"id": 1, "result": [...]}                 or  {"id": 1, "error": {"message": "..."}}
core → app    {"event": "status", "data": {...}}          at any time, without an id
```

Requests may overlap: a ChatGPT sign-in that waits for the browser does not hold up anything else. Error messages are fixed words meant for the player. They never contain an API key, a password or a token; an unexpected error only says `Something went wrong (<kind>).`

`--settings <file>` and `--logs <folder>` work as on the command line. The logs default to `logs` next to the settings file.

## Methods

| Method                                                                      | Params                  | Result                                                                                                          |
| --------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `hello`                                                                     |                         | version, platform, settings file                                                                                |
| `status`                                                                    |                         | the status (below), refreshed                                                                                   |
| `settings.get`                                                              |                         | `{settings, keys, file}`: the settings without any API key; `keys` says per provider whether a key is set       |
| `settings.set`                                                              | `settings`              | the same as `settings.get`. A `brain.model.apiKey` sent here goes into the keychain, never into the file        |
| `game.find`                                                                 |                         | the WoW Forever clients found: folder, version, interface, whether the addon is installed                       |
| `game.check`                                                                | `path`                  | the same for a folder, its parent or the game's program; an error if it is no client                            |
| `addon.install` / `addon.uninstall`                                         | `client?`               | what changed; uninstalling needs WoW closed                                                                     |
| `agents.find`                                                               |                         | agents on this PC: Hermes, Codex, Claude Code, Gemini CLI, OpenClaw, with their ACP command and what is missing |
| `local.find`                                                                |                         | Ollama and LM Studio: running, installed, models and whether each can call tools                                |
| `local.start`                                                               | `kind`                  | starts an installed local server                                                                                |
| `key.set` / `key.delete` / `key.has`                                        | `provider`, `key`       | API keys in the system keychain                                                                                 |
| `models.list`                                                               | `provider`, `key?`      | the provider's models, recommended first; with the stored key when `key` is left out                            |
| `chatgpt.account` / `chatgpt.signIn` / `chatgpt.signOut` / `chatgpt.models` | `forget?`               | Sign in with ChatGPT; the sign-in opens the browser and also sends the address as a `chatgpt-url` event         |
| `ssh.resolve`                                                               | `host`                  | what applies to a computer after `~/.ssh/config`: address, user, port, key files, ProxyJump                     |
| `ssh.hostKey` / `ssh.trust`                                                 | `host`, `fingerprint`   | a computer's key fingerprint; trusting writes that key, and only that one, to `known_hosts`                     |
| `ssh.setSecret`                                                             | `host`, `kind`, `value` | an SSH password or key passphrase, into the keychain                                                            |
| `ssh.test`                                                                  | `ssh?`                  | signs in and looks for the agent's program there: `{ok, problem?, agentFound?, agentPath?}`                     |
| `brain.test`                                                                | `settings?`             | asks the brain one short question without the game: time, answer, tools                                         |
| `start` / `stop` / `restart`                                                |                         | runs Familiar with the saved settings; `start` returns the status                                               |
| `logs.recent` / `logs.folder`                                               | `limit?`                | the last log lines (at most 500), the log folder                                                                |
| `shutdown`                                                                  |                         | stops and exits                                                                                                 |

## Events

- `status`: whenever something the overview shows changes.

  ```json
  {"running": true, "client": "C:\\...\\_forever_", "addon": {"installed": true},
   "game": {"running": true, "lastContact": 1795600000000, "hello": "Familiar 0.13.0, ..."},
   "character": {"name": "Moonbreeze", "level": "35"},
   "brain": {"kind": "agent", "command": ["hermes", "acp"]},
   "last": {"at": 1795600000000, "ms": 3800, "tools": ["quests", "flightpaths"]},
   "problems": ["Port 27495 is in use, ..."]}
  ```

- `log`: each line of the log as it is written, the same JSON as in the log file. Answers are not in it.
- `chatgpt-url`: the sign-in address, in case the browser did not open.
- `invalid`: a line that was no request.

## Secrets

API keys, SSH passwords and key passphrases live in the system keychain under the service `Familiar` (Windows Credential Manager, macOS Keychain, Secret Service on Linux): `api-key/<provider>`, `ssh-password/<host>`, `ssh-passphrase/<host>`. The ChatGPT sign-in stays in its own owner-only file, because Windows limits a keychain entry to about 2.5 KB.

For an agent on another computer with a password or passphrase, `ssh` asks Familiar itself: Familiar starts `ssh` with `SSH_ASKPASS` set to its own program and `SSH_ASKPASS_REQUIRE=force` (Windows 11 ignores `SSH_ASKPASS` without it). Started that way, Familiar prints only the one SSH secret that `FAMILIAR_ASKPASS` names, and only to ssh's own password or passphrase prompt; it never serves an API key. The secret is never on a command line, in a file or in a log.
