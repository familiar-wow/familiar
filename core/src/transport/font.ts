// Font bank fonts: TrueType files whose glyph widths carry a 512-byte packet. The addon sets a
// font the client has not loaded yet and measures each data glyph (addon/Familiar/Bank.lua);
// nothing in the file runs.
//
// The metrics are the ones measured to work in the client (FAM-15): 1024 units per em, the data
// glyph for byte v at U+E000 + its index is (16 + v) × 16 units wide, and the addon reads at
// font height 64 with "!" (v = 0) and '"' (v = 255) as calibration and "~" behind every glyph.
import { PACKET_BYTES } from "./codec.ts";

const UPEM = 1024;
const BOX_W = 64;
const BOX_H = 512;
/** Glyph id of U+E000: .notdef, space and "!" to "~" come first. */
const FIRST_DATA_GLYPH = 96;
const DATA_START = 0xe000;

/** Big-endian byte builder for the font tables. */
class Bytes {
	private buffer = new Uint8Array(4096);
	length = 0;

	private room(n: number): void {
		if (this.length + n <= this.buffer.length) return;
		const next = new Uint8Array(
			Math.max(this.buffer.length * 2, this.length + n),
		);
		next.set(this.buffer.subarray(0, this.length));
		this.buffer = next;
	}

	u8(value: number): this {
		this.room(1);
		this.buffer[this.length++] = value & 0xff;
		return this;
	}

	u16(value: number): this {
		return this.u8(value >>> 8).u8(value);
	}

	u32(value: number): this {
		return this.u16(value >>> 16).u16(value & 0xffff);
	}

	bytes(data: Uint8Array): this {
		this.room(data.length);
		this.buffer.set(data, this.length);
		this.length += data.length;
		return this;
	}

	done(): Uint8Array {
		return this.buffer.slice(0, this.length);
	}
}

const advance = (value: number) => (16 + value) * 16;

/** Advance and whether it has an outline: .notdef, space, "!" to "~", then the data. */
function glyphs(packet: Uint8Array): { advance: number; outline: boolean }[] {
	const list = [
		{ advance: 512, outline: true },
		{ advance: 256, outline: false },
	];
	for (let code = 0x21; code <= 0x7e; code++)
		list.push({
			advance: advance(code === 0x21 ? 0 : code === 0x22 ? 255 : 16),
			outline: true,
		});
	for (const value of packet)
		list.push({ advance: advance(value), outline: true });
	return list;
}

/** The same small clockwise box for every visible glyph, 34 bytes. */
function box(out: Bytes): void {
	out.u16(1).u16(0).u16(0).u16(BOX_W).u16(BOX_H); // contours, bounding box
	out.u16(3).u16(0); // last point, no instructions
	out.u8(1).u8(1).u8(1).u8(1); // on-curve points with 16-bit deltas
	for (const dx of [0, 0, BOX_W, 0]) out.u16(dx & 0xffff);
	for (const dy of [0, BOX_H, 0, -BOX_H]) out.u16(dy & 0xffff);
}

function cmap(): Uint8Array {
	const segments = [
		{ start: 0x20, end: 0x7e, delta: 1 - 0x20 },
		{
			start: DATA_START,
			end: DATA_START + PACKET_BYTES - 1,
			delta: FIRST_DATA_GLYPH - DATA_START,
		},
		{ start: 0xffff, end: 0xffff, delta: 1 },
	];
	const n = segments.length;
	const searchRange = 2 * 2 ** Math.floor(Math.log2(n));
	const sub = new Bytes()
		.u16(4)
		.u16(16 + 8 * n)
		.u16(0)
		.u16(2 * n)
		.u16(searchRange)
		.u16(Math.log2(searchRange / 2))
		.u16(2 * n - searchRange);
	for (const s of segments) sub.u16(s.end);
	sub.u16(0);
	for (const s of segments) sub.u16(s.start);
	for (const s of segments) sub.u16(s.delta & 0xffff);
	for (let i = 0; i < n; i++) sub.u16(0);
	return new Bytes()
		.u16(0)
		.u16(2)
		.u16(0) // Unicode, BMP
		.u16(3)
		.u32(20)
		.u16(3) // Windows, Unicode BMP
		.u16(1)
		.u32(20)
		.bytes(sub.done())
		.done();
}

function name(family: string): Uint8Array {
	const records: [number, string][] = [
		[1, family],
		[2, "Regular"],
		[3, family],
		[4, family],
		[5, "Version 1.000"],
		[6, family],
	];
	const strings = records.map(([, text]) => {
		const out = new Bytes();
		for (const ch of text) out.u16(ch.charCodeAt(0));
		return out.done();
	});
	const out = new Bytes()
		.u16(0)
		.u16(records.length)
		.u16(6 + 12 * records.length);
	let offset = 0;
	records.forEach(([id], i) => {
		const length = strings[i]?.length ?? 0;
		out.u16(3).u16(1).u16(0x409).u16(id).u16(length).u16(offset);
		offset += length;
	});
	for (const s of strings) out.bytes(s);
	return out.done();
}

function checksum(data: Uint8Array): number {
	let sum = 0;
	for (let i = 0; i < data.length; i += 4)
		sum =
			(sum +
				(((data[i] ?? 0) << 24) |
					((data[i + 1] ?? 0) << 16) |
					((data[i + 2] ?? 0) << 8) |
					(data[i + 3] ?? 0))) >>>
			0;
	return sum;
}

/** A complete TrueType font that carries one packet. */
export function fontFile(packet: Uint8Array, slot: number): Uint8Array {
	if (packet.length !== PACKET_BYTES) throw new Error("packet size");
	const list = glyphs(packet);
	const glyf = new Bytes();
	const loca = new Bytes();
	for (const g of list) {
		loca.u16(glyf.length / 2);
		if (g.outline) box(glyf);
	}
	loca.u16(glyf.length / 2);
	const hmtx = new Bytes();
	for (const g of list) hmtx.u16(g.advance).u16(0);
	const widest = Math.max(...list.map((g) => g.advance));
	const narrowest = Math.min(
		...list.filter((g) => g.outline).map((g) => g.advance),
	);

	const head = new Bytes()
		.u32(0x00010000)
		.u32(0x00010000) // font revision 1.0
		.u32(0) // checkSumAdjustment, set below
		.u32(0x5f0f3cf5)
		.u16(0x0003)
		.u16(UPEM)
		.u32(0)
		.u32(3_850_070_400) // created: 2026-01-01
		.u32(0)
		.u32(3_850_070_400)
		.u16(0)
		.u16(0)
		.u16(BOX_W)
		.u16(BOX_H)
		.u16(0) // macStyle
		.u16(8) // lowestRecPPEM
		.u16(2) // fontDirectionHint
		.u16(0) // short loca
		.u16(0);
	const hhea = new Bytes()
		.u32(0x00010000)
		.u16(800)
		.u16(-224 & 0xffff)
		.u16(0)
		.u16(widest)
		.u16(0)
		.u16(narrowest - BOX_W)
		.u16(BOX_W)
		.u16(1)
		.u16(0)
		.u16(0)
		.u32(0)
		.u32(0)
		.u16(0)
		.u16(list.length);
	const maxp = new Bytes()
		.u32(0x00010000)
		.u16(list.length)
		.u16(4) // maxPoints
		.u16(1) // maxContours
		.u32(0)
		.u16(2) // maxZones
		.bytes(new Uint8Array(16));
	const os2 = new Bytes()
		.u16(4)
		.u16(512) // xAvgCharWidth
		.u16(400)
		.u16(5)
		.u16(0) // fsType: installable
		.u16(666)
		.u16(614)
		.u16(0)
		.u16(77)
		.u16(666)
		.u16(614)
		.u16(0)
		.u16(358)
		.u16(50)
		.u16(260)
		.u16(0) // sFamilyClass
		.bytes(new Uint8Array(10)) // panose
		.u32(1) // Basic Latin
		.u32(1 << 28) // Private Use Area
		.u32(0)
		.u32(0)
		.bytes(new TextEncoder().encode("NONE"))
		.u16(0x0040) // regular
		.u16(0x20)
		.u16(DATA_START + PACKET_BYTES - 1)
		.u16(800)
		.u16(-224 & 0xffff)
		.u16(0)
		.u16(800)
		.u16(224)
		.u32(1) // Latin 1
		.u32(0)
		.u16(400)
		.u16(512)
		.u16(0)
		.u16(0x20)
		.u16(1);
	const post = new Bytes()
		.u32(0x00030000)
		.u32(0)
		.u16(-100 & 0xffff)
		.u16(50)
		.bytes(new Uint8Array(20));

	const tables = (
		[
			["OS/2", os2.done()],
			["cmap", cmap()],
			["glyf", glyf.done()],
			["head", head.done()],
			["hhea", hhea.done()],
			["hmtx", hmtx.done()],
			["loca", loca.done()],
			["maxp", maxp.done()],
			["name", name(`Familiar${String(slot).padStart(3, "0")}`)],
			["post", post.done()],
		] as [string, Uint8Array][]
	).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	const count = tables.length;
	const searchRange = 16 * 2 ** Math.floor(Math.log2(count));
	const out = new Bytes()
		.u32(0x00010000)
		.u16(count)
		.u16(searchRange)
		.u16(Math.log2(searchRange / 16))
		.u16(count * 16 - searchRange);
	let offset = 12 + 16 * count;
	let headAt = 0;
	for (const [tag, data] of tables) {
		const padded = new Uint8Array(Math.ceil(data.length / 4) * 4);
		padded.set(data);
		if (tag === "head") headAt = offset;
		out
			.bytes(new TextEncoder().encode(tag))
			.u32(checksum(padded))
			.u32(offset)
			.u32(data.length);
		offset += padded.length;
	}
	for (const [, data] of tables)
		out.bytes(data).bytes(new Uint8Array((4 - (data.length % 4)) % 4));
	const font = out.done();
	new DataView(font.buffer).setUint32(
		headAt + 8,
		(0xb1b0afba - checksum(font)) >>> 0,
	);
	return font;
}

/** What the bank holds before the app writes a font: a valid font with an all-zero packet. */
export function emptyFont(slot: number): Uint8Array {
	return fontFile(new Uint8Array(PACKET_BYTES), slot);
}
