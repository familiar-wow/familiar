// The app's texts in English and German, one pair of files per part of the app so that parts can
// be written side by side. Each pair has the same keys, and no key is in two parts
// (i18n.test.ts checks both).
import agentDe from "../locales/agent.de.json" with { type: "json" };
import agentEn from "../locales/agent.en.json" with { type: "json" };
import brainDe from "../locales/brain.de.json" with { type: "json" };
import brainEn from "../locales/brain.en.json" with { type: "json" };
import baseDe from "../locales/de.json" with { type: "json" };
import baseEn from "../locales/en.json" with { type: "json" };
import settingsDe from "../locales/settings.de.json" with { type: "json" };
import settingsEn from "../locales/settings.en.json" with { type: "json" };
import setupDe from "../locales/setup.de.json" with { type: "json" };
import setupEn from "../locales/setup.en.json" with { type: "json" };
import type { Language } from "./types.ts";

/** The parts, for the tests: each with its English and German texts. */
export const parts = {
	base: { en: baseEn, de: baseDe },
	brain: { en: brainEn, de: brainDe },
	agent: { en: agentEn, de: agentDe },
	setup: { en: setupEn, de: setupDe },
	settings: { en: settingsEn, de: settingsDe },
};

const en = { ...baseEn, ...brainEn, ...agentEn, ...setupEn, ...settingsEn };
const de = { ...baseDe, ...brainDe, ...agentDe, ...setupDe, ...settingsDe };

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
