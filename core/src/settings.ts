// The settings file, shared by the command line and the desktop app (FAM-6), which edits it
// through the sidecar. For the player's own agent it holds the bridge's settings only: that brain
// is set up in the agent (ADR 0006). For the built-in agent it names the model and its provider
// (ADR 0008); the key belongs in the system keychain, not here.
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * A server's address: http or https only, and no user or password in it, since the settings
 * file is plain text and the app shows it.
 */
const ServerUrl = z.url().refine(
	(value) => {
		const url = new URL(value);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			!url.username &&
			!url.password
		);
	},
	{
		message:
			"A server address must start with http:// or https:// and hold no user or password.",
	},
);

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
	"chatgpt",
] as const;

/** A provider the built-in agent can ask. */
export type Provider = (typeof PROVIDERS)[number];

const Model = z
	.strictObject({
		provider: z.enum(PROVIDERS),
		/**
		 * The model's name at the provider, such as "gpt-5-mini" or "google/gemini-3-flash". For
		 * "chatgpt", one that `familiar login chatgpt` lists.
		 */
		name: z.string().min(1),
		/** The API's address; needed for "openai-compatible", optional for the others. */
		baseUrl: ServerUrl.optional(),
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

/**
 * The player's own agent on another computer, reached through `ssh` (sidecar/ssh.ts). When set,
 * it replaces `brain.command`. Passwords and passphrases are in the system keychain.
 */
const Ssh = z.strictObject({
	/** A name, an address or a Host from ~/.ssh/config. */
	host: z.string().min(1),
	/** Override the user; by default ~/.ssh/config or the local user name decides. */
	user: z.string().min(1).optional(),
	/** Override the key file; by default ~/.ssh/config or ssh's defaults decide. */
	identityFile: z.string().min(1).optional(),
	auth: z.enum(["key", "passphrase", "password"]).default("key"),
	/** The agent's ACP command on that computer, ideally with its full path. */
	command: z.array(z.string().min(1)).min(1),
});

/**
 * What each kind of brain on the app's Brain page held last, so that switching to another kind
 * and back keeps the choice. The brain that answers is in `brain`; this is only remembered.
 */
const Remembered = z.strictObject({
	chatgpt: z.strictObject({ name: z.string().min(1) }).optional(),
	key: z
		.strictObject({
			provider: z.enum([
				"openai",
				"anthropic",
				"google",
				"openrouter",
				"deepseek",
			]),
			name: z.string().min(1),
			/** A provider's own address, such as a proxy, set by hand. */
			baseUrl: ServerUrl.optional(),
		})
		.optional(),
	local: z
		.strictObject({
			provider: z.enum(["ollama", "lmstudio", "openai-compatible"]),
			name: z.string().min(1),
			baseUrl: ServerUrl.optional(),
		})
		.optional(),
	agent: z
		.strictObject({
			command: z.array(z.string().min(1)).min(1),
			cwd: z.string().min(1).optional(),
		})
		.optional(),
	/** The working folder there is a folder on that computer, so it is kept apart. */
	ssh: Ssh.extend({ cwd: z.string().min(1).optional() }).optional(),
});

const Settings = z.strictObject({
	/** The WoW Forever client folder the player chose; found automatically when left out. */
	game: z.strictObject({ client: z.string().min(1).optional() }).prefault({}),
	/** How the desktop app behaves; the command line ignores this. */
	app: z
		.strictObject({
			/** What the window's close button does. */
			close: z.enum(["tray", "quit"]).default("tray"),
			/** Start with Windows, in the tray. */
			autostart: z.boolean().default(false),
			language: z.enum(["system", "en", "de"]).default("system"),
			/**
			 * The setup assistant ran, or the player skipped it; false while it runs. Unset for
			 * settings from before the app: those players set Familiar up already.
			 */
			setupDone: z.boolean().optional(),
			brains: Remembered.prefault({}),
		})
		.prefault({}),
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
			/** The agent on another computer; replaces `command` when set. */
			ssh: Ssh.optional(),
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

/** Checks settings from the app or a file; throws an error that names no values. */
export function parseSettings(json: unknown, where = "The settings"): Settings {
	const result = Settings.safeParse(json);
	if (!result.success) throw new Error(`${where}:\n${problems(result.error)}`);
	return result.data;
}

/**
 * Writes the settings: to a new file next to the old one, then renamed over it, so a crash
 * never leaves half a file. The new file is no more open than the old one, and only its owner
 * may read it while it holds an API key.
 */
export function saveSettings(file: string, settings: Settings): void {
	const clean = parseSettings(settings);
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	let mode = 0o644;
	try {
		mode = statSync(file).mode & 0o777;
	} catch {
		// A new file.
	}
	if (clean.brain.model?.apiKey) mode &= 0o700;
	try {
		writeFileSync(tmp, `${JSON.stringify(clean, null, "\t")}\n`, { mode });
		// The umask may have taken away less than we want gone.
		if (process.platform !== "win32") chmodSync(tmp, mode);
		renameSync(tmp, file);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}

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
		// A new player: the desktop app's setup assistant runs once. A file from before the app
		// has no setupDone at all, and its player is not sent through the assistant.
		const defaults = Settings.parse({ app: { setupDone: false } });
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(defaults, null, "\t")}\n`);
		return defaults;
	}
	let json: unknown;
	try {
		json = JSON.parse(readFileSync(file, "utf8"));
	} catch {
		// The parser's message quotes the text around the mistake, which may be an API key.
		throw new Error(
			`${file} is not valid JSON. Check the quotes, commas and brackets near the last change.`,
		);
	}
	return parseSettings(json, file);
}

/**
 * What is wrong in the settings, one line each. Zod's messages quote no values, except the
 * name of an unknown setting, which could be an API key in the wrong place, so that one is
 * left out.
 */
function problems(error: z.ZodError): string {
	return error.issues
		.map((issue) => {
			const at = issue.path.join(".") || "the settings";
			return issue.code === "unrecognized_keys"
				? `✖ ${at}: has ${issue.keys.length === 1 ? "a setting" : `${issue.keys.length} settings`} Familiar does not know (not shown here, in case it is a key)`
				: `✖ ${at}: ${issue.message}`;
		})
		.join("\n");
}
