// How the desktop app and Familiar's core talk (ADR 0002): one JSON object per line, the app's
// requests on stdin, replies and events on stdout. No network port is opened.
//
//   app  → core   {"id": 1, "method": "game.find", "params": {}}
//   core → app    {"id": 1, "result": {...}}            or {"id": 1, "error": {"message": "..."}}
//   core → app    {"event": "status", "data": {...}}     at any time, without an id
//
// Error messages are fixed words meant for the player; they never carry a key or a password.

export interface Request {
	id: number | string;
	method: string;
	params?: Record<string, unknown>;
}

export type Reply =
	| { id: number | string; result: unknown }
	| { id: number | string; error: { message: string } };

export interface Event {
	event: string;
	data?: unknown;
}

/** A request from one line, or undefined if the line is none. */
export function parseRequest(line: string): Request | undefined {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) return undefined;
	const { id, method, params } = value as Record<string, unknown>;
	if (typeof id !== "number" && typeof id !== "string") return undefined;
	if (typeof method !== "string" || !method) return undefined;
	if (
		params !== undefined &&
		(typeof params !== "object" || params === null || Array.isArray(params))
	)
		return undefined;
	return { id, method, params: params as Record<string, unknown> | undefined };
}

/** An error the player may read as it is. Anything else becomes a generic message. */
export class PlayerError extends Error {
	override name = "PlayerError";
}
