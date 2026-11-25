// The Brain page's "Your own agent" tab: an agent on this PC, or on another computer through
// SSH. `presentAgent` and the helpers are pure; `AgentController` runs the calls behind the
// fields and buttons, one at a time, with the core and MainApp passed in, so both are tested
// without Svelte or Tauri. Passwords and passphrases only pass through `saveSecret` on their
// way to the keychain; they are never part of the state.
import {
	activeChoice,
	type Choice,
	isActive,
	joinCommand,
	type Permissions,
	type Settings,
	type SshAuth,
	type SshSettings,
	splitCommand,
} from "./brain.ts";
import { type Key, seconds, type Translate } from "./i18n.ts";
import type { BrainTest, Outcome } from "./main-app.ts";
import type { View } from "./overview.ts";
import { messageOf } from "./types.ts";

export type Where = "local" | "ssh";

/** An agent on this PC, as `agents.find` reports it. */
export interface FoundAgent {
	id: string;
	name: string;
	command: string[];
	path?: string;
	version?: string;
	ready: boolean;
	/** The core's fixed words for what is missing. */
	needs?: string;
}

/** What `ssh.resolve` says applies to a computer after `.ssh/config`. */
export interface Resolved {
	host: string;
	hostname: string;
	user: string;
	port: number;
	identityFiles: string[];
	proxyJump?: string;
	proxyCommand?: string;
	hostKeyAlias?: string;
	fromConfig: boolean;
}

/** What `ssh.test` reports: the sign-in and the program there, not an answer of the brain. */
export interface Connection {
	ok: boolean;
	problem?: string;
	agentFound?: boolean;
	agentPath?: string;
}

export interface LocalForm {
	/** The command as one line (`splitCommand`). */
	command: string;
	cwd: string;
	/** "Other command…" is chosen instead of an agent from the list. */
	custom: boolean;
}

export interface SshForm {
	host: string;
	/** Overrides from "Advanced"; empty means what `.ssh/config` says. */
	user: string;
	identityFile: string;
	auth: SshAuth;
	command: string;
	cwd: string;
}

export type Field = "host" | "user" | "command" | "cwd";

/** Why a form is not a complete choice yet, per field. */
export type Problems = Partial<Record<Field, Key>>;

/** The host-key step before a connection: SSH trusts a computer once, on the player's word. */
export type Trust =
	| { step: "none" }
	/** Not known yet; the computer showed this key. "Trust this computer" goes on with `next`. */
	| {
			step: "ask";
			host: string;
			fingerprint: string;
			/** The key's type, such as ssh-ed25519, when the core says it. */
			type?: string;
			next: "connect" | "use";
	  }
	/** Not known, and no key could be read from here (a jump host, or offline). */
	| { step: "unreachable"; host: string };

export type Busy =
	| "connect"
	| "trust"
	| "use"
	| "test"
	| "secret"
	| "permissions"
	| "folder";

/** The last action's result, the one line under the buttons. */
export type Result =
	| { kind: "used"; choice: Choice }
	| { kind: "notStarted"; problem: string }
	| { kind: "answered"; ms: number; answer?: string }
	| { kind: "testFailed"; problem: string }
	| { kind: "secretSaved" }
	| { kind: "error"; message: string };

export interface AgentState {
	where: Where;
	local: LocalForm;
	ssh: SshForm;
	permissions: Permissions;
	/** `agents.find`; undefined until it answered. */
	agents?: FoundAgent[];
	finding: boolean;
	findError?: string;
	/** `ssh.resolve` for exactly `host`; shown only while the field still holds it. */
	resolved?: { host: string; result: Resolved };
	/** Whether a password or passphrase is stored for `host` and `auth` (`ssh.hasSecret`). */
	stored?: { host: string; auth: SshAuth; has: boolean };
	resolveError?: { host: string; message: string };
	resolving?: string;
	advanced: boolean;
	trust: Trust;
	/** The last `ssh.test`, for the sign-in it was made with (`signIn`). */
	connection?: { signIn: string; result: Connection };
	busy?: Busy;
	result?: Result;
	/** Show "required" problems too: after the player tried to use or test the form. */
	tried: boolean;
	/** The choice last remembered or read, so a blur without a change saves nothing. */
	remembered?: string;
}

const DEFAULT: SshForm = {
	host: "",
	user: "",
	identityFile: "",
	auth: "key",
	command: "hermes acp",
	cwd: "",
};

/** The tab's draft, taken from the settings once when it opens. */
export function initialState(settings: Settings): AgentState {
	const active = activeChoice(settings);
	const where: Where =
		active?.kind === "agent" && active.where === "ssh" ? "ssh" : "local";
	const remembered = settings.app?.brains ?? {};
	const brain = settings.brain ?? {};
	// This PC: what the tab held last, else the agent that answers here, else the core's default.
	const here =
		remembered.agent ??
		(active?.kind === "agent" && active.where === "local" ? active : undefined);
	const local: LocalForm = {
		command: joinCommand(here?.command ?? brain.command ?? ["hermes", "acp"]),
		cwd: here?.cwd ?? "",
		custom: false,
	};
	const there =
		remembered.ssh ??
		(active?.kind === "agent" && active.where === "ssh"
			? { ...active.ssh, cwd: active.cwd }
			: undefined);
	const ssh: SshForm = there
		? {
				host: there.host,
				user: there.user ?? "",
				identityFile: there.identityFile ?? "",
				auth: there.auth,
				command: joinCommand(there.command),
				cwd: there.cwd ?? "",
			}
		: { ...DEFAULT };
	const state: AgentState = {
		where,
		local,
		ssh,
		permissions: brain.permissions ?? "ask",
		finding: false,
		advanced: ssh.user !== "" || ssh.identityFile !== "",
		trust: { step: "none" },
		tried: false,
	};
	const choice = formChoice(state).choice;
	if (choice) state.remembered = key(choice);
	return state;
}

const sameWords = (a: readonly string[], b: readonly string[]) =>
	a.length === b.length && a.every((w, i) => w === b[i]);

/** The command typed on this PC's form, checked. */
function commandOf(
	line: string,
): { words: string[]; problem?: undefined } | { problem: Key } {
	const words = splitCommand(line);
	if (words === undefined) return { problem: "agent.err.quote" };
	if (words.length === 0) return { problem: "agent.err.command" };
	// ssh and the core would read a leading "-" as an option.
	if (words[0]?.startsWith("-")) return { problem: "agent.err.dash" };
	return { words };
}

/** This PC's form as a choice, or what is missing. */
export function localChoice(form: LocalForm): {
	choice?: Choice;
	problems: Problems;
} {
	const command = commandOf(form.command);
	if (command.problem) return { problems: { command: command.problem } };
	const cwd = form.cwd.trim();
	return {
		choice: {
			kind: "agent",
			where: "local",
			command: command.words,
			...(cwd ? { cwd } : {}),
		},
		problems: {},
	};
}

/**
 * The SSH form as a choice, or what is missing. The computer and the command are required; the
 * working folder too, as an absolute folder there: the agent's session needs one that exists
 * on that computer, and this PC's folders do not.
 */
export function sshChoice(form: SshForm): {
	choice?: Choice;
	problems: Problems;
} {
	const problems: Problems = {};
	const host = form.host.trim();
	if (!host) problems.host = "agent.err.host";
	else if (/\s/.test(host)) problems.host = "agent.err.hostSpaces";
	else if (host.startsWith("-")) problems.host = "agent.err.hostDash";
	const user = form.user.trim();
	if (/\s/.test(user)) problems.user = "agent.err.userSpaces";
	const command = commandOf(form.command);
	if (command.problem) problems.command = command.problem;
	const cwd = form.cwd.trim();
	if (!cwd) problems.cwd = "agent.err.cwdRequired";
	else if (!cwd.startsWith("/")) problems.cwd = "agent.err.cwdAbsolute";
	if (Object.keys(problems).length > 0 || command.problem) return { problems };
	const identityFile = form.identityFile.trim();
	const ssh: SshSettings = {
		host,
		...(user ? { user } : {}),
		...(identityFile ? { identityFile } : {}),
		auth: form.auth,
		command: command.words,
	};
	return { choice: { kind: "agent", where: "ssh", ssh, cwd }, problems: {} };
}

/** The form of the place the tab shows, as a choice. */
export function formChoice(state: AgentState): {
	choice?: Choice;
	problems: Problems;
} {
	return state.where === "ssh"
		? sshChoice(state.ssh)
		: localChoice(state.local);
}

/** One value per choice, whatever order its fields were written in. */
function key(choice: Choice): string {
	return JSON.stringify(choice, (_, value) =>
		value && typeof value === "object" && !Array.isArray(value)
			? Object.fromEntries(
					Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
				)
			: value,
	);
}

/** Who signs in where: a connection test holds for these, whatever the command. */
export function signInOf(form: SshForm): string {
	return JSON.stringify([
		form.host.trim(),
		form.user.trim(),
		form.identityFile.trim(),
		form.auth,
	]);
}

export interface AgentRow {
	id: string;
	name: string;
	/** The command as one line, as it goes into the settings. */
	command: string;
	/** Where it was found and its version, as the program says it. */
	detail: string;
	/** "✓ ACP", or "not ready". */
	status: string;
	ready: boolean;
	/** What is missing, in the core's words. */
	needs?: string;
	selected: boolean;
	/** This agent answers now. */
	inUse: boolean;
}

/** The agents found on this PC, with the one the form holds selected. */
export function agentRows(
	agents: readonly FoundAgent[],
	form: LocalForm,
	settings: Settings | undefined,
	t: Translate,
): AgentRow[] {
	const typed = splitCommand(form.command);
	const active = settings ? activeChoice(settings) : undefined;
	const answering =
		active?.kind === "agent" && active.where === "local"
			? active.command
			: undefined;
	return agents.map((a) => ({
		id: a.id,
		name: a.name,
		command: joinCommand(a.command),
		// The first line of `--version` already names the program ("hermes 0.31.0").
		detail: [a.path, a.version].filter(Boolean).join(" · "),
		status: a.ready ? t("agent.ready") : t("agent.notReady"),
		ready: a.ready,
		...(a.ready || !a.needs
			? {}
			: { needs: t("agent.needs", { needs: a.needs }) }),
		selected: !form.custom && !!typed && sameWords(typed, a.command),
		inUse: !!answering && sameWords(answering, a.command),
	}));
}

/** The key files `ssh -G` lists by default: every one ssh would try, whether it exists or not. */
const USUAL_KEY = /^~[\\/]\.ssh[\\/]id_[a-z0-9_]+$/i;

/**
 * What applies to the computer, in one line: "homelab → 192.168.1.10, user p, port 22, key
 * ~/.ssh/id_ed25519, through jump-host; from .ssh/config", with the overrides from "Advanced"
 * in place of what they replace ("user q (set here)").
 */
export function resolvedLine(
	r: Resolved,
	over: { user?: string; identityFile?: string },
	t: Translate,
): string {
	const parts: string[] = [];
	const user = over.user?.trim();
	const keyFile = over.identityFile?.trim();
	if (user)
		parts.push(`${t("agent.ssh.user1", { user })} ${t("agent.ssh.setHere")}`);
	else if (r.user) parts.push(t("agent.ssh.user1", { user: r.user }));
	parts.push(t("agent.ssh.port1", { port: r.port }));
	if (keyFile)
		parts.push(
			`${t("agent.ssh.key1", { key: keyFile })} ${t("agent.ssh.setHere")}`,
		);
	else if (r.identityFiles.length === 1)
		parts.push(t("agent.ssh.key1", { key: r.identityFiles[0] ?? "" }));
	else if (r.identityFiles.length > 1)
		parts.push(
			r.identityFiles.every((f) => USUAL_KEY.test(f))
				? t("agent.ssh.keysUsual")
				: t("agent.ssh.keys", { keys: r.identityFiles.join(", ") }),
		);
	if (r.proxyJump) parts.push(t("agent.ssh.through", { via: r.proxyJump }));
	else if (r.proxyCommand) parts.push(t("agent.ssh.throughCommand"));
	const target =
		r.hostname && r.hostname !== r.host ? `${r.host} → ${r.hostname}` : r.host;
	const source = r.fromConfig
		? t("agent.ssh.fromConfig")
		: t("agent.ssh.notInConfig");
	return `${target}, ${parts.join(", ")}; ${source}`;
}

/** What the host-key answer means for the next step. */
export function trustStep(
	host: string,
	answer: HostKeyAnswer | null | undefined,
	next: "connect" | "use",
): "go" | Trust {
	if (answer?.known) return "go";
	if (answer?.fingerprint)
		return {
			step: "ask",
			host,
			fingerprint: answer.fingerprint,
			...(answer.type ? { type: answer.type } : {}),
			next,
		};
	return { step: "unreachable", host };
}

type HostKeyAnswer = { known?: boolean; fingerprint?: string; type?: string };

/**
 * The file the computer keeps that key in, for the player to compare: `ssh-ed25519` →
 * /etc/ssh/ssh_host_ed25519_key.pub. Undefined for a type we do not know a file for.
 */
export function hostKeyFile(type: string | undefined): string | undefined {
	const name = {
		"ssh-ed25519": "ed25519",
		"ecdsa-sha2-nistp256": "ecdsa",
		"ecdsa-sha2-nistp384": "ecdsa",
		"ecdsa-sha2-nistp521": "ecdsa",
		"ssh-rsa": "rsa",
	}[type ?? ""];
	return name ? `/etc/ssh/ssh_host_${name}_key.pub` : undefined;
}

export type Tone = "good" | "warn" | "bad";

export interface AgentPage {
	where: Where;
	/** This PC. */
	rows: AgentRow[];
	/** "Other command…" is selected: its field shows. */
	other: boolean;
	finding: boolean;
	/** `agents.find` answered with nothing. */
	none: boolean;
	findError?: string;
	/** SSH: the resolved line for the host in the field, or why it failed. */
	resolved?: string;
	resolveError?: string;
	resolving: boolean;
	/** A password or passphrase is not used through a jump host: said before the core refuses. */
	viaJump?: string;
	/** The program's path there differs from the command's first word: offer to use it. */
	usePath?: string;
	connection?: { tone: Tone; text: string };
	/** A good connection for this sign-in: the brain's own Test may run. */
	connected: boolean;
	trust: Trust;
	problems: Problems;
	/** The form is a complete choice. */
	complete: boolean;
	/** The form's choice is the brain that answers. */
	inUse: boolean;
	busy?: Busy;
	result?: { tone: Tone; text: string; detail?: string };
}

/** The answer's start, as plain text on one line. */
function excerpt(answer: string, max = 140): string {
	const line = answer.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** How the player knows the choice: the found agent's name, else the command (and the computer). */
export function choiceName(
	choice: Choice,
	agents: readonly FoundAgent[] | undefined,
	t: Translate,
): string {
	if (choice.kind !== "agent") return "";
	if (choice.where === "ssh")
		return t("agent.ssh.on", {
			command: joinCommand(choice.ssh.command),
			host: choice.ssh.host,
		});
	const found = agents?.find((a) => sameWords(a.command, choice.command));
	return found?.name ?? joinCommand(choice.command);
}

/** The problems that only say a field is empty. */
const REQUIRED = new Set<Key>([
	"agent.err.host",
	"agent.err.command",
	"agent.err.cwdRequired",
]);

export function presentAgent(
	state: AgentState,
	view: View,
	t: Translate,
): AgentPage {
	const { choice, problems } = formChoice(state);
	// "Required" shows only once the player tried; a wrong value shows at once.
	const shown: Problems = {};
	for (const [field, problem] of Object.entries(problems) as [Field, Key][])
		if (state.tried || !REQUIRED.has(problem)) shown[field] = problem;
	const agents = state.agents ?? [];
	const rows = agentRows(agents, state.local, view.settings, t);
	const page: AgentPage = {
		where: state.where,
		rows,
		other:
			state.local.custom ||
			(state.agents !== undefined && !rows.some((r) => r.selected)),
		finding: state.finding,
		none: state.agents !== undefined && agents.length === 0,
		resolving: false,
		connected: false,
		trust: state.trust,
		problems: shown,
		complete: choice !== undefined,
		inUse:
			choice !== undefined && view.settings !== undefined
				? isActive(view.settings, choice)
				: false,
	};
	if (state.findError) page.findError = state.findError;
	if (state.where === "ssh") {
		const host = state.ssh.host.trim();
		page.resolving = state.resolving === host && host !== "";
		const r = state.resolved?.host === host ? state.resolved.result : undefined;
		if (r) {
			page.resolved = resolvedLine(r, state.ssh, t);
			const via = r.proxyJump ?? (r.proxyCommand ? "ProxyCommand" : undefined);
			if (via && state.ssh.auth !== "key")
				page.viaJump = t("agent.ssh.viaJump", { host, via });
		}
		if (state.resolveError?.host === host)
			page.resolveError = state.resolveError.message;
		const c =
			state.connection?.signIn === signInOf(state.ssh)
				? state.connection.result
				: undefined;
		if (c) {
			page.connected = c.ok;
			page.connection = c.ok
				? {
						tone: "good",
						text: c.agentPath
							? t("agent.ssh.connectedAt", { path: c.agentPath })
							: t("agent.ssh.connected"),
					}
				: { tone: "bad", text: c.problem ?? t("agent.ssh.failed") };
			const first = splitCommand(state.ssh.command)?.[0];
			if (c.ok && c.agentPath && first !== c.agentPath)
				page.usePath = c.agentPath;
		}
	}
	if (state.busy) page.busy = state.busy;
	const r = state.result;
	if (r?.kind === "used")
		page.result = {
			tone: "good",
			text: t("agent.used", { name: choiceName(r.choice, state.agents, t) }),
		};
	else if (r?.kind === "notStarted")
		page.result = {
			tone: "bad",
			text: r.problem,
			detail: t("agent.notStarted"),
		};
	else if (r?.kind === "answered")
		page.result = {
			tone: "good",
			text: t("agent.answered", { seconds: seconds(r.ms, view.language) }),
			...(r.answer ? { detail: `“${excerpt(r.answer)}”` } : {}),
		};
	else if (r?.kind === "testFailed")
		page.result = { tone: "bad", text: r.problem };
	else if (r?.kind === "secretSaved")
		page.result = { tone: "good", text: t("agent.ssh.secretSaved") };
	else if (r?.kind === "error") page.result = { tone: "bad", text: r.message };
	return page;
}

export interface AgentDeps {
	call<T>(method: string, params?: Record<string, unknown>): Promise<T>;
	/** Keeps what the tab holds, without changing the brain that answers. */
	rememberBrain(choice: Choice): Promise<void>;
	/** Saves the choice as the brain that answers and (re)starts Familiar. */
	useBrain(choice: Choice): Promise<Outcome>;
	/** One short question to the choice, never thrown. */
	testBrain(choice: Choice): Promise<BrainTest>;
	/** MainApp's one queue of settings changes. */
	updateSettings(change: (settings: Settings) => Settings): Promise<Settings>;
	pickFolder(title: string): Promise<string | null>;
}

export class AgentController {
	state: AgentState;
	private readonly watchers = new Set<(state: AgentState) => void>();
	/** The tab is gone: late answers are dropped. */
	private disposed = false;

	constructor(
		private readonly deps: AgentDeps,
		settings: Settings,
	) {
		this.state = initialState(settings);
	}

	watch(fn: (state: AgentState) => void): () => void {
		this.watchers.add(fn);
		return () => this.watchers.delete(fn);
	}

	dispose(): void {
		this.disposed = true;
		this.watchers.clear();
	}

	/** When the tab opens, and "Search again". */
	async findAgents(): Promise<void> {
		if (this.state.finding) return;
		this.set({ finding: true, findError: undefined });
		try {
			const found = await this.deps.call<unknown>("agents.find");
			const agents = Array.isArray(found) ? (found as FoundAgent[]) : [];
			this.set({ agents });
		} catch (error) {
			this.set({
				findError: messageOf(error),
				agents: this.state.agents ?? [],
			});
		} finally {
			this.set({ finding: false });
		}
	}

	/** "On this PC" / "On another computer": only the tab changes, nothing is saved. */
	setWhere(where: Where): void {
		if (where === this.state.where || this.state.busy) return;
		this.set({
			where,
			result: undefined,
			tried: false,
			trust: { step: "none" },
		});
		if (where === "ssh") void this.resolve();
	}

	/** A found agent was clicked: that command, remembered for the tab. */
	pickAgent(agent: FoundAgent): void {
		if (this.state.busy) return;
		this.set({
			local: {
				...this.state.local,
				command: joinCommand(agent.command),
				custom: false,
			},
			result: undefined,
		});
		this.commit();
	}

	/** "Other command…": the command field, with what the form held. */
	pickOther(): void {
		if (this.state.busy) return;
		this.set({
			local: { ...this.state.local, custom: true },
			result: undefined,
		});
	}

	editLocal(change: Partial<Omit<LocalForm, "custom">>): void {
		const local = { ...this.state.local, ...change };
		this.set({ local, ...this.stale(this.state.local, local) });
	}

	/** Typing in the SSH form. A resolve answer belongs to its host: another host drops it. */
	editSsh(change: Partial<SshForm>): void {
		const ssh = { ...this.state.ssh, ...change };
		const host = ssh.host.trim();
		const next: Partial<AgentState> = {
			ssh,
			...this.stale(this.state.ssh, ssh),
		};
		if (this.state.resolved && this.state.resolved.host !== host)
			next.resolved = undefined;
		if (this.state.resolveError && this.state.resolveError.host !== host)
			next.resolveError = undefined;
		if (this.state.trust.step !== "none" && this.state.trust.host !== host)
			next.trust = { step: "none" };
		this.set(next);
	}

	/** A sign-in method was picked: a complete choice, so remembered. */
	setAuth(auth: SshAuth): void {
		if (this.state.busy) return;
		this.editSsh({ auth });
		this.commit();
	}

	toggleAdvanced(): void {
		this.set({ advanced: !this.state.advanced });
	}

	/**
	 * What `.ssh/config` makes of the host in the field, after a pause or on blur. Kept only
	 * while the field still holds that host.
	 */
	async resolve(): Promise<void> {
		const host = this.state.ssh.host.trim();
		if (!host || /\s/.test(host) || host.startsWith("-")) return;
		if (this.state.resolved?.host === host || this.state.resolving === host)
			return;
		if (this.state.resolveError?.host === host) return;
		this.set({ resolving: host });
		try {
			const result = await this.deps.call<Resolved>("ssh.resolve", { host });
			if (this.state.ssh.host.trim() === host && result)
				this.set({ resolved: { host, result }, resolveError: undefined });
		} catch (error) {
			if (this.state.ssh.host.trim() === host)
				this.set({
					resolveError: { host, message: messageOf(error) },
					resolved: undefined,
				});
		} finally {
			if (this.state.resolving === host) this.set({ resolving: undefined });
		}
	}

	/**
	 * A field lost focus or a choice was made: a complete form is remembered for the tab, in
	 * the background; a half-typed one is not.
	 */
	commit(): void {
		const { choice } = formChoice(this.state);
		if (!choice) return;
		const k = key(choice);
		if (k === this.state.remembered) return;
		const before = this.state.remembered;
		this.set({ remembered: k });
		this.deps.rememberBrain(choice).catch((error) => {
			if (this.state.remembered === k) this.set({ remembered: before });
			this.set({ result: { kind: "error", message: messageOf(error) } });
		});
	}

	/** "Choose…" for the working folder on this PC. */
	chooseFolder(title: string): Promise<void> {
		return this.run("folder", async () => {
			const folder = await this.deps.pickFolder(title);
			if (!folder) return;
			this.editLocal({ cwd: folder });
			this.commit();
		});
	}

	/** One setting for all agents; takes effect with the next start. */
	setPermissions(permissions: Permissions): Promise<void> {
		if (permissions === this.state.permissions) return Promise.resolve();
		return this.run("permissions", async () => {
			const before = this.state.permissions;
			this.set({ permissions, result: undefined });
			try {
				await this.deps.updateSettings((settings) => ({
					...settings,
					brain: { ...settings.brain, permissions },
				}));
			} catch (error) {
				this.set({
					permissions: before,
					result: { kind: "error", message: messageOf(error) },
				});
			}
		});
	}

	/**
	 * A password or passphrase for the computer in the field, into the keychain. The value is
	 * passed on and forgotten; the page clears its field afterwards.
	 */
	saveSecret(value: string): Promise<boolean> {
		const host = this.state.ssh.host.trim();
		const kind = this.state.ssh.auth;
		let saved = false;
		if (!host || kind === "key" || !value) return Promise.resolve(false);
		return this.run("secret", async () => {
			this.set({ result: undefined });
			try {
				await this.deps.call("ssh.setSecret", { host, kind, value });
				saved = true;
				// A sign-in that failed for want of it may work now: test it again.
				this.set({
					result: { kind: "secretSaved" },
					connection: undefined,
					stored: { host, auth: kind, has: true },
				});
			} catch (error) {
				this.set({ result: { kind: "error", message: messageOf(error) } });
			}
		}).then(() => saved);
	}

	/**
	 * Whether a password or passphrase is already stored for the computer in the field, so the
	 * page can say so after it was reopened. Kept only for that host and sign-in.
	 */
	async checkStored(): Promise<void> {
		const host = this.state.ssh.host.trim();
		const auth = this.state.ssh.auth;
		if (!host || auth === "key") return;
		if (this.state.stored?.host === host && this.state.stored.auth === auth)
			return;
		try {
			const has = await this.deps.call<boolean>("ssh.hasSecret", {
				host,
				kind: auth,
			});
			if (this.state.ssh.host.trim() === host && this.state.ssh.auth === auth)
				this.set({ stored: { host, auth, has: has === true } });
		} catch {
			// Not knowing is no error: the field stays as it is.
		}
	}

	/** "Test connection": the host key, then the sign-in and the program there. */
	connect(): Promise<void> {
		return this.run("connect", async () => {
			const choice = this.ready();
			if (choice?.kind !== "agent" || choice.where !== "ssh") return;
			if (!(await this.hostKey(choice.ssh.host, "connect"))) return;
			const signIn = signInOf(this.state.ssh);
			let result: Connection;
			try {
				result = await this.deps.call<Connection>("ssh.test", {
					ssh: choice.ssh,
				});
			} catch (error) {
				result = { ok: false, problem: messageOf(error) };
			}
			this.set({ connection: { signIn, result: result ?? { ok: false } } });
		});
	}

	/** "Trust this computer": the fingerprint the player saw, then what they had started. */
	async trust(): Promise<void> {
		const trust = this.state.trust;
		if (trust.step !== "ask") return;
		let trusted = false;
		await this.run("trust", async () => {
			try {
				await this.deps.call("ssh.trust", {
					host: trust.host,
					fingerprint: trust.fingerprint,
				});
				trusted = true;
				this.set({ trust: { step: "none" } });
			} catch (error) {
				this.set({ result: { kind: "error", message: messageOf(error) } });
			}
		});
		if (!trusted || this.state.ssh.host.trim() !== trust.host) return;
		await (trust.next === "use" ? this.use() : this.connect());
	}

	/** "Use this path": the program's full path there as the command's first word. */
	usePath(): void {
		const c = this.state.connection?.result;
		const words = splitCommand(this.state.ssh.command);
		if (!c?.agentPath || !words || this.state.busy) return;
		this.editSsh({ command: joinCommand([c.agentPath, ...words.slice(1)]) });
		this.commit();
	}

	/** "Use this agent". On another computer, the host key comes first. */
	use(): Promise<void> {
		return this.run("use", async () => {
			const choice = this.ready();
			if (!choice) return;
			if (choice.kind === "agent" && choice.where === "ssh")
				if (!(await this.hostKey(choice.ssh.host, "use"))) return;
			const outcome = await this.deps.useBrain(choice);
			this.set({
				remembered: key(choice),
				result: outcome.ok
					? { kind: "used", choice }
					: { kind: "notStarted", problem: outcome.problem },
			});
		});
	}

	/** "Test": one question to the brain itself; may take over a minute. */
	test(): Promise<void> {
		return this.run("test", async () => {
			const choice = this.ready();
			if (!choice) return;
			const r = await this.deps.testBrain(choice);
			this.set({
				result: r.ok
					? {
							kind: "answered",
							ms: r.ms,
							...(r.answer ? { answer: r.answer } : {}),
						}
					: { kind: "testFailed", problem: r.problem ?? "" },
			});
		});
	}

	/** A result about another form than the one shown now is gone. */
	private stale(before: object, after: object): Partial<AgentState> {
		const kind = this.state.result?.kind;
		const about = kind !== undefined && kind !== "error";
		return about && JSON.stringify(before) !== JSON.stringify(after)
			? { result: undefined }
			: {};
	}

	/** The form's choice; otherwise its problems show. */
	private ready(): Choice | undefined {
		const { choice } = formChoice(this.state);
		if (!choice) this.set({ tried: true });
		return choice;
	}

	/** Whether the computer's host key is trusted, asking the player once when it is not. */
	private async hostKey(
		host: string,
		next: "connect" | "use",
	): Promise<boolean> {
		let answer: HostKeyAnswer | null;
		try {
			answer = await this.deps.call("ssh.hostKey", { host });
		} catch (error) {
			this.set({ result: { kind: "error", message: messageOf(error) } });
			return false;
		}
		const step = trustStep(host, answer, next);
		if (step === "go") {
			this.set({ trust: { step: "none" } });
			return true;
		}
		this.set({ trust: step });
		return false;
	}

	private async run(busy: Busy, action: () => Promise<void>): Promise<void> {
		if (this.state.busy) return;
		this.set({ busy, result: undefined });
		try {
			await action();
		} finally {
			this.set({ busy: undefined });
		}
	}

	private set(change: Partial<AgentState>): void {
		if (this.disposed) return;
		const next = { ...this.state, ...change };
		for (const k of Object.keys(change) as (keyof AgentState)[])
			if (change[k] === undefined) delete next[k];
		this.state = next;
		for (const fn of this.watchers) fn(this.state);
	}
}
