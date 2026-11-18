import { expect, test } from "bun:test";
import { Conversation, STATUS_MS } from "./conversation.ts";
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
