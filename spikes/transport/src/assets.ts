// The addon's Lua files, embedded into the executable at build time.
import bench from "../addon/FamiliarSpike/Bench.lua" with { type: "text" };
import font from "../addon/FamiliarSpike/Font.lua" with { type: "text" };
import msg from "../addon/FamiliarSpike/Msg.lua" with { type: "text" };
import probe from "../addon/FamiliarSpike/Probe.lua" with { type: "text" };
import shot from "../addon/FamiliarSpike/Shot.lua" with { type: "text" };
import spike from "../addon/FamiliarSpike/Spike.lua" with { type: "text" };
import wire from "../addon/FamiliarSpike/Wire.lua" with { type: "text" };

/** In load order. */
export const ADDON_FILES: Record<string, string> = {
	"Wire.lua": wire,
	"Font.lua": font,
	"Shot.lua": shot,
	"Probe.lua": probe,
	"Msg.lua": msg,
	"Bench.lua": bench,
	"Spike.lua": spike,
};
