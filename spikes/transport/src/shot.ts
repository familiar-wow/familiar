// Screenshot uplink, addon → companion. The addon paints a message as a block of cells where
// the player typed, shows it for one or two frames around Screenshot() and hides it; the
// companion finds the block anywhere in the picture. Shared with addon/FamiliarSpike/Shot.lua.
//
// Layout: C × R cells, both odd, plus a quiet zone of two dark cells around them. The outer
// ring alternates on and off (corners on), so the reader can find the block and its grid. The
// cells inside carry the message bits, row by row, most significant bit first. Cells are 4
// physical pixels (2 in the "small" style). "On" is white, or a dark grey in the "muted" style;
// "off" is black. Black and white only: 0.4.1 showed that the client's picture settings bend
// colours, and two levels survive that best.

import type { Raster } from "./image.ts";
import { decodeMessage, type Message } from "./protocol.ts";

/** The grey an "on" cell has in the muted style. */
export const MUTED_LEVEL = 0.3;
/** Dark cells around the ring: wider than a cell, so the ring's alternation ends there. */
export const QUIET = 2;

export interface Layout {
	cols: number;
	rows: number;
	/** Data cells inside the ring. */
	capacityBits: number;
}

/** About four times as wide as high, both sides odd. As in Shot.lua. */
export function layout(bytes: number): Layout {
	const bits = bytes * 8;
	const dataRows = Math.max(3, Math.ceil(Math.sqrt(bits / 4)));
	const dataCols = Math.max(3, Math.ceil(bits / dataRows));
	const cols = dataCols + 2 + ((dataCols + 2) % 2 === 0 ? 1 : 0);
	const rows = dataRows + 2 + ((dataRows + 2) % 2 === 0 ? 1 : 0);
	return { cols, rows, capacityBits: (cols - 2) * (rows - 2) };
}

/**
 * Whether each cell of the block is on, quiet zone included, row by row. For synthetic tests;
 * the addon paints the same pattern.
 */
export function blockCells(message: Uint8Array): {
	width: number;
	height: number;
	on: Uint8Array;
} {
	const { cols, rows } = layout(message.length);
	const width = cols + 2 * QUIET;
	const height = rows + 2 * QUIET;
	const on = new Uint8Array(width * height);
	for (let r = 0; r < rows; r++)
		for (let c = 0; c < cols; c++) {
			let value: number;
			if (r === 0 || c === 0 || r === rows - 1 || c === cols - 1)
				value = (r + c) % 2 === 0 ? 1 : 0;
			else {
				const k = (r - 1) * (cols - 2) + (c - 1);
				value = ((message[k >> 3] ?? 0) >> (7 - (k & 7))) & 1;
			}
			on[(r + QUIET) * width + c + QUIET] = value;
		}
	return { width, height, on };
}

// Reading -------------------------------------------------------------------------

export interface Found {
	/** Top-left pixel of the ring's first cell, and the cell size. */
	x: number;
	y: number;
	pitchX: number;
	pitchY: number;
	cols: number;
	rows: number;
	/** Mean brightness of the ring's on and off cells. */
	on: number;
	off: number;
}

export interface ShotRead {
	found?: Found;
	message?: Message;
	/** The block was found, but its bits did not make a valid message. */
	corrupt?: boolean;
}

function lumaOf(image: Raster): Float32Array {
	const out = new Float32Array(image.width * image.rows);
	const rgb = image.rgb;
	for (let i = 0, j = 0; i < out.length; i++, j += 3)
		out[i] =
			((rgb[j] ?? 0) * 299 +
				(rgb[j + 1] ?? 0) * 587 +
				(rgb[j + 2] ?? 0) * 114) /
			1000;
	return out;
}

interface Run {
	on: boolean;
	start: number;
	end: number;
}

/** Runs of a thresholded line of `n` samples. */
function runs(n: number, sample: (i: number) => number, t: number): Run[] {
	const out: Run[] = [];
	for (let i = 0; i < n; i++) {
		const on = sample(i) > t;
		const last = out.at(-1);
		if (last && last.on === on) last.end = i + 1;
		else out.push({ on, start: i, end: i + 1 });
	}
	return out;
}

/**
 * The longest stretch of alternating runs around index `at`, starting and ending with an on
 * run, every run about `pitch` long. Returns the first and last run.
 */
function alternation(
	list: Run[],
	at: number,
	pitch: number,
): { first: Run; last: Run; onRuns: number } | undefined {
	const fits = (r: Run) =>
		r.end - r.start >= pitch * 0.5 && r.end - r.start <= pitch * 1.6;
	let k = list.findIndex((r) => r.start <= at && at < r.end);
	if (k < 0 || !fits(list[k] as Run)) return undefined;
	let a = k;
	while (a > 0 && fits(list[a - 1] as Run)) a--;
	let b = k;
	while (b < list.length - 1 && fits(list[b + 1] as Run)) b++;
	if (!(list[a] as Run).on) a++;
	if (!(list[b] as Run).on) b--;
	if (b - a < 4) return undefined;
	k = 0;
	for (let i = a; i <= b; i++) if ((list[i] as Run).on) k++;
	return { first: list[a] as Run, last: list[b] as Run, onRuns: k };
}

const NOMINAL_PITCHES = [4, 2];
/** Smallest brightness step between on and off cells we try to read. */
const MIN_CONTRAST = 12;

/** Finds the block's ring at row `y` around the candidate stretch, then its left column. */
function refine(
	image: Raster,
	luma: Float32Array,
	y: number,
	from: number,
	to: number,
	pitch: number,
): Found | undefined {
	const w = image.width;
	let low = 255;
	let high = 0;
	for (let x = from; x < to; x++) {
		const v = luma[y * w + x] ?? 0;
		if (v < low) low = v;
		if (v > high) high = v;
	}
	if (high - low < MIN_CONTRAST) return undefined;
	const t = (low + high) / 2;
	const x0 = Math.max(0, from - 6 * pitch);
	const x1 = Math.min(w, to + 6 * pitch);
	const row = runs(x1 - x0, (i) => luma[y * w + x0 + i] ?? 0, t);
	const across = alternation(row, Math.floor((from + to) / 2) - x0, pitch);
	if (!across || across.onRuns < 3) return undefined;
	const left = x0 + across.first.start;
	const right = x0 + across.last.end;
	const cols = 2 * across.onRuns - 1;
	const pitchX = (right - left) / cols;
	// Down the ring's first column, through this row.
	const cx = Math.round(left + pitchX / 2);
	const column = runs(image.rows, (i) => luma[i * w + cx] ?? 0, t);
	const down = alternation(column, y, pitchX);
	if (!down || down.onRuns < 2) return undefined;
	const top = down.first.start;
	const bottom = down.last.end;
	const rows = 2 * down.onRuns - 1;
	const pitchY = (bottom - top) / rows;
	if (Math.abs(pitchY - pitchX) > pitchX * 0.25) return undefined;
	return {
		x: left,
		y: top,
		pitchX,
		pitchY,
		cols,
		rows,
		on: high,
		off: low,
	};
}

/** Mean brightness of the middle half of a cell. */
function cell(
	image: Raster,
	luma: Float32Array,
	f: Found,
	r: number,
	c: number,
): number {
	// Small cells: the whole cell, since its middle half is a single pixel.
	const inset = f.pitchX < 3 ? 0 : 0.25;
	const xa = Math.round(f.x + (c + inset) * f.pitchX);
	const xb = Math.max(xa + 1, Math.round(f.x + (c + 1 - inset) * f.pitchX));
	const ya = Math.round(f.y + (r + inset) * f.pitchY);
	const yb = Math.max(ya + 1, Math.round(f.y + (r + 1 - inset) * f.pitchY));
	let sum = 0;
	let n = 0;
	for (let y = Math.max(0, ya); y < Math.min(image.rows, yb); y++)
		for (let x = Math.max(0, xa); x < Math.min(image.width, xb); x++) {
			sum += luma[y * image.width + x] ?? 0;
			n++;
		}
	return n ? sum / n : 0;
}

/** Checks the whole ring and reads the cells inside. */
function decodeAt(
	image: Raster,
	luma: Float32Array,
	f: Found,
): { found: Found; message?: Message } | undefined {
	const ring: [number, number][] = [];
	for (let c = 0; c < f.cols; c++) ring.push([0, c], [f.rows - 1, c]);
	for (let r = 1; r < f.rows - 1; r++) ring.push([r, 0], [r, f.cols - 1]);
	let onSum = 0;
	let onN = 0;
	let offSum = 0;
	let offN = 0;
	const values = ring.map(([r, c]) => {
		const v = cell(image, luma, f, r, c);
		if ((r + c) % 2 === 0) {
			onSum += v;
			onN++;
		} else {
			offSum += v;
			offN++;
		}
		return v;
	});
	const on = onSum / onN;
	const off = offSum / offN;
	if (on - off < MIN_CONTRAST) return undefined;
	const t = (on + off) / 2;
	let good = 0;
	ring.forEach(([r, c], i) => {
		if ((values[i] ?? 0) > t === ((r + c) % 2 === 0)) good++;
	});
	if (good / ring.length < 0.9) return undefined;
	const found = { ...f, on, off };
	const bits = (f.cols - 2) * (f.rows - 2);
	const bytes = new Uint8Array(Math.floor(bits / 8));
	for (let k = 0; k < bytes.length * 8; k++) {
		const r = 1 + Math.floor(k / (f.cols - 2));
		const c = 1 + (k % (f.cols - 2));
		if (cell(image, luma, f, r, c) > t)
			bytes[k >> 3] = (bytes[k >> 3] ?? 0) | (0x80 >> (k & 7));
	}
	return { found, message: decodeMessage(bytes) };
}

/**
 * Finds a block anywhere in the picture: rows where brightness alternates with a period of
 * two cells are candidates, the ring around them must check out, and the cells must make a
 * message with a valid checksum.
 */
export function readShot(image: Raster): ShotRead {
	const luma = lumaOf(image);
	const w = image.width;
	const tau = MIN_CONTRAST * MIN_CONTRAST;
	let best: Found | undefined;
	for (const pitch of NOMINAL_PITCHES) {
		// Blurred edges break the test for a pixel or two at every cell border.
		const gap = Math.max(1, pitch / 2);
		for (let y = 0; y < image.rows; y++) {
			const base = y * w;
			let start = -1;
			let last = -1;
			for (let x = 0; x + 2 * pitch < w; x++) {
				const a = (luma[base + x] ?? 0) - (luma[base + x + pitch] ?? 0);
				const b =
					(luma[base + x + pitch] ?? 0) - (luma[base + x + 2 * pitch] ?? 0);
				if (-a * b > tau) {
					if (start < 0) start = x;
					last = x;
					if (x + 2 * pitch + 1 < w) continue;
				} else if (start < 0 || x - last <= gap) continue;
				if (last + 1 - start >= 6 * pitch) {
					const f = refine(image, luma, y, start, last + 1 + 2 * pitch, pitch);
					if (f) {
						const read = decodeAt(image, luma, f);
						if (read?.message) return read;
						if (read && !best) best = read.found;
					}
				}
				start = -1;
			}
		}
	}
	return best ? { found: best, corrupt: true } : {};
}
