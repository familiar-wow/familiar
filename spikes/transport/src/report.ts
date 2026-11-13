// Joins the addon's SavedVariables with the companion log and renders report.md: one verdict
// per question 0.5.0 asks, then the details behind each.
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
const sec = (value: number | undefined) =>
	value === undefined ? "–" : `${(value / 1000).toFixed(2)} s`;
const trio = (s: Stats | undefined, digits = 1) =>
	s
		? `${s.p50.toFixed(digits)} / ${s.p95.toFixed(digits)} / ${s.max.toFixed(digits)} ms`
		: "–";
const mark = (ok: boolean | undefined) =>
	ok === undefined ? "?" : ok ? "✔" : "✘";
const rows = (value: string | undefined) =>
	value ? value.split(";").filter(Boolean) : [];
const stamp = (value: string | undefined) =>
	value === undefined || value === "" || value === "-"
		? undefined
		: Number(value);
const time = (t: number) => new Date(t).toLocaleTimeString();
const ratio = (ok: number, all: number) => `${ok}/${all}`;

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

// Records -------------------------------------------------------------------------

interface Session {
	account: string;
	data: LuaTable;
	epoch: number;
	started: number;
}

interface LaneSend {
	epoch: number;
	id: number;
	kind: string;
	tag: string;
	code: number;
	gap: number;
	bytes: number;
	frames: number;
	first: number;
	save?: Stats;
	toggle?: Stats;
	mismatches: number;
	context: string;
}

interface ShotTake {
	epoch: number;
	id: number;
	attempt: number;
	tag: string;
	style: number;
	format: string;
	bytes: number;
	w: number;
	h: number;
	paintMax: number;
	called: number;
	result: string;
	worst: number;
}

interface Trip {
	epoch: number;
	id: number;
	attempts: number;
	kind: string;
	path: number;
	style: number;
	tag: string;
	start: number;
	sent: number;
	bell?: number;
	done: number;
	received?: number;
	written?: number;
	fonts: number;
	result: string;
	context: string;
}

function laneSend(epoch: number, record: string): LaneSend {
	const f = record.split(",");
	return {
		epoch,
		id: Number(f[0]),
		kind: f[2] ?? "?",
		tag: f[3] ?? "-",
		code: Number(f[4]),
		gap: Number(f[5]),
		bytes: Number(f[6]),
		frames: Number(f[7]),
		first: Number(f[8]),
		toggle: summary(f[11]),
		save: summary(f[12]),
		mismatches: Number(f[14] ?? 0),
		context: f[15] ?? "-",
	};
}

function shotTake(epoch: number, record: string): ShotTake {
	const f = record.split(",");
	return {
		epoch,
		id: Number(f[0]),
		attempt: Number(f[1]),
		tag: f[2] ?? "-",
		style: Number(f[3]),
		format: f[4] ?? "?",
		bytes: Number(f[5]),
		w: Number(f[10]),
		h: Number(f[11]),
		paintMax: Number(f[13]),
		called: Number(f[15]),
		result: f[18] ?? "?",
		worst: Number(f[19]),
	};
}

function trip(epoch: number, record: string): Trip {
	const f = record.split(",");
	return {
		epoch,
		id: Number(f[0]),
		attempts: Number(f[1]),
		kind: f[2] ?? "?",
		path: Number(f[3]),
		style: Number(f[4]),
		tag: f[5] ?? "-",
		start: Number(f[6]),
		sent: Number(f[7]),
		bell: stamp(f[8]),
		done: Number(f[9]),
		received: stamp(f[10]),
		written: stamp(f[11]),
		fonts: Number(f[13]),
		result: f[15] ?? "?",
		context: f[16] ?? "-",
	};
}

const STYLE = { muted: 1, small: 2, world: 4, hold: 8 };

function styleName(style: number): string {
	const parts = [style & STYLE.muted ? "muted" : "bright"];
	if (style & STYLE.small) parts.push("2 px");
	parts.push(style & STYLE.hold ? "2 frames" : "1 frame");
	if (style & STYLE.world) parts.push("world");
	return parts.join(", ");
}

/** Everything the report joins, keyed by "epoch:id". */
interface Data {
	sessions: Session[];
	lane: LaneSend[];
	shots: ShotTake[];
	trips: Trip[];
	/** Companion "message" events. */
	messages: Map<string, LogEvent[]>;
	/** Companion "shot" events with a decoded message, by "epoch:id:attempt". */
	pictures: Map<string, LogEvent>;
	/** Pictures without a decodable block, for matching by time. */
	blank: LogEvent[];
	events: LogEvent[];
}

const key = (epoch: number, id: number) => `${epoch}:${id}`;

function collect(saved: Saved[], events: LogEvent[]): Data {
	const sessions = saved.flatMap(({ account, db }) =>
		list(db.sessions).map((value) => {
			const data = table(value) ?? {};
			return {
				account,
				data,
				epoch: num(data.epoch) ?? -1,
				started: (num(data.started) ?? 0) * 1000,
			};
		}),
	);
	const data: Data = {
		sessions,
		lane: [],
		shots: [],
		trips: [],
		messages: new Map(),
		pictures: new Map(),
		blank: [],
		events,
	};
	for (const s of sessions) {
		for (const r of list(s.data.lane))
			data.lane.push(laneSend(s.epoch, String(r)));
		for (const r of list(s.data.shots))
			data.shots.push(shotTake(s.epoch, String(r)));
		for (const r of list(s.data.trips))
			data.trips.push(trip(s.epoch, String(r)));
	}
	for (const e of events) {
		if (e.ev === "message") {
			const k = key(Number(e.epoch), Number(e.id));
			data.messages.set(k, [...(data.messages.get(k) ?? []), e]);
		} else if (e.ev === "shot") {
			if (e.ok) data.pictures.set(`${e.epoch}:${e.id}:${e.attempt}`, e);
			else data.blank.push(e);
		}
	}
	return data;
}

const arrived = (d: Data, epoch: number, id: number) =>
	d.messages.has(key(epoch, id));

/** The companion's picture of a take: decoded, a picture without our block, or none. */
function pictureOf(
	d: Data,
	take: ShotTake,
): { decoded: boolean; event?: LogEvent } {
	const event = d.pictures.get(`${take.epoch}:${take.id}:${take.attempt}`);
	if (event) return { decoded: true, event };
	const blank = d.blank.find(
		(e) =>
			Number(e.mtime) >= take.called - 1000 &&
			Number(e.mtime) <= take.called + 4000,
	);
	return { decoded: false, event: blank };
}

// Sections --------------------------------------------------------------------------

interface Verdict {
	ok: boolean | undefined;
	check: string;
	result: string;
}

interface Section {
	title: string;
	body: string;
}

function laneSection(d: Data): { verdicts: Verdict[]; section: Section } {
	const tests = d.lane.filter((l) => l.kind === "lane");
	// One row per width, gap and message size.
	const groups = new Map<string, LaneSend[]>();
	for (const l of tests) {
		const group = `${l.tag}/${l.bytes}`;
		groups.set(group, [...(groups.get(group) ?? []), l]);
	}
	const body = [...groups.entries()].map(([group, sends]) => {
		const times = sends.flatMap((l) => {
			const m = d.messages.get(key(l.epoch, l.id))?.[0];
			return m ? [Number(m.received) - l.first] : [];
		});
		const t = stats(times);
		const bytes = sends[0]?.bytes ?? 0;
		const saves = sends.flatMap((l) => (l.save ? [l.save] : []));
		const toggles = sends.flatMap((l) => (l.toggle ? [l.toggle] : []));
		const merged = (list: Stats[]) =>
			list.length
				? {
						n: list.reduce((a, s) => a + s.n, 0),
						p50: stats(list.map((s) => s.p50))?.p50 ?? 0,
						p95: Math.max(...list.map((s) => s.p95)),
						max: Math.max(...list.map((s) => s.max)),
					}
				: undefined;
		const [bits, gap] = group.split("/");
		return [
			`${bits} bit`,
			`${gap} ms`,
			`${bytes} B`,
			ratio(times.length, sends.length),
			sec(t?.p50),
			t ? `${Math.round((bytes * 1000) / t.p50)} B/s` : "–",
			trio(merged(saves)),
			trio(merged(toggles)),
		];
	});
	const all = d.lane;
	const lost = all.filter((l) => !arrived(d, l.epoch, l.id));
	const byKind = (kind: string) => {
		const list = all.filter((l) => l.kind === kind);
		return `${kind} ${ratio(list.filter((l) => arrived(d, l.epoch, l.id)).length, list.length)}`;
	};
	const broken = d.events.filter((e) => e.ev === "lane-broken");
	const mismatches = all.reduce((a, l) => a + l.mismatches, 0);
	const soakSaves = stats(
		all
			.filter((l) => l.kind === "soak")
			.flatMap((l) => (l.save ? [l.save.p50] : [])),
	);
	const verdicts: Verdict[] = [
		{
			ok: all.length ? lost.length === 0 : undefined,
			check: "Lane U: every message arrives",
			result: `${["lane", "soak", "say", "trip", "bell", "hello"].map(byKind).join(", ")}${lost.length ? `; lost: ${lost.map((l) => `${l.kind} #${l.id} (${l.context})`).join(", ")}` : ""}`,
		},
		{
			ok: body.length ? true : undefined,
			check: "Lane U: time for 332 B (300 B text)",
			result: body.length
				? body
						.filter((r) => String(r[2]) === "332 B")
						.map((r) => `${r[0]} at ${r[1]}: ${r[4]}`)
						.join(", ")
				: "no benchmark yet: type `/fspike bench`",
		},
		{
			ok: undefined,
			check: "Lane U: SaveAddOns per save (p50 of the soak)",
			result: soakSaves ? ms(soakSaves.p50, 2) : "–",
		},
	];
	return {
		verdicts,
		section: {
			title: "Lane U",
			body: [
				"Benchmark messages, from the first save to the companion's read of the last frame. *Save* and *toggle* are p50 / p95 / max of every `SaveAddOns` call and of the `EnableAddOn`/`DisableAddOn` calls before it.",
				"",
				body.length
					? tableMd(
							[
								"Width",
								"Gap",
								"Message",
								"Arrived",
								"Time (p50)",
								"Rate",
								"Save",
								"Toggle",
							],
							body,
						)
					: "No benchmark yet.",
				"",
				`Frames the companion could not use: ${broken.length ? broken.map((e) => `${e.why}${e.why === "gap" ? ` (${e.expected}→${e.got})` : ""}`).join(", ") : "none"}. Bits the client did not take: ${mismatches}.`,
			].join("\n"),
		},
	};
}

function shotSection(d: Data): { verdicts: Verdict[]; sections: Section[] } {
	const takes = d.shots;
	const judge = (take: ShotTake) => pictureOf(d, take);
	const level = (e?: LogEvent) =>
		e?.on !== undefined
			? `${Math.round(Number(e.on))}/${Math.round(Number(e.off))}`
			: "";
	// Every style under normal settings.
	const plain = takes.filter(
		(t) =>
			!t.tag.includes("/") &&
			t.tag !== "soak" &&
			t.tag !== "say" &&
			t.tag !== "bench",
	);
	// The block was in the picture, whether or not its bits came through.
	const seen = (t: ShotTake) => {
		const p = judge(t);
		return p.decoded || p.event?.found === true;
	};
	const plainRows = plain.map((t) => {
		const p = judge(t);
		return [
			t.tag,
			styleName(t.style),
			`${t.w}×${t.h} px`,
			p.decoded
				? "✔"
				: p.event?.found
					? "✘ unreadable"
					: p.event
						? "✘ no block"
						: "✘ no picture",
			level(p.event),
			ms(t.paintMax, 1),
			ms(t.worst, 0),
		];
	});
	// Picture settings: one row per setting, one column per style.
	const settingTakes = takes.filter(
		(t) => t.tag.includes(":") && t.tag.includes("/"),
	);
	const settings = [
		...new Set(settingTakes.map((t) => t.tag.split("/")[0] ?? "")),
	];
	const styles = ["bright", "muted", "small", "small-muted"];
	const matrix = settings.map((setting) => [
		setting,
		...styles.map((style) => {
			const t = settingTakes.find((x) => x.tag === `${setting}/${style}`);
			if (!t) return "–";
			const p = judge(t);
			return `${p.decoded ? "✔" : "✘"} ${level(p.event)}`.trim();
		}),
	]);
	const holds = (style: string) =>
		settingTakes.length > 0 &&
		settingTakes
			.filter((t) => t.tag.endsWith(`/${style}`))
			.every((t) => judge(t).decoded);
	const failing = (style: string) =>
		settingTakes
			.filter((t) => t.tag.endsWith(`/${style}`) && !judge(t).decoded)
			.map((t) => t.tag.split("/")[0])
			.join(", ");
	const noui = takes.filter((t) => t.tag.startsWith("noui/"));
	const nouiText = noui
		.map(
			(t) =>
				`${t.tag.slice(5)} parent ${seen(t) ? "in the picture" : "not in it"}`,
		)
		.join(", ");
	// Soak: a message counts once, delivered by its first or second picture.
	const soak = takes.filter((t) => t.tag === "soak");
	const soakIds = [...new Set(soak.map((t) => key(t.epoch, t.id)))];
	let first = 0;
	let second = 0;
	const lostSoak: string[] = [];
	for (const k of soakIds) {
		const attempts = soak.filter((t) => key(t.epoch, t.id) === k);
		const firstTake = attempts.find((t) => t.attempt === 1);
		if (firstTake && judge(firstTake).decoded) first++;
		else if (attempts.some((t) => t.attempt > 1 && judge(t).decoded)) second++;
		else
			lostSoak.push(
				`#${k.split(":")[1]} at ${firstTake ? time(firstTake.called) : "?"} (${d.trips.find((x) => key(x.epoch, x.id) === k)?.context ?? "?"})`,
			);
	}
	const soakTrips = d.trips.filter((t) => t.kind === "soak");
	const combat = soakTrips.filter((t) => t.context.includes("combat"));
	// Pictures where only the timing could fail: no setting at a limit, the interface shown.
	const oneFrame = takes.filter(
		(t) => !(t.style & STYLE.hold) && t.attempt === 1 && !t.tag.includes("/"),
	);
	const worst = stats(takes.map((t) => t.worst));
	const verdicts: Verdict[] = [
		{
			ok: plain.length ? plain.every((t) => judge(t).decoded) : undefined,
			check: "Screenshot: every style decodes",
			result: plain.length
				? plain
						.map((t) => `${t.tag} ${judge(t).decoded ? "✔" : "✘"}`)
						.join(", ")
				: "no benchmark yet",
		},
		{
			ok: settingTakes.length ? holds("bright") : undefined,
			check: "Screenshot: picture settings at their limits",
			result: settingTakes.length
				? styles
						.map((s) => `${s} ${holds(s) ? "all" : `fails at ${failing(s)}`}`)
						.join("; ")
				: "no benchmark yet",
		},
		{
			ok: undefined,
			check: "Screenshot: interface hidden (Alt+Z)",
			result: nouiText || "not measured",
		},
		{
			ok: soakIds.length ? lostSoak.length === 0 : undefined,
			check: "Screenshot soak: every message arrives",
			result: soakIds.length
				? `${first} with the first picture, ${second} with the second, ${lostSoak.length} lost${lostSoak.length ? ` (${lostSoak.join(", ")})` : ""}; ${combat.length} in combat`
				: "no soak pictures yet",
		},
		{
			ok: oneFrame.length ? oneFrame.every(seen) : undefined,
			check: "Screenshot: block shown for one frame is in the picture",
			result: `${ratio(oneFrame.filter(seen).length, oneFrame.length)} pictures; longest frame around a picture ${ms(worst?.max)}`,
		},
	];
	const sections: Section[] = [
		{
			title: "Screenshots",
			body: [
				"Benchmark pictures with normal settings. *Levels* are the brightness of the block's on and off cells in the picture (0–255). *Paint* is the most Lua time in one frame while painting, *frame* the longest frame from the call to the saved file.",
				"",
				plainRows.length
					? tableMd(
							["Test", "Style", "Block", "Read", "Levels", "Paint", "Frame"],
							plainRows,
						)
					: "No benchmark yet.",
				"",
				"Picture settings at their slider limits, each for about two seconds, with the levels of each block:",
				"",
				matrix.length
					? tableMd(["Setting", ...styles], matrix)
					: "Not measured.",
			].join("\n"),
		},
	];
	return { verdicts, sections };
}

function tripSection(d: Data): { verdicts: Verdict[]; section: Section } {
	const trips = d.trips.filter((t) => t.kind === "say" || t.kind === "trip");
	const timing = (t: Trip) =>
		t.received !== undefined && t.written !== undefined && t.bell !== undefined
			? [
					sec(t.received - t.start),
					sec(t.written - t.received),
					sec(t.bell - t.written),
					sec(t.done - t.bell),
				]
			: ["–", "–", "–", "–"];
	const body = trips.map((t) => [
		t.kind,
		t.path === 1 ? "lane U" : `screenshot (${styleName(t.style)})`,
		t.result === "ok" ? "✔" : `✘ ${t.result}`,
		t.attempts > 1 ? "2" : "1",
		sec(t.done - t.start),
		...timing(t),
		t.context,
	]);
	const ok = trips.filter((t) => t.result === "ok");
	const byPath = (path: number) =>
		stats(ok.filter((t) => t.path === path).map((t) => t.done - t.start));
	const lane = byPath(1);
	const shot = byPath(2);
	const bells = d.trips.filter((t) => t.kind === "bell");
	const fontReads = d.trips.filter((t) => t.fonts > 0);
	const fontsOk = fontReads.filter((t) => t.result === "ok");
	const verdicts: Verdict[] = [
		{
			ok: trips.length ? ok.length === trips.length : undefined,
			check: "Round trip with a 2 KB reply",
			result: trips.length
				? `${ratio(ok.length, trips.length)} answered; lane U p50 ${sec(lane?.p50)} (max ${sec(lane?.max)}), screenshot p50 ${sec(shot?.p50)} (max ${sec(shot?.max)})`
				: "none yet: `/fspike say <text>` or the benchmark",
		},
		{
			ok: bells.length
				? bells.find((t) => t.tag === "normal")?.result === "ok"
				: undefined,
			check: "Doorbell with normal sound, volume 0, sound off",
			result: bells.length
				? bells
						.map(
							(t) =>
								`${t.tag.split(":")[0]} ${t.result === "ok" ? "heard" : "not heard"}`,
						)
						.join(", ")
				: "not measured",
		},
		{
			ok: fontReads.length ? fontsOk.length === fontReads.length : undefined,
			check: "Font bank: replies read",
			result: `${ratio(fontsOk.length, fontReads.length)} replies, ${fontReads.reduce((a, t) => a + t.fonts, 0)} fonts`,
		},
	];
	return {
		verdicts,
		section: {
			title: "Round trips",
			body: [
				"From the start of sending to the last reply font read: *up* until the companion had the message, *companion* until it wrote the reply, *doorbell* until the addon heard it, *fonts* reading the reply.",
				"",
				body.length
					? tableMd(
							[
								"Kind",
								"Path",
								"Result",
								"Pictures",
								"Total",
								"Up",
								"Companion",
								"Doorbell",
								"Fonts",
								"Context",
							],
							body,
						)
					: "None yet.",
			].join("\n"),
		},
	};
}

function listSection(d: Data): Verdict {
	// The addon collapses the category once; every later login shows whether it stayed so.
	const states = d.sessions.map((s) => num(s.data.collapsed) ?? -1);
	const later = states.slice(1).filter((s) => s >= 0);
	const helpers = d.sessions.map((s) => num(s.data.helpers)).at(-1);
	return {
		ok: later.length ? later.every((s) => s === 1) : undefined,
		check: "Addon list: lane category stays collapsed (in game)",
		result: `${later.length ? `${ratio(later.filter((s) => s === 1).length, later.length)} logins found it collapsed` : "needs a second login"}; ${helpers ?? "?"} helper addons; character list: look yourself`,
	};
}

const PHASES = [
	"baseline",
	"idle",
	"lane64-33",
	"lane128-33",
	"lane256-33",
	"lane256-17",
	"lane256-0",
	"bells",
	"trips",
	"shots",
	"settings",
	"noui",
	"say",
	"soak",
];

function frameSection(session: LuaTable | undefined): Section {
	const frames = table(session?.frames);
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
	const share = (counts: number[], from: number, n: number) =>
		n
			? `${((100 * counts.slice(from).reduce((a, c) => a + c, 0)) / n).toFixed(1)} %`
			: "–";
	const body = parsed.map((p) => [
		p.phase,
		p.n,
		ms(p.mean, 1),
		baseline === undefined || p.phase === "baseline"
			? ""
			: `${p.mean - baseline >= 0 ? "+" : ""}${(p.mean - baseline).toFixed(1)}`,
		ms(p.max, 0),
		share(p.counts, 5, p.n),
		share(p.counts, 6, p.n),
	]);
	const hitches = rows(text(session?.hitches))
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
			"Session with the benchmark. *vs. baseline* compares the mean with ten idle seconds before it.",
			"",
			body.length
				? tableMd(
						[
							"Phase",
							"Frames",
							"Mean",
							"vs. baseline",
							"Max",
							"≥34 ms",
							"≥50 ms",
						],
						body,
					)
				: "No frame times saved yet.",
			"",
			hitches.length
				? tableMd(
						["Hitch", "Phase", "Our share in the frame before", "Context"],
						hitches.map((h) => [
							ms(h.frame),
							h.phase,
							ms(h.ours, 2),
							h.context,
						]),
					)
				: "No hitches of 50 ms or more.",
		].join("\n"),
	};
}

function sessionSection(d: Data): Section {
	const body = d.sessions.map((s) => [
		s.epoch,
		s.data.reload === true ? "reload" : "login",
		time(s.started),
		num(s.data.ended)
			? `${Math.round(((num(s.data.ended) ?? 0) - s.started) / 60_000)} min`
			: "–",
		text(s.data.screen) ?? "–",
		num(s.data.collapsed) === 1
			? "yes"
			: num(s.data.collapsed) === 0
				? "no"
				: "?",
		num(s.data.fontRestart) === 1 ? "new process" : "",
		list(s.data.errors).length,
	]);
	const latest = d.sessions.at(-1)?.data;
	const recovered = d.sessions.filter((s) => text(s.data.recovered));
	const writes = d.events.filter((e) => e.ev === "addons");
	const last = writes.at(-1);
	return {
		title: "Sessions",
		body: [
			tableMd(
				[
					"Epoch",
					"Start",
					"At",
					"Length",
					"Screen",
					"List collapsed",
					"Fonts",
					"Errors",
				],
				body,
			),
			"",
			`Settings at the last login: \`${text(latest?.settings) ?? "–"}\`.`,
			`Self-test: ${text(latest?.selftest) ?? "–"}. Doorbell: ${text(latest?.doorbell) ?? "–"} (\`${text(latest?.sound) ?? "–"}\`).`,
			recovered.length
				? `Settings put back after an interrupted benchmark: ${recovered.map((s) => text(s.data.recovered)).join("; ")}.`
				: "",
			last
				? `AddOns.txt at the last client write: ${Math.round(Number(last.size) / 1024)} KB, ${last.rows} lane rows (${writes.length} client writes logged).`
				: "",
		]
			.filter((line) => line !== "")
			.join("\n"),
	};
}

function errorSection(d: Data): Section {
	const addon = d.sessions.flatMap((s) =>
		list(s.data.errors).map((e) => [s.epoch, String(e)]),
	);
	const companion = d.events.filter((e) => e.ev === "error");
	return {
		title: "Errors",
		body: [
			addon.length
				? tableMd(["Session", "Addon error"], addon)
				: "No addon errors.",
			"",
			companion.length
				? tableMd(
						["Time", "Where", "Companion error"],
						companion
							.slice(0, 20)
							.map((e) => [
								time(e.t),
								String(e.where ?? ""),
								String(e.message ?? ""),
							]),
					)
				: "No companion errors.",
		].join("\n"),
	};
}

/** Sessions that said hello but are not saved yet: the game writes them on /reload or logout. */
function unsavedNote(d: Data): string[] {
	const saved = new Set(d.sessions.map((s) => s.epoch));
	const hellos = [...d.messages.values()]
		.flat()
		.filter((e) => e.kind === "hello" && !saved.has(Number(e.epoch)));
	if (hellos.length === 0) return [];
	const last = hellos.at(-1);
	if (hellos.length === 1 && last && Date.now() - last.t < 120_000)
		return [
			"Not saved: the last session, started right before the report. Log out or quit WoW first to include it.",
			"",
		];
	return [
		`⚠ **${hellos.length} session(s) not saved yet** (${hellos.map((e) => `${e.epoch} at ${time(e.t)}`).join(", ")}). WoW writes results on \`/reload\` or logout: type \`/reload\` in game, then run \`familiar-spike report\`.`,
		"",
	];
}

export function buildReport(dataDir: string, now = new Date()): string {
	const events = readLogs(dataDir);
	const saved = loadSaved(dataDir);
	const d = collect(saved, events);
	const runs = events.filter((e) => e.ev === "companion");
	const platforms = [...new Set(runs.map((e) => String(e.platform)))].join(
		", ",
	);
	const out: string[] = [
		"# Transport spike report (FAM-15)",
		"",
		`Generated ${now.toLocaleString()}. ${d.sessions.length} addon session(s) in ${saved.length} account(s), ${runs.length} companion run(s)${platforms ? ` on ${platforms}` : ""}, ${events.length} companion events.`,
		"",
		...unsavedNote(d),
	];
	if (d.sessions.length === 0) {
		out.push(
			"No saved addon results yet. Type `/reload` in game (or log out) so the client writes them.",
		);
		return `${out.join("\n")}\n`;
	}
	const lane = laneSection(d);
	const shots = shotSection(d);
	const trips = tripSection(d);
	const verdicts = [
		...lane.verdicts,
		listSection(d),
		...shots.verdicts,
		...trips.verdicts,
	];
	const benched = d.sessions.filter((s) => table(s.data.bench)).at(-1);
	out.push(
		tableMd(
			["", "Check", "Result"],
			verdicts.map((v) => [mark(v.ok), v.check, v.result]),
		),
		"",
		"✔ passed, ✘ failed, ? not measured yet or for information.",
		"",
	);
	for (const section of [
		lane.section,
		...shots.sections,
		trips.section,
		frameSection(benched?.data),
		sessionSection(d),
		errorSection(d),
	])
		out.push(`## ${section.title}`, "", section.body, "");
	return `${out.join("\n").trimEnd()}\n`;
}
