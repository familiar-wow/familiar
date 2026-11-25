// The built-in agent (ADR 0008) against a stand-in model: tool calls, memory per character,
// errors and the timeout. The real providers are checked by hand, see core/README.md.
import { expect, test } from "bun:test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { APICallError, RetryError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { Game } from "../game.ts";
import type { Log } from "../log.ts";
import type { Tool } from "../mcp/server.ts";
import { wowTools } from "../mcp/tools.ts";
import type { Settings } from "../settings.ts";
import type { Question, Turn } from "./chat.ts";
import {
	apiKey,
	describe,
	HISTORY,
	MAX_STEPS,
	ModelBrain,
	missing,
} from "./model.ts";

const usage = {
	inputTokens: {
		total: 10,
		noCache: 10,
		cacheRead: undefined,
		cacheWrite: undefined,
	},
	outputTokens: { total: 5, text: 5, reasoning: undefined },
};
const text = (t: string) => ({
	content: [{ type: "text" as const, text: t }],
	finishReason: { unified: "stop" as const, raw: undefined },
	usage,
	warnings: [],
});
const call = (name: string, input: Record<string, unknown>, id = "c1") => ({
	content: [
		{
			type: "tool-call" as const,
			toolCallId: id,
			toolName: name,
			input: JSON.stringify(input),
		},
	],
	finishReason: { unified: "tool-calls" as const, raw: undefined },
	usage,
	warnings: [],
});

const settings: Settings["brain"] = {
	use: "model",
	model: { provider: "openrouter", name: "test/model" },
	command: ["unused"],
	permissions: "deny",
	timeout: 5,
};
const events: { name: string; data?: Record<string, unknown> }[] = [];
const log: Log = {
	event: (name, data) => void events.push({ name, data }),
	say: () => {},
};

function turn() {
	const tools: string[] = [];
	const t: Turn = {
		onTool: (title) => void tools.push(title),
		onNote: () => {},
		onPermission: async () => false,
	};
	return { t, tools };
}

const hero: Question = {
	text: "What do I wear?",
	character: { name: "Hero", realm: "Realm", level: "33", class: "Druid" },
};

const equipment: Tool = {
	name: "equipment",
	description: "What the character wears.",
	inputSchema: {
		type: "object",
		properties: { slot: { type: "string" } },
		additionalProperties: false,
	},
	call: ({ slot }) => {
		if (slot === "broken")
			throw new Error("The game did not send eq within 15 s.");
		return { items: [{ slot: "mainHand", id: 13262, name: "Ashbringer" }] };
	},
};

/** The text of every message the model was given, by role. */
function seen(options: LanguageModelV4CallOptions): string[] {
	return options.prompt.map((m) => {
		const content =
			typeof m.content === "string"
				? m.content
				: m.content
						.map((p) => ("text" in p ? p.text : JSON.stringify(p)))
						.join(" ");
		return `${m.role}: ${content}`;
	});
}

test("calls the game tools, shows them, and answers", async () => {
	const prompts: string[][] = [];
	const replies = [
		call("equipment", { slot: "mainHand" }),
		text("You wield [item:13262]."),
	];
	const model = new MockLanguageModelV4({
		doGenerate: async (options) => {
			prompts.push(seen(options));
			return replies.shift() ?? text("?");
		},
	});
	const brain = new ModelBrain(settings, { log, tools: [equipment], model });
	const { t, tools } = turn();
	expect(await brain.ask(hero, t)).toBe("You wield [item:13262].");
	expect(tools).toEqual(["equipment: mainHand"]);
	// The rules go as the system prompt; the user message carries the character and question.
	expect(prompts[0]?.[0]).toStartWith(
		"system: The player asks you from inside the game",
	);
	expect(prompts[0]?.[0]).toContain("You cannot search the web.");
	expect(prompts[0]?.[1]).toContain("Hero (Realm), level 33 Druid");
	// The tool result goes back to the model in the second round.
	expect(prompts[1]?.join("\n")).toContain("Ashbringer");
	expect(events.at(-1)).toMatchObject({
		name: "model-answer",
		data: { steps: 2, tools: ["equipment"], provider: "openrouter" },
	});
});

test("remembers the conversation per character, without tool results", async () => {
	const prompts: string[][] = [];
	const replies = [
		call("equipment", {}),
		text("Ashbringer."),
		text("Still Ashbringer."),
		text("Hello Alt."),
	];
	const model = new MockLanguageModelV4({
		doGenerate: async (options) => {
			prompts.push(seen(options));
			return replies.shift() ?? text("?");
		},
	});
	const brain = new ModelBrain(settings, { log, tools: [equipment], model });
	await brain.ask(hero, turn().t);
	await brain.ask({ ...hero, text: "And now?" }, turn().t);
	const second = prompts[2]?.join("\n") ?? "";
	expect(second).toContain("Question: What do I wear?");
	expect(second).toContain("assistant: Ashbringer.");
	expect(second).toContain("Question: And now?");
	expect(second).not.toContain("mainHand");
	// Another character starts fresh.
	await brain.ask(
		{ text: "Hi", character: { name: "Alt", realm: "Realm" } },
		turn().t,
	);
	expect(prompts[3]?.join("\n")).not.toContain("Ashbringer");
	brain.forget();
});

test("a failing tool goes back to the model, which can still answer", async () => {
	const prompts: string[][] = [];
	const replies = [
		call("equipment", { slot: "broken" }),
		text("The game did not answer."),
	];
	const model = new MockLanguageModelV4({
		doGenerate: async (options) => {
			prompts.push(seen(options));
			return replies.shift() ?? text("?");
		},
	});
	const brain = new ModelBrain(settings, { log, tools: [equipment], model });
	expect(await brain.ask(hero, turn().t)).toBe("The game did not answer.");
	expect(prompts[1]?.join("\n")).toContain("did not send eq within 15 s");
});

test("stops after the last round of tool calls", async () => {
	let n = 0;
	const model = new MockLanguageModelV4({
		doGenerate: async () => call("equipment", {}, `c${n++}`),
	});
	const brain = new ModelBrain(settings, { log, tools: [equipment], model });
	expect(await brain.ask(hero, turn().t)).toContain(`all ${MAX_STEPS} rounds`);
	expect(n).toBe(MAX_STEPS);
});

test("reports provider errors and the timeout in words for the player", async () => {
	const refused = new MockLanguageModelV4({
		doGenerate: async () => {
			throw new APICallError({
				message: "Unauthorized",
				url: "https://example.invalid",
				requestBodyValues: {},
				statusCode: 401,
				isRetryable: false,
			});
		},
	});
	const brain = new ModelBrain(settings, { log, tools: [], model: refused });
	expect(await brain.ask(hero, turn().t)).toBe(
		"The model could not answer: the provider refused the API key (HTTP 401).",
	);

	const slow = new MockLanguageModelV4({
		doGenerate: ({ abortSignal }) =>
			new Promise((_, reject) =>
				abortSignal?.addEventListener("abort", () =>
					reject(new Error("aborted")),
				),
			),
	});
	const late = new ModelBrain(
		{ ...settings, timeout: 0.2 },
		{ log, tools: [], model: slow },
	);
	expect(await late.ask(hero, turn().t)).toBe("No answer within 0.2 s.");

	// Stopped while it works, the brain gives up at once instead of when its time is up.
	const stopped = new ModelBrain(
		{ ...settings, timeout: 30 },
		{ log, tools: [], model: slow },
	);
	const started = performance.now();
	const answer = stopped.ask(hero, turn().t);
	await Bun.sleep(50);
	stopped.stop();
	await answer;
	expect(performance.now() - started).toBeLessThan(5000);
});

test("finds the API key in the settings or the provider's environment variable", () => {
	const or = { provider: "openrouter" as const, name: "x" };
	expect(apiKey(or, { OPENROUTER_API_KEY: "env" })).toBe("env");
	expect(apiKey({ ...or, apiKey: "set" }, { OPENROUTER_API_KEY: "env" })).toBe(
		"set",
	);
	expect(missing(or, {})).toContain("OPENROUTER_API_KEY");
	expect(missing({ provider: "ollama", name: "llama" }, {})).toBeUndefined();
	expect(
		missing(
			{
				provider: "openai-compatible",
				name: "x",
				baseUrl: "http://127.0.0.1:8080/v1",
			},
			{},
		),
	).toBeUndefined();
});

test("without a key it says so instead of asking", async () => {
	const brain = new ModelBrain(
		{ ...settings, model: { provider: "anthropic", name: "claude-x" } },
		{ log, tools: [] },
	);
	const saved = process.env.ANTHROPIC_API_KEY;
	delete process.env.ANTHROPIC_API_KEY;
	try {
		expect(await brain.ask(hero, turn().t)).toContain("ANTHROPIC_API_KEY");
	} finally {
		if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
	}
});

test("keeps exactly the last HISTORY questions and answers", async () => {
	const prompts: string[][] = [];
	const model = new MockLanguageModelV4({
		doGenerate: async (options) => {
			prompts.push(seen(options));
			return text(`answer ${prompts.length}`);
		},
	});
	const brain = new ModelBrain(settings, { log, tools: [], model });
	for (let i = 1; i <= HISTORY + 2; i++)
		await brain.ask({ ...hero, text: `question ${i}` }, turn().t);
	const last = prompts.at(-1)?.join("\n") ?? "";
	// The last prompt holds the HISTORY exchanges before it, from question 2 on.
	expect(last).not.toContain("Question: question 1\n");
	expect(last).toContain("Question: question 2");
	expect(last).toContain(`assistant: answer ${HISTORY + 1}`);
	expect(prompts.at(-1)?.filter((m) => m.startsWith("user:"))).toHaveLength(
		HISTORY + 1,
	);
});

test("text beside a tool call in the last round is no answer and is not remembered", async () => {
	const prompts: string[][] = [];
	let n = 0;
	const model = new MockLanguageModelV4({
		doGenerate: async (options) => {
			prompts.push(seen(options));
			if (prompts.length > MAX_STEPS) return text("fresh");
			const step = call("equipment", {}, `c${n++}`);
			return {
				...step,
				content: [
					{ type: "text" as const, text: "Let me check." },
					...step.content,
				],
			};
		},
	});
	const brain = new ModelBrain(settings, { log, tools: [equipment], model });
	expect(await brain.ask(hero, turn().t)).toContain(`all ${MAX_STEPS} rounds`);
	await brain.ask({ ...hero, text: "again" }, turn().t);
	expect(prompts.at(-1)?.join("\n")).not.toContain("assistant: Let me check.");
});

for (const [what, args] of [
	["a wrong type", { slot: 123 }],
	["an unknown argument", { slot: "head", unexpected: true }],
	["null", null],
] as const)
	test(`arguments with ${what} go back to the model, and the tool does not run`, async () => {
		const prompts: string[][] = [];
		let ran = 0;
		const counted: Tool = {
			...equipment,
			call: (a) => {
				ran++;
				return equipment.call(a);
			},
		};
		const first = {
			...call("equipment", {}),
			content: [
				{
					type: "tool-call" as const,
					toolCallId: "c1",
					toolName: "equipment",
					input: JSON.stringify(args),
				},
			],
		};
		const replies = [first, text("Sorry.")];
		const model = new MockLanguageModelV4({
			doGenerate: async (options) => {
				prompts.push(seen(options));
				return replies.shift() ?? text("?");
			},
		});
		const brain = new ModelBrain(settings, { log, tools: [counted], model });
		const { t, tools } = turn();
		expect(await brain.ask(hero, t)).toBe("Sorry.");
		expect(ran).toBe(0);
		expect(tools).toEqual([]);
		expect(prompts[1]?.join("\n")).toContain("Invalid arguments for equipment");
	});

test("the timeout stops a tool that still waits for the game, and the next question runs", async () => {
	const stuck: Tool = { ...equipment, call: () => new Promise(() => {}) };
	let n = 0;
	const model = new MockLanguageModelV4({
		doGenerate: async () => (n++ === 0 ? call("equipment", {}) : text("next")),
	});
	const brain = new ModelBrain(
		{ ...settings, timeout: 0.2 },
		{ log, tools: [stuck], model },
	);
	const started = performance.now();
	expect(await brain.ask(hero, turn().t)).toBe("No answer within 0.2 s.");
	expect(performance.now() - started).toBeLessThan(1000);
	expect(await brain.ask({ ...hero, text: "next" }, turn().t)).toBe("next");
});

test("provider errors reach the player and the log in fixed words, never with the key", async () => {
	const key = "sk-test-SECRET-1234";
	const bad = new APICallError({
		message: `Invalid request: key ${key} is malformed`,
		url: "https://example.invalid",
		requestBodyValues: { key },
		statusCode: 400,
		isRetryable: false,
	});
	expect(describe(bad, key)).toBe(
		"the provider rejected the request (HTTP 400). Check brain.model.",
	);
	const limited = new RetryError({
		message: `Failed after 2 attempts. Last error: ${key}`,
		reason: "maxRetriesExceeded",
		errors: [
			new APICallError({
				message: key,
				url: "https://example.invalid",
				requestBodyValues: {},
				statusCode: 429,
				isRetryable: true,
			}),
		],
	});
	expect(describe(limited, key)).toContain("HTTP 429");
	expect(describe(new Error(`boom ${key}`), key)).toBe(
		"an unexpected error (Error).",
	);

	const logged: string[] = [];
	const model = new MockLanguageModelV4({
		doGenerate: async () => {
			throw bad;
		},
	});
	const brain = new ModelBrain(settings, {
		log: {
			event: (_, data) => void logged.push(JSON.stringify(data)),
			say: () => {},
		},
		tools: [],
		model,
	});
	const reply = await brain.ask(hero, turn().t);
	expect(reply).not.toContain(key);
	expect(logged.join("\n")).not.toContain(key);
});

test("a provider that cannot be set up answers with a message, and the next question still runs", async () => {
	const saved = {
		url: process.env.OPENAI_BASE_URL,
		key: process.env.OPENAI_API_KEY,
	};
	process.env.OPENAI_BASE_URL = "";
	process.env.OPENAI_API_KEY = "sk-test";
	try {
		const brain = new ModelBrain(
			{ ...settings, model: { provider: "openai", name: "gpt-test" } },
			{ log, tools: [] },
		);
		const first = await Promise.race([
			brain.ask(hero, turn().t),
			Bun.sleep(2000).then(() => "hung"),
		]);
		expect(first).toContain("could not set up openai");
		const second = await Promise.race([
			brain.ask(hero, turn().t),
			Bun.sleep(2000).then(() => "hung"),
		]);
		expect(second).toContain("could not set up openai");
	} finally {
		if (saved.url === undefined) delete process.env.OPENAI_BASE_URL;
		else process.env.OPENAI_BASE_URL = saved.url;
		if (saved.key === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = saved.key;
	}
});

test("after the timeout, a late tool call from the model neither runs nor shows", async () => {
	let ran = 0;
	const counted: Tool = {
		...equipment,
		call: (a) => {
			ran++;
			return equipment.call(a);
		},
	};
	// A model that ignores the abort and asks for a tool after the deadline.
	const model = new MockLanguageModelV4({
		doGenerate: async () => {
			await Bun.sleep(300);
			return call("equipment", {});
		},
	});
	const brain = new ModelBrain(
		{ ...settings, timeout: 0.1 },
		{ log, tools: [counted], model },
	);
	const { t, tools } = turn();
	expect(await brain.ask(hero, t)).toBe("No answer within 0.1 s.");
	await Bun.sleep(500);
	expect(ran).toBe(0);
	expect(tools).toEqual([]);
});

test("keeps at most 2000 characters of each answer", async () => {
	const prompts: string[][] = [];
	const long = `${"x".repeat(2000)}TAIL`;
	const replies = [text(long), text("ok")];
	const model = new MockLanguageModelV4({
		doGenerate: async (options) => {
			prompts.push(seen(options));
			return replies.shift() ?? text("?");
		},
	});
	const brain = new ModelBrain(settings, { log, tools: [], model });
	expect(await brain.ask(hero, turn().t)).toBe(long);
	await brain.ask({ ...hero, text: "more" }, turn().t);
	const kept = prompts[1]?.join("\n") ?? "";
	expect(kept).toContain("x".repeat(2000));
	expect(kept).not.toContain("TAIL");
});

test("the real game tools check integers and booleans before they ask the game", async () => {
	const cases: [string, Record<string, unknown>, string][] = [
		["quests", { questId: "783" }, "Invalid arguments for quests"],
		["quests", { questId: 78.3 }, "Invalid arguments for quests"],
		["trainer", { onlyAvailable: "yes" }, "Invalid arguments for trainer"],
		// Valid arguments pass the check and reach the game, which is not connected here.
		["quests", { questId: 783 }, "No connection to the game client"],
		["trainer", { onlyAvailable: true }, "No connection to the game client"],
	];
	for (const [name, args, expected] of cases) {
		const prompts: string[][] = [];
		const first = {
			...call(name, {}),
			content: [
				{
					type: "tool-call" as const,
					toolCallId: "c1",
					toolName: name,
					input: JSON.stringify(args),
				},
			],
		};
		const replies = [first, text("done")];
		const model = new MockLanguageModelV4({
			doGenerate: async (options) => {
				prompts.push(seen(options));
				return replies.shift() ?? text("?");
			},
		});
		const brain = new ModelBrain(settings, {
			log,
			tools: wowTools(new Game()),
			model,
		});
		await brain.ask(hero, turn().t);
		expect(
			`${name} ${JSON.stringify(args)}: ${prompts[1]?.join("\n")}`,
		).toContain(expected);
	}
});
