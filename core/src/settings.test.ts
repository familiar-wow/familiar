import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings } from "./settings.ts";

function withFile(text: string, check: (file: string) => void) {
	const folder = mkdtempSync(join(tmpdir(), "familiar-settings-"));
	const file = join(folder, "settings.json");
	writeFileSync(file, text);
	try {
		check(file);
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
}

test("old settings without brain.use keep the player's agent", () => {
	withFile('{"brain":{"command":["hermes","acp"]}}', (file) => {
		expect(loadSettings(file).brain.use).toBe("agent");
	});
});

test("old settings get the app's new fields: setup unset, nothing remembered", () => {
	withFile('{"brain":{"command":["hermes","acp"]}}', (file) => {
		const app = loadSettings(file).app;
		expect(app.setupDone).toBeUndefined();
		expect(app.brains).toEqual({});
	});
	withFile(
		JSON.stringify({
			app: {
				setupDone: true,
				brains: {
					key: { provider: "openrouter", name: "openai/gpt-6-luna" },
					local: {
						provider: "openai-compatible",
						name: "qwen3",
						baseUrl: "http://192.168.1.20:11434/v1",
					},
					agent: { command: ["codex-acp"] },
					ssh: { host: "homelab", command: ["hermes", "acp"] },
				},
			},
		}),
		(file) => {
			const app = loadSettings(file).app;
			expect(app.setupDone).toBe(true);
			expect(app.brains.ssh).toEqual({
				host: "homelab",
				auth: "key",
				command: ["hermes", "acp"],
			});
		},
	);
	// What the app remembers for a key provider with its own address loads too.
	withFile(
		'{"app":{"brains":{"key":{"provider":"openai","name":"m","baseUrl":"https://proxy.example/v1"}}}}',
		(file) => {
			expect(loadSettings(file).app.brains.key?.baseUrl).toBe(
				"https://proxy.example/v1",
			);
		},
	);
	// A remembered API key provider is one that takes a key, not a local server.
	withFile(
		'{"app":{"brains":{"key":{"provider":"ollama","name":"x"}}}}',
		(file) => {
			expect(() => loadSettings(file)).toThrow();
		},
	);
});

test("a server address is http or https, without a user or password in it", () => {
	const local = (baseUrl: string) =>
		JSON.stringify({
			brain: {
				use: "model",
				model: { provider: "openai-compatible", name: "m", baseUrl },
			},
		});
	withFile(local("http://192.168.1.20:11434/v1"), (file) => {
		expect(loadSettings(file).brain.model?.baseUrl).toBe(
			"http://192.168.1.20:11434/v1",
		);
	});
	for (const bad of [
		"http://me:secret@host/v1",
		"file:///etc/passwd",
		"ftp://host/v1",
	])
		withFile(local(bad), (file) => {
			expect(() => loadSettings(file)).toThrow();
		});
	withFile(
		'{"app":{"brains":{"local":{"provider":"ollama","name":"m","baseUrl":"http://u:p@h/v1"}}}}',
		(file) => {
			expect(() => loadSettings(file)).toThrow();
		},
	);
});

test("the built-in agent needs a model, and openai-compatible a baseUrl", () => {
	withFile('{"brain":{"use":"model"}}', (file) => {
		expect(() => loadSettings(file)).toThrow("brain.model must name");
	});
	withFile(
		'{"brain":{"use":"model","model":{"provider":"openai-compatible","name":"x"}}}',
		(file) => {
			expect(() => loadSettings(file)).toThrow("needs a baseUrl");
		},
	);
	withFile(
		'{"brain":{"use":"model","model":{"provider":"openrouter","name":"openai/gpt-6-luna"}}}',
		(file) => {
			expect(loadSettings(file).brain.model?.provider).toBe("openrouter");
		},
	);
});

test("an unknown setting is reported without its name, which may be a key", () => {
	const key = "sk-or-v1-TESTKEY0123456789";
	withFile(
		`{"brain":{"use":"model","model":{"provider":"openrouter","name":"x","${key}":true}}}`,
		(file) => {
			let message = "";
			try {
				loadSettings(file);
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			expect(message).toContain(
				"brain.model: has a setting Familiar does not know",
			);
			expect(message).not.toContain(key);
		},
	);
});

test("broken JSON is reported without quoting the file, which may hold a key", () => {
	const key = "AIzaSyTEST-not-a-real-key-123";
	withFile(`{"brain":{"use":"model","model":{"apiKey": ${key} }}}`, (file) => {
		let message = "";
		try {
			loadSettings(file);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("is not valid JSON");
		expect(message).not.toContain(key);
	});
});
