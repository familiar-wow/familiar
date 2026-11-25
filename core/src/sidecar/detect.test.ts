import { expect, test } from "bun:test";
import {
	findAgents,
	findLocalServers,
	type LocalServer,
	serverModels,
} from "./detect.ts";
import { launchable, type Runner, type RunResult } from "./run.ts";

const ok = (stdout: string): RunResult => ({
	code: 0,
	stdout,
	stderr: "",
	timedOut: false,
});
const missing: RunResult = {
	code: null,
	stdout: "",
	stderr: "not found",
	timedOut: false,
};

/** A runner that answers from a table keyed by the joined command, and remembers every call. */
function fakeRun(answers: Record<string, RunResult> = {}) {
	const calls: { cmd: string[]; timeoutMs?: number }[] = [];
	const runner: Runner = async (cmd, opts) => {
		calls.push({ cmd, timeoutMs: opts?.timeoutMs });
		return answers[cmd.join(" ")] ?? missing;
	};
	return { runner, calls };
}

const onPath =
	(programs: Record<string, string>) =>
	(name: string): string | null =>
		programs[name] ?? null;

const files =
	(...present: string[]) =>
	(path: string) =>
		present.includes(path);

const none = () => false;

// ---- agents ----

test("finds no agents when no program is installed", async () => {
	const { runner, calls } = fakeRun();
	const agents = await findAgents({
		env: { HOME: "/home/p" },
		platform: "linux",
		run: runner,
		which: onPath({}),
		exists: none,
	});
	expect(agents).toEqual([]);
	expect(calls).toEqual([]);
});

test("finds every agent with its ACP command and version", async () => {
	const { runner, calls } = fakeRun({
		"/usr/bin/hermes --version": ok("Hermes Agent v0.9.0\nmore text\n"),
		"/usr/bin/codex --version": ok("codex-cli 0.50.0\n"),
		"/usr/bin/claude --version": ok("2.1.0 (Claude Code)\n"),
		"/usr/bin/gemini --version": ok(`${"x".repeat(60)}\n`),
	});
	const agents = await findAgents({
		env: { HOME: "/home/p", ANTHROPIC_API_KEY: "sk-ant-test" },
		platform: "linux",
		run: runner,
		which: onPath({
			hermes: "/usr/bin/hermes",
			codex: "/usr/bin/codex",
			claude: "/usr/bin/claude",
			gemini: "/usr/bin/gemini",
			openclaw: "/usr/bin/openclaw",
			npx: "/usr/bin/npx",
		}),
		exists: none,
	});
	expect(agents).toEqual([
		{
			id: "hermes",
			name: "Hermes Agent",
			command: ["hermes", "acp"],
			path: "/usr/bin/hermes",
			version: "Hermes Agent v0.9.0",
			ready: true,
		},
		{
			id: "codex",
			name: "Codex",
			command: ["npx", "-y", "@agentclientprotocol/codex-acp"],
			path: "/usr/bin/codex",
			version: "codex-cli 0.50.0",
			ready: true,
		},
		{
			id: "claude",
			name: "Claude Code",
			command: ["npx", "-y", "@agentclientprotocol/claude-agent-acp"],
			path: "/usr/bin/claude",
			version: "2.1.0 (Claude Code)",
			ready: true,
		},
		{
			id: "gemini",
			name: "Gemini CLI",
			command: ["gemini", "--experimental-acp"],
			path: "/usr/bin/gemini",
			version: "x".repeat(40),
			ready: true,
		},
		// `openclaw --version` failed: no version, still found.
		{
			id: "openclaw",
			name: "OpenClaw",
			command: ["openclaw", "acp"],
			path: "/usr/bin/openclaw",
			ready: true,
		},
	]);
	expect(calls.every((c) => c.timeoutMs === 5000)).toBe(true);
	// The key is read, never handed out.
	expect(JSON.stringify(agents)).not.toContain("sk-ant-test");
});

test("adapter agents are not ready without npx", async () => {
	const agents = await findAgents({
		env: { HOME: "/home/p", ANTHROPIC_API_KEY: "sk-ant-test" },
		platform: "linux",
		run: fakeRun().runner,
		which: onPath({ codex: "/usr/bin/codex", claude: "/usr/bin/claude" }),
		exists: none,
	});
	expect(agents.map((a) => [a.id, a.ready, a.needs, a.command[0]])).toEqual([
		["codex", false, "Node.js (npx) for the ACP adapter", "npx"],
		["claude", false, "Node.js (npx) for the ACP adapter", "npx"],
	]);
});

test("Claude Code needs an API key, a subscription does not count", async () => {
	const withNpx = await findAgents({
		env: { HOME: "/home/p" },
		platform: "linux",
		run: fakeRun().runner,
		which: onPath({ claude: "/usr/bin/claude", npx: "/usr/bin/npx" }),
		exists: none,
	});
	expect(withNpx[0]).toMatchObject({
		id: "claude",
		ready: false,
		needs: "an Anthropic API key (ANTHROPIC_API_KEY)",
	});
	const withoutNpx = await findAgents({
		env: { HOME: "/home/p", ANTHROPIC_API_KEY: "" },
		platform: "linux",
		run: fakeRun().runner,
		which: onPath({ claude: "/usr/bin/claude" }),
		exists: none,
	});
	expect(withoutNpx[0]?.needs).toBe(
		"Node.js (npx) for the ACP adapter and an Anthropic API key (ANTHROPIC_API_KEY)",
	);
});

test("finds programs off PATH in the usual Windows folders", async () => {
	const hermes = "C:\\Users\\P\\.local\\bin\\hermes.exe";
	const codex = "C:\\Users\\P\\AppData\\Roaming\\npm\\codex.cmd";
	const gemini = "C:\\Users\\P\\AppData\\Local\\Programs\\gemini\\gemini.exe";
	const npx = "C:\\Program Files\\nodejs\\npx.cmd";
	const agents = await findAgents({
		// Windows spells variables in any case.
		env: {
			USERPROFILE: "C:\\Users\\P",
			LocalAppData: "C:\\Users\\P\\AppData\\Local",
			APPDATA: "C:\\Users\\P\\AppData\\Roaming",
			ProgramFiles: "C:\\Program Files",
		},
		platform: "win32",
		run: fakeRun().runner,
		which: onPath({}),
		exists: files(hermes, codex, gemini, npx),
	});
	expect(agents.map((a) => [a.id, a.path, a.command, a.ready])).toEqual([
		["hermes", hermes, [hermes, "acp"], true],
		["codex", codex, [npx, "-y", "@agentclientprotocol/codex-acp"], true],
		["gemini", gemini, [gemini, "--experimental-acp"], true],
	]);
});

test("finds programs off PATH in ~/.local/bin and ~/.npm-global/bin on Linux", async () => {
	const agents = await findAgents({
		env: { HOME: "/home/p" },
		platform: "linux",
		run: fakeRun().runner,
		which: onPath({}),
		exists: files("/home/p/.local/bin/hermes", "/home/p/.npm-global/bin/codex"),
	});
	expect(agents.map((a) => [a.id, a.command[0], a.ready])).toEqual([
		["hermes", "/home/p/.local/bin/hermes", true],
		["codex", "npx", false],
	]);
});

test("Windows npm scripts come back with a command launchable can start", async () => {
	const nodejs = "C:\\Program Files\\nodejs";
	const npx = `${nodejs}\\npx.cmd`;
	const node = `${nodejs}\\node.exe`;
	const cli = `${nodejs}\\node_modules\\npm\\bin\\npx-cli.js`;
	const codex = "C:\\Users\\P Q\\AppData\\Roaming\\npm\\codex.cmd";
	const gemini = "C:\\Users\\P Q\\AppData\\Roaming\\npm\\gemini.cmd";
	const opts = {
		env: {
			USERPROFILE: "C:\\Users\\P Q",
			APPDATA: "C:\\Users\\P Q\\AppData\\Roaming",
			ProgramFiles: "C:\\Program Files",
		},
		platform: "win32" as const,
		which: onPath({ npx }),
		exists: files(codex, gemini, node, cli),
	};
	const { runner, calls } = fakeRun();
	const agents = await findAgents({ ...opts, run: runner });
	// Settings keep the readable command ...
	expect(agents.map((a) => [a.id, a.command, a.ready])).toEqual([
		["codex", ["npx", "-y", "@agentclientprotocol/codex-acp"], true],
		["gemini", [gemini, "--experimental-acp"], true],
	]);
	// ... which the spawning side turns into one Bun can start.
	expect(agents.map((a) => launchable(a.command, opts))).toEqual([
		[node, cli, "-y", "@agentclientprotocol/codex-acp"],
		["cmd.exe", "/d", "/s", "/c", `""${gemini}" "--experimental-acp""`],
	]);
	// The version probe goes through run(), which applies launchable itself.
	expect(calls.map((c) => c.cmd)).toEqual([
		[codex, "--version"],
		[gemini, "--version"],
	]);
});

test("a Windows script cmd cannot start safely is not ready", async () => {
	const gemini = "C:\\Users\\Tom & Jerry\\AppData\\Roaming\\npm\\gemini.cmd";
	const agents = await findAgents({
		env: {
			USERPROFILE: "C:\\Users\\Tom & Jerry",
			APPDATA: "C:\\Users\\Tom & Jerry\\AppData\\Roaming",
		},
		platform: "win32",
		run: fakeRun().runner,
		which: onPath({}),
		exists: files(gemini),
	});
	expect(agents).toEqual([
		{
			id: "gemini",
			name: "Gemini CLI",
			command: [gemini, "--experimental-acp"],
			path: gemini,
			ready: false,
			needs:
				"an install folder without %, !, ^, &, |, <, > in its path (Windows cannot start the script from there)",
		},
	]);
});

// ---- local servers ----

interface Call {
	url: string;
	method: string;
	body?: string;
	signal?: AbortSignal | null;
}

/** A fetch that answers from a handler and remembers every request. */
function fakeFetch(handler: (call: Call) => Response | undefined) {
	const calls: Call[] = [];
	const fetch = async (url: string, init: RequestInit = {}) => {
		const call: Call = {
			url,
			method: init.method ?? "GET",
			body: typeof init.body === "string" ? init.body : undefined,
			signal: init.signal,
		};
		calls.push(call);
		const res = handler(call);
		if (!res) throw new TypeError("connection refused");
		return res;
	};
	return { fetch, calls };
}

const json = (value: unknown) => Response.json(value);

const NOTHING: LocalServer = {
	kind: "ollama",
	name: "Ollama",
	baseUrl: "http://127.0.0.1:11434/v1",
	running: false,
	installed: false,
	models: [],
};
const NO_LMSTUDIO: LocalServer = {
	kind: "lmstudio",
	name: "LM Studio",
	baseUrl: "http://127.0.0.1:1234/v1",
	running: false,
	installed: false,
	models: [],
};

test("lists the models of another OpenAI-compatible server, or says nothing answered", async () => {
	const { fetch, calls } = fakeFetch((call) =>
		call.url === "http://192.168.1.20:11434/v1/models"
			? json({ data: [{ id: "qwen3:8b" }, { id: 7 }, null, { id: "llama4" }] })
			: undefined,
	);
	expect(
		await serverModels("http://192.168.1.20:11434/v1/", { fetch }),
	).toEqual([{ id: "qwen3:8b" }, { id: "llama4" }]);
	expect(calls[0]?.signal).toBeDefined();
	expect(await serverModels("http://10.0.0.9/v1", { fetch })).toBeUndefined();
});

test("reports both servers as not installed when nothing is there", async () => {
	const { runner, calls } = fakeRun();
	const servers = await findLocalServers({
		env: { HOME: "/home/p" },
		platform: "linux",
		fetch: fakeFetch(() => undefined).fetch,
		run: runner,
		which: onPath({}),
		exists: none,
	});
	expect(servers).toEqual([NOTHING, NO_LMSTUDIO]);
	// The registry is a Windows thing.
	expect(calls).toEqual([]);
});

test("lists Ollama's models with tool support, LM Studio installed but off", async () => {
	const { fetch, calls } = fakeFetch(({ url, method, body }) => {
		if (url === "http://127.0.0.1:11434/api/tags" && method === "GET")
			return json({
				models: [
					{ name: "qwen3:8b", size: 5200000000 },
					{ name: "gemma2:2b", size: 1600000000 },
					{ name: "old:1b" },
				],
			});
		if (url === "http://127.0.0.1:11434/api/show" && method === "POST") {
			const model = JSON.parse(body ?? "{}").model;
			if (model === "qwen3:8b")
				return json({ capabilities: ["completion", "tools", "thinking"] });
			if (model === "gemma2:2b") return json({ capabilities: ["completion"] });
			return json({ modelfile: "FROM old" }); // an older server: no capabilities
		}
		return undefined;
	});
	const lms = "/home/p/.lmstudio/bin/lms";
	const servers = await findLocalServers({
		env: { HOME: "/home/p" },
		platform: "linux",
		fetch,
		run: fakeRun().runner,
		which: onPath({ ollama: "/usr/local/bin/ollama" }),
		exists: files(lms),
	});
	expect(servers).toEqual([
		{
			...NOTHING,
			running: true,
			installed: true,
			path: "/usr/local/bin/ollama",
			start: ["/usr/local/bin/ollama", "serve"],
			models: [
				{ id: "qwen3:8b", size: 5200000000, tools: true },
				{ id: "gemma2:2b", size: 1600000000, tools: false },
				{ id: "old:1b" },
			],
		},
		{
			...NO_LMSTUDIO,
			installed: true,
			path: lms,
			start: [lms, "server", "start"],
		},
	]);
	expect(servers[0]?.models[2]).not.toHaveProperty("tools");
	expect(calls.every((c) => c.signal instanceof AbortSignal)).toBe(true);
});

test("asks Ollama about at most 20 models", async () => {
	const names = Array.from({ length: 25 }, (_, i) => `m${i}`);
	const { fetch, calls } = fakeFetch(({ url }) =>
		url.endsWith("/api/tags")
			? json({ models: names.map((name) => ({ name })) })
			: url.endsWith("/api/show")
				? json({ capabilities: ["tools"] })
				: undefined,
	);
	const [ollama] = await findLocalServers({
		env: {},
		platform: "linux",
		fetch,
		run: fakeRun().runner,
		which: onPath({}),
		exists: none,
	});
	expect(ollama?.models).toHaveLength(25);
	expect(calls.filter((c) => c.url.endsWith("/api/show"))).toHaveLength(20);
	expect(ollama?.models[19]?.tools).toBe(true);
	expect(ollama?.models[20]?.tools).toBeUndefined();
	// Running without a program we can find (a container, WSL): installed, but no start.
	expect(ollama).toMatchObject({ running: true, installed: true });
	expect(ollama?.start).toBeUndefined();
});

test("lists LM Studio's models when it runs", async () => {
	const { fetch } = fakeFetch(({ url }) =>
		url === "http://127.0.0.1:1234/v1/models"
			? json({
					object: "list",
					data: [{ id: "qwen/qwen3-8b" }, { id: "text-embedding-nomic" }],
				})
			: undefined,
	);
	const [, lmstudio] = await findLocalServers({
		env: {},
		platform: "linux",
		fetch,
		run: fakeRun().runner,
		which: onPath({ lms: "/usr/bin/lms" }),
		exists: none,
	});
	expect(lmstudio).toMatchObject({
		running: true,
		installed: true,
		start: ["/usr/bin/lms", "server", "start"],
		models: [{ id: "qwen/qwen3-8b" }, { id: "text-embedding-nomic" }],
	});
});

test("a server that answers with an error or no JSON is not running", async () => {
	const { fetch } = fakeFetch(({ url }) =>
		url.includes("11434")
			? new Response("boom", { status: 500 })
			: new Response("<html>", { status: 200 }),
	);
	const servers = await findLocalServers({
		env: {},
		platform: "linux",
		fetch,
		run: fakeRun().runner,
		which: onPath({}),
		exists: none,
	});
	expect(servers).toEqual([NOTHING, NO_LMSTUDIO]);
});

test("finds the Windows default install folders", async () => {
	const ollama = "C:\\Users\\P\\AppData\\Local\\Programs\\Ollama\\ollama.exe";
	const app =
		"C:\\Users\\P\\AppData\\Local\\Programs\\LM Studio\\LM Studio.exe";
	const { runner, calls } = fakeRun();
	const servers = await findLocalServers({
		env: {
			USERPROFILE: "C:\\Users\\P",
			LOCALAPPDATA: "C:\\Users\\P\\AppData\\Local",
		},
		platform: "win32",
		fetch: fakeFetch(() => undefined).fetch,
		run: runner,
		which: onPath({}),
		exists: files(ollama, app),
	});
	expect(servers[0]).toMatchObject({
		installed: true,
		path: ollama,
		start: [ollama, "serve"],
	});
	// The app alone cannot start a headless server.
	expect(servers[1]).toMatchObject({ installed: true, path: app });
	expect(servers[1]?.start).toBeUndefined();
	expect(calls).toEqual([]);
});

// The shape of `reg query <key> /s /f <name> /d`: CRLF lines, four-space indents, a key line
// per match, followed by only the values whose data matched. `/v <name>` prints the key line
// and that one value. Layout as in Microsoft's examples (see detect.ts); values are made up.
const UNINSTALL = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
const HKCU_KEY = (id: string) => `HKCU\\${UNINSTALL}\\${id}`;
const HKLM_KEY = (id: string) => `HKLM\\${UNINSTALL}\\${id}`;
const long = (key: string) =>
	key
		.replace(/^HKCU\\/, "HKEY_CURRENT_USER\\")
		.replace(/^HKLM\\/, "HKEY_LOCAL_MACHINE\\");

/** `reg query <root>\...\Uninstall /s /f <product> /d` with these keys and matching values. */
function search(keys: Record<string, string[]>): RunResult {
	const blocks = Object.entries(keys).map(([key, values]) =>
		[long(key), ...values.map((v) => `    ${v}`), ""].join("\r\n"),
	);
	const count = Object.values(keys).flat().length;
	return ok(
		["", ...blocks, `End of search: ${count} match(es) found.`, ""].join(
			"\r\n",
		),
	);
}

/** `reg query <key> /v <name>` answers for every value of a key. */
function values(
	key: string,
	vals: Record<string, [type: string, data: string]>,
): Record<string, RunResult> {
	return Object.fromEntries(
		Object.entries(vals).map(([name, [type, data]]) => [
			`reg query ${key} /v ${name}`,
			ok(
				["", long(key), `    ${name}    ${type}    ${data}`, "", ""].join(
					"\r\n",
				),
			),
		]),
	);
}

const NO_MATCH: RunResult = {
	code: 1,
	stdout: "\r\nEnd of search: 0 match(es) found.\r\n",
	stderr: "",
	timedOut: false,
};

const LMSTUDIO_KEY = HKCU_KEY("0a1b2c3d-lm-studio");
const OLLAMA_KEY = HKLM_KEY("{44E83376-CE68-45EB-8FC1-393500EB558C}_is1");
const OLLAMA_GUI_KEY = HKLM_KEY("OllamaGui");

const searchFor = (root: "HKCU" | "HKLM", product: string) =>
	`reg query ${root}\\${UNINSTALL} /s /f ${product} /d`;

test("falls back to the uninstall keys in the Windows registry", async () => {
	const ollama = "C:\\Program Files\\Ollama\\ollama.exe";
	const app = "D:\\Apps\\LM Studio\\LM Studio.exe";
	const { runner, calls } = fakeRun({
		[searchFor("HKCU", "Ollama")]: NO_MATCH,
		[searchFor("HKLM", "Ollama")]: search({
			[OLLAMA_KEY]: [
				"Inno Setup: App Path    REG_SZ    %ProgramFiles%\\Ollama",
				"InstallLocation    REG_EXPAND_SZ    %ProgramFiles%\\Ollama\\",
				"DisplayName    REG_SZ    Ollama version 0.12.6",
				"Publisher    REG_SZ    Ollama",
			],
			[OLLAMA_GUI_KEY]: ["InstallLocation    REG_SZ    C:\\Tools\\OllamaGui"],
		}),
		...values(OLLAMA_KEY, {
			DisplayName: ["REG_SZ", "Ollama version 0.12.6"],
			InstallLocation: ["REG_EXPAND_SZ", "%ProgramFiles%\\Ollama\\"],
			DisplayIcon: ["REG_SZ", "%ProgramFiles%\\Ollama\\app.ico"],
		}),
		...values(OLLAMA_GUI_KEY, {
			DisplayName: ["REG_SZ", "Ollama GUI"],
			InstallLocation: ["REG_SZ", "C:\\Tools\\OllamaGui"],
		}),
		[searchFor("HKCU", "LM Studio")]: search({
			[LMSTUDIO_KEY]: [
				"DisplayName    REG_SZ    LM Studio 0.3.30",
				'UninstallString    REG_SZ    "D:\\Apps\\LM Studio\\Uninstall LM Studio.exe" /currentuser',
				'DisplayIcon    REG_SZ    "D:\\Apps\\LM Studio\\LM Studio.exe",0',
			],
		}),
		...values(LMSTUDIO_KEY, {
			DisplayName: ["REG_SZ", "LM Studio 0.3.30"],
			DisplayIcon: ["REG_SZ", '"D:\\Apps\\LM Studio\\LM Studio.exe",0'],
		}),
	});
	const servers = await findLocalServers({
		env: {
			USERPROFILE: "C:\\Users\\P",
			LOCALAPPDATA: "C:\\Users\\P\\AppData\\Local",
			ProgramFiles: "C:\\Program Files",
		},
		platform: "win32",
		fetch: fakeFetch(() => undefined).fetch,
		run: runner,
		which: onPath({}),
		// C:\Tools\OllamaGui\ollama.exe is named too, but does not exist.
		exists: files(ollama, app),
	});
	expect(servers[0]).toMatchObject({
		installed: true,
		running: false,
		path: ollama,
		start: [ollama, "serve"],
	});
	expect(servers[1]).toMatchObject({ installed: true, path: app });
	// Both servers are looked up at the same time, so only the order per product is fixed.
	const searches = (product: string) =>
		calls.map((c) => c.cmd).filter((cmd) => cmd[5] === product);
	expect(searches("Ollama")).toEqual([
		["reg", "query", `HKCU\\${UNINSTALL}`, "/s", "/f", "Ollama", "/d"],
		["reg", "query", `HKLM\\${UNINSTALL}`, "/s", "/f", "Ollama", "/d"],
	]);
	// Found under HKCU, so HKLM is not asked.
	expect(searches("LM Studio")).toEqual([
		["reg", "query", `HKCU\\${UNINSTALL}`, "/s", "/f", "LM Studio", "/d"],
	]);
	// The keys are read by name, without the data filter; the first key already has it.
	const reads = calls.map((c) => c.cmd).filter((cmd) => cmd[3] === "/v");
	expect(reads.map((cmd) => `${cmd[2]} ${cmd[4]}`).sort()).toEqual(
		[
			`${LMSTUDIO_KEY} DisplayIcon`,
			`${LMSTUDIO_KEY} DisplayName`,
			`${LMSTUDIO_KEY} InstallLocation`,
			`${OLLAMA_KEY} DisplayIcon`,
			`${OLLAMA_KEY} DisplayName`,
			`${OLLAMA_KEY} InstallLocation`,
		].sort(),
	);
	expect(calls.every((c) => c.timeoutMs === 5000)).toBe(true);
});

test("finds an install whose folder and icon do not name the product", async () => {
	// Only DisplayName and Publisher contain "Ollama", so the search prints only those two.
	const key = HKCU_KEY("{0F3A}_is1");
	const ollama = "D:\\AI\\server\\ollama.exe";
	const lmKey = HKCU_KEY("lmstudio");
	const app = "E:\\x\\LM Studio.exe";
	const { runner } = fakeRun({
		[searchFor("HKCU", "Ollama")]: search({
			[key]: [
				"DisplayName    REG_SZ    Ollama version 0.12.6",
				"Publisher    REG_SZ    Ollama",
			],
		}),
		...values(key, {
			DisplayName: ["REG_SZ", "Ollama version 0.12.6"],
			InstallLocation: ["REG_SZ", "D:\\AI\\server\\"],
			DisplayIcon: ["REG_SZ", "D:\\AI\\server\\app.ico"],
		}),
		// No InstallLocation at all; the icon is the program, in a folder without the name.
		[searchFor("HKCU", "LM Studio")]: search({
			[lmKey]: ["DisplayName    REG_SZ    LM Studio"],
		}),
		...values(lmKey, {
			DisplayName: ["REG_SZ", "LM Studio"],
			DisplayIcon: ["REG_SZ", "E:\\x\\LM Studio.exe,0"],
		}),
	});
	const servers = await findLocalServers({
		env: {},
		platform: "win32",
		fetch: fakeFetch(() => undefined).fetch,
		run: runner,
		which: onPath({}),
		exists: files(ollama, app),
	});
	expect(servers[0]).toMatchObject({ installed: true, path: ollama });
	expect(servers[1]).toMatchObject({ installed: true, path: app });
});

test("a key that names the product only in other values is another program", async () => {
	const key = HKCU_KEY("OpenWebUI");
	const bundled = "C:\\WebUI\\ollama.exe";
	const servers = await findLocalServers({
		env: {},
		platform: "win32",
		fetch: fakeFetch(() => undefined).fetch,
		run: fakeRun({
			[searchFor("HKCU", "Ollama")]: search({
				[key]: ["Comments    REG_SZ    A web front end for Ollama"],
			}),
			...values(key, {
				DisplayName: ["REG_SZ", "Open WebUI"],
				InstallLocation: ["REG_SZ", "C:\\WebUI"],
			}),
		}).runner,
		which: onPath({}),
		exists: files(bundled),
	});
	expect(servers).toEqual([NOTHING, NO_LMSTUDIO]);
});

test("reads at most 5 matching keys per registry root", async () => {
	const keys = Array.from({ length: 7 }, (_, i) => HKCU_KEY(`Ollama-${i}`));
	const { runner, calls } = fakeRun({
		[searchFor("HKCU", "Ollama")]: search(
			Object.fromEntries(
				keys.map((k) => [k, ["DisplayName    REG_SZ    Ollama"]]),
			),
		),
		...Object.assign(
			{},
			...keys.map((k) => values(k, { DisplayName: ["REG_SZ", "Ollama"] })),
		),
	});
	await findLocalServers({
		env: {},
		platform: "win32",
		fetch: fakeFetch(() => undefined).fetch,
		run: runner,
		which: onPath({}),
		exists: none,
	});
	const read = new Set(
		calls.filter((c) => c.cmd[3] === "/v").map((c) => c.cmd[2]),
	);
	expect([...read]).toEqual(keys.slice(0, 5));
});

test("ignores uninstall entries whose program is gone", async () => {
	const servers = await findLocalServers({
		env: { ProgramFiles: "C:\\Program Files" },
		platform: "win32",
		fetch: fakeFetch(() => undefined).fetch,
		run: fakeRun({
			[searchFor("HKLM", "Ollama")]: search({
				[OLLAMA_KEY]: ["DisplayName    REG_SZ    Ollama version 0.12.6"],
			}),
			...values(OLLAMA_KEY, {
				DisplayName: ["REG_SZ", "Ollama version 0.12.6"],
				InstallLocation: ["REG_EXPAND_SZ", "%ProgramFiles%\\Ollama\\"],
			}),
		}).runner,
		which: onPath({}),
		exists: none,
	});
	expect(servers).toEqual([NOTHING, NO_LMSTUDIO]);
});
