import { expect, test } from "bun:test";
import { clock, recentQuestions, toolChips } from "./questions.ts";

const q = (at: number, text: string) => ({
	at,
	event: "question",
	text,
	character: { name: "Moonbreeze" },
});
const a = (at: number, ms: number, tools: string[] = []) => ({
	at,
	event: "answered",
	ms,
	bytes: 10,
	tools,
});

test("an answer closes its question, newest first", () => {
	const lines = [
		q(1, "Which flight paths do I know?"),
		{ at: 2, event: "say", text: "Question: ..." },
		a(3, 3900, ["flightpaths"]),
		q(4, "What do the Magram give me?"),
		a(5, 6200, ["lookup", "lookup", "lookup"]),
	];
	expect(recentQuestions(lines)).toEqual([
		{
			at: 4,
			text: "What do the Magram give me?",
			ms: 6200,
			tools: ["lookup", "lookup", "lookup"],
		},
		{
			at: 1,
			text: "Which flight paths do I know?",
			ms: 3900,
			tools: ["flightpaths"],
		},
	]);
});

test("a question without an answer yet stays open", () => {
	expect(recentQuestions([q(1, "Where is Bear Form?")])).toEqual([
		{ at: 1, text: "Where is Bear Form?", tools: [] },
	]);
});

test("an answer whose question was cut from the log has no text", () => {
	expect(recentQuestions([a(7, 2100, ["quests"]), q(8, "Next?")])).toEqual([
		{ at: 8, text: "Next?", tools: [] },
		{ at: 7, ms: 2100, tools: ["quests"] },
	]);
});

test("an answer closes the newest open question; an unanswered one stays open", () => {
	const rows = recentQuestions([q(1, "lost"), q(2, "second"), a(3, 1000)]);
	expect(rows).toEqual([
		{ at: 2, text: "second", ms: 1000, tools: [] },
		{ at: 1, text: "lost", tools: [] },
	]);
});

test("at most 8 by default, and as many as asked", () => {
	const lines = Array.from({ length: 12 }, (_, i) => [
		q(i * 10, `#${i}`),
		a(i * 10 + 1, 100),
	]).flat();
	const rows = recentQuestions(lines);
	expect(rows).toHaveLength(8);
	expect(rows[0]?.text).toBe("#11");
	expect(recentQuestions(lines, 3).map((r) => r.text)).toEqual([
		"#11",
		"#10",
		"#9",
	]);
});

test("the text stays exactly as the game sent it", () => {
	const text = "Is <b>Thunderfury</b> & co. worth it?";
	expect(recentQuestions([q(1, text)])[0]?.text).toBe(text);
});

test("repeated tools collapse into one chip, in the order first used", () => {
	expect(toolChips(["lookup", "quests", "lookup", "lookup"])).toEqual([
		"lookup ×3",
		"quests",
	]);
	expect(toolChips([])).toEqual([]);
});

test("local time as HH:MM", () => {
	expect(clock(new Date(2026, 10, 25, 9, 5).getTime())).toBe("09:05");
	expect(clock(new Date(2026, 10, 25, 23, 41).getTime())).toBe("23:41");
});
