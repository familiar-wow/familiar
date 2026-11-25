// familiar: the companion for development builds, until the desktop app exists (FAM-6). It
// installs the addon and carries questions from the game to a brain and the answers back.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { ChatGpt, ChatGptError, USAGE_URL } from "./brain/chatgpt.ts";
import { startFamiliar } from "./familiar.ts";
import { fileLog } from "./log.ts";
import { loadSettings, type Settings, settingsFolder } from "./settings.ts";
import { keychain } from "./sidecar/secrets.ts";
import { serveSidecar } from "./sidecar/sidecar.ts";
import { askpassMain } from "./sidecar/ssh.ts";
import {
	addonsFiles,
	clientProcesses,
	clientVersion,
	findClients,
	isClientFolder,
	type WowPaths,
	wowPaths,
} from "./wow/client.ts";
import { isInstalled, uninstall } from "./wow/install.ts";

const VERSION = pkg.version;

const USAGE = `familiar ${VERSION}: the Familiar app for development builds

  familiar              install or update the addon, then answer questions until Ctrl+C
  familiar check        show which client it found, without changing anything
  familiar uninstall    remove the addon and its helpers (close WoW first)
  familiar sidecar      for the desktop app: commands and events as JSON lines on stdin/stdout
  familiar login chatgpt    sign in with ChatGPT, so your ChatGPT plan answers
  familiar logout chatgpt   sign out of ChatGPT; --forget also forgets the account,
                            so that another ChatGPT account can sign in

Options:
  --wow <folder>       the _forever_ client folder, if it is not found automatically
  --logs <folder>      where the log goes (default: familiar-logs in the current folder)
  --settings <file>    the settings file (default: settings.json in ${settingsFolder()})
  --echo               answer with an echo instead of the brain, to test the transport`;

const NOT_FOUND = `WoW: Forever was not found. Pass the client folder, for example:
  familiar --wow ${
		process.platform === "win32"
			? '"C:\\Program Files (x86)\\World of Warcraft\\_forever_"'
			: '"$HOME/Games/battlenet/drive_c/Program Files (x86)/World of Warcraft/_forever_"'
	}`;

function exitWith(message: string, code = 1): never {
	console.error(message);
	// A double-clicked console window would close before anyone could read the message.
	if (process.platform === "win32" && process.stdin.isTTY)
		prompt("Press Enter to close.");
	process.exit(code);
}

async function resolveClient(option?: string): Promise<WowPaths> {
	// The shell does not expand ~ inside quotes.
	const client = option
		? resolve(option.replace(/^~(?=$|[\\/])/, homedir()))
		: (await findClients())[0];
	if (!client) exitWith(NOT_FOUND);
	if (!isClientFolder(client))
		exitWith(`${client} does not look like a WoW client folder.`);
	return wowPaths(client);
}

const stamp = () =>
	new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");

interface RunOptions {
	logs: string;
	settingsFile: string;
	settings: Settings;
	echo: boolean;
}

async function run(paths: WowPaths, options: RunOptions): Promise<void> {
	const { logs, settingsFile, settings } = options;
	mkdirSync(logs, { recursive: true });
	const logFile = join(logs, `familiar-${stamp()}.jsonl`);
	const familiar = await startFamiliar({
		paths,
		settings,
		settingsFile,
		log: fileLog(logFile),
		logFile,
		version: VERSION,
		echo: options.echo,
		secrets: keychain(),
		notes: {
			info: (text) => console.log(text),
			warn: (text) => console.log(`\n!! ${text}\n`),
		},
	});
	console.log("\nReady. In game, /familiar opens the window. Ctrl+C stops.\n");
	const stop = () => {
		familiar.stop();
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	process.on("SIGHUP", stop);
}

async function check(paths: WowPaths): Promise<void> {
	const { interface: iface, version } = clientVersion(paths.client);
	const pids = await clientProcesses();
	const rows: [string, string][] = [
		["Client", paths.client],
		[
			"Version",
			version
				? `${version} (interface ${iface})`
				: `unknown, assuming interface ${iface}`,
		],
		["Addon", isInstalled(paths) ? "installed" : "not installed"],
		["Characters", String(addonsFiles(paths.accounts).length)],
		["WoW running", pids.length > 0 ? `yes (pid ${pids.join(", ")})` : "no"],
	];
	for (const [label, value] of rows)
		console.log(`${`${label}:`.padEnd(13)}${value}`);
}

/** Opens `url` in the default browser; the address is printed too, in case that fails. */
function openBrowser(url: string): void {
	const command =
		process.platform === "win32"
			? ["rundll32", "url.dll,FileProtocolHandler", url]
			: process.platform === "darwin"
				? ["open", url]
				: ["xdg-open", url];
	try {
		Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
	} catch {
		// The printed address is enough.
	}
}

async function login(folder: string): Promise<void> {
	mkdirSync(folder, { recursive: true });
	const chatgpt = new ChatGpt({ folder });
	try {
		const account = await chatgpt.signIn((url) => {
			console.log(
				`Continue with ChatGPT in your browser. If it does not open, copy this address into it:\n\n${url}\n\nWaiting for the browser …`,
			);
			openBrowser(url);
		});
		console.log(
			`\nSigned in as ${account}.\n\nYou're using your ChatGPT plan: Familiar's answers count toward your plan's usage. Manage usage and Familiar's limit: ${USAGE_URL}\n`,
		);
		const models = await chatgpt.models();
		if (models.length) {
			console.log("Models your plan offers (name to use in the settings):");
			for (const m of models) console.log(`  ${m.slug.padEnd(28)} ${m.name}`);
			const pick = models[0]?.slug ?? "<model>";
			console.log(
				`\nIn settings.json:\n  "brain": { "use": "model", "model": { "provider": "chatgpt", "name": "${pick}" } }`,
			);
		}
	} catch (error) {
		exitWith(
			error instanceof ChatGptError
				? error.message
				: `Sign-in failed: ${error instanceof Error ? error.name : "unknown error"}.`,
		);
	}
}

async function logout(folder: string, forget: boolean): Promise<void> {
	const { revoked } = await new ChatGpt({ folder }).signOut({ forget });
	console.log(
		revoked
			? "Signed out of ChatGPT."
			: "Signed out here, but ChatGPT did not confirm it. To be sure, disconnect Familiar in ChatGPT's settings.",
	);
}

async function main(): Promise<void> {
	// `ssh` starts this program to ask for a password (sidecar/ssh.ts): it prints the secret from
	// the keychain that FAMILIAR_ASKPASS names and does nothing else. Its argument is ssh's prompt.
	if (process.env.FAMILIAR_ASKPASS && process.env.SSH_ASKPASS_REQUIRE)
		process.exit(
			await askpassMain(Bun.argv.slice(2), {
				store: keychain(),
				env: process.env,
			}),
		);
	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			wow: { type: "string" },
			logs: { type: "string" },
			settings: { type: "string" },
			echo: { type: "boolean" },
			forget: { type: "boolean" },
			help: { type: "boolean", short: "h" },
			version: { type: "boolean" },
		},
		allowPositionals: true,
	});
	if (values.help) return void console.log(USAGE);
	if (values.version) return void console.log(VERSION);
	const command = positionals[0] ?? "run";
	const settingsFile = resolve(
		values.settings ?? join(settingsFolder(), "settings.json"),
	);
	// The client the player chose in the app, unless --wow names another: the same for every
	// command, so `check` and `uninstall` look at the client Familiar runs with.
	const chosen = (): string | undefined => {
		if (values.wow) return values.wow;
		try {
			return loadSettings(settingsFile).game.client;
		} catch {
			return undefined;
		}
	};
	if (command === "check") return check(await resolveClient(chosen()));
	if (command === "uninstall") {
		const paths = await resolveClient(chosen());
		if ((await clientProcesses()).length > 0)
			exitWith("Close WoW first, so it does not write the helpers' rows back.");
		const removed = uninstall(paths);
		return void console.log(
			`Removed ${removed.folders} addon folders and ${removed.rows} AddOns.txt rows.`,
		);
	}
	if (command === "login" || command === "logout") {
		if (positionals[1] !== "chatgpt") exitWith(USAGE);
		const folder = dirname(
			resolve(values.settings ?? join(settingsFolder(), "settings.json")),
		);
		return command === "login"
			? login(folder)
			: logout(folder, values.forget ?? false);
	}
	if (command === "sidecar")
		return serveSidecar({
			settingsFile,
			logs: resolve(values.logs ?? join(dirname(settingsFile), "logs")),
			version: VERSION,
			askpass: process.execPath,
		});
	if (command !== "run") exitWith(USAGE);
	let settings: Settings;
	try {
		settings = loadSettings(settingsFile);
	} catch (error) {
		exitWith(error instanceof Error ? error.message : String(error));
	}
	await run(await resolveClient(chosen()), {
		logs: resolve(values.logs ?? "familiar-logs"),
		settingsFile,
		settings,
		echo: values.echo ?? false,
	});
}

// No `if (import.meta.main)`: in a Windows build made with Bun.build, the entry point is named
// without .exe, so the check fails and the app quits without a word (FAM-22).
main().catch((error) =>
	exitWith(
		String(error instanceof Error ? (error.stack ?? error.message) : error),
	),
);
