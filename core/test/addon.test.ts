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
import { Game } from "../src/game.ts";
import type { Log } from "../src/log.ts";
import { wowTools } from "../src/mcp/tools.ts";
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
let gameState = new Game();
const questions: Question[] = [];
const chat: string[] = [];
/** Lines the window restored from the saved history. */
const restored: string[] = [];
/** The font of the window's history, each time the addon sets it. */
const fonts: string[] = [];
/** What the window's font strings showed, each time a test asked. */
const texts: string[] = [];
const errors: string[] = [];
/** What clicks on links in the window opened: "itemref <link>" or "questlog <id>". */
const clicks: string[] = [];
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

/** What the window's font strings show now, such as its status line. */
async function shown(): Promise<string> {
	const before = texts.length;
	command("texts");
	while (texts.length === before) await Bun.sleep(10);
	return texts.at(-1) ?? "";
}

/**
 * Starts the app's end, which answers every question with the echo. "never" gets no answer, and
 * "note" a note on the way.
 */
async function startApp(welcome = "the test app"): Promise<void> {
	const transport = new Transport({
		paths,
		log,
		welcome,
		processes: async () => pids,
		processPollMs: 50,
	});
	gameState = new Game();
	const conversation = new Conversation(
		{
			ask: (question, turn) => {
				questions.push(question);
				if (question.text === "never") return new Promise(() => {});
				if (question.text === "note") turn.onNote("Denied: echo a test.");
				return echoBrain.ask(question, turn);
			},
		},
		(body) => transport.send(body),
		log,
		gameState,
	);
	// The same wiring as main.ts.
	transport.onMessage((body, info) => conversation.receive(body, info));
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
				if (line.startsWith("font ")) fonts.push(line.slice(5));
				if (line.startsWith("texts ")) texts.push(line.slice(6));
				if (line.startsWith("error ")) errors.push(line.slice(6));
				if (line.startsWith("itemref ") || line.startsWith("questlog "))
					clicks.push(line);
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
		map: "1454",
		coords: "51.2,62.4",
		money: "123456",
	});
	expect(questions[0]?.revs).toEqual({
		eq: 1,
		bags: 1,
		quests: 1,
		talents: 1,
		stats: 1,
		prof: 1,
		rep: 1,
		spells: 1,
		bank: 0,
		merchant: 0,
		trainer: 0,
		// Entering the world bumps it once.
		taxi: 2,
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

	// Links in: a shift-click while the input line has the focus inserts the link. The brain
	// gets it as [item:id name] with its tooltip and the item worn in that slot.
	const thunderfury =
		"|cnIQ5:|Hitem:19019::::::::60:::::|h[Thunderfury, Blessed Blade of the Windseeker]|h|r";
	command("focus");
	command(`shiftclick ${thunderfury}`);
	command("enter better than mine?");
	at = await waitFor(
		/^\|cffffd100You:\|r \|cnIQ5:\|Hitem:19019:.*\|h\|r better than mine\?$/,
		at,
	);
	at = await waitFor(
		/:\|r heard: \|cnIQ5:\|Hitem:19019:.*\|h\|r better than mine\?$/,
		at,
	);
	expect(questions.at(-1)?.text).toBe(
		[
			"[item:19019 Thunderfury, Blessed Blade of the Windseeker] better than mine?",
			"",
			"Linked by the player (game data):",
			"[item:19019 Thunderfury, Blessed Blade of the Windseeker]",
			"  Binds when picked up",
			"  One-Hand  Sword",
			"Worn: [item:13262 Ashbringer]",
			"  Binds when picked up",
		].join("\n"),
	);
	at = await waitFor(
		/^Worn: \|cnIQ5:\|Hitem:13262:.*\|h\[Ashbringer\]\|h\|r$/,
		at,
	);

	// Links out: what the client knows becomes a link, once loaded; unknown IDs stay text.
	command("enter [item:2589] [spell:133] [quest:783] [item:999999] [spell:1]");
	at = await waitFor(
		/:\|r heard: \|cnIQ1:\|Hitem:2589:[^|]*\|h\[Linen Cloth\]\|h\|r \|cff71d5ff\|Hspell:133:0\|h\[Fireball\]\|h\|r \|cffffff00\|Hquest:783:1\|h\[A Threat Within\]\|h\|r \[item:999999\] \[spell:1\]$/,
		at,
	);

	// 2000 bytes take five fonts, and every line of the answer reaches the window.
	at = await roundTrip("2000", /^familiar familiar /, at);
	expect(chat[at - 2]).toMatch(/:\|r heard: 2000$/);
	// A | in an answer shows as text and never starts a link (AGENTS.md, rule 3).
	at = await roundTrip(
		"|Hitem:19019|h[Thunderfury]",
		/:\|r heard: \|\|Hitem:19019\|\|h\[Thunderfury\]$/,
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

// Every test below leaves the game connected. Run alone (-t), a test starts while the addon still
// says hello, so each waits for the first connection.
const CONNECTED = /Connected to the test app\.$/;

test("the window's settings apply at once, survive /reload and reset", async () => {
	/** Waits until the history got `font` after the first `from` times. */
	const shows = async (font: string, from = 0) => {
		const deadline = Date.now() + 5_000;
		while (!fonts.slice(from).includes(font)) {
			if (Date.now() > deadline)
				throw new Error(`no font ${font}; fonts: ${fonts.slice(from)}`);
			await Bun.sleep(20);
		}
	};
	await waitFor(CONNECTED, 0);
	// The window starts with the client's chat font.
	expect(fonts[0]).toBe("Fonts\\ARIALN.TTF 14 plain");

	command("slash /familiar config");
	command("slide Size 18");
	await shows("Fonts\\ARIALN.TTF 18 plain");
	command("click Outline");
	command("click Font");
	await shows("Fonts\\FRIZQT__.TTF 18 OUTLINE");

	const reloaded = fonts.length;
	const at = chat.length;
	command("reload");
	await shows("Fonts\\FRIZQT__.TTF 18 OUTLINE", reloaded);
	expect(fonts[reloaded]).toBe("Fonts\\FRIZQT__.TTF 18 OUTLINE");

	command("slash /familiar config");
	command("click Reset");
	await shows("Fonts\\ARIALN.TTF 14 plain", reloaded + 1);
	// The addon says hello again after /reload; the next test needs the connection.
	await waitFor(CONNECTED, at);
	expect(errors).toEqual([]);
});

test("a helper that something else switched on costs one attempt, not the connection", async () => {
	await waitFor(CONNECTED, 0);
	const from = chat.length;
	// Bit 7 of a data byte: plain text never sets it, so the lane never switched it off again.
	command("poke Familiar_L207");
	command("slash /familiar say after a poke");
	await waitFor(/heard: after a poke$/, from);
	const sent = await waitFor(/^Sent in /, from);
	// The first attempt is garbled; the second starts 3 s later.
	expect(chat[sent - 1]).toMatch(/^Sent in [3-5]\.\d+ s\.$/);
	expect(chat.slice(from).filter((l) => l.startsWith("Not sent"))).toEqual([]);
	expect(errors).toEqual([]);
}, 30_000);

test("without game sound Familiar says so, and connects again once it is back", async () => {
	await waitFor(CONNECTED, 0);
	const from = chat.length;
	command("sound off");
	command("slash /familiar say into the silence");
	let at = await waitFor(
		/^Not sent: the game sound is off, so Familiar cannot hear the app\.$/,
		from,
		30_000,
	);
	at = await waitFor(/^Familiar needs the game sound: /, at);
	expect(
		chat.slice(from).filter((l) => l.includes("stopped answering")),
	).toEqual([]);

	command("sound on");
	// The app had the question all along: its answer is the first doorbell Familiar hears.
	await waitFor(/heard: into the silence$/, at, 30_000);
	at = await waitFor(CONNECTED, at, 30_000);
	await roundTrip("with sound again", /heard: with sound again$/, at);
	expect(errors).toEqual([]);
}, 90_000);

test("a confirmed question without an answer ends when the app's patience is over", async () => {
	await waitFor(CONNECTED, 0);
	// The welcome names the patience, so the addon has to say hello again.
	const patient = "the test app\npatience: 2";
	app?.stop();
	await startApp(patient);
	let at = chat.length;
	command("reload");
	at = await waitFor(CONNECTED, at);
	command("slash /familiar say never");
	at = await waitFor(/^Sent in /, at);
	expect(await shown()).toContain("Thinking …");

	// The app restarts while the brain works: nobody will answer this question.
	app?.stop();
	await startApp(patient);
	at = await waitFor(
		/^No answer from the app after \d+ s\. The question is lost; ask it again\.$/,
		at,
	);
	expect(await shown()).not.toContain("Thinking");
	at = await roundTrip("after a lost one", /heard: after a lost one$/, at);

	app?.stop();
	await startApp();
	at = chat.length;
	command("reload");
	await waitFor(CONNECTED, at);
	expect(errors).toEqual([]);
}, 60_000);

test("the window shows what the app notes while the brain works", async () => {
	await waitFor(CONNECTED, 0);
	const from = chat.length;
	command("slash /familiar say note");
	await waitFor(/^Denied: echo a test\.$/, from);
	await waitFor(/:\|r heard: note$/, from);
	expect(errors).toEqual([]);
});

test("pulls equipment, bags, quests and talents on demand, caches by revision and isolates characters", async () => {
	let at = await waitFor(CONNECTED, 0);
	at = await roundTrip("before pull", /heard: before pull$/, at);
	const eq1 = await gameState.get("eq");
	expect(eq1.cached).toBe(false);
	expect(eq1.revision).toBe(1);
	expect(eq1.items).toEqual([
		{
			slot: "mainHand",
			id: 13262,
			name: "Ashbringer",
			itemLevel: 88,
			quality: 5,
			durability: { current: 95, max: 100 },
		},
	]);

	// Unchanged revision: served straight from cache without touching the transport.
	const eqCached = await gameState.get("eq");
	expect(eqCached.cached).toBe(true);
	expect(eqCached.items[0]?.name).toBe("Ashbringer");

	// All other slices pull cleanly over the real transport too.
	const bags = await gameState.get("bags");
	expect(bags.freeSlots).toBe(13);
	expect(bags.totalSlots).toBe(16);
	expect(bags.money).toEqual({ copper: 123456, formatted: "12g 34s 56c" });
	expect(bags.items).toEqual([
		{ id: 2589, count: 20, quality: 1, name: "Linen Cloth" },
		{ id: 6948, count: 1, quality: 1, name: "Hearthstone" },
	]);

	const quests = await gameState.get("quests");
	expect(quests.quests).toEqual([
		{
			id: 783,
			level: 1,
			complete: false,
			watched: true,
			category: "Elwynn Forest",
			title: "A Threat Within",
			location: {
				source: "waypoint",
				mapId: 1429,
				map: "Elwynn Forest",
				x: 48.1,
				y: 42,
				note: "Marshal McBride",
			},
			objectives: [
				{ finished: false, text: "Speak with Marshal McBride: 0/1" },
			],
		},
	]);

	const talents = await gameState.get("talents");
	expect(talents.unspent).toBe(2);
	expect(talents.spent).toBe(6);
	expect(talents.trees).toEqual([
		{ name: "Arms", spent: 1 },
		{ name: "Fury", spent: 5 },
	]);
	expect(talents.talents).toEqual([
		{
			tree: "Arms",
			name: "Mortal Strike",
			rank: 1,
			maxRank: 1,
			spellId: 12294,
		},
		{ tree: "Fury", name: "Cruelty", rank: 5, maxRank: 5, spellId: 12320 },
	]);

	// Equipping another weapon bumps the equipment revision; the next question carries it.
	command("equip 16 19019");
	at = await roundTrip("after equip", /heard: after equip$/, at);
	expect(questions.at(-1)?.revs?.eq).toBe(2);
	const eq2 = await gameState.get("eq");
	expect(eq2.cached).toBe(false);
	expect(eq2.revision).toBe(2);
	expect(eq2.items[0]).toMatchObject({
		slot: "mainHand",
		id: 19019,
		name: "Thunderfury, Blessed Blade of the Windseeker",
		enchantId: 1900,
	});

	// Switching to Alt isolates Hero's cache.
	command("login Alt");
	at = await waitFor(CONNECTED, at);
	at = await roundTrip("as alt", /heard: as alt$/, at);
	const altEq = await gameState.get("eq");
	expect(altEq.cached).toBe(false);
	expect(altEq.items[0]?.id).toBe(19019);

	// Leave Hero logged in for any later test.
	command("login Hero");
	await waitFor(CONNECTED, at);
	expect(errors).toEqual([]);
}, 45_000);

test("reads the second collectors through the addon and keeps session-only visits", async () => {
	let at = await waitFor(CONNECTED, 0);
	at = await roundTrip("before visits", /heard: before visits$/, at);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const tool = wowTools(gameState).find((t) => t.name === name);
		if (!tool) throw new Error(`Missing tool: ${name}`);
		return await tool.call(args);
	};
	expect(await call("stats")).toMatchObject({
		healthMax: 1600,
		armor: 421,
		spellCrit: 4.5,
	});
	expect(await call("professions", { search: "min" })).toMatchObject({
		skills: [{ name: "Mining", rank: 42, maxRank: 75 }],
	});
	expect(await call("reputation", { search: "bluff" })).toMatchObject({
		factions: [{ name: "Thunder Bluff", current: 1750, max: 6000 }],
	});
	expect(await call("spells", { includePassive: false })).toMatchObject({
		spells: [{ id: 133, name: "Fireball" }],
	});
	for (const key of ["bank", "merchant", "trainer"])
		expect(await call(key)).toMatchObject({ available: false });
	command("visit");
	at = await roundTrip("after visits", /heard: after visits$/, at);
	expect(await call("bank")).toMatchObject({
		available: true,
		freeSlots: 4,
		totalSlots: 4,
		items: [],
	});
	expect(await call("merchant", { search: "water" })).toMatchObject({
		available: true,
		npc: "Test Vendor",
		items: [{ name: "Water", price: { copper: 25 } }],
	});
	expect(await call("trainer", { onlyAvailable: true })).toMatchObject({
		available: true,
		services: [{ name: "Charge", cost: { copper: 100 } }],
	});
	expect(await call("bank")).toMatchObject({ cached: true });
	expect(errors).toEqual([]);
}, 60_000);

test("stats the game hides are named, not computed with, and read again next time", async () => {
	let at = await waitFor(CONNECTED, 0);
	const call = async (name: string) => {
		const tool = wowTools(gameState).find((t) => t.name === name);
		if (!tool) throw new Error(`Missing tool: ${name}`);
		return (await tool.call({})) as Record<string, unknown>;
	};
	at = await roundTrip("stats plain", /heard: stats plain$/, at);
	expect(await call("stats")).toMatchObject({
		meleeAP: 115,
		spellDamage: 37,
		armor: 421,
	});

	// In combat, say: the game hands the addon secret values (Collect.lua used to fail on them).
	command("set secretStats 1");
	command("fire UNIT_ATTACK_POWER player");
	at = await roundTrip("stats hidden", /heard: stats hidden$/, at);
	const hidden = await call("stats");
	expect(hidden).toMatchObject({
		healthMax: 1600,
		hidden: ["armor", "meleeAP", "spellCrit", "spellDamage"],
	});
	expect(hidden.note).toContain("hid these values");
	for (const key of ["armor", "meleeAP", "spellCrit", "spellDamage"])
		expect(hidden[key]).toBeUndefined();

	// After combat no stats event need fire: the addon counts a hidden read as changed, so the
	// next question reads the game again instead of the cache.
	command("set secretStats 0");
	at = await roundTrip("stats back", /heard: stats back$/, at);
	const back = await call("stats");
	expect(back).toMatchObject({
		cached: false,
		meleeAP: 115,
		spellCrit: 4.5,
		spellDamage: 37,
	});
	expect(back.hidden).toBeUndefined();
	expect(errors).toEqual([]);
}, 45_000);

test("collector revisions follow late events and restart with the interface", async () => {
	let at = await waitFor(CONNECTED, 0);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const tool = wowTools(gameState).find((t) => t.name === name);
		if (!tool) throw new Error(`Missing tool: ${name}`);
		return await tool.call(args);
	};

	// A defense change alone bumps stats, so the cached sheet is not served again.
	at = await roundTrip("stats before", /heard: stats before$/, at);
	expect(await call("stats")).toMatchObject({ defense: 100 });
	command("set defense 101");
	command("fire UNIT_DEFENSE player");
	at = await roundTrip("stats after", /heard: stats after$/, at);
	expect(await call("stats")).toMatchObject({ defense: 101, cached: false });

	// Trainer names that load after the window opened still reach the snapshot.
	command("set trainerNames 0");
	command("fire TRAINER_SHOW");
	at = await roundTrip("trainer open", /heard: trainer open$/, at);
	expect(await call("trainer")).toMatchObject({
		available: true,
		services: [],
	});
	command("set trainerNames 1");
	command("fire TRAINER_SERVICE_INFO_NAME_UPDATE");
	command("fire TRAINER_CLOSED");
	at = await roundTrip("names loaded", /heard: names loaded$/, at);
	expect(await call("trainer")).toMatchObject({
		cached: false,
		trainerType: "general",
		services: [{ name: "Charge", cost: { copper: 100 } }],
	});

	// A pet trainer's costs are training points.
	command("set trainerType 3");
	command("fire TRAINER_SHOW");
	command("fire TRAINER_CLOSED");
	at = await roundTrip("pet trainer", /heard: pet trainer$/, at);
	expect(await call("trainer")).toMatchObject({
		trainerType: "pet",
		services: [{ name: "Charge", cost: { trainingPoints: 100 } }],
	});

	// Revisions restart with every interface load: merchant A and B both get revision 1.
	command("reload");
	at = await waitFor(CONNECTED, at);
	command("fire MERCHANT_SHOW");
	at = await roundTrip("merchant a", /heard: merchant a$/, at);
	expect(await call("merchant")).toMatchObject({
		revision: 1,
		items: [{ name: "Water" }],
	});
	command("reload");
	at = await waitFor(CONNECTED, at);
	command("set merchantItem Ogre Tea");
	command("set token 1");
	command("fire MERCHANT_SHOW");
	at = await roundTrip("merchant b", /heard: merchant b$/, at);
	expect(await call("merchant")).toMatchObject({
		revision: 1,
		cached: false,
		items: [
			{
				name: "Ogre Tea",
				price: { copper: 0 },
				extendedCost: [{ amount: 2, itemId: 29434, name: "Badge of Justice" }],
			},
		],
	});

	for (const [key, value] of Object.entries({
		defense: "100",
		merchantItem: "Water",
		token: "0",
		trainerType: "0",
	}))
		command(`set ${key} ${value}`);
	expect(errors).toEqual([]);
}, 60_000);

test("quests show where they lead, and any item, spell or quest can be looked up by ID", async () => {
	let at = await waitFor(CONNECTED, 0);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const tool = wowTools(gameState).find((t) => t.name === name);
		if (!tool) throw new Error(`Missing tool: ${name}`);
		return await tool.call(args);
	};
	const reset = () => {
		for (const [key, value] of Object.entries({
			waypoint: "1",
			poiMap: "1454",
			slowLoads: "0",
			done783: "0",
			noMap: "0",
			ratchet: "0",
		}))
			command(`set ${key} ${value}`);
	};

	// Without a waypoint, the quest's area on the player's map: here Orgrimmar.
	command("set waypoint 0");
	command("fire QUEST_POI_UPDATE");
	at = await roundTrip("no waypoint", /heard: no waypoint$/, at);
	expect(await call("quests")).toMatchObject({
		cached: false,
		quests: [
			{
				id: 783,
				location: {
					source: "map",
					mapId: 1454,
					map: "Orgrimmar",
					x: 50,
					y: 62.5,
				},
			},
		],
	});
	// Marked only on the parent zone, the area is found there.
	command("set poiMap 1411");
	command("fire ZONE_CHANGED_NEW_AREA");
	at = await roundTrip("parent zone", /heard: parent zone$/, at);
	expect(await call("quests")).toMatchObject({
		cached: false,
		quests: [
			{ id: 783, location: { source: "map", mapId: 1411, map: "Durotar" } },
		],
	});
	// Marked only in a zone far away on the same continent, it is found there too.
	command("set poiMap 1443");
	command("fire QUEST_POI_UPDATE");
	at = await roundTrip("far zone", /heard: far zone$/, at);
	expect(await call("quests")).toMatchObject({
		cached: false,
		quests: [
			{ id: 783, location: { source: "map", mapId: 1443, map: "Desolace" } },
		],
	});

	// Flight paths of the Horde and neutral ones, on both continents, in zone coordinates.
	expect(await call("flightpaths")).toMatchObject({
		cached: false,
		nodes: [
			{
				id: 23,
				name: "Orgrimmar, Durotar",
				known: true,
				continent: "Kalimdor",
				mapId: 1454,
				zone: "Orgrimmar",
				x: 45.2,
				y: 63.9,
			},
			{
				id: 25,
				name: "Crossroads, The Barrens",
				known: true,
				zone: "The Barrens",
				x: 51.4,
				y: 30.3,
			},
			{ id: 80, name: "Ratchet, The Barrens", known: false },
			{
				id: 18,
				name: "Booty Bay, Stranglethorn",
				known: true,
				continent: "Eastern Kingdoms",
				zone: "Stranglethorn Vale",
			},
		],
	});
	expect(
		(
			(await call("flightpaths", { known: true })) as {
				nodes: { id: number }[];
			}
		).nodes.map((n) => n.id),
	).toEqual([23, 25, 18]);
	expect(
		(
			(await call("flightpaths", { search: "barrens" })) as {
				nodes: { id: number }[];
			}
		).nodes.map((n) => n.id),
	).toEqual([25, 80]);
	expect(await call("flightpaths")).toMatchObject({ cached: true });
	// A flight path found at a flight master shows at once.
	command("set ratchet 1");
	command("fire TAXI_NODE_STATUS_CHANGED");
	at = await roundTrip("found ratchet", /heard: found ratchet$/, at);
	expect(
		(await call("flightpaths", { known: true })) as {
			cached: boolean;
			nodes: { id: number }[];
		},
	).toMatchObject({
		cached: false,
		nodes: [{ id: 23 }, { id: 25 }, { id: 80 }, { id: 18 }],
	});
	// Without a map, as during a loading screen, it is an error to retry, not an empty list.
	command("set noMap 1");
	command("fire TAXIMAP_CLOSED");
	at = await roundTrip("no map", /heard: no map$/, at);
	await expect(call("flightpaths")).rejects.toThrow("no map for the character");
	command("set noMap 0");
	expect(await call("flightpaths")).toMatchObject({ cached: false });
	command("set ratchet 0");

	expect(await call("lookup", { kind: "item", id: 2589 })).toMatchObject({
		found: true,
		name: "Linen Cloth",
		quality: 1,
		itemLevel: 5,
		itemType: "Trade Goods",
		itemSubType: "Cloth",
		sellPrice: { copper: 13, formatted: "13c" },
		tooltip: ["Max Stack: 200", "Sell Price: 13 copper"],
	});
	expect(await call("lookup", { kind: "spell", id: 133 })).toMatchObject({
		found: true,
		name: "Fireball",
		description: "Hurls a fiery ball that causes 14 to 22 Fire damage.",
		tooltip: [
			"30 Mana  35 yd range",
			"Hurls a fiery ball that causes 14 to 22 Fire damage.",
		],
	});

	// An item the client loads too slowly is an error to retry, not an answer to keep.
	command("set slowLoads 20");
	await expect(call("lookup", { kind: "item", id: 4306 })).rejects.toThrow(
		"still loading item 4306",
	);
	expect(await call("lookup", { kind: "item", id: 4306 })).toMatchObject({
		found: true,
		name: "Silk Cloth",
		sellPrice: { copper: 150 },
	});

	// A quest's status is asked anew every time: it changes while playing.
	expect(await call("lookup", { kind: "quest", id: 783 })).toMatchObject({
		found: true,
		completed: false,
		inQuestLog: true,
	});
	command("set done783 1");
	expect(await call("lookup", { kind: "quest", id: 783 })).toMatchObject({
		completed: true,
	});
	expect(await call("lookup", { kind: "quest", id: 7 })).toMatchObject({
		found: true,
		name: "Kobold Camp Cleanup",
		questLevel: 3,
		completed: true,
		inQuestLog: false,
	});

	expect(await call("lookup", { kind: "item", id: 999999 })).toEqual({
		kind: "item",
		id: 999999,
		found: false,
		tooltip: [],
	});
	// The client cannot tell an unknown quest from a loading one, so it waits and says so.
	const started = performance.now();
	expect(await call("lookup", { kind: "quest", id: 424242 })).toEqual({
		kind: "quest",
		id: 424242,
		found: false,
		unsure: true,
		tooltip: [],
	});
	expect(performance.now() - started).toBeGreaterThan(2500);
	reset();
	expect(errors).toEqual([]);
}, 90_000);

test("a click on a quest in the log opens the quest log, other links their tooltip", async () => {
	await waitFor(CONNECTED, 0);
	const click = async (what: string) => {
		const from = clicks.length;
		command(`linkclick ${what}`);
		const until = Date.now() + 5000;
		while (clicks.length === from && Date.now() < until) await Bun.sleep(20);
		return clicks.slice(from);
	};
	// In the log: the quest log with its map.
	expect(await click("LeftButton quest:783:1")).toEqual(["questlog 783"]);
	// Not in the log, another button, a modifier or combat: the game's usual handling.
	expect(await click("LeftButton quest:7:3")).toEqual(["itemref quest:7:3"]);
	expect(await click("RightButton quest:783:1")).toEqual([
		"itemref quest:783:1",
	]);
	expect(await click("shift quest:783:1")).toEqual(["itemref quest:783:1"]);
	command("set combat 1");
	expect(await click("LeftButton quest:783:1")).toEqual([
		"itemref quest:783:1",
	]);
	command("set combat 0");
	// If the quest log cannot open, the click still shows the tooltip.
	command("set questMapFails 1");
	expect(await click("LeftButton quest:783:1")).toEqual([
		"itemref quest:783:1",
	]);
	command("set questMapFails 0");
	expect(await click("LeftButton item:19019::::::::60")).toEqual([
		"itemref item:19019::::::::60",
	]);
	expect(errors).toEqual([]);
}, 30_000);
