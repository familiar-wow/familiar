import { expect, test } from "bun:test";
import {
	emptyView,
	present,
	snapshot,
	trayUpdate,
	type View,
} from "./overview.ts";
import type { Status } from "./types.ts";

const connected: Status = {
	running: true,
	client: "C:\\WoW\\_forever_",
	addon: { installed: true },
	game: { running: true, hello: "Familiar 0.14.0", lastContact: 0 },
	character: {
		name: "Moonbreeze",
		level: "35",
		race: "Tauren",
		class: "Druid",
		zone: "Desolace",
	},
	brain: { kind: "agent", command: ["hermes", "acp"] },
	last: { at: 0, ms: 24_100, tools: [] },
	problems: [],
};
const evening = new Date(2026, 10, 25, 23, 0).getTime();
const view = (over: Partial<View>): View => ({
	...emptyView("en"),
	gen: 1,
	...over,
});

test("greets the character by name, by local time", () => {
	const status = {
		...connected,
		game: { ...connected.game, lastContact: evening - 4000 },
	};
	const o = present(view({ status }), evening);
	expect(o.heading).toBe("Good evening, Moonbreeze");
	expect(o.sub).toBe("Familiar is listening. Ask in game with /familiar.");
	expect(o.game).toEqual({
		headline: "Connected",
		name: "Moonbreeze",
		who: "Level 35 Tauren Druid · Desolace",
		contact: "last contact 4 s ago",
		canRestart: false,
	});
	expect(present(view({}), evening).heading).toBe("Familiar");
});

test("after the core stopped: the last stderr line and a restart", () => {
	const o = present(
		view({
			status: connected,
			exited: true,
			stderrTail: ["first", "last", "  "],
		}),
		evening,
	);
	expect(o.connection).toBe("error");
	expect(o.game).toEqual({
		headline: "Familiar's core stopped.",
		stderr: "last",
		canRestart: true,
	});
});

test("the restart banner, and the problems as a list", () => {
	const o = present(
		view({
			status: { ...connected, restartNeeded: true, problems: ["Port in use."] },
		}),
		evening,
	);
	expect(o.restartNeeded).toBe(true);
	expect(o.problems).toEqual(["Port in use."]);
	expect(o.game.headline).toBe("Something needs your attention.");
});

test("the tray gets at most 3 questions; the overview 8", () => {
	const log = Array.from({ length: 10 }, (_, i) => ({
		at: i,
		event: "question",
		text: `#${i}`,
	}));
	expect(present(view({ log }), evening).questions).toHaveLength(8);
	expect(snapshot(view({ log })).recent.map((q) => q.text)).toEqual([
		"#9",
		"#8",
		"#7",
	]);
	expect(present(view({ log }), evening).questions[0]?.duration).toBe("…");
});

test("the tray icon names the state and the character", () => {
	expect(trayUpdate(view({ status: connected }))).toEqual({
		state: "connected",
		tooltip: "Familiar: Connected · Moonbreeze",
		open: "Open Familiar",
		quit: "Quit",
	});
	expect(trayUpdate(view({ failure: "x".repeat(200) })).tooltip).toHaveLength(
		120,
	);
});
