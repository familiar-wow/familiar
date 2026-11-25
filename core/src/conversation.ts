// The app's side of the chat window (FAM-23): questions from the addon go to the brain, and its
// answer, the tool it calls now and its permission requests go back. Formats: brain/chat.ts.
import {
	type Brain,
	clip,
	type Down,
	formatDown,
	parseUp,
	type Question,
} from "./brain/chat.ts";
import type { Game } from "./game.ts";
import type { Log } from "./log.ts";
import { DOWN_PAYLOAD } from "./transport/codec.ts";

/** An answer may take four fonts of the bank. */
const MAX_ANSWER = 4 * DOWN_PAYLOAD;
/** A status line, such as the tool's title, fits one font. */
const MAX_STATUS = 200;
/** A note fits one font too, but explains something, so it may be longer. */
const MAX_NOTE = 400;
/** At most one status line per this many milliseconds: each costs a font and a doorbell. */
export const STATUS_MS = 4000;

export class Conversation {
	private readonly waiting = new Map<number, (allow: boolean) => void>();
	private nextId = 1;

	constructor(
		private readonly brain: Brain,
		private readonly send: (body: Uint8Array) => void,
		private readonly log: Log,
		/** Learns the character from each question's header, and caches pulled slices for `wow`. */
		private readonly game: Game,
	) {
		this.game.setFetcher((id, slice, arg) =>
			this.down({ kind: "fetch", id, slice, ...(arg ? { arg } : {}) }),
		);
	}

	/**
	 * Handles a message from the addon. A hello means the game loaded its interface, which
	 * restarts the addon's revision counters, so the game state learned before is stale.
	 */
	receive(body: Uint8Array, { hello = false }: { hello?: boolean } = {}): void {
		const text = new TextDecoder().decode(body);
		if (hello) {
			this.game.forget();
			this.log.event("hello", { text });
			this.log.say(`The addon says hello: ${text}`);
			return;
		}
		const m = parseUp(text);
		if (!m) this.log.say(`Unknown message from the addon: ${text}`);
		else if (m.kind === "question") void this.answer(m.question);
		else if (m.kind === "state")
			this.game.receiveState(m.id, m.slice, m.rev, m.payload);
		else {
			this.log.say(`  ${m.allow ? "allowed" : "denied"} in game`);
			this.waiting.get(m.id)?.(m.allow);
			this.waiting.delete(m.id);
		}
	}

	private async answer(question: Question): Promise<void> {
		this.log.say(`Question: ${question.text}`);
		// For the desktop app's overview: who asks what, and later how long it took and with what.
		// The question is in the log anyway, in the line above.
		this.log.event("question", {
			text: question.text,
			character: question.character,
		});
		this.game.see(question.character, question.revs);
		const asked = performance.now();
		const status = throttle(
			(title) => this.down({ kind: "status", text: clip(title, MAX_STATUS) }),
			STATUS_MS,
		);
		const tools: string[] = [];
		const reply = await this.brain.ask(question, {
			onTool: (title) => {
				tools.push(title.split(":")[0] ?? title);
				status.tool(title);
			},
			onNote: (note) => {
				this.log.say(`  ${note}`);
				this.down({ kind: "note", text: clip(note, MAX_NOTE) });
			},
			onPermission: (title) => this.permission(title),
		});
		status.stop();
		const text = clip(plain(reply), MAX_ANSWER);
		if (this.down({ kind: "answer", text })) {
			const ms = Math.round(performance.now() - asked);
			const bytes = new TextEncoder().encode(text).length;
			this.log.event("answered", { ms, bytes, tools });
			this.log.say(
				`Answered after ${(ms / 1000).toFixed(1)} s, ${bytes} bytes.`,
			);
		}
	}

	private permission(title: string): Promise<boolean> {
		const id = this.nextId++;
		this.log.say(`  ? ${title}: the player decides in game`);
		return new Promise((resolve) => {
			this.waiting.set(id, resolve);
			if (
				!this.down({ kind: "permission", id, text: clip(title, MAX_STATUS) })
			) {
				this.waiting.delete(id);
				resolve(false);
			}
		});
	}

	/** Sends a message to the addon; false if it could not. */
	private down(m: Down): boolean {
		try {
			this.send(new TextEncoder().encode(formatDown(m)));
			return true;
		} catch (error) {
			this.log.say(
				`Could not send the ${m.kind}: ${error instanceof Error ? error.message : error}`,
			);
			return false;
		}
	}
}

/**
 * The answer without the Markdown that models write even when told not to: the game window
 * shows plain text, so **bold**, __bold__, `code` and "# " headings would show as their marks.
 * Game links such as [item:19019] stay as they are.
 */
export function plain(text: string): string {
	// Code keeps its content: it is set aside, the marks around it go, then it comes back
	// without its backticks, so `__init__` stays a name.
	const code: string[] = [];
	// The placeholder is a private-use character; one already in the answer means nothing and
	// would mix with the placeholders, so it goes first.
	const marked = text
		.replaceAll("\uE000", "")
		.replace(/(`+)([^\n]*?[^`\n])\1(?!`)/g, (_, _ticks, inner: string) => {
			code.push(inner);
			return `\uE000${code.length - 1}\uE000`;
		});
	return marked
		.replace(/^#{1,6} +/gm, "")
		.replace(/\*\*(.+?)\*\*/g, "$1")
		.replace(/__(.+?)__/g, "$1")
		.replace(/\uE000(\d+)\uE000/g, (_, i: string) => code[Number(i)] ?? "");
}

/**
 * Passes on the latest title at most every `ms` milliseconds: the first one at once, a later one
 * when the time is up, and titles in between only as the latest.
 */
function throttle(send: (title: string) => void, ms: number) {
	let last = Number.NEGATIVE_INFINITY;
	let latest: string | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const flush = () => {
		timer = undefined;
		if (latest === undefined) return;
		last = performance.now();
		send(latest);
		latest = undefined;
	};
	return {
		tool(title: string) {
			latest = title;
			if (timer) return;
			const wait = last + ms - performance.now();
			if (wait <= 0) flush();
			else timer = setTimeout(flush, wait);
		},
		stop() {
			clearTimeout(timer);
			timer = undefined;
			latest = undefined;
		},
	};
}
