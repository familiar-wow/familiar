// Recent questions from the core's log: a `question` line opens one, an `answered` line closes
// it. The question text is game data: the pages show it as text only, never as HTML.

export interface Asked {
	/** When it was asked, or answered when the question was cut from the log. */
	at: number;
	/** Undefined when the log was cut before the question. */
	text?: string;
	/** Undefined while the question is still open. */
	ms?: number;
	tools: string[];
}

/** The log lines that matter here; others are left out to keep the memory small. */
export function isQuestionLine(line: unknown): line is Record<string, unknown> {
	if (!line || typeof line !== "object") return false;
	const event = (line as Record<string, unknown>).event;
	return event === "question" || event === "answered";
}

/**
 * Pairs the lines, newest first. An answer closes the newest open question: a question whose
 * answer never went out (the game was gone) stays open instead of taking the next one's time.
 */
export function recentQuestions(lines: readonly unknown[], max = 8): Asked[] {
	const all: Asked[] = [];
	const open: Asked[] = [];
	for (const line of lines) {
		if (!isQuestionLine(line)) continue;
		const at = typeof line.at === "number" ? line.at : 0;
		if (line.event === "question") {
			const q: Asked = {
				at,
				text: typeof line.text === "string" ? line.text : "",
				tools: [],
			};
			all.push(q);
			open.push(q);
			continue;
		}
		const tools = Array.isArray(line.tools) ? line.tools.map(String) : [];
		const ms = typeof line.ms === "number" ? line.ms : 0;
		const q = open.pop();
		if (q) {
			q.ms = ms;
			q.tools = tools;
		} else all.push({ at, ms, tools });
	}
	return all.reverse().slice(0, max);
}

/** Repeated tools as one chip: ["lookup", "lookup", "quests"] → ["lookup ×2", "quests"]. */
export function toolChips(tools: readonly string[]): string[] {
	const counts = new Map<string, number>();
	for (const tool of tools) counts.set(tool, (counts.get(tool) ?? 0) + 1);
	return [...counts].map(([tool, n]) => (n > 1 ? `${tool} ×${n}` : tool));
}

/** HH:MM in local time. */
export function clock(ms: number): string {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
