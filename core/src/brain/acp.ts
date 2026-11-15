// A brain reached through the Agent Client Protocol (ADR 0001), such as Hermes. Familiar starts
// the agent as a child process on the first question and talks JSON-RPC with it over stdin and
// stdout. Each character gets its own session, so a conversation goes on where it stopped.
//
// Game text is data, never an instruction: Familiar offers the agent no file or terminal access
// and declines every permission request. Which tools the agent brings along is set in the
// agent itself; core/README.md shows how for Hermes.
import {
	type ActiveSession,
	type ClientConnection,
	client,
	methods,
	ndJsonStream,
	PROTOCOL_VERSION,
	type StopReason,
} from "@agentclientprotocol/sdk";
import type { Log } from "../log.ts";
import type { Settings } from "../settings.ts";
import { prompt, type Question } from "./chat.ts";

/** How long an agent may take to stop after a cancelled question before it is killed. */
const GRACE_MS = 5000;
/** Lines of the agent's stderr kept for error messages. */
const STDERR_LINES = 20;

interface Agent {
	child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	connection: ClientConnection;
	sessions: Map<string, ActiveSession>;
	stderr: string[];
}

export interface AcpBrainOptions {
	/** The agent's working folder. */
	cwd: string;
	log: Log;
	/** Familiar's version, for the agent. */
	version: string;
}

export class AcpBrain {
	private agent?: Agent;
	private queue: Promise<void> = Promise.resolve();

	constructor(
		private readonly settings: Settings["brain"],
		private readonly options: AcpBrainOptions,
	) {}

	/** Asks one question at a time. Resolves with the answer or a message for the player. */
	ask(question: Question): Promise<string> {
		return new Promise((reply) => {
			this.queue = this.queue.then(() => this.answer(question, reply));
		});
	}

	stop(): void {
		this.agent?.child.kill();
	}

	private async answer(
		question: Question,
		reply: (text: string) => void,
	): Promise<void> {
		const { name, timeout } = this.settings;
		let agent: Agent;
		try {
			agent = this.agent ?? (await this.start());
		} catch (error) {
			return reply(`${name} could not start: ${message(error)}`);
		}
		const started = performance.now();
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let killer: ReturnType<typeof setTimeout> | undefined;
		try {
			const session = await this.session(agent, question);
			timer = setTimeout(() => {
				timedOut = true;
				reply(`${name} did not answer within ${timeout} s.`);
				void agent.connection.agent
					.notify(methods.agent.session.cancel, {
						sessionId: session.sessionId,
					})
					.catch(() => {});
				killer = setTimeout(() => this.drop(agent), GRACE_MS);
			}, timeout * 1000);
			// A command the agent offers, such as /tools, goes to it as typed (ACP slash commands).
			const input = question.text.startsWith("/")
				? question.text
				: prompt(question);
			const turn = session.prompt(input);
			const text = await lastMessage(session);
			const { stopReason } = await turn;
			this.options.log.event("answer", {
				ms: Math.round(performance.now() - started),
				stopReason,
				chars: text.length,
			});
			reply(answerFor(name, stopReason, text));
		} catch (error) {
			// The agent quit or broke the protocol: the next question starts a new one.
			this.drop(agent);
			if (!timedOut) reply(`${name} stopped: ${await why(agent, error)}`);
		} finally {
			clearTimeout(timer);
			clearTimeout(killer);
		}
	}

	private drop(agent: Agent): void {
		if (this.agent === agent) this.agent = undefined;
		agent.child.kill();
	}

	private async start(): Promise<Agent> {
		const { name, command } = this.settings;
		const { cwd, log, version } = this.options;
		const started = performance.now();
		const child = Bun.spawn(command, {
			cwd,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr: string[] = [];
		void keepLines(child.stderr, stderr);
		const output = new WritableStream<Uint8Array>({
			async write(chunk) {
				child.stdin.write(chunk);
				await child.stdin.flush();
			},
			close() {
				child.stdin.end();
			},
		});
		const connection = client({ name: "familiar" })
			.onRequest(methods.client.session.requestPermission, ({ params }) => {
				const decline =
					params.options.find((o) => o.kind === "reject_once") ??
					params.options.find((o) => o.kind === "reject_always");
				log.event("brain-permission", {
					tool: params.toolCall.title,
					declined: decline?.optionId ?? "cancelled",
				});
				return {
					outcome: decline
						? { outcome: "selected", optionId: decline.optionId }
						: { outcome: "cancelled" },
				};
			})
			.connect(ndJsonStream(output, child.stdout));
		const agent: Agent = { child, connection, sessions: new Map(), stderr };
		void child.exited.then((code) => {
			connection.close();
			if (this.agent === agent) this.agent = undefined;
			log.event("brain-exit", { code, stderr: stderr.slice(-5) });
		});
		try {
			const init = await connection.agent.request(methods.agent.initialize, {
				protocolVersion: PROTOCOL_VERSION,
				// No file system and no terminal for the agent.
				clientCapabilities: {},
				clientInfo: { name: "familiar", title: "Familiar", version },
			});
			if (init.protocolVersion !== PROTOCOL_VERSION)
				throw new Error(
					`it speaks ACP version ${init.protocolVersion}, Familiar version ${PROTOCOL_VERSION}`,
				);
			const ms = Math.round(performance.now() - started);
			log.event("brain-start", { ms, agent: init.agentInfo });
			log.say(
				`${name} is ready: ${init.agentInfo?.name ?? command[0]} ${init.agentInfo?.version ?? ""}`.trim(),
			);
		} catch (error) {
			child.kill();
			throw new Error(await why(agent, error));
		}
		this.agent = agent;
		return agent;
	}

	/** One session per character; the realm keeps two characters of the same name apart. */
	private async session(
		agent: Agent,
		{ character }: Question,
	): Promise<ActiveSession> {
		const key = `${character.name ?? ""}-${character.realm ?? ""}`;
		let session = agent.sessions.get(key);
		if (!session) {
			session = await agent.connection.agent
				.buildSession(this.options.cwd)
				.start();
			agent.sessions.set(key, session);
			this.options.log.event("brain-session", { session: session.sessionId });
		}
		return session;
	}
}

/**
 * Reads a turn to its end. Text before a tool call is the agent thinking aloud, so the answer
 * is the last text.
 */
async function lastMessage(session: ActiveSession): Promise<string> {
	const texts = [""];
	for (;;) {
		const next = await session.nextUpdate();
		if (next.kind === "stop")
			return (
				texts
					.map((text) => text.trim())
					.filter(Boolean)
					.at(-1) ?? ""
			);
		const { update } = next;
		if (update.sessionUpdate === "tool_call") texts.push("");
		else if (
			update.sessionUpdate === "agent_message_chunk" &&
			update.content.type === "text"
		)
			texts[texts.length - 1] += update.content.text;
	}
}

function answerFor(name: string, stopReason: StopReason, text: string): string {
	if (stopReason === "refusal") return `${name} declined to answer.`;
	if (stopReason === "cancelled") return `${name} stopped answering.`;
	if (!text) return `${name} gave no answer.`;
	return stopReason === "end_turn" ? text : `${text} …`;
}

/** The agent's last words if it quit, otherwise the error. */
async function why(agent: Agent, error: unknown): Promise<string> {
	const quit = await Promise.race([
		agent.child.exited.then(() => true),
		Bun.sleep(500).then(() => false),
	]);
	const last = agent.stderr.findLast((line) => line.trim() !== "");
	return quit && last ? last.trim().replace(/^Error:\s*/, "") : message(error);
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Keeps the last lines of a stream. Reading it also keeps the agent from blocking on a full pipe. */
async function keepLines(
	stream: ReadableStream<Uint8Array>,
	lines: string[],
): Promise<void> {
	const decoder = new TextDecoder();
	let rest = "";
	for await (const chunk of stream) {
		const parts = (rest + decoder.decode(chunk, { stream: true })).split(
			/\r?\n/,
		);
		rest = parts.pop() ?? "";
		lines.push(...parts);
		lines.splice(0, Math.max(0, lines.length - STDERR_LINES));
	}
	if (rest) lines.push(rest);
}
