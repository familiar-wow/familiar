// Just enough image handling for the screenshot channel: PNG and TGA are decoded here, JPEG
// through Bun.Image (libjpeg-turbo) and then as PNG. Only the top rows matter, where the addon
// draws its block, so decoding can stop early. PNG encoding is for the crops in the report data.
import { deflateSync, inflateSync } from "node:zlib";
import { crc32 } from "./protocol.ts";

/** RGB, 3 bytes per pixel, rows top-down. `rows` may be fewer than the image height. */
export interface Raster {
	width: number;
	height: number;
	rows: number;
	rgb: Uint8Array;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function u32be(bytes: Uint8Array, at: number): number {
	return (
		(((bytes[at] ?? 0) << 24) |
			((bytes[at + 1] ?? 0) << 16) |
			((bytes[at + 2] ?? 0) << 8) |
			(bytes[at + 3] ?? 0)) >>>
		0
	);
}

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** 8-bit grey, grey+alpha, RGB or RGBA, not interlaced. */
export function decodePng(bytes: Uint8Array, maxRows = Infinity): Raster {
	if (PNG_SIGNATURE.some((value, i) => bytes[i] !== value))
		throw new Error("not a PNG");
	let width = 0;
	let height = 0;
	let channels = 0;
	const idat: Uint8Array[] = [];
	for (let at = 8; at + 8 <= bytes.length; ) {
		const length = u32be(bytes, at);
		const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
		const data = bytes.subarray(at + 8, at + 8 + length);
		if (type === "IHDR") {
			width = u32be(data, 0);
			height = u32be(data, 4);
			const [depth, color, , , interlace] = data.subarray(8, 13);
			channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[color ?? -1] ?? 0;
			if (depth !== 8 || channels === 0 || interlace !== 0)
				throw new Error(`unsupported PNG (depth ${depth}, colour ${color})`);
		} else if (type === "IDAT") idat.push(data);
		else if (type === "IEND") break;
		at += 12 + length;
	}
	const raw = inflateSync(Buffer.concat(idat));
	const rows = Math.min(height, maxRows);
	const stride = width * channels;
	const rgb = new Uint8Array(width * rows * 3);
	let previous = new Uint8Array(stride);
	let current = new Uint8Array(stride);
	for (let y = 0; y < rows; y++) {
		const at = y * (stride + 1);
		const filter = raw[at];
		for (let x = 0; x < stride; x++) {
			const value = raw[at + 1 + x] ?? 0;
			const left = x >= channels ? (current[x - channels] ?? 0) : 0;
			const up = previous[x] ?? 0;
			const upLeft = x >= channels ? (previous[x - channels] ?? 0) : 0;
			current[x] =
				filter === 1
					? value + left
					: filter === 2
						? value + up
						: filter === 3
							? value + ((left + up) >> 1)
							: filter === 4
								? value + paeth(left, up, upLeft)
								: value;
		}
		for (let x = 0; x < width; x++) {
			const from = x * channels;
			const to = (y * width + x) * 3;
			const grey = channels < 3;
			rgb[to] = current[from] ?? 0;
			rgb[to + 1] = current[grey ? from : from + 1] ?? 0;
			rgb[to + 2] = current[grey ? from : from + 2] ?? 0;
		}
		[previous, current] = [current, previous];
	}
	return { width, height, rows, rgb };
}

/** Uncompressed or run-length true-colour TGA, 24 or 32 bits. */
export function decodeTga(bytes: Uint8Array, maxRows = Infinity): Raster {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const type = bytes[2];
	const width = view.getUint16(12, true);
	const height = view.getUint16(14, true);
	const depth = bytes[16] ?? 0;
	const topDown = ((bytes[17] ?? 0) & 0x20) !== 0;
	if ((type !== 2 && type !== 10) || (depth !== 24 && depth !== 32))
		throw new Error(`unsupported TGA (type ${type}, ${depth} bits)`);
	const size = depth / 8;
	const pixels = new Uint8Array(width * height * 3);
	let at = 18 + (bytes[0] ?? 0);
	const put = (n: number) => {
		pixels[n * 3] = bytes[at + 2] ?? 0;
		pixels[n * 3 + 1] = bytes[at + 1] ?? 0;
		pixels[n * 3 + 2] = bytes[at] ?? 0;
	};
	for (let n = 0; n < width * height; ) {
		if (type === 2) {
			put(n++);
			at += size;
			continue;
		}
		const header = bytes[at++] ?? 0;
		const count = (header & 0x7f) + 1;
		if (header & 0x80) {
			for (let k = 0; k < count; k++) put(n++);
			at += size;
		} else
			for (let k = 0; k < count; k++) {
				put(n++);
				at += size;
			}
	}
	const rows = Math.min(height, maxRows);
	const rgb = new Uint8Array(width * rows * 3);
	for (let y = 0; y < rows; y++) {
		const source = topDown ? y : height - 1 - y;
		rgb.set(
			pixels.subarray(source * width * 3, (source + 1) * width * 3),
			y * width * 3,
		);
	}
	return { width, height, rows, rgb };
}

/** Decodes a screenshot by its file extension. */
export async function readImage(
	bytes: Uint8Array,
	extension: string,
	maxRows = Infinity,
): Promise<Raster> {
	const kind = extension.toLowerCase();
	if (kind === "tga") return decodeTga(bytes, maxRows);
	if (kind === "png")
		try {
			return decodePng(bytes, maxRows);
		} catch {
			// Interlaced or another variant: let libspng normalise it.
		}
	const png = await new Bun.Image(bytes).png({ compressionLevel: 0 }).bytes();
	return decodePng(png, maxRows);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set(new TextEncoder().encode(type), 4);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
	return out;
}

/** RGB PNG of the top-left width × height pixels. */
export function encodePng(
	image: Raster,
	width = image.width,
	height = image.rows,
): Uint8Array {
	const w = Math.min(width, image.width);
	const h = Math.min(height, image.rows);
	const raw = new Uint8Array(h * (w * 3 + 1));
	for (let y = 0; y < h; y++)
		raw.set(
			image.rgb.subarray(y * image.width * 3, (y * image.width + w) * 3),
			y * (w * 3 + 1) + 1,
		);
	const header = new Uint8Array(13);
	const view = new DataView(header.buffer);
	view.setUint32(0, w);
	view.setUint32(4, h);
	header.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([
		Uint8Array.from(PNG_SIGNATURE),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", new Uint8Array()),
	]);
}
