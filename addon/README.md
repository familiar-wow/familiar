# Addon

The part of Familiar that runs inside World of Warcraft: the chat window, game-state collectors, link hooks and rendering of validated links. It is written in Lua 5.1 for the game's sandbox and contains nothing specific to a model or agent. See [ADR 0001](../docs/adr/0001-architecture-addon-companion-and-brains.md).

So far it holds the chat window and the transport to the app ([ADR 0005](../docs/adr/0005-transport-addons-txt-lane-and-font-bank.md)):

| File                     | Job                                                                     |
| ------------------------ | ----------------------------------------------------------------------- |
| `Familiar/Codec.lua`     | checksums and numbers, as in `core/src/transport/codec.ts`              |
| `Familiar/Tasks.lua`     | coroutines that the frame loop resumes, so waiting never blocks a frame |
| `Familiar/Lane.lua`      | up: switches the 256 helper addons and saves `AddOns.txt`               |
| `Familiar/Bells.lua`     | doorbells: plays a `.wav` file and asks whether it still plays          |
| `Familiar/Bank.lua`      | down: reads a packet from the glyph widths of a font                    |
| `Familiar/Transport.lua` | hello and welcome, messages up with confirmation, messages down         |
| `Familiar/Chat.lua`      | the window: history, input line, status, Allow and Deny                 |
| `Familiar/Familiar.lua`  | saved state, events, the frame loop and `/familiar`                     |

The app installs the addon together with the helpers, fonts and doorbell files; see [core](../core/README.md).

`/familiar` opens and closes the window; it can be moved and resized, and keeps its place and its last 200 lines. Enter sends what is typed in its input line, and `/familiar say <question>` asks from the game's chat line. While the brain works, the status line counts the seconds and names the tool the agent calls. When the agent asks for permission, the window opens and shows _Allow once_ and _Deny_; `/familiar allow` and `/familiar deny` answer too. Familiar's own messages go to the window, and to the chat frame while the window is closed. `/familiar status` shows the state of the transport.

Each question starts with a header about the character (`Chat.lua`, `header`). A `|` in an answer shows as text, so an answer cannot create a link. The window reads nothing from the game's chat.

## Test

`core/test/addon.test.ts` runs this addon in [`test/client.lua`](test/client.lua), a small stand-in for the game client, against the app's real transport. It needs Lua 5.1 with the bit library, as in the game:

```sh
sudo apt install lua5.1 lua-bitop   # Debian and Ubuntu; set LUA and LUAC for other binary names
bun test
```

The stand-in shows that both sides follow the same protocol. It does not show how the game behaves; only a test in the game does.
