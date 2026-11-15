// What goes between the player and the brain. The addon sends a question as "key: value" lines
// about the character, a blank line and the question (addon/Familiar/Familiar.lua). The brain
// gets the question with that header, as ADR 0001 has it: everything else it will fetch through
// tools (P2).

const FIELDS = [
	"name",
	"realm",
	"level",
	"race",
	"class",
	"faction",
	"zone",
	"subzone",
	"locale",
] as const;
export type Character = Partial<Record<(typeof FIELDS)[number], string>>;

export interface Question {
	text: string;
	character: Character;
}

export function parseQuestion(body: string): Question {
	const end = body.indexOf("\n\n");
	if (end < 0) return { text: body.trim(), character: {} };
	const character: Character = {};
	for (const line of body.slice(0, end).split("\n")) {
		const [, key, value] = /^([a-z]+): (.+)$/.exec(line) ?? [];
		const field = FIELDS.find((f) => f === key);
		if (field && value) character[field] = value;
	}
	return { text: body.slice(end + 2).trim(), character };
}

/** The prompt for the brain: how to answer, who asks and from where, and the question. */
export function prompt({ text, character: c }: Question): string {
	const kind = [c.level && `level ${c.level}`, c.race, c.class]
		.filter(Boolean)
		.join(" ");
	const where = [c.zone, c.subzone].filter(Boolean).join(", ");
	const player = [
		c.name && (c.realm ? `${c.name} (${c.realm})` : c.name),
		kind && `${kind}${c.faction ? ` of the ${c.faction}` : ""}`,
		where && `in ${where}`,
	]
		.filter(Boolean)
		.join(", ");
	return [
		"The player asks you from inside the game WoW Forever, through the addon Familiar. Your answer appears in the game's chat window.",
		"- Answer in the player's language and use the names the game shows in that language.",
		"- Keep it short: at most 600 characters of plain text, without Markdown.",
		"- You only advise. You cannot act in the game.",
		"- If you are not sure how something works in Forever, say so instead of guessing.",
		"",
		`The player: ${player || "unknown"}.${c.locale ? ` Game language: ${c.locale}.` : ""}`,
		"",
		`Question: ${text}`,
	].join("\n");
}

/** Cuts `text` to at most `bytes` bytes of UTF-8, between characters, and marks the cut. */
export function clip(text: string, bytes: number): string {
	const encoded = new TextEncoder().encode(text);
	if (encoded.length <= bytes) return text;
	const mark = " …";
	let end = bytes - new TextEncoder().encode(mark).length;
	// Continuation bytes are 10xxxxxx: back up to the start of a character.
	while (end > 0 && ((encoded[end] ?? 0) & 0xc0) === 0x80) end--;
	return `${new TextDecoder().decode(encoded.subarray(0, end)).trimEnd()}${mark}`;
}
