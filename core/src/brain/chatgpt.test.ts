// Sign in with ChatGPT against a stand-in for OpenAI: the browser, the token server with signed
// ID tokens, renewal, sign-out, and a question on the plan through the Responses API.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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
	/** The PKCE challenge the browser saw, checked against the verifier at the exchange. */
	challenge: "",
	/** Changes to the next ID token's claims, and whether to sign it with a stranger's key. */
	claims: {} as Record<string, unknown>,
	forge: false,
	/** Milliseconds the token server waits before it answers. */
	delayMs: 0,
	/** The scope a renewal grants, if it differs. */
	refreshScope: "",
};
let stranger: CryptoKeyPair;

async function idToken(claims: Record<string, unknown>): Promise<string> {
	const enc = (o: unknown) =>
		base64url(new TextEncoder().encode(JSON.stringify(o)));
	const head = enc({ alg: "RS256", kid: "k1", typ: "JWT" });
	const body = enc(claims);
	const sig = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		fake.forge ? stranger.privateKey : keys.privateKey,
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
	stranger = (await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
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
				if (fake.delayMs) await Bun.sleep(fake.delayMs);
				if (form.grant_type === "authorization_code") {
					const digest = new Uint8Array(
						await crypto.subtle.digest(
							"SHA-256",
							new TextEncoder().encode(form.code_verifier ?? ""),
						),
					);
					if (base64url(digest) !== fake.challenge)
						return Response.json({ error: "invalid_grant" }, { status: 400 });
				}
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
						...fake.claims,
					}),
					token_type: "Bearer",
					expires_in: 3600,
					scope:
						form.grant_type === "refresh_token" && fake.refreshScope
							? fake.refreshScope
							: fake.scope,
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
				if (reply[0] === "cut" || reply[0] === "incomplete") {
					const message = {
						type: "message",
						id: "msg_1",
						role: "assistant",
						status: "in_progress",
						content: [],
					};
					return sse([
						{ type: "response.created", response: base },
						{
							type: "response.output_item.added",
							output_index: 0,
							item: message,
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
							delta: "Half an ans",
							logprobs: [],
						},
						...(reply[0] === "incomplete"
							? [
									{
										type: "response.incomplete",
										response: {
											...base,
											status: "incomplete",
											incomplete_details: { reason: "max_output_tokens" },
											usage,
										},
									},
								]
							: []),
					]);
				}
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

function chatgpt(now?: () => number, folder?: string) {
	const where = folder ?? mkdtempSync(join(tmpdir(), "familiar-chatgpt-"));
	if (!folder) folders.push(where);
	return new ChatGpt({ folder: where, endpoints, firstPort: 0, now });
}

/** The player's browser: approves (or not) and comes back to Familiar's callback. */
function browser(answer: (params: URLSearchParams) => Record<string, string>) {
	const seen: URLSearchParams[] = [];
	const pages: Promise<string>[] = [];
	const open = (url: string) => {
		const params = new URL(url).searchParams;
		seen.push(params);
		fake.nonce = params.get("nonce") ?? undefined;
		fake.challenge = params.get("code_challenge") ?? "";
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
	else {
		// Only the player's own account, nothing inherited from the folder.
		const acl = spawnSync("icacls", [c.file], { encoding: "utf8" }).stdout;
		expect(acl).toContain(process.env.USERNAME ?? "?");
		expect(acl).not.toMatch(
			/Everyone|BUILTIN\\Users|Authenticated Users|\(I\)/,
		);
	}
	expect(c.account()).toBe("hero@example.com");
	expect(await c.models()).toEqual([{ slug: "gpt-plan", name: "GPT Plan" }]);

	// Signing in again reuses the registration: its client ID and hints, no name hint.
	const again = browser(approve);
	await c.signIn(again.open);
	expect(again.seen[0]?.get("client_id")).toBe(CLIENT);
	expect(again.seen[0]?.has("agent_name_hint")).toBe(false);
	expect(again.seen[0]?.has("id_token_hint")).toBe(false);
	expect(again.seen[0]?.get("login_hint")).toBe("hero@example.com");
	expect(again.seen[0]?.get("ext_agent_host_id")).toBe(saved.ext_agent_host_id);
});

test("a stray request to the callback is turned away, and the sign-in keeps waiting", async () => {
	const c = chatgpt();
	const strays: number[] = [];
	const done = c.signIn(
		(url) => {
			const params = new URL(url).searchParams;
			const back = params.get("redirect_uri") ?? "";
			void (async () => {
				// Another program on the PC, without the state, and once with a wrong one.
				strays.push((await fetch(`${back}?code=evil`)).status);
				strays.push((await fetch(`${back}?code=evil&state=guess`)).status);
				browser(approve).open(url);
			})();
		},
		{ timeoutMs: 5000 },
	);
	expect(await done).toBe("hero@example.com");
	expect(strays).toEqual([400, 400]);
});

test("refuses a declined consent and a missing plan permission", async () => {
	const declined = browser((p) => ({
		error: "access_denied",
		state: p.get("state") ?? "",
	}));
	await expect(chatgpt().signIn(declined.open)).rejects.toThrow("declined");
	expect(await declined.pages[0]).toContain("was not completed");

	fake.scope = "openid profile email offline_access";
	const noPlan = chatgpt();
	const page = browser(approve);
	await expect(noPlan.signIn(page.open)).rejects.toThrow(
		"plan usage was not allowed",
	);
	// The browser hears that it did not work, not "signed in".
	expect(await page.pages[0]).toContain("was not completed");
	await expect(noPlan.accessToken()).rejects.toThrow(
		"not allowed for Familiar",
	);
	fake.scope =
		"chatgpt.tokens.use.direct email offline_access openid profile resource.invoke";
});

for (const [what, change] of [
	["another nonce", { nonce: "someone-else" }],
	["another issuer", { iss: "https://evil.example" }],
	["another audience", { aud: "oaiapp_other" }],
	["an expired token", { exp: 1000 }],
	["a stranger's signature", { forge: true }],
] as const)
	test(`refuses an ID token with ${what}`, async () => {
		const { forge, ...claims } = { forge: false, ...change } as {
			forge: boolean;
		} & Record<string, unknown>;
		const c = chatgpt();
		const pending = c.signIn((url) => {
			browser(approve).open(url);
			// Set after the browser stored the real nonce.
			fake.claims = claims;
			fake.forge = forge;
		});
		try {
			await expect(pending).rejects.toThrow("did not check out");
		} finally {
			fake.claims = {};
			fake.forge = false;
		}
		expect(c.account()).toBeUndefined();
	});

test("the code exchange proves the PKCE verifier", async () => {
	const c = chatgpt();
	const pending = c.signIn((url) => {
		browser(approve).open(url);
		fake.challenge = "not-the-challenge";
	});
	await expect(pending).rejects.toThrow("invalid_grant");
});

test("the printed address never carries a token", async () => {
	const c = chatgpt();
	await c.signIn(browser(approve).open);
	const shown: string[] = [];
	await c.signIn((url) => {
		shown.push(url);
		browser(approve).open(url);
	});
	const params = new URL(shown[0] ?? "").searchParams;
	expect(params.has("id_token_hint")).toBe(false);
	expect(params.get("login_hint")).toBe("hero@example.com");
	expect(shown[0]).not.toContain(c.read().id_token ?? "none");
});

test("a different account needs --forget, which then lets it sign in", async () => {
	const c = chatgpt();
	await c.signIn(browser(approve).open);
	fake.sub = "user-2";
	try {
		await expect(c.signIn(browser(approve).open)).rejects.toThrow("--forget");
		await c.signOut({ forget: true });
		expect(c.read().client_id).toBeUndefined();
		expect(await c.signIn(browser(approve).open)).toBe("hero@example.com");
		expect(c.read().subject).toBe("user-2");
	} finally {
		fake.sub = "user-1";
	}
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

test("two Familiar processes renew one after the other, not both", async () => {
	let clock = Math.floor(Date.now() / 1000);
	const a = chatgpt(() => clock);
	await a.signIn(browser(approve).open);
	// A second process: its own object on the same file.
	const b = chatgpt(() => clock, a.file.replace(/[\\/]chatgpt\.json$/, ""));
	clock += 3600;
	fake.delayMs = 100;
	const before = fake.tokenRequests.length;
	try {
		const [x, y] = await Promise.all([a.accessToken(), b.accessToken()]);
		expect(x).toBe(y);
	} finally {
		fake.delayMs = 0;
	}
	expect(fake.tokenRequests.length).toBe(before + 1);
});

test("signing out while another process renews does not bring the tokens back", async () => {
	let clock = Math.floor(Date.now() / 1000);
	const a = chatgpt(() => clock);
	await a.signIn(browser(approve).open);
	const b = chatgpt(() => clock, a.file.replace(/[\\/]chatgpt\.json$/, ""));
	clock += 3600;
	fake.delayMs = 150;
	try {
		const renewing = a.accessToken();
		await Bun.sleep(30);
		await b.signOut();
		await renewing;
	} finally {
		fake.delayMs = 0;
	}
	// The sign-out came after the renewal and removed its tokens too.
	expect(a.account()).toBeUndefined();
	expect(a.read().refresh_token).toBeUndefined();
});

test("a renewal that drops the plan permission does not hand out the new token", async () => {
	let clock = Math.floor(Date.now() / 1000);
	const c = chatgpt(() => clock);
	await c.signIn(browser(approve).open);
	clock += 3600;
	fake.refreshScope = "openid email";
	try {
		await expect(c.accessToken()).rejects.toThrow("not allowed for Familiar");
	} finally {
		fake.refreshScope = "";
	}
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

for (const kind of ["cut", "incomplete"])
	test(`a ${kind === "cut" ? "broken-off" : "incomplete"} answer on the plan is not passed off as complete`, async () => {
		const c = chatgpt();
		await c.signIn(browser(approve).open);
		fake.replies = [[kind], ["text", "fresh"]];
		const brain = new ModelBrain(settings, { log, tools: [], chatgpt: c });
		expect(await brain.ask(hero, turn())).toBe(
			"ChatGPT's answer was cut off. Ask again.",
		);
		fake.responses = [];
		await brain.ask({ ...hero, text: "again" }, turn());
		expect(JSON.stringify(fake.responses[0])).not.toContain("Half an ans");
	});

test("a stalled sign-in server counts against the question's time", async () => {
	let clock = Math.floor(Date.now() / 1000);
	const c = chatgpt(() => clock);
	await c.signIn(browser(approve).open);
	clock += 3600;
	fake.delayMs = 1500;
	try {
		const brain = new ModelBrain(
			{ ...settings, timeout: 0.2 },
			{ log, tools: [], chatgpt: c },
		);
		const started = performance.now();
		expect(await brain.ask(hero, turn())).toBe("No answer within 0.2 s.");
		expect(performance.now() - started).toBeLessThan(1000);
	} finally {
		fake.delayMs = 0;
	}
});
