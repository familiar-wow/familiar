// A stand-in ACP agent for acp.test.ts. It logs to stderr as it works, as Hermes does, and
// refuses sessions in folders whose path contains "missing", and in folders whose path contains
// "no-tools" if the session comes with MCP servers. The question picks what it does:
//   wow         calls the tool "character" of the MCP server it got and answers with the result
//   permission  asks to run a command and says which option it got
//   always      the same, but offers no "allow once"
//   where       names the session's folder
//   fail        answers with a JSON-RPC error and runs on
//   slow        answers only once Familiar cancels
//   hang        ignores the cancel too
//   crash       quits with a message on stderr
//   anything    "<session>: <question>"
import {
	agent,
	methods,
	ndJsonStream,
	PROTOCOL_VERSION,
	RequestError,
} from "@agentclientprotocol/sdk";

const folders = new Map<string, string>();
/** The MCP server over HTTP that each session got: its URL and headers. */
const servers = new Map<string, { url: string; headers: [string, string][] }>();
const cancelled = new Map<string, () => void>();
const log = (line: string) =>
	process.stderr.write(`2026-11-15 22:47:25 [INFO] fake-agent: ${line}\n`);

const output = new WritableStream<Uint8Array>({
	write(chunk) {
		process.stdout.write(chunk);
	},
});

agent({ name: "fake-agent" })
	// --hang-init: never answers initialize, as an agent stuck at start.
	.onRequest(methods.agent.initialize, async () => {
		if (process.argv.includes("--hang-init"))
			await new Promise<never>(() => {});
		log("ready");
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentCapabilities: {},
			agentInfo: { name: "fake-agent", version: "1.0.0" },
		};
	})
	.onRequest(methods.agent.session.new, ({ params }) => {
		log(`new session in ${params.cwd}`);
		if (params.cwd.includes("missing"))
			throw RequestError.internalError({ details: "invalid_params" });
		if (params.cwd.includes("no-tools") && params.mcpServers.length > 0)
			throw RequestError.invalidParams({ details: "no MCP over HTTP" });
		const sessionId = `session ${folders.size + 1}`;
		folders.set(sessionId, params.cwd);
		for (const server of params.mcpServers)
			if ("type" in server && server.type === "http")
				servers.set(sessionId, {
					url: server.url,
					headers: server.headers.map((h) => [h.name, h.value]),
				});
		return { sessionId };
	})
	.onNotification(methods.agent.session.cancel, ({ params }) => {
		cancelled.get(params.sessionId)?.();
	})
	.onRequest(methods.agent.session.prompt, async ({ params, client }) => {
		const { sessionId } = params;
		const text = params.prompt
			.map((b) => (b.type === "text" ? b.text : ""))
			.join("");
		// --ask: every question is "permission", such as the app's test question.
		const question = process.argv.includes("--ask")
			? "permission"
			: text.slice(text.lastIndexOf("Question: ") + 10);
		log(`question: ${question}`);
		const say = (answer: string) =>
			client.notify(methods.client.session.update, {
				sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: answer },
				},
			});
		if (question === "crash") {
			process.stderr.write("fake-agent: crashed on purpose\n");
			log("shutting down");
			process.exit(3);
		}
		if (question === "fail")
			throw RequestError.internalError({ details: "model unavailable" });
		if (question === "wow") {
			const server = servers.get(sessionId);
			if (!server) {
				await say("no wow server");
				return { stopReason: "end_turn" };
			}
			const rpc = async (id: number, method: string, params: object) => {
				const response = await fetch(server.url, {
					method: "POST",
					headers: [
						["Content-Type", "application/json"],
						["Accept", "application/json, text/event-stream"],
						...server.headers,
					],
					body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				return (await response.json()) as {
					result: { content: { text: string }[] };
				};
			};
			await rpc(1, "initialize", {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "fake-agent", version: "1.0.0" },
			});
			const called = await rpc(2, "tools/call", {
				name: "character",
				arguments: {},
			});
			await say(called.result.content[0]?.text ?? "");
			return { stopReason: "end_turn" };
		}
		if (question === "where") {
			await say(folders.get(sessionId) ?? "");
			return { stopReason: "end_turn" };
		}
		if (question === "slow" || question === "hang") {
			await new Promise<void>((resolve) => {
				if (question === "slow") cancelled.set(sessionId, resolve);
			});
			return { stopReason: "cancelled" };
		}
		if (question === "permission" || question === "always") {
			const { outcome } = await client.request(
				methods.client.session.requestPermission,
				{
					sessionId,
					toolCall: { toolCallId: "1", title: "rm -rf ~" },
					options: [
						...(question === "always"
							? []
							: [
									{
										optionId: "allow-once",
										name: "Allow",
										kind: "allow_once" as const,
									},
								]),
						{
							optionId: "allow-always",
							name: "Always allow",
							kind: "allow_always",
						},
						{ optionId: "reject-once", name: "Deny", kind: "reject_once" },
						{
							optionId: "reject-always",
							name: "Never allow",
							kind: "reject_always",
						},
					],
				},
			);
			await say(
				`got ${outcome.outcome === "selected" ? outcome.optionId : outcome.outcome}`,
			);
			return { stopReason: "end_turn" };
		}
		// Thinking aloud before a tool call is not part of the answer.
		await say("Let me look.");
		await client.notify(methods.client.session.update, {
			sessionId,
			update: {
				sessionUpdate: "tool_call",
				toolCallId: "2",
				title: "web_search: hello",
			},
		});
		await client.notify(methods.client.session.update, {
			sessionId,
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: "2",
				status: "failed",
			},
		});
		await say(`${sessionId}: `);
		await say(question);
		return { stopReason: "end_turn" };
	})
	.connect(ndJsonStream(output, Bun.stdin.stream()));
