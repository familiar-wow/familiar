// The view state of the main window and what the overview, the tray panel and the tray icon
// show from it. Pure: App.svelte and Tray.svelte only render what comes out of here.
import { seconds, translator } from "./i18n.ts";
import { clock, recentQuestions, toolChips } from "./questions.ts";
import {
	ago,
	type BrainLine,
	brainLine,
	brainText,
	characterParts,
	connection,
	dayPart,
	detail,
	detailText,
} from "./status.ts";
import type {
	Connection,
	Language,
	Status,
	TraySnapshot,
	TrayUpdate,
} from "./types.ts";

export interface View {
	/** The core's generation; 0 until the page knows it. */
	gen: number;
	status?: Status;
	exited: boolean;
	exitCode?: number | null;
	/** The message of the bootstrap step that failed. */
	failure?: string;
	stderrTail: string[];
	/** The number of the last stderr line the page has, so a stale snapshot adds nothing. */
	stderrSeq: number;
	/** The core's version, from `hello`. */
	version?: string;
	language: Language;
	/** The log's `question` and `answered` lines, oldest first. */
	log: Record<string, unknown>[];
}

export function emptyView(language: Language): View {
	return {
		gen: 0,
		exited: false,
		stderrTail: [],
		stderrSeq: 0,
		language,
		log: [],
	};
}

export interface QuestionRow {
	at: number;
	time: string;
	/** The question as plain text; undefined when the log was cut before it. */
	text?: string;
	tools: string[];
	duration: string;
}

export interface Overview {
	connection: Connection;
	heading: string;
	sub: string;
	game: {
		headline: string;
		/** While connected: "Moonbreeze", "Level 35 Tauren Druid · Desolace", "last contact 4 s ago". */
		name?: string;
		who?: string;
		contact?: string;
		/** The core's last stderr line after it stopped. */
		stderr?: string;
		/** The core stopped or a step failed: offer to start it again. */
		canRestart: boolean;
	};
	brain: BrainLine;
	problems: string[];
	restartNeeded: boolean;
	questions: QuestionRow[];
}

export function present(view: View, now: number): Overview {
	const t = translator(view.language);
	const conn = connection(view);
	const d = detail(view);
	const status = view.status;
	const character = characterParts(status?.character, t);
	const name = character.name;
	const game: Overview["game"] = {
		headline: detailText(d, t),
		canRestart: view.exited || view.failure !== undefined,
	};
	if (d.kind === "connected") {
		if (character.name) game.name = character.name;
		if (character.line) game.who = character.line;
		const contact = status?.game.lastContact;
		if (contact)
			game.contact = t("game.lastContact", { ago: ago(contact, now, t) });
	}
	const stderr = view.exited ? lastLine(view.stderrTail) : undefined;
	if (stderr) game.stderr = stderr;
	return {
		connection: conn,
		heading: name
			? t(`heading.${dayPart(new Date(now))}`, { name })
			: t("heading.plain"),
		sub: t(`sub.${conn}`),
		game,
		brain: brainLine(status, t, view.language),
		problems: status?.problems ?? [],
		restartNeeded: status?.restartNeeded === true && !view.exited,
		questions: rows(view, 8),
	};
}

function rows(view: View, max: number): QuestionRow[] {
	return recentQuestions(view.log, max).map((q) => ({
		at: q.at,
		time: clock(q.at),
		text: q.text,
		tools: toolChips(q.tools),
		duration: duration(q, view.language),
	}));
}

/** "…" while open, "not delivered" when the game was gone, else the seconds. */
export function duration(
	q: { ms?: number; undelivered?: true },
	language: Language,
): string {
	if (q.undelivered) return translator(language)("questions.undelivered");
	return q.ms === undefined ? "…" : seconds(q.ms, language);
}

export function snapshot(view: View): TraySnapshot {
	const t = translator(view.language);
	const { name, line } = characterParts(view.status?.character, t);
	const snap: TraySnapshot = {
		connection: connection(view),
		language: view.language,
		gameLine: detailText(detail(view), t),
		brain: brainText(brainLine(view.status, t, view.language)),
		recent: recentQuestions(view.log, 3).map((q) => ({
			at: q.at,
			text: q.text,
			ms: q.ms,
			...(q.undelivered ? { undelivered: true as const } : {}),
			tools: toolChips(q.tools),
		})),
	};
	if (name) snap.character = name;
	if (line) snap.characterLine = line;
	return snap;
}

/** Windows cuts tray tooltips at 127 characters. */
const TOOLTIP_MAX = 120;

export function trayUpdate(view: View): TrayUpdate {
	const t = translator(view.language);
	const state = connection(view);
	const d = detail(view);
	const name = characterParts(view.status?.character, t).name;
	let line = detailText(d, t);
	if (d.kind === "connected" && name) line = `${line} · ${name}`;
	let tooltip = t("tray.tooltip", { line });
	if (tooltip.length > TOOLTIP_MAX)
		tooltip = `${tooltip.slice(0, TOOLTIP_MAX - 1)}…`;
	return { state, tooltip, open: t("tray.open"), quit: t("tray.quit") };
}

function lastLine(lines: readonly string[]): string | undefined {
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]?.trim();
		if (line) return line;
	}
	return undefined;
}
