// Sign in with ChatGPT against a stand-in for OpenAI: the browser, the token server with signed
// ID tokens, renewal, sign-out, and a question on the plan through the Responses API.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Log } from "../log.ts";
import type { Tool } from "../mcp/server.ts";
import type { Settings } from "../settings.ts";
import { base64url, ChatGpt, type Endpoints } from "./chatgpt.ts";
import { ModelBrain } from "./model.ts";

const CLIENT = "oaiapp_test";
let keys: CryptoKeyPair;
let jwk: Record<string, unknown>;
let server: ReturnType<typeof Bun.serve>;
let endpoints: Endpoints;
const folders: string[] = [];

/** What the stand-in does next, and what it was asked. */
const fake = {
	scope:
		"chatgpt.tokens.use.direct email offline_access openid profile resource.invoke",
	sub: "user-1",
	nonce: "" as string | undefined,
	refreshError: "",
	tokenRequests: [] as Record<string, string>[],
	revoked: [] as Record<string, string>[],
	responses: [] as Record<string, unknown>[],
	replies: [] as string[][],
	serial: 0,
};

async function idToken(claims: Record<string, unknown>): Promise<string> {
	const enc = (o: unknown) =>
		base64url(new TextEncoder().encode(JSON.stringify(o)));
	const head = enc({ alg: "RS256", kid: "k1", typ: "JWT" });
	const body = enc(claims);
	const sig = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		keys.privateKey,
		new TextEncoder().encode(`${head}.${body}`),
	);
	return `${head}.${body}.${base64url(new Uint8Array(sig))}`;
}

const sse = (events: Record<string, unknown>[]) =>
	new Response(
		events
			.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
			.join(""),
		{
			headers: { "Content-Type": "text/event-stream" },
		},
	);

beforeAll(async () => {
	keys = (await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	jwk = {
		...((await crypto.subtle.exportKey("jwk", keys.publicKey)) as object),
		kid: "k1",
		alg: "RS256",
		use: "sig",
	};
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/jwks") return Response.json({ keys: [jwk] });
			if (url.pathname === "/revoke") {
				fake.revoked.push(
					Object.fromEntries(await request.formData()) as never,
				);
				return new Response(null, { status: 200 });
			}
			if (url.pathname === "/token") {
				const form = Object.fromEntries(await request.formData()) as Record<
					string,
					string
				>;
				fake.tokenRequests.push(form);
				if (form.grant_type === "refresh_token" && fake.refreshError)
					return Response.json(
						{
							error: fake.refreshError,
							error_description: `secret ${form.refresh_token}`,
						},
						{ status: 400 },
					);
				const n = ++fake.serial;
				return Response.json({
					access_token: `access-${n}`,
					refresh_token: `refresh-${n}`,
					id_token: await idToken({
						iss: endpoints.issuer,
						aud: CLIENT,
						sub: fake.sub,
						email: "hero@example.com",
						nonce: fake.nonce,
						exp: Math.floor(Date.now() / 1000) + 3600,
					}),
					token_type: "Bearer",
					expires_in: 3600,
					scope: fake.scope,
				});
			}
			if (url.pathname === "/v1/models")
				return Response.json({
					models: [
						{ slug: "gpt-plan", display_name: "GPT Plan", visibility: "list" },
						{ slug: "hidden", display_name: "Hidden", visibility: "hide" },
					],
				});
			if (url.pathname === "/v1/responses") {
				const body = (await request.json()) as Record<string, unknown>;
				fake.responses.push({
					...body,
					authorization: request.headers.get("authorization"),
				});
				const reply = fake.replies.shift() ?? ["text", "?"];
				const base = {
					id: "resp_1",
					created_at: 1,
					model: "gpt-plan",
					service_tier: null,
				};
				const usage = {
					input_tokens: 10,
					output_tokens: 5,
					input_tokens_details: { cached_tokens: 0 },
					output_tokens_details: { reasoning_tokens: 0 },
				};
				if (reply[0] === "fail")
					return sse([
						{ type: "response.created", response: base },
						{
							type: "response.failed",
							response: {
								...base,
								status: "failed",
								error: { code: reply[1], message: "limit" },
								usage,
							},
						},
					]);
				if (reply[0] === "call") {
					const item = {
						type: "function_call",
						id: "fc_1",
						call_id: "call_1",
						name: reply[1],
						namespace: "wow",
						arguments: reply[2] ?? "{}",
						status: "completed",
					};
					return sse([
						{ type: "response.created", response: base },
						{
							type: "response.output_item.added",
							output_index: 0,
							item: { ...item, arguments: "", status: "in_progress" },
						},
						{
							type: "response.function_call_arguments.delta",
							item_id: "fc_1",
							output_index: 0,
							delta: item.arguments,
						},
						{ type: "response.output_item.done", output_index: 0, item },
						{
							type: "response.completed",
							response: { ...base, status: "completed", usage },
						},
					]);
				}
				const message = {
					type: "message",
					id: "msg_1",
					role: "assistant",
					status: "completed",
					content: [{ type: "output_text", text: reply[1], annotations: [] }],
				};
				return sse([
					{ type: "response.created", response: base },
					{
						type: "response.output_item.added",
						output_index: 0,
						item: { ...message, status: "in_progress", content: [] },
					},
					{
						type: "response.content_part.added",
						item_id: "msg_1",
						output_index: 0,
						content_index: 0,
						part: { type: "output_text", text: "", annotations: [] },
					},
					{
						type: "response.output_text.delta",
						item_id: "msg_1",
						output_index: 0,
						content_index: 0,
						delta: reply[1],
						logprobs: [],
					},
					{ type: "response.output_item.done", output_index: 0, item: message },
					{
						type: "response.completed",
						response: { ...base, status: "completed", usage },
					},
				]);
			}
			return new Response("not found", { status: 404 });
		},
	});
	const at = `http://127.0.0.1:${server.port}`;
	endpoints = {
		issuer: at,
		authorize: `${at}/authorize`,
		token: `${at}/token`,
		revoke: `${at}/revoke`,
		jwks: `${at}/jwks`,
		api: `${at}/v1`,
	};
});

afterAll(() => {
	server.stop(true);
	for (const f of folders) rmSync(f, { recursive: true, force: true });
});

function chatgpt(now?: () => number) {
	const folder = mkdtempSync(join(tmpdir(), "familiar-chatgpt-"));
	folders.push(folder);
	return new ChatGpt({ folder, endpoints, firstPort: 0, now });
}

/** The player's browser: approves (or not) and comes back to Familiar's callback. */
function browser(answer: (params: URLSearchParams) => Record<string, string>) {
	const seen: URLSearchParams[] = [];
	const pages: Promise<string>[] = [];
	const open = (url: string) => {
		const params = new URL(url).searchParams;
		seen.push(params);
		fake.nonce = params.get("nonce") ?? undefined;
		const back = new URL(params.get("redirect_uri") ?? "");
		for (const [k, v] of Object.entries(answer(params)))
			back.searchParams.set(k, v);
		// The page the player sees after signing in.
		pages.push(fetch(back).then((r) => r.text()));
	};
	return { open, seen, pages };
}

const approve = (p: URLSearchParams) => ({
	code: "code-1",
	state: p.get("state") ?? "",
	...(p.get("client_id") === "dynamic_agent_client"
		? { client_id: CLIENT }
		: {}),
});

test("signs in through the browser, registers, and keeps the tokens owner-only", async () => {
	const c = chatgpt();
	const { open, seen, pages } = browser(approve);
	expect(await c.signIn(open)).toBe("hero@example.com");
	expect(await pages[0]).toContain("Signed in. You can close this tab");
	const first = seen[0];
	expect(first?.get("client_id")).toBe("dynamic_agent_client");
	expect(first?.get("agent_name_hint")).toBe("Familiar");
	expect(first?.get("ext_agent_host_id")).toStartWith("urn:uuid:");
	expect(first?.get("scope")).toContain("chatgpt.tokens.use.direct");
	expect(first?.get("code_challenge_method")).toBe("S256");
	expect(first?.get("redirect_uri")).toMatch(
		/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/,
	);
	const exchange = fake.tokenRequests.at(-1);
	expect(exchange).toMatchObject({
		grant_type: "authorization_code",
		client_id: CLIENT,
		code: "code-1",
	});
	expect(exchange?.code_verifier?.length).toBeGreaterThan(40);
	const saved = c.read();
	expect(saved).toMatchObject({
		client_id: CLIENT,
		subject: "user-1",
		email: "hero@example.com",
	});
	if (process.platform !== "win32")
		expect(statSync(c.file).mode & 0o777).toBe(0o600);
	expect(c.account()).toBe("hero@example.com");
	expect(await c.models()).toEqual([{ slug: "gpt-plan", name: "GPT Plan" }]);

	// Signing in again reuses the registration: its client ID and hints, no name hint.
	const again = browser(approve);
	await c.signIn(again.open);
	expect(again.seen[0]?.get("client_id")).toBe(CLIENT);
	expect(again.seen[0]?.has("agent_name_hint")).toBe(false);
	expect(again.seen[0]?.get("id_token_hint")).toBe(saved.id_token ?? "");
	expect(again.seen[0]?.get("ext_agent_host_id")).toBe(saved.ext_agent_host_id);
});

test("refuses a wrong state, a declined consent, a missing plan permission and a bad ID token", async () => {
	const wrongState = browser((p) => ({ ...approve(p), state: "other" }));
	await expect(chatgpt().signIn(wrongState.open)).rejects.toThrow(
		"different sign-in",
	);

	const declined = browser((p) => ({
		error: "access_denied",
		state: p.get("state") ?? "",
	}));
	await expect(chatgpt().signIn(declined.open)).rejects.toThrow("declined");
	expect(await declined.pages[0]).toContain("was not completed");

	fake.scope = "openid profile email offline_access";
	const noPlan = chatgpt();
	await expect(noPlan.signIn(browser(approve).open)).rejects.toThrow(
		"plan usage was not allowed",
	);
	await expect(noPlan.accessToken()).rejects.toThrow(
		"not allowed for Familiar",
	);
	fake.scope =
		"chatgpt.tokens.use.direct email offline_access openid profile resource.invoke";

	// A token for another nonce, as from a replayed sign-in.
	const replay = browser(approve);
	const c = chatgpt();
	const pending = c.signIn((url) => {
		replay.open(url);
		fake.nonce = "someone-else";
	});
	await expect(pending).rejects.toThrow("did not check out");
});

test("renews the access token once, shortly before it expires", async () => {
	let clock = Math.floor(Date.now() / 1000);
	const c = chatgpt(() => clock);
	await c.signIn(browser(approve).open);
	const first = await c.accessToken();
	expect(await c.accessToken()).toBe(first);
	clock += 3600 - 200;
	const before = fake.tokenRequests.length;
	const [a, b] = await Promise.all([c.accessToken(), c.accessToken()]);
	expect(a).toBe(b);
	expect(a).not.toBe(first);
	expect(fake.tokenRequests.length).toBe(before + 1);
	expect(fake.tokenRequests.at(-1)).toMatchObject({
		grant_type: "refresh_token",
		client_id: CLIENT,
	});
});

test("a revoked sign-in asks to sign in again and never shows the token", async () => {
	let clock = Math.floor(Date.now() / 1000);
	const c = chatgpt(() => clock);
	await c.signIn(browser(approve).open);
	clock += 4000;
	fake.refreshError = "invalid_grant";
	let message = "";
	try {
		await c.accessToken();
	} catch (error) {
		message = (error as Error).message;
	}
	fake.refreshError = "";
	expect(message).toContain("familiar login chatgpt");
	expect(message).not.toContain("refresh-");
	expect(c.read().refresh_token).toBeUndefined();
	expect(c.read().client_id).toBe(CLIENT);
});

test("signs out at OpenAI and keeps only the registration", async () => {
	const c = chatgpt();
	await c.signIn(browser(approve).open);
	const refresh = c.read().refresh_token;
	expect(await c.signOut()).toEqual({ revoked: true });
	expect(fake.revoked.at(-1)).toMatchObject({
		token: refresh,
		token_type_hint: "refresh_token",
		client_id: CLIENT,
	});
	expect(c.account()).toBeUndefined();
	expect(c.read()).toMatchObject({ client_id: CLIENT, subject: "user-1" });
});

const log: Log = { event: () => {}, say: () => {} };
const settings: Settings["brain"] = {
	use: "model",
	model: { provider: "chatgpt", name: "gpt-plan" },
	command: ["unused"],
	permissions: "deny",
	timeout: 10,
};
const equipment: Tool = {
	name: "equipment",
	description: "What the character wears.",
	inputSchema: {
		type: "object",
		properties: { slot: { type: "string" } },
		additionalProperties: false,
	},
	call: () => ({
		items: [{ slot: "mainHand", id: 13262, name: "Ashbringer" }],
	}),
};
const turn = () => ({
	onTool: () => {},
	onNote: () => {},
	onPermission: async () => false,
});
const hero = {
	text: "What do I wear?",
	character: { name: "Hero", realm: "Realm" },
};

test("asks on the plan as OpenAI requires: streamed, unstored, tools in a namespace", async () => {
	const c = chatgpt();
	await c.signIn(browser(approve).open);
	fake.responses = [];
	fake.replies = [
		["call", "equipment", '{"slot":"mainHand"}'],
		["text", "You wield [item:13262]."],
	];
	const brain = new ModelBrain(settings, {
		log,
		tools: [equipment],
		chatgpt: c,
	});
	expect(await brain.ask(hero, turn())).toBe("You wield [item:13262].");
	expect(fake.responses).toHaveLength(2);
	const first = fake.responses[0] as Record<string, unknown>;
	expect(first).toMatchObject({
		model: "gpt-plan",
		store: false,
		stream: true,
	});
	expect(String(first.authorization)).toStartWith("Bearer access-");
	expect(String(first.instructions)).toStartWith(
		"The player asks you from inside the game",
	);
	const input = first.input as { role?: string }[];
	expect(input.some((m) => m.role === "system")).toBe(false);
	for (const field of [
		"temperature",
		"top_p",
		"max_output_tokens",
		"previous_response_id",
		"user",
		"metadata",
	])
		expect(first).not.toHaveProperty(field);
	expect(first.tools).toEqual([
		expect.objectContaining({
			type: "namespace",
			name: "wow",
			tools: [expect.objectContaining({ type: "function", name: "equipment" })],
		}),
	]);
	// The second round carries the call and its result back, with the namespace.
	const second = JSON.stringify(fake.responses[1]);
	expect(second).toContain('"function_call_output"');
	expect(second).toContain("Ashbringer");
	expect(second).toContain('"namespace":"wow"');
});

test("a plan usage limit becomes a message with the link to manage usage", async () => {
	const c = chatgpt();
	await c.signIn(browser(approve).open);
	fake.replies = [["fail", "subscription_sharing_usage_limit_exceeded"]];
	const brain = new ModelBrain(settings, {
		log,
		tools: [equipment],
		chatgpt: c,
	});
	const reply = await brain.ask(hero, turn());
	expect(reply).toContain("usage limit");
	expect(reply).toContain("https://chatgpt.com/settings/usage");
});

test("without a sign-in the player hears how to sign in", async () => {
	const brain = new ModelBrain(settings, {
		log,
		tools: [],
		chatgpt: chatgpt(),
	});
	expect(await brain.ask(hero, turn())).toContain("familiar login chatgpt");
});
