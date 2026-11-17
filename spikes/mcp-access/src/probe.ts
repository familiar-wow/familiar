// Does an ACP agent reach an MCP server that the client names in session/new? The probe starts
// the spike's server, starts the agent, hands it the server and asks a question that only the
// server's tool can answer: the tool returns a word made up for this run.
//
// Usage: bun src/probe.ts [options] -- <agent command...>
//   --caps            stop after initialize: report what the agent advertises, ask no model
//   --token none      hand the server over without the Authorization header
//   --token wrong     hand it over with a token the server does not know
//   --port <n>        the server's port (default: any free one)
//   --url <url>       the URL the agent gets, when it reaches the server another way, such as
//                     through `ssh -R`; the port in it is the port on the agent's machine
//   --cwd <folder>    the session's folder (default: ./cwd)
//   --timeout <s>     give up on the answer after this long (default: 180)
// SPIKE_TOKEN in the environment sets the server's token instead of a random one.

import {
	client,
	methods,
	ndJsonStream,
	PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import { serve, tools } from "./server.ts";

// Options first, then the agent's command. Bun drops a "--" that follows the script's name, so
// the command starts at the first word that is no option.
const VALUED = ["token", "port", "url", "cwd", "timeout"];
const words = Bun.argv.slice(2);
const flags: string[] = [];
while (words[0]?.startsWith("--")) {
	const word = words.shift() as string;
	if (word === "--") break;
	flags.push(word);
	if (VALUED.includes(word.slice(2))) flags.push(words.shift() ?? "");
}
const command = words;
if (!command.length) {
	console.error("usage: bun src/probe.ts [options] -- <agent command...>");
	process.exit(2);
}
const flag = (name: string) => {
	const at = flags.indexOf(`--${name}`);
	return at < 0 ? undefined : flags[at + 1];
};

// SPIKE_TOKEN sets the token, to look for it afterwards in what the agent wrote to disk.
const token = process.env.SPIKE_TOKEN ?? crypto.randomUUID();
const nonce = crypto.randomUUID().slice(0, 8);
const port = flag("port");
const server = serve({
	token,
	tools: tools(nonce),
	port: port ? Number(port) : undefined,
});
const handed = flag("token");
const headers =
	handed === "none"
		? []
		: [
				{
					name: "Authorization",
					value: `Bearer ${handed === "wrong" ? crypto.randomUUID() : token}`,
				},
			];
const url = flag("url") ?? server.url;
const sessionCwd = flag("cwd") ?? `${import.meta.dir}/../cwd`;

const t0 = performance.now();
const say = (text: string) =>
	console.log(
		`[${((performance.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${text}`,
	);
say(
	`server on ${server.url}; the agent gets ${url} with ${headers.length ? `a ${handed === "wrong" ? "wrong" : "valid"} token` : "no token"}`,
);
say(`agent: ${command.join(" ")}`);

const proc = Bun.spawn(command, {
	stdin: "pipe",
	stdout: "pipe",
	stderr: "pipe",
	cwd: `${import.meta.dir}/../cwd`,
});
const stderr: string[] = [];
void (async () => {
	const decoder = new TextDecoder();
	for await (const chunk of proc.stderr)
		for (const line of decoder.decode(chunk).split("\n"))
			if (line.trim()) stderr.push(line);
})();
let exited: number | undefined;
void proc.exited.then((code) => {
	exited = code;
});

const output = new WritableStream<Uint8Array>({
	async write(chunk) {
		proc.stdin.write(chunk);
		await proc.stdin.flush();
	},
	close() {
		proc.stdin.end();
	},
});

/** What the agent asked permission for, and what the probe answered. */
const asked: string[] = [];
const app = client({ name: "familiar-spike" })
	.onRequest(methods.client.session.requestPermission, ({ params }) => {
		const title = params.toolCall.title ?? "";
		// Only the spike's own tool may run. Everything else the agent wants is refused.
		const ours = /character_equipment/.test(
			`${title} ${JSON.stringify(params.toolCall.rawInput ?? "")}`,
		);
		const option = params.options.find(
			(o) => o.kind === (ours ? "allow_once" : "reject_once"),
		);
		asked.push(`${ours && option ? "allowed once" : "denied"}: ${title}`);
		say(
			`permission ${asked.at(-1)} (options: ${params.options.map((o) => o.kind).join(", ")})`,
		);
		return option
			? { outcome: { outcome: "selected", optionId: option.optionId } }
			: { outcome: { outcome: "cancelled" } };
	})
	.onRequest("*", ({ method }) => {
		say(`unexpected request ${method}`);
		throw new Error(`not supported: ${method}`);
	});

const finish = (code: number): never => {
	console.log("\nrequests the server saw:");
	if (!server.seen.length) console.log("  none");
	for (const s of server.seen)
		console.log(
			`  ${(s.at / 1000).toFixed(1).padStart(5)} s  ${s.status}  ${s.method}${s.tool ? ` ${s.tool}` : ""}  [${s.version || "no version header"}]  ${s.agent}`,
		);
	if (stderr.length) {
		console.log(
			`\nagent's stderr, last ${Math.min(stderr.length, 12)} of ${stderr.length} lines:`,
		);
		for (const line of stderr.slice(-12))
			console.log(`  ${line.slice(0, 220)}`);
	}
	server.stop();
	proc.kill();
	process.exit(code);
};
const within = <T>(
	seconds: number,
	what: string,
	promise: Promise<T>,
): Promise<T> =>
	Promise.race([
		promise,
		new Promise<never>((_, reject) =>
			setTimeout(
				() => reject(new Error(`${what}: no result within ${seconds} s`)),
				seconds * 1000,
			),
		),
	]);

try {
	const connection = app.connect(ndJsonStream(output, proc.stdout));
	const agent = connection.agent;
	const init = await within(
		60,
		"initialize",
		agent.request(methods.agent.initialize, {
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: {},
			clientInfo: { name: "familiar-spike", version: "0.0.0" },
		}),
	);
	say(
		`agent ${JSON.stringify(init.agentInfo)} speaks ACP ${init.protocolVersion}`,
	);
	say(
		`advertises mcpCapabilities: ${JSON.stringify(init.agentCapabilities?.mcpCapabilities ?? null)}`,
	);
	if (flags.includes("--caps")) {
		say(`all capabilities: ${JSON.stringify(init.agentCapabilities)}`);
		finish(0);
	}

	const session = await within(
		120,
		"session/new",
		agent
			.buildSession({
				cwd: sessionCwd,
				mcpServers: [{ type: "http", name: "wow", url, headers }],
			})
			.start(),
	);
	say(
		`session ${session.sessionId}; the server saw ${server.seen.length} request(s) so far`,
	);

	const done = session.prompt(
		"Which weapon does my character hold in the main hand? Look it up with the wow tools and answer with the item's exact name only. If you have no such tool, answer exactly: NO TOOL.",
	);
	let text = "";
	const limit = Number(flag("timeout") ?? 180);
	await within(
		limit,
		"the answer",
		(async () => {
			for (;;) {
				const message = await session.nextUpdate();
				if (message.kind === "stop") {
					say(`stop: ${message.stopReason}`);
					return;
				}
				const update = message.update;
				if (
					update.sessionUpdate === "agent_message_chunk" &&
					update.content.type === "text"
				)
					text += update.content.text;
				else if (update.sessionUpdate === "tool_call")
					say(
						`tool call: ${update.title} (${update.kind ?? "?"}, ${update.status ?? "?"})`,
					);
				else if (update.sessionUpdate === "tool_call_update" && update.status)
					say(`tool ${update.status}: ${update.title ?? update.toolCallId}`);
			}
		})(),
	);
	await done;
	say(`answer: ${text.trim().slice(0, 300)}`);
	const called = server.seen.some(
		(s) => s.method === "tools/call" && s.status === 200,
	);
	const told = text.includes(nonce);
	console.log(
		`\nRESULT: the tool was ${called ? "called" : "NOT called"}; the answer ${told ? "has" : "does NOT have"} this run's word (${nonce}).`,
	);
	finish(called && told ? 0 : 1);
} catch (e) {
	say(
		`failed: ${e instanceof Error ? e.message : JSON.stringify(e)}${exited === undefined ? "" : ` (agent exited with ${exited})`}`,
	);
	finish(1);
}
