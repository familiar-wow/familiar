// Checks the fonts with an independent reader: opentype.js parses them the way a font loader
// would, and every data glyph must be as wide as the byte it carries.
import { expect, test } from "bun:test";
import { parse } from "opentype.js";
import { PACKET_BYTES } from "./codec.ts";
import { emptyFont, fontFile } from "./font.ts";

const width = (font: ReturnType<typeof parse>, char: string) =>
	font.charToGlyph(char).advanceWidth;

test("every data glyph is as wide as its byte", () => {
	const packet = Uint8Array.from(
		{ length: PACKET_BYTES },
		(_, i) => (i * 73 + 11) % 256,
	);
	const bytes = fontFile(packet, 7);
	const font = parse(bytes.buffer);
	expect(font.unitsPerEm).toBe(1024);
	packet.forEach((value, i) => {
		expect(width(font, String.fromCodePoint(0xe000 + i))).toBe(
			(16 + value) * 16,
		);
	});
	// The addon calibrates with "!" (0) and '"' (255) and puts "~" behind every glyph.
	expect(width(font, "!")).toBe(16 * 16);
	expect(width(font, '"')).toBe(271 * 16);
	expect(width(font, "~")).toBe(32 * 16);
});

test("the empty font is a valid font of zero bytes", () => {
	const font = parse(emptyFont(1).buffer);
	expect(width(font, "\u{e000}")).toBe(16 * 16);
	expect(width(font, "\u{e1ff}")).toBe(16 * 16);
});
