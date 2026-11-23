// The built-in agent (ADR 0008) against a stand-in model: tool calls, memory per character,
// errors and the timeout. The real providers are checked by hand, see core/README.md.
import { expect, test } from "bun:test";
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { Log } from "../log.ts";
import type { Tool } from "../mcp/server.ts";
import type { Settings } from "../settings.ts";
import type { Question, Turn } from "./chat.ts";
import { apiKey, MAX_STEPS, ModelBrain, missing } from "./model.ts";

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
