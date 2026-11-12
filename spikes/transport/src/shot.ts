// Screenshot uplink, addon → companion. The addon draws a block of cells into the top-left
// corner, calls Screenshot() and hides the block again; the companion reads the file from the
// Screenshots folder. Shared with addon/FamiliarSpike/Shot.lua.
//
// The block is 258 × 34 cells of 4 physical pixels. Row 0 and column 0 alternate white and
// black (white first) so the reader can find the grid; the last row and column are black, a
// margin against the game behind it. The 256 × 32 cells in between carry one frame in one of
// these variants:
//   A  cells of 8 px, black or white            256 bytes
//   B  cells of 4 px, black or white            1 KB
//   C  cells of 4 px, 4 grey levels              2 KB
//   D  cells of 4 px, 8 grey levels              3 KB
//   E  cells of 4 px, one byte per colour        24 KB, lossless formats only
// WoW saves JPEG at quality 3 by default, so the coarse variants are the ones that must hold.

import type { Raster } from "./image.ts";
import { crc32 } from "./protocol.ts";

export const SHOT = {
	cols: 258,
	rows: 34,
	dataCols: 256,
	dataRows: 32,
	cellPx: 4,
} as const;

export interface Variant {
	name: string;
	id: number;
	/** Grid cells per side of one data cell. */
	cell: number;
	/** Bits per data cell; 24 means one byte per colour channel. */
	bits: number;
}

export const VARIANTS: Variant[] = [
	{ name: "A", id: 1, cell: 2, bits: 1 },
	{ name: "B", id: 2, cell: 1, bits: 1 },
	{ name: "C", id: 3, cell: 1, bits: 2 },
	{ name: "D", id: 4, cell: 1, bits: 3 },
	{ name: "E", id: 5, cell: 1, bits: 24 },
];

export const variantById = (id: number) => VARIANTS.find((v) => v.id === id);

/** Frame bytes a variant carries. */
export function capacity(v: Variant): number {
	return ((SHOT.dataCols / v.cell) * (SHOT.dataRows / v.cell) * v.bits) / 8;
}

/** Screenshot formats as the addon reports them. */
export const FORMATS = ["other", "jpeg", "png", "tga"];

/** Payload byte j (0-based) of a shot frame, as in Shot.lua. */
export function shotByte(seq: number, j: number): number {
	return (seq * 13 + j * 29 + Math.floor(j / 256) * 7) % 251;
}

export interface ShotHeader {
	variant: number;
	epoch: number;
	seq: number;
	format: number;
	/** Addon wall time in ms when it drew the block. */
	wallMs: number;
}

/**
 * Layout: "FSS", variant, epoch, seq (u16), format, wall ms (u48), payload length (u16),
 * payload, CRC-32 of everything before it. Little-endian; fills the variant's capacity.
 */
export function shotFrame(
	v: Variant,
	h: Omit<ShotHeader, "variant">,
): Uint8Array {
	const size = capacity(v);
	const bytes = new Uint8Array(size);
	const view = new DataView(bytes.buffer);
	bytes.set([0x46, 0x53, 0x53, v.id, h.epoch], 0);
	view.setUint16(5, h.seq, true);
	bytes[7] = h.format;
	view.setUint32(8, h.wallMs % 2 ** 32, true);
	view.setUint16(12, Math.floor(h.wallMs / 2 ** 32), true);
	view.setUint16(14, size - 20, true);
	for (let j = 0; j < size - 20; j++) bytes[16 + j] = shotByte(h.seq, j);
	view.setUint32(size - 4, crc32(bytes, 0, size - 4), true);
	return bytes;
}

function header(bytes: Uint8Array): ShotHeader | undefined {
	if (bytes[0] !== 0x46 || bytes[1] !== 0x53 || bytes[2] !== 0x53)
		return undefined;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return {
		variant: bytes[3] ?? 0,
		epoch: bytes[4] ?? 0,
		seq: view.getUint16(5, true),
		format: bytes[7] ?? 0,
		wallMs: view.getUint32(8, true) + view.getUint16(12, true) * 2 ** 32,
	};
}

/** Colour of every grid cell as the addon paints it: [r, g, b] in 0–255. For tests and the sim. */
export function paintCells(v: Variant, frame: Uint8Array): Uint8Array {
	const cells = new Uint8Array(SHOT.cols * SHOT.rows * 3);
	const set = (r: number, c: number, rgb: number[]) =>
		cells.set(rgb, (r * SHOT.cols + c) * 3);
	for (let c = 0; c < SHOT.cols; c++)
		set(0, c, c % 2 ? [0, 0, 0] : [255, 255, 255]);
	for (let r = 0; r < SHOT.rows; r++)
		set(r, 0, r % 2 ? [0, 0, 0] : [255, 255, 255]);
	const levels = 2 ** v.bits - 1;
	let bit = 0;
	const next = () => {
		let value = 0;
		for (let k = 0; k < v.bits; k++, bit++)
			value = value * 2 + (((frame[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1);
		return value;
	};
	for (let lr = 0; lr < SHOT.dataRows / v.cell; lr++)
		for (let lc = 0; lc < SHOT.dataCols / v.cell; lc++) {
			const value = next();
			const grey = Math.round((value / levels) * 255);
			const rgb =
				v.bits === 24
					? [(value >> 16) & 255, (value >> 8) & 255, value & 255]
					: [grey, grey, grey];
			for (let dy = 0; dy < v.cell; dy++)
				for (let dx = 0; dx < v.cell; dx++)
					set(1 + lr * v.cell + dy, 1 + lc * v.cell + dx, rgb);
		}
	return cells;
}

// Reading -------------------------------------------------------------------------

interface Grid {
	x0: number;
	y0: number;
	pitchX: number;
	pitchY: number;
}

export interface ShotRead {
	/** Whether the alternating row and column of the block were found. */
	found: boolean;
	grid?: Grid;
	black?: number;
	white?: number;
	/** The decoded frame's header, if a variant's header and checksum matched. */
	frame?: ShotHeader;
	ok: boolean;
	variant?: string;
	/** For a frame whose header read but whose checksum failed: wrong bits in the frame. */
	bitErrors?: number;
	bits?: number;
}

const luma = (image: Raster, x: number, y: number): number => {
	const i = (y * image.width + x) * 3;
	return (
		((image.rgb[i] ?? 0) * 299 +
			(image.rgb[i + 1] ?? 0) * 587 +
			(image.rgb[i + 2] ?? 0) * 114) /
		1000
	);
};

/** Mean colour of the middle half of a cell, or undefined outside the image. */
function cellColour(
	image: Raster,
	grid: Grid,
	r: number,
	c: number,
): [number, number, number, number] | undefined {
	const x1 = Math.round(grid.x0 + (c + 0.25) * grid.pitchX);
	const x2 = Math.max(x1 + 1, Math.round(grid.x0 + (c + 0.75) * grid.pitchX));
	const y1 = Math.round(grid.y0 + (r + 0.25) * grid.pitchY);
	const y2 = Math.max(y1 + 1, Math.round(grid.y0 + (r + 0.75) * grid.pitchY));
	if (x1 < 0 || y1 < 0 || x2 > image.width || y2 > image.rows) return undefined;
	let red = 0;
	let green = 0;
	let blue = 0;
	let n = 0;
	for (let y = y1; y < y2; y++)
		for (let x = x1; x < x2; x++) {
			const i = (y * image.width + x) * 3;
			red += image.rgb[i] ?? 0;
			green += image.rgb[i + 1] ?? 0;
			blue += image.rgb[i + 2] ?? 0;
			n++;
		}
	red /= n;
	green /= n;
	blue /= n;
	return [red, green, blue, (red * 299 + green * 587 + blue * 114) / 1000];
}

/** Share of sync cells (row 0 and column 0) with the expected brightness. */
function syncScore(image: Raster, grid: Grid, threshold: number): number {
	let good = 0;
	let total = 0;
	const check = (r: number, c: number, white: boolean) => {
		const colour = cellColour(image, grid, r, c);
		total++;
		if (colour && colour[3] > threshold === white) good++;
	};
	for (let c = 0; c < SHOT.cols - 1; c++) check(0, c, c % 2 === 0);
	for (let r = 1; r < SHOT.rows - 1; r++) check(r, 0, r % 2 === 0);
	return good / total;
}

/**
 * Finds the block's grid: first where the addon put it (top-left, 4 px cells), then by search,
 * in case the screen scale made the cells a little larger or smaller.
 */
function locate(image: Raster): Grid | undefined {
	let low = 255;
	let high = 0;
	for (let x = 0; x < Math.min(image.width, 1100); x++) {
		const value = luma(image, x, Math.min(2, image.rows - 1));
		low = Math.min(low, value);
		high = Math.max(high, value);
	}
	if (high - low < 64) return undefined;
	const threshold = (low + high) / 2;
	const nominal = { x0: 0, y0: 0, pitchX: SHOT.cellPx, pitchY: SHOT.cellPx };
	if (syncScore(image, nominal, threshold) >= 0.97) return nominal;
	let best: Grid | undefined;
	let bestScore = 0;
	for (let pitch = 3; pitch <= 6; pitch += 0.01)
		for (let offset = -2; offset <= 2; offset += 0.5) {
			const grid = { x0: offset, y0: offset, pitchX: pitch, pitchY: pitch };
			const score = syncScore(image, grid, threshold);
			if (score > bestScore) [best, bestScore] = [grid, score];
		}
	return bestScore >= 0.9 ? best : undefined;
}

/** One-dimensional k-means for the grey levels, seeded evenly between black and white. */
function levelsOf(
	values: number[],
	count: number,
	black: number,
	white: number,
): number[] {
	let centres = Array.from(
		{ length: count },
		(_, k) => black + ((white - black) * k) / (count - 1),
	);
	for (let round = 0; round < 8; round++) {
		const sums = new Array<number>(count).fill(0);
		const ns = new Array<number>(count).fill(0);
		for (const value of values) {
			const k = nearest(centres, value);
			sums[k] = (sums[k] ?? 0) + value;
			ns[k] = (ns[k] ?? 0) + 1;
		}
		centres = centres.map((c, k) =>
			(ns[k] ?? 0) > 0 ? (sums[k] ?? 0) / (ns[k] ?? 1) : c,
		);
	}
	return centres;
}

function nearest(centres: number[], value: number): number {
	let best = 0;
	for (let k = 1; k < centres.length; k++)
		if (
			Math.abs(value - (centres[k] ?? 0)) <
			Math.abs(value - (centres[best] ?? 0))
		)
			best = k;
	return best;
}

function bitErrors(a: Uint8Array, b: Uint8Array): number {
	let errors = 0;
	for (let i = 0; i < a.length; i++) {
		let x = (a[i] ?? 0) ^ (b[i] ?? 0);
		while (x) {
			errors += x & 1;
			x >>= 1;
		}
	}
	return errors;
}

/** Reads the block from a screenshot and tries every variant. */
export function readShot(image: Raster): ShotRead {
	const grid = locate(image);
	if (!grid) return { found: false, ok: false };
	const colours: ([number, number, number, number] | undefined)[] = [];
	for (let r = 0; r < SHOT.rows; r++)
		for (let c = 0; c < SHOT.cols; c++)
			colours.push(cellColour(image, grid, r, c));
	const at = (r: number, c: number) => colours[r * SHOT.cols + c];
	const whites: number[] = [];
	const blacks: number[] = [];
	for (let c = 1; c < SHOT.cols - 1; c++)
		(c % 2 ? blacks : whites).push(at(0, c)?.[3] ?? 0);
	const mean = (list: number[]) =>
		list.reduce((a, b) => a + b, 0) / list.length;
	const black = mean(blacks);
	const white = mean(whites);
	let best: ShotRead = { found: true, grid, black, white, ok: false };
	for (const v of VARIANTS) {
		const cols = SHOT.dataCols / v.cell;
		const rows = SHOT.dataRows / v.cell;
		const values: number[][] = [];
		for (let lr = 0; lr < rows; lr++)
			for (let lc = 0; lc < cols; lc++) {
				const sum = [0, 0, 0, 0];
				for (let dy = 0; dy < v.cell; dy++)
					for (let dx = 0; dx < v.cell; dx++) {
						const colour = at(1 + lr * v.cell + dy, 1 + lc * v.cell + dx) ?? [
							0, 0, 0, 0,
						];
						for (let k = 0; k < 4; k++)
							sum[k] = (sum[k] ?? 0) + (colour[k] ?? 0);
					}
				values.push(sum.map((s) => s / (v.cell * v.cell)));
			}
		const bytes = new Uint8Array(capacity(v));
		let bit = 0;
		const push = (value: number, width: number) => {
			for (let k = width - 1; k >= 0; k--, bit++)
				if ((value >> k) & 1)
					bytes[bit >> 3] = (bytes[bit >> 3] ?? 0) | (0x80 >> (bit & 7));
		};
		if (v.bits === 24)
			for (const [r = 0, g = 0, b = 0] of values)
				for (const channel of [r, g, b])
					push(Math.max(0, Math.min(255, Math.round(channel))), 8);
		else {
			const lumas = values.map((value) => value[3] ?? 0);
			const centres =
				v.bits === 1
					? [black, white]
					: levelsOf(lumas, 2 ** v.bits, black, white).sort((a, b) => a - b);
			for (const value of lumas) push(nearest(centres, value), v.bits);
		}
		const head = header(bytes);
		if (!head || head.variant !== v.id) continue;
		const view = new DataView(bytes.buffer);
		if (
			crc32(bytes, 0, bytes.length - 4) ===
			view.getUint32(bytes.length - 4, true)
		)
			return {
				found: true,
				grid,
				black,
				white,
				frame: head,
				ok: true,
				variant: v.name,
			};
		const expected = shotFrame(v, head);
		const errors = bitErrors(bytes, expected);
		if (best.bitErrors === undefined || errors < best.bitErrors)
			best = {
				found: true,
				grid,
				black,
				white,
				frame: head,
				ok: false,
				variant: v.name,
				bitErrors: errors,
				bits: bytes.length * 8,
			};
	}
	return best;
}
