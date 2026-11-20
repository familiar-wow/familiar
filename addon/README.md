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
| `Familiar/Links.lua`     | links from the player to the brain and from the brain back to the game  |
| `Familiar/Style.lua`     | the window's look, the player's settings for it and the settings panel  |
| `Familiar/Collect.lua`   | on-demand game-state collectors (equipment, bags, quests, talents)      |
| `Familiar/Chat.lua`      | the window: history, input line, status, Allow and Deny                 |
| `Familiar/Familiar.lua`  | saved state, events, the frame loop and `/familiar`                     |

The app installs the addon together with the helpers, fonts and doorbell files; see [core](../core/README.md).

`/familiar` opens and closes the window; it can be moved by its title bar and resized, and keeps its place and the last 200 lines of each character, who also has a session of their own with the agent. Enter sends what is typed in its input line, and `/familiar say <question>` asks from the game's chat line. While the brain works, the status line counts the seconds and names the tool the agent calls. It stops waiting once the app's patience is over, which the welcome names, and says that the question is lost. When the agent asks for permission, the window opens and shows _Allow once_ and _Deny_; `/familiar allow` and `/familiar deny` answer too. If the agent offers no way to allow a request once, the app denies it and the window says why. Familiar's own messages go to the window, and to the chat frame while the window is closed. `/familiar status` shows the state of the transport.

**Look.** _Settings_ in the title bar, or `/familiar config`, opens a panel next to the window: font, size, outline, how opaque the background is, scale and accent color. The settings apply at once and hold for all characters; _Reset_ brings the defaults back. With _Select text to copy_ on, dragging over the history selects text, and releasing the mouse button copies it to the clipboard.

Each question starts with a header about the character (`Chat.lua`, `header`), including map, coordinates, money and revision numbers for the collectors. The window reads nothing from the game's chat.

**Collectors.** `Collect.lua` bumps an integer revision counter per slice when WoW events fire (equipment, bags/money, quests, talents), sending nothing until the agent asks. When the app requests a slice (`fetch`), the addon reads the client APIs, caps the reply at 8 KB of compact TSV, and sends it up (`state`).

**Links.** With the focus in the input line, a shift-click on an item, spell, quest or profession inserts its link, as into the chat. The brain gets each link as `[item:19019 Thunderfury]` with the text of its tooltip, and for an item also the items the character wears in its slots; that adds up to 1.8 KB per question, about two seconds on the lane. The brain links with `[item:ID]`, `[spell:ID]` or `[quest:ID]`. The addon asks the client for each ID and shows its link, with a tooltip on hover; an ID the client does not know within two seconds stays text. Any other `|` in an answer shows as text, so an answer cannot create a link of its own (AGENTS.md, rule 3).

## Test

`core/test/addon.test.ts` runs this addon in [`test/client.lua`](test/client.lua), a small stand-in for the game client, against the app's real transport. It needs Lua 5.1 with the bit library, as in the game:

```sh
sudo apt install lua5.1 lua-bitop   # Debian and Ubuntu; set LUA and LUAC for other binary names
bun test
```

The stand-in shows that both sides follow the same protocol. It does not show how the game behaves; only a test in the game does.
