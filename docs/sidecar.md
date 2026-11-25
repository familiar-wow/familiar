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

| Method                                                                      | Params                  | Result                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hello`                                                                     |                         | version, platform, settings file                                                                                                                                                                                                                                                                      |
| `status`                                                                    |                         | the status (below), refreshed                                                                                                                                                                                                                                                                         |
| `settings.get`                                                              |                         | `{settings, keys, file}`: the settings without any API key; `keys` says per provider whether a key is set                                                                                                                                                                                             |
| `settings.set`                                                              | `settings`              | the same as `settings.get`. A `brain.model.apiKey` sent here goes into the keychain, never into the file                                                                                                                                                                                              |
| `game.find`                                                                 |                         | the WoW Forever clients found: folder, version, interface, whether the addon is installed                                                                                                                                                                                                             |
| `game.check`                                                                | `path`                  | the same for a folder, its parent or the game's program; an error if it is no client                                                                                                                                                                                                                  |
| `addon.install` / `addon.uninstall`                                         | `client?`               | what changed; uninstalling needs WoW closed                                                                                                                                                                                                                                                           |
| `agents.find`                                                               |                         | agents on this PC: Hermes, Codex, Claude Code, Gemini CLI, OpenClaw, with their ACP command and what is missing                                                                                                                                                                                       |
| `local.find`                                                                |                         | Ollama and LM Studio: running, installed, models and whether each can call tools                                                                                                                                                                                                                      |
| `local.start`                                                               | `kind`                  | starts an installed local server                                                                                                                                                                                                                                                                      |
| `key.set` / `key.delete` / `key.has`                                        | `provider`, `key`       | API keys in the system keychain                                                                                                                                                                                                                                                                       |
| `models.list`                                                               | `provider`, `key?`      | the provider's models, recommended first; with the stored key when `key` is left out                                                                                                                                                                                                                  |
| `chatgpt.account` / `chatgpt.signIn` / `chatgpt.signOut` / `chatgpt.models` | `forget?`               | Sign in with ChatGPT; the sign-in opens the browser and also sends the address as a `chatgpt-url` event                                                                                                                                                                                               |
| `ssh.resolve`                                                               | `host`                  | what applies to a computer after `~/.ssh/config`: address, user, port, key files, ProxyJump, ProxyCommand, HostKeyAlias                                                                                                                                                                               |
| `ssh.hostKey` / `ssh.trust`                                                 | `host`, `fingerprint`   | a computer's key fingerprint; trusting writes that key, and only that one, to the first known hosts file ssh uses for that computer (normally `~/.ssh/known_hosts`)                                                                                                                                   |
| `ssh.setSecret`                                                             | `host`, `kind`, `value` | an SSH password or key passphrase, into the keychain                                                                                                                                                                                                                                                  |
| `ssh.test`                                                                  | `ssh?`                  | signs in and looks for the agent's program there: `{ok, problem?, agentFound?, agentPath?}`                                                                                                                                                                                                           |
| `brain.test`                                                                | `settings?`             | asks the brain one short question without the game: time, answer, tools                                                                                                                                                                                                                               |
| `start` / `stop` / `restart`                                                |                         | runs Familiar with the saved settings; `start` returns the status. They run one after another: a second `start` waits for the first and finds it running, and a `stop` sent during a start stops that run as soon as it is up. After a stop, nothing of that run reaches the game or the app any more |
| `logs.recent` / `logs.folder`                                               | `limit?`                | the last log lines (at most 500), the log folder                                                                                                                                                                                                                                                      |
| `shutdown`                                                                  |                         | stops and exits                                                                                                                                                                                                                                                                                       |

## Events

- `status`: whenever something the overview shows changes.

  ```json
  {"running": true, "client": "C:\\...\\_forever_", "addon": {"installed": true},
   "game": {"running": true, "lastContact": 1795600000000, "hello": "Familiar 0.13.0, ..."},
   "character": {"name": "Moonbreeze", "level": "35"},
   "brain": {"kind": "agent", "command": ["hermes", "acp"]},
   "last": {"at": 1795600000000, "ms": 3800, "tools": ["quests", "flightpaths"]},
   "problems": ["Port 27495 is in use, ..."], "restartNeeded": false}
  ```

  `restartNeeded` is true when the settings were saved while Familiar ran; `brain` keeps showing the brain that answers until `restart`.

- `log`: each line of the log as it is written, the same JSON as in the log file. A `question` line carries the question's text and the character, the `answered` line after it how long the answer took and which tools it used. Answers are not in it.
- `status` forgets the addon's hello and the last contact when a WoW process goes away, so it only shows a game as connected while the addon that said hello still runs.
- `chatgpt-url`: the sign-in address, in case the browser did not open.
- `invalid`: a line that was no request.

## Secrets

API keys, SSH passwords and key passphrases live in the system keychain under the service `Familiar` (Windows Credential Manager, macOS Keychain, Secret Service on Linux): `api-key/<provider>`, `ssh-password/<host>`, `ssh-passphrase/<host>`.

Familiar looks for an API key in one order everywhere, whether it starts, tests the brain or lists models: the keychain first, then `brain.model.apiKey` in the settings, then the provider's environment variable. A key found in the settings file moves into the keychain the next time the app saves the settings; without a keychain it stays in the file, which is then readable by its owner only. The ChatGPT sign-in stays in its own owner-only file, because Windows limits a keychain entry to about 2.5 KB.

For an agent on another computer that signs in with a password or a key passphrase, `ssh` asks Familiar itself: Familiar starts `ssh` with `SSH_ASKPASS` set to its own program and `SSH_ASKPASS_REQUIRE=force` (Windows 11 ignores `SSH_ASKPASS` without it). Before that it asks `ssh -G` where this very command would connect and passes the answer on in the environment: `FAMILIAR_ASKPASS` names the keychain entry, `FAMILIAR_ASKPASS_HOST` the `user@host` a password is for, `FAMILIAR_ASKPASS_KEY` the key file(s) a passphrase is for. Started that way, Familiar answers exactly one question: OpenSSH's password prompt for that user and host, or OpenSSH's passphrase prompt for one of those key files. A computer in between, another user or host, a host-key question, a verification code or a request for an API key gets no answer.

A computer that your SSH config reaches through another one (ProxyJump or ProxyCommand) is refused when a saved password or passphrase is involved, because the computer in between would ask through the same helper; use a key without a passphrase or an SSH agent there.

This guard keeps a saved secret from going to the wrong computer or to the wrong question. It is not a wall against other programs on your computer: anything that runs as you can read the same keychain entries, or start Familiar with the same environment and prompt and read the answer. The secret is never on a command line, in a file or in a log.
