// Wire format shared with addon/FamiliarSpike/Wire.lua and Probe.lua.

export const LANE_BITS = 256;
export const FRAME_BYTES = 32;
export const PAYLOAD_BYTES = 20;
export const SIGNALS = 600;
export const SLOTS = 64;
export const MAX_SLOT_BYTES = 2 * 1024 * 1024;

export const Kind = { Data: 1, Ack: 2, Control: 3 } as const;
export const LAST = 2;

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

/** Reads a lane from AddOns.txt. Undefined while the client has not written all 256 rows. */
export function readLane(text: string, lane: Lane): Uint8Array | undefined {
	const bytes = new Uint8Array(FRAME_BYTES);
	const seen = new Set<number>();
	for (const match of text.matchAll(LANE_LINE)) {
		if (match[1] !== lane) continue;
		const index = Number(match[2]);
		if (seen.has(index)) return undefined;
		seen.add(index);
		if (match[3] === "enabled") {
			const at = index >> 3;
			bytes[at] = (bytes[at] ?? 0) | (1 << (index & 7));
		}
	}
	return seen.size === LANE_BITS ? bytes : undefined;
}

/** Rewrites only the rows of one lane and proves that nothing else changed. */
export function writeLane(text: string, lane: Lane, frame: Uint8Array): string {
	let rows = 0;
	const result = text.replace(
		LANE_LINE,
		(row, letter: string, digits: string, _state: string, cr: string) => {
			if (letter !== lane) return row;
			rows++;
			const index = Number(digits);
			const on = ((frame[index >> 3] ?? 0) >> (index & 7)) & 1;
			return `FamiliarSpike_${letter}${digits}: ${on ? "enabled" : "disabled"}${cr}`;
		},
	);
	if (rows !== LANE_BITS)
		throw new Error(`lane ${lane} has ${rows} rows, expected ${LANE_BITS}`);
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

/** The downlink test message, as in Probe.lua downlinkBytes(). */
export function downlinkBytes(nonce: number, count: number): Uint8Array {
	const seed = nonce % 251;
	return Uint8Array.from(
		{ length: count },
		(_, i) => (seed + (i + 1) * 17) % 256,
	);
}

export function downlinkFrames(
	epoch: number,
	nonce: number,
	count: number,
): Uint8Array[] {
	const data = downlinkBytes(nonce, count);
	const frames: Uint8Array[] = [];
	for (
		let offset = 0, seq = 1;
		offset < data.length;
		offset += PAYLOAD_BYTES, seq++
	) {
		const payload = data.slice(offset, offset + PAYLOAD_BYTES);
		const last = offset + PAYLOAD_BYTES >= data.length;
		frames.push(
			encodeFrame({
				kind: Kind.Data,
				epoch,
				seq,
				flags: last ? LAST : 0,
				payload,
			}),
		);
	}
	return frames;
}

const ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** data.lua for a load-on-demand slot. The alphabet needs no escaping in a Lua string. */
export function slotSource(slot: number, nonce: number, size: number): string {
	const chars = new Array<string>(size);
	for (let i = 1; i <= size; i++)
		chars[i - 1] = ALPHABET[(nonce + i * 7) % 64] ?? "A";
	return `FamiliarSpike_SlotData = { slot = ${slot}, nonce = ${nonce}, size = ${size}, data = "${chars.join("")}" }\n`;
}

export function placeholderSource(slot: number): string {
	return `FamiliarSpike_SlotData = { slot = ${slot}, nonce = 0, size = 0, data = "" }\n`;
}

/** 50 ms of 8-bit silence. PlaySoundFile reports it as playable; an empty file is not. */
export const SILENT_WAV: Uint8Array = (() => {
	const samples = 400;
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
})();

export function signalName(n: number): string {
	return `${String(n).padStart(4, "0")}.wav`;
}

export function slotFolder(k: number): string {
	return `FamiliarSpike_L${String(k).padStart(2, "0")}`;
}

export function laneFolder(lane: Lane, index: number): string {
	return `FamiliarSpike_${lane}${String(index).padStart(3, "0")}`;
}
