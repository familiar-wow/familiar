# ADR 0005: Transport — AddOns.txt lane up, font bank and doorbell down

- **Status:** Proposed
- **Date:** 2026-11-13
- **Deciders:** @Smidelis, @hermes-smidelis

## Context

Addons run in a sandbox without network or file access, and saved variables reach the disk only on `/reload` or logout. Familiar needs a live channel in both directions: questions and game data from the addon to the companion, and answers back into the game ([ADR 0001](0001-architecture-addon-companion-and-brains.md)). Every known way goes through a side channel of the game client, and each has a price: entries in the addon list, screen capture, visible effects, or Lua that the game runs after another program wrote it.

A throwaway measuring tool ([#2], FAM-15) tested six channels in the live client, build 1.60.1.70888. @Smidelis ran it on Windows and @huettelcloud on Linux under Proton, over several rounds with hours of normal play, including combat, character switches and full client restarts. We judged the channels by these questions:

- Does every message arrive?
- Do players notice anything while they play?
- Does sending cost measurable frame time?
- How many entries does it add to the addon list?
- Does it need permissions or settings on the player's system?

## Decision

**Up, from the addon to the companion: the AddOns.txt lane.**

- Familiar installs 256 empty helper addons that never load. The addon writes a frame of 32 bytes (a header byte, 29 bytes of data and a CRC-16) as their enabled states and calls `C_AddOns.SaveAddOns()`. The client then writes the character's `AddOns.txt`, and the companion reads the frame from it.
- The addon waits at least 33 ms between two saves; at that pace the client lost no frame in any round. Half that gap worked in a short test. One save per rendered frame did not: the client wrote fewer file versions than the addon saved.
- Every message carries a CRC-32. If no reply comes, the addon sends the message again.
- Every message ends with all helpers off, which also tells the companion that it is complete. With helpers left on, the addon list would offer _Reload UI_ instead of _OK_.
- The addon switches every helper off before its first frame in a session and never trusts `GetAddOnEnableState`: the client keeps one enabled state per process, while `AddOns.txt` holds rows per character.
- The addon does not send while the player has the addon list open.
- The companion never writes `AddOns.txt` while the game runs. The client does not write the file atomically, so the companion reads a fresh file again when it looks cut short, and retries while Windows still locks it.
- The helpers form one group in their own category of the addon list, and the addon collapses that category once. Familiar's main addon stays outside it.

**Down, from the companion to the addon: the font bank and the doorbell.**

- The companion writes a reply into TrueType files that the client has not loaded yet. Each file holds a packet of 512 bytes, 490 of them reply data, one byte per glyph as its advance width. The addon measures the glyphs with `GetStringWidth`.
- For every file the addon creates a fresh font string, measures only after `GetFont` names the new file, scales the measuring frame to one screen pixel per unit and calibrates with two known glyphs.
- The client loads each file only once per process, so the bank is a budget per game session. The companion resets it when the game starts.
- The doorbell tells the addon when a reply is ready, so the addon never spends a font on a reply that is not there yet. Four times a second, the addon plays the next of a series of `.wav` files on the master channel. When a reply is in place, the companion turns that file into 1.5 seconds of silence. This build reports even an empty file as played, so the addon asks `C_Sound.IsPlaying` a moment later whether the file is still playing.

The transport stays behind its interface, and copy and paste remains the fallback ([ADR 0001](0001-architecture-addon-companion-and-brains.md)).

## Alternatives

- **Screenshot up:** the addon shows a black-and-white block for one frame and calls `Screenshot()`; the companion reads the block from the picture and deletes the file. It needs no helper addons, works in combat and survived the picture settings at their limits, but players notice the block even for that one frame. Not built; the code in [#2] shows how, should the lane ever fail.
- **AddOns.txt down:** the companion writes the bits, the addon reads them with `C_AddOns.ResetAddOns()`. It works, but costs more per read than the font bank, and the companion's write can overwrite a save of the client. In one run that cost an uplink frame.
- **Load-on-demand slots:** the companion writes Lua files that the addon loads. They carry large payloads, but each load costs several times more on Windows than on Linux, each slot works once per session, and the game runs code that another program wrote.
- **Pixel strip with screen capture** (wow-ai, hermes-forever): needs screen recording permission on macOS, a portal dialog on Wayland and a window that nothing covers. Not measured again.
- **Key bindings** (Witchcraft): pause in combat and change the player's own bindings. Not measured.
- **Fewer helper addons:** 128 or 64 helpers halve or quarter the rate. With the category collapsed, the number hardly shows, so we keep 256.
- **Saved variables only:** reach the disk only on `/reload` or logout.

## Consequences

- While they play, players see and hear nothing of the transport. Sending works in combat and costs no measurable frame time.
- The addon list shows Familiar and one collapsed category; opened, it lists 256 helpers. The client keeps the collapsed state per machine. It stayed collapsed across `/reload` on Windows; the character list after a full restart is still to be checked.
- Familiar has to install the helpers, the font bank and the doorbell files, and the client finds new files only after a full restart. Whether the CurseForge package or the companion installs them is decided later.
- Up, the lane carries at most about 0.9 KB/s (29 bytes every 33 ms). Messages stay small, and the brain pulls everything else through tools ([ADR 0001](0001-architecture-addon-companion-and-brains.md)).
- Fonts and doorbell files work once per game session. The tool's 256 fonts hold about 125 KB, or about 50 replies of 2 KB. Familiar needs a larger bank, for example many file names as hard links to a few files, as wow-forever-codex does, or a denser reply format. Not measured yet.
- Players who switch off all game sound get no doorbell; master volume 0 works. They need another trigger, such as a font that the addon reads at fixed intervals and that says whether a reply is ready. Not measured yet.
- Neither side runs code that the other wrote: the companion reads bits from a text file, the addon measures fonts.
- Everything rests on undocumented behavior of build 1.60.1.70888, and a client update can break it. The transport stays isolated, and the measuring tool in [#2] can run again.

[#2]: https://github.com/familiar-wow/familiar/pull/2
