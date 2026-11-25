import { expect, test } from "bun:test";
import { Bootstrap, type Step } from "./bootstrap.ts";

/** Steps that wait until the test lets them go, and record what ran. */
function setup(
	names = ["hello", "settings.get", "status", "logs.recent", "start"],
) {
	const ran: string[] = [];
	const failures: [number, string, string][] = [];
	const gates = new Map<
		string,
		{ open: () => void; fail: (e: Error) => void }
	>();
	const bootstrap = new Bootstrap({
		steps: (gen) =>
			names.map(
				(name): Step => ({
					name,
					run: () =>
						new Promise<void>((resolve, reject) => {
							ran.push(`${gen}:${name}`);
							gates.set(`${gen}:${name}`, { open: resolve, fail: reject });
						}),
				}),
			),
		failed: (gen, step, message) => failures.push([gen, step, message]),
	});
	const tick = () => new Promise((r) => setTimeout(r, 0));
	const open = async (key: string) => {
		gates.get(key)?.open();
		await tick();
	};
	const fail = async (key: string, message: string) => {
		gates.get(key)?.fail(new Error(message));
		await tick();
	};
	return { bootstrap, ran, failures, open, fail, tick };
}

test("runs the steps in order", async () => {
	const { bootstrap, ran, open } = setup(["hello", "status"]);
	const done = bootstrap.run(1);
	await open("1:hello");
	await open("1:status");
	expect(await done).toBe(true);
	expect(ran).toEqual(["1:hello", "1:status"]);
});

test("a second trigger for the same generation joins the run under way", async () => {
	const { bootstrap, ran, open } = setup(["hello", "status"]);
	const first = bootstrap.run(1);
	const second = bootstrap.run(1);
	expect(second).toBe(first);
	await open("1:hello");
	await open("1:status");
	expect(await second).toBe(true);
	// And once done, it does not run again for that core.
	expect(await bootstrap.run(1)).toBe(true);
	expect(ran).toEqual(["1:hello", "1:status"]);
});

test("stops at a failed step and reports its message", async () => {
	const { bootstrap, ran, failures, open, fail } = setup();
	const done = bootstrap.run(1);
	await open("1:hello");
	await fail("1:settings.get", "The settings file is broken.");
	expect(await done).toBe(false);
	expect(ran).toEqual(["1:hello", "1:settings.get"]);
	expect(failures).toEqual([
		[1, "settings.get", "The settings file is broken."],
	]);
});

test("a newer generation abandons the older run's remaining steps", async () => {
	const { bootstrap, ran, failures, open, fail } = setup(["hello", "status"]);
	const old = bootstrap.run(1);
	const fresh = bootstrap.run(2);
	await open("1:hello");
	expect(await old).toBe(false);
	await open("2:hello");
	await open("2:status");
	expect(await fresh).toBe(true);
	expect(ran).toEqual(["1:hello", "2:hello", "2:status"]);
	// The old core's step failing late is not the new core's problem.
	await fail("1:hello", "late");
	expect(failures).toEqual([]);
});

test("an older generation does not start once a newer one ran", async () => {
	const { bootstrap, ran, tick } = setup(["hello"]);
	void bootstrap.run(3);
	expect(await bootstrap.run(2)).toBe(false);
	await tick();
	expect(ran).toEqual(["3:hello"]);
});

test("a failure in an abandoned run is not reported", async () => {
	const { bootstrap, failures, fail } = setup(["hello"]);
	const old = bootstrap.run(1);
	void bootstrap.run(2);
	await fail("1:hello", "The core stopped.");
	expect(await old).toBe(false);
	expect(failures).toEqual([]);
});
