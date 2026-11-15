import { expect, test } from "bun:test";
import { clip, parseQuestion } from "./chat.ts";

test("clip cuts between the bytes of a character and marks the cut", () => {
	const cut = clip("€".repeat(700), 1968);
	expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(1968);
	expect(cut).not.toContain("\uFFFD");
	expect(cut).toEndWith("€ …");
	expect(clip("short", 1968)).toBe("short");
});

test("a question without a header is all text", () => {
	expect(parseQuestion("hello\n")).toEqual({ text: "hello", character: {} });
});
