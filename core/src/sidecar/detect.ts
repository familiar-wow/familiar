// Finds what the player already has, for the setup screen of the desktop app: agents that speak
// ACP (Hermes, Codex, Claude Code, Gemini CLI, OpenClaw) and local model servers (Ollama,
// LM Studio). A missing program is an answer, never an error. Everything outside this file
// (environment, platform, programs, files, network) comes in through options, so tests run
// anywhere.
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import { run as defaultRun, launchable, type Runner } from "./run.ts";

type Env = Record<string, string | undefined>;
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface DetectOptions {
	env?: Env;
	platform?: NodeJS.Platform;
	run?: Runner;
	/** Full path of a program on PATH, or null. Defaults to Bun.which. */
	which?: (name: string) => string | null;
	exists?: (path: string) => boolean;
}

export interface FoundAgent {
	id: "hermes" | "codex" | "claude" | "gemini" | "openclaw";
	name: string;
	/** The ACP command to put into settings. */
	command: string[];
	/** Where its program was found. */
	path?: string;
	/** First line of `<program> --version`, at most 40 characters. */
	version?: string;
	ready: boolean;
	/** Fixed words: what is missing. */
	needs?: string;
}

export interface LocalModel {
	id: string;
	tools?: boolean;
	size?: number;
}

export interface LocalServer {
	kind: "ollama" | "lmstudio";
	name: string;
	/** OpenAI-compatible base URL. */
	baseUrl: string;
	running: boolean;
	/** The program was found, or the server answers. */
	installed: boolean;
	path?: string;
	/** The command that starts the server, when we know one. */
	start?: string[];
	/** Empty unless running. */
	models: LocalModel[];
}

interface Context {
	env: Env;
	platform: NodeJS.Platform;
	run: Runner;
	which: (name: string) => string | null;
	exists: (path: string) => boolean;
}

function context(opts: DetectOptions): Context {
	const c: Context = {
		env: opts.env ?? process.env,
		platform: opts.platform ?? process.platform,
		run: opts.run ?? defaultRun,
		exists: opts.exists ?? existsSync,
		// Search the PATH of the injected environment, not necessarily our own.
		which:
			opts.which ??
			((name) => {
				const PATH = envVar(c, "PATH");
				return PATH === undefined ? Bun.which(name) : Bun.which(name, { PATH });
			}),
	};
	return c;
}

/** Windows spells variables in any case (Path, LocalAppData); a plain object does not forgive that. */
function envVar(c: Context, name: string): string | undefined {
	let value = c.env[name];
	if (value === undefined && c.platform === "win32") {
		const key = Object.keys(c.env).find(
			(k) => k.toUpperCase() === name.toUpperCase(),
		);
		value = key === undefined ? undefined : c.env[key];
	}
	return value || undefined;
}

/** Windows paths stay Windows paths even when the tests run on Linux. */
const paths = (c: Context) => (c.platform === "win32" ? win32 : posix);

const home = (c: Context) =>
	envVar(c, c.platform === "win32" ? "USERPROFILE" : "HOME");

function firstExisting(
	c: Context,
	candidates: (string | undefined)[],
): string | undefined {
	return candidates.find((p): p is string => p !== undefined && c.exists(p));
}

interface Program {
	path: string;
	/** Found through PATH, so the bare name works in a command. */
	onPath: boolean;
}

/** PATH first, then the folders installers use that are often missing from PATH. */
function locate(
	c: Context,
	name: string,
	extraDirs: string[] = [],
): Program | undefined {
	const onPath = c.which(name);
	if (onPath) return { path: onPath, onPath: true };
	const p = paths(c);
	const dirs: (string | undefined)[] = [];
	if (c.platform === "win32") {
		const local = envVar(c, "LOCALAPPDATA");
		const appData = envVar(c, "APPDATA");
		const profile = home(c);
		dirs.push(
			local && p.join(local, "Programs", name),
			profile && p.join(profile, ".local", "bin"),
			appData && p.join(appData, "npm"), // npm installs .cmd shims here
		);
	} else {
		const h = home(c);
		if (h)
			dirs.push(p.join(h, ".local", "bin"), p.join(h, ".npm-global", "bin"));
	}
	dirs.push(...extraDirs);
	const files =
		c.platform === "win32" ? [`${name}.exe`, `${name}.cmd`] : [name];
	const path = firstExisting(
		c,
		dirs.flatMap((dir) => (dir ? files.map((f) => p.join(dir, f)) : [])),
	);
	return path ? { path, onPath: false } : undefined;
}

/** The bare name when PATH finds it (settings stay readable), else the full path. */
const commandFor = (program: Program, name: string) =>
	program.onPath ? name : program.path;

async function versionOf(
	c: Context,
	path: string,
): Promise<string | undefined> {
	const r = await c.run([path, "--version"], { timeoutMs: 5000 });
	if (r.code !== 0) return undefined;
	const line = `${r.stdout}\n${r.stderr}`
		.split(/\r?\n/)
		.map((l) => l.trim())
		.find(Boolean);
	return line?.slice(0, 40);
}

interface AgentSpec {
	id: FoundAgent["id"];
	name: string;
	program: string;
	/** Arguments that make the program itself speak ACP. */
	args?: string[];
	/** An npm package that speaks ACP for a program that does not. */
	adapter?: string;
	/** An environment variable the agent needs, and how to say that it is missing. */
	key?: { env: string; needs: string };
}

const AGENTS: AgentSpec[] = [
	{ id: "hermes", name: "Hermes Agent", program: "hermes", args: ["acp"] },
	{
		id: "codex",
		name: "Codex",
		program: "codex",
		adapter: "@agentclientprotocol/codex-acp",
	},
	{
		id: "claude",
		name: "Claude Code",
		program: "claude",
		adapter: "@agentclientprotocol/claude-agent-acp",
		// Subscriptions may not be used through the SDK (ADR 0001); only an API key works.
		key: {
			env: "ANTHROPIC_API_KEY",
			needs: "an Anthropic API key (ANTHROPIC_API_KEY)",
		},
	},
	{
		id: "gemini",
		name: "Gemini CLI",
		program: "gemini",
		args: ["--experimental-acp"],
	},
	{ id: "openclaw", name: "OpenClaw", program: "openclaw", args: ["acp"] },
];

/** The agents whose program is installed, ready or with the words for what is missing. */
export async function findAgents(
	opts: DetectOptions = {},
): Promise<FoundAgent[]> {
	const c = context(opts);
	const programFiles = envVar(c, "ProgramFiles");
	const npx = locate(
		c,
		"npx",
		c.platform === "win32" && programFiles
			? [win32.join(programFiles, "nodejs")]
			: [],
	);
	const found = AGENTS.flatMap((spec) => {
		const program = locate(c, spec.program);
		return program ? [{ spec, program }] : [];
	});
	return Promise.all(
		found.map(async ({ spec, program }): Promise<FoundAgent> => {
			const needs: string[] = [];
			let command: string[];
			if (spec.adapter) {
				if (!npx) needs.push("Node.js (npx) for the ACP adapter");
				command = [npx ? commandFor(npx, "npx") : "npx", "-y", spec.adapter];
			} else {
				command = [commandFor(program, spec.program), ...(spec.args ?? [])];
			}
			// The command stays readable for settings; launchable turns it into what Bun can
			// start when it is spawned. A Windows script it cannot start safely is not ready.
			try {
				launchable(command, c);
			} catch {
				needs.push(
					"an install folder without %, !, ^, &, |, <, > in its path (Windows cannot start the script from there)",
				);
			}
			if (spec.key && !envVar(c, spec.key.env)) needs.push(spec.key.needs);
			const version = await versionOf(c, program.path);
			return {
				id: spec.id,
				name: spec.name,
				command,
				path: program.path,
				...(version ? { version } : {}),
				ready: needs.length === 0,
				...(needs.length > 0 ? { needs: needs.join(" and ") } : {}),
			};
		}),
	);
}

const OLLAMA = "http://127.0.0.1:11434";
const LMSTUDIO = "http://127.0.0.1:1234";
/** /api/show is one request per model; 20 covers a real collection without flooding the server. */
const MAX_SHOW = 20;

/** The parsed answer, or undefined for anything else: no server, an error, a slow server, not JSON. */
async function getJson(
	fetch: Fetch,
	url: string,
	init: RequestInit = {},
): Promise<unknown> {
	try {
		const res = await fetch(url, {
			...init,
			signal: AbortSignal.timeout(2000),
		});
		if (!res.ok) return undefined;
		return await res.json();
	} catch {
		return undefined;
	}
}

async function ollamaModels(fetch: Fetch): Promise<LocalModel[] | undefined> {
	const tags = (await getJson(fetch, `${OLLAMA}/api/tags`)) as
		| { models?: unknown }
		| undefined;
	if (!Array.isArray(tags?.models)) return undefined;
	const models: LocalModel[] = [];
	for (const m of tags.models as ({ name?: unknown; size?: unknown } | null)[])
		if (typeof m?.name === "string")
			models.push({
				id: m.name,
				...(typeof m.size === "number" ? { size: m.size } : {}),
			});
	await Promise.all(
		models.slice(0, MAX_SHOW).map(async (model) => {
			const show = (await getJson(fetch, `${OLLAMA}/api/show`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: model.id }),
			})) as { capabilities?: unknown } | undefined;
			// Older servers have no capabilities field; then we do not know.
			if (Array.isArray(show?.capabilities))
				model.tools = show.capabilities.includes("tools");
		}),
	);
	return models;
}

async function lmStudioModels(fetch: Fetch): Promise<LocalModel[] | undefined> {
	const list = (await getJson(fetch, `${LMSTUDIO}/v1/models`)) as
		| { data?: unknown }
		| undefined;
	if (!Array.isArray(list?.data)) return undefined;
	return (list.data as ({ id?: unknown } | null)[]).flatMap((m) =>
		typeof m?.id === "string" ? [{ id: m.id }] : [],
	);
}

/**
 * The models of any OpenAI-compatible server, such as Ollama on another PC; undefined when
 * nothing there answers like one. `baseUrl` ends where `/models` follows, such as
 * `http://192.168.1.20:11434/v1`.
 */
export async function serverModels(
	baseUrl: string,
	opts: { fetch?: Fetch } = {},
): Promise<LocalModel[] | undefined> {
	const list = (await getJson(
		opts.fetch ?? fetch,
		`${baseUrl.replace(/\/+$/, "")}/models`,
	)) as { data?: unknown } | undefined;
	if (!Array.isArray(list?.data)) return undefined;
	return (list.data as ({ id?: unknown } | null)[]).flatMap((m) =>
		typeof m?.id === "string" ? [{ id: m.id }] : [],
	);
}

/** %VAR% in registry values (REG_EXPAND_SZ), from the injected environment. */
function expand(c: Context, value: string): string {
	return value.replace(
		/%([^%]+)%/g,
		(all, name: string) => envVar(c, name) ?? all,
	);
}

const UNINSTALL = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
const ROOTS = [
	{ short: "HKCU", long: "HKEY_CURRENT_USER" },
	{ short: "HKLM", long: "HKEY_LOCAL_MACHINE" },
];
/** Uninstall keys whose data mentions the product, read per root; real matches are one or two. */
const MAX_KEYS = 5;

/** A string value of one key, from `reg query <key> /v <name>`; undefined if it is not there. */
async function regValue(
	c: Context,
	key: string,
	name: "DisplayName" | "InstallLocation" | "DisplayIcon",
): Promise<string | undefined> {
	const r = await c.run(["reg", "query", key, "/v", name], { timeoutMs: 5000 });
	if (r.code !== 0) return undefined;
	const m = r.stdout.match(
		new RegExp(`^\\s+${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.+?)\\s*$`, "im"),
	);
	return m?.[1] ? expand(c, m[1]) : undefined;
}

const unquote = (value: string) => value.trim().replace(/^"|"$/g, "").trim();

/**
 * The last resort on Windows: the uninstall entries installers write, which name the install
 * folder (InstallLocation) or a file inside it (DisplayIcon). Only a program that exists counts.
 */
async function fromUninstallKeys(
	c: Context,
	product: string,
	exe: string,
): Promise<string | undefined> {
	for (const root of ROOTS) {
		// `/f <product> /d` prints only the values whose data matches, so it finds the keys; their
		// InstallLocation and DisplayIcon need not contain the product name and are read below.
		const r = await c.run(
			[
				"reg",
				"query",
				`${root.short}\\${UNINSTALL}`,
				"/s",
				"/f",
				product,
				"/d",
			],
			{ timeoutMs: 5000 },
		);
		const keys = [
			...new Set(
				r.stdout
					.split(/\r?\n/)
					.map((line) => line.trimEnd())
					.filter((line) => line.startsWith(`${root.long}\\`))
					// The short root is the documented spelling for a key name (reg query docs).
					.map((line) => root.short + line.slice(root.long.length)),
			),
		].slice(0, MAX_KEYS);
		for (const key of keys) {
			const [name, location, icon] = await Promise.all([
				regValue(c, key, "DisplayName"),
				regValue(c, key, "InstallLocation"),
				regValue(c, key, "DisplayIcon"),
			]);
			// A match in a publisher or a comment is another program.
			if (!name?.toLowerCase().includes(product.toLowerCase())) continue;
			const dir = location && unquote(location);
			const file = icon && unquote(icon.replace(/,\s*-?\d+$/, "")); // may end in an icon index
			const found = firstExisting(c, [
				dir ? win32.join(dir, exe) : undefined,
				file ? win32.join(win32.dirname(file), exe) : undefined,
			]);
			if (found) return found;
		}
	}
	return undefined;
}

async function ollamaProgram(c: Context): Promise<string | undefined> {
	const onPath = c.which("ollama");
	if (onPath) return onPath;
	if (c.platform !== "win32") return undefined;
	const local = envVar(c, "LOCALAPPDATA");
	return (
		firstExisting(c, [
			local && win32.join(local, "Programs", "Ollama", "ollama.exe"),
		]) ?? fromUninstallKeys(c, "Ollama", "ollama.exe")
	);
}

/** `lms` can start the server; the app alone cannot be started headless, so it has no start. */
async function lmStudioProgram(
	c: Context,
): Promise<{ path: string; lms: boolean } | undefined> {
	const onPath = c.which("lms");
	if (onPath) return { path: onPath, lms: true };
	const h = home(c);
	const lms = firstExisting(c, [
		h &&
			paths(c).join(
				h,
				".lmstudio",
				"bin",
				c.platform === "win32" ? "lms.exe" : "lms",
			),
	]);
	if (lms) return { path: lms, lms: true };
	if (c.platform !== "win32") return undefined;
	const local = envVar(c, "LOCALAPPDATA");
	const app =
		firstExisting(c, [
			local && win32.join(local, "Programs", "LM Studio", "LM Studio.exe"),
		]) ?? (await fromUninstallKeys(c, "LM Studio", "LM Studio.exe"));
	return app ? { path: app, lms: false } : undefined;
}

/** Always both kinds, so the setup screen can say "not installed". */
export async function findLocalServers(
	opts: DetectOptions & { fetch?: Fetch } = {},
): Promise<LocalServer[]> {
	const c = context(opts);
	const f = opts.fetch ?? fetch;
	const [oModels, oPath, lModels, lm] = await Promise.all([
		ollamaModels(f),
		ollamaProgram(c),
		lmStudioModels(f),
		lmStudioProgram(c),
	]);
	return [
		{
			kind: "ollama",
			name: "Ollama",
			baseUrl: `${OLLAMA}/v1`,
			running: oModels !== undefined,
			installed: oModels !== undefined || oPath !== undefined,
			...(oPath ? { path: oPath, start: [oPath, "serve"] } : {}),
			models: oModels ?? [],
		},
		{
			kind: "lmstudio",
			name: "LM Studio",
			baseUrl: `${LMSTUDIO}/v1`,
			running: lModels !== undefined,
			installed: lModels !== undefined || lm !== undefined,
			...(lm ? { path: lm.path } : {}),
			...(lm?.lms ? { start: [lm.path, "server", "start"] } : {}),
			models: lModels ?? [],
		},
	];
}
