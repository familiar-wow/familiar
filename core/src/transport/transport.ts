// The app's end of the transport (ADR 0005): messages from the addon come in over the lane and
// are confirmed with the ack doorbell they name; messages to the addon go into the font bank.
// A hello is answered with a welcome. Formats: codec.ts.
import { join } from "node:path";
import type { Log } from "../log.ts";
import { clientProcesses, type WowPaths } from "../wow/client.ts";
import { Bank } from "./bank.ts";
import type { UpMessage } from "./codec.ts";
import { LaneReader } from "./lane.ts";

export interface TransportOptions {
	paths: WowPaths;
	log: Log;
	/** What the welcome tells the addon, such as the app's name and version. */
	welcome: string;
	/** Running game processes; replaced in tests. */
	processes?: () => Promise<number[]>;
	processPollMs?: number;
}

export type Handler = (body: Uint8Array, info: { hello: boolean }) => void;

export class Transport {
	private readonly bank: Bank;
	private readonly lane: LaneReader;
	private readonly seen = new Set<string>();
	private handler: Handler = () => {};
	/** The addon session we answer: random per game start and account. */
	private key?: number;
	private pids?: number[];
	private timer?: ReturnType<typeof setInterval>;

	constructor(private readonly options: TransportOptions) {
		this.bank = new Bank(join(options.paths.addons, "Familiar"));
		this.lane = new LaneReader(
			options.paths.accounts,
			(m) => this.receive(m),
			options.log,
		);
	}

	/** Whether an addon session has spoken since the game started. */
	get connected(): boolean {
		return this.key !== undefined;
	}

	onMessage(handler: Handler): void {
		this.handler = handler;
	}

	/** Sends a message to the addon. Throws without an addon session or when the bank is used up. */
	send(body: Uint8Array, welcome = false): void {
		if (this.key === undefined) throw new Error("no addon session yet");
		const sent = this.bank.send(this.key, body, welcome);
		this.options.log.event("send", { bytes: body.length, welcome, ...sent });
	}

	async start(): Promise<void> {
		await this.checkGame();
		this.lane.start();
		this.timer = setInterval(
			() => void this.checkGame(),
			this.options.processPollMs ?? 2000,
		);
	}

	stop(): void {
		clearInterval(this.timer);
		this.lane.stop();
	}

	private receive(m: UpMessage): void {
		const log = this.options.log;
		if (m.key !== this.key) {
			this.key = m.key;
			const silenced = this.bank.adopt(m.ack, m.bell, m.font);
			log.event("session", { key: m.key, silenced });
		} else this.bank.catchUp(m.bell, m.font);
		const id = `${m.key}:${m.id}`;
		const repeat = this.seen.has(id);
		this.seen.add(id);
		log.event(repeat ? "repeat" : "message", {
			key: m.key,
			id: m.id,
			ack: m.ack,
			hello: m.hello,
			bytes: m.body.length,
		});
		try {
			if (m.hello) {
				// Every hello, because a repeat means the addon has not heard the welcome.
				this.send(new TextEncoder().encode(this.options.welcome), true);
			} else {
				// Raised for a repeat too: the addon may have missed it.
				this.bank.ack(m.ack);
			}
			if (!repeat) this.handler(m.body, { hello: m.hello });
		} catch (error) {
			// This runs in a timer: an error must not stop the transport.
			log.say(
				`Could not answer the addon: ${error instanceof Error ? error.message : error}`,
			);
		}
	}

	/** Doorbells and fonts start over with every game process. */
	private async checkGame(): Promise<void> {
		const pids = await (this.options.processes ?? clientProcesses)();
		const before = this.pids;
		this.pids = pids;
		const log = this.options.log;
		if (!before) {
			// Next to a running game, the files may be in use: the addon's first message says
			// how far (adopt). Without a game, nothing can be in use.
			if (pids.length === 0) this.reset("WoW is not running");
			return;
		}
		const closed = before.length > 0 && pids.length === 0;
		const restarted =
			pids.length > 0 && !pids.some((pid) => before.includes(pid));
		if (closed || restarted) this.reset(closed ? "WoW closed" : "WoW started");
		if (pids.join() !== before.join()) log.event("game", { pids });
	}

	private reset(why: string): void {
		const changed = this.bank.reset();
		this.key = undefined;
		this.seen.clear();
		this.options.log.event("reset", { why, changed });
	}
}
