import { expect, test } from "bun:test";
import { KEEP_LINES, MainApp } from "./main-app.ts";
import type {
	Host,
	HostEvents,
	SidecarState,
	Status,
	TraySnapshot,
	TrayUpdate,
} from "./types.ts";

type Reply = { result: unknown } | { error: string } | "never";

const tick = () => new Promise((r) => setTimeout(r, 0));

function status(over: Partial<Status> = {}): Status {
	return {
		running: false,
		client: "C:\\WoW\\_forever_",
		addon: { installed: true },
		game: { running: false },
		brain: { kind: "agent", command: ["hermes", "acp"] },
		problems: [],
		...over,
	};
}

/** The shell and a core that answers by method, as the test says. */
function fakeHost(
	state: SidecarState = { gen: 1, running: true, stderrTail: [], stderrSeq: 0 },
) {
	const handlers = new Map<string, ((p: never) => void)[]>();
	const sent: { gen: number; id: number; method: string }[] = [];
	const trays: TrayUpdate[] = [];
	const snapshots: TraySnapshot[] = [];
	const closeModes: string[] = [];
	const picks: string[] = [];
	const params: { method: string; params?: Record<string, unknown> }[] = [];
	const replies: Record<string, Reply> = {
		hello: { result: { version: "0.14.0" } },
		"settings.get": {
			result: {
				settings: { app: { language: "de", close: "quit", setupDone: true } },
			},
		},
		status: { result: status() },
		"logs.recent": { result: [] },
		start: { result: status({ running: true }) },
	};
	const fire = <K extends keyof HostEvents>(
		event: K,
		payload: HostEvents[K],
	) => {
		for (const h of handlers.get(event) ?? []) h(payload as never);
	};
	const answer = (id: number, reply: Reply) => {
		if (reply === "never") return;
		const body =
			"error" in reply
				? { id, error: { message: reply.error } }
				: { id, result: reply.result };
		fire("sidecar-line", { gen: state.gen, line: JSON.stringify(body) });
	};
	const host: Host = {
		state: async () => structuredClone(state),
		send: async (line) => {
			const r = JSON.parse(line);
			sent.push({ gen: state.gen, id: r.id, method: r.method });
			params.push({ method: r.method, params: r.params });
			const reply = replies[r.method] ?? { error: "Unknown." };
			setTimeout(() => answer(r.id, reply), 0);
		},
		restart: async () => {
			state = {
				gen: state.gen + 1,
				running: true,
				stderrTail: [],
				stderrSeq: 0,
			};
			fire("sidecar-started", { gen: state.gen });
		},
		trayUpdate: async (u) => void trays.push(u),
		setCloseMode: async (m) => void closeModes.push(m),
		showMain: async () => {},
		quit: async () => {},
		pickFolder: async (title) => {
			picks.push(title);
			return "D:\\Games\\World of Warcraft";
		},
		on: async (event, handler) => {
			handlers.set(event, [
				...(handlers.get(event) ?? []),
				handler as (p: never) => void,
			]);
			return () => {};
		},
		emit: async (event, payload) => {
			if (event === "familiar-snapshot")
				snapshots.push(payload as TraySnapshot);
		},
	};
	return {
		host,
		sent,
		trays,
		snapshots,
		closeModes,
		picks,
		params,
		replies,
		fire,
		line: (gen: number, data: unknown) =>
			fire("sidecar-line", { gen, line: JSON.stringify(data) }),
		setState: (s: SidecarState) => {
			state = s;
		},
	};
}

async function settle(times = 20) {
	for (let i = 0; i < times; i++) await tick();
}

test("bootstraps in order: hello, settings, status, recent log, start", async () => {
	const f = fakeHost();
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	await app.start();
	await settle();
	expect(f.sent.map((s) => s.method)).toEqual([
		"hello",
		"settings.get",
		"status",
		"logs.recent",
		"start",
	]);
	expect(f.sent.map((s) => s.id)).toEqual([1, 2, 3, 4, 5]);
	expect(app.view.version).toBe("0.14.0");
	expect(app.view.language).toBe("de");
	expect(f.closeModes).toEqual(["quit"]);
	expect(app.view.status?.running).toBe(true);
	expect(app.view.failure).toBeUndefined();
});

test("a failed step shows its message and stops the bootstrap", async () => {
	const f = fakeHost();
	f.replies.start = {
		error: "WoW Forever was not found. Choose its _forever_ folder.",
	};
	f.replies.status = { error: "The settings file is broken." };
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	await app.start();
	await settle();
	expect(f.sent.map((s) => s.method)).toEqual([
		"hello",
		"settings.get",
		"status",
	]);
	expect(app.view.failure).toBe("The settings file is broken.");
	expect(f.trays.at(-1)?.state).toBe("error");
	expect(f.snapshots.at(-1)?.gameLine).toBe("The settings file is broken.");
});

test("once Familiar runs again, the error that kept it from starting goes", async () => {
	const f = fakeHost();
	f.replies.start = {
		error: "WoW Forever was not found. Choose its _forever_ folder.",
	};
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	await app.start();
	await settle();
	expect(app.view.failure).toBe(
		"WoW Forever was not found. Choose its _forever_ folder.",
	);
	// The player chose the client and installed the addon; the Game page starts Familiar.
	f.replies.start = { result: status({ running: true }) };
	await app.startFamiliar();
	expect(app.view.failure).toBeUndefined();
	expect(f.trays.at(-1)?.state).not.toBe("error");
	// A start that answers but does not run keeps the error where it was.
	f.replies.start = { error: "Still no client." };
	await app.startFamiliar();
	expect(app.view.failure).toBe("Still no client.");
});

test("the core exiting fails what is pending and shows the last stderr line", async () => {
	const f = fakeHost();
	f.replies.start = "never";
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	await app.start();
	await settle();
	expect(f.sent.at(-1)?.method).toBe("start");
	f.fire("sidecar-stderr", { gen: 1, seq: 1, line: "panic: out of cheese" });
	f.fire("sidecar-exit", { gen: 1, code: 3 });
	await settle();
	expect(app.view.exited).toBe(true);
	expect(app.view.exitCode).toBe(3);
	expect(app.view.failure).toBe("The core stopped.");
	expect(app.view.stderrTail).toEqual(["panic: out of cheese"]);
	expect(f.trays.at(-1)?.state).toBe("error");
	// settings.get said German.
	expect(f.snapshots.at(-1)?.gameLine).toBe(
		"Der Kern von Familiar läuft nicht mehr.",
	);
	expect(f.snapshots.at(-1)?.connection).toBe("error");
});

test("a page that loads after the core died shows the error at once", async () => {
	const f = fakeHost({
		gen: 2,
		running: false,
		exitCode: 1,
		stderrTail: ["a", "boom", ""],
		stderrSeq: 3,
	});
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	await app.start();
	await settle();
	expect(f.sent).toEqual([]);
	expect(app.view.gen).toBe(2);
	expect(app.view.exited).toBe(true);
	expect(f.snapshots.at(-1)?.gameLine).toBe("Familiar's core stopped.");
});

test("a restarted core gets its own bootstrap; the old core's lines are ignored", async () => {
	const f = fakeHost();
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	await app.start();
	await settle();
	f.fire("sidecar-exit", { gen: 1, code: null });
	await settle();
	await app.restartCore();
	await settle();
	expect(app.view.gen).toBe(2);
	expect(app.view.exited).toBe(false);
	expect(app.view.failure).toBeUndefined();
	expect(f.sent.filter((s) => s.gen === 2).map((s) => s.method)).toEqual([
		"hello",
		"settings.get",
		"status",
		"logs.recent",
		"start",
	]);
	// The started event and the sticky state both said gen 2: one bootstrap, not two.
	expect(f.sent.filter((s) => s.method === "hello")).toHaveLength(2);
	f.line(1, { event: "status", data: status({ problems: ["old core"] }) });
	expect(app.view.status?.problems).toEqual([]);
});

test("a restart whose core cannot start shows why, though no event said it", async () => {
	const f = fakeHost();
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	await app.start();
	await settle();
	// As Rust does when the spawn fails: the reason only in the sticky state, then the events.
	f.host.restart = async () => {
		f.setState({
			gen: 2,
			running: false,
			exitCode: null,
			stderrTail: ["Could not start the core: not found"],
			stderrSeq: 1,
		});
		f.fire("sidecar-started", { gen: 2 });
		f.fire("sidecar-exit", { gen: 2, code: null });
	};
	await app.restartCore();
	await settle();
	expect(app.view.gen).toBe(2);
	expect(app.view.exited).toBe(true);
	expect(app.view.stderrTail).toEqual(["Could not start the core: not found"]);
});

test("stderr lines the page heard are not repeated from the sticky state", async () => {
	const f = fakeHost();
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	await app.start();
	await settle();
	f.fire("sidecar-stderr", { gen: 1, seq: 1, line: "one" });
	f.fire("sidecar-stderr", { gen: 1, seq: 2, line: "two" });
	f.setState({
		gen: 1,
		running: false,
		exitCode: 1,
		stderrTail: ["one", "two", "three"],
		stderrSeq: 3,
	});
	f.host.restart = async () => {};
	await app.restartCore();
	await settle();
	expect(app.view.stderrTail).toEqual(["one", "two", "three"]);
});

test("a snapshot older than the events changes nothing, and equal lines stay apart", async () => {
	// Taken when the core had said "one"; "fatal" and a second "one" arrived before it.
	const f = fakeHost();
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	await app.start();
	await settle();
	f.fire("sidecar-stderr", { gen: 1, seq: 1, line: "one" });
	f.fire("sidecar-stderr", { gen: 1, seq: 2, line: "fatal" });
	f.fire("sidecar-stderr", { gen: 1, seq: 3, line: "one" });
	f.fire("sidecar-exit", { gen: 1, code: 1 });
	f.setState({
		gen: 1,
		running: false,
		exitCode: 1,
		stderrTail: ["one"],
		stderrSeq: 1,
	});
	f.host.restart = async () => {};
	await app.restartCore();
	await settle();
	expect(app.view.stderrTail).toEqual(["one", "fatal", "one"]);
	// A late event already in the tail is not added twice either.
	f.fire("sidecar-stderr", { gen: 1, seq: 2, line: "fatal" });
	expect(app.view.stderrTail).toEqual(["one", "fatal", "one"]);
});

test("status and log events from the core update the view", async () => {
	const f = fakeHost();
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	await app.start();
	await settle();
	f.line(1, {
		event: "status",
		data: status({
			running: true,
			game: { running: true, hello: "Familiar 0.14.0" },
			character: { name: "Moonbreeze", level: "35" },
		}),
	});
	f.line(1, {
		event: "log",
		data: { at: 1, event: "question", text: "Where?" },
	});
	f.line(1, { event: "log", data: { at: 2, event: "say", text: "noise" } });
	expect(app.view.log).toEqual([{ at: 1, event: "question", text: "Where?" }]);
	const snap = f.snapshots.at(-1);
	expect(snap?.connection).toBe("connected");
	expect(snap?.character).toBe("Moonbreeze");
	expect(snap?.characterLine).toBe("Stufe 35");
	expect(snap?.recent).toEqual([
		{ at: 1, text: "Where?", ms: undefined, tools: [] },
	]);
	expect(f.trays.at(-1)).toEqual({
		state: "connected",
		tooltip: "Familiar: Verbunden · Moonbreeze",
		open: "Familiar öffnen",
		quit: "Beenden",
	});
});

test("the tray icon is only updated when something it shows changed", async () => {
	const f = fakeHost();
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	await app.start();
	await settle();
	const before = f.trays.length;
	f.line(1, { event: "log", data: { at: 1, event: "question", text: "a" } });
	f.line(1, {
		event: "log",
		data: { at: 2, event: "answered", ms: 5, tools: [] },
	});
	expect(f.trays.length).toBe(before);
	const keys = f.trays.map((u) => JSON.stringify(u));
	for (let i = 1; i < keys.length; i++) expect(keys[i]).not.toBe(keys[i - 1]);
});

test("a snapshot request is answered even when nothing changed", async () => {
	const f = fakeHost();
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	await app.start();
	await settle();
	const before = f.snapshots.length;
	f.fire("familiar-snapshot-request", null);
	expect(f.snapshots.length).toBe(before + 1);
});

test("lines that come while the recent log is asked for are kept once", async () => {
	const f = fakeHost();
	const asked = { at: 1, event: "question", text: "old" };
	const during = { at: 2, event: "answered", ms: 10, tools: [] };
	f.replies["logs.recent"] = { result: [asked] };
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	const origSend = f.host.send;
	f.host.send = async (line) => {
		if (JSON.parse(line).method === "logs.recent")
			f.line(1, { event: "log", data: during });
		return origSend(line);
	};
	await app.start();
	await settle();
	expect(app.view.log).toEqual([asked, during]);
});

test("the recent log asks for 500 lines and fills the Logs page's buffer", async () => {
	const f = fakeHost();
	const recent = [
		{ at: 1, event: "start", version: "0.15.0" },
		{ at: 2, event: "question", n: 1, text: "Where?" },
		{ at: 3, event: "mcp-call", tool: "quests" },
	];
	f.replies["logs.recent"] = { result: recent };
	let params: unknown;
	const origSend = f.host.send;
	f.host.send = async (line) => {
		const r = JSON.parse(line);
		if (r.method === "logs.recent") params = r.params;
		return origSend(line);
	};
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	await app.start();
	await settle();
	expect(params).toEqual({ limit: 500 });
	expect(app.view.lines).toEqual(recent);
	// The overview's question buffer stays as it was: questions only.
	expect(app.view.log).toEqual([
		{ at: 2, event: "question", n: 1, text: "Where?" },
	]);
	f.line(1, { event: "log", data: { at: 4, event: "say", text: "hi" } });
	expect(app.view.lines.at(-1)).toEqual({ at: 4, event: "say", text: "hi" });
	expect(app.view.log).toHaveLength(1);
});

test("the log buffer keeps the newest 2000 lines", async () => {
	const f = fakeHost();
	f.replies["logs.recent"] = {
		result: Array.from({ length: 500 }, (_, i) => ({ at: i, event: "say" })),
	};
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	await app.start();
	await settle();
	for (let i = 500; i < 2100; i++)
		f.line(1, { event: "log", data: { at: i, event: "send", bytes: 1 } });
	expect(app.view.lines).toHaveLength(KEEP_LINES);
	expect(app.view.lines[0]?.at).toBe(100);
	expect(app.view.lines.at(-1)?.at).toBe(2099);
});

test("a new core starts with an empty log buffer and fills it again", async () => {
	const f = fakeHost();
	f.replies["logs.recent"] = { result: [{ at: 1, event: "say", text: "old" }] };
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	await app.start();
	await settle();
	f.line(1, { event: "log", data: { at: 2, event: "say", text: "old too" } });
	expect(app.view.lines).toHaveLength(2);
	f.replies["logs.recent"] = { result: [{ at: 5, event: "say", text: "new" }] };
	f.fire("sidecar-exit", { gen: 1, code: null });
	await settle();
	await app.restartCore();
	await settle();
	expect(app.view.gen).toBe(2);
	expect(app.view.lines).toEqual([{ at: 5, event: "say", text: "new" }]);
	// Lines of the old core that come late are not mixed in.
	f.line(1, { event: "log", data: { at: 6, event: "say", text: "late" } });
	expect(app.view.lines).toHaveLength(1);
});

test("a new player gets the setup assistant once, and Familiar waits for it to start", async () => {
	const f = fakeHost();
	f.replies["settings.get"] = {
		result: {
			settings: { app: { language: "en", setupDone: false } },
			keys: {},
		},
	};
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	await app.start();
	await settle();
	expect(app.view.page).toBe("setup");
	// The assistant installs the addon itself: the bootstrap does not start Familiar.
	expect(f.sent.map((s) => s.method)).not.toContain("start");
	app.open("overview");
	await app.restartCore();
	await settle();
	expect(app.view.gen).toBe(2);
	expect(app.view.page).toBe("overview");
});

test("a player from before the app (no setupDone) is not sent through the assistant", async () => {
	const f = fakeHost();
	f.replies["settings.get"] = {
		result: { settings: { app: { language: "en" }, brain: {} }, keys: {} },
	};
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	await app.start();
	await settle();
	expect(app.view.page).toBe("overview");
	expect(f.sent.map((s) => s.method)).toContain("start");
});

test("finishing the setup saves setupDone with the rest, opens a page and starts Familiar", async () => {
	const f = fakeHost();
	let saved: Record<string, unknown> = {
		app: { language: "en", setupDone: false },
		brain: { command: ["hermes", "acp"] },
	};
	f.replies["settings.get"] = {
		result: { settings: saved, keys: { openai: true } },
	};
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	await app.start();
	await settle();
	expect(app.view.keys).toEqual({ openai: true });
	f.replies["settings.set"] = {
		result: { settings: { app: { setupDone: true } }, keys: {} },
	};
	f.replies.start = { result: status({ running: true }) };
	await app.finishSetup("brain");
	expect(app.view.page).toBe("brain");
	expect(app.view.settings?.app?.setupDone).toBe(true);
	// The whole settings object goes back, with only setupDone changed.
	expect(f.params.filter((p) => p.method === "settings.set")).toEqual([
		{
			method: "settings.set",
			params: {
				settings: {
					app: { language: "en", setupDone: true },
					brain: { command: ["hermes", "acp"] },
				},
			},
		},
	]);
	expect(f.sent.at(-1)?.method).toBe("start");
	void saved;
	saved = {};
});

test("settings changes run one after another, so neither undoes the other", async () => {
	const f = fakeHost();
	let file: Record<string, unknown> = { app: { setupDone: true } };
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	await app.start();
	await settle();
	// A core that keeps what it is given: settings.get answers with the last save.
	f.replies["settings.get"] = { result: { settings: file, keys: {} } };
	const keep = (p?: Record<string, unknown>) => {
		file = p?.settings as Record<string, unknown>;
		f.replies["settings.get"] = { result: { settings: file, keys: {} } };
	};
	const send = f.host.send;
	f.host.send = async (line) => {
		const r = JSON.parse(line);
		if (r.method === "settings.set") {
			keep(r.params);
			f.replies["settings.set"] = { result: { settings: file, keys: {} } };
		}
		return send(line);
	};
	await Promise.all([
		app.rememberBrain({ kind: "chatgpt", name: "gpt-6-luna" }),
		app.rememberBrain({ kind: "key", provider: "openrouter", name: "m" }),
	]);
	expect((file.app as { brains: unknown }).brains).toEqual({
		chatgpt: { name: "gpt-6-luna" },
		key: { provider: "openrouter", name: "m" },
	});
});

test("use this brain: saved, then a running Familiar restarts and a stopped one starts", async () => {
	const f = fakeHost();
	f.replies["settings.get"] = {
		result: {
			settings: {
				app: { setupDone: true },
				brain: { use: "agent", command: ["hermes", "acp"], permissions: "ask" },
			},
			keys: {},
		},
	};
	f.replies["settings.set"] = { result: { settings: {}, keys: {} } };
	f.replies.restart = { result: status({ running: true }) };
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	await app.start();
	await settle();
	expect(app.view.status?.running).toBe(true);
	f.sent.length = 0;
	expect(await app.useBrain({ kind: "chatgpt", name: "gpt-6-luna" })).toEqual({
		ok: true,
	});
	expect(f.sent.map((s) => s.method)).toEqual([
		"settings.get",
		"settings.set",
		"restart",
	]);
	expect(f.params.find((p) => p.method === "settings.set")?.params).toEqual({
		settings: {
			app: {
				setupDone: true,
				// The agent that answered before keeps its place on its tab.
				brains: {
					agent: { command: ["hermes", "acp"] },
					chatgpt: { name: "gpt-6-luna" },
				},
			},
			brain: {
				use: "model",
				model: { provider: "chatgpt", name: "gpt-6-luna" },
				command: ["hermes", "acp"],
				permissions: "ask",
			},
		},
	});
	// A new brain that does not start: the page hears why, and the status is asked again.
	f.replies.restart = { error: "Could not start the agent." };
	f.replies.status = { result: status({ running: false }) };
	f.sent.length = 0;
	expect(await app.useBrain({ kind: "chatgpt", name: "gpt-6-luna" })).toEqual({
		ok: false,
		problem: "Could not start the agent.",
	});
	expect(f.sent.at(-1)?.method).toBe("status");
	expect(app.view.status?.running).toBe(false);
	// Stopped: Use this starts it.
	f.replies.start = { result: status({ running: true }) };
	f.sent.length = 0;
	await app.useBrain({ kind: "chatgpt", name: "gpt-6-luna" });
	expect(f.sent.map((s) => s.method)).toEqual([
		"settings.get",
		"settings.set",
		"start",
	]);
});

test("one ChatGPT sign-in at a time, with its address shown while it waits", async () => {
	const f = fakeHost();
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	await app.start();
	await settle();
	f.replies["chatgpt.signIn"] = "never";
	const first = app.signInChatGpt();
	const second = app.signInChatGpt();
	expect(second).toBe(first);
	await settle();
	expect(f.sent.filter((s) => s.method === "chatgpt.signIn")).toHaveLength(1);
	f.line(1, {
		event: "chatgpt-url",
		data: { url: "https://auth.openai.com/oauth/authorize?x=1" },
	});
	expect(app.view.chatgptUrl).toBe(
		"https://auth.openai.com/oauth/authorize?x=1",
	);
	// Only an https address is shown.
	f.line(1, { event: "chatgpt-url", data: { url: "javascript:alert(1)" } });
	expect(app.view.chatgptUrl).toBe(
		"https://auth.openai.com/oauth/authorize?x=1",
	);
	const id = f.sent.find((s) => s.method === "chatgpt.signIn")?.id;
	f.line(1, { id, result: { account: "me@example.com", usage: "https://u" } });
	expect(await first).toEqual({
		account: "me@example.com",
		usage: "https://u",
	});
	expect(app.view.chatgptUrl).toBeUndefined();
});

test("a key goes only to key.set, and the page learns where keys are afterwards", async () => {
	const f = fakeHost();
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	await app.start();
	await settle();
	f.replies["key.set"] = { result: null };
	f.replies["settings.get"] = {
		result: {
			settings: { app: { setupDone: true } },
			keys: { openrouter: true },
			keySources: { openrouter: "keychain" },
		},
	};
	await app.setKey("openrouter", "sk-test-123");
	expect(f.params.find((p) => p.method === "key.set")?.params).toEqual({
		provider: "openrouter",
		key: "sk-test-123",
	});
	expect(app.view.keySources).toEqual({ openrouter: "keychain" });
	expect(JSON.stringify(app.view)).not.toContain("sk-test-123");
});

test("the brain test: a real answer, or the core's words, never a timeout's crash", async () => {
	const f = fakeHost();
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	await app.start();
	await settle();
	f.replies["brain.test"] = {
		result: { ok: false, ms: 120, problem: "Could not start x", tools: [] },
	};
	expect(
		await app.testBrain({ kind: "agent", where: "local", command: ["x"] }),
	).toEqual({ ok: false, ms: 120, problem: "Could not start x", tools: [] });
	f.replies["brain.test"] = { error: "The settings are broken." };
	expect(
		await app.testBrain({ kind: "agent", where: "local", command: ["x"] }),
	).toMatchObject({ ok: false, problem: "The settings are broken." });
});

test("openBrain opens the Brain page on a kind's tab", async () => {
	const f = fakeHost();
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	await app.start();
	await settle();
	app.openBrain("local");
	expect(app.view.page).toBe("brain");
	expect(app.view.brainTab).toBe("local");
});

test("familiar-open from the tray panel switches the page, also across a new core", async () => {
	const f = fakeHost();
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	await app.start();
	await settle();
	expect(app.view.page).toBe("overview");
	const seen: string[] = [];
	app.watch((v) => seen.push(v.page));
	f.fire("familiar-open", { page: "logs" });
	expect(app.view.page).toBe("logs");
	expect(seen.at(-1)).toBe("logs");
	app.open("game");
	expect(app.view.page).toBe("game");
	await app.restartCore();
	await settle();
	expect(app.view.gen).toBe(2);
	expect(app.view.page).toBe("game");
});

test("pickFolder passes the dialog's title in the page's language", async () => {
	const f = fakeHost();
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	expect(await app.pickFolder()).toBe("D:\\Games\\World of Warcraft");
	await app.start();
	await settle();
	// settings.get said German.
	await app.pickFolder();
	expect(f.picks).toEqual([
		"Choose the WoW Forever folder",
		"Wähle den Ordner von WoW Forever",
	]);
});

test("pages call the core and refresh the shared status", async () => {
	const f = fakeHost();
	const app = new MainApp(f.host, { systemLanguage: "en-US" });
	await app.start();
	await settle();
	f.replies["game.find"] = { result: [{ client: "C:\\WoW", installed: true }] };
	expect(await app.call("game.find")).toEqual([
		{ client: "C:\\WoW", installed: true },
	]);
	f.replies.status = { result: status({ running: true, restartNeeded: true }) };
	await app.refreshStatus();
	expect(app.view.status?.restartNeeded).toBe(true);
});
