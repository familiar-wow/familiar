// The app's texts in English and German. Both files have the same keys (i18n.test.ts checks).
import de from "../locales/de.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };
import type { Language } from "./types.ts";

export type Key = keyof typeof en;
export type Translate = (
	key: Key,
	vars?: Record<string, string | number>,
) => string;

export const locales: Record<Language, Record<Key, string>> = { en, de };

/** `app.language` from the settings: "system" follows the system's language. */
export function resolveLanguage(
	setting: unknown,
	systemLanguage: string | undefined,
): Language {
	if (setting === "en" || setting === "de") return setting;
	return systemLanguage?.toLowerCase().startsWith("de") ? "de" : "en";
}

export function translator(language: Language): Translate {
	const texts = locales[language];
	return (key, vars) =>
		texts[key].replace(/\{(\w+)\}/g, (all, name: string) =>
			vars && name in vars ? String(vars[name]) : all,
		);
}

/** Seconds with one decimal, as the language writes them: "24.1 s", "24,1 s". */
export function seconds(ms: number, language: Language): string {
	const n = new Intl.NumberFormat(language === "de" ? "de-DE" : "en-US", {
		minimumFractionDigits: 1,
		maximumFractionDigits: 1,
	}).format(ms / 1000);
	return `${n} s`;
}
