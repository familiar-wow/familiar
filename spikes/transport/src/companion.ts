// The measuring companion: reads lane U, answers requests, drives lane D and logs every step.
import { type FSWatcher, readFileSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./files.ts";
import { resetVolatile } from "./install.ts";
import type { EventLog } from "./log.ts";
import {
	decodeFrame,
	downlinkFrames,
	type Frame,
	Kind,
	MAX_SLOT_BYTES,
	readLane,
	SIGNALS,
	SILENT_WAV,
	SLOTS,
	signalName,
	slotFolder,
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
}

interface DownlinkJob {
	entry: Watched;
	epoch: number;
	frames: Uint8Array[];
	next: number;
	writtenAt: number;
	started: number;
	rewrites: number;
}

export interface CompanionOptions {
	paths: WowPaths;
	log: EventLog;
	processes?: () => Promise<number[]>;
	onSaved?: () => void;
	pollMs?: number;
}

const DOWNLINK_RETRY_MS = 1500;
const DOWNLINK_TIMEOUT_MS = 90_000;

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
	private readonly watched = new Map<string, Watched>();
	private readonly handled = new Map<number, Set<number>>();
	private readonly hellos = new Map<number, number>();
	private readonly streams = new Map<string, Set<number>>();
	private readonly savedMtimes = new Map<string, number>();
	private readonly timers: ReturnType<typeof setInterval>[] = [];
	private locked?: Watched;
	private downlink?: DownlinkJob;
	private watcher?: FSWatcher;
	private running = false;
	private startedAt = 0;
	private firstGameCheck = true;
	private pids: number[] = [];
	private intervals: number[] = [];
	private lastPoll = 0;
	private counts = { frames: 0, signals: 0, slots: 0, sessions: 0 };

	constructor(private readonly options: CompanionOptions) {}

	private get log(): EventLog {
		return this.options.log;
	}

	start(): void {
		this.running = true;
		this.startedAt = Date.now() - 1000;
		this.log.add("companion", { pid: process.pid, platform: process.platform });
		this.scan();
		this.checkSaved();
		void this.checkGame();
		this.every(1000, () => this.scan());
		this.every(1000, () => this.checkSaved());
		this.every(3000, () => void this.checkGame());
		this.every(50, () => {
			for (const entry of this.watched.values())
				if (entry !== this.locked) this.check(entry);
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
			`Watching ${this.watched.size} AddOns.txt files. Start WoW and log in; the addon says hello in chat.`,
		);
	}

	stop(): void {
		this.running = false;
		for (const timer of this.timers) clearInterval(timer);
		this.watcher?.close();
		this.log.flush();
	}

	status(): string {
		const dl = this.downlink
			? `downlink frame ${this.downlink.next + 1}/${this.downlink.frames.length}`
			: "downlink idle";
		return `${this.counts.sessions} sessions, ${this.counts.frames} frames, ${this.counts.signals} signals, ${this.counts.slots} slots, ${dl}`;
	}

	private every(ms: number, fn: () => void): void {
		this.timers.push(setInterval(fn, ms));
	}

	private fastLoop = (): void => {
		if (!this.running) return;
		const now = performance.now();
		if (this.lastPoll) this.intervals.push(now - this.lastPoll);
		this.lastPoll = now;
		if (this.locked) this.check(this.locked);
		this.tickDownlink();
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
			};
			this.watched.set(file, entry);
			try {
				const stat = statSync(file);
				// A file written before we started holds history, not requests. A newer one
				// (a character's first login) is read normally on the next poll.
				if (stat.mtimeMs >= this.startedAt) continue;
				const lane = readLane(readFileSync(file, "latin1"), "U");
				const frame = lane && decodeFrame(lane);
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
		} catch {
			entry.retries++;
			return;
		}
		const lane = readLane(text, "U");
		const frame = lane && decodeFrame(lane);
		if (!frame && entry.retries < 5) {
			// Probably caught the client mid-write; read again on the next poll.
			entry.retries++;
			return;
		}
		entry.mtime = stat.mtimeMs;
		entry.size = stat.size;
		entry.retries = 0;
		if (frame) this.receive(entry, frame, stat.mtimeMs, readAt);
		else if (lane?.some((b) => b !== 0))
			this.log.add("bad-frame", { file: entry.label, mtime: stat.mtimeMs });
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
		} else if (frame.kind === Kind.Ack) {
			this.log.add("frame", { ...base, kind: "ack" });
			if (op === "" && p[0] === 0x44)
				this.onAck(frame.epoch, u16(p, 1), mtime, read);
		} else if (frame.kind === Kind.Control) {
			this.log.add("frame", { ...base, kind: "control", op });
			this.control(entry, frame, op, mtime, read);
		}
	}

	private control(
		entry: Watched,
		frame: Frame,
		op: string,
		mtime: number,
		read: number,
	): void {
		const p = frame.payload;
		const epoch = frame.epoch;
		// Any other request means the addon gave up on the downlink; stop rewriting the file.
		if (
			this.downlink &&
			op !== "D" &&
			(op === "H" || this.downlink.epoch === epoch)
		)
			this.finishDownlink("abandoned");
		try {
			switch (op) {
				case "H": {
					this.locked = entry;
					this.counts.sessions++;
					const reload = p[1] === 1;
					this.log.add("hello", {
						epoch,
						nonce: u32(p, 6),
						account: entry.account,
						file: entry.label,
						reload,
						build: u32(p, 2),
					});
					this.log.say(
						`Session ${epoch} on ${entry.label} (${reload ? "reload" : "login"}).`,
					);
					break;
				}
				case "S": {
					const sig = u16(p, 1);
					if (sig < 1 || sig > SIGNALS)
						throw new Error(`signal ${sig} out of range`);
					const { raised, ms } = this.raise(sig);
					this.counts.signals++;
					this.log.add("signal", { epoch, sig, mtime, read, raised, ms });
					break;
				}
				case "L": {
					const slot = p[1] ?? 0;
					const size = u32(p, 2);
					const sig = u16(p, 6);
					const nonce = u32(p, 8);
					if (
						slot < 1 ||
						slot > SLOTS ||
						size > MAX_SLOT_BYTES ||
						sig < 1 ||
						sig > SIGNALS
					)
						throw new Error(
							`slot request out of range (${slot}, ${size}, ${sig})`,
						);
					const source = slotSource(slot, nonce, size);
					const started = performance.now();
					atomicWrite(
						join(this.options.paths.addons, slotFolder(slot), "data.lua"),
						source,
					);
					const written = Date.now();
					const writeMs = performance.now() - started;
					const { raised } = this.raise(sig);
					this.counts.slots++;
					this.log.add("slot", {
						epoch,
						slot,
						size,
						sig,
						nonce,
						mtime,
						read,
						written,
						writeMs,
						raised,
					});
					break;
				}
				case "D":
					this.startDownlink(entry, epoch, u16(p, 1), u32(p, 3));
					break;
				case "M": {
					const stream = p[1] ?? 0;
					this.streams.set(`${epoch}:${stream}`, new Set());
					this.log.add("mark", { epoch, stream });
					break;
				}
				case "E": {
					const stream = p[1] ?? 0;
					const count = u16(p, 2);
					const got = this.streams.get(`${epoch}:${stream}`)?.size ?? 0;
					this.log.add("end", { epoch, stream, count, got });
					this.log.say(`Uplink stream ${stream}: ${got}/${count} frames seen.`);
					break;
				}
			}
		} catch (error) {
			this.log.add("error", { where: `control ${op}`, message: String(error) });
			this.log.say(`Error handling ${op}: ${String(error)}`);
		}
	}

	private raise(sig: number): { raised: number; ms: number } {
		const file = join(
			this.options.paths.addons,
			"FamiliarSpike",
			"sig",
			signalName(sig),
		);
		const started = performance.now();
		atomicWrite(file, SILENT_WAV);
		return { raised: Date.now(), ms: performance.now() - started };
	}

	// Lane D --------------------------------------------------------------------

	private startDownlink(
		entry: Watched,
		epoch: number,
		bytes: number,
		nonce: number,
	): void {
		if (bytes < 1 || bytes > 8192)
			throw new Error(`downlink size ${bytes} out of range`);
		if (this.downlink) this.finishDownlink("replaced");
		const frames = downlinkFrames(epoch, nonce, bytes);
		this.downlink = {
			entry,
			epoch,
			frames,
			next: 0,
			writtenAt: 0,
			started: Date.now(),
			rewrites: 0,
		};
		this.log.add("dl-start", { epoch, bytes, nonce, frames: frames.length });
		this.log.say(`Downlink test: ${bytes} bytes in ${frames.length} frames.`);
		this.writeDown();
	}

	/**
	 * Rewrites lane D. If the game saves between our read and our rename, its row update is
	 * lost; the addon then sends its ack again, and we write the frame again after a timeout.
	 */
	private writeDown(): void {
		const job = this.downlink;
		const frame = job?.frames[job.next];
		if (!job || !frame) return;
		try {
			const text = readFileSync(job.entry.file, "latin1");
			const started = performance.now();
			const retries = atomicWrite(
				job.entry.file,
				Buffer.from(writeLane(text, "D", frame), "latin1"),
			);
			job.writtenAt = Date.now();
			this.log.add("dl-write", {
				epoch: job.epoch,
				seq: job.next + 1,
				at: job.writtenAt,
				ms: performance.now() - started,
				retries,
			});
		} catch (error) {
			this.log.add("error", {
				where: "downlink write",
				message: String(error),
			});
			this.finishDownlink("write-failed");
		}
	}

	private onAck(epoch: number, seq: number, mtime: number, read: number): void {
		const job = this.downlink;
		if (!job || epoch !== job.epoch || seq !== job.next + 1) return;
		this.log.add("dl-ack", { epoch, seq, mtime, read });
		job.next++;
		if (job.next >= job.frames.length) this.finishDownlink("ok");
		else this.writeDown();
	}

	private tickDownlink(): void {
		const job = this.downlink;
		if (!job) return;
		const now = Date.now();
		if (now - job.started > DOWNLINK_TIMEOUT_MS) this.finishDownlink("timeout");
		else if (now - job.writtenAt > DOWNLINK_RETRY_MS) {
			job.rewrites++;
			this.writeDown();
		}
	}

	private finishDownlink(result: string): void {
		const job = this.downlink;
		if (!job) return;
		this.downlink = undefined;
		const finished = Date.now();
		this.log.add("dl-done", {
			epoch: job.epoch,
			result,
			acked: job.next,
			frames: job.frames.length,
			started: job.started,
			finished,
			rewrites: job.rewrites,
		});
		this.log.say(
			`Downlink test ${result}: ${job.next}/${job.frames.length} frames in ${((finished - job.started) / 1000).toFixed(1)} s.`,
		);
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
				this.log.add("error", {
					where: "savedvariables",
					message: String(error),
				});
			}
		}
	}

	async checkGame(): Promise<void> {
		const pids = await (this.options.processes ?? clientProcesses)();
		if (this.firstGameCheck) {
			this.firstGameCheck = false;
			this.pids = pids;
			this.log.add("game", { pids, initial: true });
			if (pids.length === 0)
				this.log.add("reset", resetVolatile(this.options.paths));
			return;
		}
		const started = pids.filter((pid) => !this.pids.includes(pid));
		const closed = this.pids.length > 0 && pids.length === 0;
		if (started.length === 0 && pids.length === this.pids.length) return;
		// A new client process reads the signal files fresh, so they can be reused. A second
		// process next to a running client is left alone: a reset would drop a signal the
		// running client has not heard yet.
		const restarted =
			started.length > 0 && !pids.some((pid) => this.pids.includes(pid));
		this.pids = pids;
		this.log.add("game", { pids });
		if (restarted || closed) {
			const reset = resetVolatile(this.options.paths);
			this.log.add("reset", reset);
			this.log.say(
				closed
					? "WoW closed. Signal and slot files reset."
					: `WoW started (pid ${started.join(", ")}). Signal and slot files reset.`,
			);
		}
	}
}
