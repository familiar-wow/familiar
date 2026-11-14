# Addon

The part of Familiar that runs inside World of Warcraft: the chat window, game-state collectors, link hooks and rendering of validated links. It is written in Lua 5.1 for the game's sandbox and contains nothing specific to a model or agent. See [ADR 0001](../docs/adr/0001-architecture-addon-companion-and-brains.md).

So far it holds the transport to the app ([ADR 0005](../docs/adr/0005-transport-addons-txt-lane-and-font-bank.md)):

| File                     | Job                                                                     |
| ------------------------ | ----------------------------------------------------------------------- |
| `Familiar/Codec.lua`     | checksums and numbers, as in `core/src/transport/codec.ts`              |
| `Familiar/Tasks.lua`     | coroutines that the frame loop resumes, so waiting never blocks a frame |
| `Familiar/Lane.lua`      | up: switches the 256 helper addons and saves `AddOns.txt`               |
| `Familiar/Bells.lua`     | doorbells: plays a `.wav` file and asks whether it still plays          |
| `Familiar/Bank.lua`      | down: reads a packet from the glyph widths of a font                    |
| `Familiar/Transport.lua` | hello and welcome, messages up with confirmation, messages down         |
| `Familiar/Familiar.lua`  | saved state, events, the frame loop and `/familiar`                     |

The app installs the addon together with the helpers, fonts and doorbell files; see [core](../core/README.md). Until the chat window exists (FAM-23), `/familiar say <text>` sends a test message and the app answers with an echo. `/familiar status` shows the state of the transport.

## Test

`core/test/addon.test.ts` runs this addon in [`test/client.lua`](test/client.lua), a small stand-in for the game client, against the app's real transport. It needs Lua 5.1 with the bit library, as in the game:

```sh
sudo apt install lua5.1 lua-bitop   # Debian and Ubuntu; set LUA and LUAC for other binary names
bun test
```

The stand-in shows that both sides follow the same protocol. It does not show how the game behaves; only a test in the game does.
