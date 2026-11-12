// Joins the addon's SavedVariables with the companion log and renders report.md.
// Every channel gets one verdict from its benchmark and its soak. The diagnosis section shows
// what the client actually wrote, so a channel that fails can be explained.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type LogEvent, readLogs } from "./log.ts";
import {
	type LuaTable,
	list,
	num,
	parseSavedVariables,
	table,
	text,
} from "./savedvars.ts";

interface Stats {
	n: number;
	p50: number;
	p95: number;
	max: number;
}

function stats(values: number[]): Stats | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const pick = (q: number) =>
		sorted[
			Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
		] ?? 0;
	return {
		n: sorted.length,
		p50: pick(0.5),
		p95: pick(0.95),
		max: sorted.at(-1) ?? 0,
	};
}

/** The addon's "n:p50/p95/max" summaries. */
function summary(value: string | undefined): Stats | undefined {
	const [n = "0", rest] = (value ?? "0").split(":");
	if (!rest || n === "0") return undefined;
	const [p50 = 0, p95 = 0, max = 0] = rest.split("/").map(Number);
	return { n: Number(n), p50, p95, max };
}

const ms = (value: number | undefined, digits = 0) =>
	value === undefined ? "–" : `${value.toFixed(digits)} ms`;
const trio = (s: Stats | undefined, digits = 0) =>
	s
		? `${s.p50.toFixed(digits)} / ${s.p95.toFixed(digits)} / ${s.max.toFixed(digits)} ms`
		: "–";
const pct = (part: number, whole: number) =>
	whole === 0 ? "–" : `${((100 * part) / whole).toFixed(1)} %`;
const mark = (ok: boolean | undefined) =>
	ok === undefined ? "?" : ok ? "✔" : "✘";
const rows = (value: string | undefined) =>
	value ? value.split(";").filter(Boolean) : [];
const numOrUndefined = (value: string | undefined) =>
	value === undefined || value === "" || value === "-"
		? undefined
		: Number(value);
const bytes = (n: number) =>
	n >= 1048576
		? `${n / 1048576} MB`
		: n >= 1024
			? `${Math.round(n / 1024)} KB`
			: `${n} B`;
const time = (t: number) => new Date(t).toLocaleTimeString();
const nFrames = (n: number) => `${n} frame${n === 1 ? "" : "s"}`;

function tableMd(head: string[], body: (string | number)[][]): string {
	const line = (cells: (string | number)[]) => `| ${cells.join(" | ")} |`;
	return [line(head), line(head.map(() => "---")), ...body.map(line)].join(
		"\n",
	);
}

function count<K>(map: Map<K, number>, key: K, by = 1): void {
	map.set(key, (map.get(key) ?? 0) + by);
}

const listing = (map: Map<string, number>) =>
	[...map.entries()].map(([reason, n]) => `${reason} ×${n}`).join(", ");

export interface Saved {
	account: string;
	db: LuaTable;
}

export function loadSaved(dataDir: string): Saved[] {
	let names: string[] = [];
	try {
		names = readdirSync(dataDir).filter((name) =>
			/^savedvariables-.*\.lua$/.test(name),
		);
	} catch {
		return [];
	}
	const result: Saved[] = [];
	for (const name of names.sort()) {
		const db = table(
			parseSavedVariables(readFileSync(join(dataDir, name), "utf8"))
				.FamiliarSpikeDB,
		);
		if (db) result.push({ account: name.slice(15, -4), db });
	}
	return result;
}

/** One addon session (a login or /reload) and the companion events of its lifetime. */
interface Session {
	account: string;
	data: LuaTable;
	epoch: number;
	from: number;
	to: number;
	events: LogEvent[];
	/** Whether the companion ran during the session. */
	companion: boolean;
}

function sessionsOf(saved: Saved[], events: LogEvent[]): Session[] {
	return saved.flatMap(({ account, db }) =>
		list(db.sessions).map((value) => {
			const data = table(value) ?? {};
			const from = (num(data.started) ?? 0) * 1000 - 2000;
			const to = (num(data.ended) ?? Number.POSITIVE_INFINITY) + 2000;
			const own = events.filter((e) => e.t >= from && e.t <= to);
			return {
				account,
				data,
				epoch: num(data.epoch) ?? -1,
				from,
				to,
				events: own,
				companion: own.some((e) => e.ev === "poll" || e.ev === "lane-d"),
			};
		}),
	);
}

interface Section {
	title: string;
	body: string;
}

interface Tally {
	ok: number;
	failed: number;
}

interface Verdict {
	channel: string;
	/** undefined: not measured. */
	bench: boolean | undefined;
	benchText: string;
	soak: Tally;
	soakText: string;
	/** A channel without a soak is judged on its benchmark alone. */
	benchOnly?: boolean;
}

const tally = (): Tally => ({ ok: 0, failed: 0 });

// Uplink ------------------------------------------------------------------------

const UPLINK_STREAMS = [1, 2, 3, 4, 5];
const SOAK_STREAM = 9;

function framesSeen(session: Session, stream: number): Map<number, LogEvent> {
	const seen = new Map<number, LogEvent>();
	for (const e of session.events)
		if (
			e.ev === "frame" &&
			e.kind === "data" &&
			e.epoch === session.epoch &&
			e.stream === stream
		)
			seen.set(Number(e.index), e);
	return seen;
}

/** What the client wrote to AddOns.txt between two times. */
function clientWrites(events: LogEvent[], from: number, to: number) {
	const writes = events.filter(
		(e) => e.ev === "addons" && e.t >= from && e.t <= to,
	);
	const rowCounts = writes.map((e) => Number(e.rows ?? 0));
	return {
		writes: writes.length,
		decoded: writes.filter((e) => e.frame).length,
		minRows: rowCounts.length ? Math.min(...rowCounts) : 0,
		maxRows: Math.max(0, ...rowCounts),
		maxOn: Math.max(0, ...writes.map((e) => Number(e.on ?? 0))),
	};
}

function uplinkBench(
	session: Session,
	bench: LuaTable,
): { section: Section; ok: boolean | undefined; text: string } {
	const up = table(bench.up);
	const body: (string | number)[][] = [];
	let lossFree = true;
	let detect95 = 0;
	let cost95 = 0;
	let streams = 0;
	let seenTotal = 0;
	let mismatches = 0;
	for (const stream of UPLINK_STREAMS) {
		const run = table(up?.[String(stream)]);
		if (!run) continue;
		streams++;
		const seen = framesSeen(session, stream);
		const sends = rows(text(run.sends)).map((row) =>
			row.split(",").map(Number),
		);
		const detect: number[] = [];
		const fileLag: number[] = [];
		const cost: number[] = [];
		let corrupt = 0;
		let streamMismatches = 0;
		for (const [
			index = 0,
			sent = 0,
			toggle = 0,
			save = 0,
			,
			mis = 0,
		] of sends) {
			cost.push(toggle + save);
			streamMismatches += mis;
			const e = seen.get(index);
			if (!e) continue;
			if (e.ok === false) corrupt++;
			detect.push(Number(e.read) - sent);
			fileLag.push(Number(e.mtime) - sent);
		}
		seenTotal += detect.length;
		mismatches += streamMismatches;
		const interval = num(run.interval) ?? 0;
		const lost = sends.length - detect.length;
		if ((lost > 0 || corrupt > 0) && interval >= 0.033) lossFree = false;
		const d = stats(detect);
		const c = stats(cost);
		if (interval >= 0.066) {
			detect95 = Math.max(detect95, d?.p95 ?? 0);
			cost95 = Math.max(cost95, c?.p95 ?? 0);
		}
		const first = sends[0]?.[1] ?? 0;
		const last = sends.at(-1)?.[1] ?? 0;
		const seconds = Math.max(0.001, (last - first) / 1000);
		body.push([
			interval === 0 ? "every frame" : `${Math.round(interval * 1000)} ms`,
			`${detect.length}/${sends.length}`,
			pct(lost, sends.length),
			corrupt,
			streamMismatches,
			`${((detect.length * 20) / seconds).toFixed(0)} B/s`,
			trio(d),
			trio(stats(fileLag)),
			trio(c, 2),
		]);
	}
	const from = num(bench.started) ?? 0;
	const to = num(bench.finished) ?? from;
	const writes = clientWrites(session.events, from, to);
	let ok: boolean | undefined;
	let verdict: string;
	if (streams === 0) {
		verdict = "not measured (helper addons missing?)";
	} else if (seenTotal === 0) {
		ok = session.companion ? false : undefined;
		verdict = !session.companion
			? "companion was not running"
			: writes.writes === 0
				? "no frame arrived: the client did not write AddOns.txt during the benchmark"
				: writes.maxRows === 0
					? `no frame arrived: the client wrote AddOns.txt ${writes.writes}× without FamiliarSpike_U rows`
					: `no frame arrived: the client wrote AddOns.txt ${writes.writes}× (up to ${writes.maxRows} lane rows, ${writes.maxOn} enabled), none held a valid frame`;
	} else {
		ok = lossFree && detect95 < 250 && cost95 < 2 && mismatches === 0;
		verdict = `${lossFree ? "no loss at ≥33 ms spacing" : "frames lost"}, detect p95 ${ms(detect95)}, write cost p95 ${ms(cost95, 2)}`;
	}
	if (mismatches > 0)
		verdict += `; the client ignored ${mismatches} enable/disable calls`;
	return {
		ok,
		text: verdict,
		section: {
			title: "Uplink: AddOns.txt lane U",
			body: [
				"The addon flips 256 helper enable states and calls `C_AddOns.SaveAddOns()`; the companion reads every client write of `AddOns.txt`. *Detect* runs from the start of the write to the companion's read (two clocks, ± one frame). *File lag* is the file's mtime minus the start of the write. *Write cost* is the time inside the toggle and save calls, which the frame pays for. *Ignored* counts enable/disable calls the client did not take. Payload per frame: 20 bytes.",
				"",
				tableMd(
					[
						"Spacing",
						"Seen",
						"Lost",
						"Corrupt",
						"Ignored",
						"Payload",
						"Detect p50/p95/max",
						"File lag p50/p95/max",
						"Write cost p50/p95/max",
					],
					body,
				),
				"",
				`During the benchmark the client wrote \`AddOns.txt\` ${writes.writes}× (lane U rows per write: ${writes.minRows}–${writes.maxRows}, enabled up to ${writes.maxOn}); ${writes.decoded} of these writes held a valid frame.`,
			].join("\n"),
		},
	};
}

// Lane D ------------------------------------------------------------------------

function laneDBench(
	session: Session,
	bench: LuaTable,
): { section: Section; ok: boolean | undefined; text: string } {
	const d = table(bench.laneD);
	if (!d)
		return {
			ok: undefined,
			text: "not measured",
			section: { title: "Downlink: AddOns.txt lane D", body: "Not measured." },
		};
	const started = num(d.started) ?? 0;
	const finished = num(d.finished) ?? started;
	const frames = rows(text(d.frames)).map((row) => row.split(",").map(Number));
	const writes = session.events.filter(
		(e) => e.ev === "lane-d" && e.t >= started && e.t <= finished - 500,
	);
	const written = writes.filter((e) => Number(e.written) > 0);
	const busy = writes.length - written.length;
	const seenCounters = new Set(frames.map(([counter]) => counter));
	const missed = written.filter((e) => !seenCounters.has(Number(e.counter)));
	const latency = frames
		.filter(([, at = 0]) => at >= started)
		.map(([, at = 0, seen = 0]) => seen - at);
	const lat = stats(latency);
	const reset = summary(text(d.reset));
	const read = summary(text(d.read));
	let ok: boolean | undefined;
	let verdict: string;
	if (!session.companion) verdict = "companion was not running";
	else if (written.length === 0)
		verdict = `the companion could not write lane D (${busy}× the client had just written AddOns.txt)`;
	else if (frames.length === 0) {
		ok = false;
		verdict = `ResetAddOns does not pick up the file: 0 of ${written.length} companion frames seen`;
	} else {
		ok = missed.length === 0 && (lat?.p95 ?? 0) < 1000 && (reset?.p95 ?? 0) < 2;
		verdict = `${written.length - missed.length}/${written.length} frames seen, latency p95 ${ms(lat?.p95)}, ResetAddOns cost p95 ${ms(reset?.p95, 2)}`;
	}
	return {
		ok,
		text: verdict,
		section: {
			title: "Downlink: AddOns.txt lane D",
			body: [
				"The companion rewrites lane D every 2 seconds with a counter and its clock, unless the client wrote the file within the last 3 seconds. The addon calls `C_AddOns.ResetAddOns()` every 0.1 s and reads the lane back. This only works if that call re-reads the file. Payload: 20 bytes per frame.",
				"",
				tableMd(
					[
						"Companion writes",
						"Skipped (client busy)",
						"Seen",
						"Latency p50/p95/max",
						"ResetAddOns cost p50/p95/max",
						"Read cost p50/p95/max",
					],
					[
						[
							written.length,
							busy,
							`${written.length - missed.length}/${written.length}`,
							trio(lat),
							trio(reset, 3),
							trio(read, 3),
						],
					],
				),
			].join("\n"),
		},
	};
}

// Slots -------------------------------------------------------------------------

interface SlotLoad {
	slot: number;
	size: number;
	cost: number;
	age: number | undefined;
	result: string;
}

function slotLoad(record: string): SlotLoad {
	const [slot, size, cost, age, result = "?"] = record.split(",");
	return {
		slot: Number(slot),
		size: Number(size),
		cost: Number(cost),
		age: numOrUndefined(age),
		result,
	};
}

function slotBench(
	session: Session,
	bench: LuaTable,
): { section: Section; ok: boolean | undefined; text: string } {
	const loads = rows(text(bench.slots)).map(slotLoad);
	const until = num(bench.finished) ?? session.to;
	const companionWrote = session.events.some(
		(e) => e.ev === "slots" && Number(e.written) > 0 && e.t < until,
	);
	const fresh = loads.filter((l) => l.result === "fresh").length;
	const small = stats(
		loads
			.filter((l) => l.size <= 2048 && l.result !== "used")
			.map((l) => l.cost),
	);
	const big = loads.find((l) => l.size >= 1048576);
	const age = stats(loads.flatMap((l) => (l.age === undefined ? [] : [l.age])));
	let ok: boolean | undefined;
	let verdict: string;
	if (loads.length === 0) verdict = "not measured";
	else if (!companionWrote && fresh === 0)
		verdict = "companion did not write the slots";
	else {
		ok = fresh === loads.length;
		const placeholders = loads.filter((l) => l.result === "placeholder").length;
		verdict =
			placeholders > 0 && companionWrote
				? `${fresh}/${loads.length} fresh; ${placeholders}× the client loaded the install-time file although the companion had rewritten it`
				: `${fresh}/${loads.length} fresh, data age p95 ${ms(age?.p95)}, LoadAddOn 2 KB p95 ${ms(small?.p95, 2)}${big ? `, 1 MB ${ms(big.cost, 1)}` : ""}`;
	}
	return {
		ok,
		text: verdict,
		section: {
			title: "Downlink: load-on-demand slots",
			body: [
				"The companion rewrites every slot's `data.lua` every 5 seconds (the 128 KB and 1 MB slots every 30 seconds); the addon loads one with `C_AddOns.LoadAddOn`. *fresh*: the data was written after the game started and is current; *placeholder*: the client loaded the file as installed. *Data age* is how old the data was when it was loaded. *Load cost* is paid inside one frame. A slot loads once per UI session; `/reload` frees them.",
				"",
				tableMd(
					["Slot", "Size", "Result", "Data age", "Load cost"],
					loads.map((l) => [
						l.slot,
						bytes(l.size),
						l.result,
						l.age === undefined ? "–" : ms(l.age),
						ms(l.cost, 2),
					]),
				),
			].join("\n"),
		},
	};
}

// Doorbells -----------------------------------------------------------------------

/** How the addon tells a raised doorbell from a silent one, as Probe.lua names it. */
const METHODS: Record<string, string> = {
	return: "PlaySoundFile result",
	duration: "sound length",
};

interface Bells {
	heard: number;
	missed: number;
	early: number;
	latency: number[];
	contexts: Map<string, number>;
}

/** Matches the doorbells the addon heard with the ones the companion raised. */
function bellsOf(session: Session, all: LogEvent[]): Bells {
	const raises = all.filter((e) => e.ev === "bell");
	const result: Bells = {
		heard: 0,
		missed: 0,
		early: 0,
		latency: [],
		contexts: new Map(),
	};
	const listening = num(session.data.listening) ?? session.from;
	for (const entry of list(session.data.bells).map(String)) {
		const [n = 0, seen = 0] = entry.split(",").map(Number);
		const context = entry.split(",")[2] ?? "-";
		const before = raises.filter(
			(e) => Number(e.n) === n && Number(e.raised) <= seen + 1000,
		);
		const raised = before.at(-1);
		if (!raised) {
			result.early++;
			continue;
		}
		result.heard++;
		count(result.contexts, context);
		// A doorbell raised before the addon listened waited for the login, not the doorbell.
		if (Number(raised.raised) >= listening)
			result.latency.push(seen - Number(raised.raised));
	}
	// The companion silences every doorbell when the game starts or closes: one raised before
	// that belongs to the previous client process and cannot be missed by this session.
	const silenced = Math.max(
		session.from,
		...all.filter((e) => e.ev === "reset" && e.t <= listening).map((e) => e.t),
	);
	const next = num(session.data.nextSignal);
	if (next !== undefined)
		result.missed = raises.filter(
			(e) =>
				Number(e.n) >= next &&
				Number(e.raised) >= silenced &&
				Number(e.raised) <= session.to - 7000,
		).length;
	return result;
}

// Fonts ---------------------------------------------------------------------------

interface FontRead {
	where: string;
	context: string;
	slot: number;
	start: number;
	set: number;
	ready: number;
	readyFrames: number;
	decode: number;
	decodeFrames: number;
	cost: number;
	epoch: number;
	counter: number;
	written: number;
	result: string;
	dev: number;
}

/** A Font.Format record. */
function fontRead(record: string, where: string, context = "-"): FontRead {
	const f = record.split(",");
	const n = (i: number) => Number(f[i] ?? 0);
	return {
		where,
		context,
		slot: n(0),
		start: n(1),
		set: n(2),
		ready: n(4),
		readyFrames: n(5),
		decode: n(6),
		decodeFrames: n(7),
		cost: n(8),
		epoch: n(9),
		counter: n(10),
		written: n(11),
		result: f[12] ?? "?",
		dev: n(13),
	};
}

/** Every font the companion wrote, per slot, oldest first. */
type FontWrites = Map<number, { epoch: number; counter: number; at: number }[]>;

function fontWritesOf(events: LogEvent[]): FontWrites {
	const writes: FontWrites = new Map();
	for (const e of events)
		if (e.ev === "fonts")
			for (const [slot = 0, counter = 0, at = 0] of (e.writes as number[][]) ??
				[]) {
				const list = writes.get(slot) ?? [];
				list.push({ epoch: Number(e.epoch), counter, at });
				writes.set(slot, list);
			}
	return writes;
}

/**
 * ok: decoded, and at least as new as the last data the companion wrote a second before the
 * read began. stale: decoded but older, the client kept an earlier version. waiting: the
 * install-time file because the companion had not written this font yet; not a failure.
 */
function judgeFont(read: FontRead, writes: FontWrites): string {
	const before = (writes.get(read.slot) ?? [])
		.filter((w) => w.at < read.start - 1000)
		.at(-1);
	if (read.result === "ok")
		return !before ||
			(before.epoch === read.epoch && before.counter <= read.counter)
			? "ok"
			: "stale";
	if (read.result === "placeholder")
		return before ? "placeholder although written" : "waiting";
	return read.result;
}

/** Font records of a session's soak; the first one is the read right after login. */
function sessionFonts(session: Session): FontRead[] {
	return list(session.data.soak)
		.map(String)
		.filter((r) => r.startsWith("F|"))
		.map((r, i) => {
			const [, context = "-", , detail = ""] = r.split("|");
			return fontRead(detail, i === 0 ? "login" : "soak", context);
		});
}

function fontBench(
	session: Session,
	bench: LuaTable,
	writes: FontWrites,
): { ok: boolean | undefined; text: string } {
	const reads = rows(text(bench.fonts)).map((r) => fontRead(r, "bench"));
	const until = num(bench.finished) ?? session.to;
	const wrote = [...writes.values()].some((list) =>
		list.some((w) => w.at > session.from && w.at < until),
	);
	const status = reads.map((r) => judgeFont(r, writes));
	const good = status.filter((s) => s === "ok").length;
	const cost = stats(reads.map((r) => r.cost));
	const ready = stats(
		reads.filter((r) => r.result !== "timeout").map((r) => r.ready),
	);
	const dev = Math.max(0, ...reads.map((r) => r.dev));
	if (reads.length === 0) return { ok: undefined, text: "not measured" };
	if (!wrote && good === 0)
		return { ok: undefined, text: "companion did not write the fonts" };
	const problems = new Map<string, number>();
	for (const s of status) if (s !== "ok") count(problems, s);
	return {
		ok: good === reads.length && (cost?.p95 ?? 0) < 2,
		text: `${good}/${reads.length} decoded and current${problems.size ? ` (${listing(problems)})` : ""}, font ready p95 ${ms(ready?.p95)}, cost per frame p95 ${ms(cost?.p95, 2)}, largest deviation ${dev.toFixed(3)}`,
	};
}

function fontSection(
	sessions: Session[],
	bench: LuaTable | undefined,
	writes: FontWrites,
	events: LogEvent[],
): Section {
	const reads = [
		...rows(text(bench?.fonts)).map((r) => fontRead(r, "bench")),
		...sessions.flatMap(sessionFonts),
	].sort((a, b) => a.start - b.start);
	// A client process starts the bank over: its first read shows whether a used font name
	// gives new data again.
	const processes: number[] = [];
	let restart =
		"not tested yet: quit WoW completely and start it again during the test";
	for (const session of sessions) {
		const process = num(session.data.fontProcess);
		if (process === undefined || processes.includes(process)) continue;
		processes.push(process);
		const first = sessionFonts(session)[0];
		if (processes.length > 1 && first)
			restart = `${judgeFont(first, writes) === "ok" ? "current" : judgeFont(first, writes)} (slot ${first.slot})`;
	}
	const failed = new Map<string, number>();
	for (const e of events)
		if (e.ev === "fonts")
			for (const [, code] of (e.failed as (number | string)[][]) ?? [])
				count(failed, String(code));
	const written = [...writes.values()].reduce((n, list) => n + list.length, 0);
	return {
		title: "Downlink: font bank",
		body: [
			"The companion rewrites the 256 fonts in `FamiliarSpike/fonts` one after another, two per second; each holds 512 bytes in the widths of its glyphs. The addon sets a font it has not used in this client process and measures every glyph: eight in a row in the benchmark, one after every login and one every 2 minutes while you play. *Font ready* is how long the client took until the font measured right, *cost per frame* the longest our measuring took in one frame. *Deviation* is how far a measured byte was from a whole number; up to 0.5 still reads correctly. *Data age* is how old the data was when the addon began.",
			"",
			reads.length
				? tableMd(
						[
							"Time",
							"Read",
							"Context",
							"Font",
							"Result",
							"Font ready",
							"Measuring",
							"Cost per frame",
							"Deviation",
							"Data age",
						],
						reads
							.slice(-40)
							.map((r) => [
								time(r.start),
								r.where,
								r.context,
								r.slot,
								judgeFont(r, writes),
								`${ms(r.ready)} / ${nFrames(r.readyFrames)}`,
								`${ms(r.decode)} / ${nFrames(r.decodeFrames)}`,
								ms(r.cost, 2),
								r.dev.toFixed(3),
								r.result === "ok" ? ms(r.start - r.written) : "–",
							]),
					)
				: "No font read yet.",
			"",
			`Client processes seen: ${processes.length}. First font after a client restart: ${restart}.`,
			"",
			`The companion wrote ${written} fonts${failed.size ? `; replacing a font failed ${listing(failed)} (the client may keep fonts it loaded open)` : ""}.`,
		].join("\n"),
	};
}

// Screenshots -----------------------------------------------------------------------

interface ShotTake {
	epoch: number;
	seq: number;
	variant: string;
	format: string;
	called: number;
	done: number | undefined;
	result: string;
	drawCost: number;
	frames: number;
	worst: number;
	file?: LogEvent;
}

interface ShotRun {
	data: LuaTable;
	takes: ShotTake[];
}

/** A Shot.Take record. */
function shotTake(record: string, epoch: number): ShotTake {
	const f = record.split(",");
	return {
		epoch,
		seq: Number(f[0]),
		variant: f[1] ?? "?",
		format: f[2] ?? "?",
		called: Number(f[4]),
		done: numOrUndefined(f[6]),
		result: f[7] ?? "?",
		drawCost: Number(f[8]),
		frames: Number(f[9]),
		worst: Number(f[10]),
	};
}

/** The addon's screenshot runs, each picture joined with the file the companion read. */
function shotRunsOf(
	sessions: Session[],
	events: LogEvent[],
): { runs: ShotRun[]; others: number; unmatched: number } {
	const files = events.filter((e) => e.ev === "shot");
	const used = new Set<LogEvent>();
	const runs = sessions.flatMap((session) =>
		list(session.data.shots).map((value) => {
			const data = table(value) ?? {};
			const takes = rows(text(data.shots)).map((r) =>
				shotTake(r, session.epoch),
			);
			return { data, takes };
		}),
	);
	const takes = runs.flatMap((run) => run.takes);
	for (const take of takes) {
		take.file = files.find(
			(e) =>
				!used.has(e) &&
				e.epoch === take.epoch &&
				e.seq === take.seq &&
				e.found === true,
		);
		if (take.file) used.add(take.file);
	}
	// A picture whose header did not read: match it by time.
	for (const take of takes) {
		if (take.file) continue;
		take.file = files.find(
			(e) =>
				!used.has(e) &&
				Number(e.mtime) >= take.called - 1000 &&
				Number(e.mtime) <= (take.done ?? take.called) + 3000,
		);
		if (take.file) used.add(take.file);
	}
	const rest = files.filter((e) => !used.has(e));
	return {
		runs,
		others: rest.filter((e) => !e.found).length,
		unmatched: rest.filter((e) => e.found).length,
	};
}

const decoded = (take: ShotTake) => take.file?.ok === true;

/** "jpeg: A 2/2, B 1/2; png: E 2/2" in the order the formats were taken. */
function shotSummary(takes: ShotTake[]): string {
	const formats = [...new Set(takes.map((t) => t.format))];
	return formats
		.map((format) => {
			const own = takes.filter((t) => t.format === format);
			const variants = [...new Set(own.map((t) => t.variant))].sort();
			return `${format}: ${variants
				.map((v) => {
					const of = own.filter((t) => t.variant === v);
					return `${v} ${of.filter(decoded).length}/${of.length}`;
				})
				.join(", ")}`;
		})
		.join("; ");
}

function shotBench(runs: ShotRun[]): { ok: boolean | undefined; text: string } {
	const takes = runs.flatMap((run) => run.takes);
	if (takes.length === 0)
		return {
			ok: undefined,
			text: runs.some((run) => text(run.data.result))
				? (text(runs[0]?.data.result) ?? "not measured")
				: "not measured: type `/fspike shots`",
		};
	if (!takes.some((t) => t.file))
		return {
			ok: false,
			text: `no screenshot reached the companion (client said: ${[...new Set(takes.map((t) => t.result))].join(", ")})`,
		};
	// The player's own format decides; PNG is a setting we could ask players to change.
	const own = text(runs.at(-1)?.data.format) ?? takes[0]?.format;
	const mine = takes.filter((t) => t.format === own);
	const variants = [...new Set(mine.map((t) => t.variant))];
	const ok = variants.some((v) =>
		mine.filter((t) => t.variant === v).every(decoded),
	);
	const latency = stats(
		takes.flatMap((t) => (t.file ? [Number(t.file.mtime) - t.called] : [])),
	);
	const worst = stats(takes.map((t) => t.worst));
	return {
		ok,
		text: `${shotSummary(takes)}; call → file p95 ${ms(latency?.p95)}, worst frame p95 ${ms(worst?.p95)}`,
	};
}

function shotSection(
	runs: ShotRun[],
	others: number,
	unmatched: number,
): Section {
	const takes = runs.flatMap((run) => run.takes);
	const result = (t: ShotTake) => {
		const f = t.file;
		if (!f) return "no file";
		if (f.ok) return "✔";
		if (!f.found) return `✘ block not found, kept as ${f.file}`;
		return f.bitErrors === undefined
			? "✘ header unreadable"
			: `✘ ${f.bitErrors} of ${f.bits} bits wrong`;
	};
	return {
		title: "Uplink: screenshots",
		body: [
			"The addon draws a block of 258 × 34 cells of 4 pixels into the top-left corner, calls `Screenshot()` and hides the block once the client reports the file saved. The companion decodes the picture, keeps the corner in `shots/` of the data folder and deletes the picture; screenshots without the block stay untouched. First in your own format, then in PNG if the addon may switch the format (it switches back right after). *A* has cells of 8 px, black or white (256 B); *B* 4 px, black or white (1 KB); *C* 4 grey levels (2 KB); *D* 8 grey levels (3 KB); *E* one byte per colour (24 KB, PNG only). *Shown* counts the frames the block stayed up after the call, *worst frame* is the longest frame from the call until a second after. *File → read* includes a quarter second in which the companion waits for the file to stop changing.",
			"",
			...runs.map((run) => {
				const d = run.data;
				return `- Run at ${time(num(d.started) ?? 0)}: format ${text(d.format) ?? "?"}, quality ${text(d.quality) ?? "?"}; Blizzard's message off: ${num(d.quiet) === 1 ? "yes" : "no"}; PNG: ${text(d.png) ?? "–"}${text(d.png) === "switched" ? (num(d.restored) === 1 ? ", restored" : ", NOT restored") : ""}; screen ${text(d.geometry) ?? "?"}.`;
			}),
			"",
			takes.length
				? tableMd(
						[
							"Picture",
							"Variant",
							"Format",
							"Client",
							"Decoded",
							"Call → file",
							"File → read",
							"Shown",
							"Worst frame",
							"Drawing",
						],
						takes.map((t) => [
							t.seq,
							t.variant,
							t.format,
							t.result,
							result(t),
							t.file ? ms(Number(t.file.mtime) - t.called) : "–",
							t.file ? ms(Number(t.file.seen) - Number(t.file.mtime)) : "–",
							nFrames(t.frames),
							ms(t.worst),
							ms(t.drawCost, 1),
						]),
					)
				: "No screenshots yet.",
			"",
			`${others} screenshot${others === 1 ? "" : "s"} without the block ${others === 1 ? "was" : "were"} left alone.${unmatched ? ` ${unmatched} of ours belong to results not saved yet.` : ""}`,
		].join("\n"),
	};
}

// Soak ----------------------------------------------------------------------------

interface ContextRow {
	up: Tally;
	laneD: Tally;
	slots: Tally;
	fonts: Tally;
	bells: number;
	skipped: number;
}

interface Soak {
	minutes: number;
	sessions: number;
	up: Tally;
	laneD: Tally;
	slots: Tally;
	fonts: Tally;
	bells: Tally;
	contexts: Map<string, ContextRow>;
	reasons: Map<string, number>;
	upDetect: number[];
	bellLatency: number[];
}

function soakOf(
	sessions: Session[],
	all: LogEvent[],
	fontWrites: FontWrites,
): Soak {
	const soak: Soak = {
		minutes: 0,
		sessions: 0,
		up: tally(),
		laneD: tally(),
		slots: tally(),
		fonts: tally(),
		bells: tally(),
		contexts: new Map(),
		reasons: new Map(),
		upDetect: [],
		bellLatency: [],
	};
	const row = (context: string) => {
		let found = soak.contexts.get(context);
		if (!found) {
			found = {
				up: tally(),
				laneD: tally(),
				slots: tally(),
				fonts: tally(),
				bells: 0,
				skipped: 0,
			};
			soak.contexts.set(context, found);
		}
		return found;
	};
	for (const session of sessions) {
		if (!session.companion) continue;
		const records = list(session.data.soak).map(String);
		const bells = bellsOf(session, all);
		if (records.length === 0 && bells.heard === 0) continue;
		soak.sessions++;
		const times = records
			.map((r) => Number(r.split("|")[2]))
			.filter(Number.isFinite);
		if (times.length > 1)
			soak.minutes += (Math.max(...times) - Math.min(...times)) / 60_000;
		const seen = framesSeen(session, SOAK_STREAM);
		const laneDWrites = session.events
			.filter((e) => e.ev === "lane-d" && Number(e.written) > 0)
			.map((e) => e.t);
		const clientWrites = session.events
			.filter((e) => e.ev === "addons")
			.map((e) => Number(e.mtime));
		let previousD = session.from;
		for (const record of records) {
			const [kind = "", context = "-", atText = "0", detail = ""] =
				record.split("|");
			const at = Number(atText);
			const r = row(context);
			const fail = (t: Tally, rt: Tally, reason: string) => {
				t.failed++;
				rt.failed++;
				count(soak.reasons, reason);
			};
			if (kind === "U") {
				// A frame sent right before logout may not have been read yet.
				if (at > session.to - 4000) continue;
				const e = seen.get(Number(detail));
				if (e) {
					soak.up.ok++;
					r.up.ok++;
					soak.upDetect.push(Number(e.read) - at);
				} else fail(soak.up, r.up, "uplink frame lost");
			} else if (kind === "D") {
				// Every client save writes the client's own copy of lane D back. Nothing new to
				// see is a failure only if the companion wrote a frame after the last client
				// save and after the previous read.
				const lastSave = Math.max(
					previousD,
					...clientWrites.filter((mtime) => mtime < at),
				);
				previousD = at;
				if (detail !== "-") {
					soak.laneD.ok++;
					r.laneD.ok++;
				} else if (laneDWrites.some((t) => t > lastSave && t < at - 300))
					fail(soak.laneD, r.laneD, "lane D frame not seen");
				else r.skipped++;
			} else if (kind === "L") {
				const load = slotLoad(detail);
				if (load.result === "fresh") {
					soak.slots.ok++;
					r.slots.ok++;
				} else fail(soak.slots, r.slots, `slot ${load.result}`);
			} else if (kind === "F") {
				const status = judgeFont(fontRead(detail, "soak"), fontWrites);
				if (status === "ok") {
					soak.fonts.ok++;
					r.fonts.ok++;
				} else if (status === "waiting") r.skipped++;
				else fail(soak.fonts, r.fonts, `font ${status}`);
			} else if (kind === "X") r.skipped++;
		}
		soak.bells.ok += bells.heard;
		soak.bells.failed += bells.missed + bells.early;
		soak.bellLatency.push(...bells.latency);
		if (bells.missed) count(soak.reasons, "doorbell not heard", bells.missed);
		if (bells.early)
			count(soak.reasons, "doorbell heard before it was raised", bells.early);
		for (const [context, n] of bells.contexts) row(context).bells += n;
	}
	return soak;
}

function soakSection(soak: Soak): Section {
	const cell = (t: Tally) =>
		t.ok + t.failed ? `${t.ok}/${t.ok + t.failed}` : "–";
	return {
		title: `Soak: ${soak.minutes.toFixed(0)} min in ${soak.sessions} session(s)`,
		body: [
			"While you play, the addon sends an uplink frame and reads lane D every 30 seconds, loads a slot every 3 minutes, reads a font every 2 minutes and listens for the doorbell the companion raises every 30 seconds. Cells show successful/attempted per context (combat, instance type, addon list open).",
			"",
			soak.contexts.size
				? tableMd(
						[
							"Context",
							"Uplink",
							"Lane D",
							"Slots",
							"Fonts",
							"Doorbells heard",
							"Skipped",
						],
						[...soak.contexts.entries()].map(([context, r]) => [
							context,
							cell(r.up),
							cell(r.laneD),
							cell(r.slots),
							cell(r.fonts),
							r.bells,
							r.skipped,
						]),
					)
				: "No soak rounds yet.",
			"",
			soak.reasons.size
				? `Failures: ${listing(soak.reasons)}.`
				: "No failures.",
		].join("\n"),
	};
}

// Frame times ---------------------------------------------------------------------

const FRAME_BINS = ["<8", "<12", "<17", "<25", "<34", "<50", "<100", "≥100"];
const PHASES = [
	"baseline",
	"idle",
	"up1",
	"up2",
	"up3",
	"up4",
	"up5",
	"laneD",
	"slots",
	"fonts",
	"shots",
	"soak",
];

function frameSection(session: LuaTable): Section {
	const frames = table(session.frames);
	const phases = Object.keys(frames ?? {}).sort((a, b) => {
		const ia = PHASES.indexOf(a);
		const ib = PHASES.indexOf(b);
		return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
	});
	const parsed = phases.map((phase) => {
		const [n = 0, sum = 0, max = 0, ...counts] = (text(frames?.[phase]) ?? "")
			.split(",")
			.map(Number);
		return { phase, n, mean: n ? sum / n : 0, max, counts };
	});
	const baseline = parsed.find((p) => p.phase === "baseline")?.mean;
	const body = parsed.map((p) => [
		p.phase,
		p.n,
		ms(p.mean, 1),
		baseline === undefined || p.phase === "baseline"
			? ""
			: `${p.mean - baseline >= 0 ? "+" : ""}${(p.mean - baseline).toFixed(1)}`,
		ms(p.max, 0),
		pct((p.counts[5] ?? 0) + (p.counts[6] ?? 0) + (p.counts[7] ?? 0), p.n),
		pct((p.counts[6] ?? 0) + (p.counts[7] ?? 0), p.n),
	]);
	const hitches = rows(text(session.hitches))
		.map((row) => row.split(","))
		.map(([, frame, phase, ours, context]) => ({
			frame: Number(frame),
			phase: phase ?? "",
			ours: Number(ours),
			context: context ?? "",
		}))
		.sort((a, b) => b.ours - a.ours)
		.slice(0, 8);
	return {
		title: "Frame times",
		body: [
			`Frame time per phase. *vs. baseline* compares the mean with ten idle seconds before the benchmark. Bins in ms: ${FRAME_BINS.join(", ")}.`,
			"",
			tableMd(
				["Phase", "Frames", "Mean", "vs. baseline", "Max", "≥34 ms", "≥50 ms"],
				body,
			),
			"",
			hitches.length
				? tableMd(
						["Hitch", "Phase", "Our share in previous frame", "Context"],
						hitches.map((h) => [
							ms(h.frame, 0),
							h.phase,
							ms(h.ours, 2),
							h.context,
						]),
					)
				: "No hitches of 50 ms or more.",
		].join("\n"),
	};
}

// What the client wrote -------------------------------------------------------------

function clientSection(events: LogEvent[]): Section {
	const byFile = new Map<string, LogEvent[]>();
	for (const e of events)
		if (e.ev === "addons") {
			const file = String(e.file);
			byFile.set(file, [...(byFile.get(file) ?? []), e]);
		}
	const addons = [...byFile.entries()].map(([file, writes]) => {
		const lane = writes.map((e) => Number(e.rows ?? 0));
		const d = writes.map((e) => Number(e.dRows ?? 0));
		return [
			file,
			writes.length,
			writes.filter((e) => e.frame).length,
			`${Math.min(...lane)}–${Math.max(...lane)}`,
			Math.max(...writes.map((e) => Number(e.on ?? 0))),
			`${Math.min(...d)}–${Math.max(...d)}`,
		];
	});
	const wtf = new Map<
		string,
		{ n: number; last: number; changes: Set<string> }
	>();
	for (const e of events)
		if (e.ev === "wtf") {
			const path = String(e.path);
			const entry = wtf.get(path) ?? { n: 0, last: 0, changes: new Set() };
			entry.n++;
			entry.last = e.t;
			entry.changes.add(String(e.change));
			wtf.set(path, entry);
		}
	const files = [...wtf.entries()].sort((a, b) => b[1].n - a[1].n);
	const laneD = events.filter((e) => e.ev === "lane-d");
	const readErrors = new Map<string, number>();
	for (const e of events)
		if (e.ev === "read-error") count(readErrors, String(e.code));
	return {
		title: "What the client wrote",
		body: [
			"Every write of `AddOns.txt` the companion saw, per character, and every other file the client changed under `WTF`. This explains a channel that stays silent.",
			"",
			addons.length
				? tableMd(
						[
							"AddOns.txt",
							"Client writes",
							"With a valid frame",
							"Lane U rows",
							"Enabled up to",
							"Lane D rows",
						],
						addons,
					)
				: "The client never wrote `AddOns.txt` while the companion ran.",
			"",
			files.length
				? tableMd(
						["Other file under WTF", "Changes", "Kind", "Last"],
						files
							.slice(0, 15)
							.map(([path, f]) => [
								`\`${path}\``,
								f.n,
								[...f.changes].join(", "),
								time(f.last),
							]),
					)
				: "No other file under `WTF` changed.",
			"",
			`Lane D: the companion wrote ${laneD.filter((e) => Number(e.written) > 0).length}×, skipped ${laneD.filter((e) => Number(e.written) === 0).length}× because the client had just written the file.${readErrors.size ? ` Read errors: ${listing(readErrors)}.` : ""}`,
		].join("\n"),
	};
}

function companionSection(events: LogEvent[]): Section {
	const polls = events.filter((e) => e.ev === "poll");
	const p95 = stats(polls.map((e) => Number(e.p95)));
	const worst = Math.max(0, ...polls.map((e) => Number(e.max)));
	const errors = events.filter((e) => e.ev === "error");
	const games = events.filter((e) => e.ev === "game").length;
	return {
		title: "Companion",
		body: [
			`Poll loop: p95 of the 10-second p95 values ${ms(p95?.p95, 1)}, worst single gap ${ms(worst, 0)}. Game process changes seen: ${games}.`,
			"",
			errors.length
				? tableMd(
						["Time", "Where", "Detail"],
						errors
							.slice(0, 20)
							.map((e) => [
								new Date(e.t).toLocaleString(),
								String(e.where ?? ""),
								String(e.message ?? ""),
							]),
					)
				: "No companion errors.",
		].join("\n"),
	};
}

// Report ----------------------------------------------------------------------------

function overall(v: Verdict, minutes: number): boolean | undefined {
	if (v.benchOnly) return v.bench;
	if (v.bench === false || v.soak.failed > 0) return false;
	if (v.bench === true && minutes >= 60 && v.soak.ok > 0) return true;
	return undefined;
}

const soakText = (t: Tally, unit: string) =>
	t.ok + t.failed === 0 ? "–" : `${t.ok}/${t.ok + t.failed} ${unit}`;

/**
 * Sessions the companion got a hello from that are not in the saved results: the game writes
 * them only on /reload or logout. Their uplink frames show how far they got.
 */
function unsavedNote(sessions: Session[], events: LogEvent[]): string[] {
	const saved = new Set(sessions.map((s) => num(s.data.nonce)));
	const hellos = events.filter((e) => e.ev === "hello");
	const lines = hellos.flatMap((hello, k) => {
		if (saved.has(Number(hello.nonce))) return [];
		const until = hellos[k + 1]?.t ?? Number.POSITIVE_INFINITY;
		const frames = events.filter(
			(e) =>
				e.ev === "frame" &&
				e.epoch === hello.epoch &&
				e.t >= hello.t &&
				e.t < until,
		);
		const seqs = new Set(frames.map((e) => Number(e.seq)));
		const last = Math.max(1, ...seqs);
		const end = frames.at(-1)?.t ?? hello.t;
		return [
			`- Session ${hello.epoch} on ${hello.file} (${hello.reload ? "reload" : "login"}, ${time(hello.t)}–${time(end)}): ${seqs.size} uplink frames arrived, ${last - seqs.size} of 1–${last} missing.`,
		];
	});
	if (lines.length === 0) return [];
	return [
		"⚠ **Results not saved yet.** The companion saw these sessions, but the game has not written their results. WoW writes them on `/reload` or logout: type `/reload` in game, then run `familiar-spike report`.",
		"",
		...lines,
		"",
	];
}

export function buildReport(dataDir: string, now = new Date()): string {
	const events = readLogs(dataDir);
	const saved = loadSaved(dataDir);
	const sessions = sessionsOf(saved, events);
	const runs = events.filter((e) => e.ev === "companion");
	const platforms = [...new Set(runs.map((e) => String(e.platform)))].join(
		", ",
	);
	const out: string[] = [
		"# Transport spike report (FAM-15)",
		"",
		`Generated ${now.toLocaleString()}. ${sessions.length} addon session(s) in ${saved.length} account(s), ${runs.length} companion run(s)${platforms ? ` on ${platforms}` : ""}, ${events.length} companion events.`,
		"",
		...unsavedNote(sessions, events),
	];
	if (sessions.length === 0) {
		out.push(
			"No saved addon results yet. Type `/reload` in game (or log out) so the client writes them.",
			"",
			clientSection(events).body,
		);
		return `${out.join("\n")}\n`;
	}

	const latest = sessions.at(-1);
	const benched = sessions.filter((s) => table(s.data.bench)).at(-1);
	const bench = table(benched?.data.bench);
	const sections: Section[] = [];
	const doorbell =
		text(bench?.doorbell) ?? text(latest?.data.doorbell) ?? "not tested";
	const method = METHODS[doorbell];
	const sound = text(bench?.sound) ?? text(latest?.data.sound) ?? "–";
	sections.push({
		title: "Setup",
		body: [
			`Build ${text(latest?.data.build) ?? "?"}. Self-test: ${text(bench?.selftest) ?? text(latest?.data.selftest) ?? "–"}.`,
			"",
			`Sound probe (\`PlaySoundFile\` result / \`C_Sound.IsPlaying\` 0.3 s and 0.8 s later, one digit each; - means no handle): \`${sound}\`. *empty* is a 0-byte file, *valid* 10 ms and *long* 1.5 s of silence, *missing* does not exist. *secure* is 1 while \`PlaySoundFile\` is Blizzard's own function, otherwise the addon that replaced it.`,
			"",
			`Doorbell method: ${method ?? doorbell}. *PlaySoundFile result*: an empty file fails to play, a raised one plays. *Sound length*: both play, but only a raised one is still playing a quarter second later.`,
		].join("\n"),
	});

	const fontWrites = fontWritesOf(events);
	const soak = soakOf(sessions, events, fontWrites);
	const shots = shotRunsOf(sessions, events);
	const verdicts: Verdict[] = [];
	if (benched && bench) {
		const up = uplinkBench(benched, bench);
		const laneD = laneDBench(benched, bench);
		const slots = slotBench(benched, bench);
		const fonts = fontBench(benched, bench, fontWrites);
		verdicts.push(
			{
				channel: "Uplink: AddOns.txt lane U (SaveAddOns)",
				bench: up.ok,
				benchText: up.text,
				soak: soak.up,
				soakText: soakText(soak.up, "frames"),
			},
			{
				channel: "Downlink: AddOns.txt lane D (ResetAddOns)",
				bench: laneD.ok,
				benchText: laneD.text,
				soak: soak.laneD,
				soakText: soakText(soak.laneD, "reads"),
			},
			{
				channel: "Downlink: load-on-demand slot (LoadAddOn)",
				bench: slots.ok,
				benchText: slots.text,
				soak: soak.slots,
				soakText: soakText(soak.slots, "fresh"),
			},
			{
				channel: "Downlink: font bank (SetFont)",
				bench: fonts.ok,
				benchText: fonts.text,
				soak: soak.fonts,
				soakText: soakText(soak.fonts, "current"),
			},
		);
		sections.push(up.section, laneD.section, slots.section);
	} else {
		for (const [channel, tallied, unit] of [
			["Uplink: AddOns.txt lane U (SaveAddOns)", soak.up, "frames"],
			["Downlink: AddOns.txt lane D (ResetAddOns)", soak.laneD, "reads"],
			["Downlink: load-on-demand slot (LoadAddOn)", soak.slots, "fresh"],
			["Downlink: font bank (SetFont)", soak.fonts, "current"],
		] as const)
			verdicts.push({
				channel,
				bench: undefined,
				benchText: "no benchmark yet: type `/fspike bench`",
				soak: tallied,
				soakText: soakText(tallied, unit),
			});
	}
	const bellLatency = stats(soak.bellLatency);
	verdicts.push({
		channel: "Doorbell: .wav made playable (PlaySoundFile)",
		bench: method
			? soak.bells.ok + soak.bells.failed === 0
				? undefined
				: (bellLatency?.p95 ?? 0) < 1000
			: doorbell.includes("game sound off") || doorbell === "not tested"
				? undefined
				: false,
		benchText: method
			? `${method}; raise → heard p95 ${ms(bellLatency?.p95)}`
			: doorbell,
		soak: soak.bells,
		soakText: soakText(soak.bells, "heard"),
	});
	const shot = shotBench(shots.runs);
	verdicts.push({
		channel: "Uplink: screenshot (Screenshot)",
		bench: shot.ok,
		benchText: shot.text,
		soak: tally(),
		soakText: "on demand only",
		benchOnly: true,
	});

	sections.push(
		fontSection(sessions, bench, fontWrites, events),
		shotSection(shots.runs, shots.others, shots.unmatched),
		soakSection(soak),
	);
	if (benched) sections.push(frameSection(benched.data));
	sections.push(clientSection(events), companionSection(events));
	const errors = sessions.flatMap((s) => list(s.data.errors).map(String));
	if (errors.length)
		sections.push({
			title: "Addon errors",
			body: errors.map((e) => `- \`${e}\``).join("\n"),
		});

	out.push(
		"## Verdict",
		"",
		tableMd(
			["", "Channel", "Benchmark", "Soak"],
			verdicts.map((v) => [
				mark(overall(v, soak.minutes)),
				v.channel,
				v.benchText,
				v.soakText,
			]),
		),
		"",
		`Soak so far: ${soak.minutes.toFixed(0)} of 60 minutes. Thresholds: uplink loss-free at ≥33 ms spacing, detect p95 < 250 ms, write cost p95 < 2 ms; lane D sees every frame, latency p95 < 1 s, ResetAddOns cost p95 < 2 ms; every slot load fresh; every font read decoded and current, cost per frame p95 < 2 ms; doorbell raise → heard p95 < 1 s once the addon listens after login; no failures in a soak of at least 60 minutes. Screenshots run on demand only and are judged on the benchmark: one variant decodes in every picture in your own format. \`?\` means not enough data yet.`,
		"",
	);
	for (const section of sections)
		out.push(`## ${section.title}`, "", section.body, "");
	return `${out.join("\n").trimEnd()}\n`;
}
