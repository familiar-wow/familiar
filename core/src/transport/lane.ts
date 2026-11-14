// Up, addon to app: the AddOns.txt lane (ADR 0005). Each of 256 helper addons carries one bit as
// its enabled state, and the client writes them into the character's AddOns.txt whenever the
// addon calls C_AddOns.SaveAddOns. This reads every client write and puts the frames back
// together into messages.
import { type FSWatcher, readFileSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import type { Log } from "../log.ts";
import { addonsFiles } from "../wow/client.ts";
import {
	decodeFrame,
	decodeUp,
	FRAME_BYTES,
	HELPERS,
	type UpMessage,
	upLength,
} from "./codec.ts";

export const helperName = (i: number) =>
	`Familiar_L${String(i).padStart(3, "0")}`;

const ROW = /^Familiar_L(\d{3}):[ \t]*(enabled|disabled)[ \t]*\r?$/gm;

/** A file younger than this without a valid frame may be cut short by a write in progress. */
const MID_WRITE_MS = 200;

/** The lane in a file's text as 32 bytes. A missing row counts as off, the helpers' default. */
export function readLane(text: string): Uint8Array {
	const bits = new Uint8Array(FRAME_BYTES);
	for (const [, index, state] of text.matchAll(ROW)) {
		const i = Number(index);
		if (state === "enabled" && i < HELPERS)
			bits[i >> 3] = (bits[i >> 3] ?? 0) | (1 << (i & 7));
	}
	return bits;
}

/** Puts the frames of one AddOns.txt back together into messages. */
export class Assembler {
	private chunks?: Uint8Array[];
	private next = 0;
	private last = "";

	constructor(private readonly broken: (why: string) => void = () => {}) {}

	/** Returns a message once its last frame is in. */
	push(bits: Uint8Array): UpMessage | undefined {
		const frame = decodeFrame(bits);
		const key = bits.join(",");
		// The client may write the same state twice, for example when another addon saves.
		if (!frame || key === this.last) return undefined;
		this.last = key;
		if (frame === "rest") {
			if (this.chunks) this.broken("ended early");
			this.chunks = undefined;
			return undefined;
		}
		if (frame.first) {
			if (this.chunks) this.broken("a new message began");
			this.chunks = [];
		} else if (!this.chunks) {
			return undefined; // the rest of a message that began before we looked
		} else if (frame.seq !== this.next) {
			this.broken(`frame ${frame.seq} came instead of ${this.next}`);
			this.chunks = undefined;
			return undefined;
		}
		this.chunks.push(frame.chunk);
		this.next = (frame.seq + 1) & 0x7f;
		const bytes = Buffer.concat(this.chunks);
		// One chunk is longer than the message header, so it is complete by now.
		const length = upLength(bytes);
		if (length === undefined) {
			this.broken("no message header");
			this.chunks = undefined;
			return undefined;
		}
		if (bytes.length < length) return undefined;
		this.chunks = undefined;
		const message = decodeUp(bytes.subarray(0, length));
		if (!message) this.broken("checksum");
		return message;
	}
}

interface Watched {
	file: string;
	mtime: number;
	size: number;
	/** Read again even if the file looks unchanged. */
	again: boolean;
	assembler: Assembler;
}

/** Watches every character's AddOns.txt; the one the client wrote last is polled fastest. */
export class LaneReader {
	private readonly watched = new Map<string, Watched>();
	private readonly timers: ReturnType<typeof setInterval>[] = [];
	private active?: Watched;
	private watcher?: FSWatcher;
	private running = false;

	constructor(
		private readonly accounts: string,
		private readonly receive: (message: UpMessage) => void,
		private readonly log: Log,
	) {}

	start(): void {
		this.running = true;
		this.scan(true);
		this.timers.push(setInterval(() => this.scan(false), 1000));
		this.timers.push(
			setInterval(() => {
				for (const entry of this.watched.values())
					if (entry !== this.active) this.check(entry);
			}, 50),
		);
		try {
			this.watcher = watch(
				this.accounts,
				{ recursive: true },
				(_event, name) => {
					if (!name?.endsWith("AddOns.txt")) return;
					const file = join(this.accounts, name);
					if (!this.watched.has(file)) this.scan(false);
					const entry = this.watched.get(file);
					if (entry) this.check(entry);
				},
			);
		} catch {
			// Polling alone is enough; the watcher only shortens the reaction time.
		}
		this.poll();
	}

	stop(): void {
		this.running = false;
		for (const timer of this.timers) clearInterval(timer);
		this.watcher?.close();
	}

	/** About 2 ms between looks at the active file: the client writes a frame every 33 ms. */
	private poll = (): void => {
		if (!this.running) return;
		if (this.active) this.check(this.active);
		setTimeout(this.poll, 2);
	};

	private scan(initial: boolean): void {
		for (const file of addonsFiles(this.accounts)) {
			if (this.watched.has(file)) continue;
			const entry: Watched = {
				file,
				mtime: 0,
				size: -1,
				again: false,
				assembler: new Assembler((why) =>
					this.log.event("lane-broken", { file: this.label(file), why }),
				),
			};
			this.watched.set(file, entry);
			// What was in the files before we started is history, not news.
			if (initial) {
				try {
					const stat = statSync(file);
					entry.mtime = stat.mtimeMs;
					entry.size = stat.size;
				} catch {
					// Read on the next change.
				}
			}
		}
	}

	private label(file: string): string {
		return file
			.slice(this.accounts.length + 1)
			.replace(/[\\/]AddOns\.txt$/, "");
	}

	private check(entry: Watched): void {
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(entry.file);
		} catch {
			return;
		}
		if (
			stat.mtimeMs === entry.mtime &&
			stat.size === entry.size &&
			!entry.again
		)
			return;
		let text: string;
		try {
			text = readFileSync(entry.file, "latin1");
		} catch {
			entry.again = true; // Windows locks the file while the client writes it.
			return;
		}
		const bits = readLane(text);
		const frame = decodeFrame(bits);
		// The client does not write the file atomically, and a file cut short reads as all
		// helpers off. Read it again until it is old enough to be complete.
		if (
			(!frame || frame === "rest") &&
			Date.now() - stat.mtimeMs < MID_WRITE_MS
		) {
			entry.again = true;
			return;
		}
		entry.mtime = stat.mtimeMs;
		entry.size = stat.size;
		entry.again = false;
		// The client writes only the logged-in character's file.
		this.active = entry;
		const message = entry.assembler.push(bits);
		if (message) this.receive(message);
	}
}
