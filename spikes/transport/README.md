# Transport spike (FAM-15)

Throwaway measuring tool. It answers one question for [ADR 0005](../../docs/adr/README.md):
which channels can carry Familiar's traffic between the addon and the companion while you
actually play? The addon sandbox has no sockets and no file access, so every channel is a
side effect the client happens to persist or reload.

0.5.0 is the last round. Earlier rounds settled the downlink and dropped the channels that
cost too much; this one runs the two remaining uplinks the way the product would use them,
with a real reply for every message:

| Channel           | Direction         | How it works                                                                                                                                                                         |
| ----------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AddOns.txt lane U | addon → companion | The addon flips the enable state of 64, 128 or 256 empty helper addons and calls `C_AddOns.SaveAddOns()`; the companion reads `AddOns.txt`. Every message ends with all helpers off. |
| Screenshot        | addon → companion | The addon paints the message as a black-and-white block next to the chat box, shows it for the frame that calls `Screenshot()` and hides it; the companion finds it in the picture.  |
| Font bank         | companion → addon | 256 pre-installed fonts. The companion writes the reply into the glyph widths of the fonts the message names; the addon measures them. 490 bytes per font, no code.                  |
| Doorbell          | companion → addon | Pre-installed empty `.wav` files. Once the reply is in place, the companion writes a silent sound into the next one; the addon notices with `PlaySoundFile`.                         |

Messages and replies carry a CRC-32. A screenshot that brings no doorbell is taken once more,
held a frame longer.

What the earlier rounds found on build 1.60.1.70888, and what 0.5.0 does with it:

- The picture is the frame in which `Screenshot()` runs; `OnUpdate` comes before drawing. A
  block shown in the same handler is in the picture, so it needs to be visible for one frame.
- The client's picture settings can bend the colours of a screenshot. Black and white survive
  generic curves at the slider limits, grey levels do not. The benchmark sets Gamma,
  Brightness, Contrast and the colour-blind filter to their limits for a moment each.
- Helpers in one group can sit in a collapsible category of the addon list (`## Category`;
  Forever's `AddonList.lua` files a group under its parent's category). The addon collapses it
  once, so the list shows one closed entry instead of 256.
- The addon list turns _OK_ into _Reload UI_ when an addon's state differs from the state at
  UI load. Ending every message with all helpers off keeps the list quiet.
- A character's `AddOns.txt` holds rows only for addons set for that character, and the
  client keeps one enable state per process, so the writer switches every helper off before
  its first frame instead of trusting `GetAddOnEnableState`.
- A font file is read once per process. A font string keeps measuring with its old font for a
  moment after `SetFont`, so every read uses a fresh one and waits until `GetFont` names the
  file. Widths end at the visible edge of the last glyph; the reader calibrates with two glyphs.
- An empty `.wav` already "plays"; a raised doorbell is told by its length
  (`C_Sound.IsPlaying` a moment later).

## Run it

The team gets the builds for Windows and Linux as a draft release.

**Windows:** unpack the zip and double-click `familiar-spike.exe`. SmartScreen may warn
because the file is unsigned: _More info → Run anyway_. Do not click into the console window
while it runs: Windows pauses programs whose console is in selection mode. If the title
starts with _Select_, press Esc.

**Linux**, with WoW under Wine or Proton: the tool runs natively. Unpack it and start it in
a terminal:

```sh
tar xzf familiar-spike-0.5.0-linux-x64.tar.gz
cd familiar-spike-0.5.0-linux-x64
./familiar-spike check    # shows which client it found and changes nothing
./familiar-spike
```

It looks for the client in the Wine prefixes of Lutris, Steam (Proton), Bottles, Heroic,
`~/.wine` and `$WINEPREFIX`. If it finds none or the wrong one, add
`--wow "<prefix>/drive_c/Program Files (x86)/World of Warcraft/_forever_"` to each command.

Then, on both systems:

1. Start the tool first, then WoW. If WoW was running, quit it completely and start it again:
   `/reload` does not pick up new or removed addon folders.
2. Log in. Chat shows the self-test and, a few seconds later, _Companion answered in …_.
3. Stand somewhere quiet, out of combat, and type `/fspike bench`. It takes about two minutes:
   the screen flashes a few dozen times next to the chat box, picture and sound settings
   change for moments, and the interface disappears for a second. Everything is set back
   right away; if WoW stops in between, at the next login.
4. Type `/reload` once, so the client saves the results.
5. Play for about an hour: fight, pass a loading screen, and Alt+Tab away for three minutes
   once. In the background a short lane message goes out every minute and a screenshot every
   two minutes, in combat too.
6. Now and then type `/fspike say <anything>`. Odd messages go over lane U, even ones in a
   screenshot, bright or muted, one frame or two. Chat shows the path, the reply and how long
   it took.
7. Open the addon list once in game and once at the character list: is _Familiar Spike lane_
   closed?
8. At the end, log out to the character list or quit WoW: WoW writes the addon's results
   only then. A `/reload` saves too, but starts a new session that is not saved.
9. Press Ctrl+C in the tool's window. `familiar-spike-data/report.md` is the result; send the
   whole `familiar-spike-data` folder. If the report says sessions are not saved yet, log out
   in game and run `familiar-spike report`.

Keep the game sound on, at any volume: doorbells rely on `PlaySoundFile`. `/fspike` shows the
status in game, `/fspike soak off` pauses the background messages.

```text
familiar-spike check        show which client it found, without changing anything
familiar-spike report       collect the addon's saved results from WoW and rebuild report.md
familiar-spike uninstall    remove the test addon, its AddOns.txt rows and saved results
familiar-spike --wow <folder>   use this client folder instead of searching
```

## What it touches

- `Interface/AddOns/FamiliarSpike*`: the addon, 256 helper addons, 600 sound files and 256
  fonts (6 MB). All are marked `## X-Familiar-Spike: 1`; the tool never changes folders
  without that mark and removes the lane D and slot helpers of older versions. On Linux it
  uses the existing folder even if it is spelled differently, such as `Addons`.
- The `FamiliarSpike*` rows in each character's `AddOns.txt`, which the client writes. While
  WoW is closed the tool removes the rows of old helpers; other rows stay byte for byte.
- `SavedVariables/FamiliarSpike.lua`, and once the collapsed state of the helpers' category
  in the addon list.
- `Screenshots`: the tool deletes only its own pictures, the ones with a block, and keeps the
  block in `familiar-spike-data/shots`. Your own screenshots stay untouched and nothing of
  them is kept. So do pictures the block did not make it into, such as the one taken with
  the interface hidden.
- During the benchmark only: Gamma, Brightness, Contrast, the colour-blind filter, master
  volume and game sound, each for a moment, and the interface hidden for a second.

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
bun run build                 # dist/familiar-spike-<version>-{windows-x64.zip,linux-x64.tar.gz}
bun sim/run.ts --binary dist/familiar-spike-0.5.0-linux-x64/familiar-spike
```

`sim/wow.lua` stands in for the client: it runs the addon files and backs the API calls with
real files. It measures the fonts the companion writes and renders screenshots from the
addon's textures, bent by a made-up picture curve; the runner encodes them as JPEG. With
`--binary` the simulator drives the built Linux program instead of the source, with the short
intervals of `FAMILIAR_SPIKE_FAST=1`, and the game process is named `Wow.exe` the way Wine
names it. None of this tells us what the real client does. That is what the spike is for.
