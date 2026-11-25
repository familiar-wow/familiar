import { expect, test } from "bun:test";
import {
	clock,
	describeLogLine,
	filterLines,
	type LogEntry,
	logEntries,
	plainText,
} from "./logs.ts";

const at = new Date(2026, 10, 25, 23, 41, 3).getTime();
const d = (line: Record<string, unknown>) =>
	describeLogLine({ at, ...line }, "en");
const pick = (e: LogEntry | null) =>
	e && { kind: e.kind, tone: e.tone, text: e.text };

test("time as HH:MM:SS in local time", () => {
	expect(clock(at)).toBe("23:41:03");
	expect(clock(new Date(2026, 0, 2, 4, 5, 6).getTime())).toBe("04:05:06");
});

test("start: version, build, brain and what the addon got", () => {
	expect(
		pick(
			d({
				event: "start",
				version: "0.15.0",
				client: "C:\\WoW\\_forever_",
				build: "1.60.1.62148",
				install: { added: 0, updated: 3 },
				brain: { kind: "agent", command: ["hermes", "acp"] },
			}),
		),
	).toEqual({
		kind: "start",
		tone: "info",
		text: "Familiar 0.15.0 started · WoW 1.60.1.62148 · hermes acp · addon updated (3 files)",
	});
	expect(
		d({
			event: "start",
			version: "0.15.0",
			brain: { kind: "model", provider: "openai", model: "gpt-5" },
		})?.text,
	).toBe("Familiar 0.15.0 started · openai gpt-5");
});

test("notes by their level", () => {
	expect(
		pick(d({ event: "note", level: "info", text: "Addon updated." })),
	).toEqual({ kind: "info", tone: "info", text: "Addon updated." });
	expect(
		pick(d({ event: "note", level: "warn", text: "Port in use" })),
	).toEqual({
		kind: "warning",
		tone: "warn",
		text: "Port in use",
	});
	expect(d({ event: "note", level: "error", text: "x" })?.tone).toBe("error");
});

test("questions and their ends", () => {
	expect(
		pick(
			d({
				event: "question",
				n: 1,
				text: "Is <b>Thunderfury</b> worth it?",
				character: { name: "Moonbreeze" },
			}),
		),
	).toEqual({
		kind: "question",
		tone: "good",
		// Game data stays as it came; the page renders it as text.
		text: "Is <b>Thunderfury</b> worth it?",
	});
	expect(
		pick(
			d({
				event: "answered",
				n: 1,
				ms: 6200,
				bytes: 400,
				tools: ["lookup", "lookup", "quests"],
			}),
		),
	).toEqual({
		kind: "answer",
		tone: "good",
		text: "after 6.2 s · lookup ×2, quests",
	});
	expect(d({ event: "answered", n: 2, ms: 3000, tools: [] })?.text).toBe(
		"after 3.0 s",
	);
	expect(
		pick(d({ event: "undelivered", n: 3, ms: 24_100, tools: [] })),
	).toEqual({
		kind: "answer",
		tone: "warn",
		text: "ready after 24.1 s, but it did not reach the game",
	});
});

test("German texts and number format", () => {
	const e = describeLogLine(
		{ at, event: "answered", ms: 6200, tools: ["quests"] },
		"de",
	);
	expect(e?.kind).toBe("Antwort");
	expect(e?.text).toBe("nach 6,2 s · quests");
});

test("say lines that repeat a structured event are dropped, others are dim", () => {
	expect(d({ event: "say", text: "Question: Where?" })).toBeNull();
	expect(
		d({ event: "say", text: "Answered after 6.2 s, 400 bytes." }),
	).toBeNull();
	expect(
		d({ event: "say", text: "The addon says hello: Familiar" }),
	).toBeNull();
	expect(d({ event: "say", text: "Brain ready: Hermes 0.12" })).toBeNull();
	expect(
		pick(d({ event: "say", text: "Could not send the answer: no session" })),
	).toEqual({
		kind: "info",
		tone: "dim",
		text: "Could not send the answer: no session",
	});
});

test("tools: calls, their errors and the server's troubles", () => {
	expect(pick(d({ event: "mcp-call", tool: "quests" }))).toEqual({
		kind: "tool",
		tone: "info",
		text: "quests",
	});
	expect(
		pick(d({ event: "mcp-call", tool: "lookup", error: "No item 6798." })),
	).toEqual({ kind: "tool", tone: "error", text: "lookup: No item 6798." });
	expect(
		pick(d({ event: "mcp-error", port: 27495, error: "EADDRINUSE" })),
	).toEqual({ kind: "error", tone: "error", text: "EADDRINUSE" });
	expect(
		pick(
			d({ event: "mcp-refused", status: 401, why: "no token", agent: "curl" }),
		),
	).toEqual({
		kind: "tool",
		tone: "warn",
		text: "Refused a request to the game tools (401, no token)",
	});
	expect(d({ event: "mcp-unused", session: "s1" })?.tone).toBe("warn");
	expect(
		d({
			event: "mcp-client",
			client: { name: "hermes-mcp" },
			agent: "hermes",
		})?.text,
	).toBe("hermes-mcp connected to the game tools");
});

test("brain events", () => {
	expect(
		pick(
			d({
				event: "model-error",
				provider: "openai",
				model: "gpt-5",
				error: "rate limited (HTTP 429)",
			}),
		),
	).toEqual({
		kind: "error",
		tone: "error",
		text: "openai gpt-5: rate limited (HTTP 429)",
	});
	expect(
		pick(d({ event: "brain-error", during: "prompt", error: "it quit" })),
	).toEqual({ kind: "error", tone: "error", text: "prompt: it quit" });
	expect(
		pick(d({ event: "brain-exit", code: 1, stderr: ["a", "boom", ""] })),
	).toEqual({
		kind: "brain",
		tone: "error",
		text: "The agent ended with code 1. boom",
	});
	expect(pick(d({ event: "brain-exit", code: 0, stderr: ["bye"] }))).toEqual({
		kind: "brain",
		tone: "dim",
		text: "The agent ended.",
	});
	expect(d({ event: "brain-exit", code: null })?.tone).toBe("dim");
	expect(
		d({
			event: "brain-start",
			ms: 1870,
			agent: { name: "hermes", title: "Hermes", version: "0.12.3" },
		})?.text,
	).toBe("Hermes 0.12.3 ready after 1.9 s");
	expect(d({ event: "brain-session", session: "s", wow: true })?.tone).toBe(
		"dim",
	);
	expect(
		pick(
			d({
				event: "brain-session",
				session: "s",
				wow: false,
				refused: "unsupported",
			}),
		),
	).toEqual({
		kind: "brain",
		tone: "warn",
		text: "New session without the game tools: unsupported",
	});
	expect(
		d({ event: "brain-permission", tool: "web_search", answer: "allow_once" })
			?.text,
	).toBe("Allowed once: web_search");
	for (const answer of ["reject_once", "cancelled", undefined])
		expect(
			d({ event: "brain-permission", tool: "terminal: rm -rf ~", answer })
				?.text,
		).toBe("Not allowed: terminal: rm -rf ~");
	expect(
		d({ event: "answer", ms: 5800, stopReason: "end_turn", chars: 9 })?.text,
	).toBe("The agent answered after 5.8 s");
	expect(
		d({ event: "answer", ms: 5800, stopReason: "max_tokens", chars: 9 })?.text,
	).toBe("The agent answered after 5.8 s (max_tokens)");
	expect(
		d({
			event: "model-answer",
			provider: "openai",
			model: "gpt-5",
			ms: 4200,
			steps: 3,
			inputTokens: 900,
		})?.text,
	).toBe("gpt-5 answered after 4.2 s (3 steps)");
});

test("the game and the transport", () => {
	expect(pick(d({ event: "game", pids: [18244] }))).toEqual({
		kind: "game",
		tone: "info",
		text: "WoW runs",
	});
	expect(d({ event: "game", pids: [] })?.text).toBe("WoW closed");
	expect(pick(d({ event: "hello", text: "Familiar 0.15.0" }))).toEqual({
		kind: "game",
		tone: "good",
		text: "The addon says hello: Familiar 0.15.0",
	});
	expect(d({ event: "message", id: 3, bytes: 64 })?.tone).toBe("dim");
	expect(d({ event: "repeat", id: 3, bytes: 64 })?.text).toBe(
		"Message from the addon again (64 bytes)",
	);
	expect(d({ event: "send", bytes: 410 })?.text).toBe(
		"Sent to the addon (410 bytes)",
	);
	expect(d({ event: "reset", why: "WoW closed" })?.text).toBe(
		"The transport starts over: WoW closed",
	);
	// The session key is not shown.
	expect(d({ event: "session", key: "k7f2", silenced: 0 })?.text).toBe(
		"The addon started a new session",
	);
	expect(
		pick(d({ event: "lane-broken", file: "x", why: "a part was missing" })),
	).toEqual({
		kind: "game",
		tone: "warn",
		text: "A message from the addon was broken: a part was missing",
	});
});

test("unknown events show their fields as key=value, never secret-looking ones", () => {
	expect(
		pick(
			d({
				event: "bank-full",
				slots: 64,
				why: "all used",
				extra: { a: 1 },
				apiKey: "sk-123",
				token: "abc",
			}),
		),
	).toEqual({
		kind: "bank-full",
		tone: "dim",
		text: 'slots=64 why=all used extra={"a":1}',
	});
	expect(d({ event: "something-error", error: "broke" })?.tone).toBe("error");
	expect(d({ event: "x", long: "a".repeat(500) })?.text.length).toBe(205);
});

test("lines that are no log lines are left out", () => {
	expect(describeLogLine(null)).toBeNull();
	expect(describeLogLine("text")).toBeNull();
	expect(describeLogLine({ at: 1 })).toBeNull();
	expect(describeLogLine({ at: 1, event: "" })).toBeNull();
});

const lines = [
	{ at: 1, event: "start", version: "0.15.0" },
	{ at: 2, event: "say", text: "Question: Where?" },
	{ at: 2, event: "question", n: 1, text: "Where?" },
	{ at: 3, event: "mcp-call", tool: "quests" },
	{ at: 4, event: "mcp-call", tool: "lookup", error: "No item." },
	{ at: 5, event: "note", level: "warn", text: "Port in use" },
	{ at: 6, event: "answered", n: 1, ms: 5000, tools: ["quests"] },
	{ at: 7, event: "undelivered", n: 2, ms: 1000, tools: [] },
	{ at: 8, event: "mcp-error", error: "EADDRINUSE" },
	{ at: 9, event: "mcp-refused", status: 401, why: "no token" },
	{ at: 10, event: "lane-broken", why: "x" },
	{ at: 11, event: "brain-exit", code: 2 },
	{ at: 12, event: "brain-exit", code: 0 },
	{ at: 13, event: "model-error", error: "429" },
	{ at: 14, event: "message", bytes: 3 },
];

test("filters: all, questions, tools, warnings and errors", () => {
	const entries = logEntries(lines, "en");
	const events = (f: Parameters<typeof filterLines>[1]) =>
		filterLines(entries, f).map((e) => `${e.at}:${e.event}`);
	// The duplicate say line is gone.
	expect(entries).toHaveLength(lines.length - 1);
	expect(events("all")).toHaveLength(entries.length);
	expect(events("questions")).toEqual([
		"2:question",
		"6:answered",
		"7:undelivered",
	]);
	expect(events("tools")).toEqual(["3:mcp-call", "4:mcp-call", "8:mcp-error"]);
	expect(events("problems")).toEqual([
		"4:mcp-call",
		"5:note",
		"7:undelivered",
		"8:mcp-error",
		"9:mcp-refused",
		"10:lane-broken",
		"11:brain-exit",
		"13:model-error",
	]);
});

test("oldest first, lines of the same moment in the order they came", () => {
	const entries = logEntries(
		[
			{ at: 5, event: "send", bytes: 1 },
			{ at: 2, event: "question", text: "a" },
			{ at: 2, event: "mcp-call", tool: "b" },
			{ at: 9, event: "game", pids: [] },
		],
		"en",
	);
	expect(entries.map((e) => `${e.at}:${e.event}`)).toEqual([
		"2:question",
		"2:mcp-call",
		"5:send",
		"9:game",
	]);
});

test("the copied text is the visible rows, one per line", () => {
	const entries = filterLines(
		logEntries(
			[
				{ at, event: "question", n: 1, text: "Where?" },
				{ at: at + 1000, event: "mcp-call", tool: "quests" },
			],
			"en",
		),
		"questions",
	);
	expect(plainText(entries)).toBe("23:41:03 question Where?");
	expect(plainText([])).toBe("");
});
