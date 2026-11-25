import { describe, expect, test } from "bun:test";
import { translator } from "./i18n.ts";
import {
	ago,
	brainLine,
	brainText,
	characterParts,
	connection,
	dayPart,
	detail,
	detailText,
	type Facts,
} from "./status.ts";
import type { Status } from "./types.ts";

const en = translator("en");
const de = translator("de");

function status(over: Partial<Status> = {}): Status {
	return {
		running: true,
		client: "C:\\WoW\\_forever_",
		addon: { installed: true },
		game: { running: true, hello: "Familiar 0.14.0", lastContact: 1000 },
		brain: { kind: "agent", command: ["hermes", "acp"] },
		problems: [],
		...over,
	};
}

describe("connection", () => {
	test("connected needs a running Familiar, a running game and a hello", () => {
		expect(connection({ status: status() })).toBe("connected");
		expect(connection({ status: status({ running: false }) })).toBe("waiting");
		expect(
			connection({ status: status({ game: { running: false, hello: "x" } }) }),
		).toBe("waiting");
		expect(connection({ status: status({ game: { running: true } }) })).toBe(
			"waiting",
		);
		expect(
			connection({ status: status({ game: { running: true, hello: "" } }) }),
		).toBe("waiting");
		expect(connection({})).toBe("waiting");
	});

	test("error wins over everything", () => {
		expect(connection({ status: status(), exited: true })).toBe("error");
		expect(connection({ status: status(), failure: "No." })).toBe("error");
		expect(connection({ status: status({ problems: ["Port in use."] }) })).toBe(
			"error",
		);
		// Even a failure with an empty message is a failure.
		expect(connection({ failure: "" })).toBe("error");
	});
});

describe("detail line", () => {
	const cases: [string, Facts, string][] = [
		[
			"exited first",
			{ status: status({ problems: ["x"] }), exited: true, failure: "f" },
			"Familiar's core stopped.",
		],
		[
			"then a failed step, as the core wrote it",
			{
				status: status({ problems: ["x"] }),
				failure: "WoW Forever was not found.",
			},
			"WoW Forever was not found.",
		],
		[
			"then problems",
			{ status: status({ problems: ["x"] }) },
			"Something needs your attention.",
		],
		["then starting, without a status", {}, "Familiar is starting."],
		[
			"then starting",
			{ status: status({ running: false }) },
			"Familiar is starting.",
		],
		[
			"then no client",
			{ status: status({ client: undefined }) },
			"No WoW Forever found.",
		],
		[
			"then no addon",
			{ status: status({ addon: { installed: false } }) },
			"The addon is not installed yet.",
		],
		[
			"then no game",
			{ status: status({ game: { running: false } }) },
			"Waiting for WoW.",
		],
		[
			"then no hello",
			{ status: status({ game: { running: true } }) },
			"WoW runs. Type /reload in game if Familiar does not answer.",
		],
		["else connected", { status: status() }, "Connected"],
	];
	for (const [name, facts, text] of cases)
		test(name, () => expect(detailText(detail(facts), en)).toBe(text));

	test("never reads connected while the state is an error", () => {
		const facts: Facts[] = [
			{ status: status(), exited: true },
			{ status: status(), failure: "x" },
			{ status: status({ problems: ["x"] }) },
		];
		for (const f of facts) {
			expect(connection(f)).toBe("error");
			expect(detail(f).kind).not.toBe("connected");
		}
	});

	test("German", () => {
		expect(
			detailText(detail({ status: status({ game: { running: false } }) }), de),
		).toBe("Warte auf WoW.");
	});
});

describe("brain line", () => {
	const last = { at: 1, ms: 24_100, tools: [] };
	test("own agent with its command", () => {
		const b = brainLine(status({ last }), en, "en");
		expect(b).toEqual({
			name: "Own agent",
			detail: "hermes acp",
			last: "last answer 24.1 s",
		});
		expect(brainText(b)).toBe("Own agent hermes acp · last answer 24.1 s");
	});

	test("own agent on another computer", () => {
		const b = brainLine(
			status({
				brain: { kind: "ssh", host: "homelab", command: ["hermes", "acp"] },
			}),
			en,
			"en",
		);
		expect(brainText(b)).toBe("Own agent on homelab");
	});

	test("models by provider name", () => {
		const names: [string, string][] = [
			["chatgpt", "ChatGPT plan"],
			["openai", "OpenAI"],
			["anthropic", "Anthropic"],
			["google", "Google"],
			["openrouter", "OpenRouter"],
			["deepseek", "DeepSeek"],
			["ollama", "Ollama"],
			["lmstudio", "LM Studio"],
			["compatible", "compatible"],
		];
		for (const [provider, name] of names)
			expect(
				brainLine(
					status({ brain: { kind: "model", provider, model: "m-1" } }),
					en,
					"en",
				),
			).toEqual({ name, detail: "m-1" });
	});

	test("echo, and a brain not known yet", () => {
		expect(
			brainText(brainLine(status({ brain: { kind: "echo" } }), en, "en")),
		).toBe("Echo (test)");
		expect(brainText(brainLine(undefined, en, "en"))).toBe("Not set up yet");
	});

	test("German with a decimal comma", () => {
		expect(
			brainText(brainLine(status({ last: { ...last, ms: 3800 } }), de, "de")),
		).toBe("Eigener Agent hermes acp · letzte Antwort 3,8 s");
		expect(
			brainLine(
				status({ brain: { kind: "model", provider: "chatgpt", model: "gpt" } }),
				de,
				"de",
			).name,
		).toBe("ChatGPT-Abo");
	});
});

describe("character", () => {
	test("shows only what is present", () => {
		const full = {
			name: "Moonbreeze",
			level: "35",
			race: "Tauren",
			class: "Druid",
			zone: "Desolace",
		};
		expect(characterParts(full, en)).toEqual({
			name: "Moonbreeze",
			line: "Level 35 Tauren Druid · Desolace",
		});
		expect(
			characterParts({ name: "Moonbreeze", zone: "Desolace" }, en),
		).toEqual({
			name: "Moonbreeze",
			line: "Desolace",
		});
		expect(characterParts({ level: "35" }, de)).toEqual({ line: "Stufe 35" });
		expect(characterParts(undefined, en)).toEqual({});
		expect(characterParts({ name: " " }, en)).toEqual({});
	});
});

test("relative time", () => {
	expect(ago(0, 4000, en)).toBe("4 s ago");
	expect(ago(0, 185_000, en)).toBe("3 min ago");
	expect(ago(0, 7_300_000, de)).toBe("vor 2 h");
	expect(ago(5000, 0, en)).toBe("0 s ago");
});

test("part of the day by local time", () => {
	const at = (h: number) => new Date(2026, 10, 25, h, 30);
	expect(dayPart(at(4))).toBe("evening");
	expect(dayPart(at(5))).toBe("morning");
	expect(dayPart(at(12))).toBe("afternoon");
	expect(dayPart(at(18))).toBe("evening");
	expect(dayPart(at(23))).toBe("evening");
});
