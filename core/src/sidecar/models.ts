// The models a provider offers to the player's key, for the setup's model picker. One list call
// per provider, a few pages at most. The key travels only in a header, never in the URL, and no
// error carries the key or anything the provider sent back: a provider's error text may quote
// the request.

export type Provider =
	| "openai"
	| "anthropic"
	| "google"
	| "openrouter"
	| "deepseek";

export interface ListedModel {
	/** What goes into brain.model.name. */
	id: string;
	/** Display name, if the API gives one. */
	name?: string;
	/** true/false when the API tells, else undefined. */
	tools?: boolean;
	/** USD per million tokens, when the API tells (OpenRouter). */
	price?: { input: number; output: number };
	recommended?: boolean;
}

/** A failed listing. The message is fixed words, safe to show and to log. */
export class ListError extends Error {
	override name = "ListError";
}

/** The ids we tested, best first. */
export const RECOMMENDED: Record<Provider, string[]> = {
	openai: ["gpt-6-luna"],
	anthropic: ["claude-haiku-5-5"],
	google: ["gemini-3.5-flash"],
	openrouter: [
		"openai/gpt-6-luna",
		"anthropic/claude-haiku-5.5",
		"google/gemini-3.5-flash",
		"deepseek/deepseek-v4.1-flash",
	],
	deepseek: ["deepseek-v4.1-flash", "deepseek-chat"],
};

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ListOptions {
	/** By default globalThis.fetch; tests pass a stand-in. */
	fetch?: Fetch;
	/** Replaces the provider's API base, e.g. "https://api.openai.com/v1"; "/models" is appended. */
	baseUrl?: string;
}

const BASES: Record<Provider, string> = {
	openai: "https://api.openai.com/v1",
	anthropic: "https://api.anthropic.com/v1",
	google: "https://generativelanguage.googleapis.com/v1beta",
	openrouter: "https://openrouter.ai/api/v1",
	deepseek: "https://api.deepseek.com",
};

const TIMEOUT_MS = 10_000;
/** Pages followed at most; more than that is not a list a player scrolls through. */
const MAX_PAGES = 5;

const REFUSED = "The provider refused the key.";
const LIMITED = "The provider is rate limiting; try again in a minute.";
const UNREACHABLE = "The provider could not be reached.";
const UNEXPECTED = "The provider sent an unexpected answer.";

/** The models `provider` offers to `key`: recommended first, in RECOMMENDED order, then by id. */
export async function listModels(
	provider: Provider,
	key: string,
	opts: ListOptions = {},
): Promise<ListedModel[]> {
	const get = getter(opts.fetch ?? globalThis.fetch);
	const base = (opts.baseUrl ?? BASES[provider]).replace(/\/+$/, "");
	const bearer = { authorization: `Bearer ${key}` };
	let models: ListedModel[];
	switch (provider) {
		case "openai":
			models = items(await get(`${base}/models`, bearer), "data")
				.filter((m) => chat(m.id))
				.map((m) => ({ id: m.id }));
			break;
		case "anthropic":
			models = await anthropic(get, base, key);
			break;
		case "google":
			models = await google(get, base, key);
			break;
		case "openrouter":
			// The filter leaves only models that take tools, so every one does.
			models = items(
				await get(`${base}/models?supported_parameters=tools`, bearer),
				"data",
			).map((m) => ({
				id: m.id,
				...named(m.name),
				tools: true,
				...priced(m.pricing),
			}));
			break;
		case "deepseek":
			models = items(await get(`${base}/models`, bearer), "data").map((m) => ({
				id: m.id,
				...named(m.name),
			}));
			break;
		default:
			throw new ListError("This provider cannot list its models.");
	}
	return ranked(provider, models);
}

type Get = (url: string, headers: Record<string, string>) => Promise<unknown>;
type Item = Record<string, unknown> & { id: string };

/** One GET with the timeout, its outcome in fixed words. */
function getter(fetch: Fetch): Get {
	return async (url, headers) => {
		let response: Response;
		try {
			response = await fetch(url, {
				method: "GET",
				headers: { accept: "application/json", ...headers },
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
		} catch {
			throw new ListError(UNREACHABLE);
		}
		if (!response.ok) {
			// The body is never read: it may quote the request.
			response.body?.cancel().catch(() => {});
			const status = response.status;
			if (status === 401 || status === 403) throw new ListError(REFUSED);
			if (status === 429) throw new ListError(LIMITED);
			throw new ListError(`The provider answered with HTTP ${status}.`);
		}
		try {
			return await response.json();
		} catch (error) {
			// A body cut off by the timeout or the network is no bad answer.
			throw new ListError(
				error instanceof SyntaxError ? UNEXPECTED : UNREACHABLE,
			);
		}
	};
}

/** The entries of `body[field]` that have a string id; anything but a list there is no answer. */
function items(body: unknown, field: string, idField = "id"): Item[] {
	const list =
		body && typeof body === "object"
			? (body as Record<string, unknown>)[field]
			: undefined;
	if (!Array.isArray(list)) throw new ListError(UNEXPECTED);
	const found: Item[] = [];
	for (const entry of list) {
		if (!entry || typeof entry !== "object") continue;
		const id = (entry as Record<string, unknown>)[idField];
		if (typeof id === "string" && id)
			found.push({ ...(entry as Record<string, unknown>), id });
	}
	return found;
}

async function anthropic(
	get: Get,
	base: string,
	key: string,
): Promise<ListedModel[]> {
	const headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };
	const models: ListedModel[] = [];
	let after: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const cursor = after ? `&after_id=${encodeURIComponent(after)}` : "";
		const body = await get(`${base}/models?limit=100${cursor}`, headers);
		// Every Claude model on the Messages API takes tools.
		for (const m of items(body, "data"))
			models.push({ id: m.id, ...named(m.display_name), tools: true });
		const { has_more, last_id } = body as {
			has_more?: unknown;
			last_id?: unknown;
		};
		if (has_more !== true || typeof last_id !== "string" || !last_id) break;
		after = last_id;
	}
	return models;
}

async function google(
	get: Get,
	base: string,
	key: string,
): Promise<ListedModel[]> {
	// The key goes in the header Google documents for it, not in `?key=`.
	const headers = { "x-goog-api-key": key };
	const models: ListedModel[] = [];
	let token: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const cursor = token ? `&pageToken=${encodeURIComponent(token)}` : "";
		const body = await get(`${base}/models?pageSize=200${cursor}`, headers);
		for (const m of items(body, "models", "name")) {
			const methods = m.supportedGenerationMethods;
			if (!Array.isArray(methods) || !methods.includes("generateContent"))
				continue;
			models.push({
				id: m.id.replace(/^models\//, ""),
				...named(m.displayName),
			});
		}
		const next = (body as { nextPageToken?: unknown }).nextPageToken;
		if (typeof next !== "string" || !next) break;
		token = next;
	}
	return models;
}

/** Words in an OpenAI id that mark a model that does not chat. */
const NOT_CHAT =
	/embedding|audio|image|tts|whisper|moderation|dall-e|realtime|transcribe/;

/** OpenAI's chat models: the `gpt-` and `o` series (o1, o3, o4-mini), without the rest. */
function chat(id: string): boolean {
	return (/^gpt-/.test(id) || /^o\d/.test(id)) && !NOT_CHAT.test(id);
}

function named(name: unknown): { name?: string } {
	return typeof name === "string" && name ? { name } : {};
}

/**
 * OpenRouter's prices are USD per token, as strings; the picker shows USD per million tokens.
 * A negative price means "varies" (the auto router), which is no price to show.
 */
function priced(pricing: unknown): { price?: ListedModel["price"] } {
	if (!pricing || typeof pricing !== "object") return {};
	const { prompt, completion } = pricing as Record<string, unknown>;
	const input = perMillion(prompt);
	const output = perMillion(completion);
	return input === undefined || output === undefined
		? {}
		: { price: { input, output } };
}

function perMillion(value: unknown): number | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const perToken = Number(value);
	if (!Number.isFinite(perToken) || perToken < 0) return undefined;
	// Rounded to a millionth of a dollar, so 0.00003 shows as 30 and not 30.000000000000004.
	return Math.round(perToken * 1e12) / 1e6;
}

/** One entry per id; the recommended ones first, in RECOMMENDED order, then the rest by id. */
function ranked(provider: Provider, models: ListedModel[]): ListedModel[] {
	const unique = new Map<string, ListedModel>();
	for (const m of models) if (!unique.has(m.id)) unique.set(m.id, m);
	const order = RECOMMENDED[provider];
	const rank = (id: string) => {
		const i = order.indexOf(id);
		return i < 0 ? order.length : i;
	};
	return [...unique.values()]
		.map((m) => (rank(m.id) < order.length ? { ...m, recommended: true } : m))
		.sort(
			(a, b) =>
				rank(a.id) - rank(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
		);
}
