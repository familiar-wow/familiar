import { expect, test } from "bun:test";
import {
	addonStatus,
	clientInUse,
	configuredClient,
	GameController,
	type GameDeps,
	type GameState,
	INSTALL_TIMEOUT_MS,
	outcomeText,
	presentGame,
	samePath,
	withClient,
} from "./game.ts";
import { translator } from "./i18n.ts";
import { emptyView, type View } from "./overview.ts";
import type { GameClient, Status } from "./types.ts";

const t = translator("en");
const MAIN = "C:\\Program Files (x86)\\World of Warcraft\\_forever_";
const OTHER = "D:\\Games\\World of Warcraft\\_forever_";
const tick = () => new Promise((r) => setTimeout(r, 0));

function status(over: Partial<Status> = {}): Status {
	return {
		running: true,
		client: MAIN,
		addon: { installed: true },
		game: { running: false },
		brain: { kind: "agent", command: ["hermes", "acp"] },
		problems: [],
		...over,
	};
}

const view = (over: Partial<View> = {}): View => ({
	...emptyView("en"),
	gen: 1,
	version: "0.15.0",
	status: status(),
	...over,
});

const main: GameClient = {
	client: MAIN,
	version: "1.60.1",
	interface: 16001,
	installed: true,
	addonVersion: "0.15.0",
};
const other: GameClient = {
	client: OTHER,
	version: "1.60.1",
	installed: false,
};

const state = (over: Partial<GameState> = {}): GameState => ({
	clients: [main, other],
	loaded: true,
	confirming: false,
	...over,
});

test("paths compare as the system does", () => {
	expect(samePath("C:\\WoW\\_forever_", "c:/wow/_forever_/")).toBe(true);
	expect(samePath("/home/me/WoW/_forever_", "/home/me/wow/_forever_")).toBe(
		false,
	);
	expect(samePath("/a/b/", "/a/b")).toBe(true);
	expect(samePath(undefined, "/a")).toBe(false);
});

test("in use: the settings' client, else the one the core picked", () => {
	expect(clientInUse(OTHER, MAIN)).toBe(OTHER);
	expect(clientInUse(undefined, MAIN)).toBe(MAIN);
	expect(clientInUse(undefined, undefined)).toBeUndefined();
	const rows = (s: GameState, v: View) =>
		presentGame(s, v, t).rows.map((r) => r.inUse);
	expect(rows(state(), view())).toEqual([true, false]);
	expect(rows(state({ configured: OTHER }), view())).toEqual([false, true]);
	expect(
		rows(state(), view({ status: status({ client: undefined }) })),
	).toEqual([false, false]);
});

test("configured client from settings.get", () => {
	expect(configuredClient({ game: { client: OTHER } })).toBe(OTHER);
	expect(configuredClient({ game: {} })).toBeUndefined();
	expect(configuredClient({ game: { client: "" } })).toBeUndefined();
	expect(configuredClient(undefined)).toBeUndefined();
});

test("the settings round trip changes game.client only", () => {
	const got = {
		app: { language: "de", close: "tray" },
		game: { client: MAIN },
		brain: { use: "agent", command: ["hermes", "acp"] },
		mcp: { port: 27495 },
	};
	const next = withClient(got, OTHER);
	expect(next).toEqual({ ...got, game: { client: OTHER } });
	// The object from settings.get is left alone.
	expect(got.game.client).toBe(MAIN);
	expect(withClient({ app: {} }, OTHER)).toEqual({
		app: {},
		game: { client: OTHER },
	});
});

test("the addon status line", () => {
	expect(addonStatus(main, true, "0.15.0", t)).toEqual({
		text: "Installed, version 0.15.0 · up to date",
		tone: "good",
	});
	expect(
		addonStatus({ ...main, addonVersion: "0.14.0" }, true, "0.15.0", t),
	).toEqual({
		text: "Installed, version 0.14.0 · will be updated when Familiar starts",
		tone: "warn",
	});
	expect(addonStatus(other, true, "0.15.0", t)).toEqual({
		text: "Not installed",
		tone: "off",
	});
	// Not in the list yet: the status says whether it is there.
	expect(addonStatus(undefined, true, "0.15.0", t).text).toBe("Installed");
	expect(addonStatus(undefined, false, "0.15.0", t).text).toBe("Not installed");
	expect(
		addonStatus({ ...main, addonVersion: undefined }, true, "0.15.0", t).text,
	).toBe("Installed");
});

test("the addon card follows the client in use and the overview's detail line", () => {
	const p = presentGame(
		state({ configured: OTHER }),
		view({ status: status({ game: { running: true } }) }),
		t,
	);
	expect(p.client).toBe(OTHER);
	expect(p.addon.status).toBe("Not installed");
	expect(p.addon.connection).toBe(
		"WoW runs. Type /reload in game if Familiar does not answer.",
	);
	expect(p.addon.wowRunning).toBe("yes");
	expect(p.addon.hint).toBeUndefined();
	const none = presentGame(
		state({ clients: [] }),
		view({ status: status({ client: undefined }) }),
		t,
	);
	expect(none.empty).toBe(true);
	expect(none.client).toBeUndefined();
	expect(none.addon.connection).toBe("No WoW Forever found.");
	expect(
		presentGame(state({ clients: [], loaded: false }), view(), t).empty,
	).toBe(false);
});

test("after a repair while WoW runs: reload for changed files, a restart for new ones", () => {
	const running = view({
		status: status({ game: { running: true, hello: "Familiar 0.15.0" } }),
	});
	const repaired = (added: number, updated: number) =>
		state({
			outcome: {
				kind: "repaired",
				fresh: false,
				added,
				updated,
				removed: 0,
				wowRunning: true,
			},
		});
	expect(presentGame(repaired(0, 3), running, t).addon.hint).toBe(
		"Type /reload in game.",
	);
	expect(presentGame(repaired(257, 0), running, t).addon.hint).toBe(
		"Quit WoW completely and start it again; /reload does not find new files.",
	);
	expect(presentGame(repaired(0, 0), running, t).addon.hint).toBeUndefined();
	expect(presentGame(repaired(0, 3), view(), t).addon.hint).toBeUndefined();
});

test("results and errors as one line, errors as the core wrote them", () => {
	const r = (added: number, updated: number, removed: number) =>
		outcomeText(
			{
				kind: "repaired",
				fresh: false,
				added,
				updated,
				removed,
				wowRunning: false,
			},
			t,
		);
	expect(r(0, 3, 1)).toEqual({
		text: "Addon repaired: 4 files changed.",
		error: false,
	});
	expect(r(0, 0, 0).text).toBe("Nothing to repair: the addon is complete.");
	expect(
		outcomeText(
			{
				kind: "repaired",
				fresh: true,
				added: 257,
				updated: 0,
				removed: 0,
				wowRunning: true,
			},
			t,
		).text,
	).toBe("Addon installed.");
	expect(outcomeText({ kind: "removed" }, t).text).toBe(
		"Addon and helpers removed.",
	);
	expect(
		outcomeText(
			{
				kind: "failed",
				message:
					"Close WoW first, so it does not write the helpers' rows back.",
			},
			t,
		),
	).toEqual({
		text: "Close WoW first, so it does not write the helpers' rows back.",
		error: true,
	});
});

/** A core that answers by method, and what the controller asked. */
function fakeDeps(over: Partial<GameDeps> = {}) {
	const calls: { method: string; params?: Record<string, unknown> }[] = [];
	let saved: Record<string, unknown> = {
		app: { language: "en" },
		game: {},
		brain: { use: "agent" },
	};
	const replies: Record<string, (p?: Record<string, unknown>) => unknown> = {
		"game.find": () => [main, other],
		"settings.get": () => ({ settings: structuredClone(saved) }),
		"settings.set": (p) => {
			saved = p?.settings as Record<string, unknown>;
			return { settings: saved };
		},
		"game.check": (p) => {
			const path = String(p?.path);
			if (path.includes("_ptr_"))
				throw new Error(
					"This is a test realm. Familiar works with the normal WoW Forever client in the _forever_ folder.",
				);
			if (!path.includes("World of Warcraft"))
				throw new Error("This is not a WoW Forever folder.");
			return {
				client: `${path.replace(/\\_forever_$/, "")}\\_forever_`,
				installed: false,
			};
		},
		"addon.install": () => ({
			added: 0,
			updated: 3,
			removed: 0,
			wowRunning: true,
		}),
		"addon.uninstall": () => ({ folders: 257, rows: 3 }),
	};
	let refreshed = 0;
	let started = 0;
	const timeouts: Record<string, number> = {};
	const deps: GameDeps = {
		call: async <T>(
			method: string,
			params?: Record<string, unknown>,
			timeoutMs?: number,
		) => {
			calls.push(params ? { method, params } : { method });
			if (timeoutMs !== undefined) timeouts[method] = timeoutMs;
			await tick();
			const reply = replies[method];
			if (!reply) throw new Error(`Unknown ${method}`);
			return reply(params) as T;
		},
		pickFolder: async () => "E:\\World of Warcraft",
		refreshStatus: async () => {
			refreshed++;
		},
		statusClient: () => MAIN,
		running: () => true,
		start: async () => {
			started++;
		},
		...over,
	};
	return {
		deps,
		calls,
		replies,
		saved: () => saved,
		refreshed: () => refreshed,
		started: () => started,
		timeouts,
	};
}

test("loading finds the clients and the configured one", async () => {
	const f = fakeDeps();
	f.replies["settings.get"] = () => ({ settings: { game: { client: OTHER } } });
	const g = new GameController(f.deps);
	const busy: (string | undefined)[] = [];
	g.watch((s) => busy.push(s.busy));
	await g.load();
	expect(g.state.clients).toEqual([main, other]);
	expect(g.state.configured).toBe(OTHER);
	expect(g.state.loaded).toBe(true);
	expect(busy[0]).toBe("find");
	expect(g.state.busy).toBeUndefined();
});

test("a chosen client the search does not find is checked and listed", async () => {
	const f = fakeDeps();
	const chosen = "E:\\World of Warcraft\\_forever_";
	f.replies["settings.get"] = () => ({
		settings: { game: { client: chosen } },
	});
	const g = new GameController(f.deps);
	await g.load();
	expect(g.state.clients.map((c) => c.client)).toEqual([MAIN, OTHER, chosen]);
	expect(f.calls.at(-1)).toEqual({
		method: "game.check",
		params: { path: chosen },
	});
});

test("selecting a row saves it as game.client, then asks again", async () => {
	const f = fakeDeps();
	const g = new GameController(f.deps);
	await g.load();
	f.calls.length = 0;
	await g.select(OTHER);
	expect(f.calls.map((c) => c.method)).toEqual([
		"settings.get",
		"settings.set",
		"game.find",
		"settings.get",
	]);
	expect(f.saved()).toEqual({
		app: { language: "en" },
		game: { client: OTHER },
		brain: { use: "agent" },
	});
	expect(f.refreshed()).toBe(1);
	expect(g.state.configured).toBe(OTHER);
	// The row in use again: nothing to do.
	f.calls.length = 0;
	await g.select(OTHER.toLowerCase());
	expect(f.calls).toEqual([]);
});

test("choose folder: dialog, check, save; a check error is shown as it is", async () => {
	const f = fakeDeps();
	const g = new GameController(f.deps);
	await g.choose();
	expect(f.calls.slice(0, 3).map((c) => c.method)).toEqual([
		"game.check",
		"settings.get",
		"settings.set",
	]);
	expect(f.saved().game).toEqual({
		client: "E:\\World of Warcraft\\_forever_",
	});

	const ptr = fakeDeps({
		pickFolder: async () => "C:\\World of Warcraft\\_ptr_",
	});
	const h = new GameController(ptr.deps);
	await h.choose();
	expect(h.state.findError).toBe(
		"This is a test realm. Familiar works with the normal WoW Forever client in the _forever_ folder.",
	);
	expect(ptr.calls.map((c) => c.method)).toEqual(["game.check"]);

	const cancel = fakeDeps({ pickFolder: async () => null });
	const k = new GameController(cancel.deps);
	await k.choose();
	expect(cancel.calls).toEqual([]);
	expect(k.state.busy).toBeUndefined();
});

test("repair installs into the client in use and refreshes", async () => {
	const f = fakeDeps();
	const g = new GameController(f.deps);
	await g.repair();
	expect(f.calls[0]).toEqual({
		method: "addon.install",
		params: { client: MAIN },
	});
	expect(g.state.outcome).toEqual({
		kind: "repaired",
		fresh: false,
		added: 0,
		updated: 3,
		removed: 0,
		wowRunning: true,
	});
	expect(f.refreshed()).toBe(1);
	expect(f.calls.map((c) => c.method)).toContain("game.find");
});

test("installing the addon again after an uninstall starts Familiar again", async () => {
	let running = false;
	const f = fakeDeps({ running: () => running });
	const g = new GameController(f.deps);
	await g.repair();
	expect(f.started()).toBe(1);
	// Thousands of files: far longer than an ordinary request may take.
	expect(f.timeouts["addon.install"]).toBe(INSTALL_TIMEOUT_MS);
	expect(INSTALL_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
	// While it runs, a repair leaves it alone, and a failed install starts nothing.
	running = true;
	await g.repair();
	expect(f.started()).toBe(1);
	running = false;
	f.replies["addon.install"] = () => {
		throw new Error("Close WoW first.");
	};
	await g.repair();
	expect(f.started()).toBe(1);
});

test("installing into a client without the addon is called an install", async () => {
	const f = fakeDeps({ statusClient: () => OTHER });
	f.replies["addon.install"] = () => ({
		added: 257,
		updated: 0,
		removed: 0,
		wowRunning: false,
	});
	const g = new GameController(f.deps);
	await g.load();
	await g.repair();
	expect(f.calls.find((c) => c.method === "addon.install")?.params).toEqual({
		client: OTHER,
	});
	expect(g.state.outcome).toMatchObject({ kind: "repaired", fresh: true });
	expect(presentGame(g.state, view(), t).outcome?.text).toBe(
		"Addon installed.",
	);
});

test("uninstall asks first; an error comes back as one line", async () => {
	const f = fakeDeps();
	const g = new GameController(f.deps);
	g.askUninstall();
	expect(g.state.confirming).toBe(true);
	g.cancelUninstall();
	expect(g.state.confirming).toBe(false);
	expect(f.calls).toEqual([]);
	g.askUninstall();
	await g.uninstall();
	expect(g.state.confirming).toBe(false);
	expect(f.calls[0]).toEqual({
		method: "addon.uninstall",
		params: { client: MAIN },
	});
	expect(g.state.outcome).toEqual({ kind: "removed" });

	f.replies["addon.uninstall"] = () => {
		throw new Error(
			"Close WoW first, so it does not write the helpers' rows back.",
		);
	};
	await g.uninstall();
	expect(g.state.outcome).toEqual({
		kind: "failed",
		message: "Close WoW first, so it does not write the helpers' rows back.",
	});
});

test("one action at a time", async () => {
	const f = fakeDeps();
	const g = new GameController(f.deps);
	const first = g.repair();
	const second = g.load();
	await Promise.all([first, second]);
	expect(f.calls.filter((c) => c.method === "addon.install")).toHaveLength(1);
	// The load was refused while the repair ran; the repair's own refresh asked once.
	expect(f.calls.filter((c) => c.method === "game.find")).toHaveLength(1);
});

test("a failed search says why", async () => {
	const f = fakeDeps();
	f.replies["game.find"] = () => {
		throw new Error("Something went wrong (EACCES).");
	};
	const g = new GameController(f.deps);
	await g.load();
	expect(g.state.findError).toBe("Something went wrong (EACCES).");
	expect(g.state.loaded).toBe(true);
	expect(presentGame(g.state, view(), t).findError).toBe(
		"Something went wrong (EACCES).",
	);
});
