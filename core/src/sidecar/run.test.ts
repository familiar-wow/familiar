import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { launchable, run, windowsVerbatim } from "./run.ts";

const bun = process.execPath;

test("collects output and the exit code", async () => {
	const r = await run([
		bun,
		"-e",
		"console.log('hi'); console.error('oops'); process.exit(3)",
	]);
	expect(r).toEqual({
		code: 3,
		stdout: "hi\n",
		stderr: "oops\n",
		timedOut: false,
	});
});

test("passes input and extra environment", async () => {
	const r = await run(
		[
			bun,
			"-e",
			"process.stdout.write((await Bun.stdin.text()) + process.env.FAM_TEST)",
		],
		{ stdin: "in-", env: { FAM_TEST: "env" } },
	);
	expect(r.stdout).toBe("in-env");
});

test("a missing program is an answer, not a crash", async () => {
	const r = await run(["familiar-no-such-program-xyz"]);
	expect(r.code).toBeNull();
	expect(r.timedOut).toBe(false);
});

test("stops a program that takes too long", async () => {
	const started = performance.now();
	const r = await run([bun, "-e", "await Bun.sleep(5000)"], { timeoutMs: 200 });
	expect(r.timedOut).toBe(true);
	expect(r.code).toBeNull();
	expect(performance.now() - started).toBeLessThan(2000);
});

// ---- Windows scripts ----

// npm/cli bin/npx.cmd as the Node.js installer copies it next to node.exe.
const NPX_CMD = [
	":: Created by npm, please don't edit manually.",
	"@ECHO OFF",
	"",
	"SETLOCAL",
	"",
	'SET "NODE_EXE=%~dp0\\node.exe"',
	'IF NOT EXIST "%NODE_EXE%" (',
	'  SET "NODE_EXE=node"',
	")",
	"",
	'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
	'SET "NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js"',
	'FOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"\') DO (',
	'  SET "NPM_PREFIX_NPX_CLI_JS=%%F\\node_modules\\npm\\bin\\npx-cli.js"',
	")",
	'IF EXIST "%NPM_PREFIX_NPX_CLI_JS%" (',
	'  SET "NPX_CLI_JS=%NPM_PREFIX_NPX_CLI_JS%"',
	")",
	"",
	'"%NODE_EXE%" "%NPX_CLI_JS%" %*',
	"",
].join("\r\n");

let root = "";
/** C:\Program Files\nodejs as the MSI lays it out, under a temp dir with spaces. */
let nodejs = "";
/** %APPDATA%\npm after `npm i -g npm`: a second npx.cmd, but no node.exe next to it. */
let roamingNpm = "";

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "familiar run "));
	nodejs = join(root, "Program Files", "nodejs");
	mkdirSync(join(nodejs, "node_modules", "npm", "bin"), { recursive: true });
	writeFileSync(join(nodejs, "npx.cmd"), NPX_CMD);
	writeFileSync(join(nodejs, "node.exe"), "");
	writeFileSync(join(nodejs, "node_modules", "npm", "bin", "npx-cli.js"), "");
	roamingNpm = join(root, "App Data", "Roaming", "npm");
	mkdirSync(join(roamingNpm, "node_modules", "npm", "bin"), {
		recursive: true,
	});
	writeFileSync(join(roamingNpm, "npx.cmd"), NPX_CMD);
	writeFileSync(
		join(roamingNpm, "node_modules", "npm", "bin", "npx-cli.js"),
		"",
	);
});

afterAll(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

// launchable joins Windows paths with backslashes; the files are on this machine's disk.
const onDisk = (p: string) => existsSync(p.replaceAll("\\", "/"));

test("starts the installer's npx.cmd through node.exe, without a shell", () => {
	const npx = join(nodejs, "npx.cmd");
	const opts = {
		platform: "win32" as const,
		which: (n: string) => (n === "npx" ? npx : null),
		exists: onDisk,
	};
	const node = win32.join(nodejs, "node.exe");
	const cli = win32.join(nodejs, "node_modules", "npm", "bin", "npx-cli.js");
	expect(node).toContain("Program Files");
	const args = ["-y", "@agentclientprotocol/codex-acp"];
	// By name from PATH, and by its full path.
	expect(launchable(["npx", ...args], opts)).toEqual([node, cli, ...args]);
	expect(launchable([npx, ...args], opts)).toEqual([node, cli, ...args]);
	// The cmd characters do not matter here: no shell reads them.
	expect(launchable([npx, "-y", "pkg@^1"], opts)).toEqual([
		node,
		cli,
		"-y",
		"pkg@^1",
	]);
});

test("an npx.cmd without node.exe next to it goes through cmd.exe", () => {
	const npx = join(roamingNpm, "npx.cmd");
	const cmd = launchable([npx, "-y", "pkg"], {
		platform: "win32",
		which: () => null,
		exists: onDisk,
	});
	expect(cmd).toEqual(["cmd.exe", "/d", "/s", "/c", `""${npx}" "-y" "pkg""`]);
	expect(windowsVerbatim(cmd)).toBe(true);
});

test("other scripts run through cmd.exe with every word quoted", () => {
	const gemini = "C:\\Users\\P Q\\AppData\\Roaming\\npm\\gemini.cmd";
	const opts = {
		platform: "win32" as const,
		which: (n: string) => (n === "gemini" ? gemini : null),
		exists: () => false,
	};
	expect(launchable(["gemini", "--experimental-acp"], opts)).toEqual([
		"cmd.exe",
		"/d",
		"/s",
		"/c",
		`""${gemini}" "--experimental-acp""`,
	]);
	// Inner quotes doubled; backslashes before a quote and at the end doubled; empty kept.
	expect(
		launchable([gemini, 'say "hi"', 'a\\"b', "C:\\dir\\", ""], opts)[4],
	).toBe(`""${gemini}" "say ""hi""" "a\\\\""b" "C:\\dir\\\\" """`);
	// .bat, and any case of the extension.
	expect(
		launchable(["C:\\tools\\Run.BAT"], {
			platform: "win32",
			which: () => null,
		})[4],
	).toBe('""C:\\tools\\Run.BAT""');
});

test("refuses words cmd cannot quote safely, without echoing them", () => {
	const opts = {
		platform: "win32" as const,
		which: () => null,
		exists: () => false,
	};
	for (const bad of [
		"%PATH%",
		"a!b",
		"a^b",
		"a&b",
		"a|b",
		"a<b",
		"a>b",
		"a\rb",
		"a\nb",
	]) {
		expect(() => launchable(["C:\\npm\\codex.cmd", bad], opts)).toThrow(
			"a Windows script cannot be started safely with %, !, ^, &, |, <, > or a line break in its path or arguments",
		);
	}
	// In the script's own path too.
	expect(() => launchable(["C:\\Users\\A&B\\npm\\codex.cmd"], opts)).toThrow();
	try {
		launchable(["C:\\npm\\codex.cmd", "sk-secret&x"], opts);
	} catch (error) {
		expect(String(error)).not.toContain("sk-secret");
	}
});

test("leaves programs and other platforms alone", () => {
	const which = (n: string) => `C:\\Program Files\\nodejs\\${n}.cmd`;
	const exe = ["C:\\Program Files\\Ollama\\ollama.exe", "serve"];
	expect(launchable(exe, { platform: "win32", which })).toBe(exe);
	// A name PATH resolves to an .exe, or not at all: Bun.spawn finds it, or reports it missing.
	const hermes = ["hermes", "acp"];
	expect(
		launchable(hermes, {
			platform: "win32",
			which: () => "C:\\bin\\hermes.exe",
		}),
	).toBe(hermes);
	expect(launchable(hermes, { platform: "win32", which: () => null })).toBe(
		hermes,
	);
	// Linux and macOS start scripts themselves, even ones named .cmd.
	for (const platform of ["linux", "darwin"] as const) {
		const npx = ["npx", "-y", "a&b"];
		expect(launchable(npx, { platform, which })).toBe(npx);
		const odd = ["/opt/x.cmd", "%"];
		expect(launchable(odd, { platform, which })).toBe(odd);
	}
	expect(windowsVerbatim(["cmd.exe", "/c", "dir"])).toBe(false);
	expect(launchable([], { platform: "win32" })).toEqual([]);
});

/** Runs fn as if on Windows, with Bun.spawn replaced by a recorder that refuses to start. */
async function onWindows(fn: () => Promise<void>, spawned: unknown[][]) {
	const platform = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", {
		value: "win32",
		configurable: true,
	});
	const spawn = spyOn(Bun, "spawn").mockImplementation(((
		...args: unknown[]
	) => {
		spawned.push(args);
		throw new Error("not started in this test");
	}) as typeof Bun.spawn);
	try {
		await fn();
	} finally {
		spawn.mockRestore();
		if (platform) Object.defineProperty(process, "platform", platform);
	}
}

test("run() hands Bun.spawn the launchable command, verbatim for cmd.exe", async () => {
	const spawned: unknown[][] = [];
	const codex = "C:\\Users\\P Q\\AppData\\Roaming\\npm\\codex.cmd";
	await onWindows(async () => {
		const r = await run([codex, "--version"]);
		expect(r).toMatchObject({ code: null, stderr: "not started in this test" });
	}, spawned);
	expect(spawned).toHaveLength(1);
	expect(spawned[0]?.[0]).toEqual([
		"cmd.exe",
		"/d",
		"/s",
		"/c",
		`""${codex}" "--version""`,
	]);
	expect(spawned[0]?.[1]).toMatchObject({ windowsVerbatimArguments: true });
});

test("run() answers a refused script with code null and fixed words", async () => {
	const spawned: unknown[][] = [];
	await onWindows(async () => {
		const r = await run(["C:\\npm\\codex.cmd", "100%"]);
		expect(r).toEqual({
			code: null,
			stdout: "",
			stderr:
				"a Windows script cannot be started safely with %, !, ^, &, |, <, > or a line break in its path or arguments",
			timedOut: false,
		});
	}, spawned);
	expect(spawned).toEqual([]);
});
