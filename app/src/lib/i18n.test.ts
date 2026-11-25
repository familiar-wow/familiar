import { expect, test } from "bun:test";
import de from "../locales/de.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };
import { resolveLanguage, seconds, translator } from "./i18n.ts";

const placeholders = (text: string) =>
	[...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("English and German have the same keys", () => {
	expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort());
});

test("each German text has the same placeholders as the English one", () => {
	const german = de as Record<string, string>;
	for (const [key, text] of Object.entries(en)) {
		expect(german[key]).toBeString();
		expect(placeholders(german[key] ?? "")).toEqual(placeholders(text));
	}
});

test("no text is empty", () => {
	for (const text of [...Object.values(en), ...Object.values(de)])
		expect(text.trim()).not.toBe("");
});

test("app.language: a fixed choice, or the system's language", () => {
	expect(resolveLanguage("de", "en-US")).toBe("de");
	expect(resolveLanguage("en", "de-DE")).toBe("en");
	expect(resolveLanguage("system", "de-AT")).toBe("de");
	expect(resolveLanguage("system", "DE")).toBe("de");
	expect(resolveLanguage("system", "fr-FR")).toBe("en");
	expect(resolveLanguage(undefined, undefined)).toBe("en");
});

test("fills in placeholders and leaves unknown ones", () => {
	const t = translator("en");
	expect(t("heading.evening", { name: "Moonbreeze" })).toBe(
		"Good evening, Moonbreeze",
	);
	expect(t("heading.evening")).toBe("Good evening, {name}");
});

test("seconds with one decimal in each language", () => {
	expect(seconds(24_100, "en")).toBe("24.1 s");
	expect(seconds(24_100, "de")).toBe("24,1 s");
	expect(seconds(3000, "en")).toBe("3.0 s");
});
