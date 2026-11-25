// The core as the desktop app's sidecar (FAM-63, ADR 0002): the app starts `familiar sidecar`
// and drives it with requests on stdin; replies, log lines and status changes go out on stdout
// (protocol.ts). Everything the app shows comes from here: the game it found, the agents and
// local models on this PC, the models a key may use, and what Familiar is doing right now.
import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { AcpBrain } from "../brain/acp.ts";
import type { Brain, Question, Turn } from "../brain/chat.ts";
import { ChatGpt, ChatGptError, USAGE_URL } from "../brain/chatgpt.ts";
import { ModelBrain } from "../brain/model.ts";
import {
	describeBrain,
	prepareBrain,
	type Running,
	resolveKey,
	startFamiliar,
} from "../familiar.ts";
import { Game } from "../game.ts";
import type { Log } from "../log.ts";
import { wowTools } from "../mcp/tools.ts";
import {
	loadSettings,
	PROVIDERS,
	parseSettings,
	type Settings,
	saveSettings,
} from "../settings.ts";
import {
	clientProcesses,
	clientVersion,
	findClients,
	isClientFolder,
	wowPaths,
} from "../wow/client.ts";
import { install, isInstalled, uninstall } from "../wow/install.ts";
import { findAgents, findLocalServers } from "./detect.ts";
import { ListError, listModels, type Provider } from "./models.ts";
import {
	type Event,
	PlayerError,
	parseRequest,
	type Reply,
} from "./protocol.ts";
import { launchable, windowsVerbatim } from "./run.ts";
import { keychain, names, SecretError, type SecretStore } from "./secrets.ts";
import {
	hostKey,
	resolveHost,
	type SshAgentConfig,
	testConnection,
	trustHost,
} from "./ssh.ts";

/** Providers whose models the app lists with a key (sidecar/models.ts). */
const KEYED: readonly Provider[] = [
	"openai",
	"anthropic",
	"google",
	"openrouter",
	"deepseek",
];
/** Log lines the app can ask for again, such as after its window was closed. */
const KEEP = 500;

export interface Status {
	/** Whether Familiar is carrying questions right now. */
	running: boolean;
	client?: string;
	addon: { installed: boolean };
	game: {
		/** Whether a WoW process runs. */
		running: boolean;
		/** When the addon last sent anything, in ms since 1970. */
		lastContact?: number;
		/** The addon's last hello, such as "Familiar 0.12.0, build 71037, …". */
		hello?: string;
	};
	/** The character of the last question. */
	character?: Record<string, string | undefined>;
	brain: Record<string, unknown>;
	last?: { at: number; ms: number; tools: string[] };
	/** Warnings for the player, newest last; cleared at each start. */
	problems: string[];
	/** The settings changed while Familiar ran: they apply after a restart. */
	restartNeeded?: boolean;
}

export interface SidecarOptions {
	settingsFile: string;
	logs: string;
	version: string;
	/** The program `ssh` starts to ask for a password: the Familiar binary. */
	askpass: string;
	/** Where replies and events go; stdout by default. */
	write?: (line: string) => void;
	/** Replaced in tests. */
	deps?: Partial<Deps>;
}

export interface Deps {
	secrets: SecretStore;
	findClients: typeof findClients;
	findAgents: typeof findAgents;
	findLocalServers: typeof findLocalServers;
	listModels: typeof listModels;
	startFamiliar: typeof startFamiliar;
	clientProcesses: typeof clientProcesses;
	resolveHost: typeof resolveHost;
	hostKey: typeof hostKey;
	trustHost: typeof trustHost;
	testConnection: typeof testConnection;
	openUrl: (url: string) => void;
	now: () => number;
	env: Record<string, string | undefined>;
}

type Handler = (params: Record<string, unknown>) => Promise<unknown> | unknown;

export class Sidecar {
	readonly status: Status;
	private readonly deps: Deps;
	private readonly write: (line: string) => void;
	private readonly recent: Record<string, unknown>[] = [];
	private running?: Running;
	/** Start, stop and restart run one after another. */
	private lifecycle: Promise<unknown> = Promise.resolve();
	/** Which run the log belongs to; lines of an earlier run change nothing. */
	private run = 0;
	private logFile?: string;
	private readonly handlers: Record<string, Handler>;

	constructor(private readonly o: SidecarOptions) {
		this.write =
			o.write ??
			((line) => {
				try {
					process.stdout.write(`${line}\n`);
				} catch {
					// The app has gone; stdin closing ends the sidecar.
				}
			});
		this.deps = {
			secrets: keychain(),
			findClients,
			findAgents,
			findLocalServers,
			listModels,
			startFamiliar,
			clientProcesses,
			resolveHost,
			hostKey,
			trustHost,
			testConnection,
			openUrl,
			now: Date.now,
			env: process.env,
			...o.deps,
		};
		this.status = {
			running: false,
			addon: { installed: false },
			game: { running: false },
			brain: {},
			problems: [],
		};
		this.handlers = this.methods();
	}

	/** Handles one line from the app. */
	async handle(line: string): Promise<void> {
		if (!line.trim()) return;
		const request = parseRequest(line);
		if (!request) {
			this.emit({ event: "invalid", data: { message: "Not a request." } });
			return;
		}
		const handler = this.handlers[request.method];
		let reply: Reply;
		if (!handler)
			reply = {
				id: request.id,
				error: { message: `Unknown method ${request.method}.` },
			};
		else
			try {
				reply = {
					id: request.id,
					result: (await handler(request.params ?? {})) ?? null,
				};
			} catch (error) {
				reply = { id: request.id, error: { message: shown(error) } };
			}
		this.write(JSON.stringify(reply));
	}

	/** Stops whatever runs, now. */
	stop(): void {
		this.run++;
		this.running?.stop();
		this.running = undefined;
		this.status.running = false;
	}

	/** Runs a start, stop or restart after the ones before it. */
	private serial<T>(work: () => Promise<T>): Promise<T> {
		const next = this.lifecycle.then(work, work);
		this.lifecycle = next.catch(() => {});
		return next;
	}

	private emit(e: Event): void {
		this.write(JSON.stringify(e));
	}

	private changed(): void {
		this.emit({ event: "status", data: this.status });
	}

	private settings(): Settings {
		try {
			return loadSettings(this.o.settingsFile);
		} catch (error) {
			// settings.ts names the setting that is wrong, never its value.
			throw new PlayerError(
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	/** Fills in the status before anything runs: which game, whether the addon is there. */
	async refresh(): Promise<Status> {
		if (this.running) return this.status;
		try {
			const settings = this.settings();
			this.status.brain = describeBrain(settings);
			const client = settings.game.client ?? (await this.deps.findClients())[0];
			this.status.client =
				client && isClientFolder(client) ? client : undefined;
			this.status.addon.installed = this.status.client
				? isInstalled(wowPaths(this.status.client))
				: false;
			this.status.game.running = (await this.deps.clientProcesses()).length > 0;
		} catch (error) {
			this.status.problems = [shown(error)];
		}
		this.changed();
		return this.status;
	}

	/** The log for a run: to its file, to the app as it happens, and into the status. */
	private log(file: string, run: number): Log {
		const sidecar = this;
		return {
			event(name, data = {}) {
				const line = { at: sidecar.deps.now(), event: name, ...data };
				appendFileSync(file, `${JSON.stringify(line)}\n`);
				// A run that was stopped may still finish something; the app no longer hears it.
				if (run !== sidecar.run) return;
				sidecar.recent.push(line);
				if (sidecar.recent.length > KEEP) sidecar.recent.shift();
				sidecar.emit({ event: "log", data: line });
				sidecar.observe(name, data);
			},
			say(text) {
				this.event("say", { text });
			},
		};
	}

	/** Keeps the status in step with what the log says happened. */
	private observe(name: string, data: Record<string, unknown>): void {
		const s = this.status;
		const at = this.deps.now();
		if (name === "message" || name === "repeat") s.game.lastContact = at;
		else if (name === "hello") s.game.hello = String(data.text ?? "");
		else if (name === "game")
			s.game.running = Array.isArray(data.pids) && data.pids.length > 0;
		else if (name === "question")
			s.character = data.character as Status["character"];
		else if (name === "answered")
			s.last = {
				at,
				ms: Number(data.ms ?? 0),
				tools: Array.isArray(data.tools) ? data.tools.map(String) : [],
			};
		else return;
		this.changed();
	}

	private methods(): Record<string, Handler> {
		return {
			hello: () => ({
				version: this.o.version,
				platform: process.platform,
				settingsFile: this.o.settingsFile,
			}),
			status: () => this.refresh(),
			"logs.recent": (p) => {
				const limit = Math.min(Number(p.limit ?? KEEP) || KEEP, KEEP);
				return this.recent.slice(-limit);
			},
			"logs.folder": () => this.o.logs,

			"settings.get": () => this.shownSettings(this.settings()),
			"settings.set": (p) => this.setSettings(p.settings),

			"game.find": async () => {
				const clients = await this.deps.findClients();
				return clients.map((client) => describeClient(client));
			},
			"game.check": (p) => {
				const client = clientFolder(String(p.path ?? ""));
				if (!client)
					throw new PlayerError(
						"This is not a WoW Forever folder. Choose the _forever_ folder or the game's program in it.",
					);
				return describeClient(client);
			},
			"addon.install": async (p) => {
				const client = await this.client(p.client);
				const paths = wowPaths(client);
				const { interface: iface } = clientVersion(client);
				const result = install(paths, iface, this.o.version);
				this.status.addon.installed = true;
				this.status.client = client;
				this.changed();
				return {
					...result,
					wowRunning: (await this.deps.clientProcesses()).length > 0,
				};
			},
			"addon.uninstall": async (p) => {
				if ((await this.deps.clientProcesses()).length > 0)
					throw new PlayerError(
						"Close WoW first, so it does not write the helpers' rows back.",
					);
				return this.serial(async () => {
					this.stop();
					const client = await this.client(p.client);
					const removed = uninstall(wowPaths(client));
					this.status.addon.installed = false;
					this.changed();
					return removed;
				});
			},

			"agents.find": () => this.deps.findAgents(),
			"local.find": () => this.deps.findLocalServers(),
			"local.start": async (p) => {
				const servers = await this.deps.findLocalServers();
				const server = servers.find((s) => s.kind === p.kind);
				if (!server?.start)
					throw new PlayerError("Familiar cannot start this server itself.");
				const launch = launchable(server.start);
				Bun.spawn(launch, {
					windowsVerbatimArguments: windowsVerbatim(launch),
					stdin: "ignore",
					stdout: "ignore",
					stderr: "ignore",
					windowsHide: true,
				}).unref();
				return null;
			},

			"key.set": async (p) => {
				const provider = keyedProvider(p.provider);
				const key = String(p.key ?? "").trim();
				if (!key) throw new PlayerError("The key is empty.");
				await this.deps.secrets.set(names.apiKey(provider), key);
				return null;
			},
			"key.delete": async (p) =>
				this.deps.secrets.delete(names.apiKey(anyProvider(p.provider))),
			"key.has": async (p) =>
				(await this.keyFor(anyProvider(p.provider))) !== undefined,
			"models.list": async (p) => {
				const provider = keyedProvider(p.provider);
				const key =
					typeof p.key === "string" && p.key.trim()
						? p.key.trim()
						: await this.keyFor(provider);
				if (!key) throw new PlayerError("Enter the API key first.");
				return this.deps.listModels(provider, key);
			},

			"chatgpt.account": () => this.chatgpt().account() ?? null,
			"chatgpt.signIn": async () => {
				const account = await this.chatgpt().signIn((url) => {
					this.emit({ event: "chatgpt-url", data: { url } });
					this.deps.openUrl(url);
				});
				return { account, usage: USAGE_URL };
			},
			"chatgpt.signOut": (p) =>
				this.chatgpt().signOut({ forget: p.forget === true }),
			"chatgpt.models": () => this.chatgpt().models(),

			"ssh.resolve": (p) => this.deps.resolveHost(hostOf(p.host)),
			"ssh.hostKey": (p) => this.deps.hostKey(hostOf(p.host)),
			"ssh.trust": (p) =>
				this.deps.trustHost(hostOf(p.host), String(p.fingerprint ?? "")),
			"ssh.setSecret": async (p) => {
				const host = hostOf(p.host);
				const value = String(p.value ?? "");
				if (!value) throw new PlayerError("The password is empty.");
				await this.deps.secrets.set(
					p.kind === "passphrase"
						? names.sshPassphrase(host)
						: names.sshPassword(host),
					value,
				);
				return null;
			},
			"ssh.test": (p) =>
				this.deps.testConnection(this.sshConfig(p), {
					askpass: [this.o.askpass],
				}),

			"brain.test": (p) => this.testBrain(p.settings),

			start: () => this.serial(() => this.start()),
			stop: () =>
				this.serial(async () => {
					this.stop();
					this.changed();
					return null;
				}),
			restart: () =>
				this.serial(async () => {
					this.stop();
					return this.start();
				}),
			shutdown: () => {
				this.stop();
				setTimeout(() => process.exit(0), 50);
				return null;
			},
		};
	}

	/** The settings for the app: never an API key, only whether one is there. */
	private async shownSettings(settings: Settings) {
		const shown = structuredClone(settings);
		if (shown.brain.model) delete shown.brain.model.apiKey;
		const keys: Record<string, boolean> = {};
		for (const provider of KEYED)
			keys[provider] = (await this.keyFor(provider)) !== undefined;
		return { settings: shown, keys, file: this.o.settingsFile };
	}

	private async setSettings(value: unknown) {
		const next = parseSettings(value);
		const before = existsSync(this.o.settingsFile)
			? this.settings()
			: undefined;
		const model = next.brain.model;
		// The app never sees a key that is in the file, so it cannot send it back: keep it.
		if (
			model &&
			!model.apiKey &&
			before?.brain.model?.apiKey &&
			before.brain.model.provider === model.provider
		)
			model.apiKey = before.brain.model.apiKey;
		if (model?.apiKey) {
			// A key goes into the keychain, not into the file: one the app sends, and one that
			// was in the file. Without a keychain it stays in the file, readable by its owner only.
			try {
				await this.deps.secrets.set(names.apiKey(model.provider), model.apiKey);
				delete model.apiKey;
			} catch (error) {
				if (before?.brain.model?.apiKey !== model.apiKey) throw error;
			}
		}
		saveSettings(this.o.settingsFile, next);
		// While Familiar runs, the overview shows the brain that answers, not the new one.
		if (this.status.running) this.status.restartNeeded = true;
		else this.status.brain = describeBrain(next);
		this.changed();
		return this.shownSettings(next);
	}

	/** The key for a provider, found the same way as when Familiar starts. */
	private keyFor(provider: string): Promise<string | undefined> {
		return resolveKey(
			provider,
			this.settings(),
			this.deps.secrets,
			this.deps.env,
		);
	}

	private chatgpt(): ChatGpt {
		return new ChatGpt({ folder: dirname(this.o.settingsFile) });
	}

	private async client(chosen: unknown): Promise<string> {
		const client =
			(typeof chosen === "string" && chosen) ||
			this.settings().game.client ||
			(await this.deps.findClients())[0];
		if (!client || !isClientFolder(client))
			throw new PlayerError(
				"WoW Forever was not found. Choose its _forever_ folder.",
			);
		return client;
	}

	private sshConfig(p: Record<string, unknown>): SshAgentConfig {
		const settings = this.settings();
		const ssh = (p.ssh ?? settings.brain.ssh) as Partial<SshAgentConfig>;
		if (!ssh?.host || !Array.isArray(ssh.command) || ssh.command.length === 0)
			throw new PlayerError("Enter the computer and the agent's command.");
		return {
			host: hostOf(ssh.host),
			user: ssh.user || undefined,
			identityFile: ssh.identityFile || undefined,
			auth: ssh.auth ?? "key",
			command: ssh.command.map(String),
			cwd: settings.brain.cwd,
			port: settings.mcp.port,
		};
	}

	private async start() {
		if (this.running) return this.status;
		const settings = this.settings();
		const client = await this.client(undefined);
		mkdirSync(this.o.logs, { recursive: true });
		this.logFile = join(
			this.o.logs,
			`familiar-${stamp(this.deps.now())}.jsonl`,
		);
		this.status.problems = [];
		this.status.restartNeeded = false;
		this.status.client = client;
		this.status.brain = describeBrain(settings);
		const run = ++this.run;
		const log = this.log(this.logFile, run);
		const started = await this.deps.startFamiliar({
			paths: wowPaths(client),
			settings,
			settingsFile: this.o.settingsFile,
			log,
			logFile: this.logFile,
			version: this.o.version,
			secrets: this.deps.secrets,
			askpass: this.o.askpass,
			notes: {
				info: (text) => log.event("note", { level: "info", text }),
				warn: (text) => {
					log.event("note", { level: "warn", text });
					if (run === this.run) this.status.problems.push(text);
				},
			},
		});
		// Shut down while starting: this run is no longer wanted.
		if (run !== this.run) {
			started.stop();
			return this.status;
		}
		this.running = started;
		this.status.running = true;
		this.status.addon.installed = true;
		this.status.game.running = (await this.deps.clientProcesses()).length > 0;
		this.changed();
		return this.status;
	}

	/**
	 * Asks the brain one question without the game, as the app's Test button does: does it
	 * start, does it answer, how long does it take. The game tools say there is no game.
	 */
	private async testBrain(value: unknown) {
		const settings =
			value === undefined ? this.settings() : parseSettings(value);
		const timeout = Math.min(settings.brain.timeout, 60);
		const prepared = await prepareBrain(settings, {
			secrets: this.deps.secrets,
			askpass: this.o.askpass,
		});
		const brainSettings = { ...prepared.brain, timeout };
		const quiet: Log = { event: () => {}, say: () => {} };
		const game = new Game({ fetchTimeoutMs: 1000 });
		const brain: Brain & { stop?: () => void } =
			brainSettings.use === "model"
				? new ModelBrain(brainSettings, {
						log: quiet,
						tools: wowTools(game),
						chatgpt: this.chatgpt(),
					})
				: new AcpBrain(brainSettings, {
						folder: dirname(this.o.settingsFile),
						log: quiet,
						version: this.o.version,
						env: prepared.env,
					});
		const tools: string[] = [];
		const turn: Turn = {
			onTool: (title) => void tools.push(title.split(":")[0] ?? title),
			onNote: () => {},
			onPermission: async () => false,
		};
		const question: Question = {
			text: "This is a test from the Familiar app. Answer in one short sentence, without tools.",
			character: {},
		};
		const started = performance.now();
		try {
			const answer = await brain.ask(question, turn);
			return {
				ms: Math.round(performance.now() - started),
				answer: answer.slice(0, 300),
				tools,
			};
		} finally {
			brain.stop?.();
		}
	}
}

/** Reads requests from stdin until it closes, then stops. */
export async function serveSidecar(o: SidecarOptions): Promise<void> {
	const sidecar = new Sidecar(o);
	await sidecar.refresh();
	const decoder = new TextDecoder();
	let rest = "";
	const pending: Promise<void>[] = [];
	for await (const chunk of Bun.stdin.stream()) {
		const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
		rest = lines.pop() ?? "";
		// Requests run side by side: a sign-in that waits for the browser blocks nothing.
		for (const line of lines)
			pending.push(sidecar.handle(line).catch(() => {}));
	}
	if (rest) pending.push(sidecar.handle(rest).catch(() => {}));
	// The app is gone: stop at once, give replies a moment to finish, then leave. A sign-in
	// waiting for the browser does not keep Familiar running.
	sidecar.stop();
	await Promise.race([Promise.allSettled(pending), Bun.sleep(2000)]);
	process.exit(0);
}

function describeClient(client: string) {
	const { interface: iface, version } = clientVersion(client);
	return {
		client,
		version,
		interface: iface,
		installed: isInstalled(wowPaths(client)),
	};
}

/** The client folder from what the player chose: the folder, its parent, or the game's program. */
export function clientFolder(chosen: string): string | undefined {
	if (!chosen) return undefined;
	let dir = chosen.replace(/[\\/]+$/, "");
	try {
		if (statSync(dir).isFile()) dir = dirname(dir);
	} catch {
		return undefined;
	}
	for (const candidate of [dir, join(dir, "_forever_")])
		if (isClientFolder(candidate)) return candidate;
	return undefined;
}

function keyedProvider(value: unknown): Provider {
	if (typeof value === "string" && (KEYED as readonly string[]).includes(value))
		return value as Provider;
	throw new PlayerError("Choose a provider.");
}

function anyProvider(value: unknown): string {
	if (
		typeof value === "string" &&
		(PROVIDERS as readonly string[]).includes(value)
	)
		return value;
	throw new PlayerError("Choose a provider.");
}

function hostOf(value: unknown): string {
	const host = String(value ?? "").trim();
	// A host that starts with "-" would be read by ssh as an option.
	if (!host || host.startsWith("-") || /\s/.test(host))
		throw new PlayerError("Enter the computer's name or address.");
	return host;
}

/** What the player may read of an error: our own fixed words, or a generic sentence. */
function shown(error: unknown): string {
	if (
		error instanceof PlayerError ||
		error instanceof ListError ||
		error instanceof SecretError ||
		error instanceof ChatGptError
	)
		return error.message;
	if (error instanceof Error && error.message.startsWith("The settings"))
		return error.message;
	return `Something went wrong (${error instanceof Error ? error.name : typeof error}).`;
}

function stamp(ms: number): string {
	return new Date(ms)
		.toISOString()
		.slice(0, 19)
		.replace(/[-:]/g, "")
		.replace("T", "-");
}

function openUrl(url: string): void {
	const command =
		process.platform === "win32"
			? ["rundll32", "url.dll,FileProtocolHandler", url]
			: process.platform === "darwin"
				? ["open", url]
				: ["xdg-open", url];
	try {
		Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
	} catch {
		// The app shows the address too.
	}
}
