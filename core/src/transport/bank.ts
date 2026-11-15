// Down, app to addon: the font bank and the doorbells in the addon's folder (ADR 0005).
//   bank\NNN.ttf  256 fonts, each carries one packet per game start
//   ack\NNN.wav   600 doorbells that confirm messages from the addon
//   msg\NNN.wav   600 doorbells that announce a message in the bank
// An empty .wav is a silent doorbell; the app raises it by writing 1.5 s of silence. The client
// loads every file once per process, so all of them are used once per game start, and only an
// empty bank and silent doorbells may face a new game process.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../files.ts";
import { encodePacket, packets } from "./codec.ts";
import { emptyFont, fontFile } from "./font.ts";
import { RAISED } from "./wav.ts";

export const FONTS = 256;
export const BELLS = 600;

const number = (n: number) => String(n).padStart(3, "0");

export const fontPath = (addon: string, slot: number) =>
	join(addon, "bank", `${number(slot)}.ttf`);
export const bellPath = (addon: string, row: "ack" | "msg", n: number) =>
	join(addon, row, `${number(n)}.wav`);

const sizeOf = (file: string) => {
	try {
		return statSync(file).size;
	} catch {
		return 0;
	}
};

const isEmptyFont = (file: string, slot: number) =>
	!existsSync(file) || Buffer.from(emptyFont(slot)).equals(readFileSync(file));

export class Bank {
	/** The next message doorbell and font. */
	bell = 1;
	slot = 1;

	/** `addon`: the main addon's folder. */
	constructor(private readonly addon: string) {}

	/** Silences a doorbell; returns 1 if it was raised. */
	private silence(row: "ack" | "msg", n: number): number {
		const file = bellPath(this.addon, row, n);
		if (sizeOf(file) === 0) return 0;
		atomicWrite(file, "");
		return 1;
	}

	/** Empties the bank and silences the doorbells. Returns how many files it changed. */
	reset(): number {
		let changed = 0;
		for (let n = 1; n <= BELLS; n++)
			changed += this.silence("ack", n) + this.silence("msg", n);
		for (let slot = 1; slot <= FONTS; slot++) {
			const file = fontPath(this.addon, slot);
			if (!isEmptyFont(file, slot)) {
				atomicWrite(file, emptyFont(slot));
				changed++;
			}
		}
		this.bell = 1;
		this.slot = 1;
		return changed;
	}

	/**
	 * Takes over a session the app has not seen yet, after the app started while the game ran.
	 * The addon uses doorbells in order, so the ones after its position were not played in this
	 * game yet: silencing them clears what an earlier game left raised. Returns how many files
	 * it changed.
	 */
	adopt(ack: number, bell: number, slot: number): number {
		let changed = 0;
		for (let n = ack + 1; n <= BELLS; n++) changed += this.silence("ack", n);
		for (let n = bell; n <= BELLS; n++) changed += this.silence("msg", n);
		this.bell = bell;
		this.slot = slot;
		return changed;
	}

	/** The addon read further than we wrote, for example when it skipped a message. */
	catchUp(bell: number, slot: number): void {
		this.bell = Math.max(this.bell, bell);
		this.slot = Math.max(this.slot, slot);
	}

	/** Raises the ack doorbell `n`. */
	ack(n: number): void {
		if (n >= 1 && n <= BELLS)
			atomicWrite(bellPath(this.addon, "ack", n), RAISED);
	}

	/** Writes a message into the next fonts, then rings the next message doorbell. */
	send(
		key: number,
		payload: Uint8Array,
		welcome = false,
	): { bell: number; slot: number; fonts: number } {
		const list = packets(payload, key, this.bell, this.slot, welcome);
		if (this.bell > BELLS || this.slot + list.length - 1 > FONTS)
			throw new Error(
				"the doorbells or the font bank are used up until WoW restarts",
			);
		for (const p of list)
			atomicWrite(
				fontPath(this.addon, p.slot),
				fontFile(encodePacket(p), p.slot),
			);
		atomicWrite(bellPath(this.addon, "msg", this.bell), RAISED);
		const sent = { bell: this.bell, slot: this.slot, fonts: list.length };
		this.bell++;
		this.slot += list.length;
		return sent;
	}
}
