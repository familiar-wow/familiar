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
	| { kind: "key"; provider: KeyProvider; name: string }
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
	key?: { provider: KeyProvider; name: string };
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
		return { kind, provider: model.provider, name: model.name };
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
 * What a tab shows when it opens: the brain that answers if it is of this kind, else what the
 * tab held last. For the agent tab `where` picks between this PC and another computer.
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
		if (active?.kind === "agent" && active.where === want) return active;
		if (want === "ssh") {
			if (!remembered.ssh) return undefined;
			const { cwd, ...ssh } = remembered.ssh;
			return { kind, where: "ssh", ssh, ...(cwd ? { cwd } : {}) };
		}
		const command = remembered.agent?.command ?? settings.brain?.command;
		const cwd = remembered.agent?.cwd;
		return command
			? { kind, where: "local", command, ...(cwd ? { cwd } : {}) }
			: undefined;
	}
	if (active?.kind === kind) return active;
	if (kind === "chatgpt" && remembered.chatgpt)
		return { kind, ...remembered.chatgpt };
	if (kind === "key" && remembered.key) return { kind, ...remembered.key };
	if (kind === "local" && remembered.local)
		return { kind, ...remembered.local };
	return undefined;
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
			brains.key = { provider: choice.provider, name: choice.name };
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
	const next = remember(settings, choice);
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
			...(choice.kind === "local" && choice.baseUrl
				? { baseUrl: choice.baseUrl }
				: {}),
		};
	}
	next.brain = brain;
	return next;
}

/** Whether `choice` is the brain that answers now, so the page can say "in use". */
export function isActive(settings: Settings, choice: Choice): boolean {
	return (
		JSON.stringify(activeChoice(settings)) ===
		JSON.stringify(activeChoice(applyChoice(settings, choice)))
	);
}

/**
 * A command typed in one line, split as a shell would split words: spaces separate, quotes keep
 * spaces in a word. No variables, no globbing: the words go to the program as they are.
 */
export function splitCommand(line: string): string[] {
	const words: string[] = [];
	let word = "";
	let quote: '"' | "'" | undefined;
	let started = false;
	for (const ch of line.trim()) {
		if (quote) {
			if (ch === quote) quote = undefined;
			else word += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			started = true;
		} else if (/\s/.test(ch)) {
			if (started) words.push(word);
			word = "";
			started = false;
		} else {
			word += ch;
			started = true;
		}
	}
	if (started) words.push(word);
	return words;
}

/** The command as one line again, quoting words with spaces. */
export function joinCommand(words: readonly string[]): string {
	return words
		.map((w) =>
			/[\s"']/.test(w) || w === "" ? `"${w.replace(/"/g, "'")}"` : w,
		)
		.join(" ");
}
