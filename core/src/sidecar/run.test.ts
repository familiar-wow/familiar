import { expect, test } from "bun:test";
import { run } from "./run.ts";

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
