import { describe, expect, test } from "bun:test";
import {
	type Fetch,
	ListError,
	listModels,
	type Provider,
	RECOMMENDED,
} from "./models.ts";

const KEY = "sk-test-SECRET-1234567890";

interface Call {
	url: string;
	headers: Record<string, string>;
	signal?: AbortSignal | null;
}

/** A fetch that answers from `answer` and remembers each request; never the network. */
function fake(answer: (url: string) => Response | Promise<Response>) {
	const calls: Call[] = [];
	const fetch: Fetch = async (url, init) => {
		calls.push({
			url,
			headers: Object.fromEntries(new Headers(init.headers).entries()),
			signal: init.signal,
		});
		return answer(url);
	};
	return { fetch, calls };
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

describe("OpenAI", () => {
	test("keeps chat models and asks with a bearer key", async () => {
		const { fetch, calls } = fake(() =>
			json({
				object: "list",
				data: [
					{ id: "gpt-5-mini", object: "model", created: 1, owned_by: "openai" },
					{ id: "gpt-6-luna", object: "model", created: 1, owned_by: "openai" },
					{ id: "o4-mini", object: "model", created: 1, owned_by: "openai" },
					{ id: "text-embedding-3-small", object: "model" },
					{ id: "gpt-4o-audio-preview", object: "model" },
					{ id: "gpt-image-1", object: "model" },
					{ id: "gpt-4o-mini-tts", object: "model" },
					{ id: "whisper-1", object: "model" },
					{ id: "omni-moderation-latest", object: "model" },
					{ id: "dall-e-3", object: "model" },
					{ id: "gpt-realtime", object: "model" },
					{ id: "gpt-4o-transcribe", object: "model" },
					{ id: "babbage-002", object: "model" },
					{ object: "model" },
				],
			}),
		);
		const models = await listModels("openai", KEY, { fetch });
		expect(models).toEqual([
			{ id: "gpt-6-luna", recommended: true },
			{ id: "gpt-5-mini" },
			{ id: "o4-mini" },
		]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://api.openai.com/v1/models");
		expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
		expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
	});

	test("takes another base address", async () => {
		const { fetch, calls } = fake(() => json({ data: [] }));
		await listModels("openai", KEY, {
			fetch,
			baseUrl: "http://127.0.0.1:9999/v1/",
		});
		expect(calls[0]?.url).toBe("http://127.0.0.1:9999/v1/models");
	});
});

describe("Anthropic", () => {
	test("follows the pages, names the models, all take tools", async () => {
		const pages: Record<string, unknown> = {
			"": {
				data: [
					{
						type: "model",
						id: "claude-opus-5-5",
						display_name: "Claude Opus 5.5",
						created_at: "2026-09-21T00:00:00Z",
					},
				],
				has_more: true,
				first_id: "claude-opus-5-5",
				last_id: "claude-opus-5-5",
			},
			"claude-opus-5-5": {
				data: [
					{
						type: "model",
						id: "claude-haiku-5-5",
						display_name: "Claude Haiku 5.5",
					},
				],
				has_more: false,
				first_id: "claude-haiku-5-5",
				last_id: "claude-haiku-5-5",
			},
		};
		const { fetch, calls } = fake((url) => {
			const after = new URL(url).searchParams.get("after_id") ?? "";
			return json(pages[after]);
		});
		const models = await listModels("anthropic", KEY, { fetch });
		expect(models).toEqual([
			{
				id: "claude-haiku-5-5",
				name: "Claude Haiku 5.5",
				tools: true,
				recommended: true,
			},
			{ id: "claude-opus-5-5", name: "Claude Opus 5.5", tools: true },
		]);
		expect(calls.map((c) => c.url)).toEqual([
			"https://api.anthropic.com/v1/models?limit=100",
			"https://api.anthropic.com/v1/models?limit=100&after_id=claude-opus-5-5",
		]);
		expect(calls[0]?.headers["x-api-key"]).toBe(KEY);
		expect(calls[0]?.headers["anthropic-version"]).toBe("2023-06-01");
		expect(calls[0]?.headers.authorization).toBeUndefined();
	});

	test("stops after five pages", async () => {
		let n = 0;
		const { fetch, calls } = fake(() => {
			n++;
			return json({
				data: [{ type: "model", id: `claude-${n}` }],
				has_more: true,
				last_id: `claude-${n}`,
			});
		});
		const models = await listModels("anthropic", KEY, { fetch });
		expect(calls).toHaveLength(5);
		expect(models.map((m) => m.id)).toEqual([
			"claude-1",
			"claude-2",
			"claude-3",
			"claude-4",
			"claude-5",
		]);
	});
});

describe("Google", () => {
	test("keeps generateContent models, strips models/, key in a header", async () => {
		const { fetch, calls } = fake((url) =>
			new URL(url).searchParams.get("pageToken")
				? json({
						models: [
							{
								name: "models/gemini-3.5-flash",
								displayName: "Gemini 3.5 Flash",
								supportedGenerationMethods: ["generateContent", "countTokens"],
							},
						],
					})
				: json({
						models: [
							{
								name: "models/gemini-3.5-pro",
								displayName: "Gemini 3.5 Pro",
								supportedGenerationMethods: ["generateContent"],
							},
							{
								name: "models/gemini-embedding-001",
								displayName: "Gemini Embedding",
								supportedGenerationMethods: ["embedContent"],
							},
							{ name: "models/no-methods" },
						],
						nextPageToken: "page 2",
					}),
		);
		const models = await listModels("google", KEY, { fetch });
		expect(models).toEqual([
			{ id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", recommended: true },
			{ id: "gemini-3.5-pro", name: "Gemini 3.5 Pro" },
		]);
		expect(calls.map((c) => c.url)).toEqual([
			"https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
			"https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&pageToken=page%202",
		]);
		expect(calls[0]?.headers["x-goog-api-key"]).toBe(KEY);
	});
});

describe("OpenRouter", () => {
	test("asks for tool models and turns prices per token into per million", async () => {
		const { fetch, calls } = fake(() =>
			json({
				data: [
					{
						id: "openai/gpt-4",
						name: "GPT-4",
						pricing: { prompt: "0.00003", completion: "0.00006", image: "0" },
						supported_parameters: ["tools", "temperature"],
					},
					{
						id: "deepseek/deepseek-v4.1-flash",
						name: "DeepSeek V4.1 Flash",
						pricing: { prompt: "0.00000027", completion: "0.0000011" },
					},
					{
						id: "anthropic/claude-haiku-5.5",
						name: "Claude Haiku 5.5",
						pricing: { prompt: "0.000001", completion: "0.000005" },
					},
					{
						id: "openrouter/auto",
						name: "Auto Router",
						pricing: { prompt: "-1", completion: "-1" },
					},
					{ id: "x/free", pricing: { prompt: "0", completion: "0" } },
					{ id: "x/no-price" },
				],
			}),
		);
		const models = await listModels("openrouter", KEY, { fetch });
		expect(models).toEqual([
			{
				id: "anthropic/claude-haiku-5.5",
				name: "Claude Haiku 5.5",
				tools: true,
				price: { input: 1, output: 5 },
				recommended: true,
			},
			{
				id: "deepseek/deepseek-v4.1-flash",
				name: "DeepSeek V4.1 Flash",
				tools: true,
				price: { input: 0.27, output: 1.1 },
				recommended: true,
			},
			{
				id: "openai/gpt-4",
				name: "GPT-4",
				tools: true,
				price: { input: 30, output: 60 },
			},
			{ id: "openrouter/auto", name: "Auto Router", tools: true },
			{ id: "x/free", tools: true, price: { input: 0, output: 0 } },
			{ id: "x/no-price", tools: true },
		]);
		expect(calls[0]?.url).toBe(
			"https://openrouter.ai/api/v1/models?supported_parameters=tools",
		);
		expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
	});
});

describe("DeepSeek", () => {
	test("lists the models, with their names when given", async () => {
		const { fetch, calls } = fake(() =>
			json({
				object: "list",
				data: [
					{ id: "deepseek-reasoner", object: "model", owned_by: "deepseek" },
					{ id: "deepseek-chat", object: "model", owned_by: "deepseek" },
					{
						id: "deepseek-v4.1-flash",
						object: "model",
						owned_by: "deepseek",
						name: "DeepSeek-V4.1-Flash",
					},
				],
			}),
		);
		const models = await listModels("deepseek", KEY, { fetch });
		expect(models).toEqual([
			{
				id: "deepseek-v4.1-flash",
				name: "DeepSeek-V4.1-Flash",
				recommended: true,
			},
			{ id: "deepseek-chat", recommended: true },
			{ id: "deepseek-reasoner" },
		]);
		expect(calls[0]?.url).toBe("https://api.deepseek.com/models");
		expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
	});
});

describe("ordering", () => {
	test("recommended in RECOMMENDED order, only ids present, then by id, no duplicates", async () => {
		const ids = [
			"zeta",
			"google/gemini-3.5-flash",
			"alpha",
			"openai/gpt-6-luna",
			"alpha",
		];
		const { fetch } = fake(() => json({ data: ids.map((id) => ({ id })) }));
		const models = await listModels("openrouter", KEY, { fetch });
		expect(models.map((m) => [m.id, m.recommended ?? false])).toEqual([
			["openai/gpt-6-luna", true],
			["google/gemini-3.5-flash", true],
			["alpha", false],
			["zeta", false],
		]);
		expect(RECOMMENDED.openrouter[0]).toBe("openai/gpt-6-luna");
	});
});

describe("errors", () => {
	const all: Provider[] = [
		"openai",
		"anthropic",
		"google",
		"openrouter",
		"deepseek",
	];

	async function failure(
		answer: (url: string) => Response | Promise<Response>,
		provider: Provider = "openai",
	): Promise<ListError> {
		const { fetch } = fake(answer);
		const error = await listModels(provider, KEY, { fetch }).then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(ListError);
		return error as ListError;
	}

	// The body quotes the key, as some providers' error texts do.
	const quoting = { error: { message: `Incorrect API key provided: ${KEY}` } };

	test.each([
		[401, "The provider refused the key."],
		[403, "The provider refused the key."],
		[429, "The provider is rate limiting; try again in a minute."],
		[500, "The provider answered with HTTP 500."],
		[404, "The provider answered with HTTP 404."],
	])("HTTP %d", async (status, message) => {
		const error = await failure(() => json(quoting, status));
		expect(error.message).toBe(message);
	});

	test("network failure and timeout", async () => {
		const down = await failure(() => {
			throw new TypeError(`fetch failed for ${KEY}`);
		});
		expect(down.message).toBe("The provider could not be reached.");
		const slow = await failure(() => {
			throw new DOMException("The operation timed out.", "TimeoutError");
		});
		expect(slow.message).toBe("The provider could not be reached.");
	});

	test("a body cut off mid-read is unreachable, not a bad answer", async () => {
		const error = await failure(
			() =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{"data":['));
							controller.error(new DOMException("timed out", "TimeoutError"));
						},
					}),
				),
		);
		expect(error.message).toBe("The provider could not be reached.");
	});

	test.each(all)("bad JSON or a wrong shape from %s", async (provider) => {
		const bad = await failure(() => new Response(`not json ${KEY}`), provider);
		expect(bad.message).toBe("The provider sent an unexpected answer.");
		const shape = await failure(
			() => json({ data: "nope", models: 7 }),
			provider,
		);
		expect(shape.message).toBe("The provider sent an unexpected answer.");
	});

	test.each(all)("%s: the key is in no URL and no error", async (provider) => {
		// The paging providers get a second request, which the provider refuses.
		const { fetch, calls } = fake(() =>
			calls.length > 1 ? json(quoting, 401) : json(firstPage()),
		);
		const error = await listModels(provider, KEY, { fetch }).catch(
			(e: unknown) => e,
		);
		for (const c of calls) {
			expect(c.url).not.toContain(KEY);
			expect(c.url).not.toContain("key=");
		}
		// The key went in a header.
		expect(Object.values(calls[0]?.headers ?? {}).join(" ")).toContain(KEY);
		const paging = provider === "anthropic" || provider === "google";
		expect(calls).toHaveLength(paging ? 2 : 1);
		expect(error instanceof ListError).toBe(paging);
		if (error instanceof Error) {
			expect(error.message).not.toContain(KEY);
			expect(String(error.stack)).not.toContain(KEY);
		}
		for (const answer of [
			() => json(quoting, 401),
			() => json(quoting, 500),
			() => new Response(`{${KEY}`),
			() => {
				throw new Error(KEY);
			},
		]) {
			const e = await failure(answer, provider);
			expect(e.message).not.toContain(KEY);
			expect(String(e.stack)).not.toContain(KEY);
		}
	});
});

/** A first page that asks for a second one, for every provider's paging. */
function firstPage(): unknown {
	return {
		data: [{ id: "gpt-x", type: "model" }],
		models: [
			{
				name: "models/gemini-x",
				supportedGenerationMethods: ["generateContent"],
			},
		],
		has_more: true,
		last_id: "gpt-x",
		nextPageToken: "next",
	};
}
