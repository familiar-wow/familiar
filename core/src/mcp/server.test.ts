// The `wow` server over real HTTP, as an agent's MCP client talks to it.
import { afterAll, expect, test } from "bun:test";
import { Game } from "../game.ts";
import type { Log } from "../log.ts";
import { serveMcp } from "./server.ts";
import { wowTools } from "./tools.ts";

const events: { name: string; data?: Record<string, unknown> }[] = [];
const log: Log = {
	event: (name, data) => void events.push({ name, data }),
	say: () => {},
};
const game = new Game();
const server = serveMcp({
	port: 0,
	tools: [
		...wowTools(game),
		{
			name: "echo",
			description: "Returns its arguments.",
			inputSchema: { type: "object" },
			call: (args) => args,
		},
	],
	version: "1.2.3",
	log,
});
afterAll(() => server.stop());

const post = (
	body: unknown,
	headers: Record<string, string> = {
		Authorization: `Bearer ${server.token}`,
	},
	method = "POST",
) =>
	fetch(server.url, {
		method,
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...headers,
		},
		body:
			method === "POST"
				? typeof body === "string"
					? body
					: JSON.stringify(body)
				: undefined,
	});
const rpc = async (method: string, params?: object, id: number | null = 1) => {
	const response = await post({ jsonrpc: "2.0", id, method, params });
	expect(response.status).toBe(200);
	return (await response.json()) as {
		id: number;
		// biome-ignore lint/suspicious/noExplicitAny: the tests read whatever comes back
		result?: any;
		error?: { code: number; message: string };
	};
};

test("names itself and the newest revision it shares with the client", async () => {
	const { result } = await rpc("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "a client", version: "9" },
	});
	expect(result).toEqual({
		protocolVersion: "2025-06-18",
		capabilities: { tools: {} },
		serverInfo: {
			name: "wow",
			title: "Familiar: World of Warcraft",
			version: "1.2.3",
		},
	});
	const other = await rpc("initialize", { protocolVersion: "1999-01-01" });
	expect(other.result.protocolVersion).toBe("2025-11-25");
	expect((await rpc("ping")).result).toEqual({});
	expect(
		events.filter((e) => e.name === "mcp-client").map((e) => e.data?.client),
	).toEqual([{ name: "a client", version: "9" }, undefined]);
});

test("lists its tools with what a model needs to call them", async () => {
	const { result } = await rpc("tools/list");
	expect(result.tools.map((t: { name: string }) => t.name)).toEqual([
		"character",
		"equipment",
		"bags",
		"quests",
		"flightpaths",
		"lookup",
		"talents",
		"stats",
		"professions",
		"reputation",
		"spells",
		"bank",
		"merchant",
		"trainer",
		"echo",
	]);
	for (const tool of result.tools) {
		expect(Object.keys(tool).sort()).toEqual([
			"description",
			"inputSchema",
			"name",
		]);
		expect(tool.inputSchema.type).toBe("object");
	}
});

test("async game tools pull and filter their slice", async () => {
	game.setFetcher((id, slice) => {
		queueMicrotask(() => {
			if (slice === "eq")
				game.receiveState(
					id,
					slice,
					1,
					"head	10	40	3				Cowl\nmainHand	20	44	4				Blade",
				);
			else if (slice === "bags")
				game.receiveState(
					id,
					slice,
					1,
					"meta	8	16	2500\nitem	1	5	1	Healing Potion\nitem	2	1	1	Hearthstone",
				);
			else if (slice === "quests")
				game.receiveState(
					id,
					slice,
					1,
					"q	100	10	0	1	Zone	First\nq	200	20	1	0	Zone	Second",
				);
			else game.receiveState(id, slice, 1, "meta	0	1\ntree	Fire	1");
		});
		return true;
	});
	const eq = await rpc("tools/call", {
		name: "equipment",
		arguments: { slot: "mainHand" },
	});
	expect(eq.result.isError).toBe(false);
	expect(JSON.parse(eq.result.content[0].text).items).toEqual([
		{ slot: "mainHand", id: 20, name: "Blade", itemLevel: 44, quality: 4 },
	]);
	const bags = await rpc("tools/call", {
		name: "bags",
		arguments: { search: "potion" },
	});
	expect(JSON.parse(bags.result.content[0].text).items).toEqual([
		{ id: 1, count: 5, quality: 1, name: "Healing Potion" },
	]);
	const quests = await rpc("tools/call", {
		name: "quests",
		arguments: { questId: 200 },
	});
	expect(JSON.parse(quests.result.content[0].text).quests).toHaveLength(1);
	const talents = await rpc("tools/call", { name: "talents", arguments: {} });
	expect(JSON.parse(talents.result.content[0].text).trees).toEqual([
		{ name: "Fire", spent: 1 },
	]);
});

test("the character tool returns what the game showed last, or says that nothing came yet", async () => {
	const call = () => rpc("tools/call", { name: "character", arguments: {} });
	expect((await call()).result).toEqual({
		content: [
			{
				type: "text",
				text: "The game has sent nothing about the character yet.",
			},
		],
		isError: true,
	});
	game.see({ name: "Hero", realm: "Realm", class: "Magier", locale: "deDE" });
	const { result } = await call();
	expect(result.isError).toBe(false);
	const value = JSON.parse(result.content[0].text);
	expect(value).toEqual({
		name: "Hero",
		realm: "Realm",
		class: "Magier",
		locale: "deDE",
		asOf: game.character?.at.toISOString(),
	});
});

test("answers as JSON-RPC wants", async () => {
	expect(
		(await rpc("tools/call", { name: "echo", arguments: { a: 1 } })).result,
	).toEqual({ content: [{ type: "text", text: '{"a":1}' }], isError: false });
	// Arguments may be missing.
	expect(
		(await rpc("tools/call", { name: "echo" })).result.content[0].text,
	).toBe("{}");
	expect((await rpc("tools/call", { name: "fly" })).error).toEqual({
		code: -32602,
		message: "Unknown tool: fly",
	});
	expect((await rpc("resources/list")).error).toEqual({
		code: -32601,
		message: "Method not found: resources/list",
	});
	// A notification gets no answer.
	const notified = await post({
		jsonrpc: "2.0",
		method: "notifications/initialized",
	});
	expect(notified.status).toBe(202);
	expect(await notified.text()).toBe("");
	// A batch, as the revision of 2025-03-26 allows: answers for the requests only.
	const batch = await post([
		{ jsonrpc: "2.0", id: 7, method: "ping" },
		{ jsonrpc: "2.0", method: "notifications/initialized" },
		{ jsonrpc: "2.0", id: 8, method: "ping" },
	]);
	expect(await batch.json()).toEqual([
		{ jsonrpc: "2.0", id: 7, result: {} },
		{ jsonrpc: "2.0", id: 8, result: {} },
	]);
	const garbage = await post("{not json");
	expect(garbage.status).toBe(400);
	expect(await garbage.json()).toEqual({
		jsonrpc: "2.0",
		id: null,
		error: { code: -32700, message: "Parse error" },
	});
	expect(await (await post(7)).json()).toEqual({
		jsonrpc: "2.0",
		id: null,
		error: { code: -32600, message: "Invalid request" },
	});
});

test("serves only requests that carry the token and come from no browser", async () => {
	const auth = { Authorization: `Bearer ${server.token}` };
	const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
	const before = server.served();
	const status = async (headers: Record<string, string>, method = "POST") =>
		(await post(list, headers, method)).status;

	const none = await post(list, {});
	expect(none.status).toBe(401);
	expect(none.headers.get("www-authenticate")).toBe("Bearer");
	expect(await none.text()).toBe("");
	expect(await status({ Authorization: `Bearer ${"x".repeat(43)}` })).toBe(401);
	expect(await status({ Authorization: server.token })).toBe(401);
	// Every browser names the page that asks.
	expect(await status({ ...auth, Origin: "https://example.com" })).toBe(403);
	expect(await status({ ...auth, Origin: "http://127.0.0.1" })).toBe(403);
	// A name that was rebound to 127.0.0.1 still arrives as that name.
	expect(await status({ ...auth, Host: "evil.example" })).toBe(403);
	expect(await status({ ...auth, Host: `localhost:${server.port}` })).toBe(200);
	// Clients try to open a stream; there is none.
	const get = await post(undefined, auth, "GET");
	expect(get.status).toBe(405);
	expect(get.headers.get("allow")).toBe("POST");
	expect(await status({}, "GET")).toBe(401);
	expect(
		(
			await fetch(server.url.replace("/mcp", "/"), {
				method: "POST",
				headers: auth,
			})
		).status,
	).toBe(404);
	const big = await post(
		{ ...list, params: { pad: "x".repeat(70_000) } },
		auth,
	);
	expect(big.status).toBe(413);
	expect(await status(auth)).toBe(200);

	// Only the two good requests count, and each kind of refusal is logged once.
	expect(server.served() - before).toBe(2);
	expect(
		events.filter((e) => e.name === "mcp-refused").map((e) => e.data?.why),
	).toEqual(["no token", "a wrong token", "a browser", "another host name"]);
});

test("a new start has a new token, and a taken port is an error", () => {
	expect(server.token).toMatch(/^[\w-]{43}$/);
	expect(() =>
		serveMcp({ port: server.port, tools: [], version: "1", log }),
	).toThrow();
	const other = serveMcp({ port: 0, tools: [], version: "1", log });
	expect(other.token).not.toBe(server.token);
	expect(other.url).toBe(`http://127.0.0.1:${other.port}/mcp`);
	other.stop();
});
