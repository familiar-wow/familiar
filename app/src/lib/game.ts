// The Game page: which WoW Forever clients the core finds, which one Familiar uses, and the
// addon in it. `presentGame` is pure; `GameController` runs the calls behind the buttons, one at
// a time, with the core and the dialog passed in, so both are tested without either.
import type { Translate } from "./i18n.ts";
import type { View } from "./overview.ts";
import { detail, detailText } from "./status.ts";
import { type GameClient, messageOf } from "./types.ts";

export type Busy = "find" | "save" | "repair" | "uninstall";

export type Outcome =
	| {
			kind: "repaired";
			/** The addon was not there before: an install, not a repair. */
			fresh: boolean;
			added: number;
			updated: number;
			removed: number;
			wowRunning: boolean;
	  }
	| { kind: "removed" }
	| { kind: "failed"; message: string };

export interface GameState {
	clients: GameClient[];
	/** `game.client` from the settings; undefined while Familiar chooses by itself. */
	configured?: string;
	/** The first `game.find` came back, so an empty list means nothing was found. */
	loaded: boolean;
	busy?: Busy;
	/** Why searching, checking a chosen folder or saving the choice failed, as the core said. */
	findError?: string;
	/** The page asks before it uninstalls. */
	confirming: boolean;
	/** The last addon action's result, shown under its buttons. */
	outcome?: Outcome;
}

export interface GameRow {
	client: string;
	version?: string;
	inUse: boolean;
}

export type AddonTone = "good" | "warn" | "off";

export interface GamePage {
	rows: GameRow[];
	empty: boolean;
	findError?: string;
	/** The client the addon card is about. */
	client?: string;
	addon: {
		status: string;
		tone: AddonTone;
		connection: string;
		wowRunning: string;
		/** After a repair that changed files while WoW runs: how the game picks them up. */
		hint?: string;
	};
	outcome?: { text: string; error: boolean };
	busy?: Busy;
	confirming: boolean;
}

/** Windows paths ignore case and either slash; a trailing slash changes nothing anywhere. */
export function samePath(
	a: string | undefined,
	b: string | undefined,
): boolean {
	if (!a || !b) return false;
	const norm = (p: string) => {
		const windows = /^[a-z]:/i.test(p) || p.includes("\\");
		const out = p.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
		return windows ? out.toLowerCase() : out;
	};
	return norm(a) === norm(b);
}

/** The client in use: the one the settings name, else the one the core picked by itself. */
export function clientInUse(
	configured: string | undefined,
	statusClient: string | undefined,
): string | undefined {
	return configured ?? statusClient;
}

/** `game.client` from a `settings.get` result, if the player chose one. */
export function configuredClient(settings: unknown): string | undefined {
	const game = (settings as { game?: { client?: unknown } } | undefined)?.game;
	return typeof game?.client === "string" && game.client !== ""
		? game.client
		: undefined;
}

/**
 * The settings to send back with another client: `settings.set` takes the whole object, so
 * everything else goes back as `settings.get` gave it.
 */
export function withClient(
	settings: Record<string, unknown>,
	client: string,
): Record<string, unknown> {
	const next = structuredClone(settings);
	const game =
		next.game && typeof next.game === "object"
			? (next.game as Record<string, unknown>)
			: {};
	next.game = { ...game, client };
	return next;
}

/** "Installed, version 0.15.0 · up to date", measured against the core's own version. */
export function addonStatus(
	client: GameClient | undefined,
	installed: boolean,
	coreVersion: string | undefined,
	t: Translate,
): { text: string; tone: AddonTone } {
	if (!(client?.installed ?? installed))
		return { text: t("addon.notInstalled"), tone: "off" };
	const version = client?.addonVersion;
	if (!version) return { text: t("addon.installed"), tone: "good" };
	const text = t("addon.version", { version });
	if (coreVersion !== undefined && version === coreVersion)
		return { text: `${text} · ${t("addon.upToDate")}`, tone: "good" };
	return { text: `${text} · ${t("addon.willUpdate")}`, tone: "warn" };
}

export function outcomeText(
	outcome: Outcome,
	t: Translate,
): { text: string; error: boolean } {
	if (outcome.kind === "failed") return { text: outcome.message, error: true };
	if (outcome.kind === "removed")
		return { text: t("addon.removed"), error: false };
	if (outcome.fresh) return { text: t("addon.installedNow"), error: false };
	const n = outcome.added + outcome.updated + outcome.removed;
	return {
		text: n > 0 ? t("addon.repaired", { n }) : t("addon.complete"),
		error: false,
	};
}

export function presentGame(
	state: GameState,
	view: View,
	t: Translate,
): GamePage {
	const used = clientInUse(state.configured, view.status?.client);
	const rows = state.clients.map((c) => ({
		client: c.client,
		version: c.version,
		inUse: samePath(c.client, used),
	}));
	const client = state.clients.find((c) => samePath(c.client, used));
	const running = view.status?.game.running === true;
	const status = addonStatus(
		client,
		used !== undefined &&
			samePath(view.status?.client, used) &&
			view.status?.addon.installed === true,
		view.version,
		t,
	);
	const o = state.outcome;
	let hint: string | undefined;
	if (running && o?.kind === "repaired" && o.added + o.updated > 0)
		// New files need a fresh start of WoW; changed ones only a reload.
		hint = o.added > 0 ? t("addon.restartWow") : t("addon.reload");
	const page: GamePage = {
		rows,
		empty: state.loaded && rows.length === 0,
		addon: {
			status: status.text,
			tone: status.tone,
			connection: detailText(detail(view), t),
			wowRunning: running ? t("addon.yes") : t("addon.no"),
		},
		confirming: state.confirming,
	};
	if (used) page.client = used;
	if (hint) page.addon.hint = hint;
	if (state.findError) page.findError = state.findError;
	if (o) page.outcome = outcomeText(o, t);
	if (state.busy) page.busy = state.busy;
	return page;
}

/** Installing writes thousands of small files: about 15 s on a Windows runner, more on a slow disk. */
export const INSTALL_TIMEOUT_MS = 120_000;

export interface GameDeps {
	call<T>(
		method: string,
		params?: Record<string, unknown>,
		timeoutMs?: number,
	): Promise<T>;
	/** The folder dialog; null when the player cancels. */
	pickFolder(): Promise<string | null>;
	/** Asks the core for its status again, which the overview and this page share. */
	refreshStatus(): Promise<void>;
	/** The client the core uses when the settings name none. */
	statusClient(): string | undefined;
	/** Whether Familiar carries questions right now. */
	running(): boolean;
	/** Starts Familiar with the saved settings, as when the app starts. */
	start(): Promise<void>;
}

export class GameController {
	state: GameState = { clients: [], loaded: false, confirming: false };
	private readonly watchers = new Set<(state: GameState) => void>();

	constructor(private readonly deps: GameDeps) {}

	watch(fn: (state: GameState) => void): () => void {
		this.watchers.add(fn);
		return () => this.watchers.delete(fn);
	}

	/** When the page opens, and "Search again". */
	load(): Promise<void> {
		return this.run("find", async () => {
			this.set({ findError: undefined });
			await this.find();
		});
	}

	/** A row was clicked: that client from now on. */
	select(client: string): Promise<void> {
		if (samePath(client, this.inUse())) return Promise.resolve();
		return this.run("save", async () => {
			this.set({ findError: undefined, outcome: undefined });
			await this.save(client);
		});
	}

	/** "Choose folder…": the dialog, then the core checks the folder, then it is saved. */
	choose(): Promise<void> {
		return this.run("save", async () => {
			this.set({ findError: undefined, outcome: undefined });
			const path = await this.deps.pickFolder();
			if (!path) return;
			let checked: GameClient;
			try {
				checked = await this.deps.call<GameClient>("game.check", { path });
			} catch (error) {
				this.set({ findError: messageOf(error) });
				return;
			}
			await this.save(checked.client);
		});
	}

	repair(): Promise<void> {
		return this.run("repair", async () => {
			this.set({ outcome: undefined, confirming: false });
			const used = this.inUse();
			const before = this.state.clients.find((c) => samePath(c.client, used));
			try {
				const r = await this.deps.call<Record<string, unknown>>(
					"addon.install",
					this.target(),
					INSTALL_TIMEOUT_MS,
				);
				const count = (v: unknown) => (typeof v === "number" ? v : 0);
				this.set({
					outcome: {
						kind: "repaired",
						fresh: before?.installed === false,
						added: count(r?.added),
						updated: count(r?.updated),
						removed: count(r?.removed),
						wowRunning: r?.wowRunning === true,
					},
				});
			} catch (error) {
				this.set({ outcome: { kind: "failed", message: messageOf(error) } });
				await this.after();
				return;
			}
			// Uninstalling stopped Familiar; with the addon back, it carries questions again.
			if (!this.deps.running()) await this.deps.start().catch(() => {});
			await this.after();
		});
	}

	askUninstall(): void {
		if (this.state.busy) return;
		this.set({ confirming: true, outcome: undefined });
	}

	cancelUninstall(): void {
		this.set({ confirming: false });
	}

	uninstall(): Promise<void> {
		return this.run("uninstall", async () => {
			this.set({ confirming: false, outcome: undefined });
			try {
				await this.deps.call(
					"addon.uninstall",
					this.target(),
					INSTALL_TIMEOUT_MS,
				);
				this.set({ outcome: { kind: "removed" } });
			} catch (error) {
				this.set({ outcome: { kind: "failed", message: messageOf(error) } });
			}
			await this.after();
		});
	}

	private inUse(): string | undefined {
		return clientInUse(this.state.configured, this.deps.statusClient());
	}

	private target(): Record<string, unknown> | undefined {
		const client = this.inUse();
		return client ? { client } : undefined;
	}

	/** The settings round trip: only `game.client` changes. */
	private async save(client: string): Promise<void> {
		try {
			const got = await this.deps.call<{ settings?: Record<string, unknown> }>(
				"settings.get",
			);
			await this.deps.call("settings.set", {
				settings: withClient(got?.settings ?? {}, client),
			});
		} catch (error) {
			this.set({ findError: messageOf(error) });
		}
		await this.after();
	}

	/** After any change: the clients and the status again. */
	private async after(): Promise<void> {
		await this.deps.refreshStatus().catch(() => {});
		await this.find();
	}

	private async find(): Promise<void> {
		try {
			const [found, got] = await Promise.all([
				this.deps.call<unknown>("game.find"),
				this.deps.call<{ settings?: unknown }>("settings.get"),
			]);
			const configured = configuredClient(got?.settings);
			let clients = Array.isArray(found) ? (found as GameClient[]) : [];
			// A folder the player chose is not always where the search looks: ask for it alone.
			const used = clientInUse(configured, this.deps.statusClient());
			if (used && !clients.some((c) => samePath(c.client, used))) {
				const one = await this.deps
					.call<GameClient>("game.check", { path: used })
					.catch(() => undefined);
				if (one) clients = [...clients, one];
			}
			this.set({ clients, configured, loaded: true });
		} catch (error) {
			this.set({ findError: messageOf(error), loaded: true });
		}
	}

	private async run(busy: Busy, action: () => Promise<void>): Promise<void> {
		if (this.state.busy) return;
		this.set({ busy });
		try {
			await action();
		} finally {
			this.set({ busy: undefined });
		}
	}

	private set(change: Partial<GameState>): void {
		const next = { ...this.state, ...change };
		for (const key of Object.keys(change) as (keyof GameState)[])
			if (change[key] === undefined) delete next[key];
		this.state = next;
		for (const fn of this.watchers) fn(this.state);
	}
}
