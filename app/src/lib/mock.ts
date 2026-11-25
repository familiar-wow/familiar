// A stand-in for the Rust shell and the core, for working on the look in a plain browser
// (`bun run dev` or `vite preview`). The entry files load it only when Tauri is missing.
// Choose a case with `?mock=live|connected|waiting|problems|exit|fail` and `&lang=de`.
import type { Host, HostEvents, SidecarState, Status } from "./types.ts";

type Handler = (payload: never) => void;

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
	let status: Status = fresh();
	let log: Record<string, unknown>[] = [];
	const line = (data: unknown) =>
		fire("sidecar-line", { gen: state.gen, line: JSON.stringify(data) });
	const changed = () => line({ event: "status", data: status });
	const logLine = (entry: Record<string, unknown>) => {
		log.push(entry);
		line({ event: "log", data: entry });
	};

	function fresh(): Status {
		return {
			running: false,
			client: "C:\\Program Files (x86)\\World of Warcraft\\_forever_",
			addon: { installed: true },
			game: { running: false },
			brain: { kind: "agent", command: ["hermes", "acp"] },
			problems: [],
		};
	}

	function history(now: number): Record<string, unknown>[] {
		const lines: Record<string, unknown>[] = [
			// The log was cut before this question.
			{
				at: now - 3_600_000,
				event: "answered",
				ms: 2100,
				bytes: 80,
				tools: [],
			},
		];
		QUESTIONS.forEach(([text, ms, tools], i) => {
			const at = now - (QUESTIONS.length - i) * 600_000;
			lines.push({ at, event: "question", text, character: CHARACTER });
			lines.push({ at: at + ms, event: "answered", ms, bytes: 400, tools });
		});
		return lines;
	}

	function connect(now: number) {
		status.game = { running: true, hello: "Familiar 0.14.0", lastContact: now };
		status.character = CHARACTER;
		status.last = { at: now, ms: 24_100, tools: ["quests", "flightpaths"] };
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
			later(1500, () =>
				logLine({
					at: Date.now(),
					event: "question",
					text: "Where do I train Bear Form?",
					character: CHARACTER,
				}),
			);
			return;
		}
		if (scenario === "waiting") return;
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
		later(1500, () => {
			status.game = { running: true };
			changed();
		});
		later(3000, () => {
			status.game = {
				running: true,
				hello: "Familiar 0.14.0",
				lastContact: Date.now(),
			};
			changed();
		});
		let i = 0;
		const ask = () => {
			const next = QUESTIONS[i++ % QUESTIONS.length];
			if (!next) return;
			const [text, ms, tools] = next;
			logLine({
				at: Date.now(),
				event: "question",
				text,
				character: CHARACTER,
			});
			status.character = CHARACTER;
			status.game.lastContact = Date.now();
			changed();
			later(Math.min(ms, 4000), () => {
				logLine({ at: Date.now(), event: "answered", ms, bytes: 400, tools });
				status.last = { at: Date.now(), ms, tools };
				changed();
				later(5000, ask);
			});
		};
		later(4500, ask);
	}

	function handle(request: { id: number; method: string }) {
		const reply = (result: unknown) =>
			later(120, () => line({ id: request.id, result }));
		const fail = (message: string) =>
			later(120, () => line({ id: request.id, error: { message } }));
		switch (request.method) {
			case "hello":
				return reply({ version: "0.14.0", platform: "mock", settingsFile: "" });
			case "settings.get":
				return reply({
					settings: { app: { language: language ?? "system", close: "tray" } },
					keys: {},
					file: "",
				});
			case "status":
				return reply(status);
			case "logs.recent":
				return reply(log);
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
