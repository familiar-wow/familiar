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

## Run it

The team gets the builds for Windows and Linux as a draft release.

**Windows:** unpack the zip and double-click `familiar-spike.exe`. SmartScreen may warn
because the file is unsigned: _More info → Run anyway_. Do not click into the console window
while it runs: Windows pauses programs whose console is in selection mode. If the title
starts with _Select_, press Esc.

**Linux**, with WoW under Wine or Proton: the tool runs natively. Unpack it and start it in
a terminal:

```sh
tar xzf familiar-spike-0.2.0-linux-x64.tar.gz
cd familiar-spike-0.2.0-linux-x64
./familiar-spike check    # shows which client it found and changes nothing
./familiar-spike
```

It looks for the client in the Wine prefixes of Lutris, Steam (Proton), Bottles, Heroic,
`~/.wine` and `$WINEPREFIX`. If it finds none or the wrong one, add
`--wow "<prefix>/drive_c/Program Files (x86)/World of Warcraft/_forever_"` to each command.

Then, on both systems:

1. If WoW was running, quit it completely and start it again. `/reload` does not pick up new
   addon folders.
2. Log in. Chat shows _Familiar Spike: Companion connected_.
3. Stand somewhere quiet, out of combat, and type `/fspike bench`. It takes about two minutes.
4. Type `/reload` once, so the client saves the results.
5. Play as usual for at least an hour: questing, dungeons, combat. The addon runs a small
   round every 30 seconds. Every `/reload` or logout adds results.
6. Press Ctrl+C in the tool's window. `familiar-spike-data/report.md` is the result; send the
   whole `familiar-spike-data` folder.

The game sound has to be on, at any volume: doorbells rely on `PlaySoundFile`. `/fspike`
shows the status in game, `/fspike soak off` pauses the background rounds.

```text
familiar-spike check        show which client it found, without changing anything
familiar-spike report       rebuild report.md from the collected data
familiar-spike uninstall    remove the test addon, its AddOns.txt rows and saved results
familiar-spike --wow <folder>   use this client folder instead of searching
```

## What it touches

- `Interface/AddOns/FamiliarSpike*`: the addon, 512 helper addons, 64 slots, 600 sound files.
  All are marked `## X-Familiar-Spike: 1`; the tool never changes folders without that mark.
  On Linux it uses the existing folder even if it is spelled differently, such as `Addons`.
- The `FamiliarSpike*` rows in each character's `AddOns.txt`. Other rows stay byte for byte.
- `SavedVariables/FamiliarSpike.lua`.

No network, no game automation. The sounds are silence and are stopped right away.

## Development

Needs [Bun](https://bun.com) and, for the simulator, LuaJIT or Lua 5.1 with LuaBitOp.
Packing the release archives needs `zip` and `tar`.

```sh
bun install
bun run typecheck
bun run sim                 # real addon + real companion, files in a temp folder
bun sim/run.ts --noreset    # ResetAddOns keeps memory: the lane D downlink must time out
bun run build               # dist/familiar-spike-<version>-{windows-x64.zip,linux-x64.tar.gz}
bun sim/run.ts --binary dist/familiar-spike-0.2.0-linux-x64/familiar-spike
```

`sim/wow.lua` stands in for the client: it runs the addon files and backs the API calls with
real files. With `--binary` the simulator drives the built Linux program instead of the
source, and the game process is named `Wow.exe` the way Wine names it. None of this tells us
what the real client does. That is what the spike is for.
