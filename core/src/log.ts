import { appendFileSync } from "node:fs";

/** Events for the log file and short lines for the person watching. */
export interface Log {
	event(name: string, data?: Record<string, unknown>): void;
	say(text: string): void;
}

/** Writes events as JSON lines to `file` and says lines on the console. */
export function fileLog(file: string): Log {
	return {
		event(name, data = {}) {
			appendFileSync(
				file,
				`${JSON.stringify({ at: Date.now(), event: name, ...data })}\n`,
			);
		},
		say(text) {
			const time = new Date().toLocaleTimeString();
			console.log(`${time}  ${text}`);
			this.event("say", { text });
		},
	};
}
