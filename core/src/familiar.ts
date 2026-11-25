// Starting Familiar: install or update the addon, start the game tools and the brain, and carry
// questions between the game and the brain. The command line (main.ts) and the desktop app's
// sidecar (sidecar/sidecar.ts) both start it here; they differ only in how they tell the player.
import { dirname } from "node:path";
import { AcpBrain } from "./brain/acp.ts";
import type { Brain } from "./brain/chat.ts";
import { ChatGpt, USAGE_URL } from "./brain/chatgpt.ts";
import { ModelBrain, missing } from "./brain/model.ts";
import { Conversation } from "./conversation.ts";
import { echoBrain } from "./echo.ts";
import { Game } from "./game.ts";
import type { Log } from "./log.ts";
import { type McpServer, serveMcp } from "./mcp/server.ts";
import { wowTools } from "./mcp/tools.ts";
import type { Settings } from "./settings.ts";
import { names, type SecretStore } from "./sidecar/secrets.ts";
import { sshCommand } from "./sidecar/ssh.ts";
import { Transport } from "./transport/transport.ts";
import { clientProcesses, clientVersion, type WowPaths } from "./wow/client.ts";
import { type InstallResult, install, isInstalled } from "./wow/install.ts";

/** Seconds the window waits for an answer beyond the brain's timeout. */
const PATIENCE_S = 30;

/** What the player should read: on the console, or in the desktop app. */
export interface Notes {
	info(text: string): void;
	warn(text: string): void;
}

export interface StartOptions {
	paths: WowPaths;
	settings: Settings;
	settingsFile: string;
	log: Log;
	logFile: string;
	version: string;
	notes: Notes;
	/** Answer with an echo instead of the brain, to test the transport. */
	echo?: boolean;
	/** The system keychain, for API keys and SSH passwords; without one, keys come from the environment. */
	secrets?: SecretStore;
	/** The program `ssh` runs to ask for a password: this one, in its askpass role. */
	askpass?: string;
}

export interface Running {
	install: InstallResult;
	/** Whether the addon was installed for the first time. */
	fresh: boolean;
	stop(): void;
}

/** A short description of the brain, for logs and the app's overview. */
export function describeBrain(
	settings: Settings,
	echo = false,
): Record<string, unknown> {
	if (echo) return { kind: "echo" };
	const { use, model, ssh, command } = settings.brain;
	if (use === "model" && model)
		return { kind: "model", provider: model.provider, model: model.name };
	if (ssh) return { kind: "ssh", host: ssh.host, command: ssh.command };
	return { kind: "agent", command };
}

/**
 * The brain's settings as they run: the API key from the keychain when neither the settings nor
 * the environment have one, and the `ssh` command for an agent on another computer. Nothing of
 * this is written back to the settings file.
 */
export async function prepareBrain(
	settings: Settings,
	o: { secrets?: SecretStore; askpass?: string },
): Promise<{ brain: Settings["brain"]; env?: Record<string, string> }> {
	const brain = structuredClone(settings.brain);
	if (
		brain.use === "model" &&
		brain.model &&
		missing(brain.model) &&
		o.secrets
	) {
		const key = await o.secrets
			.get(names.apiKey(brain.model.provider))
			.catch(() => null);
		if (key) brain.model.apiKey = key;
	}
	if (brain.use === "agent" && brain.ssh) {
		const built = sshCommand(
			{
				host: brain.ssh.host,
				user: brain.ssh.user,
				identityFile: brain.ssh.identityFile,
				auth: brain.ssh.auth,
				command: brain.ssh.command,
				cwd: brain.cwd,
				port: settings.mcp.port,
			},
			{ askpass: [o.askpass ?? process.execPath] },
		);
		brain.command = built.command;
		return { brain, env: built.env };
	}
	return { brain };
}

export async function startFamiliar(o: StartOptions): Promise<Running> {
	const { paths, settings, settingsFile, log, notes, version } = o;
	const { interface: iface, version: build } = clientVersion(paths.client);
	const running = (await clientProcesses()).length > 0;
	const fresh = !isInstalled(paths);
	const result = install(paths, iface, version);
	log.event("start", {
		version,
		platform: process.platform,
		client: paths.client,
		interface: iface,
		build,
		install: result,
		brain: describeBrain(settings, o.echo),
	});
	notes.info(`familiar ${version}`);
	notes.info(
		`Client: ${paths.client} (interface ${iface}${build ? `, ${build}` : ""})`,
	);
	notes.info(`Log:    ${o.logFile}`);

	const prepared = await prepareBrain(settings, o);
	const { command, permissions, cwd, use, model, ssh } = prepared.brain;
	if (o.echo) notes.info("Brain:  an echo, to test the transport");
	else if (use === "model" && model) {
		notes.info(
			`Brain:  Familiar's built-in agent with ${model.name} from ${model.provider}, set in ${settingsFile}`,
		);
		const problem = missing(model);
		if (problem) notes.warn(problem);
		if (model.provider === "chatgpt") {
			const account = new ChatGpt({ folder: dirname(settingsFile) }).account();
			if (account)
				notes.info(
					`        Using ChatGPT plan (${account}). Manage usage: ${USAGE_URL}`,
				);
			else
				notes.warn(
					"Not signed in to ChatGPT. Sign in (in the app, or with `familiar login chatgpt`), then start Familiar again.",
				);
		}
	} else {
		notes.info(
			ssh
				? `Brain:  ${ssh.command.join(" ")} on ${ssh.host} (permission requests: ${permissions}), set in ${settingsFile}`
				: `Brain:  ${command.join(" ")} (permission requests: ${permissions}), set in ${settingsFile}`,
		);
		notes.info(`        sessions open in ${cwd ?? dirname(settingsFile)}`);
		if (!Bun.which(command[0] ?? ""))
			notes.warn(
				`${command[0]} was not found. Install it, or change brain.command in the settings.`,
			);
	}

	// The game's state as tools for the agent (ADR 0007). The echo has no use for them, and the
	// built-in agent calls them in this process (ADR 0008).
	const game = new Game();
	let wow: McpServer | undefined;
	if (!o.echo && use === "agent") {
		const { port } = settings.mcp;
		try {
			wow = serveMcp({ port, tools: wowTools(game), version, log });
			notes.info(`Tools:  ${wow.url}, handed to the agent with each session`);
		} catch (error) {
			const taken = (error as { code?: string }).code === "EADDRINUSE";
			log.event("mcp-error", { port, error: String(error) });
			notes.warn(
				taken
					? `Port ${port} is in use, so the agent gets no game tools. If another Familiar is running, close it: two of them both answer the game. Otherwise set mcp.port in ${settingsFile}.`
					: `The game tools could not start on port ${port}, so the agent gets none: ${error instanceof Error ? error.message : error}`,
			);
		}
	}
	if (fresh) notes.info("Addon installed.");
	else if (result.added + result.updated > 0) notes.info("Addon updated.");
	if (running && result.added > 0)
		notes.warn(
			"WoW is running and new files were added. Quit WoW completely and start it again; /reload does not find new files.",
		);
	else if (running && result.updated > 0)
		notes.info("WoW is running: type /reload in game.");

	// Starts nothing until the first question.
	const brain: Brain & { stop?: () => void } =
		use === "model"
			? new ModelBrain(prepared.brain, {
					log,
					tools: wowTools(game),
					chatgpt: new ChatGpt({ folder: dirname(settingsFile) }),
				})
			: new AcpBrain(prepared.brain, {
					folder: dirname(settingsFile),
					log,
					version,
					wow,
					env: prepared.env,
				});
	const transport = new Transport({
		paths,
		log,
		// The brain answers every question within its timeout, if only to say that there is no
		// answer. PATIENCE_S on top covers starting the agent and the way back; after that the
		// window stops waiting (addon/Familiar/Chat.lua).
		welcome: `Familiar app ${version}\npatience: ${Math.ceil(settings.brain.timeout) + PATIENCE_S}`,
	});
	const conversation = new Conversation(
		o.echo ? echoBrain : brain,
		(body) => transport.send(body),
		log,
		game,
	);
	transport.onMessage((body, info) => conversation.receive(body, info));
	await transport.start();
	return {
		install: result,
		fresh,
		stop() {
			transport.stop();
			brain.stop?.();
			wow?.stop();
		},
	};
}
