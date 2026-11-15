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
import type { Question } from "../src/brain/chat.ts";
import { Conversation } from "../src/conversation.ts";
import { echoBrain } from "../src/echo.ts";
import type { Log } from "../src/log.ts";
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
const questions: Question[] = [];
const chat: string[] = [];
/** Lines the window restored from the saved history. */
const restored: string[] = [];
const errors: string[] = [];
let game: Bun.Subprocess<"pipe", "pipe", "pipe">;
let ticker: ReturnType<typeof setTimeout> | undefined;
let nextFrame = () => {};

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

/** Sends a test message and waits for the echo. It must go through at the first attempt. */
async function roundTrip(
	text: string,
	expected: RegExp,
	from: number,
): Promise<number> {
	command(`slash /familiar say ${text}`);
	const sent = await waitFor(/Sent in \d+\.\d+ s\.$/, from);
	// A second attempt starts only after 3 s.
	expect(chat[sent - 1]).toMatch(/Sent in [0-2]\.\d+ s\.$/);
	return Math.max(sent, await waitFor(expected, from));
}

/** Starts the app's end, which answers every question with the echo. */
async function startApp(): Promise<void> {
	const transport = new Transport({
		paths,
		log,
		welcome: "the test app",
		processes: async () => pids,
		processPollMs: 50,
	});
	const conversation = new Conversation(
		{
			ask: (question, turn) => {
				questions.push(question);
				return echoBrain.ask(question, turn);
			},
		},
		(body) => transport.send(body),
		log,
	);
	transport.onMessage((body, { hello }) => {
		if (!hello) conversation.receive(body);
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
				if (line.startsWith("tick")) ticker = setTimeout(nextFrame, 17);
				// What the player reads: the window, and the chat while it is closed.
				if (line.startsWith("chat ")) chat.push(line.slice(5));
				if (line.startsWith("window ")) chat.push(line.slice(7));
				if (line.startsWith("backfill ")) restored.push(line.slice(9));
				if (line.startsWith("error ")) errors.push(line.slice(6));
			}
		}
	})();
	// About 60 frames per second, and the addon saves every second frame: each frame of a message
	// stays in AddOns.txt for only 34 ms, as with the slowest client measured. A frame starts
	// 17 ms after the stub client has finished the last one, so a stalled client draws one long
	// frame and cannot catch up on the frames it missed.
	const started = performance.now();
	nextFrame = () => command(`frame ${Math.round(performance.now() - started)}`);
	nextFrame();
});

afterAll(() => {
	nextFrame = () => {};
	clearTimeout(ticker);
	app?.stop();
	game?.kill();
	rmSync(root, { recursive: true, force: true });
});

test("messages go up and replies come down, across /reload, a character switch and a restart", async () => {
	let at = await waitFor(/Connected to the test app\.$/, 0);
	at = await roundTrip("hello", /:\|r heard: hello$/, at);
	expect(questions[0]?.character).toEqual({
		name: "Hero",
		realm: "Realm",
		level: "60",
		race: "Orc",
		class: "Warrior",
		faction: "Horde",
		zone: "Orgrimmar",
		subzone: "Valley of Strength",
		locale: "enUS",
	});
	// The window: a question typed into its input line, the tool the agent calls, and a
	// permission request the player answers in game.
	command("enter tools");
	at = await waitFor(/^ {2}> web_search: echo$/, at);
	at = await waitFor(/:\|r heard: tools$/, at);
	command("enter permission");
	at = await waitFor(/^The agent asks: echo a test$/, at);
	command("slash /familiar allow");
	at = await waitFor(/^Allowed once: echo a test$/, at);
	at = await waitFor(/:\|r heard: permission, allowed$/, at);

	// 2000 bytes take five fonts, and every line of the answer reaches the window.
	at = await roundTrip("2000", /^familiar familiar /, at);
	expect(chat[at - 2]).toMatch(/:\|r heard: 2000$/);
	// A | in an answer shows as text and never starts a link (AGENTS.md, rule 3).
	at = await roundTrip(
		"|Hitem:19019|h[Thunderfury]|h",
		/:\|r heard: \|\|Hitem:19019\|\|h\[Thunderfury\]\|\|h$/,
		at,
	);

	// Nothing goes out while the addon list is open.
	command("list open");
	command("slash /familiar say wait for the list");
	await Bun.sleep(600);
	expect(
		chat.slice(at).some((line) => line.includes("heard: wait for the list")),
	).toBe(false);
	command("list close");
	at = await waitFor(/heard: wait for the list$/, at);

	// A message that gets lost goes out again.
	command("drop 1");
	command("slash /familiar say lost once");
	at = await waitFor(/Sent in [3-9]\.\d+ s\./, at);
	at = await waitFor(/heard: lost once$/, at);

	// The system holds a write up halfway: AddOns.txt stays empty for 0.3 s, which reads as all
	// helpers off. The message must not end there.
	command("stall 2 300");
	at = await roundTrip(
		"its second frame is written slowly",
		/heard: its second frame is written slowly$/,
		at,
	);

	command("reload");
	at = await waitFor(/Connected to the test app\.$/, at);
	// The window keeps its history across /reload.
	expect(restored).toContain("|cff8fd1ffFamiliar:|r heard: tools");
	at = await roundTrip(
		"grüße nach dem Reload",
		/heard: grüße nach dem Reload$/,
		at,
	);

	// Alt's AddOns.txt does not exist yet: the client creates it with the hello. Alt has its
	// own history in the window, as it has its own session with the agent.
	let since = restored.length;
	command("login Alt");
	at = await waitFor(/Connected to the test app\.$/, at);
	expect(restored.slice(since)).toEqual([]);
	at = await roundTrip("from Alt", /heard: from Alt$/, at);
	since = restored.length;
	command("login Hero");
	at = await waitFor(/Connected to the test app\.$/, at);
	expect(restored.slice(since)).toContain(
		"|cff8fd1ffFamiliar:|r heard: grüße nach dem Reload",
	);
	expect(restored.slice(since).join("\n")).not.toContain("from Alt");

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

	// The new process starts before the old one has quit, so the app empties nothing. It
	// silences what the old process raised once the hello names the new session.
	pids = [2, 3];
	command("restart");
	at = await waitFor(/Connected to the test app\.$/, at);
	expect(events.findLast((e) => e.name === "session")?.data?.silenced).toBe(3);
	pids = [3];
	at = await roundTrip(
		"after an overlapping restart",
		/heard: after an overlapping restart$/,
		at,
	);
	// Every hello so far got its welcome at the first attempt.
	expect(chat.filter((line) => line.includes("does not answer"))).toEqual([]);

	// The app quits while the game runs, then the game restarts on its own: the doorbells the
	// app raised are still raised. They must not pass for an app that answers.
	app?.stop();
	pids = [4];
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

	// The app restarts while the game runs, and the addon still counts as connected: the app
	// takes over from the next message, without a hello.
	app?.stop();
	await startApp();
	at = await roundTrip(
		"after an app restart",
		/heard: after an app restart$/,
		at,
	);

	command("slash /familiar status");
	await waitFor(
		/^connected, sound ok; used since the game started: 2 of 4096 confirmations, 5 of 4096 message doorbells, 5 of 8192 fonts; probe: font yes, sound yes$/,
		at,
	);
	expect(errors).toEqual([]);
	expect(events.filter((e) => e.name === "lane-broken")).toEqual([]);
}, 120_000);
