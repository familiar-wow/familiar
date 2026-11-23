// The settings file, until the desktop app has a settings page (FAM-6). For the player's own
// agent it holds the bridge's settings only: that brain is set up in the agent (ADR 0006). For
// the built-in agent it names the model and its provider (ADR 0008).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

/** Providers the built-in agent can ask (brain/model.ts). */
export const PROVIDERS = [
	"openai",
	"anthropic",
	"google",
	"openrouter",
	"deepseek",
	"ollama",
	"lmstudio",
	"openai-compatible",
] as const;

const Model = z
	.strictObject({
		provider: z.enum(PROVIDERS),
		/** The model's name at the provider, such as "gpt-5-mini" or "google/gemini-3-flash". */
		name: z.string().min(1),
		/** The API's address; needed for "openai-compatible", optional for the others. */
		baseUrl: z.url().optional(),
		/**
		 * The API key. Better left out: then it comes from the provider's environment variable,
		 * such as OPENAI_API_KEY. The desktop app will keep it in the system keychain (FAM-6).
		 */
		apiKey: z.string().min(1).optional(),
	})
	.refine((m) => m.provider !== "openai-compatible" || m.baseUrl, {
		message: 'The provider "openai-compatible" needs a baseUrl.',
		path: ["baseUrl"],
	});

const Settings = z.strictObject({
	brain: z
		.strictObject({
			/**
			 * Which brain answers: "agent", the player's own agent through ACP (`command`), or
			 * "model", Familiar's built-in agent with a model from a provider (`model`).
			 */
			use: z.enum(["agent", "model"]).default("agent"),
			/** The model for the built-in agent. */
			model: Model.optional(),
			/** Starts an agent that speaks ACP on stdin and stdout. */
			command: z.array(z.string().min(1)).min(1).default(["hermes", "acp"]),
			/**
			 * The answer to the agent's permission requests, each one once: deny, allow, or ask the
			 * player in game.
			 */
			permissions: z.enum(["ask", "deny", "allow"]).default("ask"),
			/** Seconds to wait for an answer. */
			timeout: z.number().positive().default(120),
			/**
			 * The agent's working folder; by default the settings folder. It must exist where the
			 * agent runs, which matters for an agent on another machine.
			 */
			cwd: z.string().min(1).optional(),
		})
		.refine((b) => b.use !== "model" || b.model, {
			message:
				'brain.use is "model", so brain.model must name a provider and a model.',
			path: ["model"],
		})
		.prefault({}),
	mcp: z
		.strictObject({
			/**
			 * The port of the `wow` server on 127.0.0.1 (ADR 0007). It is fixed so that the command
			 * for an agent on another machine can name it in `ssh -R`.
			 */
			port: z.number().int().min(1024).max(65535).default(27495),
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
