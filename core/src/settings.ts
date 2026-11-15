// The settings file, until the desktop app has a settings page (FAM-6).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const Settings = z.object({
	brain: z
		.object({
			/** How the player sees the brain in messages. */
			name: z.string().min(1).default("Hermes"),
			/** Starts an agent that speaks ACP on stdin and stdout. */
			command: z
				.array(z.string().min(1))
				.min(1)
				.default(["hermes", "--profile", "familiar", "acp"]),
			/** Seconds to wait for an answer. */
			timeout: z.number().positive().default(120),
			/**
			 * The agent's working folder; by default the settings folder. It must exist where the
			 * agent runs, which matters for an agent on another machine.
			 */
			cwd: z.string().min(1).optional(),
		})
		.prefault({}),
});
export type Settings = z.infer<typeof Settings>;

/** Where the settings live: the usual folder for app settings on each system. */
export function settingsFolder(): string {
	if (process.platform === "win32")
		return join(
			process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"),
			"Familiar",
		);
	if (process.platform === "darwin")
		return join(homedir(), "Library", "Application Support", "Familiar");
	return join(
		process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
		"familiar",
	);
}

/** Reads the settings. A missing file is written with the defaults, so there is one to edit. */
export function loadSettings(file: string): Settings {
	if (!existsSync(file)) {
		const defaults = Settings.parse({});
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(defaults, null, "\t")}\n`);
		return defaults;
	}
	let json: unknown;
	try {
		json = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(
			`${file} is not valid JSON: ${error instanceof Error ? error.message : error}`,
		);
	}
	const result = Settings.safeParse(json);
	if (!result.success)
		throw new Error(`${file}:\n${z.prettifyError(result.error)}`);
	return result.data;
}
