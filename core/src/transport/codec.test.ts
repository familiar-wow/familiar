import { describe, expect, test } from "bun:test";
import {
	crc16,
	crc32,
	DOWN_PAYLOAD,
	decodeFrame,
	decodePacket,
	decodeUp,
	encodeFrame,
	encodePacket,
	encodeUp,
	FRAME_BYTES,
	packets,
	upLength,
} from "./codec.ts";

const text = (s: string) => new TextEncoder().encode(s);

test("checksums match the published check values", () => {
	expect(crc32(text("123456789"))).toBe(0xcbf43926);
	expect(crc16(text("123456789"))).toBe(0x29b1);
});

describe("lane frames", () => {
	test("round trip, rest state and a flipped bit", () => {
		const frame = { first: true, seq: 5, chunk: text("hello") };
		const bytes = encodeFrame(frame);
		expect(bytes.length).toBe(FRAME_BYTES);
		expect(decodeFrame(bytes)).toEqual({
			first: true,
			seq: 5,
			chunk: Uint8Array.from([...text("hello"), ...new Uint8Array(24)]),
		});
		expect(decodeFrame(new Uint8Array(FRAME_BYTES))).toBe("rest");
		bytes[3] = (bytes[3] ?? 0) ^ 1;
		expect(decodeFrame(bytes)).toBeUndefined();
	});
});

describe("messages up", () => {
	const message = {
		hello: true,
		key: 0xdeadbeef,
		id: 65535,
		ack: 600,
		bell: 7,
		font: 256,
		body: text("Hallo Familiar äöü"),
	};

	test("round trip", () => {
		const bytes = encodeUp(message);
		expect(upLength(bytes)).toBe(bytes.length);
		expect(decodeUp(bytes)).toEqual(message);
	});

	test("cut short or changed, nothing comes out", () => {
		const bytes = encodeUp(message);
		expect(decodeUp(bytes.subarray(0, -1))).toBeUndefined();
		bytes[20] = (bytes[20] ?? 0) ^ 0x10;
		expect(decodeUp(bytes)).toBeUndefined();
	});
});

describe("packets down", () => {
	test("a long message fills consecutive fonts", () => {
		const payload = text("x".repeat(2000));
		const list = packets(payload, 42, 3, 10, true);
		expect(list.map((p) => [p.slot, p.part, p.parts])).toEqual([
			[10, 0, 5],
			[11, 1, 5],
			[12, 2, 5],
			[13, 3, 5],
			[14, 4, 5],
		]);
		expect(list.at(-1)?.payload.length).toBe(2000 - 4 * DOWN_PAYLOAD);
		const back = list.map((p) => decodePacket(encodePacket(p)));
		expect(back).toEqual(
			list.map((p) => ({ ...p, payload: p.payload.slice() })),
		);
	});

	test("an empty message still takes a font, a damaged packet is rejected", () => {
		const list = packets(new Uint8Array(0), 1, 1, 1);
		expect(list.map((p) => p.parts)).toEqual([1]);
		const bytes = encodePacket(list[0] as (typeof list)[0]);
		bytes[100] = 1;
		expect(decodePacket(bytes)).toBeUndefined();
		expect(decodePacket(new Uint8Array(512))).toBeUndefined();
	});
});
