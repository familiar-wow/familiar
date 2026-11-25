import { expect, test } from "bun:test";
import type { Choice, Settings } from "./brain.ts";
import {
	ChatGptTab,
	choiceName,
	filterModels,
	KEY_PAGES,
	type KeyDeps,
	KeyTab,
	keyField,
	keySourceText,
	type ListedModel,
	type LocalDeps,
	type LocalServer,
	LocalTab,
	modelRow,
	openingTab,
	priceText,
	prosCons,
	resultLine,
	START_TRIES,
	serverAddress,
	serverCard,
	TABS,
	tabRows,
	toolsHint,
	USAGE_URL,
} from "./brain-page.ts";
import { translator } from "./i18n.ts";
import type { BrainTest, KeySource } from "./main-app.ts";

const t = translator("en");
const de = translator("de");
const tick = () => new Promise((r) => setTimeout(r, 0));

const agent: Settings = { brain: { use: "agent", command: ["hermes", "acp"] } };
const openrouter: Settings = {
	brain: {
		use: "model",
		model: { provider: "openrouter", name: "openai/gpt-6-luna" },
	},
};

// Tabs -------------------------------------------------------------------------------------------

test("the tabs come in the sketch's order", () => {
	expect(TABS).toEqual(["chatgpt", "key", "local", "agent"]);
});

test("the page opens the tab a page asked for, else the brain that answers", () => {
	expect(openingTab(openrouter)).toBe("key");
	expect(openingTab(agent)).toBe("agent");
	expect(openingTab(openrouter, "local")).toBe("local");
	// Before the settings came, the default brain is the own agent.
	expect(openingTab(undefined)).toBe("agent");
	expect(
		openingTab({
			brain: { use: "model", model: { provider: "ollama", name: "q" } },
		}),
	).toBe("local");
});

test("only the tab of the brain that answers is marked in use", () => {
	const rows = tabRows(openrouter, t);
	expect(rows.map((r) => [r.kind, r.label, r.inUse])).toEqual([
		["chatgpt", "ChatGPT plan", false],
		["key", "API key", true],
		["local", "Local model", false],
		["agent", "Your own agent", false],
	]);
	// Without settings nobody is marked: the page does not know yet.
	expect(tabRows(undefined, t).some((r) => r.inUse)).toBe(false);
});

test("pros and cons say no web search for the built-in agent, and not for the own agent", () => {
	for (const kind of ["chatgpt", "key", "local"] as const) {
		const { pros, cons } = prosCons(kind, t);
		expect(cons).toContain("No web search in this version");
		expect(pros).toContain("Uses Familiar's game tools");
	}
	const own = prosCons("agent", t);
	expect(own.cons.join(" ")).not.toContain("web search");
	expect(own.pros.join(" ")).toContain("web search");
	expect(prosCons("chatgpt", t).pros).toContain(
		"No extra cost with a Plus or Pro plan",
	);
	expect(prosCons("key", t).cons).toContain("You pay the provider per use");
	expect(prosCons("local", t).cons).toContain(
		"Small models make more mistakes",
	);
});

// Models -----------------------------------------------------------------------------------------

const listed: ListedModel[] = [
	{ id: "anthropic/claude-haiku-5.5", name: "Claude Haiku", recommended: true },
	{ id: "openai/gpt-6-luna", name: "GPT-6 Luna", recommended: true },
	{ id: "meta/llama-5", name: "Llama 5" },
	{ id: "openai/gpt-6-luna-pro", name: "GPT-6 Luna Pro" },
	{ id: "x/old", tools: false },
];

test("the model list filters by id and name, every word, ignoring case", () => {
	expect(filterModels(listed, "LUNA").map((m) => m.id)).toEqual([
		"openai/gpt-6-luna",
		"openai/gpt-6-luna-pro",
	]);
	expect(filterModels(listed, "luna pro").map((m) => m.id)).toEqual([
		"openai/gpt-6-luna-pro",
	]);
	expect(filterModels(listed, "haiku").map((m) => m.id)).toEqual([
		"anthropic/claude-haiku-5.5",
	]);
	expect(filterModels(listed, "nothing")).toEqual([]);
	expect(filterModels(listed, "  ")).toHaveLength(5);
});

test("recommended models come first, the rest keep the core's order", () => {
	const mixed: ListedModel[] = [
		{ id: "a" },
		{ id: "b", recommended: true },
		{ id: "c" },
		{ id: "d", recommended: true },
	];
	expect(filterModels(mixed, "").map((m) => m.id)).toEqual([
		"b",
		"d",
		"a",
		"c",
	]);
});

test("a model row: recommended, price when known, and the tools warning only for tools false", () => {
	const row = modelRow(
		{
			id: "openai/gpt-6-luna",
			name: "OpenAI: GPT-6 Luna",
			tools: true,
			price: { input: 0.1, output: 0.5 },
			recommended: true,
		},
		t,
		"en",
	);
	expect(row).toEqual({
		id: "openai/gpt-6-luna",
		name: "OpenAI: GPT-6 Luna",
		recommended: true,
		price: "$0.10 / $0.50 per M tokens",
		noTools: false,
	});
	expect(modelRow({ id: "x", tools: false }, t, "en")).toEqual({
		id: "x",
		recommended: false,
		noTools: true,
	});
	// Unknown is not "no": OpenAI does not say.
	expect(modelRow({ id: "gpt-6" }, t, "en").noTools).toBe(false);
	// A name that only repeats the id says nothing more.
	expect(modelRow({ id: "y", name: "y" }, t, "en").name).toBeUndefined();
});

test("prices have as many decimals as they need, in the page's language", () => {
	expect(priceText({ input: 0.075, output: 30 }, t, "en")).toBe(
		"$0.075 / $30.00 per M tokens",
	);
	expect(priceText({ input: 0.1, output: 1.25 }, de, "de")).toBe(
		"0,10 $ / 1,25 $ pro Mio. Tokens",
	);
});

// Keys -------------------------------------------------------------------------------------------

test("the key field: enter one, or stored with where it is; only a keychain key can be removed", () => {
	const keys = { openai: true, anthropic: true, google: true };
	const sources: Record<string, KeySource> = {
		openai: "keychain",
		anthropic: "environment",
		google: "file",
	};
	expect(keyField("openai", keys, sources, false)).toEqual({
		state: "stored",
		source: "keychain",
		removable: true,
	});
	expect(keyField("anthropic", keys, sources, false)).toEqual({
		state: "stored",
		source: "environment",
		removable: false,
	});
	expect(keyField("google", keys, sources, false)).toEqual({
		state: "stored",
		source: "file",
		removable: false,
	});
	expect(keyField("deepseek", keys, sources, false)).toEqual({
		state: "enter",
	});
	// Replacing shows the field again, whatever is stored.
	expect(keyField("openai", keys, sources, true)).toEqual({ state: "enter" });
	expect(keySourceText("anthropic", "environment", t)).toBe(
		"from the environment variable ANTHROPIC_API_KEY",
	);
});

test("every provider has a page for keys, written as text", () => {
	expect(KEY_PAGES).toEqual({
		openai: "platform.openai.com/api-keys",
		anthropic: "console.anthropic.com",
		google: "aistudio.google.com/apikey",
		openrouter: "openrouter.ai/keys",
		deepseek: "platform.deepseek.com/api_keys",
	});
});

// Local servers ----------------------------------------------------------------------------------

const ollama: LocalServer = {
	kind: "ollama",
	name: "Ollama",
	baseUrl: "http://127.0.0.1:11434/v1",
	running: true,
	installed: true,
	start: ["ollama", "serve"],
	models: [
		{ id: "qwen3.7:14b", tools: true },
		{ id: "gemma4:4b", tools: false },
		{ id: "llama4.1:8b", tools: true },
	],
};
const lmOff: LocalServer = {
	kind: "lmstudio",
	name: "LM Studio",
	baseUrl: "http://127.0.0.1:1234/v1",
	running: false,
	installed: true,
	start: ["lms", "server", "start"],
	models: [],
};

test("server cards: running with its models, off with Start or a how-to, not installed", () => {
	expect(serverCard(ollama, t)).toEqual({
		kind: "ollama",
		name: "Ollama",
		state: "running",
		status: "running",
		detail: "127.0.0.1:11434 · 3 models",
		canStart: false,
	});
	expect(serverCard({ ...ollama, models: [{ id: "a" }] }, t).detail).toBe(
		"127.0.0.1:11434 · 1 model",
	);
	expect(serverCard(lmOff, t)).toMatchObject({
		state: "off",
		status: "installed, server off",
		canStart: true,
	});
	// The LM Studio app alone cannot be started headless: say where its switch is.
	const noLms = { ...lmOff, start: undefined };
	expect(serverCard(noLms, t)).toMatchObject({
		state: "off",
		canStart: false,
		detail:
			"Start the server in LM Studio (Developer → Start server), then search again.",
	});
	expect(
		serverCard({ ...ollama, running: false, installed: false, models: [] }, t),
	).toMatchObject({
		state: "missing",
		status: "not installed",
		canStart: false,
		detail: "Install it from ollama.com, download a model, then search again.",
	});
});

test("tool support: yes, no, or not known when the server does not tell", () => {
	expect(toolsHint(true, t)).toEqual({ text: "supports tools ✓", tone: "ok" });
	expect(toolsHint(false, t).tone).toBe("warn");
	expect(toolsHint(undefined, t)).toEqual({
		text: "tool support not known",
		tone: "muted",
	});
});

test("a typed server address becomes a base address, or nothing", () => {
	expect(serverAddress("192.168.1.20:11434")).toBe(
		"http://192.168.1.20:11434/v1",
	);
	expect(serverAddress(" http://pc.local:1234/v1/ ")).toBe(
		"http://pc.local:1234/v1",
	);
	expect(serverAddress("https://llm.example.com/api/v1")).toBe(
		"https://llm.example.com/api/v1",
	);
	expect(serverAddress("http://user:pw@pc:11434")).toBeUndefined();
	expect(serverAddress("ftp://pc/v1")).toBeUndefined();
	expect(serverAddress("file:///etc/passwd")).toBeUndefined();
	expect(serverAddress("pc name")).toBeUndefined();
	expect(serverAddress("")).toBeUndefined();
	expect(serverAddress("http://pc:1/v1?x=1")).toBeUndefined();
});

// Lines ------------------------------------------------------------------------------------------

test("choice names for the line after Use this", () => {
	expect(choiceName({ kind: "chatgpt", name: "gpt-6-luna" }, t)).toBe(
		"ChatGPT plan · gpt-6-luna",
	);
	expect(
		choiceName({ kind: "key", provider: "openrouter", name: "x/y" }, t),
	).toBe("OpenRouter · x/y");
	expect(
		choiceName({ kind: "local", provider: "lmstudio", name: "m" }, t),
	).toBe("LM Studio · m");
	expect(
		choiceName(
			{ kind: "agent", where: "local", command: ["hermes", "acp"] },
			t,
		),
	).toBe("hermes acp");
});

test("result lines: answered with the time and the answer, problems as they are", () => {
	const ok: BrainTest = { ok: true, ms: 6400, answer: " Hello! ", tools: [] };
	expect(resultLine({ kind: "tested", test: ok }, t, "en")).toEqual({
		text: "Answered in 6.4 s.",
		tone: "ok",
		detail: "Hello!",
	});
	expect(resultLine({ kind: "tested", test: ok }, de, "de").text).toBe(
		"Antwort nach 6,4 s.",
	);
	const bad: BrainTest = {
		ok: false,
		ms: 80_000,
		problem: "No answer within 80 s.",
		tools: [],
	};
	expect(resultLine({ kind: "tested", test: bad }, t, "en")).toEqual({
		text: "No answer within 80 s.",
		tone: "error",
	});
	expect(
		resultLine(
			{ kind: "tested", test: { ok: false, ms: 0, tools: [] } },
			t,
			"en",
		).text,
	).toBe("The brain did not answer.");
	// Markup from a brain stays text: the page renders it as text, the line keeps it as is.
	const html: BrainTest = {
		ok: true,
		ms: 1000,
		answer: "<b>hi</b>",
		tools: [],
	};
	expect(resultLine({ kind: "tested", test: html }, t, "en").detail).toBe(
		"<b>hi</b>",
	);
});

test("Use this: running with the new brain, or saved but not started and why", () => {
	const choice: Choice = { kind: "local", provider: "ollama", name: "qwen" };
	expect(
		resultLine({ kind: "used", outcome: { ok: true }, choice }, t, "en"),
	).toEqual({ text: "Familiar now answers with Ollama · qwen.", tone: "ok" });
	expect(
		resultLine(
			{
				kind: "used",
				outcome: { ok: false, problem: "Ollama is not running." },
				choice,
			},
			t,
			"en",
		),
	).toEqual({
		text: "Ollama · qwen is saved as the brain that answers, but Familiar did not start with it:",
		tone: "error",
		detail: "Ollama is not running.",
	});
});

test("notes after removing a key say when another key still works", () => {
	expect(
		resultLine(
			{ kind: "note", note: "keyStillEnv", provider: "openai" },
			t,
			"en",
		),
	).toEqual({
		text: "Removed from the keychain. The key from OPENAI_API_KEY still works.",
		tone: "info",
	});
	expect(
		resultLine(
			{ kind: "note", note: "keyRemoved", provider: "openai" },
			t,
			"en",
		).text,
	).toBe("Key removed.");
	expect(resultLine({ kind: "failed", message: "Nope." }, t, "en")).toEqual({
		text: "Nope.",
		tone: "error",
	});
});

// Controllers ------------------------------------------------------------------------------------

interface Fake {
	calls: [string, Record<string, unknown> | undefined][];
	remembered: Choice[];
	used: Choice[];
	tested: Choice[];
}

function base(
	answers: Record<string, (params?: Record<string, unknown>) => unknown>,
) {
	const fake: Fake = { calls: [], remembered: [], used: [], tested: [] };
	const deps = {
		call: async <T>(method: string, params?: Record<string, unknown>) => {
			fake.calls.push([method, params]);
			const answer = answers[method];
			if (!answer) throw new Error(`unexpected ${method}`);
			return (await answer(params)) as T;
		},
		useBrain: async (choice: Choice) => {
			fake.used.push(choice);
			return { ok: true as const };
		},
		testBrain: async (choice: Choice): Promise<BrainTest> => {
			fake.tested.push(choice);
			return { ok: true, ms: 1200, answer: "Hi", tools: [] };
		},
		rememberBrain: async (choice: Choice) => {
			fake.remembered.push(choice);
		},
	};
	return { fake, deps };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

test("ChatGPT: signed in, the models load and the held model stays choosable", async () => {
	const { fake, deps } = base({
		"chatgpt.account": () => ({
			account: "me@example.com",
			usage: "https://chatgpt.com/settings/usage",
		}),
		"chatgpt.models": () => [
			{ slug: "gpt-6-luna", name: "GPT-6 Luna" },
			{ slug: "gpt-6", name: "GPT-6" },
		],
	});
	const tab = new ChatGptTab(
		{ ...deps, signIn: async () => ({ account: "x", usage: USAGE_URL }) },
		"gpt-5-old",
	);
	await tab.load();
	expect(tab.state.account).toBe("me@example.com");
	expect(tab.state.models?.map((m) => m.slug)).toEqual([
		"gpt-5-old",
		"gpt-6-luna",
		"gpt-6",
	]);
	expect(tab.state.model).toBe("gpt-5-old");
	expect(tab.state.busy).toBeUndefined();
	// Opening the tab saves nothing.
	expect(fake.remembered).toEqual([]);
	tab.pick("gpt-6");
	await tick();
	expect(fake.remembered).toEqual([{ kind: "chatgpt", name: "gpt-6" }]);
	await tab.use();
	expect(fake.used).toEqual([{ kind: "chatgpt", name: "gpt-6" }]);
	expect(tab.state.result).toMatchObject({ kind: "used" });
});

test("ChatGPT: without a held model the first one is preselected, not saved", async () => {
	const { fake, deps } = base({
		"chatgpt.account": () => ({
			account: "me@example.com",
			usage: "https://chatgpt.com/settings/usage",
		}),
		"chatgpt.models": () => [{ slug: "gpt-6-luna", name: "GPT-6 Luna" }],
	});
	const tab = new ChatGptTab({
		...deps,
		signIn: async () => ({ account: "x", usage: USAGE_URL }),
	});
	await tab.load();
	expect(tab.choice()).toEqual({ kind: "chatgpt", name: "gpt-6-luna" });
	expect(fake.remembered).toEqual([]);
});

test("ChatGPT: signed out there is no choice; sign-in waits, then the models come", async () => {
	const { deps } = base({
		"chatgpt.account": () => null,
		"chatgpt.models": () => [{ slug: "gpt-6-luna", name: "GPT-6 Luna" }],
	});
	const browser = deferred<{ account: string; usage: string }>();
	const tab = new ChatGptTab({ ...deps, signIn: () => browser.promise });
	await tab.load();
	expect(tab.state.account).toBeNull();
	expect(tab.choice()).toBeUndefined();
	const going = tab.signIn();
	expect(tab.state).toMatchObject({ waiting: true, busy: "signIn" });
	// One call at a time: a second click does nothing.
	await tab.signOut();
	browser.resolve({ account: "me@example.com", usage: USAGE_URL });
	await going;
	expect(tab.state).toMatchObject({
		account: "me@example.com",
		waiting: false,
		model: "gpt-6-luna",
	});
	expect(tab.state.busy).toBeUndefined();
});

test("ChatGPT: Cancel stops waiting in the page; the late sign-in is dropped", async () => {
	const { deps } = base({ "chatgpt.account": () => null });
	const browser = deferred<{ account: string; usage: string }>();
	const tab = new ChatGptTab({ ...deps, signIn: () => browser.promise });
	await tab.load();
	const going = tab.signIn();
	tab.cancel();
	expect(tab.state.waiting).toBe(false);
	expect(tab.state.busy).toBeUndefined();
	browser.reject(new Error("The sign-in was cancelled."));
	await going;
	expect(tab.state.result).toBeUndefined();
	expect(tab.state.account).toBeNull();
});

test("ChatGPT: a failed sign-in shows the core's words; sign out says so", async () => {
	const { fake, deps } = base({
		"chatgpt.account": () => ({
			account: "me@example.com",
			usage: "https://chatgpt.com/settings/usage",
		}),
		"chatgpt.models": () => [],
		"chatgpt.signOut": () => ({ revoked: true }),
	});
	const tab = new ChatGptTab({
		...deps,
		signIn: async () => {
			throw new Error("ChatGPT plan usage is not allowed.");
		},
	});
	await tab.load();
	await tab.signOut();
	expect(fake.calls.at(-1)).toEqual(["chatgpt.signOut", {}]);
	expect(tab.state.account).toBeNull();
	expect(tab.state.result).toEqual({ kind: "note", note: "signedOut" });
	await tab.signIn();
	expect(tab.state.result).toEqual({
		kind: "failed",
		message: "ChatGPT plan usage is not allowed.",
	});
	expect(tab.state.waiting).toBe(false);
});

test("a test result that comes after the tab was left is dropped", async () => {
	const { deps } = base({
		"chatgpt.account": () => ({
			account: "me@example.com",
			usage: "https://chatgpt.com/settings/usage",
		}),
		"chatgpt.models": () => [{ slug: "m", name: "M" }],
	});
	const answer = deferred<BrainTest>();
	const tab = new ChatGptTab({
		...deps,
		testBrain: () => answer.promise,
		signIn: async () => ({ account: "x", usage: USAGE_URL }),
	});
	await tab.load();
	const seen: unknown[] = [];
	tab.watch((s) => seen.push(s.result));
	const going = tab.test();
	expect(tab.state.busy).toBe("test");
	tab.dispose();
	answer.resolve({ ok: true, ms: 60_000, answer: "late", tools: [] });
	await going;
	expect(seen.filter(Boolean)).toEqual([]);
	expect(tab.state.result).toBeUndefined();
});

function keyDeps(
	keys: Record<string, boolean>,
	sources: Record<string, KeySource> = {},
	models: Record<string, ListedModel[]> = {},
) {
	const { fake, deps } = base({
		"models.list": (p) => {
			const list = models[String(p?.provider)];
			if (!list) throw new Error("The provider refused the key.");
			return list;
		},
	});
	const stored: string[] = [];
	const k: KeyDeps = {
		...deps,
		setKey: async (provider, key) => {
			stored.push(`${provider}:${key}`);
			keys[provider] = true;
			sources[provider] = "keychain";
		},
		deleteKey: async (provider) => {
			if (sources[provider] === "keychain") {
				delete sources[provider];
				keys[provider] = false;
			}
		},
		keys: () => keys,
		keySources: () => sources,
	};
	return { fake, deps: k, stored };
}

test("API key: with a stored key the models load when the tab opens", async () => {
	const { fake, deps } = keyDeps(
		{ openrouter: true },
		{ openrouter: "keychain" },
		{ openrouter: listed },
	);
	const tab = new KeyTab(deps, {
		kind: "key",
		provider: "openrouter",
		name: "openai/gpt-6-luna",
	});
	await tab.load();
	expect(fake.calls).toEqual([["models.list", { provider: "openrouter" }]]);
	expect(tab.state.models).toHaveLength(5);
	expect(tab.choice()).toEqual({
		kind: "key",
		provider: "openrouter",
		name: "openai/gpt-6-luna",
	});
});

test("API key: no key, no list; saving one stores it, lists, and keeps no copy", async () => {
	const { fake, deps, stored } = keyDeps(
		{},
		{},
		{ deepseek: [{ id: "deepseek-chat" }] },
	);
	const tab = new KeyTab(deps);
	expect(tab.state.provider).toBe("openai");
	await tab.load();
	expect(fake.calls).toEqual([]);
	await tab.selectProvider("deepseek");
	expect(await tab.saveKey("  sk-secret  ")).toBe(true);
	expect(stored).toEqual(["deepseek:sk-secret"]);
	expect(tab.state.models?.map((m) => m.id)).toEqual(["deepseek-chat"]);
	expect(tab.state.result).toEqual({ kind: "note", note: "keyStored" });
	expect(JSON.stringify(tab.state)).not.toContain("sk-secret");
	// An empty field stores nothing.
	expect(await tab.saveKey("   ")).toBe(false);
	expect(stored).toHaveLength(1);
});

test("API key: a refused key shows the provider's words after saving", async () => {
	const { deps } = keyDeps({}, {}, {});
	const tab = new KeyTab(deps, {
		kind: "key",
		provider: "google",
		name: "gemini",
	});
	expect(await tab.saveKey("bad-key")).toBe(true);
	expect(tab.state.result).toEqual({
		kind: "failed",
		message: "The provider refused the key.",
	});
	expect(tab.state.busy).toBeUndefined();
});

test("API key: removing says when a key in the environment still works", async () => {
	const { deps } = keyDeps(
		{ anthropic: true, openai: true },
		{ anthropic: "keychain", openai: "keychain" },
		{ openai: [{ id: "gpt-6" }] },
	);
	const tab = new KeyTab(deps, {
		kind: "key",
		provider: "openai",
		name: "gpt-6",
	});
	await tab.load();
	expect(tab.state.models).toHaveLength(1);
	await tab.removeKey();
	expect(tab.state.result).toEqual({
		kind: "note",
		note: "keyRemoved",
		provider: "openai",
	});
	// The list belonged to the key that is gone.
	expect(tab.state.models).toBeUndefined();
	// The environment's key is found after the keychain's is gone.
	deps.deleteKey = async () => {};
	deps.keySources = () => ({ anthropic: "environment" });
	await tab.selectProvider("anthropic");
	await tab.removeKey();
	expect(tab.state.result).toEqual({
		kind: "note",
		note: "keyStillEnv",
		provider: "anthropic",
	});
});

test("API key: another provider has its own model; a list still coming for the old one is dropped", async () => {
	const slow = deferred<ListedModel[]>();
	const { deps } = keyDeps(
		{ openai: true, google: true },
		{ openai: "keychain", google: "keychain" },
	);
	deps.call = (async (_method: string, params?: Record<string, unknown>) =>
		params?.provider === "openai"
			? slow.promise
			: [{ id: "gemini-3.5-flash" }]) as KeyDeps["call"];
	const tab = new KeyTab(deps, {
		kind: "key",
		provider: "openai",
		name: "gpt-6",
		baseUrl: "https://proxy.example.com/v1",
	});
	const first = tab.load();
	expect(tab.state.busy).toBe("models");
	await tab.selectProvider("google");
	expect(tab.state.model).toBeUndefined();
	expect(tab.state.models?.map((m) => m.id)).toEqual(["gemini-3.5-flash"]);
	slow.resolve([{ id: "gpt-6" }]);
	await first;
	expect(tab.state.provider).toBe("google");
	expect(tab.state.models?.map((m) => m.id)).toEqual(["gemini-3.5-flash"]);
	expect(tab.state.busy).toBeUndefined();
	tab.pick("gemini-3.5-flash");
	expect(tab.choice()).toEqual({
		kind: "key",
		provider: "google",
		name: "gemini-3.5-flash",
	});
	// Back to OpenAI: its model and its own address come back.
	await tab.selectProvider("openai");
	expect(tab.choice()).toEqual({
		kind: "key",
		provider: "openai",
		name: "gpt-6",
		baseUrl: "https://proxy.example.com/v1",
	});
});

test("API key: picking a model remembers it in the background, a failure shows", async () => {
	const { fake, deps } = keyDeps({}, {});
	const tab = new KeyTab(deps, { kind: "key", provider: "openai", name: "a" });
	tab.pick("b");
	await tick();
	expect(fake.remembered).toEqual([
		{ kind: "key", provider: "openai", name: "b" },
	]);
	deps.rememberBrain = async () => {
		throw new Error("The settings could not be saved.");
	};
	tab.pick("c");
	await tick();
	expect(tab.state.result).toEqual({
		kind: "failed",
		message: "The settings could not be saved.",
	});
});

function localDeps(servers: () => LocalServer[]) {
	const { fake, deps } = base({
		"local.find": () => servers(),
		"local.start": () => null,
		"local.models": (p) => {
			if (p?.baseUrl === "http://192.168.1.20:11434/v1")
				return [{ id: "qwen3.7:32b" }];
			throw new Error("No OpenAI-compatible server answered at this address.");
		},
	});
	const local: LocalDeps = { ...deps, sleep: async () => {} };
	return { fake, deps: local };
}

test("local: Ollama at its own address stays there, not the Ollama found here", async () => {
	const { deps } = localDeps(() => [ollama, lmOff]);
	const tab = new LocalTab(deps, {
		kind: "local",
		provider: "ollama",
		name: "qwen3.7:32b",
		baseUrl: "http://192.168.1.20:11434/v1",
	});
	expect(tab.initialAddress).toBe("http://192.168.1.20:11434/v1");
	await tab.load();
	expect(tab.state.source).toBe("other");
	expect(tab.choice()).toEqual({
		kind: "local",
		provider: "ollama",
		name: "qwen3.7:32b",
		baseUrl: "http://192.168.1.20:11434/v1",
	});
});

test("local: the first running server is preselected with a model that can call tools", async () => {
	const { fake, deps } = localDeps(() => [
		{
			...ollama,
			models: [{ id: "gemma4:4b", tools: false }, ...ollama.models],
		},
		lmOff,
	]);
	const tab = new LocalTab(deps);
	await tab.load();
	expect(tab.state.source).toBe("ollama");
	expect(tab.state.model).toBe("qwen3.7:14b");
	expect(tab.choice()).toEqual({
		kind: "local",
		provider: "ollama",
		name: "qwen3.7:14b",
	});
	// Opening saves nothing; choosing a model does.
	expect(fake.remembered).toEqual([]);
	tab.pick("llama4.1:8b");
	await tick();
	expect(fake.remembered).toEqual([
		{ kind: "local", provider: "ollama", name: "llama4.1:8b" },
	]);
	// A server that is off cannot be chosen.
	tab.select("lmstudio");
	expect(tab.state.source).toBe("ollama");
});

test("local: Start looks until the server answers, then chooses it", async () => {
	let running = false;
	let finds = 0;
	const { fake, deps } = localDeps(() => {
		finds++;
		if (finds === 3) running = true;
		return [
			ollama,
			running
				? { ...lmOff, running: true, models: [{ id: "mistral-small-4" }] }
				: lmOff,
		];
	});
	const tab = new LocalTab(deps);
	await tab.load();
	await tab.start("lmstudio");
	expect(fake.calls.filter(([m]) => m === "local.start")).toEqual([
		["local.start", { kind: "lmstudio" }],
	]);
	expect(tab.state.source).toBe("lmstudio");
	expect(tab.state.model).toBe("mistral-small-4");
	expect(fake.remembered.at(-1)).toEqual({
		kind: "local",
		provider: "lmstudio",
		name: "mistral-small-4",
	});
});

test("local: a server that does not come up says so", async () => {
	const { fake, deps } = localDeps(() => [ollama, lmOff]);
	const tab = new LocalTab(deps);
	await tab.load();
	await tab.start("lmstudio");
	expect(fake.calls.filter(([m]) => m === "local.find")).toHaveLength(
		1 + START_TRIES,
	);
	expect(tab.state.result).toEqual({ kind: "note", note: "notStarted" });
	expect(tab.state.source).toBe("ollama");
});

test("local: another server by address, its models, and the core's words when none answers", async () => {
	const { fake, deps } = localDeps(() => [ollama, lmOff]);
	const tab = new LocalTab(deps);
	await tab.load();
	tab.selectOther();
	expect(tab.state.source).toBe("other");
	expect(tab.choice()).toBeUndefined();
	await tab.search("user:pw@192.168.1.20");
	expect(tab.state.result).toEqual({ kind: "note", note: "badAddress" });
	expect(fake.calls.some(([m]) => m === "local.models")).toBe(false);
	await tab.search("192.168.1.21:11434");
	expect(tab.state.result).toEqual({
		kind: "failed",
		message: "No OpenAI-compatible server answered at this address.",
	});
	await tab.search("192.168.1.20:11434");
	expect(tab.choice()).toEqual({
		kind: "local",
		provider: "openai-compatible",
		name: "qwen3.7:32b",
		baseUrl: "http://192.168.1.20:11434/v1",
	});
	expect(fake.remembered.at(-1)).toEqual(tab.choice() as Choice);
	expect(tab.models()).toEqual([{ id: "qwen3.7:32b" }]);
});

test("local: the other server the tab held is searched again when it opens, without saving", async () => {
	const { fake, deps } = localDeps(() => [ollama, lmOff]);
	const tab = new LocalTab(deps, {
		kind: "local",
		provider: "openai-compatible",
		name: "qwen3.7:32b",
		baseUrl: "http://192.168.1.20:11434/v1",
	});
	expect(tab.initialAddress).toBe("http://192.168.1.20:11434/v1");
	await tab.load();
	expect(tab.state.source).toBe("other");
	expect(tab.state.model).toBe("qwen3.7:32b");
	expect(fake.remembered).toEqual([]);
});

test("Test and Use this go to the app with the tab's choice, one at a time", async () => {
	const { fake, deps } = localDeps(() => [ollama]);
	const tab = new LocalTab(deps);
	await tab.load();
	const testing = tab.test();
	await tab.use();
	await testing;
	expect(fake.tested).toHaveLength(1);
	expect(fake.used).toEqual([]);
	expect(tab.state.result).toEqual({
		kind: "tested",
		test: { ok: true, ms: 1200, answer: "Hi", tools: [] },
	});
});
