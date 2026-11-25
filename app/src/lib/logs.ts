// The Logs page: each line of the core's log (`log` events and `logs.recent`) as one row with a
// time, a kind and a text. The core writes events for programs, so this says them for people.
// Question texts and anything the addon sent are game data: the page shows them as text only.
import { type Key, seconds, type Translate, translator } from "./i18n.ts";
import { toolChips } from "./questions.ts";
import type { Language } from "./types.ts";

export type Tone = "info" | "good" | "warn" | "error" | "dim";
export type LogFilter = "all" | "questions" | "tools" | "problems";
export const FILTERS: readonly LogFilter[] = [
	"all",
	"questions",
	"tools",
	"problems",
];

export interface LogEntry {
	at: number;
	/** The event as the core named it; the filters go by it. */
	event: string;
	/** The label in front of the text, such as "question" or "tool". */
	kind: string;
	tone: Tone;
	text: string;
}

type Line = Record<string, unknown>;

/** `say` lines that only repeat an event the page already shows in its own words. */
const REPEATS = [
	"Question: ",
	"Answered after ",
	"The addon says hello: ",
	"Brain ready: ",
];

const QUESTIONS = new Set(["question", "answered", "undelivered"]);
const TOOLS = new Set(["mcp-call", "mcp-error"]);
/** Never shown as `key=value`, in case a future event carries something like a secret. */
const SECRET = /key|token|secret|pass|auth|cookie|header|env/i;
/** Long values of unknown events are cut; the log file has them whole. */
const MAX_VALUE = 200;

/** One line of the log as a row, or null for a line the page leaves out. */
export function describeLogLine(
	line: unknown,
	language: Language = "en",
): LogEntry | null {
	return describe(line, translator(language), language);
}

/** The rows for the page, oldest first: newest at the bottom. */
export function logEntries(
	lines: readonly unknown[],
	language: Language,
): LogEntry[] {
	const t = translator(language);
	const entries: LogEntry[] = [];
	for (const line of lines) {
		const entry = describe(line, t, language);
		if (entry) entries.push(entry);
	}
	// Lines arrive in order; the sort only guards a merge of the recent log and live lines.
	// Array.prototype.sort is stable, so lines of the same millisecond keep their order.
	return entries.sort((a, b) => a.at - b.at);
}

export function filterLines(
	entries: readonly LogEntry[],
	filter: LogFilter,
): LogEntry[] {
	if (filter === "questions")
		return entries.filter((e) => QUESTIONS.has(e.event));
	if (filter === "tools") return entries.filter((e) => TOOLS.has(e.event));
	if (filter === "problems")
		return entries.filter((e) => e.tone === "warn" || e.tone === "error");
	return [...entries];
}

/** The rows as the page shows them, one per line, for the clipboard. */
export function plainText(entries: readonly LogEntry[]): string {
	return entries.map((e) => `${clock(e.at)} ${e.kind} ${e.text}`).join("\n");
}

/** HH:MM:SS in local time. */
export function clock(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function describe(
	raw: unknown,
	t: Translate,
	language: Language,
): LogEntry | null {
	if (!raw || typeof raw !== "object") return null;
	const line = raw as Line;
	const event = line.event;
	if (typeof event !== "string" || event === "") return null;
	const at = typeof line.at === "number" ? line.at : 0;
	const row = (kind: Key | string, tone: Tone, text: string): LogEntry => ({
		at,
		event,
		kind: kind.startsWith("logs.kind.") ? t(kind as Key) : kind,
		tone,
		text,
	});
	const s = (ms: unknown) => seconds(num(ms) ?? 0, language);

	switch (event) {
		case "start": {
			const parts = [t("logs.start", { version: str(line.version) ?? "?" })];
			const build = str(line.build);
			if (build) parts.push(`WoW ${build}`);
			const brain = brainName(line.brain);
			if (brain) parts.push(brain);
			const install = (line.install ?? {}) as Line;
			const changed = (num(install.added) ?? 0) + (num(install.updated) ?? 0);
			if (changed > 0) parts.push(t("logs.start.addon", { n: changed }));
			return row("logs.kind.start", "info", parts.join(" · "));
		}
		case "note": {
			const text = str(line.text) ?? "";
			if (line.level === "error") return row("logs.kind.error", "error", text);
			if (line.level === "warn") return row("logs.kind.warning", "warn", text);
			return row("logs.kind.info", "info", text);
		}
		case "say": {
			const text = str(line.text) ?? "";
			if (REPEATS.some((p) => text.startsWith(p))) return null;
			return row("logs.kind.info", "dim", text);
		}
		case "question":
			return row("logs.kind.question", "good", str(line.text) ?? "");
		case "answered": {
			const tools = toolChips(list(line.tools));
			const text = t("logs.answered", { s: s(line.ms) });
			return row(
				"logs.kind.answer",
				"good",
				tools.length > 0 ? `${text} · ${tools.join(", ")}` : text,
			);
		}
		case "undelivered":
			return row(
				"logs.kind.answer",
				"warn",
				t("logs.undelivered", { s: s(line.ms) }),
			);
		case "model-error": {
			const model = [str(line.provider), str(line.model)]
				.filter(Boolean)
				.join(" ");
			const error = str(line.error) ?? "";
			return row(
				"logs.kind.error",
				"error",
				model ? `${model}: ${error}` : error,
			);
		}
		case "brain-exit": {
			const code = num(line.code);
			const failed = code !== undefined && code !== 0;
			let text = failed
				? t("logs.brainExit.code", { code })
				: t("logs.brainExit");
			// The agent's own last words say why; the core logs them for exactly that.
			const last = list(line.stderr)
				.map((l) => l.trim())
				.filter(Boolean)
				.at(-1);
			if (failed && last) text = `${text} ${last}`;
			return row("logs.kind.brain", failed ? "error" : "dim", text);
		}
		case "brain-start": {
			const agent = (line.agent ?? {}) as Line;
			const name = [str(agent.title) ?? str(agent.name), str(agent.version)]
				.filter(Boolean)
				.join(" ");
			return row(
				"logs.kind.brain",
				"info",
				t("logs.brainStart", {
					agent: name || t("logs.theAgent"),
					s: s(line.ms),
				}),
			);
		}
		case "brain-session": {
			const refused = str(line.refused);
			if (refused)
				return row(
					"logs.kind.brain",
					"warn",
					t("logs.session.noTools", { why: refused }),
				);
			return row("logs.kind.brain", "dim", t("logs.session"));
		}
		case "brain-permission": {
			// The agent's option ids (ACP): allow_once, reject_once, …; "cancelled" when none fit.
			const answer = str(line.answer) ?? "";
			const key = answer.startsWith("allow")
				? "logs.permissionAllowed"
				: "logs.permissionDenied";
			return row(
				"logs.kind.brain",
				"info",
				t(key, { tool: str(line.tool) ?? "?" }),
			);
		}
		case "answer": {
			const reason = str(line.stopReason);
			const text = t("logs.agentAnswer", { s: s(line.ms) });
			return row(
				"logs.kind.brain",
				"dim",
				reason && reason !== "end_turn" ? `${text} (${reason})` : text,
			);
		}
		case "model-answer":
			return row(
				"logs.kind.brain",
				"dim",
				t("logs.modelAnswer", {
					model: str(line.model) ?? "?",
					s: s(line.ms),
					steps: num(line.steps) ?? 1,
				}),
			);
		case "mcp-call": {
			const tool = str(line.tool) ?? "?";
			const error = str(line.error);
			return error
				? row("logs.kind.tool", "error", `${tool}: ${error}`)
				: row("logs.kind.tool", "info", tool);
		}
		case "mcp-refused":
			return row(
				"logs.kind.tool",
				"warn",
				t("logs.mcpRefused", {
					status: num(line.status) ?? "?",
					why: str(line.why) ?? "?",
				}),
			);
		case "mcp-unused":
			return row("logs.kind.tool", "warn", t("logs.mcpUnused"));
		case "mcp-client": {
			const client = (line.client ?? {}) as Line;
			const name = str(client.title) ?? str(client.name) ?? t("logs.theAgent");
			return row("logs.kind.tool", "dim", t("logs.mcpClient", { agent: name }));
		}
		case "game":
			return row(
				"logs.kind.game",
				"info",
				list(line.pids).length > 0 ? t("logs.gameRuns") : t("logs.gameGone"),
			);
		case "hello":
			return row(
				"logs.kind.game",
				"good",
				t("logs.hello", { text: str(line.text) ?? "" }),
			);
		case "message":
		case "repeat":
			return row(
				"logs.kind.game",
				"dim",
				t(event === "repeat" ? "logs.repeat" : "logs.message", {
					bytes: num(line.bytes) ?? 0,
				}),
			);
		case "send":
			return row(
				"logs.kind.game",
				"dim",
				t("logs.send", { bytes: num(line.bytes) ?? 0 }),
			);
		case "reset":
			return row(
				"logs.kind.game",
				"dim",
				t("logs.reset", { why: str(line.why) ?? "?" }),
			);
		case "session":
			// The addon's session key is no secret, but nobody needs to read it here.
			return row("logs.kind.game", "dim", t("logs.addonSession"));
		case "lane-broken":
			return row(
				"logs.kind.game",
				"warn",
				t("logs.laneBroken", { why: str(line.why) ?? "?" }),
			);
	}
	// Every other error, such as mcp-error or brain-error, by its name.
	if (event.endsWith("-error")) {
		const error = str(line.error);
		const during = str(line.during);
		const text = error ?? fields(line);
		return row(
			"logs.kind.error",
			"error",
			during && error ? `${during}: ${text}` : text,
		);
	}
	return row(event, "dim", fields(line));
}

/** The fields of an unknown event as `key=value`, without `at` and `event`. */
function fields(line: Line): string {
	const out: string[] = [];
	for (const [key, value] of Object.entries(line)) {
		if (key === "at" || key === "event" || SECRET.test(key)) continue;
		if (value === undefined) continue;
		let text = typeof value === "string" ? value : JSON.stringify(value);
		if (text.length > MAX_VALUE) text = `${text.slice(0, MAX_VALUE - 1)}…`;
		out.push(`${key}=${text}`);
	}
	return out.join(" ");
}

/** The brain of a `start` line: what the core's describeBrain() says. */
function brainName(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const b = value as Line;
	if (b.kind === "model")
		return [str(b.provider), str(b.model)].filter(Boolean).join(" ");
	if (b.kind === "echo") return "echo";
	const command = list(b.command).join(" ");
	if (b.kind === "ssh") return `${command} @ ${str(b.host) ?? "?"}`.trim();
	return command || undefined;
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v !== "" ? v : undefined;
}

function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function list(v: unknown): string[] {
	return Array.isArray(v) ? v.map(String) : [];
}
