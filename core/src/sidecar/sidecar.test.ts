// The sidecar against fake programs and a fake keychain: requests in, replies and events out.
import { afterAll, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Log } from "../log.ts";
import { ListError } from "./models.ts";
import { memoryStore, names, SecretError } from "./secrets.ts";
import {
	clientFolder,
	type Deps,
	isTestRealm,
	Sidecar,
	type Status,
} from "./sidecar.ts";

const folders: string[] = [];
afterAll(() => {
	for (const f of folders) rmSync(f, { recursive: true, force: true });
});

function temp(): string {
	const dir = mkdtempSync(join(tmpdir(), "familiar-sidecar-"));
	folders.push(dir);
	return dir;
}

/** A WoW folder with a _forever_ client in it. */
function wow(): { root: string; client: string } {
	const root = temp();
	const client = join(root, "_forever_");
	mkdirSync(join(client, "Interface", "AddOns"), { recursive: true });
	mkdirSync(join(client, "WTF", "Account"), { recursive: true });
	writeFileSync(join(client, "Wow.exe"), "");
	writeFileSync(
		join(root, ".build.info"),
		"Branch!STRING:0|Product!STRING:0|Version!STRING:0\nus|wowf|1.60.1.71037\n",
	);
	return { root, client };
}

function sidecar(deps: Partial<Deps> = {}, settings?: unknown) {
	const dir = temp();
	const settingsFile = join(dir, "settings.json");
	const logs = join(dir, "logs");
	if (settings) writeFileSync(settingsFile, JSON.stringify(settings));
	const out: Record<string, unknown>[] = [];
	const store = memoryStore();
	const s = new Sidecar({
		settingsFile,
		logs,
		version: "0.0.0-test",
		askpass: "/opt/familiar",
		write: (line) => void out.push(JSON.parse(line)),
		deps: {
			secrets: store,
			findClients: async () => [],
			clientProcesses: async () => [],
			openUrl: () => {},
			openFolder: () => {},
			serverModels: async () => undefined,
			...deps,
		},
	});
	let id = 0;
	const call = async (method: string, params?: Record<string, unknown>) => {
		const mine = ++id;
		await s.handle(JSON.stringify({ id: mine, method, params }));
		const reply = out.find((m) => m.id === mine) as
			| { result?: unknown; error?: { message: string } }
			| undefined;
		if (!reply) throw new Error(`no reply to ${method}`);
		return reply;
	};
	return { s, out, store, settingsFile, logs, call };
}

test("answers hello, refuses unknown methods and lines that are no request", async () => {
	const { s, out, call } = sidecar();
	expect((await call("hello")).result).toMatchObject({ version: "0.0.0-test" });
	expect((await call("no.such")).error?.message).toBe(
		"Unknown method no.such.",
	);
	await s.handle("not json");
	expect(out.at(-1)).toEqual({
		event: "invalid",
		data: { message: "Not a request." },
	});
});

test("settings: the app never sees a key, and a key it sends goes to the keychain", async () => {
	const { call, store, settingsFile } = sidecar(
		{},
		{
			brain: {
				use: "model",
				model: {
					provider: "openrouter",
					name: "openai/gpt-6-luna",
					apiKey: "sk-in-file",
				},
			},
		},
	);
	const got = (await call("settings.get")).result as {
		settings: { brain: { model: Record<string, unknown> } };
		keys: Record<string, boolean>;
	};
	expect(got.settings.brain.model.apiKey).toBeUndefined();
	expect(got.keys.openrouter).toBe(true);

	// Sent back without the key (the app never had it): the key from the file is kept, and moves
	// into the keychain.
	await call("settings.set", { settings: got.settings });
	expect(
		JSON.parse(readFileSync(settingsFile, "utf8")).brain.model.apiKey,
	).toBeUndefined();
	expect(await store.get(names.apiKey("openrouter"))).toBe("sk-in-file");

	// A new key from the app: into the keychain, out of the file.
	const next = structuredClone(got.settings);
	next.brain.model.apiKey = "sk-new";
	await call("settings.set", { settings: next });
	expect(
		JSON.parse(readFileSync(settingsFile, "utf8")).brain.model.apiKey,
	).toBeUndefined();
	expect(await store.get(names.apiKey("openrouter"))).toBe("sk-new");
	expect(JSON.stringify((await call("settings.get")).result)).not.toContain(
		"sk-",
	);
});

test("settings that do not fit are refused with words that name no value", async () => {
	const { call } = sidecar();
	const reply = await call("settings.set", {
		settings: { brain: { use: "model", "sk-secret-in-a-key-name": 1 } },
	});
	expect(reply.error?.message).toContain("does not know");
	expect(reply.error?.message).not.toContain("sk-secret");
});

test("finds the game, and takes a folder, its parent or the game's program", async () => {
	const { root, client } = wow();
	const { call } = sidecar({ findClients: async () => [client] });
	expect((await call("game.find")).result).toEqual([
		{ client, version: "1.60.1.71037", interface: 16001, installed: false },
	]);
	expect(clientFolder(root)).toBe(client);
	expect(clientFolder(join(client, "Wow.exe"))).toBe(client);
	expect(clientFolder(temp())).toBeUndefined();
	expect((await call("game.check", { path: temp() })).error?.message).toContain(
		"not a WoW Forever folder",
	);
});

// Installing writes thousands of helper files: about 15 s on a Windows runner.
test("an installed addon shows its own version", async () => {
	const { client } = wow();
	const { call } = sidecar({ findClients: async () => [client] });
	expect((await call("addon.install", { client })).error).toBeUndefined();
	expect((await call("game.find")).result).toEqual([
		{
			client,
			version: "1.60.1.71037",
			interface: 16001,
			installed: true,
			addonVersion: "0.0.0-test",
		},
	]);
}, 60_000);

test("refuses a test realm, also one that would pass as a client folder", async () => {
	const root = temp();
	const ptr = join(root, "_ptr_");
	mkdirSync(join(ptr, "Interface", "AddOns"), { recursive: true });
	writeFileSync(join(ptr, "Wow.exe"), "");
	const { call } = sidecar();
	const eraPtr = join(root, "_classic_era_ptr_");
	mkdirSync(join(eraPtr, "Interface", "AddOns"), { recursive: true });
	writeFileSync(join(eraPtr, "Wow.exe"), "");
	for (const path of [
		ptr,
		join(ptr, "Wow.exe"),
		join(root, "_classic_ptr_"),
		eraPtr,
	])
		expect((await call("game.check", { path })).error?.message).toContain(
			"test realm",
		);
	expect(isTestRealm(join(root, "_forever_"))).toBe(false);
	expect(isTestRealm(join(root, "_xptr_", "Wow.exe"))).toBe(true);
	expect(isTestRealm(join(root, "_beta_"))).toBe(true);
	expect(isTestRealm(join(root, "ptr notes"))).toBe(false);
});

test("lists another server's models, and refuses addresses that are no server", async () => {
	const asked: string[] = [];
	const { call } = sidecar({
		serverModels: async (url) => {
			asked.push(url);
			return url.includes("192.168.1.20") ? [{ id: "qwen3:8b" }] : undefined;
		},
	});
	expect(
		(await call("local.models", { baseUrl: " http://192.168.1.20:11434/v1/ " }))
			.result,
	).toEqual([{ id: "qwen3:8b" }]);
	expect(asked).toEqual(["http://192.168.1.20:11434/v1"]);
	expect(
		(await call("local.models", { baseUrl: "http://10.0.0.9/v1" })).error
			?.message,
	).toContain("No OpenAI-compatible server answered");
	for (const [baseUrl, words] of [
		["", "Enter the server's address"],
		["file:///etc/passwd", "http:// or https://"],
		["http://user:secret@host/v1", "Leave the user name and password out"],
	])
		expect((await call("local.models", { baseUrl })).error?.message).toContain(
			words,
		);
	// Nothing that is no server was asked.
	expect(asked).toHaveLength(2);
});

test("opens the log folder, and makes it first when nothing was logged yet", async () => {
	let opened = "";
	const { call, logs } = sidecar({
		openFolder: (folder) => {
			opened = folder;
		},
	});
	expect((await call("logs.open")).result).toBeNull();
	expect(opened).toBe(logs);
	expect(existsSync(logs)).toBe(true);
});

test("keys: stored, found and removed; models are listed with the stored key", async () => {
	let seen = "";
	const { call } = sidecar({
		listModels: async (_provider, key) => {
			seen = key;
			return [{ id: "openai/gpt-6-luna", recommended: true }];
		},
	});
	expect(
		(await call("models.list", { provider: "openrouter" })).error?.message,
	).toBe("Enter the API key first.");
	expect(
		(await call("key.set", { provider: "openrouter", key: " sk-or-1 " }))
			.result,
	).toBeNull();
	expect((await call("key.has", { provider: "openrouter" })).result).toBe(true);
	expect(
		(await call("models.list", { provider: "openrouter" })).result,
	).toEqual([{ id: "openai/gpt-6-luna", recommended: true }]);
	expect(seen).toBe("sk-or-1");
	expect((await call("key.delete", { provider: "openrouter" })).result).toBe(
		true,
	);
	expect((await call("key.has", { provider: "openrouter" })).result).toBe(
		false,
	);
	expect(
		(await call("key.set", { provider: "nope", key: "x" })).error?.message,
	).toBe("Choose a provider.");
});

test("errors: our own words pass, anything else says nothing about itself", async () => {
	const { call } = sidecar({
		listModels: async () => {
			throw new ListError("The provider refused the key.");
		},
		findAgents: async () => {
			throw new Error("internal detail sk-should-not-show");
		},
	});
	expect(
		(await call("models.list", { provider: "openai", key: "sk-x" })).error
			?.message,
	).toBe("The provider refused the key.");
	expect((await call("agents.find")).error?.message).toBe(
		"Something went wrong (Error).",
	);
});

test("a host that could be read as an ssh option is refused", async () => {
	let asked = "";
	const { call } = sidecar({
		resolveHost: async (host) => {
			asked = host;
			return {
				host,
				hostname: host,
				user: "u",
				port: 22,
				identityFiles: [],
				fromConfig: false,
			};
		},
	});
	for (const host of ["-oProxyCommand=evil", "a b", ""])
		expect((await call("ssh.resolve", { host })).error?.message).toBe(
			"Enter the computer's name or address.",
		);
	expect(asked).toBe("");
	expect((await call("ssh.resolve", { host: "homelab" })).result).toMatchObject(
		{
			hostname: "homelab",
		},
	);
});

test("start runs Familiar and the status follows what the log says", async () => {
	const { client } = wow();
	let log: Log | undefined;
	let stopped = false;
	const { call, out } = sidecar(
		{
			findClients: async () => [client],
			startFamiliar: async (o) => {
				log = o.log;
				o.notes.warn("Port 27495 is in use.");
				return {
					install: { added: 1, updated: 0, removed: 0 } as never,
					fresh: true,
					stop: () => {
						stopped = true;
					},
				};
			},
		},
		{ brain: { command: ["hermes", "acp"] } },
	);
	const started = (await call("start")).result as Record<string, unknown>;
	expect(started).toMatchObject({
		running: true,
		client,
		brain: { kind: "agent", command: ["hermes", "acp"] },
		problems: ["Port 27495 is in use."],
	});
	log?.event("hello", { text: "Familiar 0.0.0, build 1" });
	log?.event("message", { key: "k", id: 1 });
	log?.event("question", { character: { name: "Moonbreeze", level: "35" } });
	log?.event("answered", {
		ms: 3800,
		bytes: 120,
		tools: ["quests", "flightpaths"],
	});
	const last = out.filter((m) => m.event === "status").at(-1)?.data as Record<
		string,
		unknown
	>;
	expect(last).toMatchObject({
		game: { hello: "Familiar 0.0.0, build 1" },
		character: { name: "Moonbreeze" },
		last: { ms: 3800, tools: ["quests", "flightpaths"] },
	});
	expect((last.game as { lastContact?: number }).lastContact).toBeNumber();
	expect(out.some((m) => m.event === "log")).toBe(true);
	expect(
		((await call("logs.recent", { limit: 2 })).result as unknown[]).length,
	).toBe(2);
	await call("stop");
	expect(stopped).toBe(true);
});

test("a WoW that closes takes its hello along, so the app no longer shows it connected", async () => {
	const { client } = wow();
	let log: Log | undefined;
	const { call, out } = sidecar({
		findClients: async () => [client],
		startFamiliar: async (o) => {
			log = o.log;
			return {
				install: { added: 0, updated: 0, removed: 0 } as never,
				fresh: false,
				stop: () => {},
			};
		},
	});
	await call("start");
	const game = () =>
		(out.filter((m) => m.event === "status").at(-1)?.data as Status | undefined)
			?.game ?? ({} as Status["game"]);
	log?.event("game", { pids: [41] });
	log?.event("hello", { text: "Familiar 0.0.0, build 1" });
	log?.event("message", { key: "k", id: 1 });
	// A second client starting changes nothing for the first one's addon.
	log?.event("game", { pids: [41, 77] });
	expect(game()).toMatchObject({
		running: true,
		hello: "Familiar 0.0.0, build 1",
	});
	log?.event("game", { pids: [77] });
	expect(game().running).toBe(true);
	expect(game().hello).toBeUndefined();
	expect(game().lastContact).toBeUndefined();
	log?.event("hello", { text: "Familiar 0.0.0, build 2" });
	log?.event("game", { pids: [] });
	expect(game()).toEqual({ running: false });
	await call("stop");
});

test("two starts at once start Familiar once, and a stop during the start wins", async () => {
	const { client } = wow();
	let starts = 0;
	const stopped: number[] = [];
	let release: () => void = () => {};
	const { call } = sidecar(
		{
			findClients: async () => [client],
			startFamiliar: async () => {
				const me = ++starts;
				await new Promise<void>((r) => {
					release = r;
				});
				return {
					install: { added: 0, updated: 0, removed: 0 } as never,
					fresh: false,
					stop: () => void stopped.push(me),
				};
			},
		},
		{ brain: { command: ["hermes", "acp"] } },
	);
	const a = call("start");
	const b = call("start");
	await Bun.sleep(20);
	release();
	await a;
	await Bun.sleep(20);
	expect((await b).result).toMatchObject({ running: true });
	expect(starts).toBe(1);

	// A stop sent while a restart is still starting: the new run is stopped as soon as it is up.
	const restart = call("restart");
	await Bun.sleep(20);
	const stop = call("stop");
	release();
	await restart;
	await stop;
	expect(starts).toBe(2);
	expect(stopped).toEqual([1, 2]);
	expect(((await call("status")).result as { running: boolean }).running).toBe(
		false,
	);
});

test("what a stopped run still logs no longer reaches the app", async () => {
	const { client } = wow();
	let log: Log | undefined;
	const { call, out } = sidecar(
		{
			findClients: async () => [client],
			startFamiliar: async (o) => {
				log = o.log;
				return { install: {} as never, fresh: false, stop: () => {} };
			},
		},
		{ brain: { command: ["hermes", "acp"] } },
	);
	await call("start");
	await call("stop");
	const before = out.length;
	log?.event("answered", { ms: 1, bytes: 1, tools: [] });
	expect(out.length).toBe(before);
	expect(
		((await call("status")).result as { last?: unknown }).last,
	).toBeUndefined();
});

test("settings changed while running wait for a restart", async () => {
	const { client } = wow();
	const { call } = sidecar(
		{
			findClients: async () => [client],
			startFamiliar: async () => ({
				install: {} as never,
				fresh: false,
				stop: () => {},
			}),
		},
		{ brain: { command: ["hermes", "acp"] } },
	);
	await call("start");
	const got = (await call("settings.get")).result as {
		settings: Record<string, unknown>;
	};
	const next = structuredClone(got.settings) as {
		brain: { command: string[] };
	};
	next.brain.command = ["codex-acp"];
	await call("settings.set", { settings: next });
	expect((await call("status")).result).toMatchObject({
		restartNeeded: true,
		brain: { command: ["hermes", "acp"] },
	});
});

test("a key in the file moves into the keychain when the settings are saved", async () => {
	const { call, store, settingsFile } = sidecar(
		{},
		{
			brain: {
				use: "model",
				model: {
					provider: "openai-compatible",
					name: "m",
					baseUrl: "http://x/v1",
					apiKey: "sk-file",
				},
			},
		},
	);
	const got = (await call("settings.get")).result as { settings: unknown };
	await call("settings.set", { settings: got.settings });
	expect(
		JSON.parse(readFileSync(settingsFile, "utf8")).brain.model.apiKey,
	).toBeUndefined();
	expect(await store.get(names.apiKey("openai-compatible"))).toBe("sk-file");
});

test("without a keychain the key stays in the file, readable only by its owner", async () => {
	if (process.platform === "win32") return;
	const broken = {
		get: async () => null,
		set: async () => {
			throw new SecretError("The system keychain is not available.");
		},
		delete: async () => false,
	};
	const { call, settingsFile } = sidecar(
		{ secrets: broken },
		{
			brain: {
				use: "model",
				model: { provider: "openrouter", name: "m", apiKey: "sk-file" },
			},
		},
	);
	chmodSync(settingsFile, 0o644);
	const got = (await call("settings.get")).result as { settings: unknown };
	expect(
		(await call("settings.set", { settings: got.settings })).error,
	).toBeUndefined();
	expect(
		JSON.parse(readFileSync(settingsFile, "utf8")).brain.model.apiKey,
	).toBe("sk-file");
	expect(statSync(settingsFile).mode & 0o777).toBe(0o600);
});

test("a stop before the start has found its client still stops it, and shutdown ends all starts", async () => {
	const { client } = wow();
	let release: (() => void) | undefined;
	let starts = 0;
	const { call } = sidecar(
		{
			// The start's look for the game is held back, before anything else runs.
			findClients: () =>
				release === undefined
					? new Promise((resolve) => {
							release = () => resolve([client]);
						})
					: Promise.resolve([client]),
			startFamiliar: async () => {
				starts++;
				return { install: {} as never, fresh: false, stop: () => {} };
			},
		},
		{ brain: { command: ["hermes", "acp"] } },
	);
	const start = call("start");
	await Bun.sleep(20);
	const stop = call("stop");
	release?.();
	await start;
	await stop;
	expect(starts).toBe(0);
	expect(((await call("status")).result as { running: boolean }).running).toBe(
		false,
	);
});

test("settings saved while a start is under way also wait for a restart", async () => {
	const { client } = wow();
	let release: () => void = () => {};
	const { call } = sidecar(
		{
			findClients: async () => [client],
			startFamiliar: async () => {
				await new Promise<void>((r) => {
					release = r;
				});
				return { install: {} as never, fresh: false, stop: () => {} };
			},
		},
		{ brain: { command: ["hermes", "acp"] } },
	);
	const start = call("start");
	await Bun.sleep(20);
	const got = (await call("settings.get")).result as {
		settings: { brain: { command: string[] } };
	};
	got.settings.brain.command = ["codex-acp"];
	await call("settings.set", { settings: got.settings });
	release();
	await start;
	expect((await call("status")).result).toMatchObject({
		running: true,
		restartNeeded: true,
		brain: { command: ["hermes", "acp"] },
	});
});

test("the app's own settings change nothing a run uses, so they need no restart", async () => {
	const { client } = wow();
	const { call } = sidecar(
		{
			findClients: async () => [client],
			startFamiliar: async () => ({
				install: {} as never,
				fresh: false,
				stop: () => {},
			}),
		},
		{ brain: { command: ["hermes", "acp"] } },
	);
	await call("start");
	const got = (await call("settings.get")).result as {
		settings: { app: Record<string, unknown> };
	};
	got.settings.app.language = "de";
	got.settings.app.setupDone = true;
	got.settings.app.brains = { agent: { command: ["codex-acp"] } };
	await call("settings.set", { settings: got.settings });
	expect((await call("status")).result).toMatchObject({
		running: true,
		restartNeeded: false,
	});
});

test("an old key from the file does not replace a newer one in the keychain", async () => {
	const { call, store, settingsFile } = sidecar(
		{},
		{
			brain: {
				use: "model",
				model: { provider: "openrouter", name: "m", apiKey: "sk-old" },
			},
		},
	);
	await store.set(names.apiKey("openrouter"), "sk-new");
	const got = (await call("settings.get")).result as { settings: unknown };
	await call("settings.set", { settings: got.settings });
	expect(await store.get(names.apiKey("openrouter"))).toBe("sk-new");
	expect(
		JSON.parse(readFileSync(settingsFile, "utf8")).brain.model.apiKey,
	).toBeUndefined();
});

test("settings saved while the start still looks for the game wait for a restart", async () => {
	const { client } = wow();
	let release: (() => void) | undefined;
	const { call } = sidecar(
		{
			findClients: () =>
				release === undefined
					? new Promise((resolve) => {
							release = () => resolve([client]);
						})
					: Promise.resolve([client]),
			startFamiliar: async () => ({
				install: {} as never,
				fresh: false,
				stop: () => {},
			}),
		},
		{ brain: { command: ["hermes", "acp"] } },
	);
	const start = call("start");
	await Bun.sleep(20);
	const got = (await call("settings.get")).result as {
		settings: { brain: { command: string[] } };
	};
	got.settings.brain.command = ["codex-acp"];
	await call("settings.set", { settings: got.settings });
	release?.();
	await start;
	expect((await call("status")).result).toMatchObject({
		running: true,
		restartNeeded: true,
		brain: { command: ["hermes", "acp"] },
	});
});
