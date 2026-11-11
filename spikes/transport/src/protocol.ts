// Wire format shared with addon/FamiliarSpike/Wire.lua and Probe.lua.

export const LANE_BITS = 256;
export const FRAME_BYTES = 32;
export const PAYLOAD_BYTES = 20;
export const SIGNALS = 600;
export const SLOTS = 64;

export const Kind = { Data: 1, Control: 3 } as const;

export type Lane = "U" | "D";

export interface Frame {
	kind: number;
	epoch: number;
	seq: number;
	flags: number;
	payload: Uint8Array;
}

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

export function encodeFrame(frame: Frame): Uint8Array {
	if (frame.payload.length > PAYLOAD_BYTES)
		throw new Error("payload too large");
	const bytes = new Uint8Array(FRAME_BYTES);
	const view = new DataView(bytes.buffer);
	bytes.set([0x46, 0x53, frame.kind, frame.epoch], 0);
	view.setUint16(4, frame.seq, true);
	bytes[6] = frame.payload.length;
	bytes[7] = frame.flags;
	bytes.set(frame.payload, 8);
	view.setUint32(28, crc32(bytes, 0, 28), true);
	return bytes;
}

export function decodeFrame(bytes: Uint8Array): Frame | undefined {
	if (bytes.length !== FRAME_BYTES || bytes[0] !== 0x46 || bytes[1] !== 0x53)
		return undefined;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (crc32(bytes, 0, 28) !== view.getUint32(28, true)) return undefined;
	const length = bytes[6] ?? 0;
	if (length > PAYLOAD_BYTES) return undefined;
	return {
		kind: bytes[2] ?? 0,
		epoch: bytes[3] ?? 0,
		seq: view.getUint16(4, true),
		flags: bytes[7] ?? 0,
		payload: bytes.slice(8, 8 + length),
	};
}

const LANE_LINE =
	/^FamiliarSpike_([UD])(\d{3}):[ \t]*(enabled|disabled)[ \t]*(\r?)$/gm;

export interface LaneRead {
	/** The lane as a frame. A missing row counts as disabled, the helpers' default state. */
	bytes: Uint8Array;
	/** How many of the 256 rows the file holds. */
	rows: number;
	/** How many of them are enabled. */
	on: number;
	duplicate: boolean;
}

export function readLane(text: string, lane: Lane): LaneRead {
	const bytes = new Uint8Array(FRAME_BYTES);
	const seen = new Set<number>();
	let on = 0;
	let duplicate = false;
	for (const match of text.matchAll(LANE_LINE)) {
		if (match[1] !== lane) continue;
		const index = Number(match[2]);
		if (seen.has(index)) duplicate = true;
		seen.add(index);
		if (match[3] === "enabled") {
			on++;
			const at = index >> 3;
			bytes[at] = (bytes[at] ?? 0) | (1 << (index & 7));
		}
	}
	return { bytes, rows: seen.size, on, duplicate };
}

function laneRow(lane: Lane, index: number, frame: Uint8Array): string {
	const on = ((frame[index >> 3] ?? 0) >> (index & 7)) & 1;
	return `FamiliarSpike_${lane}${String(index).padStart(3, "0")}: ${on ? "enabled" : "disabled"}`;
}

/**
 * Sets the rows of one lane: existing rows are rewritten in place, missing ones are appended
 * in the file's own line ending. Proves that no other row changed.
 */
export function writeLane(text: string, lane: Lane, frame: Uint8Array): string {
	const present = new Set<number>();
	let result = text.replace(
		LANE_LINE,
		(row, letter: string, digits: string, _state: string, cr: string) => {
			if (letter !== lane) return row;
			const index = Number(digits);
			present.add(index);
			return `${laneRow(lane, index, frame)}${cr}`;
		},
	);
	const missing: string[] = [];
	for (let i = 0; i < LANE_BITS; i++)
		if (!present.has(i)) missing.push(laneRow(lane, i, frame));
	if (missing.length > 0) {
		const eol = text.includes("\r\n") ? "\r\n" : "\n";
		if (result.length > 0 && !result.endsWith("\n")) result += eol;
		result += missing.join(eol) + eol;
	}
	if (foreignLines(result).join("\n") !== foreignLines(text).join("\n"))
		throw new Error("lane rewrite touched foreign rows");
	return result;
}

/** All rows that do not belong to the spike, for the integrity check. */
export function foreignLines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.filter((line) => line.trim() !== "" && !line.startsWith("FamiliarSpike"));
}

/** Byte j (1-based) of an uplink test frame, as in Probe.lua testBytes(). */
export function uplinkByte(stream: number, index: number, j: number): number {
	return (stream * 31 + index * 7 + j * 13) % 251;
}

/** A lane D frame: a counter and the companion's wall time in ms, both little-endian. */
export function laneDFrame(
	epoch: number,
	counter: number,
	wallMs: number,
): Uint8Array {
	const payload = new Uint8Array(10);
	const view = new DataView(payload.buffer);
	view.setUint32(0, counter >>> 0, true);
	view.setUint32(4, wallMs % 2 ** 32, true);
	view.setUint16(8, Math.floor(wallMs / 2 ** 32), true);
	return encodeFrame({
		kind: Kind.Data,
		epoch,
		seq: counter % 65536,
		flags: 0,
		payload,
	});
}

const ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export interface SlotContent {
	slot: number;
	/** The companion's refresh round; 0 is the install-time placeholder. */
	refresh: number;
	/** Companion wall time in ms when it wrote the file. */
	written: number;
	/** How often the companion rewrites this slot, in ms. */
	every: number;
	size: number;
}

/** data.lua for a load-on-demand slot. The alphabet needs no escaping in a Lua string. */
export function slotSource(content: SlotContent): string {
	const { slot, refresh, written, every, size } = content;
	const chars = new Array<string>(size);
	for (let i = 1; i <= size; i++)
		chars[i - 1] = ALPHABET[(refresh + i * 7) % 64] ?? "A";
	return `FamiliarSpike_SlotData = { slot = ${slot}, refresh = ${refresh}, written = ${written}, every = ${every}, size = ${size}, data = "${chars.join("")}" }\n`;
}

export function placeholderSource(slot: number): string {
	return slotSource({ slot, refresh: 0, written: 0, every: 0, size: 0 });
}

/** Bytes per slot: 1-6 are the benchmark sizes, the rest serve the soak. */
export function slotSize(slot: number): number {
	return [2048, 2048, 2048, 16384, 131072, 1048576][slot - 1] ?? 2048;
}

/** Mono 8-bit silence. */
export function silentWav(ms: number): Uint8Array {
	const samples = Math.round(8 * ms);
	const bytes = new Uint8Array(44 + samples).fill(0x80);
	const view = new DataView(bytes.buffer);
	const ascii = (at: number, text: string) => {
		for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
	};
	ascii(0, "RIFF");
	view.setUint32(4, 36 + samples, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, 8000, true);
	view.setUint32(28, 8000, true);
	view.setUint16(32, 1, true);
	view.setUint16(34, 8, true);
	ascii(36, "data");
	view.setUint32(40, samples, true);
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

export function slotFolder(k: number): string {
	return `FamiliarSpike_L${String(k).padStart(2, "0")}`;
}

export function laneFolder(lane: Lane, index: number): string {
	return `FamiliarSpike_${lane}${String(index).padStart(3, "0")}`;
}
