// The main window's logic: it owns the connection to the core, follows the core's generations,
// runs the bootstrap, and tells the tray icon and the tray panel what to show. App.svelte only
// renders `view`.
import { Bootstrap, type Step } from "./bootstrap.ts";
import { CoreClient, STOPPED } from "./client.ts";
import { resolveLanguage } from "./i18n.ts";
import { emptyView, snapshot, trayUpdate, type View } from "./overview.ts";
import { isQuestionLine } from "./questions.ts";
import {
	type Host,
	messageOf,
	type SidecarState,
	type Status,
} from "./types.ts";

/** `start` waits for the brain to come up, which can take a while. */
export const START_TIMEOUT_MS = 60_000;
/** Question lines kept for the overview; it shows 8. */
const KEEP_LOG = 200;
/** Rust keeps the same number of stderr lines. */
const KEEP_STDERR = 20;

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
			h.on("sidecar-stderr", (p) => this.stderr(p.gen, p.line)),
			h.on("sidecar-exit", (p) => this.exited(p.gen, p.code)),
			h.on("sidecar-started", (p) => this.started(p.gen)),
			h.on("familiar-snapshot-request", () => this.sendSnapshot(true)),
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
	async restartFamiliar(): Promise<void> {
		const gen = this.view.gen;
		try {
			const status = await this.client.request<Status>(
				"restart",
				undefined,
				this.o.startTimeoutMs ?? START_TIMEOUT_MS,
			);
			if (gen !== this.view.gen) return;
			this.view.status = status;
		} catch (error) {
			if (gen !== this.view.gen) return;
			this.view.failure = messageOf(error);
		}
		this.changed();
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
		if (state.gen > this.view.gen) this.switchTo(state.gen, state.stderrTail);
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
			this.switchTo(gen, []);
			this.changed();
		} else if (this.view.exited) return;
		void this.bootstrap.run(gen);
	}

	private exited(gen: number, code: number | null): void {
		if (gen < this.view.gen) return;
		if (gen > this.view.gen) this.switchTo(gen, []);
		this.markExited(code);
	}

	private markExited(code: number | null): void {
		this.view.exited = true;
		this.view.exitCode = code;
		this.client.stopped(this.view.gen, STOPPED);
		this.changed();
	}

	private stderr(gen: number, line: string): void {
		if (gen !== this.view.gen) return;
		const tail = [...this.view.stderrTail, line].slice(-KEEP_STDERR);
		this.view.stderrTail = tail;
		this.changed();
	}

	/** A newer core: forget everything the old one said, keep the language until settings come. */
	private switchTo(gen: number, stderrTail: string[]): void {
		this.client.useGen(gen);
		this.arriving = undefined;
		this.view = {
			...emptyView(this.view.language),
			gen,
			version: this.view.version,
			stderrTail: stderrTail.slice(-KEEP_STDERR),
		};
	}

	private steps(gen: number): Step[] {
		const ask = async <T>(
			method: string,
			timeoutMs?: number,
		): Promise<T | undefined> => {
			const result = await this.client.request<T>(method, undefined, timeoutMs);
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
					const got = await ask<{
						settings?: { app?: { language?: unknown; close?: unknown } };
					}>("settings.get");
					const app = got?.settings?.app;
					this.view.language = resolveLanguage(
						app?.language,
						this.o.systemLanguage,
					);
					this.changed();
					await this.host.setCloseMode(app?.close === "quit" ? "quit" : "tray");
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
						const lines = await ask<unknown[]>("logs.recent");
						this.loadLog(Array.isArray(lines) ? lines : []);
					} finally {
						this.arriving = undefined;
					}
				},
			},
			{
				name: "start",
				run: async () => {
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
		const log = lines.filter(isQuestionLine);
		const seen = new Set(log.map((line) => JSON.stringify(line)));
		for (const line of this.arriving ?? [])
			if (!seen.has(JSON.stringify(line))) log.push(line);
		this.view.log = log.slice(-KEEP_LOG);
		this.changed();
	}

	private coreEvent(event: string, data: unknown): void {
		if (event === "status" && data && typeof data === "object") {
			this.view.status = data as Status;
			this.changed();
		} else if (event === "log" && isQuestionLine(data)) {
			this.arriving?.push(data);
			this.view.log = [...this.view.log, data].slice(-KEEP_LOG);
			this.changed();
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
