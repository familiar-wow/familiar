# Transport spike (FAM-15)

Throwaway measuring tool. It answers one question for [ADR 0005](../../docs/adr/README.md):
which channels can carry Familiar's traffic between the addon and the companion while you
actually play? The addon sandbox has no sockets and no file access, so every channel is a
side effect the client happens to persist or reload.

| Channel           | Direction         | How it works                                                                                                                                          |
| ----------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| AddOns.txt lane U | addon → companion | The addon flips the enable state of 256 empty helper addons and calls `C_AddOns.SaveAddOns()`. The companion reads `AddOns.txt`. 20 bytes per frame.  |
| AddOns.txt lane D | companion → addon | The companion rewrites a second lane; the addon calls `C_AddOns.ResetAddOns()` and reads it back. Works only if that call re-reads the file.          |
| Slot              | companion → addon | Pre-installed load-on-demand addons. The companion keeps their `data.lua` fresh; the addon calls `LoadAddOn`. Large payloads, 64 per UI session.      |
| Doorbell          | companion → addon | Pre-installed empty `.wav` files. The companion writes a silent sound into one; the addon notices with `PlaySoundFile`. One bit, no payload.          |
| Font bank         | companion → addon | 256 pre-installed fonts. The companion writes bytes into the glyph widths; the addon sets a font and measures them. 490 bytes per font, no code.      |
| Screenshot        | addon → companion | The addon paints a block of cells into a corner for a moment and calls `Screenshot()`; the companion decodes the picture. 256 B to 24 KB per picture. |

Doorbells and slots are the downlink that [wow-ai](https://github.com/chelinho139/wow-ai) and
[hermes-forever](https://github.com/Adolanium/hermes-forever) already use. The AddOns.txt
lanes would replace their screen-capture uplink: no visible pixels, and it works minimized
and in exclusive fullscreen.

The font bank follows what [wow-forever-codex](https://github.com/0xInuarashi/wow-forever-codex)
measured on build 69913: the client reads a font file once per process, only files that
existed when it started, and again after a full restart. The fonts are files, not addons, so
they do not show up in the addon list. The screenshot channel is new: it needs no screen
capture, so it should also work minimized and under Wayland.

On build 70888 both work, with two findings from 0.4.0. After `SetFont`, a font string that
already shows one of our fonts keeps measuring with it at first, and `GetFont` does not name
the new file yet. And widths came out close to half a byte off, which fits glyph advances
rounded to whole screen pixels. Since 0.4.1 every font read uses a fresh font string, waits
until `GetFont` names the new file and measures in a frame scaled to one pixel per unit. The
screenshot block is painted while hidden, a few hundred cells per frame, and some pictures
hide the data right after the call to find out when the client captures.

Every channel is measured on its own schedule, so one that does not work on a client cannot
hide the others. On build 1.60.1.70888 an empty `.wav` already "plays"; the addon then tells a
raised doorbell by its length (`C_Sound.IsPlaying` a moment later) and says so in chat. The
report also lists every file the client writes under `WTF`, which explains a channel that
stays silent.

What the client does with `AddOns.txt`, measured on build 70888: a character's file holds
rows only for the addons set for that character, and the client keeps one enable state for
the whole process. After a character switch, a helper without a row still has the state the
previous character left in memory, so `GetAddOnEnableState` cannot be trusted. Since 0.3.1
the addon disables all 256 helpers before its first frame in every session, and the
companion writes lane D into the file the client wrote last.

## Run it

The team gets the builds for Windows and Linux as a draft release.

**Windows:** unpack the zip and double-click `familiar-spike.exe`. SmartScreen may warn
because the file is unsigned: _More info → Run anyway_. Do not click into the console window
while it runs: Windows pauses programs whose console is in selection mode. If the title
starts with _Select_, press Esc.

**Linux**, with WoW under Wine or Proton: the tool runs natively. Unpack it and start it in
a terminal:

```sh
tar xzf familiar-spike-0.4.1-linux-x64.tar.gz
cd familiar-spike-0.4.1-linux-x64
./familiar-spike check    # shows which client it found and changes nothing
./familiar-spike
```

It looks for the client in the Wine prefixes of Lutris, Steam (Proton), Bottles, Heroic,
`~/.wine` and `$WINEPREFIX`. If it finds none or the wrong one, add
`--wow "<prefix>/drive_c/Program Files (x86)/World of Warcraft/_forever_"` to each command.

Then, on both systems:

1. Start the tool first, then WoW. If WoW was running, quit it completely and start it again:
   `/reload` does not pick up new addon files.
2. Log in. Chat shows the self-test, whether doorbells work on this client and, a few seconds
   later, _Companion seen via …_.
3. Stand somewhere quiet, out of combat, and type `/fspike bench`. It takes about three
   minutes. At the end the top-left corner flashes twelve times: those are the screenshots.
   Your screenshot format is switched to PNG for a few seconds and back.
4. Type `/reload` once, so the client saves the results.
5. Play as usual for at least an hour: questing, dungeons, combat. Somewhere in that hour,
   switch characters once: log out to the character list, play a few minutes on another
   character, then come back. Every `/reload` or logout adds results.
6. Quit WoW completely once, start it again and log in: a new client process reads the font
   bank from the start, which shows whether fonts can be used again.
7. At the end, log out to the character list or quit WoW: WoW writes the addon's results
   only then. A `/reload` saves too, but starts a new session that is not saved.
8. Press Ctrl+C in the tool's window. `familiar-spike-data/report.md` is the result; send the
   whole `familiar-spike-data` folder. If the report starts with _Results not saved yet_,
   log out in game and run `familiar-spike report`.

Keep the game sound on, at any volume: doorbells rely on `PlaySoundFile`. `/fspike` shows the
status in game, `/fspike shots` repeats the screenshot test, `/fspike soak off` pauses the
background rounds.

```text
familiar-spike check        show which client it found, without changing anything
familiar-spike report       collect the addon's saved results from WoW and rebuild report.md
familiar-spike uninstall    remove the test addon, its AddOns.txt rows and saved results
familiar-spike --wow <folder>   use this client folder instead of searching
```

## What it touches

- `Interface/AddOns/FamiliarSpike*`: the addon, 512 helper addons, 64 slots, 600 sound files
  and 256 fonts (6 MB). All are marked `## X-Familiar-Spike: 1`; the tool never changes
  folders without that mark. On Linux it uses the existing folder even if it is spelled
  differently, such as `Addons`.
- The `FamiliarSpike*` rows in each character's `AddOns.txt`. Until the client has written
  one of them, lane D goes into every character's file. Other rows stay byte for byte.
- `SavedVariables/FamiliarSpike.lua`.
- `Screenshots`: the tool deletes only its own pictures, the ones with the block, and keeps
  their corner in `familiar-spike-data/shots`. Your own screenshots stay untouched.
- The `screenshotFormat` setting, during the screenshot test only. If WoW stops before it is
  switched back, the addon restores it at the next login.

It only reads the rest of `WTF`. No network, no game automation, no memory access. The sounds
are silence and are stopped right away.

## Development

Needs [Bun](https://bun.com) and, for the simulator, LuaJIT or Lua 5.1 with LuaBitOp.
Packing the release archives needs `zip` and `tar`.

```sh
bun install
bun run typecheck
bun run sim                   # real addon + real companion, files in a temp folder,
                              # with a character switch and a client restart
bun sim/run.ts --emptyplays   # build 70888: an empty .wav plays, a missing one stays missing
bun sim/run.ts --noreset      # ResetAddOns keeps memory: lane D must fail, the rest not
bun run build                 # dist/familiar-spike-<version>-{windows-x64.zip,linux-x64.tar.gz}
bun sim/run.ts --binary dist/familiar-spike-0.4.1-linux-x64/familiar-spike
```

`sim/wow.lua` stands in for the client: it runs the addon files and backs the API calls with
real files. It measures the fonts the companion writes and renders screenshots from the
addon's textures; the runner encodes them as JPEG or PNG. With `--binary` the simulator
drives the built Linux program instead of the source, with the short intervals of
`FAMILIAR_SPIKE_FAST=1`, and the game process is named `Wow.exe` the way Wine names it. None
of this tells us what the real client does. That is what the spike is for.
