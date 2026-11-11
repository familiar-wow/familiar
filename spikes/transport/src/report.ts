// Joins the addon's SavedVariables with the companion log and renders report.md.
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
	mean: number;
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
		mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
	};
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
	value === undefined || value === "-" ? undefined : Number(value);

function tableMd(head: string[], body: (string | number)[][]): string {
	const line = (cells: (string | number)[]) => `| ${cells.join(" | ")} |`;
	return [line(head), line(head.map(() => "---")), ...body.map(line)].join(
		"\n",
	);
}

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

/** Companion events that belong to one addon session: same epoch, inside its lifetime. */
function eventsOf(events: LogEvent[], session: LuaTable): LogEvent[] {
	const epoch = num(session.epoch);
	const from = (num(session.started) ?? 0) * 1000 - 2000;
	const to = (num(session.ended) ?? Number.POSITIVE_INFINITY) + 5000;
	return events.filter((e) => e.epoch === epoch && e.t >= from && e.t <= to);
}

const FRAME_BINS = ["<8", "<12", "<17", "<25", "<34", "<50", "<100", "≥100"];

interface Section {
	title: string;
	body: string;
}

interface Verdict {
	channel: string;
	ok: boolean | undefined;
	summary: string;
}

function uplinkSection(
	bench: LuaTable,
	events: LogEvent[],
	verdicts: Verdict[],
): Section {
	const up = table(bench.up);
	const body: (string | number)[][] = [];
	let lossFree = true;
	let cost95 = 0;
	let detect95 = 0;
	let streams = 0;
	for (const stream of ["1", "2", "3", "4"]) {
		const run = table(up?.[stream]);
		if (!run) continue;
		streams++;
		const seen = new Map<number, LogEvent>();
		for (const e of events)
			if (e.ev === "frame" && e.kind === "data" && e.stream === Number(stream))
				seen.set(Number(e.index), e);
		const sends = rows(text(run.sends)).map((row) =>
			row.split(",").map(Number),
		);
		const detect: number[] = [];
		const fileLag: number[] = [];
		const cost: number[] = [];
		let corrupt = 0;
		for (const [index = 0, sent = 0, toggle = 0, save = 0] of sends) {
			cost.push(toggle + save);
			const e = seen.get(index);
			if (!e) continue;
			if (e.ok === false) corrupt++;
			detect.push(Number(e.read) - sent);
			fileLag.push(Number(e.mtime) - sent);
		}
		const first = sends[0]?.[1] ?? 0;
		const last = sends.at(-1)?.[1] ?? 0;
		const seconds = Math.max(0.001, (last - first) / 1000);
		const lost = sends.length - detect.length;
		if (lost > 0 && Number(stream) > 1) lossFree = false;
		const d = stats(detect);
		const c = stats(cost);
		if (Number(stream) >= 3) {
			detect95 = Math.max(detect95, d?.p95 ?? 0);
			cost95 = Math.max(cost95, c?.p95 ?? 0);
		}
		const interval = num(run.interval) ?? 0;
		body.push([
			interval === 0 ? "every frame" : `${Math.round(interval * 1000)} ms`,
			`${detect.length}/${sends.length}`,
			pct(lost, sends.length),
			corrupt,
			`${(sends.length / seconds).toFixed(1)}/s`,
			`${((detect.length * 20) / seconds).toFixed(0)} B/s`,
			trio(d),
			trio(stats(fileLag)),
			trio(c, 2),
		]);
	}
	const ok =
		streams === 0 ? undefined : lossFree && detect95 < 250 && cost95 < 2;
	verdicts.push({
		channel: "Uplink: AddOns.txt lane (SaveAddOns)",
		ok,
		summary:
			streams === 0
				? "not measured"
				: `${lossFree ? "no loss at ≥33 ms spacing" : "frames lost"}, detect p95 ${ms(detect95)}, write cost p95 ${ms(cost95, 2)}`,
	});
	return {
		title: "Uplink: AddOns.txt lane",
		body: [
			"The addon flips 256 helper enable states and calls `C_AddOns.SaveAddOns()`; the companion reads `AddOns.txt`.",
			"*Detect* runs from the start of the write to the companion's read (two clocks, ± one frame). *File lag* is the file's mtime minus the start of the write. *Write cost* is the time inside the toggle and save calls, which the frame pays for. Payload per frame: 20 bytes.",
			"",
			tableMd(
				[
					"Spacing",
					"Seen",
					"Lost",
					"Corrupt",
					"Rate",
					"Payload",
					"Detect p50/p95/max",
					"File lag p50/p95/max",
					"Write cost p50/p95/max",
				],
				body,
			),
		].join("\n"),
	};
}

function signalSection(
	bench: LuaTable,
	events: LogEvent[],
	verdicts: Verdict[],
): Section {
	const companion = new Map<number, LogEvent>();
	for (const e of events)
		if (e.ev === "signal") companion.set(Number(e.sig), e);
	const roundTrip: number[] = [];
	const handling: number[] = [];
	const ring: number[] = [];
	const pollCost: number[] = [];
	let missed = 0;
	const records = rows(text(bench.signals)).filter((row) => row !== "-");
	for (const row of records) {
		const [sig, requested, seen, , worst] = row.split(",");
		const seenAt = numOrUndefined(seen);
		pollCost.push(Number(worst));
		if (seenAt === undefined) {
			missed++;
			continue;
		}
		roundTrip.push(seenAt - Number(requested));
		const e = companion.get(Number(sig));
		if (e) {
			handling.push(Number(e.raised) - Number(e.read));
			ring.push(seenAt - Number(e.raised));
		}
	}
	const rt = stats(roundTrip);
	verdicts.push({
		channel: "Doorbell: .wav made playable (PlaySoundFile)",
		ok: records.length === 0 ? undefined : missed === 0 && (rt?.p95 ?? 0) < 500,
		summary:
			records.length === 0
				? "not measured"
				: `${records.length - missed}/${records.length} seen, round trip p95 ${ms(rt?.p95)}`,
	});
	return {
		title: "Doorbells",
		body: [
			"The addon requests a doorbell over the uplink and polls `PlaySoundFile` every frame until the file plays. *Round trip* is measured on the addon clock alone.",
			"",
			tableMd(
				[
					"Rounds",
					"Missed",
					"Round trip p50/p95/max",
					"Companion handling",
					"Raise → heard",
					"Poll cost p50/p95/max",
				],
				[
					[
						records.length,
						missed,
						trio(rt),
						trio(stats(handling), 1),
						trio(stats(ring)),
						trio(stats(pollCost), 3),
					],
				],
			),
		].join("\n"),
	};
}

function slotSection(
	bench: LuaTable,
	events: LogEvent[],
	verdicts: Verdict[],
): Section {
	const companion = new Map<string, LogEvent>();
	for (const e of events)
		if (e.ev === "slot") companion.set(`${e.slot}:${e.sig}`, e);
	const body: (string | number)[][] = [];
	let fresh = 0;
	let total = 0;
	let worstSmall = 0;
	const answer2k: number[] = [];
	for (const row of rows(text(bench.slots)).filter((r) => r !== "-")) {
		const [slot, size, sig, requested, signaled, loaded, loadMs, , result] =
			row.split(",");
		total++;
		if (result === "fresh") fresh++;
		const e = companion.get(`${slot}:${sig}`);
		const loadedAt = numOrUndefined(loaded);
		const sizeBytes = Number(size);
		if (sizeBytes <= 16384) worstSmall = Math.max(worstSmall, Number(loadMs));
		if (sizeBytes === 2048 && loadedAt !== undefined)
			answer2k.push(loadedAt - Number(requested));
		body.push([
			sizeBytes >= 1024
				? `${Math.round(sizeBytes / 1024)} KB`
				: `${sizeBytes} B`,
			result ?? "?",
			loadedAt === undefined ? "–" : ms(loadedAt - Number(requested)),
			numOrUndefined(signaled) === undefined
				? "–"
				: ms(Number(signaled) - Number(requested)),
			ms(Number(loadMs), 2),
			e ? ms(Number(e.writeMs), 1) : "–",
		]);
	}
	const placeholder = text(bench.placeholder)?.split(",");
	const worst2k = Math.max(0, ...answer2k);
	verdicts.push({
		channel: "Downlink: load-on-demand slot (LoadAddOn)",
		ok:
			total === 0
				? undefined
				: fresh === total &&
					placeholder?.[2] === "placeholder" &&
					answer2k.length > 0 &&
					worst2k < 5000,
		summary:
			total === 0
				? "not measured"
				: `${fresh}/${total} fresh, 2 KB answer in up to ${ms(worst2k)}, LoadAddOn ≤16 KB costs up to ${ms(worstSmall, 1)}`,
	});
	return {
		title: "Slots",
		body: [
			"The companion writes `data.lua` into an unused load-on-demand addon and rings a doorbell; the addon loads it. *Load cost* is the `LoadAddOn` call, paid inside one frame.",
			"",
			tableMd(
				[
					"Size",
					"Result",
					"Request → loaded",
					"Request → doorbell",
					"Load cost",
					"Companion write",
				],
				body,
			),
			"",
			placeholder
				? `Untouched slot ${placeholder[0]}: \`${placeholder[2]}\` (load cost ${ms(Number(placeholder[1]), 2)}). Expected: \`placeholder\`.`
				: "Untouched slot: not measured.",
		].join("\n"),
	};
}

function downlinkSection(
	bench: LuaTable,
	events: LogEvent[],
	verdicts: Verdict[],
): Section {
	const dl = table(bench.dl);
	if (!dl) {
		verdicts.push({
			channel: "Downlink: AddOns.txt lane (ResetAddOns)",
			ok: undefined,
			summary: "not measured",
		});
		return { title: "Downlink: AddOns.txt lane", body: "Not measured." };
	}
	const result = text(dl.result) ?? "?";
	const bytes = num(dl.bytes) ?? 0;
	const frames = num(dl.frames) ?? 0;
	const seconds = ((num(dl.finished) ?? 0) - (num(dl.started) ?? 0)) / 1000;
	const done = events.find((e) => e.ev === "dl-done");
	const writes = events.filter((e) => e.ev === "dl-write").length;
	const parse = (value: string | undefined) => {
		const [n, rest] = (value ?? "0").split(":");
		const [p50, p95, max] = (rest ?? "").split("/");
		return n === "0" ? "–" : `${p50} / ${p95} / ${max} ms (${n} calls)`;
	};
	verdicts.push({
		channel: "Downlink: AddOns.txt lane (ResetAddOns)",
		ok: result === "ok" && seconds < 5,
		summary:
			result === "ok"
				? `${bytes} B in ${seconds.toFixed(1)} s (${(bytes / Math.max(seconds, 0.001)).toFixed(0)} B/s)`
				: `${result} after ${frames} frames`,
	});
	return {
		title: "Downlink: AddOns.txt lane",
		body: [
			"The companion rewrites lane D in `AddOns.txt`; the addon calls `C_AddOns.ResetAddOns()` every frame and acks each frame over the uplink. This only works if `ResetAddOns` re-reads the file.",
			"",
			tableMd(
				[
					"Result",
					"Frames",
					"Bytes",
					"Duration",
					"Re-acks",
					"Lane writes",
					"ResetAddOns cost p50/p95/max",
					"Read cost p50/p95/max",
				],
				[
					[
						result,
						`${frames}${done ? `/${done.frames}` : ""}`,
						bytes,
						`${seconds.toFixed(1)} s`,
						num(dl.reacks) ?? 0,
						writes,
						parse(text(dl.reset)),
						parse(text(dl.read)),
					],
				],
			),
		].join("\n"),
	};
}

function frameSection(session: LuaTable): Section {
	const frames = table(session.frames);
	const order = [
		"baseline",
		"idle",
		"up1",
		"up2",
		"up3",
		"up4",
		"signals",
		"slots",
		"dl",
		"soak",
	];
	const phases = Object.keys(frames ?? {}).sort((a, b) => {
		const ia = order.indexOf(a);
		const ib = order.indexOf(b);
		return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
	});
	const parsed = phases.map((phase) => {
		const [n = 0, sum = 0, max = 0, ...counts] = (text(frames?.[phase]) ?? "")
			.split(",")
			.map(Number);
		return { phase, n, mean: n ? sum / n : 0, max, counts };
	});
	const baseline = parsed.find((p) => p.phase === "baseline")?.mean;
	const body = parsed.map((p) => {
		const slow = (p.counts[5] ?? 0) + (p.counts[6] ?? 0) + (p.counts[7] ?? 0);
		return [
			p.phase,
			p.n,
			ms(p.mean, 1),
			baseline === undefined || p.phase === "baseline"
				? ""
				: `${p.mean - baseline >= 0 ? "+" : ""}${(p.mean - baseline).toFixed(1)}`,
			ms(p.max, 0),
			pct(slow, p.n),
			pct((p.counts[6] ?? 0) + (p.counts[7] ?? 0), p.n),
		];
	});
	const hitches = rows(text(session.hitches))
		.map((row) => row.split(","))
		.map(([at, frame, phase, ours, context]) => ({
			at: Number(at),
			frame: Number(frame),
			phase,
			ours: Number(ours),
			context,
		}))
		.sort((a, b) => b.ours - a.ours)
		.slice(0, 8);
	return {
		title: "Frame times",
		body: [
			"Frame time per phase. *vs. baseline* compares the mean with ten idle seconds before the benchmark. Bins in ms: " +
				FRAME_BINS.join(", ") +
				".",
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
							h.phase ?? "",
							ms(h.ours, 2),
							h.context ?? "",
						]),
					)
				: "No hitches of 50 ms or more.",
		].join("\n"),
	};
}

interface Soak {
	section: Section;
	ok: number;
	failed: number;
	minutes: number;
	contexts: string[];
}

function soakSection(session: LuaTable, events: LogEvent[]): Soak | undefined {
	const entries = list(session.soak).map((value) => String(value));
	if (entries.length === 0) return undefined;
	let first = Number.POSITIVE_INFINITY;
	let last = 0;
	const companionSignals = new Set(
		events.filter((e) => e.ev === "signal").map((e) => Number(e.sig)),
	);
	const groups = new Map<
		string,
		{
			ok: number;
			failed: number;
			skipped: number;
			rtt: number[];
			reasons: Map<string, number>;
		}
	>();
	for (const entry of entries) {
		const [kind, context = "-", record = ""] = entry.split("|");
		let group = groups.get(context);
		if (!group) {
			group = { ok: 0, failed: 0, skipped: 0, rtt: [], reasons: new Map() };
			groups.set(context, group);
		}
		const fail = (reason: string) => {
			group.failed++;
			group.reasons.set(reason, (group.reasons.get(reason) ?? 0) + 1);
		};
		const fields = record.split(",");
		const requested = Number(kind === "A" ? fields[3] : fields[1]);
		if (kind !== "X" && requested > 0) {
			first = Math.min(first, requested);
			last = Math.max(last, requested);
		}
		if (kind === "X") {
			group.skipped++;
		} else if (kind === "S") {
			const seen = numOrUndefined(fields[2]);
			if (seen === undefined)
				fail(
					companionSignals.has(Number(fields[0]))
						? "doorbell not heard"
						: "request not seen",
				);
			else {
				group.ok++;
				group.rtt.push(seen - Number(fields[1]));
			}
		} else if (kind === "A") {
			const result = fields[8] ?? "?";
			if (result === "fresh") {
				group.ok++;
				const loaded = numOrUndefined(fields[5]);
				if (loaded !== undefined) group.rtt.push(loaded - Number(fields[3]));
			} else fail(`answer ${result}`);
		}
	}
	let ok = 0;
	let failed = 0;
	const body = [...groups.entries()].map(([context, g]) => {
		ok += g.ok;
		failed += g.failed;
		return [
			context,
			g.ok,
			g.failed,
			g.skipped,
			trio(stats(g.rtt)),
			[...g.reasons.entries()]
				.map(([reason, count]) => `${reason} ×${count}`)
				.join(", ") || "",
		];
	});
	const minutes = last > first ? (last - first) / 60000 : 0;
	return {
		ok,
		failed,
		minutes,
		contexts: [...groups.keys()],
		section: {
			title: `Soak: session ${num(session.epoch)} (${new Date((num(session.started) ?? 0) * 1000).toLocaleString()}, ${minutes.toFixed(0)} min)`,
			body: [
				"Every 30 s a doorbell round, every 3 min a 2 KB answer through a slot, while you play. Context is taken when the round ends.",
				"",
				tableMd(
					[
						"Context",
						"OK",
						"Failed",
						"Skipped",
						"Round trip p50/p95/max",
						"Failures",
					],
					body,
				),
			].join("\n"),
		},
	};
}

function companionSection(events: LogEvent[]): Section {
	const polls = events.filter((e) => e.ev === "poll");
	const p95 = stats(polls.map((e) => Number(e.p95)));
	const worst = Math.max(0, ...polls.map((e) => Number(e.max)));
	const errors = events.filter((e) => e.ev === "error" || e.ev === "bad-frame");
	const games = events.filter((e) => e.ev === "game").length;
	return {
		title: "Companion",
		body: [
			`Poll loop: p95 of the 10-second p95 values ${ms(p95?.p95, 1)}, worst single gap ${ms(worst, 0)}. Game process changes seen: ${games}.`,
			"",
			errors.length
				? tableMd(
						["Time", "Event", "Detail"],
						errors
							.slice(0, 20)
							.map((e) => [
								new Date(e.t).toLocaleString(),
								e.ev,
								String(e.message ?? e.file ?? ""),
							]),
					)
				: "No companion errors.",
		].join("\n"),
	};
}

export function buildReport(dataDir: string, now = new Date()): string {
	const events = readLogs(dataDir);
	const saved = loadSaved(dataDir);
	const out: string[] = ["# Transport spike report (FAM-15)", ""];
	const sessions = saved.flatMap(({ account, db }) =>
		list(db.sessions).map((s) => ({ account, session: table(s) ?? {} })),
	);
	const runs = events.filter((e) => e.ev === "companion").length;
	out.push(
		`Generated ${now.toLocaleString()}. ${sessions.length} addon sessions in ${saved.length} account(s), ${runs} companion run(s), ${events.length} companion events.`,
		"",
	);
	if (sessions.length === 0) {
		out.push(
			"No saved addon results yet. Type `/reload` in game (or log out) so the client writes them.",
		);
		return `${out.join("\n")}\n`;
	}
	const benched = sessions.filter(({ session }) => table(session.bench));
	const latest = benched.at(-1);
	const verdicts: Verdict[] = [];
	const sections: Section[] = [];
	if (latest) {
		const bench = table(latest.session.bench) ?? {};
		const own = eventsOf(events, latest.session);
		sections.push(
			{
				title: "Benchmark",
				body: `Session ${num(latest.session.epoch)} on build ${text(latest.session.build)} (${latest.account}). Self-test: ${text(bench.selftest) ?? "–"}.`,
			},
			uplinkSection(bench, own, verdicts),
			signalSection(bench, own, verdicts),
			slotSection(bench, own, verdicts),
			downlinkSection(bench, own, verdicts),
			frameSection(latest.session),
		);
	} else {
		sections.push({
			title: "Benchmark",
			body: "No benchmark yet. Type `/fspike bench` in game.",
		});
	}
	const soak = { ok: 0, failed: 0, minutes: 0, contexts: new Set<string>() };
	for (const { session } of sessions) {
		const result = soakSection(session, eventsOf(events, session));
		if (!result) continue;
		sections.push(result.section);
		soak.ok += result.ok;
		soak.failed += result.failed;
		soak.minutes += result.minutes;
		for (const context of result.contexts) soak.contexts.add(context);
	}
	verdicts.push({
		channel: "Soak while playing (goal: 60 min)",
		ok: soak.failed > 0 ? false : soak.minutes >= 60 ? true : undefined,
		summary: `${soak.ok} ok, ${soak.failed} failed over ${soak.minutes.toFixed(0)} min; contexts: ${[...soak.contexts].join(", ") || "–"}`,
	});
	sections.push(companionSection(events));
	const errors = sessions.flatMap(({ session }) =>
		list(session.errors).map(String),
	);
	if (errors.length)
		sections.push({
			title: "Addon errors",
			body: errors.map((e) => `- \`${e}\``).join("\n"),
		});

	out.push(
		"## Verdict",
		"",
		tableMd(
			["", "Channel", "Measured"],
			verdicts.map((v) => [mark(v.ok), v.channel, v.summary]),
		),
		"",
		"Thresholds: uplink loss-free at ≥33 ms spacing, detect p95 < 250 ms, write cost p95 < 2 ms; doorbell round trip p95 < 500 ms; downlinks deliver 2 KB in under 5 s, every slot fresh; soak without failures for at least 60 minutes (FAM-15 decision rule). `?` means not enough data yet.",
		"",
	);
	for (const section of sections)
		out.push(`## ${section.title}`, "", section.body, "");
	return `${out.join("\n").trimEnd()}\n`;
}
