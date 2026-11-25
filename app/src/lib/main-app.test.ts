import { expect, test } from "bun:test";
import { MainApp } from "./main-app.ts";
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
	const replies: Record<string, Reply> = {
		hello: { result: { version: "0.14.0" } },
		"settings.get": {
			result: { settings: { app: { language: "de", close: "quit" } } },
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
