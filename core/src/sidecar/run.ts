// Runs a program and collects what it printed, for the checks the desktop app makes: which
// agents are installed, what `ssh -G` resolves, whether a local model server exists. A program
// that is missing is an answer, not a crash.

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

/** Bun.spawn with a timeout (default 5 s). Never throws: a program that cannot start gives code null. */
export const run: Runner = async (cmd, opts = {}) => {
	let child: ReturnType<typeof Bun.spawn>;
	try {
		child = Bun.spawn(cmd, {
			stdin: opts.stdin === undefined ? "ignore" : "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: opts.env ? { ...process.env, ...opts.env } : process.env,
			windowsHide: true,
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
