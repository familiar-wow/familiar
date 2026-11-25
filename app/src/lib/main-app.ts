// The main window's logic: it owns the connection to the core, follows the core's generations,
// runs the bootstrap, and tells the tray icon and the tray panel what to show. App.svelte only
// renders `view`.

import { Bootstrap, type Step } from "./bootstrap.ts";
import {
	applyChoice,
	type BrainKind,
	type Choice,
	remember,
	type Settings,
} from "./brain.ts";
import { CoreClient, STOPPED } from "./client.ts";
import { resolveLanguage, translator } from "./i18n.ts";
import { emptyView, snapshot, trayUpdate, type View } from "./overview.ts";
import { isQuestionLine } from "./questions.ts";
import { timeoutFor } from "./timeouts.ts";
import {
	type Host,
	messageOf,
	type Page,
	type SidecarState,
	type Status,
} from "./types.ts";

/** `start` waits for the brain to come up, which can take a while. */
export const START_TIMEOUT_MS = 60_000;
/** Question lines kept for the overview; it shows 8. */
const KEEP_LOG = 200;
/** All log lines kept for the Logs page. */
export const KEEP_LINES = 2000;
/** What `logs.recent` gives at most. */
const RECENT = 500;
/** Rust keeps the same number of stderr lines. */
const KEEP_STDERR = 20;
interface SettingsReply {
	settings?: Settings;
	keys?: Record<string, boolean>;
	keySources?: Record<string, KeySource>;
	file?: string;
}

/** Where an API key comes from; "Remove" deletes only the keychain's. */
export type KeySource = "keychain" | "file" | "environment";

/**
 * What `brain.test` answers: `ok` only for a real answer, with its start; otherwise `problem`,
 * the core's words. `tools` are the tools it named.
 */
export interface BrainTest {
	ok: boolean;
	ms: number;
	answer?: string;
	problem?: string;
	tools: string[];
}

/** How starting Familiar went: running, or why not. */
export type Outcome = { ok: true } | { ok: false; problem: string };

export interface MainAppOptions {
	/** navigator.language, for `app.language: "system"`. */
	systemLanguage?: string;
	timeoutMs?: number;
	startTimeoutMs?: number;
}

/** Thrown when a newer core took over while a step waited. */
class Abandoned extends Error {}

export class MainApp {
	view: View;
	private readonly client: CoreClient;
	private readonly bootstrap: Bootstrap;
	private unlisten: (() => void)[] = [];
	private readonly watchers = new Set<(view: View) => void>();
	private lastTray?: string;
	private lastSnapshot?: string;
	/** Log lines that arrived while `logs.recent` was under way. */
	private arriving?: Record<string, unknown>[];
	/** The setup assistant opens by itself once per app start, not for every new core. */
	private setupShown = false;
	/** Settings changes, one after another (`updateSettings`). */
	private settingsQueue: Promise<unknown> = Promise.resolve();
	/** A start or restart under way, if one is. */
	private starting?: Promise<Outcome>;
	/** The ChatGPT sign-in that waits for the browser, if one does. */
	private signingIn?: Promise<{ account: string; usage: string }>;

	constructor(
		private readonly host: Host,
		private readonly o: MainAppOptions = {},
	) {
		this.view = emptyView(resolveLanguage("system", o.systemLanguage));
		this.client = new CoreClient({
			send: (line) => host.send(line),
			onEvent: (event, data) => this.coreEvent(event, data),
			timeoutMs: o.timeoutMs,
		});
		this.bootstrap = new Bootstrap({
			steps: (gen) => this.steps(gen),
			failed: (gen, _step, message) => {
				if (gen !== this.view.gen) return;
				this.view.failure = message;
				this.changed();
			},
		});
	}

	/** Listens first, then asks Rust where things are: events sent before that are not lost. */
	async start(): Promise<void> {
		const h = this.host;
		this.unlisten = await Promise.all([
			h.on("sidecar-line", (p) => this.client.receive(p.gen, p.line)),
			h.on("sidecar-stderr", (p) => this.stderr(p.gen, p.seq, p.line)),
			h.on("sidecar-exit", (p) => this.exited(p.gen, p.code)),
			h.on("sidecar-started", (p) => this.started(p.gen)),
			h.on("familiar-snapshot-request", () => this.sendSnapshot(true)),
			h.on("familiar-open", (p) => this.open(p.page)),
		]);
		this.changed();
		await this.sync();
	}

	/** Calls `fn` with each new view; returns the function that stops it. */
	watch(fn: (view: View) => void): () => void {
		this.watchers.add(fn);
		return () => this.watchers.delete(fn);
	}

	dispose(): void {
		for (const off of this.unlisten) off();
		this.unlisten = [];
	}

	/** Shows a page: the sidebar, or the tray panel through `familiar-open`. */
	open(page: Page): void {
		if (page === this.view.page) return;
		this.view.page = page;
		// A tab asked for once: the next visit opens on the brain that answers again.
		if (page !== "brain") this.view.brainTab = undefined;
		this.changed();
	}

	/**
	 * A request to the current core, for the pages. Each method waits as long as it may need
	 * (lib/timeouts.ts) unless `timeoutMs` says otherwise.
	 */
	call<T>(
		method: string,
		params?: Record<string, unknown>,
		timeoutMs?: number,
	): Promise<T> {
		return this.client.request<T>(
			method,
			params,
			timeoutMs ?? this.o.timeoutMs ?? timeoutFor(method),
		);
	}

	/** Asks the core for its status again, after a page changed something. */
	async refreshStatus(): Promise<void> {
		const gen = this.view.gen;
		const status = await this.client.request<Status>("status");
		if (gen !== this.view.gen || !status) return;
		this.view.status = status;
		this.changed();
	}

	/**
	 * Changes the settings: reads them, lets `change` make the new ones, saves them, one change
	 * after another. Two pages saving at once would otherwise each write what they read, and the
	 * later save would undo the earlier one. Rejects with the core's message.
	 */
	updateSettings(change: (settings: Settings) => Settings): Promise<Settings> {
		const next = this.settingsQueue.then(async () => {
			const gen = this.view.gen;
			const got = await this.client.request<SettingsReply>("settings.get");
			const saved = await this.client.request<SettingsReply>("settings.set", {
				settings: change(structuredClone(got?.settings ?? {})),
			});
			if (gen === this.view.gen) this.takeSettings(saved);
			return saved?.settings ?? {};
		});
		// A failed change does not stop the ones after it.
		this.settingsQueue = next.catch(() => {});
		return next;
	}

	/** The settings as the core has them now, also into `view`; waits for changes under way. */
	loadSettings(): Promise<Settings> {
		const next = this.settingsQueue.then(async () => {
			const gen = this.view.gen;
			const got = await this.client.request<SettingsReply>("settings.get");
			if (gen === this.view.gen) this.takeSettings(got);
			return got?.settings ?? {};
		});
		this.settingsQueue = next.catch(() => {});
		return next;
	}

	/** Keeps what a tab holds without changing the brain that answers. */
	async rememberBrain(choice: Choice): Promise<void> {
		await this.updateSettings((settings) => remember(settings, choice));
	}

	/**
	 * "Use this": the choice becomes the brain that answers, and Familiar runs with it; a run
	 * under way restarts, so the next question goes to the new brain. Says whether Familiar runs
	 * afterwards; if not, why. There is no way back to the old brain but choosing it again.
	 */
	async useBrain(choice: Choice): Promise<Outcome> {
		try {
			await this.updateSettings((settings) => applyChoice(settings, choice));
		} catch (error) {
			return { ok: false, problem: messageOf(error) };
		}
		// A start under way (such as the one after the setup assistant) began with the brain
		// before: wait for it, then restart so the saved brain is the one that answers.
		await this.starting?.catch(() => {});
		const outcome = this.view.status?.running
			? await this.restartFamiliar()
			: await this.startFamiliar();
		// It came up, but not with these settings yet: one restart more.
		if (outcome.ok && this.view.status?.restartNeeded)
			return this.restartFamiliar();
		return outcome;
	}

	/**
	 * "Test": one short question to `choice` without saving it. `ok` is true only for a real
	 * answer; `problem` is the core's words otherwise. Takes up to 95 s.
	 */
	async testBrain(choice: Choice): Promise<BrainTest> {
		const settings = applyChoice(await this.loadSettings(), choice);
		try {
			return await this.call<BrainTest>("brain.test", { settings });
		} catch (error) {
			return { ok: false, ms: 0, problem: messageOf(error), tools: [] };
		}
	}

	/** Stores an API key in the system keychain; the key goes nowhere else. */
	async setKey(provider: string, key: string): Promise<void> {
		await this.call("key.set", { provider, key });
		await this.loadSettings();
	}

	/** Removes the keychain's key; one in the file or the environment stays (`keySources`). */
	async deleteKey(provider: string): Promise<void> {
		await this.call("key.delete", { provider });
		await this.loadSettings();
	}

	/**
	 * Signs in with ChatGPT in the browser. One sign-in at a time: a page that asks again while
	 * one waits gets the same one. `view.chatgptUrl` holds the address meanwhile, in case the
	 * browser did not open. Resolves with the account, or rejects with the core's message.
	 */
	signInChatGpt(): Promise<{ account: string; usage: string }> {
		this.signingIn ??= this.call<{ account: string; usage: string }>(
			"chatgpt.signIn",
		).finally(() => {
			this.signingIn = undefined;
			this.view.chatgptUrl = undefined;
			this.changed();
		});
		return this.signingIn;
	}

	/** Opens the Brain page on one kind's tab, such as the one chosen in the setup assistant. */
	openBrain(kind: BrainKind): void {
		this.view.brainTab = kind;
		this.view.page = "brain";
		this.changed();
	}

	/**
	 * The setup assistant ran or was skipped: it does not open by itself again, and Familiar
	 * starts, which the first start left to the assistant. `then` is the page to show, or `tab`
	 * the Brain page's tab. Rejects with the core's message if the save fails, before leaving.
	 */
	async finishSetup(then: Page = "overview", tab?: BrainKind): Promise<void> {
		await this.updateSettings((settings) => ({
			...settings,
			app: { ...settings.app, setupDone: true },
		}));
		if (tab) this.openBrain(tab);
		else this.open(then);
		// In the background: the page is there already, and starting may take a minute.
		if (!this.view.status?.running) void this.startFamiliar();
	}

	/** The setup assistant runs: it says when Familiar starts (a new player). */
	get firstRun(): boolean {
		return this.view.settings?.app?.setupDone === false;
	}

	private takeSettings(got: SettingsReply | undefined): void {
		if (!got?.settings) return;
		this.view.settings = got.settings;
		this.view.keys = got.keys ?? {};
		this.view.keySources = got.keySources ?? {};
		// A language chosen in the settings applies at once, here and in the tray panel.
		this.view.language = resolveLanguage(
			got.settings.app?.language,
			this.o.systemLanguage,
		);
		this.changed();
	}

	/**
	 * Changes the app's own settings (`app.*`): saved like any other change, then what the shell
	 * does at once, the close button's behaviour. Familiar keeps running; none of them needs a
	 * restart. Rejects with the core's message.
	 */
	async updateApp(
		change: (app: NonNullable<Settings["app"]>) => NonNullable<Settings["app"]>,
	): Promise<void> {
		const saved = await this.updateSettings((settings) => ({
			...settings,
			app: change({ ...settings.app }),
		}));
		await this.host.setCloseMode(saved.app?.close === "quit" ? "quit" : "tray");
	}

	/** The desktop app's own version, from its build (the core's comes with hello). */
	appVersion(): Promise<string> {
		return this.host.version();
	}

	/** Whether the system starts Familiar now: its own entry, which may differ from the setting. */
	systemAutostart(): Promise<boolean> {
		return this.host.autostart();
	}

	/**
	 * Starting with the system: the system's entry first, then the setting, so the setting never
	 * says on while the system does not start Familiar. Rejects with the reason.
	 */
	async setAutostart(on: boolean): Promise<void> {
		await this.host.setAutostart(on);
		await this.updateApp((app) => ({ ...app, autostart: on }));
	}

	/** The folder dialog, titled in the page's language; `title` for another purpose. */
	pickFolder(title?: string): Promise<string | null> {
		return this.host.pickFolder(
			title ?? translator(this.view.language)("client.pickTitle"),
		);
	}

	/** The error state's button: a new core. */
	async restartCore(): Promise<void> {
		try {
			await this.host.restart();
		} catch (error) {
			this.view.failure = messageOf(error);
			this.changed();
			return;
		}
		// The `sidecar-started` event normally does this; the sticky state covers a missed one.
		await this.sync();
	}

	/** The banner's button: Familiar runs again with the saved settings. */
	restartFamiliar(): Promise<Outcome> {
		return this.run("restart");
	}

	/** Familiar runs again after it was stopped, such as by uninstalling the addon. */
	startFamiliar(): Promise<Outcome> {
		return this.run("start");
	}

	/** Also says how it went, for a page that waits for it. */
	private run(method: "start" | "restart"): Promise<Outcome> {
		const running = this.runOnce(method);
		this.starting = running;
		void running.finally(() => {
			if (this.starting === running) this.starting = undefined;
		});
		return running;
	}

	private async runOnce(method: "start" | "restart"): Promise<Outcome> {
		const gen = this.view.gen;
		try {
			const status = await this.client.request<Status>(
				method,
				undefined,
				this.o.startTimeoutMs ?? START_TIMEOUT_MS,
			);
			if (gen !== this.view.gen) return { ok: false, problem: STOPPED };
			this.view.status = status;
			// It runs now: what kept it from starting before is no longer the news.
			if (status?.running) this.view.failure = undefined;
			this.changed();
			return status?.running
				? { ok: true }
				: { ok: false, problem: this.view.failure ?? STOPPED };
		} catch (error) {
			if (gen !== this.view.gen) return { ok: false, problem: STOPPED };
			const problem = messageOf(error);
			this.view.failure = problem;
			this.changed();
			// A restart stops the old run before the new one fails: the status says so.
			await this.refreshStatus().catch(() => {});
			return { ok: false, problem };
		}
	}

	private async sync(): Promise<void> {
		let state: SidecarState;
		try {
			state = await this.host.state();
		} catch (error) {
			this.view.failure = messageOf(error);
			this.changed();
			return;
		}
		if (state.gen < this.view.gen) return;
		if (state.gen > this.view.gen) this.switchTo(state.gen);
		// Rust keeps the stderr of this core too, such as why it could not start at all, which
		// no event carries: take the lines the page has not heard yet, by their numbers.
		this.mergeStderr(state.stderrTail, state.stderrSeq);
		if (!state.running) {
			this.markExited(state.exitCode ?? null);
			return;
		}
		this.changed();
		// In the background: `start` may wait for the brain for up to a minute.
		void this.bootstrap.run(state.gen);
	}

	private started(gen: number): void {
		if (gen < this.view.gen) return;
		if (gen > this.view.gen) {
			this.switchTo(gen);
			this.changed();
		} else if (this.view.exited) return;
		void this.bootstrap.run(gen);
	}

	private exited(gen: number, code: number | null): void {
		if (gen < this.view.gen) return;
		if (gen > this.view.gen) this.switchTo(gen);
		this.markExited(code);
	}

	private markExited(code: number | null): void {
		this.view.exited = true;
		this.view.exitCode = code;
		this.client.stopped(this.view.gen, STOPPED);
		this.changed();
	}

	/**
	 * Lines of the sticky tail the page has not had: their numbers run up to `seq`. A snapshot
	 * older than the events already heard adds nothing, and equal lines never get mixed up.
	 */
	private mergeStderr(sticky: readonly string[], seq: number): void {
		const first = seq - sticky.length + 1;
		const fresh = sticky.filter((_, i) => first + i > this.view.stderrSeq);
		if (fresh.length === 0) return;
		this.view.stderrTail = [...this.view.stderrTail, ...fresh].slice(
			-KEEP_STDERR,
		);
		this.view.stderrSeq = seq;
	}

	private stderr(gen: number, seq: number, line: string): void {
		if (gen !== this.view.gen || seq <= this.view.stderrSeq) return;
		this.view.stderrTail = [...this.view.stderrTail, line].slice(-KEEP_STDERR);
		this.view.stderrSeq = seq;
		this.changed();
	}

	/** A newer core: forget everything the old one said, keep the language until settings come. */
	private switchTo(gen: number): void {
		this.client.useGen(gen);
		this.arriving = undefined;
		this.view = {
			...emptyView(this.view.language),
			gen,
			version: this.view.version,
			page: this.view.page,
			// Kept until the new core's settings.get answers, so an open page does not blank out.
			...(this.view.settings ? { settings: this.view.settings } : {}),
			keys: this.view.keys,
			keySources: this.view.keySources,
			...(this.view.brainTab ? { brainTab: this.view.brainTab } : {}),
		};
	}

	private steps(gen: number): Step[] {
		const ask = async <T>(
			method: string,
			timeoutMs?: number,
			params?: Record<string, unknown>,
		): Promise<T | undefined> => {
			const result = await this.client.request<T>(method, params, timeoutMs);
			if (gen !== this.view.gen) throw new Abandoned();
			return result ?? undefined;
		};
		return [
			{
				name: "hello",
				run: async () => {
					const hello = await ask<{ version?: unknown }>("hello");
					if (typeof hello?.version === "string")
						this.view.version = hello.version;
					this.changed();
				},
			},
			{
				name: "settings.get",
				run: async () => {
					const got = await ask<SettingsReply>("settings.get");
					const app = got?.settings?.app;
					this.view.language = resolveLanguage(
						app?.language,
						this.o.systemLanguage,
					);
					this.takeSettings(got);
					// A new player (setupDone false, which only a new settings file has): the setup
					// assistant opens, once per app start, until it ran or was skipped.
					if (app?.setupDone === false && !this.setupShown) {
						this.setupShown = true;
						this.view.page = "setup";
					}
					this.changed();
					await this.host.setCloseMode(app?.close === "quit" ? "quit" : "tray");
					// The autostart entry is left as it is: the player may have switched it off in
					// the system (Windows' Startup apps). The Settings page shows a difference.
				},
			},
			{
				name: "status",
				run: async () => {
					const status = await ask<Status>("status");
					if (status) this.view.status = status;
					this.changed();
				},
			},
			{
				name: "logs.recent",
				run: async () => {
					this.arriving = [];
					try {
						const lines = await ask<unknown[]>("logs.recent", undefined, {
							limit: RECENT,
						});
						this.loadLog(Array.isArray(lines) ? lines : []);
					} finally {
						this.arriving = undefined;
					}
				},
			},
			{
				name: "start",
				run: async () => {
					// A new player: the setup assistant installs the addon and starts Familiar.
					if (this.firstRun) return;
					const status = await ask<Status>(
						"start",
						this.o.startTimeoutMs ?? START_TIMEOUT_MS,
					);
					if (status) this.view.status = status;
					this.changed();
				},
			},
		];
	}

	/** The recent log replaces what the page had; lines that came while it was asked for stay. */
	private loadLog(lines: unknown[]): void {
		const all = lines.filter(isLine);
		const seen = new Set(all.map((line) => JSON.stringify(line)));
		for (const line of this.arriving ?? [])
			if (!seen.has(JSON.stringify(line))) all.push(line);
		this.view.lines = all.slice(-KEEP_LINES);
		this.view.log = all.filter(isQuestionLine).slice(-KEEP_LOG);
		this.changed();
	}

	private coreEvent(event: string, data: unknown): void {
		if (event === "status" && data && typeof data === "object") {
			this.view.status = data as Status;
			this.changed();
		} else if (event === "log" && isLine(data)) {
			this.arriving?.push(data);
			this.view.lines = [...this.view.lines, data].slice(-KEEP_LINES);
			if (isQuestionLine(data))
				this.view.log = [...this.view.log, data].slice(-KEEP_LOG);
			this.changed();
		} else if (event === "chatgpt-url" && data && typeof data === "object") {
			// The sign-in's address, shown in case the browser did not open.
			const url = (data as { url?: unknown }).url;
			if (typeof url === "string" && /^https:\/\//.test(url)) {
				this.view.chatgptUrl = url;
				this.changed();
			}
		}
	}

	/** After every change: a new view object for the page, then the tray icon and the panel. */
	private changed(): void {
		this.view = { ...this.view };
		for (const fn of this.watchers) fn(this.view);
		const tray = trayUpdate(this.view);
		const key = JSON.stringify(tray);
		if (key !== this.lastTray) {
			this.lastTray = key;
			this.host.trayUpdate(tray).catch(() => {
				// Try again with the next change.
				this.lastTray = undefined;
			});
		}
		this.sendSnapshot(false);
	}

	private sendSnapshot(always: boolean): void {
		const snap = snapshot(this.view);
		const key = JSON.stringify(snap);
		if (!always && key === this.lastSnapshot) return;
		this.lastSnapshot = key;
		this.host.emit("familiar-snapshot", snap).catch(() => {});
	}
}

function isLine(line: unknown): line is Record<string, unknown> {
	return !!line && typeof line === "object" && !Array.isArray(line);
}
