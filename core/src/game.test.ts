// The revisioned game-state cache and TSV parsers (FAM-46).
import { expect, test } from "bun:test";
import {
	formatMoney,
	Game,
	parseBags,
	parseEquipment,
	parseLookup,
	parseMerchant,
	parseQuests,
	parseTalents,
	parseTaxi,
	parseTrainer,
} from "./game.ts";

test("pulls once per revision, serves unchanged slices from cache, and isolates characters", async () => {
	const game = new Game({ fetchTimeoutMs: 500 });
	const fetches: { id: number; slice: string }[] = [];
	let weapon = "Ashbringer";
	let rev = 1;
	game.setFetcher((id, slice) => {
		fetches.push({ id, slice });
		queueMicrotask(() => {
			game.receiveState(
				id,
				slice,
				rev,
				`mainHand\t13262\t88\t5\t1900\t\t90/100\t${weapon}`,
			);
		});
		return true;
	});

	game.see({ name: "Hero", realm: "Realm" }, { eq: 1 });
	const first = await game.get("eq");
	expect(first.cached).toBe(false);
	expect(first.revision).toBe(1);
	expect(first.items[0]?.name).toBe("Ashbringer");
	expect(fetches).toHaveLength(1);

	// Same revision: straight from cache, no fetch.
	const second = await game.get("eq");
	expect(second.cached).toBe(true);
	expect(second.items[0]?.name).toBe("Ashbringer");
	expect(fetches).toHaveLength(1);

	// Revision bumped in the next question: pulls fresh.
	weapon = "Thunderfury";
	rev = 2;
	game.see({ name: "Hero", realm: "Realm" }, { eq: 2 });
	const third = await game.get("eq");
	expect(third.cached).toBe(false);
	expect(third.revision).toBe(2);
	expect(third.items[0]?.name).toBe("Thunderfury");
	expect(fetches).toHaveLength(2);

	// Character switch: Alt does not inherit Hero's cached equipment even at the same revision.
	weapon = "Worn Shortsword";
	game.see({ name: "Alt", realm: "Realm" }, { eq: 2 });
	const alt = await game.get("eq");
	expect(alt.cached).toBe(false);
	expect(alt.items[0]?.name).toBe("Worn Shortsword");
	expect(fetches).toHaveLength(3);

	// Back to Hero at revision 2: still cached!
	game.see({ name: "Hero", realm: "Realm" }, { eq: 2 });
	const back = await game.get("eq");
	expect(back.cached).toBe(true);
	expect(back.items[0]?.name).toBe("Thunderfury");
	expect(fetches).toHaveLength(3);
});

test("deduplicates concurrent pulls for the same slice", async () => {
	const game = new Game({ fetchTimeoutMs: 500 });
	let sent = 0;
	let reply = () => {};
	game.setFetcher((id, slice) => {
		sent++;
		reply = () => game.receiveState(id, slice, 3, "meta\t10\t16\t500");
		return true;
	});
	game.see({ name: "Hero", realm: "Realm" }, { bags: 3 });
	const p1 = game.get("bags");
	const p2 = game.get("bags");
	expect(sent).toBe(1);
	reply();
	const [r1, r2] = await Promise.all([p1, p2]);
	expect(r1.freeSlots).toBe(10);
	expect(r2.freeSlots).toBe(10);
});

test("reports timeouts, addon errors and missing connection", async () => {
	const offline = new Game({ fetchTimeoutMs: 50 });
	await expect(offline.get("eq")).rejects.toThrow(/No connection/);

	const silent = new Game({ fetchTimeoutMs: 40 });
	silent.setFetcher(() => true);
	await expect(silent.get("quests")).rejects.toThrow(/did not send quests/);

	const broken = new Game({ fetchTimeoutMs: 500 });
	broken.setFetcher((id, slice) => {
		queueMicrotask(() =>
			broken.receiveState(id, slice, 1, "error\tnot ready yet"),
		);
		return true;
	});
	await expect(broken.get("talents")).rejects.toThrow("not ready yet");

	const failedSend = new Game({ fetchTimeoutMs: 500 });
	failedSend.setFetcher(() => false);
	await expect(failedSend.get("bags")).rejects.toThrow(/Could not ask/);
});

test("parses TSV payloads for equipment, bags, quests and talents", () => {
	expect(
		parseEquipment(
			[
				"head\t1234\t45\t3\t929\t101,102\t60/60\tHelm of Testing",
				"mainHand\t13262\t88\t5\t\t\t\tAshbringer",
				"truncated",
			].join("\n"),
		),
	).toEqual({
		items: [
			{
				slot: "head",
				id: 1234,
				name: "Helm of Testing",
				itemLevel: 45,
				quality: 3,
				enchantId: 929,
				gems: [101, 102],
				durability: { current: 60, max: 60 },
			},
			{
				slot: "mainHand",
				id: 13262,
				name: "Ashbringer",
				itemLevel: 88,
				quality: 5,
			},
		],
		truncated: true,
	});

	expect(
		parseBags(
			[
				"meta\t13\t16\t123456",
				"item\t2589\t20\t1\tLinen Cloth",
				"item\t6948\t1\t1\tHearthstone",
			].join("\n"),
		),
	).toEqual({
		freeSlots: 13,
		totalSlots: 16,
		money: { copper: 123456, formatted: "12g 34s 56c" },
		items: [
			{ id: 2589, count: 20, quality: 1, name: "Linen Cloth" },
			{ id: 6948, count: 1, quality: 1, name: "Hearthstone" },
		],
	});

	expect(
		parseQuests(
			[
				"q\t557\t33\t0\t1\tHillsbrad\tArmschienen der Bindung",
				"o\t0\tArmschienen der Erdbindung: 2/4",
				"q\t783\t1\t1\t0\t\tA Threat Within",
			].join("\n"),
		),
	).toEqual({
		quests: [
			{
				id: 557,
				level: 33,
				complete: false,
				watched: true,
				category: "Hillsbrad",
				title: "Armschienen der Bindung",
				objectives: [
					{ finished: false, text: "Armschienen der Erdbindung: 2/4" },
				],
			},
			{
				id: 783,
				level: 1,
				complete: true,
				watched: false,
				title: "A Threat Within",
				objectives: [],
			},
		],
	});

	expect(
		parseTalents(
			[
				"meta\t2\t6",
				"tree\tArms\t1",
				"tree\tFury\t5",
				"t\tArms\t1\t1\t12294\tMortal Strike",
				"t\tFury\t5\t5\t12320\tCruelty",
			].join("\n"),
		),
	).toEqual({
		unspent: 2,
		spent: 6,
		trees: [
			{ name: "Arms", spent: 1 },
			{ name: "Fury", spent: 5 },
		],
		talents: [
			{
				tree: "Arms",
				name: "Mortal Strike",
				rank: 1,
				maxRank: 1,
				spellId: 12294,
			},
			{ tree: "Fury", name: "Cruelty", rank: 5, maxRank: 5, spellId: 12320 },
		],
	});

	expect(formatMoney(0)).toBe("0c");
	expect(formatMoney(504)).toBe("5s 4c");
	expect(formatMoney(10000)).toBe("1g 0s 0c");
});

test("forgets cached slices and pending pulls when the game reloads its interface", async () => {
	const game = new Game({ fetchTimeoutMs: 500 });
	let weapon = "Ashbringer";
	let answer = true;
	let fetches = 0;
	game.setFetcher((id, slice) => {
		fetches++;
		if (answer)
			queueMicrotask(() =>
				game.receiveState(
					id,
					slice,
					1,
					`mainHand\t13262\t88\t5\t\t\t\t${weapon}`,
				),
			);
		return true;
	});
	game.see({ name: "Hero", realm: "Realm" }, { eq: 1 });
	expect((await game.get("eq")).items[0]?.name).toBe("Ashbringer");

	// After a reload the addon's counters restart: revision 1 now means other data.
	game.forget();
	weapon = "Thunderfury";
	game.see({ name: "Hero", realm: "Realm" }, { eq: 1 });
	const after = await game.get("eq");
	expect(after.cached).toBe(false);
	expect(after.items[0]?.name).toBe("Thunderfury");
	expect(fetches).toBe(2);

	// A pull the old interface will never answer fails at once instead of timing out.
	answer = false;
	game.see({ name: "Hero", realm: "Realm" }, { eq: 2 });
	const pending = game.get("eq");
	game.forget();
	// A read right after the reset pulls anew instead of joining the dropped pull.
	answer = true;
	game.see({ name: "Hero", realm: "Realm" }, { eq: 2 });
	const fresh = game.get("eq");
	await expect(pending).rejects.toThrow("reloaded");
	expect((await fresh).cached).toBe(false);
	expect(fetches).toBe(4);
});

test("parses merchant extended costs and pet trainer points", () => {
	const merchant = parseMerchant(
		[
			"meta\t2026-11-23 20:00\tTest Vendor",
			"m\t33042\t0\t1\t-1\t1\tOgre Tea",
			"mc\t2\titem\t29434\tBadge of Justice",
			"mc\t1500\tcurrency\t1901\tHonor Points",
			"m\t159\t25\t5\t-1\t1\tWater",
		].join("\n"),
	);
	expect(merchant.items).toEqual([
		{
			id: 33042,
			name: "Ogre Tea",
			price: { copper: 0, formatted: "0c" },
			extendedCost: [
				{ amount: 2, itemId: 29434, name: "Badge of Justice" },
				{ amount: 1500, currencyId: 1901, name: "Honor Points" },
			],
			stackCount: 1,
			numAvailable: -1,
			usable: true,
		},
		{
			id: 159,
			name: "Water",
			price: { copper: 25, formatted: "25c" },
			stackCount: 5,
			numAvailable: -1,
			usable: true,
		},
	]);

	const pet = parseTrainer(
		"meta\t2026-11-23 20:00\tPet Trainer\t3\ntr\tavailable\t30\t120\tRank 3\tBite",
	);
	expect(pet.trainerType).toBe("pet");
	expect(pet.services[0]?.cost).toEqual({ trainingPoints: 120 });

	const general = parseTrainer(
		"meta\t2026-11-23 20:00\tTrainer\t0\ntr\tavailable\t4\t100\t\tCharge",
	);
	expect(general.trainerType).toBe("general");
	expect(general.services[0]?.cost).toEqual({
		copper: 100,
		formatted: "1s 0c",
	});
});

test("parses where a quest leads, from a waypoint or the quest's area on the map", () => {
	const log = parseQuests(
		[
			"q\t783\t1\t0\t1\tElwynn Forest\tA Threat Within",
			"w\twaypoint\t1429\tElwynn Forest\t48.1\t42.0\tMarshal McBride",
			"o\t0\tSpeak with Marshal McBride: 0/1",
			"q\t7\t3\t0\t0\tElwynn Forest\tKobold Camp Cleanup",
			"w\tmap\t1429\tElwynn Forest\t40.5\t83.0\t",
			"q\t8\t5\t0\t0\t\tNo map",
		].join("\n"),
	);
	expect(log.quests[0]).toMatchObject({
		id: 783,
		location: {
			source: "waypoint",
			mapId: 1429,
			map: "Elwynn Forest",
			x: 48.1,
			y: 42,
			note: "Marshal McBride",
		},
		objectives: [{ text: "Speak with Marshal McBride: 0/1" }],
	});
	expect(log.quests[1]?.location).toEqual({
		source: "map",
		mapId: 1429,
		map: "Elwynn Forest",
		x: 40.5,
		y: 83,
	});
	expect(log.quests[2]?.location).toBeUndefined();
});

test("parses a lookup of an item, a spell, a quest and an unknown ID", () => {
	expect(
		parseLookup(
			"item",
			2589,
			"l\titem\t2589\tLinen Cloth\ni\t1\t5\t0\tTrade Goods\tCloth\t\t13\nt\tMax Stack: 200",
		),
	).toEqual({
		kind: "item",
		id: 2589,
		found: true,
		name: "Linen Cloth",
		quality: 1,
		itemLevel: 5,
		itemType: "Trade Goods",
		itemSubType: "Cloth",
		sellPrice: { copper: 13, formatted: "13c" },
		tooltip: ["Max Stack: 200"],
	});
	expect(
		parseLookup(
			"spell",
			133,
			"l\tspell\t133\tFireball\nd\tHurls a fiery ball.\nt\t30 Mana  35 yd range",
		),
	).toMatchObject({
		found: true,
		name: "Fireball",
		description: "Hurls a fiery ball.",
		tooltip: ["30 Mana  35 yd range"],
	});
	expect(
		parseLookup("quest", 7, "l\tquest\t7\tKobold Camp Cleanup\nqd\t3\t1\t0"),
	).toMatchObject({
		found: true,
		questLevel: 3,
		completed: true,
		inQuestLog: false,
	});
	expect(parseLookup("item", 999999, "none")).toEqual({
		kind: "item",
		id: 999999,
		found: false,
		tooltip: [],
	});
});

test("looks up through the addon once and answers again from memory until the interface reloads", async () => {
	const game = new Game({ fetchTimeoutMs: 500 });
	const asked: { slice: string; arg?: string }[] = [];
	game.setFetcher((id, slice, arg) => {
		asked.push({ slice, arg });
		queueMicrotask(() =>
			game.receiveState(id, slice, 0, "l\titem\t2589\tLinen Cloth"),
		);
		return true;
	});
	const [a, b] = await Promise.all([
		game.lookup("item", 2589),
		game.lookup("item", 2589),
	]);
	expect(a).toEqual(b);
	expect(await game.lookup("item", 2589)).toMatchObject({
		name: "Linen Cloth",
	});
	expect(asked).toEqual([{ slice: "lookup", arg: "item:2589" }]);
	game.forget();
	await game.lookup("item", 2589);
	expect(asked).toHaveLength(2);
});

test("a lookup still loading is an error, not an answer, and quests are never kept", async () => {
	expect(() => parseLookup("item", 4306, "loading")).toThrow(
		"still loading item 4306",
	);
	expect(parseLookup("quest", 424242, "none\tunsure")).toEqual({
		kind: "quest",
		id: 424242,
		found: false,
		unsure: true,
		tooltip: [],
	});
	const game = new Game({ fetchTimeoutMs: 500 });
	const answers = ["loading", "l\titem\t4306\tSilk Cloth"];
	let quests = 0;
	game.setFetcher((id, slice, arg) => {
		const payload = arg?.startsWith("quest")
			? `l\tquest\t783\tA Threat Within\nqd\t1\t${quests++ ? 1 : 0}\t1`
			: (answers.shift() ?? "none");
		queueMicrotask(() => game.receiveState(id, slice, 0, payload));
		return true;
	});
	await expect(game.lookup("item", 4306)).rejects.toThrow("still loading");
	expect(await game.lookup("item", 4306)).toMatchObject({ name: "Silk Cloth" });
	expect(await game.lookup("quest", 783)).toMatchObject({ completed: false });
	expect(await game.lookup("quest", 783)).toMatchObject({ completed: true });
});

test("parses flight paths and skips broken lines", () => {
	expect(
		parseTaxi(
			[
				"f\t23\t1\tOrgrimmar, Durotar\tKalimdor\t1454\tOrgrimmar\t45.2\t63.9",
				"f\t80\t0\tRatchet, The Barrens\tKalimdor\t1414\tKalimdor\t60.0\t55.0",
				"f\tx\t1\tbroken",
				"truncated",
			].join("\n"),
		),
	).toEqual({
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
				id: 80,
				name: "Ratchet, The Barrens",
				known: false,
				continent: "Kalimdor",
				mapId: 1414,
				zone: "Kalimdor",
				x: 60,
				y: 55,
			},
		],
		truncated: true,
	});
});
