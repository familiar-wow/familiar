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
	RetryError,
	streamText,
	type ToolSet,
	tool,
} from "ai";
import { z } from "zod";
import type { Log } from "../log.ts";
import type { Tool } from "../mcp/server.ts";
import type { Settings } from "../settings.ts";
import { asked, type Brain, type Question, rules, type Turn } from "./chat.ts";
import { type ChatGpt, ChatGptError, USAGE_URL } from "./chatgpt.ts";

type ModelSettings = NonNullable<Settings["brain"]["model"]>;
type Env = Record<string, string | undefined>;

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
	// Signed in through the browser (`familiar login chatgpt`), no key (brain/chatgpt.ts).
	chatgpt: {},
};

/** Rounds of model calls per question; each round may call several tools. */
export const MAX_STEPS = 8;
/** Questions and answers kept per character, without tool results. */
export const HISTORY = 12;
/** Characters of an answer kept in the history; the window shows less anyway. */
const KEPT = 2000;
const CANCELLED = "The question was cancelled.";

/** The key for `model`, from the settings or the provider's environment variable. */
export function apiKey(
	model: ModelSettings,
	env: Env = process.env,
): string | undefined {
	const name = PRESETS[model.provider].env;
	return model.apiKey ?? (name ? env[name] : undefined);
}

/** What is missing before the model can answer, as a message for the player; or undefined. */
export function missing(
	model: ModelSettings,
	env: Env = process.env,
): string | undefined {
	const name = PRESETS[model.provider].env;
	if (!name || apiKey(model, env)) return undefined;
	return `No API key for ${model.provider}. Set the environment variable ${name} and restart Familiar, or put it into brain.model.apiKey in the settings.`;
}

/** The model the settings name, through the AI SDK provider that speaks its API. */
export function languageModel(
	model: ModelSettings,
	env: Env = process.env,
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
	/** The ChatGPT sign-in, for the provider "chatgpt". */
	chatgpt?: ChatGpt;
}

export class ModelBrain implements Brain {
	private readonly history = new Map<string, ModelMessage[]>();
	private queue: Promise<void> = Promise.resolve();
	private model?: LanguageModel;
	/** Checks the model's arguments against each tool's schema before the tool runs. */
	private readonly validators = new Map<string, z.ZodType>();
	/** Aborts the answer in progress, so a stopped Familiar does not keep a model working. */
	private current?: AbortController;

	constructor(
		private readonly settings: Settings["brain"],
		private readonly options: ModelBrainOptions,
	) {
		this.model = options.model;
		for (const t of options.tools)
			this.validators.set(
				t.name,
				z.fromJSONSchema(t.inputSchema as z.core.JSONSchema.JSONSchema),
			);
	}

	/** Asks one question at a time. Resolves with the answer or a message for the player. */
	ask(question: Question, turn: Turn): Promise<string> {
		return new Promise((reply) => {
			this.queue = this.queue
				.then(async () => reply(await this.answer(question, turn)))
				// answer() does not throw. Should it ever, the player still hears, and the next
				// question still runs.
				.catch((error) =>
					reply(`The built-in agent failed: ${describe(error, undefined)}`),
				);
		});
	}

	/** Forgets every conversation, as after a restart. */
	forget(): void {
		this.history.clear();
	}

	/** Stops the answer in progress; it ends as if its time were up. */
	stop(): void {
		this.current?.abort();
	}

	private async answer(question: Question, turn: Turn): Promise<string> {
		const settings = this.settings.model;
		if (!settings)
			return "No model is set: brain.model is missing in the settings.";
		const { log } = this.options;
		const plan = settings.provider === "chatgpt";
		let key = this.options.model ? undefined : apiKey(settings);
		const timeout = this.settings.timeout;
		const abort = new AbortController();
		this.current = abort;
		const timer = setTimeout(() => abort.abort(), timeout * 1000);
		// The deadline holds even if a provider, a tool or the sign-in ignores the abort.
		const deadline = new Promise<never>((_, reject) =>
			abort.signal.addEventListener(
				"abort",
				() => reject(new Error(CANCELLED)),
				{ once: true },
			),
		);
		deadline.catch(() => {});
		let done = false;
		// On the plan: whether each streamed response ended with `response.completed`.
		const ends: boolean[] = [];
		try {
			if (plan && !this.options.model) {
				// A fresh access token for each question: they last an hour. Renewing it counts
				// against the question's time like everything else.
				try {
					if (!this.options.chatgpt)
						throw new ChatGptError("ChatGPT sign-in is not set up.");
					const chatgpt = this.options.chatgpt;
					key = await Promise.race([chatgpt.accessToken(), deadline]);
					this.model = createOpenAI({
						apiKey: key,
						baseURL: chatgpt.api,
						fetch: watchEnds(ends),
					}).responses(settings.name);
				} catch (error) {
					if (abort.signal.aborted) return `No answer within ${timeout} s.`;
					log.event("model-error", {
						provider: settings.provider,
						model: settings.name,
						during: "sign-in",
						error: describe(error, key),
					});
					return describe(error, key);
				}
			}
			if (!this.model) {
				const problem = missing(settings);
				if (problem) return problem;
				try {
					this.model = languageModel(settings);
				} catch (error) {
					log.event("model-error", {
						provider: settings.provider,
						model: settings.name,
						during: "setup",
						error: describe(error, key),
					});
					return `The built-in agent could not set up ${settings.provider}: ${describe(error, key)}`;
				}
			}
			const c = question.character;
			const who =
				c.name || c.realm ? `${c.name ?? ""}-${c.realm ?? ""}` : "unknown";
			const past = this.history.get(who) ?? [];
			const user: ModelMessage = { role: "user", content: asked(question) };
			const started = performance.now();
			try {
				const request = {
					model: this.model,
					messages: [...past, user],
					tools: this.toolSet(turn, () => done, plan),
					stopWhen: isStepCount(MAX_STEPS),
					abortSignal: abort.signal,
					maxRetries: 1,
				};
				const result = await Promise.race([
					plan
						? planText({ ...request, instructions: rules({ web: false }) })
						: generateText({ ...request, system: rules({ web: false }) }),
					deadline,
				]);
				const text = result.text.trim();
				const tools = result.steps.flatMap((s) =>
					s.toolCalls.map((t) => t.toolName),
				);
				// The last round still asked for tools: the model ran out of rounds, and any text
				// it wrote alongside is a preamble, not the answer.
				const exhausted = (result.steps.at(-1)?.toolCalls.length ?? 0) > 0;
				// On the plan an answer counts only when every response said it is complete.
				const cut =
					plan &&
					(result.steps.at(-1)?.finishReason !== "stop" ||
						(!this.options.model &&
							(ends.length === 0 || ends.some((end) => !end))));
				const summary = {
					provider: settings.provider,
					model: settings.name,
					ms: Math.round(performance.now() - started),
					steps: result.steps.length,
					tools,
					inputTokens: result.totalUsage.inputTokens,
					outputTokens: result.totalUsage.outputTokens,
				};
				if (exhausted) {
					log.event("model-error", { ...summary, error: "out of rounds" });
					return `The model used all ${MAX_STEPS} rounds of tool calls without an answer. Ask again, perhaps more narrowly.`;
				}
				if (cut) {
					log.event("model-error", { ...summary, error: "incomplete answer" });
					return "ChatGPT's answer was cut off. Ask again.";
				}
				if (!text) {
					log.event("model-error", { ...summary, error: "empty answer" });
					return "The model gave an empty answer.";
				}
				log.event("model-answer", summary);
				const answer: ModelMessage = {
					role: "assistant",
					content: text.slice(0, KEPT),
				};
				this.history.set(who, [...past, user, answer].slice(-2 * HISTORY));
				return text;
			} catch (error) {
				if (abort.signal.aborted) return `No answer within ${timeout} s.`;
				log.event("model-error", {
					provider: settings.provider,
					model: settings.name,
					error: describe(error, key),
				});
				return `The model could not answer: ${describe(error, key)}`;
			}
		} finally {
			done = true;
			clearTimeout(timer);
			abort.abort();
		}
	}

	/**
	 * The `wow` tools for the model. Each call shows in the window's status line. Arguments that
	 * do not fit a tool's schema go back to the model as an error, and so does a cancelled
	 * question: a tool still waiting for the game stops waiting.
	 */
	private toolSet(turn: Turn, done: () => boolean, plan = false): ToolSet {
		return Object.fromEntries(
			this.options.tools.map((t) => [
				t.name,
				tool({
					description: t.description,
					inputSchema: jsonSchema<Record<string, unknown>>(t.inputSchema),
					// ChatGPT plan usage takes function tools only inside a namespace.
					...(plan ? { providerOptions: { openai: { namespace: WOW } } } : {}),
					execute: async (input, { abortSignal }) => {
						// A call without arguments is an empty object; null or anything else is checked.
						const value = input === undefined ? {} : input;
						const parsed = this.validators.get(t.name)?.safeParse(value);
						if (parsed && !parsed.success)
							throw new Error(
								`Invalid arguments for ${t.name}: ${z.prettifyError(parsed.error)}`,
							);
						if (done() || abortSignal?.aborted) throw new Error(CANCELLED);
						const args = (parsed?.data ?? {}) as Record<string, unknown>;
						const shown = Object.values(args).map(String).join(", ");
						turn.onTool(shown ? `${t.name}: ${shown}` : t.name);
						return await abortable(Promise.resolve(t.call(args)), abortSignal);
					},
				}),
			]),
		);
	}
}

const WOW = {
	name: "wow",
	description:
		"The player's character and game state in WoW Forever, read live from the game.",
};

/**
 * A fetch that notes for each streamed response whether it ended with `response.completed`.
 * The AI SDK reports an incomplete response without a reason as finished, so the stream itself
 * is watched (developers.openai.com/siwc: only `response.completed` is a successful answer).
 */
function watchEnds(ends: boolean[]): typeof fetch {
	const watched = async (input: string | URL | Request, init?: RequestInit) => {
		const response = await fetch(input, init);
		// Only answers that stream count; an error the SDK retries is no answer at all.
		if (
			!response.ok ||
			!response.body ||
			!response.headers.get("content-type")?.includes("text/event-stream")
		)
			return response;
		const index = ends.push(false) - 1;
		const decoder = new TextDecoder();
		// Whole events only: a long answer's final event can span many chunks.
		let pending = "";
		const look = (event: string) => {
			const data = event
				.split(/\r?\n/)
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trimStart())
				.join("\n");
			if (!data) return;
			let type: unknown;
			try {
				type = (JSON.parse(data) as { type?: unknown }).type;
			} catch {
				return;
			}
			if (type === "response.completed") ends[index] = true;
			else if (type === "response.incomplete" || type === "response.failed")
				ends[index] = false;
		};
		const body = response.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					pending += decoder.decode(chunk, { stream: true });
					const events = pending.split(/\r?\n\r?\n/);
					pending = events.pop() ?? "";
					for (const event of events) look(event);
					controller.enqueue(chunk);
				},
				flush() {
					look(pending + decoder.decode());
				},
			}),
		);
		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
	return Object.assign(watched, {
		preconnect: fetch.preconnect,
	}) as typeof fetch;
}

/**
 * One question on the player's ChatGPT plan. OpenAI's rules for it: streamed, nothing stored at
 * OpenAI, the rules as `instructions` rather than a system message, and no sampling settings.
 */
async function planText(options: {
	model: LanguageModel;
	messages: ModelMessage[];
	tools: ToolSet;
	stopWhen: ReturnType<typeof isStepCount>;
	abortSignal: AbortSignal;
	maxRetries: number;
	instructions: string;
}) {
	const { instructions, ...rest } = options;
	let failure: unknown;
	const result = streamText({
		...rest,
		providerOptions: { openai: { store: false, instructions } },
		onError: ({ error }) => {
			failure ??= error;
		},
	});
	try {
		const [text, steps, totalUsage] = await Promise.all([
			result.text,
			result.steps,
			result.totalUsage,
		]);
		if (failure) throw failure;
		return { text, steps, totalUsage };
	} catch (error) {
		throw failure ?? error;
	}
}

/** `work`, or a rejection as soon as `signal` aborts. */
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return work;
	return new Promise<T>((resolve, reject) => {
		const stop = () => reject(new Error(CANCELLED));
		if (signal.aborted) return stop();
		signal.addEventListener("abort", stop, { once: true });
		work
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", stop));
	});
}

/**
 * A provider's error in fixed words. A provider's own message may quote the request, and with
 * it a key, so none of it reaches the log or the game; the key is masked on top of that.
 */
export function describe(error: unknown, key: string | undefined): string {
	const cause = RetryError.isInstance(error) ? error.lastError : error;
	// Our own messages for the ChatGPT sign-in hold no secrets.
	if (cause instanceof ChatGptError) return cause.message;
	const plan = planProblem(cause);
	if (plan) return plan;
	let text: string;
	if (APICallError.isInstance(cause)) {
		const status = cause.statusCode;
		if (status === 401 || status === 403)
			text = `the provider refused the API key (HTTP ${status}).`;
		else if (status === 402)
			text = "the account has no credit left (HTTP 402).";
		else if (status === 404)
			text =
				"the provider does not know this model (HTTP 404). Check brain.model.name.";
		else if (status === 429)
			text =
				"the provider is rate limiting or the account has no credit left (HTTP 429).";
		else if (status !== undefined && status >= 500)
			text = `the provider has a problem (HTTP ${status}). Try again later.`;
		else if (status !== undefined)
			text = `the provider rejected the request (HTTP ${status}). Check brain.model.`;
		else text = "the provider could not be reached.";
	} else if (
		cause instanceof Error &&
		/fetch|ECONNREFUSED|ENOTFOUND|network/i.test(cause.message)
	)
		text =
			"the provider could not be reached. Check the address and the connection.";
	else {
		// Only a name like AI_InvalidArgumentError, never text from the error itself.
		const name = cause instanceof Error ? cause.name : "";
		text = /^[A-Za-z_]{0,40}Error$/.test(name)
			? `an unexpected error (${name}).`
			: "an unexpected error.";
	}
	return key ? text.replaceAll(key, "***") : text;
}

/**
 * The ChatGPT plan's own errors (developers.openai.com/siwc, errors and recovery), found by
 * their fixed codes anywhere in the error, and answered with fixed words.
 */
function planProblem(error: unknown): string | undefined {
	let seen = "";
	try {
		seen = APICallError.isInstance(error)
			? `${error.responseBody ?? ""} ${JSON.stringify(error.data ?? "")}`
			: `${error instanceof Error ? error.message : ""} ${JSON.stringify(error)}`;
	} catch {
		return undefined;
	}
	if (seen.includes("subscription_sharing_usage_limit_exceeded"))
		return `You reached a ChatGPT usage limit, for your plan or for Familiar. Manage usage: ${USAGE_URL}`;
	if (seen.includes("subscription_sharing_user_not_eligible"))
		return "This ChatGPT account or workspace cannot use its plan in other apps. Use an API key instead.";
	if (
		seen.includes("subscription_sharing_usage_unavailable") ||
		seen.includes("subscription_sharing_user_unavailable")
	)
		return "ChatGPT could not check your plan's usage just now. Try again in a minute.";
	if (seen.includes("subscription_sharing_invalid_user"))
		return "ChatGPT did not accept the sign-in. Run `familiar login chatgpt` again.";
	if (seen.includes("subscription_sharing_unsupported_capability"))
		return "ChatGPT plan usage does not support this model or request. Pick another model from `familiar login chatgpt`.";
	return undefined;
}
