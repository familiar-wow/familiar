// The MCP server `wow` (ADR 0007): the game's state as tools for the player's agent. It speaks
// the smallest shape of MCP over HTTP: one endpoint, POST /mcp, that answers JSON-RPC with JSON.
// Tools only, no session, no stream. Familiar hands its address and token to the agent with
// each session (brain/acp.ts).
//
// It listens on the loopback address, but every process on this machine can connect there, and
// with `ssh -R` every user on the agent's machine. So each request must carry the token, which
// is new at every start. Browsers are kept out twice: no request with an Origin header is
// served, and none whose Host is not this machine, which is what a rebound DNS name would send.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Log } from "../log.ts";

/** The MCP revisions the server answers as; a client that asks for another gets the first. */
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
/** Requests are a tool's name and a few arguments. */
const MAX_BODY = 64 * 1024;
const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

export interface Tool {
	name: string;
	/** Read by the agent's model: it is all the model learns about the tool. */
	description: string;
	inputSchema: Record<string, unknown>;
	/** The result, sent as JSON. An error's message goes to the model, which may try again. */
	call(args: Record<string, unknown>): unknown | Promise<unknown>;
}

export interface McpServer {
	url: string;
	port: number;
	token: string;
	/** How many requests with the right token it has answered. */
	served(): number;
	stop(): void;
}

export interface McpOptions {
	port: number;
	tools: Tool[];
	/** Familiar's version, for the client. */
	version: string;
	log: Log;
}

interface Rpc {
	id?: string | number | null;
	method?: string;
	params?: Record<string, unknown>;
}

/** Starts the server. Throws if the port is taken. */
export function serveMcp(options: McpOptions): McpServer {
	const { tools, version, log } = options;
	const token = randomBytes(32).toString("base64url");
	const bearer = Buffer.from(`Bearer ${token}`);
	let served = 0;
	// One log line per kind of refusal: whatever knocks may knock often.
	const refused = new Set<string>();

	const answer = async (
		message: unknown,
		agent: string,
	): Promise<object | undefined> => {
		if (typeof message !== "object" || message === null)
			return failure(null, -32600, "Invalid request");
		const { id, method, params } = message as Rpc;
		// A message without an id is a notification, and one without a method an answer to a
		// request the server never sends. Neither gets an answer.
		if (id === undefined || id === null || method === undefined)
			return undefined;
		const result = (value: unknown) => ({ jsonrpc: "2.0", id, result: value });
		if (method === "initialize") {
			const asked = String(params?.protocolVersion ?? "");
			log.event("mcp-client", {
				client: params?.clientInfo,
				agent,
				protocol: asked,
			});
			return result({
				protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
				capabilities: { tools: {} },
				serverInfo: {
					name: "wow",
					title: "Familiar: World of Warcraft",
					version,
				},
			});
		}
		if (method === "ping") return result({});
		if (method === "tools/list")
			return result({
				tools: tools.map(({ name, description, inputSchema }) => ({
					name,
					description,
					inputSchema,
				})),
			});
		if (method === "tools/call") {
			const tool = tools.find((t) => t.name === params?.name);
			if (!tool)
				return failure(id, -32602, `Unknown tool: ${String(params?.name)}`);
			const args = params?.arguments;
			try {
				const value = await tool.call(
					typeof args === "object" && args !== null
						? (args as Record<string, unknown>)
						: {},
				);
				log.event("mcp-call", { tool: tool.name });
				return result({
					content: [{ type: "text", text: JSON.stringify(value) }],
					isError: false,
				});
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				log.event("mcp-call", { tool: tool.name, error: text });
				// The model reads a tool's error; a protocol error it would not see.
				return result({ content: [{ type: "text", text }], isError: true });
			}
		}
		return failure(id, -32601, `Method not found: ${method}`);
	};

	const http = Bun.serve({
		hostname: "127.0.0.1",
		port: options.port,
		maxRequestBodySize: MAX_BODY,
		async fetch(request) {
			const refuse = (status: number, why: string) => {
				if (!refused.has(why)) {
					refused.add(why);
					log.event("mcp-refused", {
						status,
						why,
						agent: request.headers.get("user-agent"),
					});
				}
				return new Response(null, {
					status,
					headers: status === 401 ? { "WWW-Authenticate": "Bearer" } : {},
				});
			};
			if (new URL(request.url).pathname !== "/mcp")
				return new Response(null, { status: 404 });
			if (request.headers.has("origin")) return refuse(403, "a browser");
			if (!LOCAL.test(request.headers.get("host") ?? ""))
				return refuse(403, "another host name");
			const given = Buffer.from(request.headers.get("authorization") ?? "");
			if (given.length !== bearer.length || !timingSafeEqual(given, bearer))
				return refuse(401, given.length ? "a wrong token" : "no token");
			// Clients ask for a stream with GET, some probe with HEAD; there is none to open.
			if (request.method !== "POST")
				return new Response(null, { status: 405, headers: { Allow: "POST" } });

			let body: unknown;
			try {
				body = await request.json();
			} catch {
				return Response.json(failure(null, -32700, "Parse error"), {
					status: 400,
				});
			}
			served++;
			const agent = request.headers.get("user-agent") ?? "";
			const resolved = await Promise.all(
				(Array.isArray(body) ? body : [body]).map((message) =>
					answer(message, agent),
				),
			);
			const answers = resolved.filter((a) => a !== undefined);
			if (answers.length === 0) return new Response(null, { status: 202 });
			return Response.json(Array.isArray(body) ? answers : answers[0]);
		},
	});
	const port = http.port ?? options.port;
	return {
		url: `http://127.0.0.1:${port}/mcp`,
		port,
		token,
		served: () => served,
		stop: () => void http.stop(true),
	};
}

function failure(id: Rpc["id"], code: number, message: string): object {
	return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
