// The measuring companion. Every channel runs on its own schedule, so a channel that does not
// work cannot stall the others:
//   lane U    decodes the addon's frames from every client write of AddOns.txt
//   lane D    rewrites lane D every 2 s with a counter and the time
//   slots     keeps every slot's data.lua fresh
//   doorbells raises the next sig\NNNN.wav every 30 s, starting a minute after WoW starts
// It also logs every other file the client writes under WTF, which shows when it saves what.
import {
	type FSWatcher,
	readdirSync,
	readFileSync,
	statSync,
	watch,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { atomicWrite } from "./files.ts";
import { resetVolatile } from "./install.ts";
import type { EventLog } from "./log.ts";
import {
	decodeFrame,
	type Frame,
	Kind,
	LONG_WAV,
	laneDFrame,
	readLane,
	SIGNALS,
	SLOTS,
	signalName,
	slotFolder,
	slotSize,
	slotSource,
	uplinkByte,
	writeLane,
} from "./protocol.ts";
import {
	type LuaTable,
	list,
	parseSavedVariables,
	table,
} from "./savedvars.ts";
import {
	accountNames,
	addonsFiles,
	clientProcesses,
	mtimeOf,
	savedVariablesFile,
	type WowPaths,
} from "./wow.ts";

interface Watched {
	file: string;
	account: string;
	label: string;
	mtime: number;
	size: number;
	retries: number;
	/** When the client last wrote this file, for lane D's quiet period. */
	clientAt: number;
	readErrors: number;
}

export interface Timing {
	laneDMs: number;
	/** Lane D leaves a file alone this long after the client wrote it. */
	quietMs: number;
	slotMs: number;
	bigSlotMs: number;
	bellStartMs: number;
	bellEveryMs: number;
	wtfMs: number;
}

export const TIMING: Timing = {
	laneDMs: 2000,
	quietMs: 3000,
	slotMs: 5000,
	bigSlotMs: 30_000,
	bellStartMs: 60_000,
	bellEveryMs: 30_000,
	wtfMs: 2000,
};

/** For the simulator, which plays for seconds instead of hours. */
export const FAST_TIMING: Timing = {
	laneDMs: 500,
	quietMs: 600,
	slotMs: 1000,
	bigSlotMs: 3000,
	bellStartMs: 3000,
	bellEveryMs: 3000,
	wtfMs: 1000,
};

export interface CompanionOptions {
	paths: WowPaths;
	log: EventLog;
	processes?: () => Promise<number[]>;
	onSaved?: () => void;
	pollMs?: number;
	timing?: Partial<Timing>;
}

const MAX_WTF_FILES = 5000;
/** A file without a valid frame that changed more recently than this may still be written. */
const MID_WRITE_MS = 200;

const u16 = (bytes: Uint8Array, at: number) =>
	(bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
const u32 = (bytes: Uint8Array, at: number) =>
	(u16(bytes, at) + u16(bytes, at + 2) * 65536) >>> 0;

function percentile(values: number[], q: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return (
		sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0
	);
}

export class Companion {
	/** Parsed FamiliarSpikeDB per account, refreshed whenever the game saves it. */
	readonly saved = new Map<string, LuaTable>();
	private readonly timing: Timing;
	private readonly watched = new Map<string, Watched>();
	private readonly handled = new Map<number, Set<number>>();
	private readonly hellos = new Map<number, number>();
	private readonly streams = new Map<string, Set<number>>();
	private readonly savedMtimes = new Map<string, number>();
	private readonly slotWritten = new Map<number, number>();
	private readonly timers: ReturnType<typeof setInterval>[] = [];
	private wtf?: Map<string, string>;
	/** The logged-in character's AddOns.txt: the one the client wrote last. */
	private active?: Watched;
	private watcher?: FSWatcher;
	private running = false;
	private startedAt = 0;
	private firstGameCheck = true;
	private pids: number[] = [];
	private gameStartedAt?: number;
	private nextBell = 1;
	private readonly laneDEpoch = 1 + Math.floor(Math.random() * 255);
	private laneDCounter = 0;
	private slotRefresh = 0;
	private intervals: number[] = [];
	private lastPoll = 0;
	private errors = 0;
	private counts = {
		sessions: 0,
		frames: 0,
		clientWrites: 0,
		laneD: 0,
		slots: 0,
		bells: 0,
		wtf: 0,
	};

	constructor(private readonly options: CompanionOptions) {
		this.timing = { ...TIMING, ...options.timing };
	}

	private get log(): EventLog {
		return this.options.log;
	}

	get gameRunning(): boolean {
		return this.pids.length > 0;
	}

	start(): void {
		this.running = true;
		this.startedAt = Date.now() - 1000;
		this.log.add("companion", {
			pid: process.pid,
			platform: process.platform,
			timing: this.timing,
		});
		this.scan();
		this.checkSaved();
		this.scanWtf();
		void this.checkGame();
		this.every(1000, () => this.scan());
		this.every(1000, () => this.checkSaved());
		this.every(3000, () => void this.checkGame());
		this.every(this.timing.wtfMs, () => this.scanWtf());
		this.every(50, () => {
			for (const entry of this.watched.values())
				if (entry !== this.active) this.check(entry);
		});
		this.every(this.timing.laneDMs, () => this.writeLaneD());
		this.every(1000, () => {
			this.refreshSlots();
			this.ringBells();
		});
		this.every(10_000, () => this.reportPolling());
		this.every(1000, () => this.log.flush());
		try {
			this.watcher = watch(
				this.options.paths.accounts,
				{ recursive: true },
				(_event, name) => {
					if (!name || !String(name).endsWith("AddOns.txt")) return;
					const file = join(this.options.paths.accounts, String(name));
					if (!this.watched.has(file)) this.scan();
					const entry = this.watched.get(file);
					if (entry) this.check(entry);
				},
			);
		} catch {
			// Polling alone is enough; the watcher only shortens the reaction time.
		}
		this.fastLoop();
		this.log.say(
			`Watching ${this.watched.size} AddOns.txt files. Start WoW and log in.`,
		);
	}

	stop(): void {
		this.running = false;
		for (const timer of this.timers) clearInterval(timer);
		this.watcher?.close();
		this.log.flush();
	}

	status(): string {
		const c = this.counts;
		return `${c.sessions} sessions; uplink: client wrote AddOns.txt ${c.clientWrites}×, ${c.frames} frames; lane D ${c.laneD} writes; slots ${c.slots} refreshes; doorbells ${c.bells} raised; ${c.wtf} other client file changes`;
	}

	private every(ms: number, fn: () => void): void {
		this.timers.push(setInterval(fn, ms));
	}

	private error(where: string, error: unknown, data: object = {}): void {
		if (this.errors++ < 200)
			this.log.add("error", { where, message: String(error), ...data });
	}

	private fastLoop = (): void => {
		if (!this.running) return;
		const now = performance.now();
		if (this.lastPoll) this.intervals.push(now - this.lastPoll);
		this.lastPoll = now;
		if (this.active) this.check(this.active);
		setTimeout(this.fastLoop, this.options.pollMs ?? 2);
	};

	private reportPolling(): void {
		if (this.intervals.length === 0) return;
		const values = this.intervals;
		this.intervals = [];
		this.log.add("poll", {
			n: values.length,
			p50: percentile(values, 0.5),
			p95: percentile(values, 0.95),
			max: Math.max(...values),
		});
	}

	// Lane U --------------------------------------------------------------------

	private scan(): void {
		for (const { file, account } of addonsFiles(this.options.paths)) {
			if (this.watched.has(file)) continue;
			const parts = file.split(/[\\/]/);
			const entry: Watched = {
				file,
				account,
				label: `${parts.at(-3)}/${parts.at(-2)}`,
				mtime: 0,
				size: -1,
				retries: 0,
				clientAt: 0,
				readErrors: 0,
			};
			this.watched.set(file, entry);
			try {
				const stat = statSync(file);
				// A file written before we started holds history, not news. A newer one
				// (a character's first login) is read normally on the next poll.
				if (stat.mtimeMs >= this.startedAt) continue;
				const frame = decodeFrame(
					readLane(readFileSync(file, "latin1"), "U").bytes,
				);
				if (frame) this.seen(frame.epoch).add(frame.seq);
				entry.mtime = stat.mtimeMs;
				entry.size = stat.size;
			} catch {
				// Read again on the next change.
			}
		}
	}

	private seen(epoch: number): Set<number> {
		let set = this.handled.get(epoch);
		if (!set) {
			set = new Set();
			this.handled.set(epoch, set);
		}
		return set;
	}

	/** Reads a client write of AddOns.txt and logs what it held, decodable or not. */
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
			entry.retries === 0
		)
			return;
		const readAt = Date.now();
		let text: string;
		try {
			text = readFileSync(entry.file, "latin1");
		} catch (error) {
			entry.retries++;
			if (entry.readErrors++ < 10)
				this.log.add("read-error", {
					file: entry.label,
					code: (error as NodeJS.ErrnoException).code ?? String(error),
				});
			return;
		}
		const lane = readLane(text, "U");
		const frame = decodeFrame(lane.bytes);
		if (!frame && readAt - stat.mtimeMs < MID_WRITE_MS) {
			// Maybe caught the client mid-write; it does not replace the file atomically.
			// Read again on the next poll and log only once the file has settled.
			entry.retries++;
			return;
		}
		entry.mtime = stat.mtimeMs;
		entry.size = stat.size;
		entry.retries = 0;
		entry.clientAt = readAt;
		// The client writes only the logged-in character's file, so its last write tells us who
		// plays, even when the frame in it does not decode.
		this.active = entry;
		this.counts.clientWrites++;
		this.log.add("addons", {
			file: entry.label,
			mtime: stat.mtimeMs,
			read: readAt,
			size: stat.size,
			rows: lane.rows,
			on: lane.on,
			dRows: readLane(text, "D").rows,
			frame: frame ? `${frame.epoch}:${frame.seq}` : null,
			duplicate: lane.duplicate || undefined,
		});
		if (frame) this.receive(entry, frame, stat.mtimeMs, readAt);
	}

	private receive(
		entry: Watched,
		frame: Frame,
		mtime: number,
		read: number,
	): void {
		const p = frame.payload;
		const op =
			frame.kind === Kind.Control ? String.fromCharCode(p[0] ?? 0) : "";
		if (op === "H") {
			const nonce = u32(p, 6);
			if (this.hellos.get(frame.epoch) !== nonce) {
				this.hellos.set(frame.epoch, nonce);
				this.handled.set(frame.epoch, new Set());
			}
		}
		const seen = this.seen(frame.epoch);
		if (seen.has(frame.seq)) return;
		seen.add(frame.seq);
		this.counts.frames++;
		const base = {
			file: entry.label,
			epoch: frame.epoch,
			seq: frame.seq,
			mtime,
			read,
		};
		if (frame.kind === Kind.Data) {
			const stream = p[0] ?? 0;
			const index = u16(p, 1);
			let ok = p.length === 20;
			for (let j = 1; ok && j <= 17; j++)
				ok = p[2 + j] === uplinkByte(stream, index, j);
			this.log.add("frame", { ...base, kind: "data", stream, index, ok });
			this.streams.get(`${frame.epoch}:${stream}`)?.add(index);
			return;
		}
		if (frame.kind !== Kind.Control) return;
		this.log.add("frame", { ...base, kind: "control", op });
		if (op === "H") {
			this.active = entry;
			this.counts.sessions++;
			const reload = p[1] === 1;
			this.log.add("hello", {
				epoch: frame.epoch,
				nonce: u32(p, 6),
				account: entry.account,
				file: entry.label,
				reload,
				build: u32(p, 2),
			});
			this.log.say(
				`Session ${frame.epoch} on ${entry.label} (${reload ? "reload" : "login"}).`,
			);
		} else if (op === "M") {
			this.streams.set(`${frame.epoch}:${p[1] ?? 0}`, new Set());
		} else if (op === "E") {
			const stream = p[1] ?? 0;
			const count = u16(p, 2);
			const got = this.streams.get(`${frame.epoch}:${stream}`)?.size ?? 0;
			this.log.add("end", { epoch: frame.epoch, stream, count, got });
			this.log.say(`Uplink stream ${stream}: ${got}/${count} frames seen.`);
		}
	}

	// Lane D --------------------------------------------------------------------

	/**
	 * Writes the next lane D frame into the active character's AddOns.txt, or into every
	 * character's file until the client has written one. A file the client wrote within
	 * the quiet period is skipped, so our rewrite cannot drop one of its lane U frames.
	 */
	private writeLaneD(): void {
		if (!this.gameRunning) return;
		const at = Date.now();
		const counter = ++this.laneDCounter;
		const frame = laneDFrame(this.laneDEpoch, counter, at);
		const targets = this.active ? [this.active] : [...this.watched.values()];
		let written = 0;
		let busy = 0;
		for (const entry of targets) {
			this.check(entry); // take in a client write we have not read yet
			if (
				entry.retries > 0 ||
				Date.now() - entry.clientAt < this.timing.quietMs
			) {
				busy++;
				continue;
			}
			try {
				const before = statSync(entry.file);
				const text = readFileSync(entry.file, "latin1");
				const next = Buffer.from(writeLane(text, "D", frame), "latin1");
				const again = statSync(entry.file);
				if (again.mtimeMs !== before.mtimeMs || again.size !== before.size) {
					busy++;
					continue;
				}
				atomicWrite(entry.file, next);
				const after = statSync(entry.file);
				entry.mtime = after.mtimeMs;
				entry.size = after.size;
				written++;
			} catch (error) {
				this.error("lane D", error, { file: entry.label });
			}
		}
		if (written > 0) this.counts.laneD++;
		this.log.add("lane-d", { counter, at, written, busy });
	}

	// Slots ---------------------------------------------------------------------

	/** Rewrites every slot whose refresh interval has passed. Slots 5 and 6 are big and slower. */
	private refreshSlots(): void {
		if (!this.gameRunning) return;
		const now = Date.now();
		const due: number[] = [];
		for (let k = 1; k <= SLOTS; k++) {
			const every =
				slotSize(k) >= 131072 ? this.timing.bigSlotMs : this.timing.slotMs;
			if (now - (this.slotWritten.get(k) ?? 0) >= every) due.push(k);
		}
		if (due.length === 0) return;
		const refresh = ++this.slotRefresh;
		const started = performance.now();
		let written = 0;
		for (const k of due) {
			const size = slotSize(k);
			const every = size >= 131072 ? this.timing.bigSlotMs : this.timing.slotMs;
			try {
				atomicWrite(
					join(this.options.paths.addons, slotFolder(k), "data.lua"),
					slotSource({ slot: k, refresh, written: Date.now(), every, size }),
				);
				this.slotWritten.set(k, now);
				written++;
			} catch (error) {
				this.error("slot", error, { slot: k });
			}
		}
		this.counts.slots++;
		this.log.add("slots", {
			refresh,
			at: now,
			written,
			ms: performance.now() - started,
		});
	}

	// Doorbells -----------------------------------------------------------------

	private signalFile(n: number): string {
		return join(
			this.options.paths.addons,
			"FamiliarSpike",
			"sig",
			signalName(n),
		);
	}

	/** Raises every doorbell that is due: the first a minute after WoW starts, then one every 30 s. */
	private ringBells(): void {
		if (!this.gameRunning || this.gameStartedAt === undefined) return;
		const due = Math.min(
			SIGNALS,
			Math.floor(
				(Date.now() - this.gameStartedAt - this.timing.bellStartMs) /
					this.timing.bellEveryMs,
			) + 1,
		);
		while (this.nextBell <= due) {
			const n = this.nextBell++;
			try {
				atomicWrite(this.signalFile(n), LONG_WAV);
				this.counts.bells++;
				this.log.add("bell", { n, raised: Date.now() });
			} catch (error) {
				this.error("doorbell", error, { n });
			}
		}
	}

	/** After a companion restart next to a running game: continue after the last raised file. */
	private firstUnraised(): number {
		let n = 1;
		while (n <= SIGNALS && (statSizeOf(this.signalFile(n)) ?? 0) > 0) n++;
		return n;
	}

	// Client files ----------------------------------------------------------------

	/** Logs every file under WTF the client adds, changes or removes, except AddOns.txt. */
	private scanWtf(): void {
		const root = dirname(this.options.paths.accounts);
		const now = new Map<string, string>();
		const walk = (dir: string, depth: number) => {
			if (depth > 6 || now.size >= MAX_WTF_FILES) return;
			let entries: import("node:fs").Dirent[];
			try {
				entries = readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) walk(path, depth + 1);
				else if (entry.isFile() && entry.name !== "AddOns.txt") {
					try {
						const stat = statSync(path);
						now.set(relative(root, path), `${stat.size}:${stat.mtimeMs}`);
					} catch {
						// Removed while we looked.
					}
				}
			}
		};
		walk(root, 0);
		const before = this.wtf;
		this.wtf = now;
		if (!before) {
			this.log.add("wtf-start", { files: now.size });
			return;
		}
		for (const [path, value] of now) {
			const old = before.get(path);
			if (old === value) continue;
			const [size, mtime] = value.split(":").map(Number);
			this.counts.wtf++;
			this.log.add("wtf", {
				path,
				change: old === undefined ? "added" : "changed",
				size,
				mtime,
			});
		}
		for (const path of before.keys())
			if (!now.has(path)) this.log.add("wtf", { path, change: "removed" });
	}

	// Saved results and game lifecycle -------------------------------------------

	private checkSaved(): void {
		for (const account of accountNames(this.options.paths)) {
			const file = savedVariablesFile(this.options.paths, account);
			const mtime = mtimeOf(file);
			if (mtime === undefined || this.savedMtimes.get(file) === mtime) continue;
			this.savedMtimes.set(file, mtime);
			try {
				const db = table(
					parseSavedVariables(readFileSync(file, "utf8")).FamiliarSpikeDB,
				);
				if (!db) continue;
				this.saved.set(account, db);
				const sessions = list(db.sessions).length;
				this.log.add("saved", { account, sessions });
				this.log.say(
					`Saved results received from ${account} (${sessions} sessions).`,
				);
				this.options.onSaved?.();
			} catch (error) {
				this.error("savedvariables", error);
			}
		}
	}

	private reset(): { signals: number; slots: number } {
		this.nextBell = 1;
		this.slotWritten.clear();
		this.active = undefined;
		return resetVolatile(this.options.paths);
	}

	async checkGame(): Promise<void> {
		const pids = await (this.options.processes ?? clientProcesses)();
		if (this.firstGameCheck) {
			this.firstGameCheck = false;
			this.pids = pids;
			this.log.add("game", { pids, initial: true });
			if (pids.length === 0) this.log.add("reset", this.reset());
			else {
				// The game was already running: its files cannot be reset safely.
				this.gameStartedAt = Date.now();
				this.nextBell = this.firstUnraised();
			}
			return;
		}
		const started = pids.filter((pid) => !this.pids.includes(pid));
		const closed = this.pids.length > 0 && pids.length === 0;
		if (started.length === 0 && pids.length === this.pids.length) return;
		// A new client process reads the doorbell files fresh, so they can be reused. A second
		// process next to a running client is left alone: a reset would drop a doorbell the
		// running client has not heard yet.
		const restarted =
			started.length > 0 && !pids.some((pid) => this.pids.includes(pid));
		this.pids = pids;
		this.log.add("game", { pids });
		if (restarted || closed) {
			this.log.add("reset", this.reset());
			this.gameStartedAt = restarted ? Date.now() : undefined;
			this.log.say(
				closed
					? "WoW closed. Doorbell and slot files reset."
					: `WoW started (pid ${started.join(", ")}). Doorbell and slot files reset.`,
			);
		}
	}
}

function statSizeOf(file: string): number | undefined {
	try {
		return statSync(file).size;
	} catch {
		return undefined;
	}
}
