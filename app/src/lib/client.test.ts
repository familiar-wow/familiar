import { expect, test } from "bun:test";
import { CoreClient, STOPPED, TIMED_OUT } from "./client.ts";

function setup(timeoutMs = 1000) {
	const sent: { id: number; method: string; params?: unknown }[] = [];
	const events: [string, unknown][] = [];
	let fail: string | undefined;
	const client = new CoreClient({
		send: async (line) => {
			if (fail) throw fail;
			sent.push(JSON.parse(line));
		},
		onEvent: (event, data) => events.push([event, data]),
		timeoutMs,
	});
	client.useGen(1);
	return {
		client,
		sent,
		events,
		failSends: (message: string) => {
			fail = message;
		},
	};
}

const reply = (id: number, result: unknown) => JSON.stringify({ id, result });

test("numbers requests from 1 and matches replies by id, in any order", async () => {
	const { client, sent } = setup();
	const hello = client.request("hello");
	const status = client.request("status", { fresh: true });
	await Promise.resolve();
	expect(sent).toEqual([
		{ id: 1, method: "hello" },
		{ id: 2, method: "status", params: { fresh: true } },
	]);
	client.receive(1, reply(2, { running: true }));
	client.receive(1, reply(1, { version: "0.14.0" }));
	expect(await hello).toEqual({ version: "0.14.0" });
	expect(await status).toEqual({ running: true });
});

test("an error reply rejects with the core's message as it is", async () => {
	const { client } = setup();
	const p = client.request("start");
	client.receive(
		1,
		JSON.stringify({ id: 1, error: { message: "WoW Forever was not found." } }),
	);
	await expect(p).rejects.toThrow("WoW Forever was not found.");
});

test("a request without a reply times out", async () => {
	const { client } = setup(20);
	await expect(client.request("status")).rejects.toThrow(TIMED_OUT);
	// A late reply changes nothing.
	client.receive(1, reply(1, {}));
});

test("a request may set its own timeout", async () => {
	const { client } = setup(10);
	const p = client.request("start", undefined, 200);
	await Bun.sleep(30);
	client.receive(1, reply(1, "ok"));
	expect(await p).toBe("ok");
});

test("the core stopping fails every pending request", async () => {
	const { client } = setup();
	const a = client.request("hello");
	const b = client.request("start");
	client.stopped(1);
	await expect(a).rejects.toThrow(STOPPED);
	await expect(b).rejects.toThrow(STOPPED);
});

test("a stop of another generation leaves the requests alone", async () => {
	const { client } = setup();
	const p = client.request("hello");
	client.stopped(2);
	client.receive(1, reply(1, "still here"));
	expect(await p).toBe("still here");
});

test("lines of another generation are ignored", async () => {
	const { client, events } = setup();
	const p = client.request("hello");
	client.receive(0, reply(1, "old core"));
	client.receive(2, reply(1, "newer core"));
	client.receive(2, JSON.stringify({ event: "status", data: {} }));
	expect(events).toEqual([]);
	client.receive(1, reply(1, "this core"));
	expect(await p).toBe("this core");
});

test("a newer generation fails the requests to the old one", async () => {
	const { client } = setup();
	const p = client.request("start");
	client.useGen(2);
	await expect(p).rejects.toThrow(STOPPED);
	expect(client.generation).toBe(2);
});

test("events go to onEvent; junk, foreign ids and unknown ids are dropped", () => {
	const { client, events } = setup();
	client.receive(1, "not json");
	client.receive(1, "42");
	client.receive(1, JSON.stringify({ id: "quit", result: null }));
	client.receive(1, reply(99, "nobody asked"));
	client.receive(1, JSON.stringify({ event: "log", data: { event: "hello" } }));
	expect(events).toEqual([["log", { event: "hello" }]]);
});

test("a send the shell refuses rejects with its message", async () => {
	const { client, failSends } = setup();
	failSends("The core is not running.");
	await expect(client.request("hello")).rejects.toThrow(
		"The core is not running.",
	);
});
