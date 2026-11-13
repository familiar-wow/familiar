// Font bank: TrueType fonts whose glyph widths carry bytes, companion → addon. The addon sets a
// font it has never loaded and measures the width of every data glyph; the file holds no code.
// The client reads a font file only on its first use per process and finds only files that
// existed when it started, so the bank is a set of files installed up front, each read once.
// A reply fills the fonts from the one the addon named in its message. Shared with
// addon/FamiliarSpike/Font.lua.
//
// Metrics follow what wow-forever-codex measured to work on Forever: 1024 units per em, a data
// glyph for byte v is (16 + v) × 16 units wide, read at font height 64 with "!" (v = 0) and '"'
// (v = 255) as calibration and "~" behind every glyph.
import { crc32 } from "./protocol.ts";

/** Font files in the bank. */
export const FONTS = 256;
/** Bytes per font, one data glyph each, starting at U+E000. */
export const FONT_PACKET = 512;
export const FONT_HEADER = 18;
export const FONT_PAYLOAD = FONT_PACKET - FONT_HEADER - 4;

const UPEM = 1024;
const BOX_W = 64;
const BOX_H = 512;
const DATA_GLYPH = 96; // glyph id of U+E000: .notdef, space, then "!" to "~"

export function fontName(slot: number): string {
	return `F${String(slot).padStart(3, "0")}.ttf`;
}

export interface FontContent {
	/** The companion run. */
	epoch: number;
	slot: number;
	/** The part of the reply this font carries, from 0. */
	part: number;
	/** Companion wall time in ms when it wrote the file. */
	wallMs: number;
	payload: Uint8Array;
}

/**
 * Layout: "FF", version 1, epoch, slot (u16), part (u32), wall ms (u48), payload length (u16),
 * 490 payload bytes, CRC-32 of everything before it. Little-endian.
 */
export function fontPacket(content: FontContent): Uint8Array {
	if (content.payload.length > FONT_PAYLOAD) throw new Error("font payload");
	const bytes = new Uint8Array(FONT_PACKET);
	const view = new DataView(bytes.buffer);
	bytes.set([0x46, 0x46, 1, content.epoch], 0);
	view.setUint16(4, content.slot, true);
	view.setUint32(6, content.part >>> 0, true);
	view.setUint32(10, content.wallMs % 2 ** 32, true);
	view.setUint16(14, Math.floor(content.wallMs / 2 ** 32), true);
	view.setUint16(16, content.payload.length, true);
	bytes.set(content.payload, FONT_HEADER);
	view.setUint32(FONT_PACKET - 4, crc32(bytes, 0, FONT_PACKET - 4), true);
	return bytes;
}

/** A reply cut into font packets, one per slot from `first` on. */
export function replyPackets(
	reply: Uint8Array,
	first: number,
	epoch: number,
	wallMs: number,
): { slot: number; packet: Uint8Array }[] {
	const out: { slot: number; packet: Uint8Array }[] = [];
	for (let part = 0; part * FONT_PAYLOAD < reply.length; part++) {
		const slot = first + part;
		const payload = reply.subarray(
			part * FONT_PAYLOAD,
			(part + 1) * FONT_PAYLOAD,
		);
		out.push({
			slot,
			packet: fontPacket({ epoch, slot, part, wallMs, payload }),
		});
	}
	return out;
}

/** Big-endian byte builder for the font tables. */
export class Bytes {
	private buffer = new Uint8Array(1024);
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

	pad4(): this {
		while (this.length % 4) this.u8(0);
		return this;
	}

	done(): Uint8Array {
		return this.buffer.slice(0, this.length);
	}
}

interface Glyph {
	advance: number;
	outline: boolean;
}

const width = (value: number) => (16 + value) * 16;

/** .notdef, space, "!" to "~" (printable Latin keeps font loaders happy), then the data. */
function glyphs(packet: Uint8Array): Glyph[] {
	const list: Glyph[] = [
		{ advance: 512, outline: true },
		{ advance: 256, outline: false },
	];
	for (let code = 0x21; code <= 0x7e; code++)
		list.push({
			advance: width(code === 0x21 ? 0 : code === 0x22 ? 255 : 16),
			outline: true,
		});
	for (const value of packet)
		list.push({ advance: width(value), outline: true });
	return list;
}

/** A clockwise box, 34 bytes: the same small outline for every visible glyph. */
function box(out: Bytes): void {
	out.u16(1).u16(0).u16(0).u16(BOX_W).u16(BOX_H); // contours, bounding box
	out.u16(3).u16(0); // last point, no instructions
	out.u8(1).u8(1).u8(1).u8(1); // on-curve points, 16-bit deltas
	for (const dx of [0, 0, BOX_W, 0]) out.u16(dx & 0xffff);
	for (const dy of [0, BOX_H, 0, -BOX_H]) out.u16(dy & 0xffff);
}

function cmap(): Uint8Array {
	const segments = [
		{ start: 0x20, end: 0x7e, delta: 1 - 0x20 },
		{
			start: 0xe000,
			end: 0xe000 + FONT_PACKET - 1,
			delta: DATA_GLYPH - 0xe000,
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

/** A complete TrueType font for one packet. */
export function fontFile(packet: Uint8Array, slot: number): Uint8Array {
	if (packet.length !== FONT_PACKET) throw new Error("font packet size");
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
	const family = `FamiliarSpikeF${String(slot).padStart(3, "0")}`;

	const head = new Bytes()
		.u16(1)
		.u16(0)
		.u32(0x00010000)
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
		.u16(0)
		.u16(0)
		.u16(2) // maxZones
		.u16(0)
		.u16(0)
		.u16(0)
		.u16(0)
		.u16(0)
		.u16(0)
		.u16(0)
		.u16(0);
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
		.u16(0xe000 + FONT_PACKET - 1)
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
		.u32(0)
		.u32(0)
		.u32(0)
		.u32(0)
		.u32(0);

	const tables: [string, Uint8Array][] = (
		[
			["OS/2", os2.done()],
			["cmap", cmap()],
			["glyf", glyf.done()],
			["head", head.done()],
			["hhea", hhea.done()],
			["hmtx", hmtx.done()],
			["loca", loca.done()],
			["maxp", maxp.done()],
			["name", name(family)],
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
	const offsets: number[] = [];
	for (const [tag, data] of tables) {
		const padded = new Uint8Array(Math.ceil(data.length / 4) * 4);
		padded.set(data);
		offsets.push(offset);
		out
			.bytes(new TextEncoder().encode(tag))
			.u32(checksum(padded))
			.u32(offset)
			.u32(data.length);
		offset += padded.length;
	}
	for (const [, data] of tables) out.bytes(data).pad4();
	const font = out.done();
	const headAt = offsets[tables.findIndex(([tag]) => tag === "head")] ?? 0;
	new DataView(font.buffer).setUint32(
		headAt + 8,
		(0xb1b0afba - checksum(font)) >>> 0,
	);
	return font;
}

/** The install-time placeholder: a valid font whose packet is all zeros. */
export function placeholderFont(slot: number): Uint8Array {
	return fontFile(new Uint8Array(FONT_PACKET), slot);
}
