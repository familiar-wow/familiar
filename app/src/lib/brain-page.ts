// The Brain page's model tabs (ChatGPT plan, API key, local model): what they show, in pure
// functions, and the calls behind their buttons, in small controllers with the app passed in
// (like GameController in game.ts), so both are tested without Svelte or Tauri.
import {
	activeKind,
	type BrainKind,
	type Choice,
	KEY_PROVIDERS,
	type KeyProvider,
	type LocalProvider,
	type Settings,
} from "./brain.ts";
import { type Key, seconds, type Translate } from "./i18n.ts";
import type { BrainTest, KeySource, Outcome } from "./main-app.ts";
import { type Language, messageOf } from "./types.ts";

/** The tabs in the sketch's order. */
export const TABS: readonly BrainKind[] = ["chatgpt", "key", "local", "agent"];

/**
 * The tab the page opens with: the one a page asked for (`view.brainTab`), else the kind of
 * brain that answers. Without settings the default brain is the player's own agent.
 */
export function openingTab(
	settings: Settings | undefined,
	hint?: BrainKind,
): BrainKind {
	return hint ?? activeKind(settings ?? {});
}

export interface TabRow {
	kind: BrainKind;
	label: string;
	/** The brain that answers is of this kind. */
	inUse: boolean;
}

export function tabRows(
	settings: Settings | undefined,
	t: Translate,
	/** Whether the saved brain answers now (`answersNow`); else no tab is "in use". */
	answering = true,
): TabRow[] {
	const active = settings && answering ? activeKind(settings) : undefined;
	return TABS.map((kind) => ({
		kind,
		label: t(`brain.tab.${kind}`),
		inUse: kind === active,
	}));
}

/**
 * Short pros and cons per kind. Only what is true today: the built-in agent (the three model
 * kinds) has the game tools but no web search in this version.
 */
export function prosCons(
	kind: BrainKind,
	t: Translate,
): { pros: string[]; cons: string[] } {
	const keys: Record<BrainKind, { pros: Key[]; cons: Key[] }> = {
		chatgpt: {
			pros: ["brain.pro.chatgptCost", "brain.pro.gameTools"],
			cons: [
				"brain.con.chatgptLimits",
				"brain.con.chatgptSignIn",
				"brain.con.noWeb",
			],
		},
		key: {
			pros: [
				"brain.pro.keyQuick",
				"brain.pro.keyModels",
				"brain.pro.gameTools",
			],
			cons: ["brain.con.keyCost", "brain.con.noWeb"],
		},
		local: {
			pros: ["brain.pro.localFree", "brain.pro.gameTools"],
			cons: ["brain.con.localPc", "brain.con.localSmall", "brain.con.noWeb"],
		},
		agent: {
			pros: ["brain.pro.agentOwn"],
			cons: ["brain.con.agentSetup"],
		},
	};
	return {
		pros: keys[kind].pros.map((k) => t(k)),
		cons: keys[kind].cons.map((k) => t(k)),
	};
}

// ---------------------------------------------------------------------------------------------
// API key

/** A model as `models.list` gives it (core/src/sidecar/models.ts). */
export interface ListedModel {
	id: string;
	name?: string;
	tools?: boolean;
	/** USD per million tokens. */
	price?: { input: number; output: number };
	recommended?: boolean;
}

export const PROVIDER_NAMES: Record<
	KeyProvider | LocalProvider | "chatgpt",
	string
> = {
	openai: "OpenAI",
	anthropic: "Anthropic",
	google: "Google",
	openrouter: "OpenRouter",
	deepseek: "DeepSeek",
	ollama: "Ollama",
	lmstudio: "LM Studio",
	"openai-compatible": "OpenAI-compatible server",
	chatgpt: "ChatGPT",
};

/** Where each provider hands out keys; shown as text, the window cannot open links. */
export const KEY_PAGES: Record<KeyProvider, string> = {
	openai: "platform.openai.com/api-keys",
	anthropic: "console.anthropic.com",
	google: "aistudio.google.com/apikey",
	openrouter: "openrouter.ai/keys",
	deepseek: "platform.deepseek.com/api_keys",
};

/** The environment variable the core reads a key from (core/src/brain/model.ts). */
export const KEY_ENV: Record<KeyProvider, string> = {
	openai: "OPENAI_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
	google: "GOOGLE_GENERATIVE_AI_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	deepseek: "DEEPSEEK_API_KEY",
};

export const isKeyProvider = (p: unknown): p is KeyProvider =>
	(KEY_PROVIDERS as readonly unknown[]).includes(p);

/**
 * The models whose id or name holds every word of `query`, ignoring case; the recommended ones
 * first, otherwise in the order the core sent (it sorts by id).
 */
export function filterModels(
	models: readonly ListedModel[],
	query: string,
): ListedModel[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const hits = models.filter((m) => {
		const text = `${m.id} ${m.name ?? ""}`.toLowerCase();
		return words.every((w) => text.includes(w));
	});
	return [
		...hits.filter((m) => m.recommended),
		...hits.filter((m) => !m.recommended),
	];
}

export interface ModelRow {
	id: string;
	/** The display name when it says more than the id. */
	name?: string;
	recommended: boolean;
	/** "$0.10 / $0.50 per M tokens", when the provider tells. */
	price?: string;
	/** The provider says it cannot call tools: Familiar will not work well. */
	noTools: boolean;
}

export function modelRow(
	m: ListedModel,
	t: Translate,
	language: Language,
): ModelRow {
	const row: ModelRow = {
		id: m.id,
		recommended: m.recommended === true,
		noTools: m.tools === false,
	};
	if (m.name && m.name !== m.id) row.name = m.name;
	if (m.price) row.price = priceText(m.price, t, language);
	return row;
}

/** USD per million tokens, input / output, with as many decimals as the price needs. */
export function priceText(
	price: { input: number; output: number },
	t: Translate,
	language: Language,
): string {
	const format = new Intl.NumberFormat(language === "de" ? "de-DE" : "en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: 4,
	});
	return t("brain.key.price", {
		input: format.format(price.input),
		output: format.format(price.output),
	});
}

/** What the key field shows for a provider. */
export type KeyField =
	| { state: "enter" }
	| { state: "stored"; source: KeySource; removable: boolean };

/**
 * "Key stored · Replace · Remove" when a key can be found, the field otherwise or while the
 * player replaces it. Only a keychain key can be removed here: one in the settings file or the
 * environment stays usable whatever the page does.
 */
export function keyField(
	provider: KeyProvider,
	keys: Record<string, boolean>,
	sources: Record<string, KeySource>,
	replacing: boolean,
): KeyField {
	if (replacing || !keys[provider]) return { state: "enter" };
	const source = sources[provider] ?? "keychain";
	return { state: "stored", source, removable: source === "keychain" };
}

/** The line next to "Key stored": where the key is. */
export function keySourceText(
	provider: KeyProvider,
	source: KeySource,
	t: Translate,
): string {
	if (source === "file") return t("brain.key.inFile");
	if (source === "environment")
		return t("brain.key.inEnv", { env: KEY_ENV[provider] });
	return t("brain.key.inKeychain");
}

// ---------------------------------------------------------------------------------------------
// Local model

/** A model of a local server (`local.find`, `local.models`). */
export interface LocalModel {
	id: string;
	tools?: boolean;
	size?: number;
}

/** A server as `local.find` describes it (core/src/sidecar/detect.ts). */
export interface LocalServer {
	kind: "ollama" | "lmstudio";
	name: string;
	baseUrl: string;
	running: boolean;
	installed: boolean;
	path?: string;
	start?: string[];
	models: LocalModel[];
}

export type ServerState = "running" | "off" | "missing";

export interface ServerCard {
	kind: LocalServer["kind"];
	name: string;
	state: ServerState;
	/** "running", "installed, server off", "not installed". */
	status: string;
	/** "127.0.0.1:11434 · 3 models", or how to get it running. */
	detail: string;
	/** Familiar knows how to start it. */
	canStart: boolean;
}

export function serverCard(server: LocalServer, t: Translate): ServerCard {
	const base = {
		kind: server.kind,
		name: server.name,
		canStart: false,
	};
	if (server.running) {
		const n = server.models.length;
		return {
			...base,
			state: "running",
			status: t("brain.local.running"),
			detail: `${hostOf(server.baseUrl)} · ${
				n === 1 ? t("brain.local.oneModel") : t("brain.local.models", { n })
			}`,
		};
	}
	if (server.installed)
		return {
			...base,
			state: "off",
			status: t("brain.local.off"),
			canStart: (server.start?.length ?? 0) > 0,
			detail: server.start?.length
				? t("brain.local.offStart")
				: server.kind === "lmstudio"
					? t("brain.local.offLmStudio")
					: t("brain.local.offOther"),
		};
	return {
		...base,
		state: "missing",
		status: t("brain.local.missing"),
		detail:
			server.kind === "ollama"
				? t("brain.local.getOllama")
				: t("brain.local.getLmStudio"),
	};
}

/** "127.0.0.1:11434" from "http://127.0.0.1:11434/v1". */
function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/**
 * Whether a model can call tools, in words. Ollama tells; LM Studio and other servers do not,
 * which is "not known", not "no".
 */
export function toolsHint(
	tools: boolean | undefined,
	t: Translate,
): { text: string; tone: "ok" | "warn" | "muted" } {
	if (tools === true) return { text: t("brain.local.toolsYes"), tone: "ok" };
	if (tools === false) return { text: t("brain.local.toolsNo"), tone: "warn" };
	return { text: t("brain.local.toolsUnknown"), tone: "muted" };
}

/**
 * The address the player typed, as the base `local.models` and the settings take: http(s) only,
 * no user or password (the core refuses those too), `http://` when no scheme is given, and
 * `/v1` when there is no path, where Ollama, LM Studio and most others answer. Undefined when it
 * cannot be one.
 */
export function serverAddress(input: string): string | undefined {
	let text = input.trim();
	if (!text || /\s/.test(text)) return undefined;
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	if (url.username || url.password || !url.hostname) return undefined;
	if (url.search || url.hash) return undefined;
	const path = url.pathname === "/" ? "/v1" : url.pathname.replace(/\/+$/, "");
	return `${url.protocol}//${url.host}${path}`;
}

// ---------------------------------------------------------------------------------------------
// The lines under the buttons

/** The brain a choice stands for, in a few words: "OpenRouter · openai/gpt-6-luna". */
export function choiceName(choice: Choice, t: Translate): string {
	switch (choice.kind) {
		case "chatgpt":
			return `${t("brain.tab.chatgpt")} · ${choice.name}`;
		case "key":
		case "local":
			return `${PROVIDER_NAMES[choice.provider]} · ${choice.name}`;
		case "agent":
			return choice.where === "ssh"
				? `${choice.ssh.command.join(" ")} @ ${choice.ssh.host}`
				: choice.command.join(" ");
	}
}

/** What the last action on a tab came to; the page turns it into words with `resultLine`. */
export type Result =
	| { kind: "tested"; test: BrainTest }
	| { kind: "used"; outcome: Outcome; choice: Choice }
	| { kind: "failed"; message: string }
	| { kind: "note"; note: Note; provider?: KeyProvider };

export type Note =
	| "keyStored"
	| "keyRemoved"
	| "keyStillFile"
	| "keyStillEnv"
	| "signedOut"
	| "notStarted"
	| "badAddress";

export interface Line {
	text: string;
	tone: "ok" | "error" | "info";
	/** A second line: an answer's start, or the reason Familiar did not start. Plain text. */
	detail?: string;
}

export function resultLine(
	result: Result,
	t: Translate,
	language: Language,
): Line {
	switch (result.kind) {
		case "tested": {
			const { test } = result;
			if (test.ok) {
				const line: Line = {
					text: t("brain.result.answered", {
						time: seconds(test.ms, language),
					}),
					tone: "ok",
				};
				const answer = test.answer?.trim();
				if (answer) line.detail = answer;
				return line;
			}
			return {
				text: test.problem?.trim() || t("brain.result.noAnswer"),
				tone: "error",
			};
		}
		case "used": {
			const name = choiceName(result.choice, t);
			if (result.outcome.ok)
				return { text: t("brain.result.used", { name }), tone: "ok" };
			return {
				text: t("brain.result.savedNotStarted", { name }),
				tone: "error",
				detail: result.outcome.problem,
			};
		}
		case "failed":
			return { text: result.message, tone: "error" };
		case "note": {
			const env = result.provider ? KEY_ENV[result.provider] : "";
			const tone: Line["tone"] =
				result.note === "badAddress" || result.note === "notStarted"
					? "error"
					: result.note === "keyStored"
						? "ok"
						: "info";
			return { text: t(`brain.note.${result.note}`, { env }), tone };
		}
	}
}

// ---------------------------------------------------------------------------------------------
// The tabs' calls

/** What every model tab needs from the app (MainApp). */
export interface TabDeps {
	call<T>(method: string, params?: Record<string, unknown>): Promise<T>;
	useBrain(choice: Choice): Promise<Outcome>;
	testBrain(choice: Choice): Promise<BrainTest>;
	rememberBrain(choice: Choice): Promise<void>;
}

export type Busy =
	| "load"
	| "signIn"
	| "signOut"
	| "key"
	| "remove"
	| "models"
	| "find"
	| "start"
	| "search"
	| "test"
	| "use";

interface TabState {
	/** The call under way; one at a time per tab. */
	busy?: Busy;
	result?: Result;
}

/**
 * One tab's state and its calls. A tab that was left (`dispose`) drops every result that comes
 * in later, such as a test that takes a minute. `epoch` moves on when the tab drops what is
 * under way itself (another provider), so that call's result is dropped too.
 */
abstract class TabController<S extends TabState> {
	private readonly watchers = new Set<(state: S) => void>();
	private disposed = false;
	protected epoch = 0;

	constructor(
		protected readonly deps: TabDeps,
		public state: S,
	) {}

	watch(fn: (state: S) => void): () => void {
		this.watchers.add(fn);
		return () => this.watchers.delete(fn);
	}

	/** The tab is gone: nothing is shown any more, nothing is saved on the way out. */
	dispose(): void {
		this.disposed = true;
		this.watchers.clear();
	}

	/** What the tab holds now, when it is a complete brain. */
	abstract choice(): Choice | undefined;

	/** "Test": one short question to the tab's brain, without saving it. */
	test(): Promise<void> {
		const choice = this.choice();
		if (!choice) return Promise.resolve();
		return this.run("test", async (alive) => {
			const test = await this.deps.testBrain(choice);
			if (alive()) this.set({ result: { kind: "tested", test } } as Partial<S>);
		});
	}

	/** "Use this": the tab's brain answers from now on, and Familiar runs with it. */
	use(): Promise<void> {
		const choice = this.choice();
		if (!choice) return Promise.resolve();
		return this.run("use", async (alive) => {
			const outcome = await this.deps.useBrain(choice);
			if (alive())
				this.set({ result: { kind: "used", outcome, choice } } as Partial<S>);
		});
	}

	/** A choice the player completed: kept for the tab in the background. */
	protected remember(): void {
		const choice = this.choice();
		if (!choice) return;
		this.deps.rememberBrain(choice).catch((error) => {
			this.set({
				result: { kind: "failed", message: messageOf(error) },
			} as Partial<S>);
		});
	}

	/**
	 * Runs one call at a time; a second one while one runs is ignored. `alive` says whether
	 * the result still belongs on the page. Errors become the result line, as the core said.
	 */
	protected async run(
		busy: Busy,
		action: (alive: () => boolean) => Promise<void>,
	): Promise<void> {
		if (this.state.busy || this.disposed) return;
		const epoch = this.epoch;
		const alive = () => !this.disposed && epoch === this.epoch;
		this.set({ busy, result: undefined } as Partial<S>);
		try {
			await action(alive);
		} catch (error) {
			if (alive())
				this.set({
					result: { kind: "failed", message: messageOf(error) },
				} as Partial<S>);
		} finally {
			if (alive()) this.set({ busy: undefined } as Partial<S>);
		}
	}

	protected set(change: Partial<S>): void {
		if (this.disposed) return;
		const next = { ...this.state, ...change };
		for (const key of Object.keys(change) as (keyof S)[])
			if (change[key] === undefined) delete next[key];
		this.state = next;
		for (const fn of this.watchers) fn(this.state);
	}
}

// ChatGPT plan ----------------------------------------------------------------------------------

/** Where a ChatGPT account manages its usage and Familiar's limit (core/src/brain/chatgpt.ts). */
export const USAGE_URL = "https://chatgpt.com/settings/usage";

export interface ChatGptDeps extends TabDeps {
	/** MainApp.signInChatGpt: one sign-in at a time, shared by every page that asks. */
	signIn(): Promise<{ account: string; usage: string }>;
}

export interface ChatGptState extends TabState {
	/** The signed-in account; null when signed out, undefined until the core said. */
	account?: string | null;
	models?: { slug: string; name: string }[];
	model?: string;
	/** The sign-in waits for the browser. */
	waiting: boolean;
	usage: string;
}

export class ChatGptTab extends TabController<ChatGptState> {
	constructor(
		deps: ChatGptDeps,
		private readonly initial?: string,
	) {
		super(deps, {
			waiting: false,
			usage: USAGE_URL,
			...(initial ? { model: initial } : {}),
		});
	}

	private get gpt(): ChatGptDeps {
		return this.deps as ChatGptDeps;
	}

	choice(): Choice | undefined {
		const { account, model } = this.state;
		return account && model ? { kind: "chatgpt", name: model } : undefined;
	}

	/** When the tab opens: who is signed in, then that account's models. */
	load(): Promise<void> {
		return this.run("load", async (alive) => {
			const got = await this.deps.call<{
				account: string;
				usage?: string;
			} | null>("chatgpt.account");
			if (!alive()) return;
			const account = got?.account ?? null;
			this.set({
				account,
				...(got?.usage?.startsWith("https://") ? { usage: got.usage } : {}),
			});
			if (account) await this.loadModels(alive);
		});
	}

	/**
	 * "Sign in with ChatGPT": the browser opens and the page waits, up to the core's ten minutes.
	 * A sign-in that already waits (started on another page) is the same one.
	 */
	signIn(): Promise<void> {
		return this.run("signIn", async (alive) => {
			this.set({ waiting: true });
			try {
				const { account, usage } = await this.gpt.signIn();
				if (!alive()) return;
				this.set({
					account,
					waiting: false,
					...(usage?.startsWith("https://") ? { usage } : {}),
				});
				await this.loadModels(alive);
			} finally {
				if (alive()) this.set({ waiting: false });
			}
		});
	}

	/** Stops waiting in the page; the sign-in in the browser goes on, and its result is dropped. */
	cancel(): void {
		if (!this.state.waiting) return;
		this.epoch++;
		this.set({ waiting: false, busy: undefined });
	}

	signOut(): Promise<void> {
		return this.run("signOut", async (alive) => {
			await this.deps.call("chatgpt.signOut", {});
			if (!alive()) return;
			this.set({
				account: null,
				models: undefined,
				result: { kind: "note", note: "signedOut" },
			});
		});
	}

	/** A model from the list: the tab keeps it. */
	pick(slug: string): void {
		if (!slug || slug === this.state.model) return;
		this.set({ model: slug, result: undefined });
		this.remember();
	}

	private async loadModels(alive: () => boolean): Promise<void> {
		const models =
			await this.deps.call<{ slug: string; name: string }[]>("chatgpt.models");
		if (!alive()) return;
		const list = Array.isArray(models) ? models : [];
		// The model the tab held stays choosable, even when the account no longer lists it.
		const held = this.state.model ?? this.initial;
		const withHeld =
			held && !list.some((m) => m.slug === held)
				? [{ slug: held, name: held }, ...list]
				: list;
		this.set({
			models: withHeld,
			model: held ?? withHeld[0]?.slug,
		});
	}
}

// API key ---------------------------------------------------------------------------------------

export interface KeyDeps extends TabDeps {
	setKey(provider: KeyProvider, key: string): Promise<void>;
	deleteKey(provider: KeyProvider): Promise<void>;
	/** `view.keys` and `view.keySources` as they are now. */
	keys(): Record<string, boolean>;
	keySources(): Record<string, KeySource>;
}

export interface KeyState extends TabState {
	provider: KeyProvider;
	/** The provider's models, once listed. */
	models?: ListedModel[];
	model?: string;
	/** The player replaces a stored key: the field shows again. */
	replacing: boolean;
}

export class KeyTab extends TabController<KeyState> {
	constructor(
		deps: KeyDeps,
		private readonly initial?: Extract<Choice, { kind: "key" }>,
	) {
		super(deps, {
			provider: initial?.provider ?? "openai",
			replacing: false,
			...(initial?.name ? { model: initial.name } : {}),
		});
	}

	private get keyDeps(): KeyDeps {
		return this.deps as KeyDeps;
	}

	choice(): Choice | undefined {
		const { provider, model } = this.state;
		if (!model) return undefined;
		// A provider's own address, set by hand, stays with that provider.
		const baseUrl =
			this.initial?.provider === provider ? this.initial.baseUrl : undefined;
		return {
			kind: "key",
			provider,
			name: model,
			...(baseUrl ? { baseUrl } : {}),
		};
	}

	/** When the tab opens: the models, if a key can be found. */
	load(): Promise<void> {
		if (!this.keyDeps.keys()[this.state.provider]) return Promise.resolve();
		return this.listModels();
	}

	/**
	 * Another provider: its own model and list. A list still under way for the old one is
	 * dropped, so a slow provider does not hold the chips.
	 */
	selectProvider(provider: KeyProvider): Promise<void> {
		if (provider === this.state.provider) return Promise.resolve();
		if (this.state.busy && this.state.busy !== "models")
			return Promise.resolve();
		this.epoch++;
		this.set({
			provider,
			models: undefined,
			model:
				this.initial?.provider === provider ? this.initial.name : undefined,
			replacing: false,
			busy: undefined,
			result: undefined,
		});
		return this.load();
	}

	/** Saves the key into the system keychain, then lists the models with it. */
	saveKey(key: string): Promise<boolean> {
		const value = key.trim();
		let saved = false;
		return this.run("key", async (alive) => {
			if (!value) return;
			const provider = this.state.provider;
			await this.keyDeps.setKey(provider, value);
			saved = true;
			if (!alive()) return;
			this.set({ replacing: false });
			await this.fetchModels(alive);
			if (alive() && !this.state.result)
				this.set({ result: { kind: "note", note: "keyStored" } });
		}).then(() => saved);
	}

	/**
	 * Removes the keychain's key. One in the settings file or the environment still works
	 * afterwards: the line says so instead of "Removed".
	 */
	removeKey(): Promise<void> {
		return this.run("remove", async (alive) => {
			const provider = this.state.provider;
			await this.keyDeps.deleteKey(provider);
			if (!alive()) return;
			const still = this.keyDeps.keys()[provider]
				? this.keyDeps.keySources()[provider]
				: undefined;
			const note: Note =
				still === "file"
					? "keyStillFile"
					: still === "environment"
						? "keyStillEnv"
						: "keyRemoved";
			// Without a key the list is gone too: it was the key's list.
			this.set({
				result: { kind: "note", note, provider },
				...(still ? {} : { models: undefined }),
			});
		});
	}

	replace(): void {
		this.set({ replacing: true, result: undefined });
	}

	cancelReplace(): void {
		this.set({ replacing: false });
	}

	/** "Refresh models": the list with the stored key. */
	listModels(): Promise<void> {
		return this.run("models", (alive) => this.fetchModels(alive));
	}

	/** A model from the list: the tab keeps it. */
	pick(id: string): void {
		if (!id) return;
		if (id !== this.state.model) this.set({ model: id });
		this.remember();
	}

	private async fetchModels(alive: () => boolean): Promise<void> {
		this.set({ busy: "models" });
		const models = await this.deps.call<ListedModel[]>("models.list", {
			provider: this.state.provider,
		});
		if (!alive()) return;
		this.set({ models: Array.isArray(models) ? models : [] });
	}
}

// Local model -----------------------------------------------------------------------------------

/** A found server, or an address the player typed. */
export type Source = LocalServer["kind"] | "other";

export interface LocalDeps extends TabDeps {
	sleep(ms: number): Promise<void>;
}

export interface LocalState extends TabState {
	servers?: LocalServer[];
	source?: Source;
	/** The other server's address and its models, once one answered. */
	other?: { baseUrl: string; models: LocalModel[] };
	model?: string;
}

/** After `local.start`: how often and how long to look for the server coming up. */
export const START_TRIES = 6;
export const START_PAUSE_MS = 1500;

export class LocalTab extends TabController<LocalState> {
	constructor(
		deps: LocalDeps,
		private readonly initial?: Extract<Choice, { kind: "local" }>,
	) {
		super(deps, {
			...(initial
				? {
						// A server at its own address, such as Ollama on another PC, shows as "Other
						// server" with that address: found servers here are another destination.
						source:
							initial.provider === "openai-compatible" || initial.baseUrl
								? ("other" as const)
								: initial.provider,
						model: initial.name,
					}
				: {}),
		});
	}

	/** The address of the other server the tab held, for the address field. */
	get initialAddress(): string {
		return this.initial?.baseUrl ?? "";
	}

	choice(): Choice | undefined {
		const { source, model, other } = this.state;
		if (!source || !model) return undefined;
		if (source === "other") {
			if (!other) return undefined;
			// The address it held: its provider stays, so nothing changes but the model.
			const same =
				this.initial?.baseUrl === other.baseUrl &&
				this.initial.provider !== "openai-compatible";
			return {
				kind: "local",
				provider:
					same && this.initial ? this.initial.provider : "openai-compatible",
				name: model,
				baseUrl: other.baseUrl,
			};
		}
		const server = this.state.servers?.find((s) => s.kind === source);
		return server?.running
			? { kind: "local", provider: source, name: model }
			: undefined;
	}

	/** The models of the chosen server. */
	models(): LocalModel[] {
		const { source } = this.state;
		if (source === "other") return this.state.other?.models ?? [];
		return this.state.servers?.find((s) => s.kind === source)?.models ?? [];
	}

	/** When the tab opens and "Search again": the servers on this PC, and the other one. */
	load(): Promise<void> {
		return this.run("find", async (alive) => {
			await this.find(alive);
			const address = this.state.other?.baseUrl ?? this.initialAddress;
			if (alive() && this.state.source === "other" && address)
				await this.fetchOther(address, alive, false);
		});
	}

	/** A running server's card. */
	select(kind: LocalServer["kind"]): void {
		if (this.state.busy) return;
		const server = this.state.servers?.find((s) => s.kind === kind);
		if (!server?.running || this.state.source === kind) return;
		this.set({
			source: kind,
			model: this.preselect(kind, server.models),
			result: undefined,
		});
		this.remember();
	}

	/** "Other server…": the address field; its models come with Search. */
	selectOther(): void {
		if (this.state.busy || this.state.source === "other") return;
		this.set({
			source: "other",
			model: this.state.other
				? this.preselect("other", this.state.other.models)
				: undefined,
			result: undefined,
		});
		if (this.state.other) this.remember();
	}

	/** "Start" on an installed server that is off; then look until it answers. */
	start(kind: LocalServer["kind"]): Promise<void> {
		return this.run("start", async (alive) => {
			await this.deps.call("local.start", { kind });
			for (let i = 0; i < START_TRIES && alive(); i++) {
				await (this.deps as LocalDeps).sleep(START_PAUSE_MS);
				if (!alive()) return;
				await this.find(alive);
				const server = this.state.servers?.find((s) => s.kind === kind);
				if (server?.running) {
					this.set({
						source: kind,
						model: this.preselect(kind, server.models),
					});
					this.remember();
					return;
				}
			}
			if (alive()) this.set({ result: { kind: "note", note: "notStarted" } });
		});
	}

	/** "Search" for the address the player typed. */
	search(input: string): Promise<void> {
		const baseUrl = serverAddress(input);
		if (!baseUrl) {
			if (!this.state.busy)
				this.set({ result: { kind: "note", note: "badAddress" } });
			return Promise.resolve();
		}
		return this.run("search", (alive) => this.fetchOther(baseUrl, alive, true));
	}

	/** A model of the chosen server: the tab keeps it. */
	pick(id: string): void {
		if (!id) return;
		if (id !== this.state.model) this.set({ model: id, result: undefined });
		this.remember();
	}

	private async find(alive: () => boolean): Promise<void> {
		const servers = await this.deps.call<LocalServer[]>("local.find");
		if (!alive()) return;
		const list = Array.isArray(servers) ? servers : [];
		this.set({ servers: list });
		// Nothing held yet: the first running server, without saving anything.
		if (!this.state.source) {
			const first = list.find((s) => s.running);
			if (first)
				this.set({
					source: first.kind,
					model: this.preselect(first.kind, first.models),
				});
		}
	}

	private async fetchOther(
		baseUrl: string,
		alive: () => boolean,
		chosen: boolean,
	): Promise<void> {
		const models = await this.deps.call<LocalModel[]>("local.models", {
			baseUrl,
		});
		if (!alive()) return;
		const list = Array.isArray(models) ? models : [];
		this.set({
			source: "other",
			other: { baseUrl, models: list },
			model: this.preselect("other", list),
		});
		// A server the player searched for is a choice; reopening the tab is not.
		if (chosen) this.remember();
	}

	/**
	 * The model a server opens with: the one the tab held there, else the first that can call
	 * tools, else the first.
	 */
	private preselect(source: Source, models: LocalModel[]): string | undefined {
		const held = this.state.source === source ? this.state.model : undefined;
		const initial =
			this.initial &&
			(this.initial.provider === "openai-compatible"
				? "other"
				: this.initial.provider) === source
				? this.initial.name
				: undefined;
		for (const id of [held, initial])
			if (id && models.some((m) => m.id === id)) return id;
		return (models.find((m) => m.tools === true) ?? models[0])?.id;
	}
}
