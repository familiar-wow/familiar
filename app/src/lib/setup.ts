// The setup assistant on first start: the game, the addon, then the kind of brain, which hands
// over to the Brain page. The game and the addon reuse the Game page's GameController; this file
// adds the step order, when a step may go on, the addon's result line and the brain cards.
// `SetupController` runs the buttons that leave the assistant, with MainApp passed in, so the
// tests need neither Svelte nor Tauri.
import {
	activeChoice,
	activeKind,
	type BrainKind,
	joinCommand,
	type Settings,
} from "./brain.ts";
import {
	type AddonTone,
	type GamePage,
	type GameState,
	type Outcome,
	presentGame,
} from "./game.ts";
import type { Key, Translate } from "./i18n.ts";
import type { View } from "./overview.ts";
import { messageOf, type Page } from "./types.ts";

export type SetupStep = "game" | "addon" | "brain";
export const STEPS: readonly SetupStep[] = ["game", "addon", "brain"];

/** The kinds in the Brain page's order (the sketch's tabs). */
export const BRAIN_KINDS: readonly BrainKind[] = [
	"chatgpt",
	"key",
	"local",
	"agent",
];

export function nextStep(step: SetupStep): SetupStep | undefined {
	return STEPS[STEPS.indexOf(step) + 1];
}

export function previousStep(step: SetupStep): SetupStep | undefined {
	const i = STEPS.indexOf(step);
	return i > 0 ? STEPS[i - 1] : undefined;
}

export interface ProgressItem {
	step: SetupStep;
	n: number;
	state: "done" | "current" | "todo";
}

/** The row "1 Game · 2 Addon · 3 Brain": what lies behind, here and ahead. */
export function progress(step: SetupStep): ProgressItem[] {
	const at = STEPS.indexOf(step);
	return STEPS.map((s, i) => ({
		step: s,
		n: i + 1,
		state: i < at ? "done" : i === at ? "current" : "todo",
	}));
}

/** One line under the addon's buttons; `hint` says how a running WoW picks the files up. */
export interface AddonResult {
	text: string;
	error: boolean;
	hint?: { text: string; waiting: boolean };
}

/** The line after "Install addon", with the hint about WoW that ends the addon step. */
export function addonResult(outcome: Outcome, t: Translate): AddonResult {
	if (outcome.kind === "failed") return { text: outcome.message, error: true };
	if (outcome.kind === "removed")
		return { text: t("addon.removed"), error: false };
	const changed = outcome.added + outcome.updated + outcome.removed;
	const text = outcome.fresh
		? t("setup.addon.installed")
		: changed > 0
			? t("setup.addon.updated", { n: changed })
			: t("setup.addon.current");
	const result: AddonResult = { text, error: false };
	if (outcome.wowRunning) {
		// New files need a fresh start of WoW; changed ones only a reload.
		if (outcome.added > 0)
			result.hint = { text: t("setup.addon.restartWow"), waiting: true };
		else if (outcome.updated > 0)
			result.hint = { text: t("setup.addon.reload"), waiting: true };
	} else if (outcome.fresh || changed > 0)
		result.hint = { text: t("setup.addon.startWow"), waiting: false };
	return result;
}

export interface AddonCard {
	/** The client the addon goes into. */
	client?: string;
	status: string;
	tone: AddonTone;
	wowRunning: string;
	/** The button: install what is missing, update an older addon; none when it is current. */
	action?: "install" | "update";
	/** Up to date before anything was done here: the step says so. */
	current: boolean;
	result?: AddonResult;
}

function addonCard(game: GameState, p: GamePage, t: Translate): AddonCard {
	const o = game.outcome;
	const card: AddonCard = {
		status: p.addon.status,
		tone: p.addon.tone,
		wowRunning: p.addon.wowRunning,
		current: p.addon.tone === "good" && o === undefined,
	};
	if (p.client) card.client = p.client;
	if (o) card.result = addonResult(o, t);
	if (p.client) {
		if (p.addon.tone === "off") card.action = "install";
		else if (p.addon.tone === "warn") card.action = "update";
		// A failed try can be tried again, whatever the files look like now.
		else if (o?.kind === "failed") card.action = "install";
	}
	return card;
}

/** Whether `step` may go on: a client chosen, then an addon in place. The brain step finishes. */
export function canGoOn(
	step: SetupStep,
	game: GameState,
	p: GamePage,
): boolean {
	if (game.busy) return false;
	if (step === "game") return p.rows.some((row) => row.inUse);
	if (step === "addon")
		return (
			p.client !== undefined &&
			(p.addon.tone === "good" || game.outcome?.kind === "repaired")
		);
	return false;
}

/** Short and true today: the built-in agent has the game tools but no web search yet. */
const PROS_CONS: Record<BrainKind, { pros: Key[]; cons: Key[] }> = {
	chatgpt: {
		pros: ["setup.chatgpt.pro.cost"],
		cons: [
			"setup.chatgpt.con.limits",
			"setup.chatgpt.con.signIn",
			"setup.con.noWebSearch",
		],
	},
	key: {
		pros: ["setup.key.pro.models", "setup.key.pro.quick"],
		cons: ["setup.key.con.cost", "setup.con.noWebSearch"],
	},
	local: {
		pros: ["setup.local.pro.free"],
		cons: [
			"setup.local.con.pc",
			"setup.local.con.small",
			"setup.con.noWebSearch",
		],
	},
	agent: {
		pros: ["setup.agent.pro.tools", "setup.agent.pro.web"],
		cons: ["setup.agent.con.setup"],
	},
};

const KIND_NAMES: Record<BrainKind, Key> = {
	chatgpt: "setup.kind.chatgpt",
	key: "setup.kind.key",
	local: "setup.kind.local",
	agent: "setup.kind.agent",
};

export interface BrainCard {
	kind: BrainKind;
	name: string;
	pros: string[];
	cons: string[];
	/** The kind of the brain that answers now. */
	inUse: boolean;
}

export function brainCards(settings: Settings, t: Translate): BrainCard[] {
	const active = activeKind(settings);
	return BRAIN_KINDS.map((kind) => ({
		kind,
		name: t(KIND_NAMES[kind]),
		pros: PROS_CONS[kind].pros.map((key) => t(key)),
		cons: PROS_CONS[kind].cons.map((key) => t(key)),
		inUse: kind === active,
	}));
}

/** What "Later" leaves in place: the brain in the settings, for a new player `hermes acp`. */
export function laterLine(settings: Settings, t: Translate): string {
	const choice = activeChoice(settings);
	if (!choice) return t("setup.later.same");
	if (choice.kind === "agent")
		return choice.where === "ssh"
			? t("setup.later.ssh", { host: choice.ssh.host })
			: t("setup.later.agent", { command: joinCommand(choice.command) });
	return t("setup.later.model", {
		kind: t(KIND_NAMES[choice.kind]),
		name: choice.name,
	});
}

export interface SetupState {
	step: SetupStep;
	/** Leaving the assistant: the settings are being saved. */
	finishing: boolean;
	/** Why finishing failed, as the core said. */
	error?: string;
}

export interface SetupPage {
	step: SetupStep;
	progress: ProgressItem[];
	canBack: boolean;
	canNext: boolean;
	/** Any call under way: the step's own or leaving the assistant. */
	busy: boolean;
	error?: string;
	game: GamePage;
	addon: AddonCard;
	brain: { cards: BrainCard[]; later: string };
}

export function presentSetup(
	setup: SetupState,
	game: GameState,
	view: View,
	t: Translate,
): SetupPage {
	const p = presentGame(game, view, t);
	const settings = view.settings ?? {};
	const page: SetupPage = {
		step: setup.step,
		progress: progress(setup.step),
		canBack: previousStep(setup.step) !== undefined && !setup.finishing,
		canNext:
			nextStep(setup.step) !== undefined &&
			!setup.finishing &&
			canGoOn(setup.step, game, p),
		busy: setup.finishing || game.busy !== undefined,
		game: p,
		addon: addonCard(game, p, t),
		brain: { cards: brainCards(settings, t), later: laterLine(settings, t) },
	};
	if (setup.error) page.error = setup.error;
	return page;
}

export interface SetupDeps {
	/**
	 * Marks the setup done, opens `then` or the Brain page's `tab`, and starts Familiar in the
	 * background (MainApp.finishSetup). Rejects before leaving if the save fails.
	 */
	finishSetup(then?: Page, tab?: BrainKind): Promise<void>;
}

export class SetupController {
	state: SetupState = { step: "game", finishing: false };
	private readonly watchers = new Set<(state: SetupState) => void>();

	constructor(private readonly deps: SetupDeps) {}

	watch(fn: (state: SetupState) => void): () => void {
		this.watchers.add(fn);
		return () => this.watchers.delete(fn);
	}

	/** "Next", when the page says the step may go on. */
	next(canGoOn: boolean): void {
		const step = nextStep(this.state.step);
		if (!canGoOn || !step || this.state.finishing) return;
		this.set({ step, error: undefined });
	}

	back(): void {
		const step = previousStep(this.state.step);
		if (!step || this.state.finishing) return;
		this.set({ step, error: undefined });
	}

	/** "Skip setup" and "Later": the brain stays as it is, the overview opens. */
	finish(): Promise<void> {
		return this.leave(() => this.deps.finishSetup());
	}

	/** A brain card: setup done, and the Brain page opens on that kind's tab. */
	choose(kind: BrainKind): Promise<void> {
		return this.leave(() => this.deps.finishSetup("brain", kind));
	}

	private async leave(go: () => Promise<void>): Promise<void> {
		if (this.state.finishing) return;
		this.set({ finishing: true, error: undefined });
		try {
			await go();
		} catch (error) {
			this.set({ error: messageOf(error) });
		} finally {
			this.set({ finishing: false });
		}
	}

	private set(change: Partial<SetupState>): void {
		const next = { ...this.state, ...change };
		for (const key of Object.keys(change) as (keyof SetupState)[])
			if (change[key] === undefined) delete next[key];
		this.state = next;
		for (const fn of this.watchers) fn(this.state);
	}
}
