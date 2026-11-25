// The main window's connection to the core: JSON lines over the sidecar's stdin and stdout
// (docs/sidecar.md). Only the main window talks to the core, so request ids never collide.
import { messageOf } from "./types.ts";

/** How long a request may take before it fails, unless the caller says otherwise. */
export const TIMEOUT_MS = 15_000;
export const STOPPED = "The core stopped.";
export const TIMED_OUT = "The core did not answer in time.";

export interface ClientOptions {
	/** Writes one line to the core; rejects when the core is not running. */
	send: (line: string) => Promise<void>;
	/** An event line from the core, such as `status` or `log`. */
	onEvent: (event: string, data: unknown) => void;
	timeoutMs?: number;
}

interface Pending {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class CoreClient {
	/** The generation of the core this client talks to; lines of any other one are ignored. */
	private gen = 0;
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();

	constructor(private readonly o: ClientOptions) {}

	get generation(): number {
		return this.gen;
	}

	/** Talks to a newer core from now on. Requests to the old one will never be answered. */
	useGen(gen: number): void {
		if (gen === this.gen) return;
		this.failAll(STOPPED);
		this.gen = gen;
	}

	/** The core of this generation ended: everything still waiting fails. */
	stopped(gen: number, message = STOPPED): void {
		if (gen === this.gen) this.failAll(message);
	}

	request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		timeoutMs = this.o.timeoutMs ?? TIMEOUT_MS,
	): Promise<T> {
		const id = this.nextId++;
		const line = JSON.stringify(
			params === undefined ? { id, method } : { id, method, params },
		);
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(TIMED_OUT));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: resolve as (value: unknown) => void,
				reject,
				timer,
			});
			this.o.send(line).catch((error: unknown) => {
				this.settle(id, undefined, messageOf(error));
			});
		});
	}

	/** One line the core wrote to stdout. */
	receive(gen: number, line: string): void {
		if (gen !== this.gen) return;
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (!message || typeof message !== "object") return;
		const m = message as Record<string, unknown>;
		if (typeof m.event === "string") {
			this.o.onEvent(m.event, m.data);
			return;
		}
		// Rust's own shutdown request uses the id "quit"; it is not ours.
		if (typeof m.id !== "number") return;
		const error = m.error as { message?: unknown } | undefined;
		if (error)
			this.settle(
				m.id,
				undefined,
				typeof error.message === "string" ? error.message : "Error.",
			);
		else this.settle(m.id, m.result);
	}

	private settle(id: number, result: unknown, error?: string): void {
		const p = this.pending.get(id);
		if (!p) return;
		this.pending.delete(id);
		clearTimeout(p.timer);
		if (error === undefined) p.resolve(result);
		else p.reject(new Error(error));
	}

	private failAll(message: string): void {
		for (const id of [...this.pending.keys()])
			this.settle(id, undefined, message);
	}
}
