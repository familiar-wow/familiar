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
