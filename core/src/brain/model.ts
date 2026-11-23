// The built-in agent (ADR 0001, ADR 0008): for players without an agent of their own. It asks a
// model through its provider's API and lets the model call the `wow` tools, which run right here
// in the app. It is deliberately small: Familiar's rules as the system prompt, the game tools, a
// few rounds of tool calls, and a short memory of the conversation per character while the app
// runs. No web, files or shell.
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
	APICallError,
	generateText,
	isStepCount,
	jsonSchema,
	type LanguageModel,
	type ModelMessage,
	type ToolSet,
	tool,
} from "ai";
import type { Log } from "../log.ts";
import type { Tool } from "../mcp/server.ts";
import type { Settings } from "../settings.ts";
import { asked, type Brain, type Question, rules, type Turn } from "./chat.ts";

type ModelSettings = NonNullable<Settings["brain"]["model"]>;

/** Where each provider lives and which environment variable holds its key, if it needs one. */
const PRESETS: Record<
	ModelSettings["provider"],
	{ baseUrl?: string; env?: string }
> = {
	openai: { env: "OPENAI_API_KEY" },
	anthropic: { env: "ANTHROPIC_API_KEY" },
	google: { env: "GOOGLE_GENERATIVE_AI_API_KEY" },
	openrouter: {
		baseUrl: "https://openrouter.ai/api/v1",
		env: "OPENROUTER_API_KEY",
	},
	deepseek: { baseUrl: "https://api.deepseek.com/v1", env: "DEEPSEEK_API_KEY" },
	ollama: { baseUrl: "http://127.0.0.1:11434/v1" },
	lmstudio: { baseUrl: "http://127.0.0.1:1234/v1" },
	"openai-compatible": {},
};

/** Rounds of model calls per question; each round may call several tools. */
export const MAX_STEPS = 8;
/** Messages kept per character: the last questions and answers, without tool results. */
const HISTORY = 12;

/** The key for `model`, from the settings or the provider's environment variable. */
export function apiKey(
	model: ModelSettings,
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	const name = PRESETS[model.provider].env;
	return model.apiKey ?? (name ? env[name] : undefined);
}

/** What is missing before the model can answer, as a message for the player; or undefined. */
export function missing(
	model: ModelSettings,
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	const name = PRESETS[model.provider].env;
	if (!name || apiKey(model, env)) return undefined;
	return `No API key for ${model.provider}. Set the environment variable ${name} and restart Familiar, or put it into brain.model.apiKey in the settings.`;
}

/** The model the settings name, through the AI SDK provider that speaks its API. */
export function languageModel(
	model: ModelSettings,
	env: Record<string, string | undefined> = process.env,
): LanguageModel {
	const key = apiKey(model, env);
	const baseURL = model.baseUrl ?? PRESETS[model.provider].baseUrl;
	switch (model.provider) {
		case "openai":
			return createOpenAI({ apiKey: key, baseURL })(model.name);
		case "anthropic":
			return createAnthropic({ apiKey: key, baseURL })(model.name);
		case "google":
			return createGoogleGenerativeAI({ apiKey: key, baseURL })(model.name);
		default:
			return createOpenAICompatible({
				name: model.provider,
				apiKey: key,
				baseURL: baseURL ?? "",
			})(model.name);
	}
}

export interface ModelBrainOptions {
	log: Log;
	/** The `wow` tools, called in this process. */
	tools: Tool[];
	/** The model to ask; by default the one the settings name. Tests pass a stand-in. */
	model?: LanguageModel;
}

export class ModelBrain implements Brain {
	private readonly history = new Map<string, ModelMessage[]>();
	private queue: Promise<void> = Promise.resolve();
	private model?: LanguageModel;

	constructor(
		private readonly settings: Settings["brain"],
		private readonly options: ModelBrainOptions,
	) {
		this.model = options.model;
	}

	/** Asks one question at a time. Resolves with the answer or a message for the player. */
	ask(question: Question, turn: Turn): Promise<string> {
		return new Promise((reply) => {
			this.queue = this.queue.then(async () =>
				reply(await this.answer(question, turn)),
			);
		});
	}

	/** Forgets every conversation, as after a restart. */
	forget(): void {
		this.history.clear();
	}

	private async answer(question: Question, turn: Turn): Promise<string> {
		const settings = this.settings.model;
		if (!settings)
			return "No model is set: brain.model is missing in the settings.";
		if (!this.model) {
			const problem = missing(settings);
			if (problem) return problem;
			this.model = languageModel(settings);
		}
		const { log } = this.options;
		const c = question.character;
		const who =
			c.name || c.realm ? `${c.name ?? ""}-${c.realm ?? ""}` : "unknown";
		const past = this.history.get(who) ?? [];
		const user: ModelMessage = { role: "user", content: asked(question) };
		const timeout = this.settings.timeout;
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), timeout * 1000);
		const started = performance.now();
		try {
			const result = await generateText({
				model: this.model,
				system: rules({ web: false }),
				messages: [...past, user],
				tools: this.toolSet(turn),
				stopWhen: isStepCount(MAX_STEPS),
				abortSignal: abort.signal,
				maxRetries: 1,
			});
			const text = result.text.trim();
			const tools = result.steps.flatMap((s) =>
				s.toolCalls.map((t) => t.toolName),
			);
			log.event("model-answer", {
				provider: settings.provider,
				model: settings.name,
				ms: Math.round(performance.now() - started),
				steps: result.steps.length,
				tools,
				inputTokens: result.totalUsage.inputTokens,
				outputTokens: result.totalUsage.outputTokens,
			});
			if (!text)
				return result.steps.length >= MAX_STEPS
					? `The model used all ${MAX_STEPS} rounds of tool calls without an answer. Ask again, perhaps more narrowly.`
					: "The model gave an empty answer.";
			this.history.set(
				who,
				[...past, user, { role: "assistant" as const, content: text }].slice(
					-HISTORY,
				),
			);
			return text;
		} catch (error) {
			if (abort.signal.aborted) return `No answer within ${timeout} s.`;
			log.event("model-error", {
				provider: settings.provider,
				model: settings.name,
				error: describe(error),
			});
			return `The model could not answer: ${describe(error)}`;
		} finally {
			clearTimeout(timer);
		}
	}

	/** The `wow` tools for the model. Each call shows in the window's status line. */
	private toolSet(turn: Turn): ToolSet {
		return Object.fromEntries(
			this.options.tools.map((t) => [
				t.name,
				tool({
					description: t.description,
					inputSchema: jsonSchema<Record<string, unknown>>(t.inputSchema),
					execute: async (args) => {
						const shown = Object.values(args ?? {})
							.map(String)
							.join(", ");
						turn.onTool(shown ? `${t.name}: ${shown}` : t.name);
						return await t.call(args ?? {});
					},
				}),
			]),
		);
	}
}

/** A provider's error in a few words, without anything from the request. */
function describe(error: unknown): string {
	if (APICallError.isInstance(error)) {
		if (error.statusCode === 401 || error.statusCode === 403)
			return `the provider refused the API key (HTTP ${error.statusCode}).`;
		if (error.statusCode === 404)
			return "the provider does not know this model (HTTP 404). Check brain.model.name.";
		if (error.statusCode === 429)
			return "the provider is rate limiting or the account has no credit left (HTTP 429).";
		return `HTTP ${error.statusCode ?? "error"}: ${error.message}`;
	}
	return error instanceof Error ? error.message : String(error);
}
