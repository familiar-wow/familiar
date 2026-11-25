import { expect, test } from "bun:test";
import { Conversation, plain, STATUS_MS } from "./conversation.ts";
import { Game } from "./game.ts";
import type { Log } from "./log.ts";

const log: Log = { event: () => {}, say: () => {} };
const encode = (text: string) => new TextEncoder().encode(text);

test(
	"sends one status line per interval and the latest tool after it, never after the answer",
	async () => {
		const sent: string[] = [];
		let finish = () => {};
		const conversation = new Conversation(
			{
				ask: async (_, turn) => {
					turn.onTool("web_search: one");
					turn.onTool("web_search: two");
					turn.onTool("web_extract: three");
					await new Promise<void>((resolve) => (finish = resolve));
					return "done";
				},
			},
			(body) => void sent.push(new TextDecoder().decode(body)),
			log,
			new Game(),
		);
		conversation.receive(encode("question\nname: Hero\n\nwhat now?"));
		await Bun.sleep(10);
		// Each status line costs a font and a doorbell (ADR 0005).
		expect(sent).toEqual(["status\nweb_search: one"]);
		finish();
		await Bun.sleep(10);
		expect(sent).toEqual(["status\nweb_search: one", "answer\ndone"]);
		await Bun.sleep(STATUS_MS);
		expect(sent).toHaveLength(2);
	},
	STATUS_MS + 1000,
);

test("sends a note at once", async () => {
	const sent: string[] = [];
	const conversation = new Conversation(
		{
			ask: async (_, turn) => {
				turn.onTool("terminal: rm -rf ~");
				turn.onNote("Denied: rm -rf ~");
				return "done";
			},
		},
		(body) => void sent.push(new TextDecoder().decode(body)),
		log,
		new Game(),
	);
	conversation.receive(encode("question\n\nclean up"));
	await Bun.sleep(10);
	// Unlike a status line, a note is never held back or dropped.
	expect(sent).toEqual([
		"status\nterminal: rm -rf ~",
		"note\nDenied: rm -rf ~",
		"answer\ndone",
	]);
});

test("hands a permission request to the player and the answer back to the brain", async () => {
	const sent: string[] = [];
	const conversation = new Conversation(
		{
			ask: async (_, turn) =>
				(await turn.onPermission("rm -rf ~")) ? "allowed" : "denied",
		},
		(body) => void sent.push(new TextDecoder().decode(body)),
		log,
		new Game(),
	);
	conversation.receive(encode("question\n\nclean up"));
	await Bun.sleep(10);
	expect(sent).toEqual(["permission\n1\nrm -rf ~"]);
	conversation.receive(encode("permission\n1\ndeny"));
	await Bun.sleep(10);
	expect(sent.at(-1)).toBe("answer\ndenied");
});

test("notes the character of each question for the game tools", async () => {
	const game = new Game();
	const conversation = new Conversation(
		{ ask: async () => "done" },
		() => {},
		log,
		game,
	);
	expect(game.character).toBeUndefined();
	conversation.receive(
		encode("question\nname: Hero\nrealm: Realm\nlevel: 30\n\nwhat now?"),
	);
	await Bun.sleep(10);
	expect(game.character?.character).toEqual({
		name: "Hero",
		realm: "Realm",
		level: "30",
	});
	conversation.receive(encode("question\nname: Alt\n\nand now?"));
	await Bun.sleep(10);
	expect(game.character?.character).toEqual({ name: "Alt" });
});

test("numbers each question, so overlapping answers find their own question", async () => {
	const events: Record<string, unknown>[] = [];
	const record: Log = {
		event: (name, data = {}) => void events.push({ event: name, ...data }),
		say: () => {},
	};
	const release: Record<string, () => void> = {};
	let up = true;
	const conversation = new Conversation(
		{
			ask: (question) =>
				new Promise((resolve) => {
					release[question.text] = () => resolve(`re: ${question.text}`);
				}),
		},
		() => {
			if (!up) throw new Error("the game is gone");
		},
		record,
		new Game(),
	);
	conversation.receive(encode("question\n\nfirst"));
	conversation.receive(encode("question\n\nsecond"));
	await Bun.sleep(5);
	release.first?.();
	await Bun.sleep(5);
	up = false;
	release.second?.();
	await Bun.sleep(5);
	const shown = events.map(({ event, n, text }) => ({ event, n, text }));
	expect(shown).toEqual([
		{ event: "question", n: 1, text: "first" },
		{ event: "question", n: 2, text: "second" },
		{ event: "answered", n: 1, text: undefined },
		{ event: "undelivered", n: 2, text: undefined },
	]);
});

test("strips the Markdown models write anyway, and keeps game links", () => {
	expect(
		plain(
			"## Gear\nYou wield **[item:13262]**, see __this__ and `/cast Charge`.\n2 * 3 = 6, a_b_c",
		),
	).toBe(
		"Gear\nYou wield [item:13262], see this and /cast Charge.\n2 * 3 = 6, a_b_c",
	);
});

test("keeps what stands inside code as it is", () => {
	expect(plain("Use `__name__` and `**kwargs`, then **go**.")).toBe(
		"Use __name__ and **kwargs, then go.",
	);
	expect(plain("**Use `foo` here**")).toBe("Use foo here");
	expect(plain("``a`__b__`c``")).toBe("a`__b__`c");
	expect(plain("A\uE0000\uE000B and `foo`")).toBe("A0B and foo");
});
