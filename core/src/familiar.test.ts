// Starting Familiar: the key it uses, and that nothing outlives a failed start.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareBrain, resolveKey, startFamiliar } from "./familiar.ts";
import { parseSettings } from "./settings.ts";
import { memoryStore, names } from "./sidecar/secrets.ts";
import { wowPaths } from "./wow/client.ts";

const folders: string[] = [];
afterAll(() => {
	for (const f of folders) rmSync(f, { recursive: true, force: true });
});

test("one key everywhere: keychain, then the settings, then the environment", async () => {
	const store = memoryStore();
	const settings = parseSettings({
		brain: {
			use: "model",
			model: { provider: "openrouter", name: "m", apiKey: "from-file" },
		},
	});
	const env = { OPENROUTER_API_KEY: "from-env" };
	expect(await resolveKey("openrouter", settings, store, env)).toBe(
		"from-file",
	);
	await store.set(names.apiKey("openrouter"), "from-keychain");
	expect(await resolveKey("openrouter", settings, store, env)).toBe(
		"from-keychain",
	);
	const bare = parseSettings({
		brain: { use: "model", model: { provider: "openrouter", name: "m" } },
	});
	expect(await resolveKey("openrouter", bare, undefined, env)).toBe("from-env");
});

test("a server without a key variable still gets the key from the keychain", async () => {
	const store = memoryStore();
	await store.set(names.apiKey("openai-compatible"), "sk-compat");
	const settings = parseSettings({
		brain: {
			use: "model",
			model: {
				provider: "openai-compatible",
				name: "m",
				baseUrl: "http://127.0.0.1:9/v1",
			},
		},
	});
	const { brain } = await prepareBrain(settings, { secrets: store });
	expect(brain.model?.apiKey).toBe("sk-compat");
	// Only for the run: the settings themselves keep no key.
	expect(settings.brain.model?.apiKey).toBeUndefined();
});

test("a start that fails leaves no game tools server behind", async () => {
	const root = mkdtempSync(join(tmpdir(), "familiar-start-"));
	folders.push(root);
	const client = join(root, "_forever_");
	mkdirSync(join(client, "Interface", "AddOns"), { recursive: true });
	mkdirSync(join(client, "WTF", "Account"), { recursive: true });
	writeFileSync(join(client, "Wow.exe"), "");
	const port = 27600 + Math.floor(Math.random() * 300);
	const settings = parseSettings({
		brain: { command: ["hermes", "acp"] },
		mcp: { port },
	});
	const quiet = { event: () => {}, say: () => {} };
	await expect(
		startFamiliar({
			paths: wowPaths(client),
			settings,
			settingsFile: join(root, "settings.json"),
			log: quiet,
			logFile: join(root, "log.jsonl"),
			version: "0.0.0-test",
			notes: {
				info: (text) => {
					// Fails after the game tools are up, as a later step of the start would.
					if (text === "Addon installed.") throw new Error("later step failed");
				},
				warn: () => {},
			},
		}),
	).rejects.toThrow("later step failed");
	// The port is free again.
	const server = Bun.serve({
		port,
		hostname: "127.0.0.1",
		fetch: () => new Response(""),
	});
	server.stop(true);
});

test("an agent behind a password is started through ssh, checked first", async () => {
	const settings = parseSettings({
		brain: {
			ssh: {
				host: "familiar-test.invalid",
				user: "pascal",
				auth: "password",
				command: ["hermes", "acp"],
			},
		},
	});
	// ssh -G resolves without connecting, so this needs no such computer.
	const { brain, env } = await prepareBrain(settings, {
		askpass: "/opt/familiar",
	});
	expect(brain.command[0]).toBe("ssh");
	expect(brain.command).toContain("familiar-test.invalid");
	expect(env?.FAMILIAR_ASKPASS_HOST).toBe("pascal@familiar-test.invalid");
	expect(env?.SSH_ASKPASS).toBe("/opt/familiar");
});
