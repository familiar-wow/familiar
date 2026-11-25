import { expect, test } from "bun:test";
import {
	activeChoice,
	activeKind,
	applyChoice,
	choiceFor,
	isActive,
	joinCommand,
	remember,
	type Settings,
	splitCommand,
} from "./brain.ts";

const base: Settings = {
	game: { client: "C:\\WoW\\_forever_" },
	app: { language: "de", close: "tray", setupDone: true, brains: {} },
	brain: {
		use: "agent",
		command: ["hermes", "acp"],
		permissions: "ask",
		timeout: 120,
	},
	mcp: { port: 27495 },
};

test("the kind that answers follows brain.use and the model's provider", () => {
	expect(activeKind(base)).toBe("agent");
	const model = (provider: string): Settings => ({
		brain: { use: "model", model: { provider, name: "m" } },
	});
	expect(activeKind(model("chatgpt"))).toBe("chatgpt");
	expect(activeKind(model("openrouter"))).toBe("key");
	expect(activeKind(model("ollama"))).toBe("local");
	expect(activeKind(model("openai-compatible"))).toBe("local");
	// A model without use: "model" does not answer.
	expect(
		activeKind({ brain: { model: { provider: "openai", name: "m" } } }),
	).toBe("agent");
});

test("applying a model keeps the game, the other tabs, permissions and time limit", () => {
	const next = applyChoice(base, {
		kind: "key",
		provider: "openrouter",
		name: "openai/gpt-6-luna",
	});
	expect(next.brain).toEqual({
		use: "model",
		model: { provider: "openrouter", name: "openai/gpt-6-luna" },
		command: ["hermes", "acp"],
		permissions: "ask",
		timeout: 120,
	});
	expect(next.game).toEqual(base.game);
	expect(next.mcp).toEqual(base.mcp);
	expect(next.app?.brains?.key).toEqual({
		provider: "openrouter",
		name: "openai/gpt-6-luna",
	});
	// The input is left alone.
	expect(base.brain?.use).toBe("agent");
});

test("switching kinds and back finds each tab as it was", () => {
	let s = applyChoice(base, { kind: "chatgpt", name: "gpt-6-luna" });
	s = applyChoice(s, {
		kind: "local",
		provider: "openai-compatible",
		name: "qwen3:8b",
		baseUrl: "http://192.168.1.20:11434/v1",
	});
	s = applyChoice(s, { kind: "agent", where: "local", command: ["codex-acp"] });
	expect(activeKind(s)).toBe("agent");
	expect(choiceFor(s, "chatgpt")).toEqual({
		kind: "chatgpt",
		name: "gpt-6-luna",
	});
	expect(choiceFor(s, "local")).toEqual({
		kind: "local",
		provider: "openai-compatible",
		name: "qwen3:8b",
		baseUrl: "http://192.168.1.20:11434/v1",
	});
	expect(choiceFor(s, "key")).toBeUndefined();
	// The model that answered before is gone from brain, but not from its tab.
	expect(s.brain?.model).toBeUndefined();
});

test("the agent on this PC and the one on another computer each keep their own folder", () => {
	const ssh = {
		host: "homelab",
		auth: "key" as const,
		command: ["/home/p/.local/bin/hermes", "acp"],
	};
	let s = applyChoice(base, {
		kind: "agent",
		where: "local",
		command: ["hermes", "acp"],
		cwd: "C:\\Users\\p\\familiar",
	});
	s = applyChoice(s, { kind: "agent", where: "ssh", ssh, cwd: "/home/p" });
	expect(s.brain?.ssh).toEqual(ssh);
	expect(s.brain?.cwd).toBe("/home/p");
	expect(choiceFor(s, "agent")).toEqual({
		kind: "agent",
		where: "ssh",
		ssh,
		cwd: "/home/p",
	});
	expect(choiceFor(s, "agent", "local")).toEqual({
		kind: "agent",
		where: "local",
		command: ["hermes", "acp"],
		cwd: "C:\\Users\\p\\familiar",
	});
	// Back to this PC: brain.ssh goes, the computer stays remembered.
	const back = applyChoice(s, choiceFor(s, "agent", "local") as never);
	expect(back.brain?.ssh).toBeUndefined();
	expect(back.brain?.cwd).toBe("C:\\Users\\p\\familiar");
	expect(choiceFor(back, "agent", "ssh")).toEqual({
		kind: "agent",
		where: "ssh",
		ssh,
		cwd: "/home/p",
	});
	// No folder chosen: none in brain either, so the core's default applies.
	const plain = applyChoice(back, {
		kind: "agent",
		where: "local",
		command: ["hermes", "acp"],
	});
	expect(plain.brain?.cwd).toBeUndefined();
});

test("old settings without app.brains: the tabs start from what brain holds", () => {
	const old: Settings = { brain: { command: ["codex-acp"] } };
	expect(activeChoice(old)).toEqual({
		kind: "agent",
		where: "local",
		command: ["codex-acp"],
	});
	expect(choiceFor(old, "agent", "ssh")).toBeUndefined();
	expect(choiceFor({}, "agent")).toEqual({
		kind: "agent",
		where: "local",
		command: ["hermes", "acp"],
	});
});

test("remember changes only the tab's memory, never the brain that answers", () => {
	const next = remember(base, { kind: "chatgpt", name: "gpt-6-luna" });
	expect(next.brain).toEqual(base.brain);
	expect(next.app?.brains?.chatgpt).toEqual({ name: "gpt-6-luna" });
	expect(next.app?.language).toBe("de");
});

test("in use: the same brain as now, however it got there", () => {
	expect(
		isActive(base, {
			kind: "agent",
			where: "local",
			command: ["hermes", "acp"],
		}),
	).toBe(true);
	expect(
		isActive(base, { kind: "agent", where: "local", command: ["codex-acp"] }),
	).toBe(false);
	expect(isActive(base, { kind: "chatgpt", name: "gpt-6-luna" })).toBe(false);
});

test("a command line splits into words like a shell, without its tricks", () => {
	expect(splitCommand("  hermes   acp ")).toEqual(["hermes", "acp"]);
	expect(splitCommand('"C:\\Program Files\\Agent\\agent.exe" --acp')).toEqual([
		"C:\\Program Files\\Agent\\agent.exe",
		"--acp",
	]);
	expect(splitCommand("npx '@scope/pkg' $HOME ~ *")).toEqual([
		"npx",
		"@scope/pkg",
		"$HOME",
		"~",
		"*",
	]);
	expect(splitCommand('a "" b')).toEqual(["a", "", "b"]);
	expect(splitCommand("")).toEqual([]);
	const words = ["C:\\Program Files\\Agent\\agent.exe", "--acp", "x"];
	expect(splitCommand(joinCommand(words))).toEqual(words);
});
