// The real addon in a stub client (addon/test/client.lua) against the real app side, through
// real files. This shows that both sides follow the same protocol; it says nothing about the
// game client itself. Needs Lua 5.1 with the bit library: LUA and LUAC name the binaries
// (default lua5.1 and luac5.1).
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Log } from "../src/log.ts";
import { echo } from "../src/main.ts";
import { Transport } from "../src/transport/transport.ts";
import { FILES, TOC } from "../src/wow/addon.ts";
import { wowPaths } from "../src/wow/client.ts";
import { install } from "../src/wow/install.ts";

const LUA = process.env.LUA ?? "lua5.1";
const LUAC = process.env.LUAC ?? "luac5.1";
const ADDON = join(import.meta.dir, "..", "..", "addon");

test("Familiar.toc lists exactly the files the app installs", () => {
	const listed = TOC.split(/\r?\n/).filter(
		(line) => line.trim() !== "" && !line.startsWith("#"),
	);
	expect(listed).toEqual(Object.keys(FILES));
});

test("the addon sets no globals but its saved state and slash command", () => {
	const files = Object.keys(FILES).map((name) => join(ADDON, "Familiar", name));
	const listing = Bun.spawnSync([LUAC, "-p", "-l", ...files]);
	expect(listing.exitCode).toBe(0);
	const globals = new Set(
		[...listing.stdout.toString().matchAll(/SETGLOBAL\s.*;\s*(\S+)/g)].map(
			(m) => m[1],
		),
	);
	expect([...globals].sort()).toEqual(["FamiliarDB", "SLASH_FAMILIAR1"]);
});

// The game -------------------------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), "familiar-test-"));
const paths = wowPaths(join(root, "_forever_"));
const events: { name: string; data?: Record<string, unknown> }[] = [];
const log: Log = {
	event: (name, data) => void events.push({ name, data }),
	say: () => {},
};
let pids = [1];
let app: Transport | undefined;
const chat: string[] = [];
const errors: string[] = [];
let game: Bun.Subprocess<"pipe", "pipe", "pipe">;
let ticker: ReturnType<typeof setInterval>;

const command = (line: string) => {
	game.stdin.write(`${line}\n`);
	game.stdin.flush();
};

/** Waits for a chat line after `from` that matches; returns the index after it. */
async function waitFor(
	pattern: RegExp,
	from: number,
	ms = 15_000,
): Promise<number> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		const at = chat.findIndex((line, i) => i >= from && pattern.test(line));
		if (at >= 0) return at + 1;
		await Bun.sleep(20);
	}
	throw new Error(
		`no chat line ${pattern} within ${ms} ms; chat:\n${chat.slice(from).join("\n")}`,
	);
}

/** Sends a test message and waits for the echo. */
async function roundTrip(
	text: string,
	expected: RegExp,
	from: number,
): Promise<number> {
	command(`slash /familiar say ${text}`);
	return waitFor(expected, from);
}

/** Starts the app's end, which answers every message with the echo. */
async function startApp(): Promise<void> {
	const transport = new Transport({
		paths,
		log,
		welcome: "the test app",
		processes: async () => pids,
		processPollMs: 50,
	});
	transport.onMessage((body, { hello }) => {
		if (!hello)
			transport.send(
				new TextEncoder().encode(echo(new TextDecoder().decode(body))),
			);
	});
	await transport.start();
	app = transport;
}

beforeAll(async () => {
	for (const character of ["Hero", "Alt"])
		mkdirSync(join(paths.accounts, "TEST", "Realm", character), {
			recursive: true,
		});
	install(paths, 16001, "0.0.0-test");
	writeFileSync(join(root, "addons.txt"), readdirSync(paths.addons).join("\n"));
	await startApp();
	game = Bun.spawn(
		[
			LUA,
			join(ADDON, "test", "client.lua"),
			paths.client,
			"TEST",
			"Realm",
			"Hero",
			join(root, "addons.txt"),
		],
		{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
	);
	void (async () => {
		let rest = "";
		for await (const chunk of game.stdout) {
			const lines = (rest + new TextDecoder().decode(chunk)).split("\n");
			rest = lines.pop() ?? "";
			for (const line of lines) {
				if (line.startsWith("chat ")) chat.push(line.slice(5));
				if (line.startsWith("error ")) errors.push(line.slice(6));
			}
		}
	})();
	const started = performance.now();
	ticker = setInterval(
		() => command(`frame ${Math.round(performance.now() - started)}`),
		16,
	);
});

afterAll(() => {
	clearInterval(ticker);
	app?.stop();
	game?.kill();
	rmSync(root, { recursive: true, force: true });
});

test("messages go up and replies come down, across /reload, a character switch and a restart", async () => {
	let at = await waitFor(/Connected to the test app\.$/, 0);
	at = await roundTrip("hello", /Reply after .*: heard: hello$/, at);
	// 2000 bytes take five fonts.
	at = await roundTrip("2000", /Reply after .*, 2000 bytes: heard: 2000$/, at);

	// Nothing goes out while the addon list is open.
	command("list open");
	command("slash /familiar say wait for the list");
	await Bun.sleep(600);
	expect(
		chat.slice(at).some((line) => line.includes("wait for the list")),
	).toBe(false);
	command("list close");
	at = await waitFor(/heard: wait for the list$/, at);

	// A message that gets lost goes out again.
	command("drop 1");
	at = await roundTrip("lost once", /Sent in [3-9]\.\d+ s\./, at);
	at = await waitFor(/heard: lost once$/, at);

	command("reload");
	at = await waitFor(/Connected to the test app\.$/, at);
	at = await roundTrip(
		"grüße nach dem Reload",
		/heard: grüße nach dem Reload$/,
		at,
	);

	command("login Alt");
	at = await waitFor(/Connected to the test app\.$/, at);
	at = await roundTrip("from Alt", /heard: from Alt$/, at);

	// The app sees the game close and a new process start; the new process starts over.
	pids = [];
	while (
		!events.some((e) => e.name === "reset" && e.data?.why === "WoW closed")
	)
		await Bun.sleep(20);
	pids = [2];
	command("restart");
	at = await waitFor(/Connected to the test app\.$/, at);
	at = await roundTrip("after restart", /heard: after restart$/, at);

	// The app quits while the game runs, then the game restarts on its own: the doorbells the
	// app raised are still raised. They must not pass for an app that answers.
	app?.stop();
	pids = [3];
	const restarted = chat.length;
	command("restart");
	at = await waitFor(/The Familiar app does not answer/, restarted);
	command("slash /familiar say too early");
	at = await waitFor(/Not sent: not connected to the Familiar app\.$/, at);
	expect(
		chat.slice(restarted).filter((line) => line.includes("Connected")),
	).toEqual([]);

	// Started next to the running game, the app joins at the addon's next hello and silences
	// the ack doorbell left raised.
	await startApp();
	at = await waitFor(/Connected to the test app\.$/, at, 30_000);
	expect(events.findLast((e) => e.name === "session")?.data?.silenced).toBe(1);
	at = await roundTrip("the app is back", /heard: the app is back$/, at);

	command("slash /familiar status");
	await waitFor(
		/:\|r connected, sound ok; used since the game started: 1 of 600 confirmations, 4 of 600 message doorbells, 4 of 256 fonts; probe: font yes, sound yes$/,
		at,
	);
	expect(errors).toEqual([]);
	expect(events.filter((e) => e.name === "lane-broken")).toEqual([]);
}, 120_000);
