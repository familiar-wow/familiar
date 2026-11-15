// The bridge to a brain that speaks the Agent Client Protocol, such as Hermes, or Codex and
// Claude Code through their adapters (ADR 0001, ADR 0006). Familiar starts the agent as a child
// process on the first question and talks JSON-RPC with it over stdin and stdout. Each character
// gets its own session, so a conversation goes on where it stopped.
//
// The player sets the agent up in the agent itself. Familiar only bridges: it offers no file
// system or terminal of its own and answers each permission request once, as its settings say.
import {
	type ActiveSession,
	type ClientConnection,
	client,
	methods,
	ndJsonStream,
	PROTOCOL_VERSION,
	RequestError,
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
	/**
	 * The settings folder. The agent process starts here, and the session too unless the settings
	 * name a `cwd`, which is a folder where the agent runs and may not exist on this machine.
	 */
	folder: string;
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
		const { command, timeout } = this.settings;
		let agent: Agent;
		try {
			agent = this.agent ?? (await this.start());
		} catch (error) {
			return reply(`Could not start ${command.join(" ")}: ${message(error)}`);
		}
		const started = performance.now();
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let killer: ReturnType<typeof setTimeout> | undefined;
		const folder = this.settings.cwd ?? this.options.folder;
		let session: ActiveSession;
		try {
			session = await this.session(agent, question, folder);
		} catch (error) {
			// The agent runs on; it only refused this folder, which happens when it runs on another
			// host and the settings name no folder there.
			this.options.log.event("brain-error", {
				during: "session/new",
				folder,
				error: message(error),
			});
			return reply(
				`The agent could not open a session in ${folder}: ${message(error)}. If it runs on another host, set brain.cwd to a folder there.`,
			);
		}
		try {
			timer = setTimeout(() => {
				timedOut = true;
				reply(`No answer within ${timeout} s.`);
				void agent.connection.agent
					.notify(methods.agent.session.cancel, {
						sessionId: session.sessionId,
					})
					.catch(() => {});
				killer = setTimeout(() => this.drop(agent), GRACE_MS);
			}, timeout * 1000);
			// A command the agent offers, such as /tools in Hermes, goes to it as typed.
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
			reply(answerFor(stopReason, text));
		} catch (error) {
			// An error the agent answered with leaves it running with its sessions. If it quit or
			// broke the protocol, the next question starts a new one. The reason comes first, so the
			// agent's own last words are not mistaken for ours.
			const { quit, reason } = await why(agent, error);
			this.options.log.event("brain-error", {
				during: "prompt",
				quit,
				error: reason,
			});
			if (quit || !(error instanceof RequestError)) this.drop(agent);
			if (!timedOut) reply(`The agent stopped: ${reason}`);
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
		const { command, permissions } = this.settings;
		const { folder, log, version } = this.options;
		const started = performance.now();
		const child = Bun.spawn(command, {
			cwd: folder,
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
				const choice = choose(params.options, permissions);
				log.event("brain-permission", {
					tool: params.toolCall.title,
					answer: choice?.optionId ?? "cancelled",
				});
				return {
					outcome: choice
						? { outcome: "selected", optionId: choice.optionId }
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
				// The agent works with its own tools; Familiar lends it no file system or terminal.
				clientCapabilities: {},
				clientInfo: { name: "familiar", title: "Familiar", version },
			});
			if (init.protocolVersion !== PROTOCOL_VERSION)
				throw new Error(
					`it speaks ACP version ${init.protocolVersion}, Familiar version ${PROTOCOL_VERSION}`,
				);
			const info = init.agentInfo;
			const ms = Math.round(performance.now() - started);
			log.event("brain-start", { ms, agent: info });
			log.say(
				`Brain ready: ${info?.title ?? info?.name ?? command[0]} ${info?.version ?? ""}`.trim(),
			);
		} catch (error) {
			const { reason } = await why(agent, error);
			child.kill();
			throw new Error(reason);
		}
		this.agent = agent;
		return agent;
	}

	/** One session per character; the realm keeps two characters of the same name apart. */
	private async session(
		agent: Agent,
		{ character }: Question,
		folder: string,
	): Promise<ActiveSession> {
		const key = `${character.name ?? ""}-${character.realm ?? ""}`;
		let session = agent.sessions.get(key);
		if (!session) {
			session = await agent.connection.agent.buildSession(folder).start();
			agent.sessions.set(key, session);
			this.options.log.event("brain-session", { session: session.sessionId });
		}
		return session;
	}
}

/**
 * Answers a permission request once, as the settings say. Never "always": that would change the
 * agent's own settings, which are the player's (ADR 0006).
 */
function choose(
	options: { optionId: string; kind: string }[],
	permissions: Settings["brain"]["permissions"],
): { optionId: string } | undefined {
	const once = (kind: string) => options.find((o) => o.kind === kind);
	return (permissions === "allow" && once("allow_once")) || once("reject_once");
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

function answerFor(stopReason: StopReason, text: string): string {
	if (stopReason === "refusal") return "The agent declined to answer.";
	if (stopReason === "cancelled") return "The agent stopped answering.";
	if (!text) return "The agent gave no answer.";
	return stopReason === "end_turn" ? text : `${text} …`;
}

/**
 * Why a request failed: the agent's last words if it quit by itself within half a second,
 * otherwise the error. Log lines at the levels INFO and DEBUG are skipped, because agents such
 * as Hermes log to stderr while they work.
 */
async function why(
	agent: Agent,
	error: unknown,
): Promise<{ quit: boolean; reason: string }> {
	const quit = await Promise.race([
		agent.child.exited.then(() => true),
		Bun.sleep(500).then(() => false),
	]);
	const last = agent.stderr.findLast(
		(line) => line.trim() !== "" && !/\b(INFO|DEBUG)\b/.test(line),
	);
	const reason =
		quit && last ? last.trim().replace(/^Error:\s*/, "") : message(error);
	return { quit, reason };
}

/** The error's message, with the details a JSON-RPC error carries, such as "invalid_params". */
function message(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const { data } = error as { data?: { details?: unknown } };
	const details = typeof data?.details === "string" ? data.details : undefined;
	return details && !error.message.includes(details)
		? `${error.message} (${details})`
		: error.message;
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
