// The addon's files, embedded into the executable at build time. Keep this list in step with
// Familiar.toc; a test compares them.
import bank from "../../../addon/Familiar/Bank.lua" with { type: "text" };
import bells from "../../../addon/Familiar/Bells.lua" with { type: "text" };
import codec from "../../../addon/Familiar/Codec.lua" with { type: "text" };
import familiar from "../../../addon/Familiar/Familiar.lua" with {
	type: "text",
};
import toc from "../../../addon/Familiar/Familiar.toc" with { type: "text" };
import lane from "../../../addon/Familiar/Lane.lua" with { type: "text" };
import tasks from "../../../addon/Familiar/Tasks.lua" with { type: "text" };
import transport from "../../../addon/Familiar/Transport.lua" with {
	type: "text",
};

export const TOC = toc;

export const FILES: Record<string, string> = {
	"Codec.lua": codec,
	"Tasks.lua": tasks,
	"Lane.lua": lane,
	"Bells.lua": bells,
	"Bank.lua": bank,
	"Transport.lua": transport,
	"Familiar.lua": familiar,
};
