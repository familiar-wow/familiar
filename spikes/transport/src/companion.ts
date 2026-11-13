// The measuring companion. It takes the addon's messages from lane U (every client write of
// AddOns.txt) and from screenshots, answers in the font bank where the message asks for it,
// and raises the next doorbell (sig\NNNN.wav) once the answer is in place. It also logs every
// other file the client writes under WTF, which shows when it saves what.
import {
	type FSWatcher,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	watch,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { atomicWrite } from "./files.ts";
import { FONTS, fontFile, fontName, replyPackets } from "./font.ts";
import { encodePng, type Raster, readImage } from "./image.ts";
import { resetVolatile } from "./install.ts";
import type { EventLog } from "./log.ts";
import {
	decodeLaneFrame,
	decodeMessage,
	encodeReply,
	KIND_NAMES,
	Kind,
	LONG_WAV,
	type Message,
	messageLength,
	Path,
	readLane,
	replyBody,
	SIGNALS,
	signalName,
} from "./protocol.ts";
import {
	type LuaTable,
	list,
	parseSavedVariables,
	table,
} from "./savedvars.ts";
import { type Found, readShot } from "./shot.ts";
import {
	accountNames,
	addonsFiles,
	clientProcesses,
	mtimeOf,
	savedVariablesFile,
	screenshotsDir,
	type WowPaths,
} from "./wow.ts";

const SHOT_FILE = /^WoWScrnShot_.*\.(jpe?g|png|tga)$/i;
/** A file without a valid frame that changed more recently than this may still be written. */
const MID_WRITE_MS = 200;
const MAX_WTF_FILES = 5000;

/** Frames of one message on its way in, per AddOns.txt. */
interface Assembly {
	code: number;
	next: number;
	chunks: Uint8Array[];
	length: number;
	frames: number;
	firstMtime: number;
	lastMtime: number;
}

interface Watched {
	file: string;
	account: string;
	label: string;
	mtime: number;
	size: number;
	retries: number;
	readErrors: number;
	/** The last frame read, to skip a client write that repeats it. */
	last?: string;
	assembly?: Assembly;
}

export interface Timing {
	wtfMs: number;
	shotMs: number;
}

export const TIMING: Timing = { wtfMs: 2000, shotMs: 100 };
/** For the simulator, which plays for seconds instead of hours. */
export const FAST_TIMING: Timing = { wtfMs: 1000, shotMs: 100 };

export interface CompanionOptions {
	paths: WowPaths;
	log: EventLog;
	/** Where crops of our screenshots go, in a "shots" folder. */
	dataDir?: string;
	processes?: () => Promise<number[]>;
	onSaved?: () => void;
	pollMs?: number;
	timing?: Partial<Timing>;
}

function percentile(values: number[], q: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return (
		sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0
	);
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const firstLine = (body: Uint8Array) =>
	(new TextDecoder().decode(body).split("\n")[0] ?? "").slice(0, 80);

export class Companion {
	/** Parsed FamiliarSpikeDB per account, refreshed whenever the game saves it. */
	readonly saved = new Map<string, LuaTable>();
	private readonly timing: Timing;
	private readonly watched = new Map<string, Watched>();
	/** epoch:id of every message answered, so a second picture is not answered twice. */
	private readonly answered = new Set<string>();
	private readonly savedMtimes = new Map<string, number>();
	private readonly timers: ReturnType<typeof setInterval>[] = [];
	private wtf?: Map<string, string>;
	/** The logged-in character's AddOns.txt: the one the client wrote last. */
	private active?: Watched;
	private watcher?: FSWatcher;
	private running = false;
	private startedAt = 0;
	private firstGameCheck = true;
	private pids: number[] = [];
	private nextBell = 1;
	private readonly shotsDone = new Set<string>();
	private readonly shotTries = new Map<string, number>();
	/** "size:mtime" of each new picture at the last poll. */
	private readonly shotStat = new Map<string, string>();
	/** Our pictures that could not be removed yet (locked by the client or a virus scanner). */
	private readonly shotRemove = new Map<string, number>();
	private shotBusy = false;
	private intervals: number[] = [];
	private lastPoll = 0;
	private errors = 0;
	private counts = {
		sessions: 0,
		lane: 0,
		shot: 0,
		replies: 0,
		bells: 0,
		frames: 0,
		clientWrites: 0,
		pictures: 0,
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
		this.every(this.timing.shotMs, () => void this.checkShots());
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
		return `${c.sessions} sessions; messages: ${c.lane} via lane U (${c.frames} frames in ${c.clientWrites} client writes), ${c.shot} via screenshot (${c.pictures} pictures read); ${c.replies} replies, ${c.bells} doorbells; ${c.wtf} other client file changes`;
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
				readErrors: 0,
			};
			this.watched.set(file, entry);
			try {
				const stat = statSync(file);
				// A file written before we started holds history, not news. A newer one
				// (a character's first login) is read normally on the next poll.
				if (stat.mtimeMs >= this.startedAt) continue;
				entry.mtime = stat.mtimeMs;
				entry.size = stat.size;
				entry.last = hex(readLane(readFileSync(file, "latin1")).bytes);
			} catch {
				// Read again on the next change.
			}
		}
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
		const lane = readLane(text);
		const frame = decodeLaneFrame(lane.bytes);
		if ((!frame || frame === "rest") && readAt - stat.mtimeMs < MID_WRITE_MS) {
			// Maybe caught the client mid-write; it does not replace the file atomically, and a
			// file cut short reads as all helpers off. Read again on the next poll and log only
			// once the file has settled.
			entry.retries++;
			return;
		}
		entry.mtime = stat.mtimeMs;
		entry.size = stat.size;
		entry.retries = 0;
		// The client writes only the logged-in character's file, so its last write tells us who
		// plays, even when the frame in it does not decode.
		this.active = entry;
		this.counts.clientWrites++;
		const key = hex(lane.bytes);
		const repeat = key === entry.last;
		entry.last = key;
		this.log.add("addons", {
			file: entry.label,
			mtime: stat.mtimeMs,
			read: readAt,
			size: stat.size,
			rows: lane.rows,
			on: lane.on,
			frame:
				frame === "rest"
					? "rest"
					: frame
						? `${frame.code}:${frame.first ? "F" : ""}${frame.seq}`
						: null,
			repeat: repeat || undefined,
			duplicate: lane.duplicate || undefined,
		});
		if (repeat || !frame) return;
		if (frame === "rest") {
			if (entry.assembly)
				this.log.add("lane-broken", {
					file: entry.label,
					why: "rest",
					frames: entry.assembly.frames,
				});
			entry.assembly = undefined;
			return;
		}
		this.counts.frames++;
		const a = entry.assembly;
		if (frame.first) {
			if (a)
				this.log.add("lane-broken", {
					file: entry.label,
					why: "new message",
					frames: a.frames,
				});
			entry.assembly = {
				code: frame.code,
				next: (frame.seq + 1) % 32,
				chunks: [frame.chunk],
				length: frame.chunk.length,
				frames: 1,
				firstMtime: stat.mtimeMs,
				lastMtime: stat.mtimeMs,
			};
		} else if (!a) {
			return; // the rest of a message that started before we looked
		} else if (frame.seq !== a.next || frame.code !== a.code) {
			this.log.add("lane-broken", {
				file: entry.label,
				why: "gap",
				expected: a.next,
				got: frame.seq,
				frames: a.frames,
			});
			entry.assembly = undefined;
			return;
		} else {
			a.chunks.push(frame.chunk);
			a.length += frame.chunk.length;
			a.frames++;
			a.next = (frame.seq + 1) % 32;
			a.lastMtime = stat.mtimeMs;
		}
		const current = entry.assembly;
		if (!current) return;
		const bytes = Buffer.concat(current.chunks);
		const length = messageLength(bytes);
		if (length === undefined || bytes.length < length) return;
		entry.assembly = undefined;
		const message = decodeMessage(bytes);
		if (!message) {
			this.log.add("lane-broken", {
				file: entry.label,
				why: "checksum",
				frames: current.frames,
			});
			return;
		}
		this.counts.lane++;
		this.receive(message, readAt, {
			file: entry.label,
			account: entry.account,
			code: current.code,
			frames: current.frames,
			firstMtime: current.firstMtime,
			lastMtime: current.lastMtime,
		});
	}

	// Messages --------------------------------------------------------------------

	/** Logs a message, then answers it: reply fonts first, the doorbell last. */
	private receive(
		m: Message,
		received: number,
		via: Record<string, unknown>,
	): void {
		const key = `${m.epoch}:${m.id}`;
		const duplicate = this.answered.has(key);
		this.log.add("message", {
			path: m.path === Path.Shot ? "shot" : "lane",
			kind: KIND_NAMES[m.kind] ?? m.kind,
			epoch: m.epoch,
			id: m.id,
			attempt: m.attempt,
			wallMs: m.wallMs,
			retryOf: m.retryOf || undefined,
			fontNext: m.fontNext,
			replyBytes: m.replyBytes,
			style: m.style,
			bytes: m.body.length,
			received,
			duplicate: duplicate || undefined,
			...via,
		});
		if (duplicate) return;
		this.answered.add(key);
		const how =
			m.path === Path.Shot ? `screenshot, style ${m.style}` : "lane U";
		if (m.kind === Kind.Hello) {
			this.counts.sessions++;
			this.log.say(`Session ${m.epoch} on ${via.file ?? "?"} said hello.`);
		} else if (m.kind === Kind.Say)
			this.log.say(`say via ${how}: "${firstLine(m.body)}"`);
		else if (m.kind === Kind.Trip) this.log.say(`Round trip via ${how}.`);
		if (m.fontNext > 0 && m.replyBytes > 0) this.reply(m, received);
		if (m.fontNext > 0 || m.kind === Kind.Bell || m.kind === Kind.Hello)
			this.ring(m);
	}

	private reply(m: Message, received: number): void {
		const started = performance.now();
		const written = Date.now();
		const body = replyBody(m.body, m.replyBytes).subarray(0, m.replyBytes);
		const bytes = encodeReply({
			epoch: m.epoch,
			id: m.id,
			attempt: m.attempt,
			receivedMs: received,
			writtenMs: written,
			path: m.path,
			body,
		});
		const packets = replyPackets(bytes, m.fontNext, m.epoch, written);
		let fonts = 0;
		for (const { slot, packet } of packets) {
			if (slot > FONTS) break;
			try {
				atomicWrite(this.fontFile(slot), fontFile(packet, slot));
				fonts++;
			} catch (error) {
				this.error("font", error, { slot });
			}
		}
		this.counts.replies++;
		this.log.add("reply", {
			epoch: m.epoch,
			id: m.id,
			first: m.fontNext,
			fonts,
			bytes: bytes.length,
			written,
			ms: performance.now() - started,
		});
	}

	private fontFile(slot: number): string {
		return join(
			this.options.paths.addons,
			"FamiliarSpike",
			"fonts",
			fontName(slot),
		);
	}

	private signalFile(n: number): string {
		return join(
			this.options.paths.addons,
			"FamiliarSpike",
			"sig",
			signalName(n),
		);
	}

	private ring(m: Message): void {
		const n = this.nextBell++;
		if (n > SIGNALS) {
			this.error("doorbell", "all doorbells used; restart WoW", { n });
			return;
		}
		try {
			atomicWrite(this.signalFile(n), LONG_WAV);
			this.counts.bells++;
			this.log.add("bell", { n, raised: Date.now(), epoch: m.epoch, id: m.id });
		} catch (error) {
			this.error("doorbell", error, { n });
		}
	}

	/** After a companion restart next to a running game: continue after the last raised file. */
	private firstUnraised(): number {
		let n = 1;
		while (n <= SIGNALS && (statSizeOf(this.signalFile(n)) ?? 0) > 0) n++;
		return n;
	}

	// Screenshots -----------------------------------------------------------------

	private async checkShots(): Promise<void> {
		if (this.shotBusy) return;
		this.shotBusy = true;
		try {
			for (const [file, tries] of this.shotRemove) {
				try {
					rmSync(file, { force: true });
					this.shotRemove.delete(file);
				} catch (error) {
					this.shotRemove.set(file, tries + 1);
					if (tries + 1 === 40) {
						this.shotRemove.delete(file);
						this.error("screenshot", error, { file });
					}
				}
			}
			const dir = screenshotsDir(this.options.paths);
			let names: string[];
			try {
				names = readdirSync(dir);
			} catch {
				return; // No screenshot taken yet.
			}
			for (const name of names) {
				const kind = SHOT_FILE.exec(name)?.[1];
				if (kind && !this.shotsDone.has(name))
					await this.readShotFile(join(dir, name), name, kind);
			}
		} finally {
			this.shotBusy = false;
		}
	}

	/**
	 * A screenshot with our block is ours: decoded, kept as a crop of the block, removed. Any
	 * other picture is the player's and stays untouched; nothing of it is kept.
	 */
	private async readShotFile(
		file: string,
		name: string,
		kind: string,
	): Promise<void> {
		let stat: ReturnType<typeof statSync>;
		try {
			stat = statSync(file);
		} catch {
			return;
		}
		if (stat.mtimeMs < this.startedAt) {
			this.shotsDone.add(name);
			return;
		}
		const seen = Date.now();
		const started = performance.now();
		let image: Raster | undefined;
		let problem: string | undefined;
		let read: ReturnType<typeof readShot> | undefined;
		try {
			image = await readImage(readFileSync(file), kind);
			read = readShot(image);
		} catch (error) {
			problem = String(error);
		}
		// A file the client is still writing reads as broken. While it changes, look again on
		// the next poll; once it holds still, give it two more reads.
		const state = `${stat.size}:${stat.mtimeMs}`;
		const settled = this.shotStat.get(name) === state;
		this.shotStat.set(name, state);
		const tries = (this.shotTries.get(name) ?? 0) + (settled ? 1 : 0);
		if (!read?.message && tries < 3 && seen - stat.mtimeMs < 10_000) {
			this.shotTries.set(name, tries);
			return;
		}
		this.shotTries.delete(name);
		this.shotStat.delete(name);
		this.shotsDone.add(name);
		this.counts.pictures++;
		const found = read?.found;
		const message = read?.message;
		this.log.add("shot", {
			file: name,
			size: stat.size,
			mtime: stat.mtimeMs,
			seen,
			tries,
			decodeMs: performance.now() - started,
			width: image?.width,
			height: image?.height,
			found: found ? true : undefined,
			ok: message ? true : undefined,
			x: found?.x,
			y: found?.y,
			pitch: found?.pitchX,
			cols: found?.cols,
			rows: found?.rows,
			on: found?.on,
			off: found?.off,
			epoch: message?.epoch,
			id: message?.id,
			attempt: message?.attempt,
			problem,
		});
		if (!found || !image) return;
		this.keepCrop(image, found, name);
		this.shotRemove.set(file, 0);
		if (message) {
			this.counts.shot++;
			this.receive(message, Date.now(), {
				file: name,
				picture: stat.mtimeMs,
				x: found.x,
				y: found.y,
				pitch: found.pitchX,
				on: found.on,
				off: found.off,
			});
		}
	}

	private keepCrop(image: Raster, found: Found, name: string): void {
		if (!this.options.dataDir) return;
		try {
			const margin = Math.round(4 * found.pitchX);
			const x0 = Math.max(0, Math.floor(found.x - margin));
			const y0 = Math.max(0, Math.floor(found.y - margin));
			const w = Math.min(
				image.width - x0,
				Math.ceil(found.cols * found.pitchX + 2 * margin),
			);
			const h = Math.min(
				image.rows - y0,
				Math.ceil(found.rows * found.pitchY + 2 * margin),
			);
			const rgb = new Uint8Array(w * h * 3);
			for (let y = 0; y < h; y++)
				rgb.set(
					image.rgb.subarray(
						((y0 + y) * image.width + x0) * 3,
						((y0 + y) * image.width + x0 + w) * 3,
					),
					y * w * 3,
				);
			const dir = join(this.options.dataDir, "shots");
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, `${name.replace(/\.\w+$/, "")}.png`),
				encodePng({ width: w, height: h, rows: h, rgb }),
			);
		} catch (error) {
			this.error("screenshot crop", error, { file: name });
		}
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

	private reset(): { signals: number; fonts: number } {
		this.nextBell = 1;
		this.active = undefined;
		for (const entry of this.watched.values()) entry.assembly = undefined;
		return resetVolatile(this.options.paths);
	}

	async checkGame(): Promise<void> {
		const pids = await (this.options.processes ?? clientProcesses)();
		if (this.firstGameCheck) {
			this.firstGameCheck = false;
			this.pids = pids;
			this.log.add("game", { pids, initial: true });
			if (pids.length === 0) this.log.add("reset", this.reset());
			// The game was already running: its files cannot be reset safely.
			else this.nextBell = this.firstUnraised();
			return;
		}
		const started = pids.filter((pid) => !this.pids.includes(pid));
		const closed = this.pids.length > 0 && pids.length === 0;
		if (started.length === 0 && pids.length === this.pids.length) return;
		// A new client process reads the doorbell and font files fresh, so they can be reused.
		// A second process next to a running client is left alone: a reset would drop a
		// doorbell the running client has not heard yet.
		const restarted =
			started.length > 0 && !pids.some((pid) => this.pids.includes(pid));
		this.pids = pids;
		this.log.add("game", { pids });
		if (restarted || closed) {
			this.log.add("reset", this.reset());
			this.log.say(
				closed
					? "WoW closed. Doorbells and fonts reset."
					: `WoW started (pid ${started.join(", ")}). Doorbells and fonts reset.`,
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
