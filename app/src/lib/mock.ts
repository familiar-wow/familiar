// A stand-in for the Rust shell and the core, for working on the look in a plain browser
// (`bun run dev` or `vite preview`). The entry files load it only when Tauri is missing.
// Choose a case with `?mock=live|connected|waiting|problems|exit|fail|empty|first` and `&lang=de`.
// `first` is a new player: a new settings file (setupDone false) and no addon yet.
// `&brain=chatgpt|key|local|ssh` sets the brain that answers (default: the own agent `hermes acp`),
// `&chatgpt=in` starts signed in with ChatGPT (also with `brain=chatgpt`).
// Settings page: `&platform=linux` plays a Linux PC (default Windows), `&refuse=save` makes every
// `settings.set` fail and `&refuse=autostart` the system's autostart entry, as a broken disk or
// desktop would.
//
// Brain page cases: API keys for OpenRouter (keychain) and Anthropic (environment); a key that
// starts with "bad" is refused by the provider. Ollama runs, LM Studio is installed but off
// (Start brings it up after 2.5 s); a server at 192.168.1.20 answers, others do not. SSH:
// `homelab` comes from the SSH config through a jump host (no fingerprint), `nas` from the config
// and already trusted, any other name is unknown with a fingerprint, `offline` cannot be reached.
// `brain.test` fails for a key provider without a key, ChatGPT signed out, Claude Code (no key)
// and `offline`. Secrets are kept as "there is one", never their value, and never logged.
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
const USAGE = "https://chatgpt.com/settings/usage";
const ACCOUNT = "moonbreeze@example.com";
const FINGERPRINT = "SHA256:q3Vx8mH2kTzN0pW7rYcB4dLs9eFgJ1uA6oQiXvR5T8k";
const NAS_FINGERPRINT = "SHA256:Zq0vN7cX2mB5sL8dK3jH6gF9aP1oI4uY7tR0eW2qT5w";
const HOME = "C:\\Users\\Moonbreeze";

/** What `models.list` gives per provider: with and without tool support and prices. */
const MODELS: Record<string, Line[]> = {
	openrouter: [
		{
			id: "openai/gpt-6-luna",
			name: "OpenAI: GPT-6 Luna",
			tools: true,
			price: { input: 0.1, output: 0.5 },
			recommended: true,
		},
		{
			id: "anthropic/claude-haiku-5.5",
			name: "Anthropic: Claude Haiku 5.5",
			tools: true,
			price: { input: 1, output: 5 },
			recommended: true,
		},
		{
			id: "google/gemini-3.5-flash",
			name: "Google: Gemini 3.5 Flash",
			tools: true,
			price: { input: 0.3, output: 2.5 },
			recommended: true,
		},
		{
			id: "deepseek/deepseek-v4.1-flash",
			name: "DeepSeek: V4.1 Flash",
			tools: true,
			price: { input: 0.14, output: 0.28 },
			recommended: true,
		},
		{
			id: "meta-llama/llama-5-70b-instruct",
			name: "Meta: Llama 5 70B Instruct",
			tools: true,
			price: { input: 0.3, output: 0.9 },
		},
		{
			id: "mistralai/mistral-medium-4",
			name: "Mistral: Medium 4",
			tools: true,
			price: { input: 0.4, output: 2 },
		},
		{
			id: "openai/gpt-6-luna-pro",
			name: "OpenAI: GPT-6 Luna Pro",
			tools: true,
			price: { input: 1.25, output: 10 },
		},
		{
			id: "openrouter/auto",
			name: "Auto Router",
			tools: true,
		},
		{
			id: "qwen/qwen3.7-235b",
			name: "Qwen: Qwen3.7 235B",
			tools: true,
			price: { input: 0.2, output: 0.6 },
		},
	],
	openai: [
		{ id: "gpt-6-luna", recommended: true },
		{ id: "gpt-6" },
		{ id: "gpt-6-luna-mini" },
		{ id: "o5-mini" },
	],
	anthropic: [
		{
			id: "claude-haiku-5-5",
			name: "Claude Haiku 5.5",
			tools: true,
			recommended: true,
		},
		{ id: "claude-opus-5-5", name: "Claude Opus 5.5", tools: true },
		{ id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", tools: true },
	],
	google: [
		{ id: "gemini-3.5-flash", name: "Gemini 3.5 Flash", recommended: true },
		{ id: "gemini-3.5-pro", name: "Gemini 3.5 Pro" },
		{ id: "gemma-4-27b-it", name: "Gemma 4 27B", tools: false },
	],
	deepseek: [
		{ id: "deepseek-v4.1-flash", recommended: true },
		{ id: "deepseek-chat", recommended: true },
		{ id: "deepseek-reasoner", tools: false },
	],
};

/** The brains `&brain=` starts with. */
const BRAINS: Record<string, Line> = {
	chatgpt: { use: "model", model: { provider: "chatgpt", name: "gpt-6-luna" } },
	key: {
		use: "model",
		model: { provider: "openrouter", name: "openai/gpt-6-luna" },
	},
	local: { use: "model", model: { provider: "ollama", name: "qwen3.7:14b" } },
	ssh: {
		use: "agent",
		command: ["hermes", "acp"],
		ssh: {
			host: "nas",
			auth: "key",
			command: ["/home/admin/.local/bin/hermes", "acp"],
		},
		cwd: "/home/admin",
	},
};

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
	/** The system's autostart entry, which the settings follow. */
	let autostartOn = false;

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
	const first = scenario === "first";
	// A new player: WoW is there, the addon is not.
	if (first)
		for (const [id, c] of clients) {
			clients.set(id, { ...c, installed: false });
			delete clients.get(id)?.addonVersion;
		}
	const query = new URLSearchParams(globalThis.location?.search ?? "");
	const brainCase = query.get("brain") ?? "";
	const refuse = query.get("refuse");
	const platform = query.get("platform") === "linux" ? "linux" : "win32";
	const folder =
		platform === "linux"
			? "/home/moonbreeze/.config/familiar"
			: `${HOME}\\AppData\\Roaming\\Familiar`;
	const sep = platform === "linux" ? "/" : "\\";
	const settingsFile = `${folder}${sep}settings.json`;
	const logsFolder = `${folder}${sep}logs`;
	let settings: Line = {
		app: {
			language: language ?? "system",
			close: "tray",
			// Only a new settings file has it: a file from before the app has none.
			...(first ? { setupDone: false } : {}),
		},
		game: {},
		brain: {
			permissions: "ask",
			...(BRAINS[brainCase] ?? { use: "agent", command: ["hermes", "acp"] }),
		},
		mcp: { port: 27495 },
	};
	// Where each provider's API key is; the keys themselves are not kept.
	const keychain = new Set<string>(["openrouter"]);
	const environment = new Set<string>(["anthropic"]);
	/** Providers whose stored key the provider refuses. */
	const refused = new Set<string>();
	let account: string | null =
		query.get("chatgpt") === "in" || brainCase === "chatgpt" ? ACCOUNT : null;
	let lmStudioRunning = false;
	const trusted = new Set<string>(["nas"]);
	/** Hosts with a saved password or passphrase: only that there is one. */
	const sshSecrets = new Set<string>();
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
			addon: { installed: client !== undefined && !first },
			game: { running: false },
			brain: describeBrain(),
			problems: [],
		};
	}

	/** The brain as the status shows it (core/src/familiar.ts describeBrain). */
	function describeBrain(): Record<string, unknown> {
		const b = settings.brain as Line;
		const model = b.model as { provider: string; name: string } | undefined;
		if (b.use === "model" && model)
			return { kind: "model", provider: model.provider, model: model.name };
		const ssh = b.ssh as { host: string; command: string[] } | undefined;
		if (ssh) return { kind: "ssh", host: ssh.host, command: ssh.command };
		return { kind: "agent", command: b.command };
	}

	/** The settings without any API key, and where each provider's key would be found. */
	function shown(): Line {
		const copy = structuredClone(settings);
		const model = (copy.brain as Line | undefined)?.model as Line | undefined;
		const fileKey = model?.apiKey ? String(model.provider) : undefined;
		if (model) delete model.apiKey;
		const keys: Record<string, boolean> = {};
		const keySources: Record<string, string> = {};
		for (const p of Object.keys(MODELS)) {
			const source = keychain.has(p)
				? "keychain"
				: fileKey === p
					? "file"
					: environment.has(p)
						? "environment"
						: undefined;
			keys[p] = source !== undefined;
			if (source) keySources[p] = source;
		}
		return { settings: copy, keys, keySources, file: settingsFile };
	}

	/** What a run uses: a change here needs a restart while Familiar runs. */
	function used(s: Line): string {
		const brain = { ...(s.brain as Line) };
		if (brain.model) brain.model = { ...(brain.model as Line), apiKey: null };
		return JSON.stringify([s.game, brain, s.mcp]);
	}

	function hostKeyOf(host: string): {
		known: boolean;
		fingerprint?: string;
		type?: string;
	} {
		if (host === "nas")
			return {
				known: true,
				fingerprint: NAS_FINGERPRINT,
				type: "ecdsa-sha2-nistp256",
			};
		// Only reachable through the jump host, or not at all: no key to show.
		if (host === "homelab" || host === "offline") return { known: false };
		if (trusted.has(host))
			return { known: true, fingerprint: FINGERPRINT, type: "ssh-ed25519" };
		return { known: false, fingerprint: FINGERPRINT, type: "ssh-ed25519" };
	}

	function resolveHost(host: string): Line {
		if (host === "homelab")
			return {
				host,
				hostname: "192.168.1.10",
				user: "pascal",
				port: 22,
				identityFiles: ["~/.ssh/id_ed25519"],
				proxyJump: "jump.example.net",
				fromConfig: true,
			};
		if (host === "nas")
			return {
				host,
				hostname: "192.168.1.30",
				user: "admin",
				port: 2222,
				identityFiles: ["~/.ssh/nas_ed25519"],
				fromConfig: true,
			};
		return {
			host,
			hostname: host,
			user: "moonbreeze",
			port: 22,
			identityFiles: ["~/.ssh/id_rsa", "~/.ssh/id_ecdsa", "~/.ssh/id_ed25519"],
			fromConfig: false,
		};
	}

	/** `ssh.test`: signs in, then looks for the program (core/src/sidecar/ssh.ts problems). */
	function sshTest(ssh: Line): Line {
		const host = String(ssh.host ?? "");
		const command = (ssh.command as string[] | undefined) ?? [];
		if (host === "offline")
			return { ok: false, problem: "The other computer could not be reached." };
		if (host === "homelab" && ssh.auth !== "key")
			return {
				ok: false,
				problem:
					"Familiar does not sign in with a saved password or passphrase when your SSH config reaches that computer through another one (ProxyJump or ProxyCommand). Use a key without a passphrase, or one that your SSH agent holds.",
			};
		if (!hostKeyOf(host).known && host !== "homelab")
			return {
				ok: false,
				problem: "The other computer's host key is not trusted yet.",
			};
		if (ssh.auth !== "key" && !sshSecrets.has(`${ssh.auth}:${host}`))
			return {
				ok: false,
				problem: "The other computer refused the sign-in (permission denied).",
			};
		const program = command[0] ?? "";
		if (!/hermes|codex|gemini|openclaw/.test(program))
			return {
				ok: false,
				problem: "The agent program was not found on the other computer.",
				agentFound: false,
			};
		const name = program.split("/").at(-1) ?? program;
		return {
			ok: true,
			agentFound: true,
			agentPath: program.startsWith("/")
				? program
				: `/home/${String(resolveHost(host).user)}/.local/bin/${name}`,
		};
	}

	/** `brain.test`: an answer, or the core's words for why there was none. */
	function brainTest(s: Line): Line {
		const b = (s.brain ?? {}) as Line;
		const model = b.model as { provider: string; name: string } | undefined;
		const ssh = b.ssh as Line | undefined;
		const ok = (ms: number, answer: string) => ({
			ok: true,
			ms,
			answer,
			tools: [],
		});
		const fail = (ms: number, problem: string) => ({
			ok: false,
			ms,
			problem,
			tools: [],
		});
		if (b.use === "model" && model) {
			const p = model.provider;
			if (p === "chatgpt")
				return account
					? ok(3100, "Greetings, Moonbreeze! I hear you loud and clear.")
					: fail(
							200,
							"Sign in with ChatGPT first: Brain page, ChatGPT plan, Sign in.",
						);
			if (p in MODELS) {
				if (!keychain.has(p) && !environment.has(p))
					return fail(
						100,
						`There is no API key for ${p}. Enter it on the Brain page.`,
					);
				if (refused.has(p)) return fail(900, "The provider refused the key.");
				return ok(
					6400,
					"Hello from the other side of the portal! Ready to help with your quests.",
				);
			}
			return ok(
				11_800,
				"Hello! I am a local model and can hear you. How can I help today?",
			);
		}
		if (ssh) {
			const problem = sshTest(ssh);
			if (!problem.ok) return fail(1200, String(problem.problem));
			return ok(8200, "Hermes here, answering from the other computer.");
		}
		const command = (b.command as string[] | undefined) ?? [];
		if (/claude/.test(command.join(" ")))
			return fail(
				2300,
				"Claude Code needs an Anthropic API key (ANTHROPIC_API_KEY); a subscription cannot be used in other apps.",
			);
		return ok(6400, "Hermes here. Ask me anything about your adventure.");
	}

	function localServers(): Line[] {
		const none = scenario === "empty";
		const ollama = `${HOME}\\AppData\\Local\\Programs\\Ollama\\ollama.exe`;
		const lms = `${HOME}\\.lmstudio\\bin\\lms.exe`;
		return [
			{
				kind: "ollama",
				name: "Ollama",
				baseUrl: "http://127.0.0.1:11434/v1",
				running: !none,
				installed: !none,
				...(none ? {} : { path: ollama, start: [ollama, "serve"] }),
				models: none
					? []
					: [
							{ id: "qwen3.7:14b", tools: true, size: 9_300_000_000 },
							{ id: "llama4.1:8b", tools: true, size: 4_900_000_000 },
							{ id: "gemma4:4b", tools: false, size: 3_300_000_000 },
						],
			},
			{
				kind: "lmstudio",
				name: "LM Studio",
				baseUrl: "http://127.0.0.1:1234/v1",
				running: lmStudioRunning,
				installed: !none,
				...(none ? {} : { path: lms, start: [lms, "server", "start"] }),
				models: lmStudioRunning
					? [{ id: "qwen3.7-14b-instruct" }, { id: "mistral-small-4" }]
					: [],
			},
		];
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

	/**
	 * The addon keeps talking while WoW runs: small messages and acks, now and then.
	 * `?trickle=<ms>` changes the pace, `&fill=<n>` sends n lines at once first: together they
	 * show the Logs page with a full buffer.
	 */
	function trickle() {
		const query = new URLSearchParams(globalThis.location?.search ?? "");
		const pace = Number(query.get("trickle")) || 2500;
		let id = 100;
		const tick = () => {
			if (!status.game.running) return;
			id++;
			logLine({ event: "message", key: "k7f2", id, ack: id - 1, bytes: 64 });
			status.game.lastContact = Date.now();
			if (id % 3 === 0) logLine({ event: "send", bytes: 24, slot: id % 16 });
			later(pace, tick);
		};
		for (let i = Number(query.get("fill")) || 0; i > 0; i--) {
			id++;
			logLine({ event: "message", key: "k7f2", id, ack: id - 1, bytes: 64 });
		}
		later(pace, tick);
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
				return reply({ version: VERSION, platform, settingsFile });
			case "settings.get":
				return reply(shown());
			case "settings.set": {
				if (refuse === "save")
					return fail(
						`Could not save the settings: ${settingsFile} is read-only (EACCES).`,
					);
				const before = used(settings);
				const next = structuredClone(p.settings as Line);
				// As the core: a key sent here goes into the keychain, never into the file.
				const model = (next.brain as Line | undefined)?.model as
					| Line
					| undefined;
				if (model?.apiKey) {
					keychain.add(String(model.provider));
					delete model.apiKey;
				}
				settings = next;
				// While Familiar runs, a change of what a run uses waits for the restart; the
				// app's own settings (`app.*`) do not.
				if (status.running) {
					if (used(settings) !== before) status.restartNeeded = true;
				} else {
					status.client = inUse();
					status.brain = describeBrain();
				}
				changed();
				return reply(shown());
			}
			case "key.set": {
				const provider = String(p.provider ?? "");
				if (!(provider in MODELS)) return fail("Choose a provider.");
				const key = String(p.key ?? "").trim();
				if (!key) return fail("The key is empty.");
				keychain.add(provider);
				if (key.startsWith("bad")) refused.add(provider);
				else refused.delete(provider);
				return reply(null);
			}
			case "key.delete":
				keychain.delete(String(p.provider ?? ""));
				refused.delete(String(p.provider ?? ""));
				return reply(null);
			case "key.has": {
				const provider = String(p.provider ?? "");
				return reply(keychain.has(provider) || environment.has(provider));
			}
			case "models.list": {
				const provider = String(p.provider ?? "");
				if (!(provider in MODELS)) return fail("Choose a provider.");
				const given = typeof p.key === "string" && p.key.trim() !== "";
				if (!given && !keychain.has(provider) && !environment.has(provider))
					return fail("Enter the API key first.");
				if (
					(given && String(p.key).trim().startsWith("bad")) ||
					(!given && refused.has(provider))
				)
					return later(700, () =>
						line({
							id: request.id,
							error: { message: "The provider refused the key." },
						}),
					);
				return later(700, () =>
					line({ id: request.id, result: MODELS[provider] }),
				);
			}
			case "chatgpt.account":
				return reply(
					account
						? { account, usage: "https://chatgpt.com/settings/usage" }
						: null,
				);
			case "chatgpt.signIn":
				// The core opens the browser and sends the address, in case it did not open.
				later(300, () =>
					line({
						event: "chatgpt-url",
						data: {
							url: "https://auth.openai.com/oauth/authorize?client_id=app_familiar&response_type=code&state=mock",
						},
					}),
				);
				return later(3000, () => {
					account = ACCOUNT;
					line({ id: request.id, result: { account, usage: USAGE } });
				});
			case "chatgpt.signOut":
				account = null;
				return reply({ revoked: true });
			case "chatgpt.models":
				if (!account) return fail("Sign in with ChatGPT first.");
				return later(500, () =>
					line({
						id: request.id,
						result: [
							{ slug: "gpt-6-luna", name: "GPT-6 Luna" },
							{ slug: "gpt-6", name: "GPT-6" },
							{ slug: "gpt-6-thinking", name: "GPT-6 Thinking" },
						],
					}),
				);
			case "local.find":
				return later(600, () =>
					line({ id: request.id, result: localServers() }),
				);
			case "local.start":
				if (p.kind === "lmstudio") {
					later(2500, () => {
						lmStudioRunning = true;
					});
					return reply(null);
				}
				if (p.kind === "ollama" && scenario !== "empty") return reply(null);
				return fail("Familiar cannot start this server itself.");
			case "local.models": {
				let url: URL;
				try {
					url = new URL(String(p.baseUrl ?? "").trim());
				} catch {
					return fail(
						"Enter the server's address, such as http://192.168.1.20:11434/v1.",
					);
				}
				if (url.protocol !== "http:" && url.protocol !== "https:")
					return fail("The address has to start with http:// or https://.");
				if (url.username || url.password)
					return fail("Leave the user name and password out of the address.");
				if (url.hostname !== "192.168.1.20")
					return later(800, () =>
						line({
							id: request.id,
							error: {
								message:
									"No OpenAI-compatible server answered at this address. Check it ends in /v1 and the server runs.",
							},
						}),
					);
				return later(800, () =>
					line({
						id: request.id,
						result: [{ id: "qwen3.7:32b" }, { id: "llama4.1:70b" }],
					}),
				);
			}
			case "agents.find":
				return later(700, () =>
					line({
						id: request.id,
						result: [
							{
								id: "hermes",
								name: "Hermes Agent",
								command: ["hermes", "acp"],
								path: `${HOME}\\AppData\\Local\\hermes\\hermes.exe`,
								version: "hermes 0.31.0",
								ready: true,
							},
							{
								id: "codex",
								name: "Codex",
								command: ["npx", "-y", "@agentclientprotocol/codex-acp"],
								path: `${HOME}\\AppData\\Roaming\\npm\\codex.cmd`,
								version: "codex-cli 0.98.0",
								ready: true,
							},
							{
								id: "claude",
								name: "Claude Code",
								command: ["npx", "-y", "@agentclientprotocol/claude-agent-acp"],
								path: `${HOME}\\.local\\bin\\claude.exe`,
								version: "2.3.1 (Claude Code)",
								ready: false,
								needs: "an Anthropic API key (ANTHROPIC_API_KEY)",
							},
						],
					}),
				);
			case "ssh.resolve": {
				const host = String(p.host ?? "").trim();
				if (!host || host.startsWith("-") || /\s/.test(host))
					return fail("That computer name cannot be used.");
				return later(300, () =>
					line({ id: request.id, result: resolveHost(host) }),
				);
			}
			case "ssh.hostKey":
				return later(400, () =>
					line({ id: request.id, result: hostKeyOf(String(p.host ?? "")) }),
				);
			case "ssh.trust": {
				const host = String(p.host ?? "");
				const key = hostKeyOf(host);
				if (!key.fingerprint || key.fingerprint !== p.fingerprint)
					return fail(
						"The other computer showed another key than the one you confirmed. Nothing was trusted.",
					);
				trusted.add(host);
				return reply(null);
			}
			case "ssh.hasSecret":
				return reply(
					sshSecrets.has(
						`${p.kind === "passphrase" ? "passphrase" : "password"}:${String(p.host ?? "")}`,
					),
				);
			case "ssh.setSecret": {
				const value = String(p.value ?? "");
				if (!value) return fail("The password is empty.");
				sshSecrets.add(
					`${p.kind === "passphrase" ? "passphrase" : "password"}:${String(p.host ?? "")}`,
				);
				return reply(null);
			}
			case "ssh.test":
				return later(1500, () =>
					line({
						id: request.id,
						result: sshTest((p.ssh ?? {}) as Line),
					}),
				);
			case "brain.test":
				return later(2500, () =>
					line({
						id: request.id,
						result: brainTest((p.settings ?? settings) as Line),
					}),
				);
			case "status": {
				const client = status.client ? clients.get(status.client) : undefined;
				status.addon.installed = client?.installed ?? false;
				return reply(status);
			}
			case "logs.recent":
				return reply(log.slice(-Number(p.limit ?? 500)));
			case "logs.folder":
				return reply(logsFolder);
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
				status.brain = describeBrain();
				reply(status);
				return later(200, play);
			case "restart":
				status.running = true;
				status.restartNeeded = false;
				status.problems = [];
				status.client = inUse();
				status.brain = describeBrain();
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
		version: async () => "0.16.0",
		autostart: async () => autostartOn,
		setAutostart: async (on) => {
			if (refuse === "autostart")
				throw "The autostart entry could not be written: Permission denied (os error 13)";
			autostartOn = on;
		},
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
