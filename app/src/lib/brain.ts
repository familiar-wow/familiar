// The Brain page's choices and the settings they stand for. Each kind of brain (a tab on the
// page) keeps what it held last in `app.brains`, so switching kinds and back loses nothing; the
// brain that answers is `brain` (core/src/settings.ts). Pure logic, tested in brain.test.ts.

export type BrainKind = "chatgpt" | "key" | "local" | "agent";
export const KEY_PROVIDERS = [
	"openai",
	"anthropic",
	"google",
	"openrouter",
	"deepseek",
] as const;
export type KeyProvider = (typeof KEY_PROVIDERS)[number];
export type LocalProvider = "ollama" | "lmstudio" | "openai-compatible";
export type Permissions = "ask" | "deny" | "allow";
export type SshAuth = "key" | "passphrase" | "password";

/** The agent on another computer, as `brain.ssh` holds it. */
export interface SshSettings {
	host: string;
	user?: string;
	identityFile?: string;
	auth: SshAuth;
	command: string[];
}

export type Choice =
	| { kind: "chatgpt"; name: string }
	| { kind: "key"; provider: KeyProvider; name: string; baseUrl?: string }
	| { kind: "local"; provider: LocalProvider; name: string; baseUrl?: string }
	| { kind: "agent"; where: "local"; command: string[]; cwd?: string }
	| { kind: "agent"; where: "ssh"; ssh: SshSettings; cwd?: string };

/** The settings as `settings.get` returns them; only the parts this page reads are typed. */
export interface Settings {
	game?: { client?: string };
	app?: {
		language?: string;
		close?: string;
		autostart?: boolean;
		setupDone?: boolean;
		brains?: Remembered;
	};
	brain?: {
		use?: "agent" | "model";
		model?: { provider: string; name: string; baseUrl?: string };
		command?: string[];
		permissions?: Permissions;
		timeout?: number;
		cwd?: string;
		ssh?: SshSettings;
	};
	mcp?: { port?: number };
}

/** `app.brains`: what each kind held last. */
export interface Remembered {
	chatgpt?: { name: string };
	key?: { provider: KeyProvider; name: string; baseUrl?: string };
	local?: { provider: LocalProvider; name: string; baseUrl?: string };
	agent?: { command: string[]; cwd?: string };
	/** The working folder on that computer, kept apart from the one on this PC. */
	ssh?: SshSettings & { cwd?: string };
}

const isKeyProvider = (p: string): p is KeyProvider =>
	(KEY_PROVIDERS as readonly string[]).includes(p);
const isLocalProvider = (p: string): p is LocalProvider =>
	p === "ollama" || p === "lmstudio" || p === "openai-compatible";

/** The kind of brain that answers now. */
export function activeKind(settings: Settings): BrainKind {
	const brain = settings.brain;
	if (brain?.use !== "model" || !brain.model) return "agent";
	const p = brain.model.provider;
	if (p === "chatgpt") return "chatgpt";
	if (isLocalProvider(p)) return "local";
	return "key";
}

/** The choice that answers now, when it is a complete one. */
export function activeChoice(settings: Settings): Choice | undefined {
	const brain = settings.brain ?? {};
	const kind = activeKind(settings);
	const model = brain.model;
	if (kind === "chatgpt" && model) return { kind, name: model.name };
	if (kind === "key" && model && isKeyProvider(model.provider))
		return {
			kind,
			provider: model.provider,
			name: model.name,
			// A provider's own address, such as a proxy, set by hand: kept, not replaced.
			...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
		};
	if (kind === "local" && model && isLocalProvider(model.provider))
		return {
			kind,
			provider: model.provider,
			name: model.name,
			...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
		};
	if (kind === "agent") {
		const cwd = brain.cwd ? { cwd: brain.cwd } : {};
		if (brain.ssh) return { kind, where: "ssh", ssh: brain.ssh, ...cwd };
		return {
			kind,
			where: "local",
			command: brain.command ?? ["hermes", "acp"],
			...cwd,
		};
	}
	return undefined;
}

/**
 * What a tab shows when it opens: what it held last, else the brain that answers if it is of
 * this kind. For the agent tab `where` picks between this PC and another computer; without it,
 * the place of the agent that answers.
 */
export function choiceFor(
	settings: Settings,
	kind: BrainKind,
	where?: "local" | "ssh",
): Choice | undefined {
	const active = activeChoice(settings);
	const remembered = settings.app?.brains ?? {};
	if (kind === "agent") {
		const want =
			where ?? (active?.kind === "agent" ? active.where : undefined) ?? "local";
		if (want === "ssh" && remembered.ssh) {
			const { cwd, ...ssh } = remembered.ssh;
			return { kind, where: "ssh", ssh, ...(cwd ? { cwd } : {}) };
		}
		if (want === "local" && remembered.agent) {
			const { command, cwd } = remembered.agent;
			return { kind, where: "local", command, ...(cwd ? { cwd } : {}) };
		}
		if (active?.kind === "agent" && active.where === want) return active;
		if (want === "local" && settings.brain?.command)
			return { kind, where: "local", command: settings.brain.command };
		return undefined;
	}
	if (kind === "chatgpt" && remembered.chatgpt)
		return { kind, ...remembered.chatgpt };
	if (kind === "key" && remembered.key) return { kind, ...remembered.key };
	if (kind === "local" && remembered.local)
		return { kind, ...remembered.local };
	return active?.kind === kind ? active : undefined;
}

/** The settings with `choice` remembered for its tab, nothing else changed. */
export function remember(settings: Settings, choice: Choice): Settings {
	const next = structuredClone(settings);
	const brains: Remembered = { ...next.app?.brains };
	switch (choice.kind) {
		case "chatgpt":
			brains.chatgpt = { name: choice.name };
			break;
		case "key":
			brains.key = {
				provider: choice.provider,
				name: choice.name,
				...(choice.baseUrl ? { baseUrl: choice.baseUrl } : {}),
			};
			break;
		case "local":
			brains.local = {
				provider: choice.provider,
				name: choice.name,
				...(choice.baseUrl ? { baseUrl: choice.baseUrl } : {}),
			};
			break;
		case "agent": {
			const cwd = choice.cwd ? { cwd: choice.cwd } : {};
			if (choice.where === "ssh") brains.ssh = { ...choice.ssh, ...cwd };
			else brains.agent = { command: choice.command, ...cwd };
		}
	}
	next.app = { ...next.app, brains };
	return next;
}

/**
 * The settings with `choice` as the brain that answers, and remembered for its tab. Everything
 * else stays: the game, the other tabs, and the agent's permissions and time limit.
 */
export function applyChoice(settings: Settings, choice: Choice): Settings {
	// The brain that answered keeps its place on its tab, also when it was set up by hand; a
	// choice the tab holds already (one the player picked but did not use) stays.
	const before = activeChoice(settings);
	const seed = before && !rememberedFor(settings, before) ? before : undefined;
	const next = remember(seed ? remember(settings, seed) : settings, choice);
	const brain = { ...next.brain };
	if (choice.kind === "agent") {
		brain.use = "agent";
		delete brain.model;
		if (choice.where === "ssh") brain.ssh = choice.ssh;
		else {
			delete brain.ssh;
			brain.command = choice.command;
		}
		if (choice.cwd) brain.cwd = choice.cwd;
		else delete brain.cwd;
	} else {
		brain.use = "model";
		const provider = choice.kind === "chatgpt" ? "chatgpt" : choice.provider;
		brain.model = {
			provider,
			name: choice.name,
			...(choice.kind !== "chatgpt" && choice.baseUrl
				? { baseUrl: choice.baseUrl }
				: {}),
		};
	}
	next.brain = brain;
	return next;
}

/** Whether `choice`'s tab (or place, for an agent) holds something already. */
function rememberedFor(settings: Settings, choice: Choice): boolean {
	const brains = settings.app?.brains ?? {};
	if (choice.kind === "agent")
		return Boolean(choice.where === "ssh" ? brains.ssh : brains.agent);
	return Boolean(brains[choice.kind]);
}

/**
 * Whether the saved brain is the one that answers: Familiar runs, and with these settings.
 * A brain that was saved but did not start is not "in use".
 */
export function answersNow(
	status: { running?: boolean; restartNeeded?: boolean } | undefined,
): boolean {
	return status?.running === true && status.restartNeeded !== true;
}

/** Whether `choice` is the brain that answers now, so the page can say "in use". */
export function isActive(settings: Settings, choice: Choice): boolean {
	return same(
		activeChoice(settings),
		activeChoice(applyChoice(settings, choice)),
	);
}

/** Equal values, whatever order their fields were written in. */
function same(a: unknown, b: unknown): boolean {
	return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.keys(value)
			.filter((k) => (value as Record<string, unknown>)[k] !== undefined)
			.sort()
			.map(
				(k) =>
					`${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`,
			)
			.join(",")}}`;
	return JSON.stringify(value) ?? "undefined";
}

/**
 * A command typed in one line, split into words the way Windows splits a command line
 * (CommandLineToArgvW): spaces separate words; double quotes keep spaces in a word; backslashes
 * are themselves, except right before a quote: 2n backslashes and a quote are n backslashes and
 * the quote's usual meaning, 2n+1 are n backslashes and a quote in the word. So
 * `"C:\Program Files\Agent\agent.exe"` needs no doubling. No variables, no `~`, no globbing:
 * the words go to the program as written. Undefined when a quote is not closed.
 */
export function splitCommand(line: string): string[] | undefined {
	const words: string[] = [];
	let word = "";
	let quoted = false;
	let started = false;
	const chars = [...line.trim()];
	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i] as string;
		if (ch === "\\") {
			let n = 0;
			while (chars[i + n] === "\\") n++;
			if (chars[i + n] === '"') {
				word += "\\".repeat(Math.floor(n / 2));
				if (n % 2 === 1) {
					word += '"';
					i += n;
				} else i += n - 1;
			} else {
				word += "\\".repeat(n);
				i += n - 1;
			}
			started = true;
		} else if (ch === '"') {
			quoted = !quoted;
			started = true;
		} else if (!quoted && /\s/.test(ch)) {
			if (started) words.push(word);
			word = "";
			started = false;
		} else {
			word += ch;
			started = true;
		}
	}
	if (quoted) return undefined;
	if (started) words.push(word);
	return words;
}

/** The words as one line again, so that `splitCommand` gives them back unchanged. */
export function joinCommand(words: readonly string[]): string {
	return words.map(quoteWord).join(" ");
}

function quoteWord(word: string): string {
	if (word !== "" && !/[\s"]/.test(word)) return word;
	let out = '"';
	let slashes = 0;
	for (const ch of word) {
		if (ch === "\\") {
			slashes++;
			continue;
		}
		// Backslashes before a quote are doubled, and the quote gets one of its own.
		out +=
			ch === '"'
				? `${"\\".repeat(slashes * 2 + 1)}"`
				: `${"\\".repeat(slashes)}${ch}`;
		slashes = 0;
	}
	// Before the closing quote, too.
	return `${out}${"\\".repeat(slashes * 2)}"`;
}
