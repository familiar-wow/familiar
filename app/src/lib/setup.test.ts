import { expect, test } from "bun:test";
import type { BrainKind, Settings } from "./brain.ts";
import type { GameState, Outcome } from "./game.ts";
import { translator } from "./i18n.ts";
import { emptyView, type View } from "./overview.ts";
import {
	addonResult,
	brainCards,
	laterLine,
	nextStep,
	presentSetup,
	previousStep,
	progress,
	SetupController,
	type SetupState,
	STEPS,
} from "./setup.ts";
import type { GameClient, Page, Status } from "./types.ts";

const t = translator("en");
const MAIN = "C:\\Program Files (x86)\\World of Warcraft\\_forever_";
const OTHER = "D:\\Games\\World of Warcraft\\_forever_";

function status(over: Partial<Status> = {}): Status {
	return {
		running: false,
		client: MAIN,
		addon: { installed: true },
		game: { running: false },
		brain: { kind: "agent", command: ["hermes", "acp"] },
		problems: [],
		...over,
	};
}

const NEW_PLAYER: Settings = {
	app: { language: "system", close: "tray", setupDone: false },
	game: {},
	brain: { use: "agent", command: ["hermes", "acp"] },
};

const view = (over: Partial<View> = {}): View => ({
	...emptyView("en"),
	gen: 1,
	version: "0.15.0",
	status: status(),
	settings: NEW_PLAYER,
	...over,
});

const current: GameClient = {
	client: MAIN,
	version: "1.60.1",
	installed: true,
	addonVersion: "0.15.0",
};
const missing: GameClient = {
	client: OTHER,
	version: "1.60.1",
	installed: false,
};

const game = (over: Partial<GameState> = {}): GameState => ({
	clients: [current, missing],
	loaded: true,
	confirming: false,
	...over,
});

const at = (step: SetupState["step"]): SetupState => ({
	step,
	finishing: false,
});

const repaired = (over: Partial<Outcome & { kind: "repaired" }> = {}) =>
	({
		kind: "repaired",
		fresh: false,
		added: 0,
		updated: 0,
		removed: 0,
		wowRunning: false,
		...over,
	}) as Outcome;

test("three steps in order: game, addon, brain", () => {
	expect(STEPS).toEqual(["game", "addon", "brain"]);
	expect(nextStep("game")).toBe("addon");
	expect(nextStep("addon")).toBe("brain");
	expect(nextStep("brain")).toBeUndefined();
	expect(previousStep("game")).toBeUndefined();
	expect(previousStep("brain")).toBe("addon");
	expect(progress("addon").map((p) => [p.n, p.step, p.state])).toEqual([
		[1, "game", "done"],
		[2, "addon", "current"],
		[3, "brain", "todo"],
	]);
});

test("the game step goes on only with a client in use", () => {
	const next = (g: GameState, v: View = view()) =>
		presentSetup(at("game"), g, v, t).canNext;
	// Found, and the core picked it by itself.
	expect(next(game())).toBe(true);
	// Chosen by the player.
	expect(
		next(
			game({ configured: OTHER }),
			view({ status: status({ client: undefined }) }),
		),
	).toBe(true);
	// Found several, none in use yet.
	expect(next(game(), view({ status: status({ client: undefined }) }))).toBe(
		false,
	);
	// Nothing found, or still searching.
	expect(
		next(
			game({ clients: [] }),
			view({ status: status({ client: undefined }) }),
		),
	).toBe(false);
	expect(next(game({ clients: [], loaded: false }))).toBe(false);
	// Not while a search or a save runs.
	expect(next(game({ busy: "find" }))).toBe(false);
	expect(next(game({ busy: "save" }))).toBe(false);
	expect(presentSetup(at("game"), game(), view(), t).canBack).toBe(false);
});

test("the addon step: install, update, or say it is current", () => {
	const addon = (g: GameState) => presentSetup(at("addon"), g, view(), t);
	// The core's client has the current addon: say so, and go on.
	let p = addon(game());
	expect(p.addon).toMatchObject({ client: MAIN, current: true, tone: "good" });
	expect(p.addon.action).toBeUndefined();
	expect(p.canNext).toBe(true);
	expect(p.canBack).toBe(true);
	// Nothing there yet: install first.
	p = addon(game({ configured: OTHER }));
	expect(p.addon).toMatchObject({
		client: OTHER,
		action: "install",
		current: false,
	});
	expect(p.canNext).toBe(false);
	// An older addon: update first.
	p = addon(game({ clients: [{ ...current, addonVersion: "0.14.0" }] }));
	expect(p.addon.action).toBe("update");
	expect(p.canNext).toBe(false);
	// Installed now: go on, also before the list says so.
	p = addon(
		game({ configured: OTHER, outcome: repaired({ fresh: true, added: 257 }) }),
	);
	expect(p.canNext).toBe(true);
	expect(p.addon.result?.text).toBe("Addon installed.");
	// A failure: the core's words, the button to try again, no Next.
	p = addon(
		game({
			configured: OTHER,
			outcome: { kind: "failed", message: "The folder is read-only." },
		}),
	);
	expect(p.addon.result).toEqual({
		text: "The folder is read-only.",
		error: true,
	});
	expect(p.addon.action).toBe("install");
	expect(p.canNext).toBe(false);
	// Not while installing.
	expect(addon(game({ busy: "repair" })).canNext).toBe(false);
	expect(addon(game({ busy: "repair" })).busy).toBe(true);
});

test("the addon result line and the hint about a running WoW", () => {
	expect(
		addonResult(repaired({ fresh: true, added: 257, wowRunning: true }), t),
	).toEqual({
		text: "Addon installed.",
		error: false,
		hint: {
			text: "WoW is running: quit WoW completely and start it again; /reload does not find new files.",
			waiting: true,
		},
	});
	expect(addonResult(repaired({ updated: 3, wowRunning: true }), t)).toEqual({
		text: "Addon updated: 3 files changed.",
		error: false,
		hint: {
			text: "WoW is running: type /reload in game to load the update.",
			waiting: true,
		},
	});
	// New helper files among the changes: /reload is not enough.
	expect(
		addonResult(repaired({ added: 2, updated: 3, wowRunning: true }), t).hint
			?.text,
	).toStartWith("WoW is running: quit WoW");
	// WoW not running: it loads with the next start.
	expect(addonResult(repaired({ fresh: true, added: 257 }), t).hint).toEqual({
		text: "The addon loads when you start WoW Forever.",
		waiting: false,
	});
	// Nothing changed: up to date, nothing to do in game.
	expect(addonResult(repaired({ wowRunning: true }), t)).toEqual({
		text: "The addon is already up to date.",
		error: false,
	});
	expect(addonResult({ kind: "failed", message: "Disk full." }, t)).toEqual({
		text: "Disk full.",
		error: true,
	});
});

test("the brain step never goes Next: a card or Later finishes", () => {
	const p = presentSetup(at("brain"), game(), view(), t);
	expect(p.canNext).toBe(false);
	expect(p.canBack).toBe(true);
	expect(
		presentSetup({ step: "addon", finishing: true }, game(), view(), t),
	).toMatchObject({
		canNext: false,
		canBack: false,
		busy: true,
	});
});

test("brain cards: four kinds in the tab order, the one that answers in use", () => {
	const cards = brainCards(NEW_PLAYER, t);
	expect(cards.map((c) => [c.kind, c.name, c.set])).toEqual([
		["chatgpt", "ChatGPT plan", false],
		["key", "API key", false],
		["local", "Local model", false],
		["agent", "Your own agent", true],
	]);
	// Only true claims: no web search for the built-in agent, only for the player's own.
	for (const card of cards.slice(0, 3))
		expect(card.cons).toContain("No web search in this version");
	expect(cards[3]?.pros).toContain("Web search, if your agent has it");
	expect(cards[0]?.pros).toEqual(["No extra cost with a Plus or Pro plan"]);
	expect(cards[1]?.cons).toContain("You pay per use");
	expect(cards[2]?.cons).toContain("Needs a strong PC");
	const chatgpt: Settings = {
		brain: { use: "model", model: { provider: "chatgpt", name: "gpt-5.5" } },
	};
	expect(brainCards(chatgpt, t).find((c) => c.set)?.kind).toBe("chatgpt");
});

test("Later says which brain stays, and that the default needs an agent", () => {
	expect(laterLine(NEW_PLAYER, t)).toBe(
		"For now, Familiar answers with your own agent (hermes acp). That needs the agent installed on this PC.",
	);
	expect(laterLine({}, t)).toContain("(hermes acp)");
	expect(
		laterLine(
			{
				brain: {
					use: "agent",
					ssh: { host: "homelab", auth: "key", command: ["hermes", "acp"] },
				},
			},
			t,
		),
	).toBe("For now, Familiar answers with your own agent on homelab.");
	expect(
		laterLine(
			{
				brain: {
					use: "model",
					model: { provider: "ollama", name: "qwen3:14b" },
				},
			},
			t,
		),
	).toBe("For now, Familiar answers with qwen3:14b (Local model).");
	// A provider the page does not know: no guess.
	expect(
		laterLine(
			{ brain: { use: "model", model: { provider: "local-x", name: "m" } } },
			t,
		),
	).toBe("For now, Familiar answers with the brain in your settings.");
});

function fake(finish: (then?: Page) => Promise<void> = async () => {}) {
	const calls: string[] = [];
	const setup = new SetupController({
		finishSetup: (then?: Page, tab?: BrainKind) => {
			calls.push(`finishSetup ${then ?? "-"}${tab ? ` ${tab}` : ""}`);
			return finish(then);
		},
	});
	return { setup, calls };
}

test("Next and Back move one step, Next only when the page allows it", () => {
	const { setup } = fake();
	const seen: string[] = [];
	setup.watch((s) => seen.push(s.step));
	setup.back();
	expect(setup.state.step).toBe("game");
	setup.next(false);
	expect(setup.state.step).toBe("game");
	setup.next(true);
	setup.next(true);
	expect(setup.state.step).toBe("brain");
	setup.next(true);
	expect(setup.state.step).toBe("brain");
	setup.back();
	expect(seen).toEqual(["addon", "brain", "addon"]);
});

test("Skip and Later finish with the brain as it is", async () => {
	const { setup, calls } = fake();
	await setup.finish();
	expect(calls).toEqual(["finishSetup -"]);
	expect(setup.state).toEqual({ step: "game", finishing: false });
});

test("a brain card finishes the setup with its tab, one leaving at a time", async () => {
	let release = () => {};
	const { setup, calls } = fake(
		() => new Promise<void>((resolve) => (release = resolve)),
	);
	const done = setup.choose("key");
	expect(calls).toEqual(["finishSetup brain key"]);
	expect(setup.state.finishing).toBe(true);
	// One at a time.
	await setup.choose("local");
	await setup.finish();
	expect(calls).toHaveLength(1);
	release();
	await done;
	expect(setup.state.finishing).toBe(false);
});

test("a failed finish shows the core's words and allows another try", async () => {
	const { setup, calls } = fake(async () => {
		throw new Error("The settings file could not be written.");
	});
	await setup.finish();
	expect(setup.state).toEqual({
		step: "game",
		finishing: false,
		error: "The settings file could not be written.",
	});
	setup.next(true);
	expect(setup.state.error).toBeUndefined();
	await setup.finish();
	expect(calls).toEqual(["finishSetup -", "finishSetup -"]);
});
