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
	const next = num(session.data.nextSignal);
	if (next !== undefined)
		result.missed = raises.filter(
			(e) =>
				Number(e.n) >= next &&
				Number(e.raised) >= session.from &&
				Number(e.raised) <= session.to - 7000,
		).length;
	return result;
}

// Soak ----------------------------------------------------------------------------

interface ContextRow {
	up: Tally;
	laneD: Tally;
	slots: Tally;
	bells: number;
	skipped: number;
}

interface Soak {
	minutes: number;
	sessions: number;
	up: Tally;
	laneD: Tally;
	slots: Tally;
	bells: Tally;
	contexts: Map<string, ContextRow>;
	reasons: Map<string, number>;
	upDetect: number[];
	bellLatency: number[];
}

function soakOf(sessions: Session[], all: LogEvent[]): Soak {
	const soak: Soak = {
		minutes: 0,
		sessions: 0,
		up: tally(),
		laneD: tally(),
		slots: tally(),
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
			"While you play, the addon sends an uplink frame and reads lane D every 30 seconds, loads a slot every 3 minutes and listens for the doorbell the companion raises every 30 seconds. Cells show successful/attempted per context (combat, instance type, addon list open).",
			"",
			soak.contexts.size
				? tableMd(
						[
							"Context",
							"Uplink",
							"Lane D",
							"Slots",
							"Doorbells heard",
							"Skipped",
						],
						[...soak.contexts.entries()].map(([context, r]) => [
							context,
							cell(r.up),
							cell(r.laneD),
							cell(r.slots),
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

	const soak = soakOf(sessions, events);
	const verdicts: Verdict[] = [];
	if (benched && bench) {
		const up = uplinkBench(benched, bench);
		const laneD = laneDBench(benched, bench);
		const slots = slotBench(benched, bench);
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
		);
		sections.push(up.section, laneD.section, slots.section);
	} else {
		for (const [channel, tallied, unit] of [
			["Uplink: AddOns.txt lane U (SaveAddOns)", soak.up, "frames"],
			["Downlink: AddOns.txt lane D (ResetAddOns)", soak.laneD, "reads"],
			["Downlink: load-on-demand slot (LoadAddOn)", soak.slots, "fresh"],
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

	sections.push(soakSection(soak));
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
		`Soak so far: ${soak.minutes.toFixed(0)} of 60 minutes. Thresholds: uplink loss-free at ≥33 ms spacing, detect p95 < 250 ms, write cost p95 < 2 ms; lane D sees every frame, latency p95 < 1 s, ResetAddOns cost p95 < 2 ms; every slot load fresh; doorbell raise → heard p95 < 1 s once the addon listens after login; no failures in a soak of at least 60 minutes. \`?\` means not enough data yet.`,
		"",
	);
	for (const section of sections)
		out.push(`## ${section.title}`, "", section.body, "");
	return `${out.join("\n").trimEnd()}\n`;
}
