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

function brain(settings: Partial<Settings["brain"]> = {}): AcpBrain {
	const created = new AcpBrain(
		{ command: FAKE, permissions: "deny", timeout: 10, ...settings },
		{ folder: tmpdir(), log, version: "0.0.0-test" },
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

// TEMPORARY probe (FAM-24): how Bun starts commands on Windows. Removed in the next commit.
test.skipIf(process.platform !== "win32")(
	"probe Windows spawn",
	async () => {
		const out: string[] = [];
		const run = async (label: string, argv: string[], cwd?: string) => {
			try {
				const p = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
				const text = (await new Response(p.stdout).text())
					.trim()
					.split(/\r?\n/)[0];
				out.push(`${label}: exit ${await p.exited}, "${text}"`);
			} catch (error) {
				out.push(`${label}: throws ${(error as Error).message}`);
			}
		};
		const npx = Bun.which("npx");
		out.push(`which npx: ${npx}`);
		await run("npx", ["npx", "--version"]);
		if (npx) await run("npx by path", [npx, "--version"]);
		await run("cmd /c npx", ["cmd.exe", "/d", "/s", "/c", "npx --version"]);
		const folder = mkdtempSync(join(tmpdir(), "probe-"));
		writeFileSync(join(folder, "probe.cmd"), "@echo probe-ok %*\r\n");
		await run("probe.cmd by path", [join(folder, "probe.cmd"), "a b"]);
		await run("probe in cwd", ["probe"], folder);
		await run(
			"cmd /c probe in cwd",
			["cmd.exe", "/d", "/s", "/c", "probe"],
			folder,
		);
		process.env.PATH = `${folder};${process.env.PATH}`;
		out.push(`which probe after PATH change: ${Bun.which("probe")}`);
		await run("probe after PATH change", ["probe"]);
		console.log(`PROBE\n${out.join("\n")}\nPROBE END`);
		expect(true).toBe(true);
	},
	60_000,
);
