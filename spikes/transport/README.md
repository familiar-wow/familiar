# Transport spike (FAM-15)

Throwaway measuring tool. It answers one question for [ADR 0005](../../docs/adr/README.md):
which channels can carry Familiar's traffic between the addon and the companion while you
actually play? The addon sandbox has no sockets and no file access, so every channel is a
side effect the client happens to persist or reload.

| Channel           | Direction         | How it works                                                                                                                                              |
| ----------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AddOns.txt lane U | addon → companion | The addon flips the enable state of 256 empty helper addons and calls `C_AddOns.SaveAddOns()`. The companion reads `AddOns.txt`. 20 bytes per frame.      |
| Doorbell          | companion → addon | Pre-installed empty `.wav` files. The companion writes a valid (silent) sound into one; `PlaySoundFile` starts to succeed. One bit, no payload.           |
| Slot              | companion → addon | Pre-installed load-on-demand addons. The companion rewrites `data.lua`, rings a doorbell, the addon calls `LoadAddOn`. Large payloads, 64 per UI session. |
| AddOns.txt lane D | companion → addon | The companion rewrites a second lane; the addon calls `C_AddOns.ResetAddOns()` and reads it back. Works only if that call re-reads the file.              |

Doorbells and slots are the downlink that [wow-ai](https://github.com/chelinho139/wow-ai) and
[hermes-forever](https://github.com/Adolanium/hermes-forever) already use. The AddOns.txt
lanes would replace their screen-capture uplink: no visible pixels, and it works minimized
and in exclusive fullscreen.

## Run it (Windows)

1. Put `familiar-spike.exe` in an empty folder and double-click it. It finds the
   `_forever_` client, installs the test addon and starts measuring. Windows SmartScreen may
   warn because the file is unsigned: _More info → Run anyway_.
2. If WoW was running, quit it completely and start it again. `/reload` does not pick up new
   addon folders.
3. Log in. Chat shows _Familiar Spike: Companion connected_.
4. Stand somewhere quiet, out of combat, and type `/fspike bench`. It takes about two minutes.
5. Type `/reload` once, so the client saves the results.
6. Play as usual for an evening: questing, dungeons, combat. The addon runs a small round
   every 30 seconds. Every `/reload` or logout adds results.
7. Press Ctrl+C in the window. `familiar-spike-data\report.md` is the result; send the whole
   `familiar-spike-data` folder.

Do not click into the console window while it runs: Windows pauses programs whose console
is in selection mode. If the title starts with _Select_, press Esc.

`/fspike` shows the status in game, `/fspike soak off` pauses the background rounds.

```text
familiar-spike report       rebuild report.md from the collected data
familiar-spike uninstall    remove the test addon, its AddOns.txt rows and saved results
familiar-spike --wow "D:\Games\World of Warcraft\_forever_"   if the client is not found
```

## What it touches

- `Interface\AddOns\FamiliarSpike*`: the addon, 512 helper addons, 64 slots, 600 sound files.
  All are marked `## X-Familiar-Spike: 1`; the tool never changes folders without that mark.
- The `FamiliarSpike*` rows in each character's `AddOns.txt`. Other rows stay byte for byte.
- `SavedVariables\FamiliarSpike.lua`.

No network, no game automation. The sounds are silence and are stopped right away.

## Development

Needs [Bun](https://bun.com) and, for the simulator, LuaJIT or Lua 5.1 with LuaBitOp.

```sh
bun install
bun run typecheck
bun run sim                 # real addon + real companion, files in a temp folder
bun sim/run.ts --noreset    # ResetAddOns keeps memory: the lane D downlink must time out
bun run build               # dist/familiar-spike.exe
```

`sim/wow.lua` stands in for the client: it runs the addon files and backs the API calls with
real files. It cannot tell us what the real client does. That is what the spike is for.
