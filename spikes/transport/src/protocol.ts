// Wire formats shared with the addon: Wire.lua (lane frames) and Msg.lua (messages, replies).
//
// A message goes up either way, over lane U or in a screenshot, and is the same bytes on both:
//   "FM", version, kind, epoch, id (u16), attempt, wall ms (u48), retry of (u48),
//   next font (u16), reply bytes (u16), path, style, body length (u16), body, CRC-32.
// A reply comes down in the font bank, 490 bytes per font, starting at the font the message
// named: "FR", version, epoch, id (u16), attempt, received ms (u48), written ms (u48), path,
// body length (u16), body, CRC-32. All little-endian.

export const LANE_BITS = 256;
export const SIGNALS = 600;
export const VERSION_BYTE = 5;

/** Bytes per lane frame by width code: 64, 128 or 256 helpers. All bits off is the rest state. */
export const WIDTHS: Record<number, number> = { 1: 8, 2: 16, 3: 32 };

export const Kind = {
	Say: 1,
	Soak: 2,
	Lane: 3,
	Bell: 4,
	Shot: 5,
	Trip: 6,
	Hello: 7,
} as const;
export const KIND_NAMES: Record<number, string> = {
	1: "say",
	2: "soak",
	3: "lane test",
	4: "bell test",
	5: "shot test",
	6: "round trip",
	7: "hello",
};
export const Path = { Lane: 1, Shot: 2 } as const;

/** Screenshot style bits. */
export const Style = { Muted: 1, Small: 2, World: 4, Hold: 8 } as const;

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, i) => {
	let c = i;
	for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
	return c >>> 0;
});

export function crc32(
	bytes: Uint8Array,
	start = 0,
	end = bytes.length,
): number {
	let crc = 0xffffffff;
	for (let i = start; i < end; i++)
		crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ (bytes[i] ?? 0)) & 0xff] ?? 0);
	return (crc ^ 0xffffffff) >>> 0;
}

/** CRC-16/CCITT-FALSE. */
export function crc16(
	bytes: Uint8Array,
	start = 0,
	end = bytes.length,
): number {
	let crc = 0xffff;
	for (let i = start; i < end; i++) {
		crc ^= (bytes[i] ?? 0) << 8;
		for (let k = 0; k < 8; k++)
			crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
	}
	return crc;
}

const view = (bytes: Uint8Array) =>
	new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function setU48(bytes: Uint8Array, at: number, value: number): void {
	const v = view(bytes);
	v.setUint32(at, value % 2 ** 32, true);
	v.setUint16(at + 4, Math.floor(value / 2 ** 32), true);
}

function getU48(bytes: Uint8Array, at: number): number {
	const v = view(bytes);
	return v.getUint32(at, true) + v.getUint16(at + 4, true) * 2 ** 32;
}

// Lane frames ------------------------------------------------------------------------

/**
 * One SaveAddOns worth of lane U: byte 0 holds the width code (bits 7-6), the first-frame flag
 * (bit 5) and a sequence number (bits 4-0); then a chunk of the message, then a CRC-16 of all
 * bytes before it. Helpers beyond the width stay off.
 */
export interface LaneFrame {
	code: number;
	first: boolean;
	seq: number;
	chunk: Uint8Array;
}

export function encodeLaneFrame(frame: LaneFrame): Uint8Array {
	const size = WIDTHS[frame.code];
	if (!size || frame.chunk.length > size - 3) throw new Error("bad lane frame");
	const bytes = new Uint8Array(size);
	bytes[0] = (frame.code << 6) | (frame.first ? 32 : 0) | (frame.seq & 31);
	bytes.set(frame.chunk, 1);
	view(bytes).setUint16(size - 2, crc16(bytes, 0, size - 2), true);
	return bytes;
}

/** "rest" when every helper is off, undefined when the bits hold no valid frame. */
export function decodeLaneFrame(
	bits: Uint8Array,
): LaneFrame | "rest" | undefined {
	if (bits.every((b) => b === 0)) return "rest";
	const code = (bits[0] ?? 0) >> 6;
	const size = WIDTHS[code];
	if (!size || bits.length < size) return undefined;
	for (let i = size; i < bits.length; i++) if (bits[i] !== 0) return undefined;
	if (crc16(bits, 0, size - 2) !== view(bits).getUint16(size - 2, true))
		return undefined;
	return {
		code,
		first: ((bits[0] ?? 0) & 32) !== 0,
		seq: (bits[0] ?? 0) & 31,
		chunk: bits.slice(1, size - 2),
	};
}

const LANE_LINE =
	/^FamiliarSpike_U(\d{3}):[ \t]*(enabled|disabled)[ \t]*(\r?)$/gm;

export interface LaneRead {
	/** Lane U as 32 bytes. A missing row counts as disabled, the helpers' default state. */
	bytes: Uint8Array;
	/** How many of the 256 rows the file holds. */
	rows: number;
	/** How many of them are enabled. */
	on: number;
	duplicate: boolean;
}

export function readLane(text: string): LaneRead {
	const bytes = new Uint8Array(LANE_BITS / 8);
	const seen = new Set<number>();
	let on = 0;
	let duplicate = false;
	for (const match of text.matchAll(LANE_LINE)) {
		const index = Number(match[1]);
		if (seen.has(index)) duplicate = true;
		seen.add(index);
		if (match[2] === "enabled") {
			on++;
			const at = index >> 3;
			bytes[at] = (bytes[at] ?? 0) | (1 << (index & 7));
		}
	}
	return { bytes, rows: seen.size, on, duplicate };
}

/** The lane rows a frame sets, for the simulator's tests. */
export function laneText(bits: Uint8Array): string {
	const lines: string[] = [];
	for (let i = 0; i < LANE_BITS; i++)
		lines.push(
			`${laneFolder(i)}: ${((bits[i >> 3] ?? 0) >> (i & 7)) & 1 ? "enabled" : "disabled"}`,
		);
	return `${lines.join("\n")}\n`;
}

// Messages ---------------------------------------------------------------------------

export const MESSAGE_HEADER = 28;

export interface Message {
	kind: number;
	epoch: number;
	id: number;
	attempt: number;
	/** Addon wall time in ms when it built the message. */
	wallMs: number;
	/** Wall time of a screenshot call whose picture missed the block; 0 if none. */
	retryOf: number;
	/** The font the reply starts at; 0: no reply. */
	fontNext: number;
	replyBytes: number;
	path: number;
	style: number;
	body: Uint8Array;
}

export function encodeMessage(m: Message): Uint8Array {
	const bytes = new Uint8Array(MESSAGE_HEADER + m.body.length + 4);
	const v = view(bytes);
	bytes.set([0x46, 0x4d, VERSION_BYTE, m.kind, m.epoch], 0);
	v.setUint16(5, m.id, true);
	bytes[7] = m.attempt;
	setU48(bytes, 8, m.wallMs);
	setU48(bytes, 14, m.retryOf);
	v.setUint16(20, m.fontNext, true);
	v.setUint16(22, m.replyBytes, true);
	bytes[24] = m.path;
	bytes[25] = m.style;
	v.setUint16(26, m.body.length, true);
	bytes.set(m.body, MESSAGE_HEADER);
	v.setUint32(bytes.length - 4, crc32(bytes, 0, bytes.length - 4), true);
	return bytes;
}

/** Total length of the message that starts with these bytes, once its header is in. */
export function messageLength(bytes: Uint8Array): number | undefined {
	if (bytes.length < MESSAGE_HEADER || bytes[0] !== 0x46 || bytes[1] !== 0x4d)
		return undefined;
	return MESSAGE_HEADER + view(bytes).getUint16(26, true) + 4;
}

export function decodeMessage(bytes: Uint8Array): Message | undefined {
	const length = messageLength(bytes);
	if (length === undefined || bytes.length < length) return undefined;
	if (bytes[2] !== VERSION_BYTE) return undefined;
	const v = view(bytes);
	if (crc32(bytes, 0, length - 4) !== v.getUint32(length - 4, true))
		return undefined;
	return {
		kind: bytes[3] ?? 0,
		epoch: bytes[4] ?? 0,
		id: v.getUint16(5, true),
		attempt: bytes[7] ?? 0,
		wallMs: getU48(bytes, 8),
		retryOf: getU48(bytes, 14),
		fontNext: v.getUint16(20, true),
		replyBytes: v.getUint16(22, true),
		path: bytes[24] ?? 0,
		style: bytes[25] ?? 0,
		body: bytes.slice(MESSAGE_HEADER, length - 4),
	};
}

// Replies ----------------------------------------------------------------------------

export const REPLY_HEADER = 22;

export interface Reply {
	epoch: number;
	id: number;
	attempt: number;
	receivedMs: number;
	writtenMs: number;
	path: number;
	body: Uint8Array;
}

export function encodeReply(r: Reply): Uint8Array {
	const bytes = new Uint8Array(REPLY_HEADER + r.body.length + 4);
	const v = view(bytes);
	bytes.set([0x46, 0x52, VERSION_BYTE, r.epoch], 0);
	v.setUint16(4, r.id, true);
	bytes[6] = r.attempt;
	setU48(bytes, 7, r.receivedMs);
	setU48(bytes, 13, r.writtenMs);
	bytes[19] = r.path;
	v.setUint16(20, r.body.length, true);
	bytes.set(r.body, REPLY_HEADER);
	v.setUint32(bytes.length - 4, crc32(bytes, 0, bytes.length - 4), true);
	return bytes;
}

export function decodeReply(bytes: Uint8Array): Reply | undefined {
	if (bytes[0] !== 0x46 || bytes[1] !== 0x52 || bytes[2] !== VERSION_BYTE)
		return undefined;
	const v = view(bytes);
	const length = REPLY_HEADER + v.getUint16(20, true) + 4;
	if (bytes.length < length) return undefined;
	if (crc32(bytes, 0, length - 4) !== v.getUint32(length - 4, true))
		return undefined;
	return {
		epoch: bytes[3] ?? 0,
		id: v.getUint16(4, true),
		attempt: bytes[6] ?? 0,
		receivedMs: getU48(bytes, 7),
		writtenMs: getU48(bytes, 13),
		path: bytes[19] ?? 0,
		body: bytes.slice(REPLY_HEADER, length - 4),
	};
}

/** "heard: <first line of the body>", then filler up to `size` bytes in total. */
export function replyBody(heard: Uint8Array, size: number): Uint8Array {
	const text = new TextDecoder().decode(heard).split("\n")[0] ?? "";
	const head = new TextEncoder().encode(`heard: ${text.slice(0, 200)}\n`);
	const body = new Uint8Array(Math.max(head.length, size));
	body.set(head);
	const filler = new TextEncoder().encode("familiar ");
	for (let i = head.length; i < body.length; i++)
		body[i] = filler[(i - head.length) % filler.length] ?? 32;
	return body;
}

// Files ------------------------------------------------------------------------------

/** Mono 8-bit silence. */
export function silentWav(ms: number): Uint8Array {
	const samples = Math.round(8 * ms);
	const bytes = new Uint8Array(44 + samples).fill(0x80);
	const v = view(bytes);
	const ascii = (at: number, text: string) => {
		for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
	};
	ascii(0, "RIFF");
	v.setUint32(4, 36 + samples, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	v.setUint32(16, 16, true);
	v.setUint16(20, 1, true); // PCM
	v.setUint16(22, 1, true); // mono
	v.setUint32(24, 8000, true);
	v.setUint32(28, 8000, true);
	v.setUint16(32, 1, true);
	v.setUint16(34, 8, true);
	ascii(36, "data");
	v.setUint32(40, samples, true);
	return bytes;
}

/** A short valid sound for the self-test. */
export const SHORT_WAV = silentWav(10);
/**
 * A raised doorbell. Long enough that C_Sound.IsPlaying still reports it a quarter second later,
 * for clients where even an empty file "plays" (build 70888).
 */
export const LONG_WAV = silentWav(1500);

export function signalName(n: number): string {
	return `${String(n).padStart(4, "0")}.wav`;
}

export function laneFolder(index: number): string {
	return `FamiliarSpike_U${String(index).padStart(3, "0")}`;
}
