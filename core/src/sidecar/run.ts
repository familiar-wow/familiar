// Runs a program and collects what it printed, for the checks the desktop app makes: which
// agents are installed, what `ssh -G` resolves, whether a local model server exists. A program
// that is missing is an answer, not a crash.
import { existsSync } from "node:fs";
import { win32 } from "node:path";

export interface RunResult {
	/** The exit code; null if the program could not start or was stopped by the timeout. */
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export type Runner = (
	cmd: string[],
	opts?: { timeoutMs?: number; env?: Record<string, string>; stdin?: string },
) => Promise<RunResult>;

export interface LaunchOptions {
	platform?: NodeJS.Platform;
	/** Full path of a program on PATH, or null. Defaults to Bun.which. */
	which?: (name: string) => string | null;
	exists?: (path: string) => boolean;
}

const SCRIPT = /\.(cmd|bat)$/i;
// cmd expands %VAR% (and !VAR! under delayed expansion) even inside quotes, a script that uses
// %1 or %* unquoted parses ^ & | < > again, and a line break ends the command.
const CMD_UNSAFE = /[%!^&|<>\r\n]/;

/** One word for cmd: in double quotes, inner `"` doubled. */
function cmdQuote(word: string): string {
	// npm's shims hand %* on to node.exe, which reads `\"` as an escaped quote (MSVCRT rules),
	// so backslashes in front of a quote or of the closing quote are doubled, as Rust's std does.
	return `"${word.replace(/(\\*)"/g, '$1$1""').replace(/(\\+)$/, "$1$1")}"`;
}

/**
 * The command as Bun.spawn can start it on this platform.
 *
 * Windows cannot start a `.cmd`/`.bat` script without cmd.exe, and npm installs every CLI as one.
 * `npx.cmd` from the Node.js installer is started without a shell: it sits next to node.exe and
 * runs `"%~dp0\node.exe" "%~dp0\node_modules\npm\bin\npx-cli.js" %*` (npm/cli bin/npx.cmd; the
 * MSI puts node.exe, npx.cmd and node_modules\npm into one folder, nodejs/node
 * tools/msvs/msi/nodemsi/product.wxs). Unlike the shim we skip its check for a newer npm in the
 * global prefix, so after `npm i -g npm` this still starts the npx that came with Node.
 * Any other script runs through `cmd.exe /d /s /c "<line>"`, like Node's `shell: true`; Bun must
 * pass that line unquoted (see windowsVerbatim). Elsewhere the command comes back unchanged.
 *
 * Throws (fixed words) when a word holds a character cmd cannot quote safely.
 */
export function launchable(cmd: string[], opts: LaunchOptions = {}): string[] {
	const platform = opts.platform ?? process.platform;
	const [first, ...args] = cmd;
	if (platform !== "win32" || first === undefined) return cmd;
	const which = opts.which ?? ((name: string) => Bun.which(name));
	const exists = opts.exists ?? existsSync;
	const script = SCRIPT.test(first)
		? first
		: /\.(exe|com)$/i.test(first)
			? undefined
			: (which(first) ?? undefined);
	if (script === undefined || !SCRIPT.test(script)) return cmd;
	if (win32.basename(script).toLowerCase() === "npx.cmd") {
		const dir = win32.dirname(script);
		const node = win32.join(dir, "node.exe");
		const cli = win32.join(dir, "node_modules", "npm", "bin", "npx-cli.js");
		if (exists(node) && exists(cli)) return [node, cli, ...args];
	}
	const words = [script, ...args];
	if (words.some((w) => CMD_UNSAFE.test(w)))
		throw new Error(
			"a Windows script cannot be started safely with %, !, ^, &, |, <, > or a line break in its path or arguments",
		);
	return ["cmd.exe", "/d", "/s", "/c", `"${words.map(cmdQuote).join(" ")}"`];
}

/**
 * True for a cmd.exe line from launchable. Bun.spawn needs `windowsVerbatimArguments` for it,
 * or it escapes the inner quotes with backslashes, which cmd does not understand.
 */
export function windowsVerbatim(cmd: string[]): boolean {
	return (
		cmd.length === 5 &&
		cmd[0] === "cmd.exe" &&
		cmd[1] === "/d" &&
		cmd[2] === "/s" &&
		cmd[3] === "/c"
	);
}

/** Bun.spawn with a timeout (default 5 s). Never throws: a program that cannot start gives code null. */
export const run: Runner = async (cmd, opts = {}) => {
	let child: ReturnType<typeof Bun.spawn>;
	try {
		const launch = launchable(cmd);
		child = Bun.spawn(launch, {
			stdin: opts.stdin === undefined ? "ignore" : "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: opts.env ? { ...process.env, ...opts.env } : process.env,
			windowsHide: true,
			windowsVerbatimArguments: windowsVerbatim(launch),
		});
	} catch (error) {
		return {
			code: null,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
			timedOut: false,
		};
	}
	if (
		opts.stdin !== undefined &&
		child.stdin &&
		typeof child.stdin !== "number"
	) {
		child.stdin.write(opts.stdin);
		child.stdin.end();
	}
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, opts.timeoutMs ?? 5000);
	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout as ReadableStream).text(),
			new Response(child.stderr as ReadableStream).text(),
			child.exited,
		]);
		return { code: timedOut ? null : code, stdout, stderr, timedOut };
	} finally {
		clearTimeout(timer);
	}
};
