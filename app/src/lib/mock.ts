// A stand-in for the Rust shell and the core, for working on the look in a plain browser
// (`bun run dev` or `vite preview`). The entry files load it only when Tauri is missing.
// Choose a case with `?mock=live|connected|waiting|problems|exit|fail|empty` and `&lang=de`.
import type {
	GameClient,
	Host,
	HostEvents,
	SidecarState,
	Status,
} from "./types.ts";

type Handler = (payload: never) => void;
type Line = Record<string, unknown>;

const VERSION = "0.15.0";
const MAIN = "C:\\Program Files (x86)\\World of Warcraft\\_forever_";
const SECOND = "D:\\Games\\World of Warcraft\\_forever_";

const CHARACTER = {
	name: "Moonbreeze",
	level: "35",
	race: "Tauren",
	class: "Druid",
	zone: "Desolace",
};

const QUESTIONS: [string, number, string[]][] = [
	["Which flight paths do I know?", 3900, ["flightpaths"]],
	[
		"What do the Magram give me for reputation?",
		6200,
		["lookup", "lookup", "lookup"],
	],
	["Is <b>Thunderfury</b> worth farming for a druid tank?", 11_800, ["lookup"]],
	[
		"What is the fastest way to turn in my finished quests, and which flight path saves the most time?",
		24_100,
		["quests", "flightpaths"],
	],
];

export function mockHost(
	scenario = "live",
	language: string | null = null,
): Host {
	const handlers = new Map<string, Set<Handler>>();
	const fire = <K extends keyof HostEvents>(event: K, payload: HostEvents[K]) =>
		setTimeout(() => {
			for (const h of handlers.get(event) ?? []) h(payload as never);
		}, 0);
	const later = (ms: number, fn: () => void) => setTimeout(fn, ms);

	let state: SidecarState = {
		gen: 1,
		running: true,
		stderrTail: [],
		stderrSeq: 0,
	};
	// What the made-up PC has: one client with the addon, one without.
	const clients = new Map<string, GameClient>([
		[
			MAIN,
			{
				client: MAIN,
				version: "1.60.1",
				interface: 16001,
				installed: true,
				addonVersion: VERSION,
			},
		],
		[
			SECOND,
			{
				client: SECOND,
				version: "1.60.1",
				interface: 16001,
				installed: false,
			},
		],
	]);
	if (scenario === "empty") clients.clear();
	let settings: Line = {
		app: { language: language ?? "system", close: "tray" },
		game: {},
		brain: { use: "agent", command: ["hermes", "acp"] },
		mcp: { port: 27495 },
	};
	let status: Status = fresh();
	let log: Line[] = [];
	let asked = 0;
	const line = (data: unknown) =>
		fire("sidecar-line", { gen: state.gen, line: JSON.stringify(data) });
	const changed = () => line({ event: "status", data: status });
	const logLine = (entry: Line) => {
		const full = { at: Date.now(), ...entry };
		log.push(full);
		if (log.length > 500) log.shift();
		line({ event: "log", data: full });
	};

	function fresh(): Status {
		const client = scenario === "empty" ? undefined : MAIN;
		return {
			running: false,
			...(client ? { client } : {}),
			addon: { installed: client !== undefined },
			game: { running: false },
			brain: { kind: "agent", command: ["hermes", "acp"] },
			problems: [],
		};
	}

	/** A run that started an hour ago: what the core really writes, in that order. */
	function history(now: number): Line[] {
		let at = now - 3_700_000;
		const lines: Line[] = [];
		const add = (gap: number, entry: Line) => {
			at += gap;
			lines.push({ at, ...entry });
		};
		add(0, {
			event: "start",
			version: VERSION,
			platform: "win32",
			client: MAIN,
			interface: 16001,
			build: "1.60.1.62148",
			install: { added: 0, updated: 3 },
			brain: { kind: "agent", command: ["hermes", "acp"] },
		});
		add(2, { event: "note", level: "info", text: `familiar ${VERSION}` });
		add(1, {
			event: "note",
			level: "info",
			text: `Client: ${MAIN} (interface 16001, 1.60.1.62148)`,
		});
		add(1, {
			event: "note",
			level: "info",
			text: "Brain:  hermes acp (permission requests: ask)",
		});
		add(40, {
			event: "note",
			level: "info",
			text: "Tools:  http://127.0.0.1:27495/mcp, handed to the agent with each session",
		});
		add(5, { event: "note", level: "info", text: "Addon updated." });
		add(30, { event: "reset", why: "WoW is not running", changed: 0 });
		add(1900, {
			event: "brain-start",
			ms: 1870,
			agent: { name: "hermes", title: "Hermes", version: "0.12.3" },
		});
		add(1, { event: "say", text: "Brain ready: Hermes 0.12.3" });
		add(23 * 60_000, { event: "game", pids: [18244] });
		add(14_000, { event: "session", key: "k7f2", silenced: 0 });
		add(1, {
			event: "message",
			key: "k7f2",
			id: 1,
			ack: 0,
			hello: true,
			bytes: 31,
		});
		add(40, { event: "send", bytes: 142, welcome: true, slot: 1 });
		add(2, { event: "hello", text: `Familiar ${VERSION}, interface 16001` });
		add(1, {
			event: "say",
			text: `The addon says hello: Familiar ${VERSION}, interface 16001`,
		});
		add(9 * 60_000, {
			event: "lane-broken",
			file: "Moonbreeze/AddOns.txt",
			why: "a part was missing",
		});
		QUESTIONS.forEach(([text, ms, tools], i) => {
			const n = ++asked;
			add(i === 0 ? 60_000 : 300_000, {
				event: "message",
				key: "k7f2",
				id: 1 + n,
				ack: n,
				bytes: 90,
			});
			add(5, { event: "say", text: `Question: ${text}` });
			add(1, { event: "question", n, text, character: CHARACTER });
			if (n === 1)
				add(300, {
					event: "brain-session",
					session: "sess-41",
					wow: true,
				});
			if (n === 1)
				add(40, {
					event: "mcp-client",
					client: { name: "hermes-mcp", version: "1.2.0" },
					agent: "hermes",
					protocol: "2025-06-18",
				});
			for (const [j, tool] of tools.entries())
				add(600 + j * 400, {
					event: "mcp-call",
					tool,
					...(n === 2 && j === 1
						? { error: "No item with the ID 6798 in the game's cache." }
						: {}),
				});
			if (n === 3)
				add(900, {
					event: "brain-permission",
					tool: "web_search: thunderfury",
					answer: "allow_once",
				});
			add(ms - 1500, {
				event: "answer",
				ms: ms - 400,
				stopReason: "end_turn",
				chars: 640,
			});
			add(300, { event: "send", bytes: 410, welcome: false, slot: n + 1 });
			if (n === 2) {
				add(1, { event: "undelivered", n, ms, tools });
				add(1, {
					event: "say",
					text: "Could not send the answer: no addon session yet",
				});
				return;
			}
			add(1, { event: "answered", n, ms, bytes: 400, tools });
			add(1, {
				event: "say",
				text: `Answered after ${(ms / 1000).toFixed(1)} s, 400 bytes.`,
			});
		});
		add(4 * 60_000, {
			event: "brain-error",
			during: "prompt",
			quit: false,
			error: "the provider is rate limiting (HTTP 429)",
		});
		add(30_000, {
			event: "mcp-refused",
			status: 401,
			why: "no token",
			agent: "curl/8.9",
		});
		add(2000, {
			event: "note",
			level: "warn",
			text: "WoW is running and new files were added. Quit WoW completely and start it again; /reload does not find new files.",
		});
		return lines.filter((l) => (l.at as number) < now);
	}

	function connect(now: number) {
		status.game = {
			running: true,
			hello: `Familiar ${VERSION}`,
			lastContact: now,
		};
		status.character = CHARACTER;
		status.last = { at: now, ms: 24_100, tools: ["quests", "flightpaths"] };
	}

	/** The addon keeps talking while WoW runs: small messages and acks, now and then. */
	function trickle() {
		let id = 100;
		const tick = () => {
			if (!status.game.running) return;
			id++;
			logLine({ event: "message", key: "k7f2", id, ack: id - 1, bytes: 64 });
			status.game.lastContact = Date.now();
			if (id % 3 === 0) logLine({ event: "send", bytes: 24, slot: id % 16 });
			later(2500, tick);
		};
		later(2500, tick);
	}

	/** One question with its tools, as the core logs it. */
	function ask(i: number, then?: () => void) {
		const next = QUESTIONS[i % QUESTIONS.length];
		if (!next) return;
		const [text, ms, tools] = next;
		const n = ++asked;
		logLine({ event: "say", text: `Question: ${text}` });
		logLine({ event: "question", n, text, character: CHARACTER });
		status.character = CHARACTER;
		status.game.lastContact = Date.now();
		changed();
		tools.forEach((tool, j) => {
			later(500 + j * 400, () => logLine({ event: "mcp-call", tool }));
		});
		later(Math.min(ms, 4000), () => {
			logLine({ event: "answered", n, ms, bytes: 400, tools });
			logLine({
				event: "say",
				text: `Answered after ${(ms / 1000).toFixed(1)} s, 400 bytes.`,
			});
			status.last = { at: Date.now(), ms, tools };
			changed();
			then?.();
		});
	}

	function play() {
		const now = Date.now();
		if (scenario === "connected" || scenario === "problems") {
			connect(now - 4000);
			if (scenario === "problems") {
				status.problems = [
					"Port 27495 is in use. Close the other program or choose another port in the settings.",
				];
				status.restartNeeded = true;
			}
			changed();
			later(1500, () => ask(4));
			trickle();
			return;
		}
		if (scenario === "waiting" || scenario === "empty") return;
		if (scenario === "exit") {
			later(1500, () => {
				const gen = state.gen;
				for (const text of [
					"familiar-core: reading the settings",
					"error: Something went wrong (TypeError).",
				]) {
					state.stderrTail.push(text);
					state.stderrSeq++;
					fire("sidecar-stderr", { gen, seq: state.stderrSeq, line: text });
				}
				state = { ...state, running: false, exitCode: 1 };
				fire("sidecar-exit", { gen, code: 1 });
			});
			return;
		}
		// live: WoW starts, the addon says hello, questions come in.
		logLine({ event: "note", level: "info", text: `familiar ${VERSION}` });
		later(1500, () => {
			status.game = { running: true };
			logLine({ event: "game", pids: [18244] });
			changed();
		});
		later(3000, () => {
			status.game = {
				running: true,
				hello: `Familiar ${VERSION}`,
				lastContact: Date.now(),
			};
			logLine({ event: "hello", text: `Familiar ${VERSION}, interface 16001` });
			changed();
			trickle();
		});
		let i = 0;
		const loop = () => ask(i++, () => later(5000, loop));
		later(4500, loop);
	}

	/** The client Familiar uses: the one in the settings, else the first one found. */
	function inUse(): string | undefined {
		const chosen = (settings.game as { client?: string } | undefined)?.client;
		return chosen ?? [...clients.keys()][0];
	}

	function check(path: string): GameClient {
		if (/[\\/]_(?:x?ptr|beta)_(?:[\\/]|$)/i.test(path))
			throw "This is a test realm. Familiar works with the normal WoW Forever client in the _forever_ folder.";
		const folder = path
			.replace(/[\\/]+$/, "")
			.replace(/[\\/]WowForever\.exe$/i, "");
		const client = /_forever_$/i.test(folder)
			? folder
			: /World of Warcraft$/i.test(folder)
				? `${folder}\\_forever_`
				: undefined;
		if (!client)
			throw "This is not a WoW Forever folder. Choose the _forever_ folder or the game's program in it.";
		return (
			clients.get(client) ?? { client, version: "1.60.1", installed: false }
		);
	}

	function handle(request: {
		id: number;
		method: string;
		params?: Record<string, unknown>;
	}) {
		const p = request.params ?? {};
		const reply = (result: unknown) =>
			later(120, () => line({ id: request.id, result }));
		const fail = (message: string) =>
			later(120, () => line({ id: request.id, error: { message } }));
		switch (request.method) {
			case "hello":
				return reply({ version: VERSION, platform: "mock", settingsFile: "" });
			case "settings.get":
				return reply({
					settings: structuredClone(settings),
					keys: {},
					file: "",
				});
			case "settings.set":
				settings = structuredClone(p.settings as Line);
				// As the core: while Familiar runs, a change waits for the restart.
				if (status.running) status.restartNeeded = true;
				else status.client = inUse();
				changed();
				return reply({ settings, keys: {}, file: "" });
			case "status": {
				const client = status.client ? clients.get(status.client) : undefined;
				status.addon.installed = client?.installed ?? false;
				return reply(status);
			}
			case "logs.recent":
				return reply(log.slice(-Number(p.limit ?? 500)));
			case "logs.open":
				console.info("logs.open");
				return reply(null);
			case "game.find":
				return later(400, () =>
					line({ id: request.id, result: [...clients.values()] }),
				);
			case "game.check":
				try {
					return reply(check(String(p.path ?? "")));
				} catch (message) {
					return fail(String(message));
				}
			case "addon.install": {
				const id = String(p.client ?? inUse() ?? "");
				const c = clients.get(id) ?? check(id);
				const fresh = !c.installed;
				const old = c.addonVersion !== VERSION;
				clients.set(id, { ...c, installed: true, addonVersion: VERSION });
				if (id === status.client) status.addon.installed = true;
				changed();
				return reply({
					added: fresh ? 257 : 0,
					updated: !fresh && old ? 3 : 0,
					removed: 0,
					wowRunning: status.game.running,
				});
			}
			case "addon.uninstall": {
				if (status.game.running)
					return fail(
						"Close WoW first, so it does not write the helpers' rows back.",
					);
				const id = String(p.client ?? inUse() ?? "");
				const c = clients.get(id);
				if (c) clients.set(id, { ...c, installed: false });
				delete clients.get(id)?.addonVersion;
				if (id === status.client) status.addon.installed = false;
				// The core stops Familiar first, so nothing writes to the removed files.
				status.running = false;
				changed();
				return reply({ folders: 257, rows: 3 });
			}
			case "start":
				if (scenario === "fail")
					return fail(
						"WoW Forever was not found. Choose its _forever_ folder.",
					);
				status.running = true;
				reply(status);
				return later(200, play);
			case "restart":
				status.restartNeeded = false;
				status.problems = [];
				status.client = inUse();
				return reply(status);
			default:
				return fail(`Unknown method ${request.method}.`);
		}
	}

	if (scenario === "connected" || scenario === "problems")
		log = history(Date.now());

	return {
		state: async () => structuredClone(state),
		send: async (text) => {
			if (!state.running) throw "The core is not running.";
			handle(JSON.parse(text));
		},
		restart: async () => {
			fire("sidecar-exit", { gen: state.gen, code: null });
			state = {
				gen: state.gen + 1,
				running: true,
				stderrTail: [],
				stderrSeq: 0,
			};
			status = fresh();
			log = [];
			scenario = "live";
			fire("sidecar-started", { gen: state.gen });
		},
		trayUpdate: async (update) => {
			console.info("tray_update", update);
		},
		setCloseMode: async () => {},
		showMain: async () => {
			console.info("show_main");
		},
		quit: async () => {},
		// No real dialog in a browser: the prompt stands in for it.
		pickFolder: async (title) =>
			globalThis.prompt?.(title, SECOND.replace(/\\_forever_$/, "")) ?? null,
		on: async (event, handler) => {
			const set = handlers.get(event) ?? new Set();
			set.add(handler as Handler);
			handlers.set(event, set);
			return () => set.delete(handler as Handler);
		},
		emit: async (event, payload) => {
			fire(event, payload);
		},
	};
}
