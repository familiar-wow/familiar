// The ACP bridge against a stand-in agent (fake-agent.ts), over a real child process and stdio.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpBrain } from "../src/brain/acp.ts";
import type { Log } from "../src/log.ts";
import type { Settings } from "../src/settings.ts";

const FAKE = [process.execPath, join(import.meta.dir, "fake-agent.ts")];
const events: { name: string; data?: Record<string, unknown> }[] = [];
const log: Log = {
	event: (name, data) => void events.push({ name, data }),
	say: () => {},
};
const brains: AcpBrain[] = [];

function brain(
	settings: Partial<Settings["brain"]> = {},
	folder = tmpdir(),
): AcpBrain {
	const created = new AcpBrain(
		{ command: FAKE, permissions: "deny", timeout: 10, ...settings },
		{ folder, log, version: "0.0.0-test" },
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

test("opens sessions in the folder from the settings, which may exist only where the agent runs", async () => {
	expect(await ask(brain(), "where")).toBe(tmpdir());
	const remote = join(tmpdir(), "folder-on-another-host");
	expect(await ask(brain({ cwd: remote }), "where")).toBe(remote);
});

test("names the folder an agent refuses and keeps the agent", async () => {
	const fake = brain({ cwd: "C:\\Users\\player\\missing" });
	const refused =
		"The agent could not open a session in C:\\Users\\player\\missing: Internal error (invalid_params). If it runs on another host, set brain.cwd to a folder there.";
	expect(await ask(fake, "hello")).toBe(refused);
	expect(await ask(fake, "hello")).toBe(refused);
	expect(starts()).toBe(1);
});

test("reports the agent's error, not its last log line, and keeps the agent", async () => {
	const fake = brain();
	expect(await ask(fake, "hello")).toBe("session 1: hello");
	expect(await ask(fake, "fail")).toBe(
		"The agent stopped: Internal error (model unavailable)",
	);
	expect(await ask(fake, "hello")).toBe("session 1: hello");
	expect(starts()).toBe(1);
});

// Codex and Claude Code start through npx, which is a .cmd file on Windows. Bun finds such files
// on the PATH and in the folder it starts in, but ignores PATH changes made at run time.
test.skipIf(process.platform !== "win32")(
	"starts an agent through a .cmd file on Windows",
	async () => {
		const folder = mkdtempSync(join(tmpdir(), "familiar-cmd-"));
		writeFileSync(
			join(folder, "fake-agent.cmd"),
			`@"${FAKE[0]}" "${FAKE[1]}" %*\r\n`,
		);
		const fake = brain({ command: ["fake-agent"] }, folder);
		expect(await ask(fake, "hello")).toBe("session 1: hello");
	},
);

test("answers a permission request once, as the settings say", async () => {
	expect(await ask(brain(), "permission")).toBe("got reject-once");
	expect(await ask(brain({ permissions: "allow" }), "permission")).toBe(
		"got allow-once",
	);
	expect(
		events.filter((e) => e.name === "brain-permission").map((e) => e.data),
	).toEqual([
		{ tool: "rm -rf ~", answer: "reject-once" },
		{ tool: "rm -rf ~", answer: "allow-once" },
	]);
});

test("cancels a question that takes too long", async () => {
	const fake = brain({ timeout: 0.5 });
	expect(await ask(fake, "slow")).toBe("No answer within 0.5 s.");
	expect(await ask(fake, "hello")).toBe("session 1: hello");
	expect(starts()).toBe(1);
});

test("kills an agent that ignores the cancel and starts a new one", async () => {
	const fake = brain({ timeout: 0.5 });
	expect(await ask(fake, "hang")).toBe("No answer within 0.5 s.");
	expect(await ask(fake, "hello")).toBe("session 1: hello");
	expect(starts()).toBe(2);
}, 15_000);

test("reports a crash and starts again with the next question", async () => {
	const fake = brain();
	expect(await ask(fake, "crash")).toBe(
		"The agent stopped: fake-agent: crashed on purpose",
	);
	expect(await ask(fake, "hello")).toBe("session 1: hello");
});

test("reports an agent that cannot start", async () => {
	const missing = brain({ command: ["familiar-no-such-agent"] });
	expect(await ask(missing, "hello")).toMatch(
		/^Could not start familiar-no-such-agent: /,
	);
	const quits = brain({
		command: [
			process.execPath,
			"-e",
			'console.error("Error: no such profile"); process.exit(1)',
		],
	});
	expect(await ask(quits, "hello")).toMatch(
		/^Could not start .+: no such profile$/,
	);
});
