// The addon's Lua files, embedded into the executable at build time.
import probe from "../addon/FamiliarSpike/Probe.lua" with { type: "text" };
import spike from "../addon/FamiliarSpike/Spike.lua" with { type: "text" };
import wire from "../addon/FamiliarSpike/Wire.lua" with { type: "text" };

export const ADDON_FILES: Record<string, string> = {
	"Wire.lua": wire,
	"Probe.lua": probe,
	"Spike.lua": spike,
};
