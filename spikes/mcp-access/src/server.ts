// A minimal MCP server over HTTP, written by hand: one POST endpoint that answers JSON-RPC with
// JSON. It serves tools only, keeps no session and never streams, which is the smallest shape
// the Streamable HTTP transport allows. The spike measures whether real agents accept it.

import { timingSafeEqual } from "node:crypto";

/** The MCP revisions this server answers as; a client that asks for another gets the first. */
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

export type Tool = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	call(args: Record<string, unknown>): unknown;
};

/** One line per HTTP request, for the report. */
export type Seen = {
	at: number;
	/** The JSON-RPC method, or the HTTP method when the request was not a POST. */
	method: string;
	tool?: string;
	status: number;
	agent: string;
	/** What the request's MCP-Protocol-Version header said. */
	version: string;
};

export type Server = {
	url: string;
	port: number;
	seen: Seen[];
	stop(): void;
};

type Rpc = {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: Record<string, unknown>;
};

const same = (a: string, b: string) => {
	const [x, y] = [Buffer.from(a), Buffer.from(b)];
	return x.length === y.length && timingSafeEqual(x, y);
};

/** Only names that mean this machine: a page on another site cannot make a browser send them. */
const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

export function serve(options: {
	token: string;
	tools: Tool[];
	port?: number;
}): Server {
	const seen: Seen[] = [];
	const started = performance.now();

	const answer = (message: Rpc): object | undefined => {
		const { id, method, params } = message;
		const result = (value: unknown) => ({ jsonrpc: "2.0", id, result: value });
		const error = (code: number, text: string) => ({
			jsonrpc: "2.0",
			id: id ?? null,
			error: { code, message: text },
		});
		// A message without an id is a notification and gets no answer.
		if (id === undefined || id === null) return undefined;
		if (method === "initialize") {
			const asked = String(params?.protocolVersion ?? "");
			return result({
				protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
				capabilities: { tools: {} },
				serverInfo: {
					name: "wow",
					title: "Familiar: World of Warcraft",
					version: "0.0.0-spike",
				},
			});
		}
		if (method === "ping") return result({});
		if (method === "tools/list")
			return result({
				tools: options.tools.map(({ name, description, inputSchema }) => ({
					name,
					description,
					inputSchema,
				})),
			});
		if (method === "tools/call") {
			const tool = options.tools.find((t) => t.name === params?.name);
			if (!tool) return error(-32602, `Unknown tool: ${String(params?.name)}`);
			try {
				const value = tool.call(
					(params?.arguments ?? {}) as Record<string, unknown>,
				);
				return result({
					content: [{ type: "text", text: JSON.stringify(value) }],
					isError: false,
				});
			} catch (e) {
				// The model reads this and can try again; a protocol error it would not see.
				return result({
					content: [
						{ type: "text", text: e instanceof Error ? e.message : String(e) },
					],
					isError: true,
				});
			}
		}
		return error(-32601, `Method not found: ${method}`);
	};

	const http = Bun.serve({
		hostname: "127.0.0.1",
		port: options.port ?? 0,
		async fetch(request) {
			const note = (method: string, status: number, tool?: string) => {
				seen.push({
					at: Math.round(performance.now() - started),
					method,
					tool,
					status,
					agent: request.headers.get("user-agent") ?? "",
					version: request.headers.get("mcp-protocol-version") ?? "",
				});
			};
			const refuse = (
				status: number,
				text: string,
				headers?: Record<string, string>,
			) => {
				note(request.method, status);
				return new Response(text, { status, headers });
			};
			if (new URL(request.url).pathname !== "/mcp")
				return refuse(404, "Not found");
			// A browser names the page that asks. No agent does, so every Origin is refused, and
			// with the Host check a rebound DNS name gets nowhere either.
			if (request.headers.has("origin")) return refuse(403, "Forbidden");
			if (!LOCAL.test(request.headers.get("host") ?? ""))
				return refuse(403, "Forbidden");
			const bearer = request.headers.get("authorization") ?? "";
			if (!same(bearer, `Bearer ${options.token}`))
				return refuse(401, "Unauthorized", { "WWW-Authenticate": "Bearer" });
			// No stream to open and no session to end.
			if (request.method !== "POST")
				return refuse(405, "Method not allowed", { Allow: "POST" });

			let body: unknown;
			try {
				body = await request.json();
			} catch {
				note("(not JSON)", 400);
				return Response.json(
					{
						jsonrpc: "2.0",
						id: null,
						error: { code: -32700, message: "Parse error" },
					},
					{ status: 400 },
				);
			}
			const messages = (Array.isArray(body) ? body : [body]) as Rpc[];
			const answers = messages.map(answer).filter((a) => a !== undefined);
			for (const m of messages)
				note(
					m.method ?? "(response)",
					answers.length ? 200 : 202,
					m.method === "tools/call" ? String(m.params?.name) : undefined,
				);
			if (!answers.length) return new Response(null, { status: 202 });
			return Response.json(Array.isArray(body) ? answers : answers[0]);
		},
	});

	return {
		url: `http://127.0.0.1:${http.port}/mcp`,
		port: http.port ?? 0,
		seen,
		stop: () => void http.stop(true),
	};
}

/** The spike's stand-in for the game: fixed data with a word no model can guess. */
export function tools(nonce: string): Tool[] {
	return [
		{
			name: "character_equipment",
			description:
				"What the player's character wears right now: one entry per equipment slot with the item's name, id and item level. Read it before you answer a question about the character's gear.",
			inputSchema: {
				type: "object",
				properties: {
					slot: {
						type: "string",
						description:
							'One slot, such as "mainHand"; leave out for all slots.',
					},
				},
				additionalProperties: false,
			},
			call: ({ slot }) => {
				const worn: Record<string, object> = {
					head: { name: "Cowl of the Quiet Hour", id: 900101, itemLevel: 41 },
					mainHand: { name: `Spikeblade ${nonce}`, id: 900102, itemLevel: 44 },
					offHand: {
						name: "Lantern of Small Hours",
						id: 900103,
						itemLevel: 39,
					},
				};
				if (slot === undefined) return { revision: 7, slots: worn };
				const one = worn[String(slot)];
				if (!one)
					throw new Error(
						`No such slot: ${String(slot)}. Slots: ${Object.keys(worn).join(", ")}.`,
					);
				return { revision: 7, slots: { [String(slot)]: one } };
			},
		},
	];
}
