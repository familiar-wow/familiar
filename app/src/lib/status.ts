// What the overview and the tray say about the game and the brain, from the core's status and
// what the page saw happen to the core. Pure, so the overview and the tray cannot disagree.
import { type Key, seconds, type Translate } from "./i18n.ts";
import type { Connection, Language, Status } from "./types.ts";

/** What the page knows: the core's status and how the core and the bootstrap went. */
export interface Facts {
	status?: Status;
	/** The core of the current generation exited. */
	exited?: boolean;
	/** A bootstrap step failed with this message. */
	failure?: string;
}

export function connection(f: Facts): Connection {
	const s = f.status;
	if (f.exited || f.failure !== undefined || (s?.problems.length ?? 0) > 0)
		return "error";
	if (
		s?.running &&
		s.game.running &&
		typeof s.game.hello === "string" &&
		s.game.hello !== ""
	)
		return "connected";
	return "waiting";
}

/** The game card's detail line: the first that applies, in the same order as connection(). */
export type Detail =
	| { kind: "exited" }
	| { kind: "failed"; message: string }
	| {
			kind:
				| "problems"
				| "starting"
				| "noClient"
				| "noAddon"
				| "noGame"
				| "noHello"
				| "connected";
	  };

export function detail(f: Facts): Detail {
	const s = f.status;
	if (f.exited) return { kind: "exited" };
	if (f.failure !== undefined) return { kind: "failed", message: f.failure };
	if (s && s.problems.length > 0) return { kind: "problems" };
	if (!s?.running) return { kind: "starting" };
	if (!s.client) return { kind: "noClient" };
	if (!s.addon.installed) return { kind: "noAddon" };
	if (!s.game.running) return { kind: "noGame" };
	if (!s.game.hello) return { kind: "noHello" };
	return { kind: "connected" };
}

const DETAIL_KEYS: Record<Exclude<Detail["kind"], "failed">, Key> = {
	exited: "game.exited",
	problems: "game.problems",
	starting: "game.starting",
	noClient: "game.noClient",
	noAddon: "game.noAddon",
	noGame: "game.noGame",
	noHello: "game.noHello",
	connected: "game.connected",
};

/** The detail line as text; a failed step's message is shown as the core wrote it. */
export function detailText(d: Detail, t: Translate): string {
	return d.kind === "failed" ? d.message : t(DETAIL_KEYS[d.kind]);
}

/** "Moonbreeze" and "Level 35 Tauren Druid · Desolace", with only what is known. */
export function characterParts(
	c: Status["character"],
	t: Translate,
): { name?: string; line?: string } {
	const text = (v: unknown) =>
		typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
	const level = text(c?.level);
	const who = [
		level ? t("character.level", { level }) : undefined,
		text(c?.race),
		text(c?.class),
	]
		.filter(Boolean)
		.join(" ");
	const line = [who, text(c?.zone)].filter(Boolean).join(" · ");
	return { name: text(c?.name), line: line || undefined };
}

const PROVIDERS: Record<string, string> = {
	openai: "OpenAI",
	anthropic: "Anthropic",
	google: "Google",
	openrouter: "OpenRouter",
	deepseek: "DeepSeek",
	ollama: "Ollama",
	lmstudio: "LM Studio",
};

export interface BrainLine {
	/** "Own agent", "ChatGPT plan", "Anthropic" */
	name: string;
	/** The command or the model. */
	detail?: string;
	/** "last answer 24.1 s" */
	last?: string;
}

export function brainLine(
	status: Pick<Status, "brain" | "last"> | undefined,
	t: Translate,
	language: Language,
): BrainLine {
	const b = status?.brain ?? {};
	const str = (v: unknown) => (typeof v === "string" ? v : "");
	let line: BrainLine;
	if (b.kind === "agent")
		line = {
			name: t("brain.agent"),
			detail: Array.isArray(b.command) ? b.command.join(" ") : undefined,
		};
	else if (b.kind === "ssh")
		line = { name: t("brain.ssh", { host: str(b.host) }) };
	else if (b.kind === "model") {
		const provider = str(b.provider);
		line = {
			name:
				provider === "chatgpt"
					? t("brain.chatgpt")
					: (PROVIDERS[provider] ?? provider),
			detail: str(b.model) || undefined,
		};
	} else if (b.kind === "echo") line = { name: t("brain.echo") };
	else line = { name: t("brain.unknown") };
	if (status?.last)
		line.last = t("brain.last", { s: seconds(status.last.ms, language) });
	if (!line.detail) delete line.detail;
	return line;
}

/** "Own agent hermes acp · last answer 24.1 s" */
export function brainText(b: BrainLine): string {
	const head = b.detail ? `${b.name} ${b.detail}` : b.name;
	return b.last ? `${head} · ${b.last}` : head;
}

/** "4 s ago", "3 min ago" */
export function ago(ms: number, now: number, t: Translate): string {
	const s = Math.max(0, Math.round((now - ms) / 1000));
	if (s < 60) return t("ago.seconds", { n: s });
	if (s < 3600) return t("ago.minutes", { n: Math.floor(s / 60) });
	if (s < 86_400) return t("ago.hours", { n: Math.floor(s / 3600) });
	return t("ago.days", { n: Math.floor(s / 86_400) });
}

/** The greeting's part of the day, by local time. */
export function dayPart(date: Date): "morning" | "afternoon" | "evening" {
	const h = date.getHours();
	if (h >= 5 && h < 12) return "morning";
	if (h >= 12 && h < 18) return "afternoon";
	return "evening";
}
