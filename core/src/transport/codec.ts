// Wire formats shared with the addon (addon/Familiar/Codec.lua, Lane.lua, Transport.lua).
// Why the transport works this way: docs/adr/0005-transport-addons-txt-lane-and-font-bank.md.
// All numbers are little-endian.
//
// Up, addon to app: a message goes out as lane frames, one per AddOns.txt save.
//   frame    head byte (bit 7: first frame of a message, bits 6-0: sequence), 29 bytes of the
//            message, CRC-16 of the 30 bytes before it. All helpers off is the rest state.
//   message  "FU", version, flags (bit 0: hello), session key (u32), id (u16), ack doorbell
//            (u16), next message doorbell (u16), next font (u16), body length (u16), body,
//            CRC-32 of everything before it.
// The app confirms a message by raising the ack doorbell it names. The addon sends it again
// when no confirmation comes. A hello names the last ack doorbell the addon used, and the app
// answers it with a welcome instead.
//
// Down, app to addon: a message goes into the font bank, one packet of 512 bytes per font,
// then the app raises the next message doorbell.
//   packet   "FD", version, flags (bit 0: welcome), session key (u32), message doorbell (u16),
//            font slot (u16), part (u8), parts (u8), payload length (u16), payload, zero fill,
//            CRC-32 of the first 508 bytes.
// The session key is random per game start and account. Doorbells can be left raised from an
// earlier game, fonts carry the key: only a welcome with its own key tells the addon that the
// app is there.

export const VERSION = 1;
export const HELPERS = 256;
export const FRAME_BYTES = HELPERS / 8;
export const CHUNK_BYTES = FRAME_BYTES - 3;
export const UP_HEADER = 18;
export const PACKET_BYTES = 512;
export const DOWN_HEADER = 16;
export const DOWN_PAYLOAD = PACKET_BYTES - DOWN_HEADER - 4;

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, i) => {
	let c = i;
	for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
	return c >>> 0;
});

/** CRC-32 (IEEE). */
export function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const b of bytes)
		crc = (crc >>> 8) ^ (CRC32_TABLE[(crc ^ b) & 0xff] ?? 0);
	return (crc ^ 0xffffffff) >>> 0;
}

/** CRC-16/CCITT-FALSE. */
export function crc16(bytes: Uint8Array): number {
	let crc = 0xffff;
	for (const b of bytes) {
		crc ^= b << 8;
		for (let k = 0; k < 8; k++)
			crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
	}
	return crc;
}

const view = (bytes: Uint8Array) =>
	new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

// Lane frames ------------------------------------------------------------------------

export interface Frame {
	first: boolean;
	seq: number;
	chunk: Uint8Array;
}

export function encodeFrame(frame: Frame): Uint8Array {
	if (frame.chunk.length > CHUNK_BYTES) throw new Error("chunk too long");
	const bytes = new Uint8Array(FRAME_BYTES);
	bytes[0] = (frame.first ? 0x80 : 0) | (frame.seq & 0x7f);
	bytes.set(frame.chunk, 1);
	view(bytes).setUint16(FRAME_BYTES - 2, crc16(bytes.subarray(0, -2)), true);
	return bytes;
}

/** "rest" when every helper is off, undefined when the bits hold no valid frame. */
export function decodeFrame(bits: Uint8Array): Frame | "rest" | undefined {
	if (bits.length !== FRAME_BYTES) return undefined;
	if (bits.every((b) => b === 0)) return "rest";
	if (
		crc16(bits.subarray(0, -2)) !== view(bits).getUint16(FRAME_BYTES - 2, true)
	)
		return undefined;
	const head = bits[0] ?? 0;
	return {
		first: (head & 0x80) !== 0,
		seq: head & 0x7f,
		chunk: bits.slice(1, -2),
	};
}

// Messages up --------------------------------------------------------------------------

export interface UpMessage {
	hello: boolean;
	key: number;
	id: number;
	/** The ack doorbell the app raises once it has the message. */
	ack: number;
	/** Where the addon reads next: message doorbell and font slot. */
	bell: number;
	font: number;
	body: Uint8Array;
}

export function encodeUp(m: UpMessage): Uint8Array {
	const bytes = new Uint8Array(UP_HEADER + m.body.length + 4);
	const v = view(bytes);
	bytes.set([0x46, 0x55, VERSION, m.hello ? 1 : 0]);
	v.setUint32(4, m.key, true);
	v.setUint16(8, m.id, true);
	v.setUint16(10, m.ack, true);
	v.setUint16(12, m.bell, true);
	v.setUint16(14, m.font, true);
	v.setUint16(16, m.body.length, true);
	bytes.set(m.body, UP_HEADER);
	v.setUint32(bytes.length - 4, crc32(bytes.subarray(0, -4)), true);
	return bytes;
}

/** The whole message's length, once the header is in; undefined if this starts no message. */
export function upLength(bytes: Uint8Array): number | undefined {
	if (bytes.length < UP_HEADER || bytes[0] !== 0x46 || bytes[1] !== 0x55)
		return undefined;
	return UP_HEADER + view(bytes).getUint16(16, true) + 4;
}

export function decodeUp(bytes: Uint8Array): UpMessage | undefined {
	const length = upLength(bytes);
	if (length === undefined || bytes.length < length || bytes[2] !== VERSION)
		return undefined;
	const v = view(bytes);
	if (crc32(bytes.subarray(0, length - 4)) !== v.getUint32(length - 4, true))
		return undefined;
	return {
		hello: ((bytes[3] ?? 0) & 1) === 1,
		key: v.getUint32(4, true),
		id: v.getUint16(8, true),
		ack: v.getUint16(10, true),
		bell: v.getUint16(12, true),
		font: v.getUint16(14, true),
		body: bytes.slice(UP_HEADER, length - 4),
	};
}

// Packets down -------------------------------------------------------------------------

export interface Packet {
	/** The answer to a hello. */
	welcome: boolean;
	key: number;
	bell: number;
	slot: number;
	part: number;
	parts: number;
	payload: Uint8Array;
}

export function encodePacket(p: Packet): Uint8Array {
	if (p.payload.length > DOWN_PAYLOAD) throw new Error("payload too long");
	const bytes = new Uint8Array(PACKET_BYTES);
	const v = view(bytes);
	bytes.set([0x46, 0x44, VERSION, p.welcome ? 1 : 0]);
	v.setUint32(4, p.key, true);
	v.setUint16(8, p.bell, true);
	v.setUint16(10, p.slot, true);
	bytes[12] = p.part;
	bytes[13] = p.parts;
	v.setUint16(14, p.payload.length, true);
	bytes.set(p.payload, DOWN_HEADER);
	v.setUint32(PACKET_BYTES - 4, crc32(bytes.subarray(0, -4)), true);
	return bytes;
}

export function decodePacket(bytes: Uint8Array): Packet | undefined {
	if (bytes.length !== PACKET_BYTES || bytes[0] !== 0x46 || bytes[1] !== 0x44)
		return undefined;
	const v = view(bytes);
	if (
		bytes[2] !== VERSION ||
		crc32(bytes.subarray(0, -4)) !== v.getUint32(PACKET_BYTES - 4, true)
	)
		return undefined;
	const length = v.getUint16(14, true);
	if (length > DOWN_PAYLOAD) return undefined;
	return {
		welcome: ((bytes[3] ?? 0) & 1) === 1,
		key: v.getUint32(4, true),
		bell: v.getUint16(8, true),
		slot: v.getUint16(10, true),
		part: bytes[12] ?? 0,
		parts: bytes[13] ?? 0,
		payload: bytes.slice(DOWN_HEADER, DOWN_HEADER + length),
	};
}

/** A message cut into packets for the fonts from `slot` on. */
export function packets(
	payload: Uint8Array,
	key: number,
	bell: number,
	slot: number,
	welcome = false,
): Packet[] {
	const parts = Math.max(1, Math.ceil(payload.length / DOWN_PAYLOAD));
	if (parts > 255) throw new Error("message too long for the font bank");
	return Array.from({ length: parts }, (_, part) => ({
		welcome,
		key,
		bell,
		slot: slot + part,
		part,
		parts,
		payload: payload.subarray(part * DOWN_PAYLOAD, (part + 1) * DOWN_PAYLOAD),
	}));
}
