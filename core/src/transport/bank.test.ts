// The bank's names are hard links to a few empty fonts (FAM-25). Runs on Windows in CI too,
// where hard links and file ids behave differently.
import { afterAll, expect, test } from "bun:test";
import {
	copyFileSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wowPaths } from "../wow/client.ts";
import { install } from "../wow/install.ts";
import {
	Bank,
	basePath,
	EMPTY_FONT,
	FONTS,
	fontPath,
	isEmptyFont,
} from "./bank.ts";
import { decodePacket } from "./codec.ts";
import { fontFile } from "./font.ts";

const root = mkdtempSync(join(tmpdir(), "familiar-bank-"));
const paths = wowPaths(join(root, "_forever_"));
const addon = join(paths.addons, "Familiar");
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The packet a font carries, read from its advance widths like the addon does. */
function packetOf(file: string): Uint8Array {
	const font = readFileSync(file);
	const hmtx = font.indexOf("hmtx");
	const offset = font.readUInt32BE(hmtx + 8);
	const bytes = new Uint8Array(512);
	for (let i = 0; i < 512; i++)
		bytes[i] = font.readUInt16BE(offset + 4 * (96 + i)) / 16 - 16;
	return bytes;
}

test("every name of the bank starts as a link to an empty font, and a reset links it again", () => {
	const started = performance.now();
	const result = install(paths, 16001, "0.0.0-test");
	console.log(
		`install: ${result.added} files in ${Math.round(performance.now() - started)} ms`,
	);
	// Every name has the size of a written font: the client may note sizes when it starts.
	expect(EMPTY_FONT.length).toBe(fontFile(new Uint8Array(512), FONTS).length);
	for (const slot of [1, 1000, 1001, FONTS]) {
		const file = fontPath(addon, slot);
		expect(isEmptyFont(file, basePath(addon, slot))).toBe(true);
		expect(statSync(file).size).toBe(EMPTY_FONT.length);
	}

	const bank = new Bank(addon);
	const sent = bank.send(7, new Uint8Array(600).fill(65));
	expect(sent).toEqual({ bell: 1, slot: 1, fonts: 2 });
	const written = fontPath(addon, 2);
	expect(isEmptyFont(written, basePath(addon, 2))).toBe(false);
	expect(decodePacket(packetOf(written))?.part).toBe(1);
	// The other names of that empty font stay empty.
	expect(readFileSync(fontPath(addon, 3))).toEqual(Buffer.from(EMPTY_FONT));

	const resetStarted = performance.now();
	expect(bank.reset()).toBe(3); // two fonts and the message doorbell
	console.log(`reset: ${Math.round(performance.now() - resetStarted)} ms`);
	expect(readFileSync(written)).toEqual(Buffer.from(EMPTY_FONT));
	expect(isEmptyFont(written, basePath(addon, 2))).toBe(true);
	expect(bank.reset()).toBe(0);
});

test("a copy of the empty font counts as empty, where the file system has no links", () => {
	const copy = join(root, "copy.ttf");
	copyFileSync(basePath(addon, 1), copy);
	expect(isEmptyFont(copy, basePath(addon, 1))).toBe(true);
});
