// Sign in with ChatGPT for the built-in agent (ADR 0001, ADR 0008): the player's ChatGPT plan
// pays for the answers instead of an API key. OpenAI allows this for open-source apps that run
// locally ("ChatGPT plan usage", developers.openai.com/siwc). Written from OpenAI's protocol
// documentation; OpenAI's own DevKit is under a noncommercial license and is not used.
//
// The flow: OAuth with PKCE in the player's browser and a callback on 127.0.0.1, a client that
// registers itself on the first sign-in, tokens kept in a file next to the settings, an access
// token renewed before each use. Familiar never logs or prints a token.
import { spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";

export const APP_NAME = "Familiar";
export const USAGE_URL = "https://chatgpt.com/settings/usage";
const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const SCOPES =
	"openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
/** The first sign-in calls back on this port; later sign-ins may use any (OpenAI's docs). */
const FIRST_PORT = 1455;
/** Renew this long before the access token expires. */
const MARGIN_S = 300;
/** No request to OpenAI's sign-in server waits longer. */
const REQUEST_MS = 20_000;

/** Where OpenAI lives; tests pass a stand-in. */
export interface Endpoints {
	issuer: string;
	authorize: string;
	token: string;
	revoke: string;
	jwks: string;
	api: string;
}

export const OPENAI: Endpoints = {
	issuer: ISSUER,
	authorize: `${ISSUER}/api/accounts/authorize`,
	token: `${ISSUER}/api/accounts/oauth/token`,
	revoke: `${ISSUER}/api/accounts/oauth/revoke`,
	jwks: `${ISSUER}/.well-known/jwks.json`,
	api: RESOURCE,
};

/** The saved sign-in. The registration (client ID, account) stays after signing out. */
export interface Credentials {
	ext_agent_host_id: string;
	client_id?: string;
	subject?: string;
	email?: string;
	id_token?: string;
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	scopes?: string[];
	/** Unix seconds when the token response arrived. */
	saved_at?: number;
}

/** A problem the player can act on; its message is shown as it is and holds no secret. */
export class ChatGptError extends Error {
	override name = "ChatGptError";
}

export interface ChatGptOptions {
	/** The settings folder; the sign-in is kept in `chatgpt.json` there. */
	folder: string;
	endpoints?: Endpoints;
	fetch?: typeof fetch;
	/** Unix seconds; tests move the clock. */
	now?: () => number;
	/** The callback port of the first sign-in; tests pass 0 for any free one. */
	firstPort?: number;
}

export class ChatGpt {
	readonly file: string;
	private readonly endpoints: Endpoints;
	private readonly fetch: typeof fetch;
	private readonly now: () => number;
	private readonly firstPort: number;
	private refreshing?: Promise<string>;

	constructor(options: ChatGptOptions) {
		this.file = join(options.folder, "chatgpt.json");
		this.endpoints = options.endpoints ?? OPENAI;
		this.fetch = options.fetch ?? fetch;
		this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
		this.firstPort = options.firstPort ?? FIRST_PORT;
	}

	/** The Responses API address the access token is for. */
	get api(): string {
		return this.endpoints.api;
	}

	/** The saved sign-in, with this installation's host ID created on first use. */
	read(): Credentials {
		const saved = this.load();
		if (saved) return saved;
		const fresh: Credentials = {
			ext_agent_host_id: `urn:uuid:${crypto.randomUUID()}`,
		};
		this.write(fresh);
		return fresh;
	}

	private load(): Credentials | undefined {
		if (!existsSync(this.file)) return undefined;
		try {
			const saved = JSON.parse(readFileSync(this.file, "utf8"));
			if (typeof saved?.ext_agent_host_id === "string") return saved;
		} catch {
			// A broken file counts as no sign-in.
		}
		return undefined;
	}

	/** Who is signed in, for messages; undefined if nobody is. */
	account(): string | undefined {
		const c = this.load();
		return c?.refresh_token ? (c.email ?? "a ChatGPT account") : undefined;
	}

	/**
	 * Writes a new file next to the old one and renames it, so a crash never leaves half a file.
	 * Only the player's own user may read it: mode 0600, and on Windows an ACL without
	 * inherited entries.
	 */
	private write(c: Credentials): void {
		const tmp = `${this.file}.${process.pid}.${random(6)}.tmp`;
		const fd = openSync(tmp, "wx", 0o600);
		try {
			writeSync(fd, `${JSON.stringify(c, null, "\t")}\n`);
		} finally {
			closeSync(fd);
		}
		try {
			restrict(tmp);
			renameSync(tmp, this.file);
		} catch (error) {
			rmSync(tmp, { force: true });
			throw error;
		}
	}

	/**
	 * One change to the saved sign-in at a time, across all Familiar processes: renewals rotate
	 * the refresh token, so two at once would lose one. A lock file older than 30 s is stale.
	 */
	private async locked<T>(work: () => Promise<T>): Promise<T> {
		const lock = `${this.file}.lock`;
		const until = Date.now() + 15_000;
		for (;;) {
			try {
				closeSync(openSync(lock, "wx", 0o600));
				break;
			} catch (error) {
				if ((error as { code?: string }).code !== "EEXIST") throw error;
				try {
					if (Date.now() - statSync(lock).mtimeMs > 30_000) {
						rmSync(lock, { force: true });
						continue;
					}
				} catch {
					continue;
				}
				if (Date.now() > until)
					throw new ChatGptError(
						"Another Familiar is busy with the ChatGPT sign-in. Try again in a moment.",
					);
				await Bun.sleep(50);
			}
		}
		try {
			return await work();
		} finally {
			rmSync(lock, { force: true });
		}
	}

	/**
	 * Signs in through the player's browser. `open` gets the address to open; it carries no
	 * token and may be printed. Resolves with the account's email once ChatGPT plan usage is
	 * allowed.
	 */
	async signIn(
		open: (url: string) => void,
		{ timeoutMs = 10 * 60_000 } = {},
	): Promise<string> {
		const saved = this.read();
		const state = random(24);
		const nonce = random(24);
		const verifier = random(48);
		const challenge = base64url(
			new Uint8Array(
				await crypto.subtle.digest(
					"SHA-256",
					new TextEncoder().encode(verifier),
				),
			),
		);
		let finish: (url: URL) => void = () => {};
		const called = new Promise<URL>((resolve) => (finish = resolve));
		// The browser waits for its page until the sign-in is really checked.
		let showPage: (ok: boolean) => void = () => {};
		const page = new Promise<boolean>((resolve) => (showPage = resolve));
		const handler = async (request: Request) => {
			const url = new URL(request.url);
			// Only the browser coming back from this very attempt ends it; anything else is
			// turned away and the sign-in keeps waiting.
			if (
				request.method !== "GET" ||
				url.pathname !== "/auth/callback" ||
				url.searchParams.get("state") !== state
			)
				return new Response("Not this sign-in.", { status: 400 });
			finish(url);
			const ok = await page;
			return new Response(
				`<!doctype html><meta charset="utf-8"><title>${APP_NAME}</title><p>${ok ? "Signed in. You can close this tab and go back to the game." : "Sign-in was not completed. See Familiar's console, then you can close this tab."}</p>`,
				{ headers: { "Content-Type": "text/html; charset=utf-8" } },
			);
		};
		let server: ReturnType<typeof Bun.serve>;
		try {
			server = Bun.serve({
				hostname: "127.0.0.1",
				port: this.firstPort,
				fetch: handler,
			});
		} catch {
			if (!saved.client_id)
				throw new ChatGptError(
					`Port ${FIRST_PORT} on 127.0.0.1 is in use, and the first sign-in needs it. Close the program that uses it (often Codex during its own sign-in) and try again.`,
				);
			server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
		}
		const redirect = `http://127.0.0.1:${server.port}/auth/callback`;
		const clientId = saved.client_id ?? "dynamic_agent_client";
		const query = new URLSearchParams({
			client_id: clientId,
			response_type: "code",
			redirect_uri: redirect,
			scope: SCOPES,
			resource: RESOURCE,
			state,
			nonce,
			code_challenge_method: "S256",
			code_challenge: challenge,
			ext_agent_host_id: saved.ext_agent_host_id,
		});
		// The address is shown to the player, so it gets no ID token as a hint; the email picks
		// the account in the browser just as well.
		if (!saved.client_id) query.set("agent_name_hint", APP_NAME);
		else if (saved.email) query.set("login_hint", saved.email);
		let ok = false;
		try {
			open(`${this.endpoints.authorize}?${query}`);
			const timer = setTimeout(
				() => finish(new URL(`${redirect}?error=timeout`)),
				timeoutMs,
			);
			const back = await called;
			clearTimeout(timer);
			const p = back.searchParams;
			if (p.get("error") === "timeout")
				throw new ChatGptError("Sign-in timed out. Try again.");
			if (p.get("error") === "access_denied")
				throw new ChatGptError(
					"Sign-in was declined in the browser. Try again and allow Familiar to use your ChatGPT plan.",
				);
			if (p.get("error"))
				throw new ChatGptError(
					`ChatGPT refused the sign-in (${clean(p.get("error"))}).`,
				);
			const code = p.get("code");
			if (!code)
				throw new ChatGptError("The browser returned no sign-in code.");
			const issued = p.get("client_id") ?? saved.client_id;
			if (!issued || issued === "dynamic_agent_client")
				throw new ChatGptError(
					"ChatGPT did not finish registering Familiar. Try again.",
				);
			if (saved.client_id && issued !== saved.client_id)
				throw new ChatGptError(
					"The browser returned another registration than this account's. Try again.",
				);
			const tokens = await this.tokenRequest({
				grant_type: "authorization_code",
				client_id: issued,
				code,
				code_verifier: verifier,
				redirect_uri: redirect,
				resource: RESOURCE,
			});
			const claims = await this.verify(tokens.id_token, issued, nonce);
			if (saved.subject && claims.sub !== saved.subject)
				throw new ChatGptError(
					"That is a different ChatGPT account than the one Familiar knows. To switch accounts, run `familiar logout chatgpt --forget` first.",
				);
			const scopes = String(tokens.scope ?? "")
				.split(/\s+/)
				.filter(Boolean);
			const next: Credentials = {
				ext_agent_host_id: saved.ext_agent_host_id,
				client_id: issued,
				subject: String(claims.sub),
				email: typeof claims.email === "string" ? claims.email : undefined,
				id_token: String(tokens.id_token),
				access_token: String(tokens.access_token),
				refresh_token: String(tokens.refresh_token),
				expires_in: Number(tokens.expires_in ?? 3600),
				scopes,
				saved_at: this.now(),
			};
			await this.locked(async () => this.write(next));
			if (!scopes.includes(PLAN_SCOPE))
				throw new ChatGptError(
					"Signed in, but ChatGPT plan usage was not allowed. Sign in again and allow it, or use an API key instead.",
				);
			ok = true;
			return next.email ?? "your ChatGPT account";
		} finally {
			showPage(ok);
			// Gently: the browser still waits for its page.
			void server.stop();
		}
	}

	/** A valid access token, renewed when it is about to expire. One renewal at a time. */
	async accessToken(): Promise<string> {
		const fresh = this.usable(this.read());
		if (fresh) return fresh;
		this.refreshing ??= this.locked(async () => {
			// Another process may have renewed while this one waited for the lock.
			const now = this.read();
			return this.usable(now) ?? (await this.renew(now));
		}).finally(() => {
			this.refreshing = undefined;
		});
		return await this.refreshing;
	}

	/** The saved access token if it may be used as it is; throws if there is no usable sign-in. */
	private usable(c: Credentials): string | undefined {
		if (!c.refresh_token || !c.client_id)
			throw new ChatGptError(
				"Not signed in to ChatGPT. Run `familiar login chatgpt` and restart Familiar.",
			);
		if (!c.scopes?.includes(PLAN_SCOPE))
			throw new ChatGptError(
				"ChatGPT plan usage is not allowed for Familiar. Run `familiar login chatgpt` again and allow it.",
			);
		const expires = (c.saved_at ?? 0) + (c.expires_in ?? 0);
		return c.access_token && this.now() < expires - MARGIN_S
			? c.access_token
			: undefined;
	}

	/** Called under the lock. */
	private async renew(c: Credentials): Promise<string> {
		let tokens: Record<string, unknown>;
		try {
			tokens = await this.tokenRequest({
				grant_type: "refresh_token",
				client_id: c.client_id ?? "",
				refresh_token: c.refresh_token ?? "",
				resource: RESOURCE,
			});
		} catch (error) {
			if (
				error instanceof ChatGptError &&
				/refresh|grant|expired|reused/i.test(error.message)
			) {
				this.write(withoutTokens(c));
				throw new ChatGptError(
					"The ChatGPT sign-in has expired or was revoked. Run `familiar login chatgpt` again.",
				);
			}
			throw error;
		}
		const next: Credentials = {
			...c,
			access_token: String(tokens.access_token),
			refresh_token: String(tokens.refresh_token ?? c.refresh_token),
			id_token:
				typeof tokens.id_token === "string" ? tokens.id_token : c.id_token,
			expires_in: Number(tokens.expires_in ?? 3600),
			scopes:
				typeof tokens.scope === "string"
					? tokens.scope.split(/\s+/).filter(Boolean)
					: c.scopes,
			saved_at: this.now(),
		};
		this.write(next);
		// The renewed grant may no longer allow the plan; then the new token is not used.
		return this.usable(next) ?? next.access_token ?? "";
	}

	/**
	 * Ends the renewable session at OpenAI, then forgets the tokens. `forget` also forgets the
	 * registration, so that another ChatGPT account can sign in.
	 */
	async signOut({ forget = false } = {}): Promise<{ revoked: boolean }> {
		return await this.locked(async () => {
			const c = this.read();
			let revoked = !c.refresh_token;
			if (c.refresh_token && c.client_id) {
				try {
					const response = await this.fetch(this.endpoints.revoke, {
						method: "POST",
						headers: { "Content-Type": "application/x-www-form-urlencoded" },
						body: new URLSearchParams({
							token: c.refresh_token,
							token_type_hint: "refresh_token",
							client_id: c.client_id,
						}),
						signal: AbortSignal.timeout(REQUEST_MS),
					});
					revoked = response.ok;
				} catch {
					revoked = false;
				}
			}
			this.write(
				forget ? { ext_agent_host_id: c.ext_agent_host_id } : withoutTokens(c),
			);
			return { revoked };
		});
	}

	/** The models this account may use, as `slug` and name, in OpenAI's order. */
	async models(): Promise<{ slug: string; name: string }[]> {
		const token = await this.accessToken();
		const response = await this.fetch(`${this.endpoints.api}/models`, {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(REQUEST_MS),
		});
		if (!response.ok)
			throw new ChatGptError(
				`ChatGPT did not list the models (HTTP ${response.status}).`,
			);
		const body = (await response.json()) as {
			models?: { slug?: string; display_name?: string; visibility?: string }[];
		};
		return (body.models ?? [])
			.filter((m) => m.visibility === "list" && m.slug)
			.map((m) => ({
				slug: m.slug as string,
				name: m.display_name ?? (m.slug as string),
			}));
	}

	private async tokenRequest(
		form: Record<string, string>,
	): Promise<Record<string, unknown>> {
		let response: Response;
		try {
			response = await this.fetch(this.endpoints.token, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams(form),
				signal: AbortSignal.timeout(REQUEST_MS),
			});
		} catch {
			throw new ChatGptError("ChatGPT's sign-in server could not be reached.");
		}
		const body = (await response.json().catch(() => ({}))) as Record<
			string,
			unknown
		>;
		if (!response.ok) {
			// Only the machine-readable code, never the description, which could quote the request.
			const code =
				typeof body.error === "string"
					? clean(body.error)
					: `HTTP ${response.status}`;
			throw new ChatGptError(`ChatGPT's sign-in server said ${code}.`);
		}
		return body;
	}

	/** Checks the ID token's signature against OpenAI's keys, and its issuer, audience, nonce and age. */
	private async verify(
		token: unknown,
		clientId: string,
		nonce: string,
	): Promise<Record<string, unknown>> {
		if (typeof token !== "string")
			throw new ChatGptError("ChatGPT sent no ID token.");
		const [h, p, s] = token.split(".");
		if (!h || !p || !s)
			throw new ChatGptError("ChatGPT sent a broken ID token.");
		let header: Record<string, unknown>;
		let claims: Record<string, unknown>;
		try {
			header = JSON.parse(new TextDecoder().decode(unbase64url(h)));
			claims = JSON.parse(new TextDecoder().decode(unbase64url(p)));
		} catch {
			throw new ChatGptError("ChatGPT sent a broken ID token.");
		}
		if (header.alg !== "RS256")
			throw new ChatGptError(
				"ChatGPT's ID token uses an unexpected signature.",
			);
		let keys: { keys?: (Record<string, unknown> & { kid?: string })[] };
		try {
			const response = await this.fetch(this.endpoints.jwks, {
				signal: AbortSignal.timeout(REQUEST_MS),
			});
			keys = (await response.json()) as typeof keys;
		} catch {
			throw new ChatGptError("ChatGPT's signing keys could not be loaded.");
		}
		const jwk = keys.keys?.find((k) => k.kid === header.kid);
		if (!jwk)
			throw new ChatGptError(
				"ChatGPT's ID token is signed with an unknown key.",
			);
		const key = await crypto.subtle.importKey(
			"jwk",
			// Bun types have no JsonWebKey; the key comes straight from OpenAI's JWKS.
			jwk as never,
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["verify"],
		);
		const valid = await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			key,
			unbase64url(s),
			new TextEncoder().encode(`${h}.${p}`),
		);
		const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
		if (
			!valid ||
			claims.iss !== this.endpoints.issuer ||
			!audience.includes(clientId) ||
			claims.nonce !== nonce ||
			typeof claims.exp !== "number" ||
			claims.exp < this.now() - 60 ||
			typeof claims.sub !== "string"
		)
			throw new ChatGptError(
				"ChatGPT's ID token did not check out. Try again.",
			);
		return claims;
	}
}

/**
 * Lets only the current user read `file`. Unix mode bits do that elsewhere; on Windows the file
 * gets an ACL with just the user's own entry, so a folder shared with others does not leak it.
 */
function restrict(file: string): void {
	if (process.platform !== "win32") return;
	const user = process.env.USERDOMAIN
		? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
		: process.env.USERNAME;
	const done = user
		? spawnSync("icacls", [file, "/inheritance:r", "/grant:r", `${user}:F`], {
				stdio: "ignore",
				windowsHide: true,
			})
		: undefined;
	if (done?.status !== 0)
		throw new ChatGptError(
			"Familiar could not restrict its ChatGPT sign-in file to your Windows user, so it did not keep it.",
		);
}

function withoutTokens(c: Credentials): Credentials {
	const {
		access_token: _a,
		refresh_token: _r,
		id_token: _i,
		expires_in: _e,
		scopes: _s,
		saved_at: _t,
		...kept
	} = c;
	return kept;
}

function random(bytes: number): string {
	return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function base64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

function unbase64url(text: string): Uint8Array<ArrayBuffer> {
	return new Uint8Array(Buffer.from(text, "base64url"));
}

/** An OAuth error code, safe to show: letters, digits and underscores only. */
function clean(text: string | null): string {
	return (text ?? "").replace(/[^\w.-]/g, "").slice(0, 60) || "an error";
}
