import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface LogEvent {
	t: number;
	ev: string;
	[key: string]: unknown;
}

/** Append-only JSON Lines log. Buffered, because the data folder may sit on a network share. */
export class EventLog {
	readonly events: LogEvent[] = [];
	private buffer: string[] = [];

	constructor(
		private readonly file?: string,
		private readonly quiet = false,
	) {}

	add(ev: string, data: Record<string, unknown> = {}): LogEvent {
		const event: LogEvent = { t: Date.now(), ev, ...data };
		this.events.push(event);
		if (this.file) this.buffer.push(JSON.stringify(event));
		return event;
	}

	say(text: string): void {
		if (!this.quiet) console.log(`${new Date().toLocaleTimeString()}  ${text}`);
	}

	flush(): void {
		if (!this.file || this.buffer.length === 0) return;
		appendFileSync(this.file, `${this.buffer.join("\n")}\n`);
		this.buffer = [];
	}
}

/** All events from earlier runs in a folder, oldest file first. */
export function readLogs(dir: string): LogEvent[] {
	let files: string[] = [];
	try {
		files = readdirSync(dir)
			.filter((name) => name.endsWith(".jsonl"))
			.sort();
	} catch {
		return [];
	}
	const events: LogEvent[] = [];
	for (const name of files)
		for (const line of readFileSync(join(dir, name), "utf8").split("\n"))
			if (line.trim()) events.push(JSON.parse(line) as LogEvent);
	return events;
}
