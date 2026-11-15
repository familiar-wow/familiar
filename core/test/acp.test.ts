// The ACP brain against a stand-in agent (fake-agent.ts), over a real child process and stdio.
import { afterEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpBrain } from "../src/brain/acp.ts";
import type { Log } from "../src/log.ts";

const FAKE = [process.execPath, join(import.meta.dir, "fake-agent.ts")];
const events: { name: string; data?: Record<string, unknown> }[] = [];
const log: Log = {
	event: (name, data) => void events.push({ name, data }),
	say: () => {},
};
const brains: AcpBrain[] = [];

function brain(command = FAKE, timeout = 10): AcpBrain {
	const created = new AcpBrain(
		{ name: "Fake", command, timeout },
		{ cwd: tmpdir(), log, version: "0.0.0-test" },
	);
	brains.push(created);
	return created;
}

const ask = (from: AcpBrain, text: string, name = "Hero") =>
	from.ask({ text, character: { name, realm: "Realm" } });
const starts = () => events.filter((e) => e.name === "brain-start").length;

afterEach(() => {
	for (const created of brains.splice(0)) created.stop();
	events.length = 0;
});

test("answers with the last message, in one session per character", async () => {
	const fake = brain();
	expect(await ask(fake, "hello")).toBe("session 1: hello");
	expect(await ask(fake, "and again")).toBe("session 1: and again");
	expect(await ask(fake, "hi", "Alt")).toBe("session 2: hi");
	expect(starts()).toBe(1);
});

test("declines what the agent asks permission for", async () => {
	expect(await ask(brain(), "permission")).toBe("got no");
	expect(events.find((e) => e.name === "brain-permission")?.data).toEqual({
		tool: "rm -rf ~",
		declined: "no",
	});
});

test("cancels a question that takes too long", async () => {
	const fake = brain(FAKE, 0.5);
	expect(await ask(fake, "slow")).toBe("Fake did not answer within 0.5 s.");
	expect(await ask(fake, "hello")).toBe("session 1: hello");
	expect(starts()).toBe(1);
});

test("kills an agent that ignores the cancel and starts a new one", async () => {
	const fake = brain(FAKE, 0.5);
	expect(await ask(fake, "hang")).toBe("Fake did not answer within 0.5 s.");
	expect(await ask(fake, "hello")).toBe("session 1: hello");
	expect(starts()).toBe(2);
}, 15_000);

test("reports a crash and starts again with the next question", async () => {
	const fake = brain();
	expect(await ask(fake, "crash")).toBe(
		"Fake stopped: fake-agent: crashed on purpose",
	);
	expect(await ask(fake, "hello")).toBe("session 1: hello");
});

test("reports an agent that cannot start", async () => {
	expect(await ask(brain(["familiar-no-such-agent"]), "hello")).toMatch(
		/^Fake could not start: .*familiar-no-such-agent/,
	);
	const quits = brain([
		process.execPath,
		"-e",
		"console.error(\"Error: Profile 'familiar' does not exist.\"); process.exit(1)",
	]);
	expect(await ask(quits, "hello")).toBe(
		"Fake could not start: Profile 'familiar' does not exist.",
	);
});
