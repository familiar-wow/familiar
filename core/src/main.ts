// familiar: the companion for development builds, until the desktop app exists (FAM-6). It
// installs the addon and carries questions from the game to a brain and the answers back.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { AcpBrain } from "./brain/acp.ts";
import { clip, parseQuestion, type Question } from "./brain/chat.ts";
import { echo } from "./echo.ts";
import { fileLog } from "./log.ts";
import { loadSettings, type Settings, settingsFolder } from "./settings.ts";
import { DOWN_PAYLOAD } from "./transport/codec.ts";
import { Transport } from "./transport/transport.ts";
import {
	addonsFiles,
	clientProcesses,
	clientVersion,
	findClients,
	isClientFolder,
	type WowPaths,
	wowPaths,
} from "./wow/client.ts";
import { install, isInstalled, uninstall } from "./wow/install.ts";

const VERSION = pkg.version;
/** An answer may take four fonts of the bank. */
const MAX_ANSWER = 4 * DOWN_PAYLOAD;

const USAGE = `familiar ${VERSION}: the Familiar app for development builds

  familiar              install or update the addon, then answer questions until Ctrl+C
  familiar check        show which client it found, without changing anything
  familiar uninstall    remove the addon and its helpers (close WoW first)

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
	const { interface: iface, version: build } = clientVersion(paths.client);
	const running = (await clientProcesses()).length > 0;
	const fresh = !isInstalled(paths);
	const result = install(paths, iface, VERSION);
	mkdirSync(logs, { recursive: true });
	const logFile = join(logs, `familiar-${stamp()}.jsonl`);
	const log = fileLog(logFile);
	log.event("start", {
		version: VERSION,
		platform: process.platform,
		client: paths.client,
		interface: iface,
		build,
		install: result,
		brain: options.echo ? "echo" : settings.brain.command,
	});
	console.log(`familiar ${VERSION}`);
	console.log(
		`Client: ${paths.client} (interface ${iface}${build ? `, ${build}` : ""})`,
	);
	console.log(`Log:    ${logFile}`);
	const { command, permissions, cwd } = settings.brain;
	if (options.echo) console.log("Brain:  an echo, to test the transport");
	else {
		console.log(
			`Brain:  ${command.join(" ")} (permission requests: ${permissions}), set in ${settingsFile}`,
		);
		console.log(`        sessions open in ${cwd ?? dirname(settingsFile)}`);
		if (!Bun.which(command[0] ?? ""))
			console.log(
				`\n!! ${command[0]} was not found. Install it, or change brain.command in the settings.\n`,
			);
	}
	if (fresh) console.log("Addon installed.");
	else if (result.added + result.updated > 0) console.log("Addon updated.");
	if (running && result.added > 0)
		console.log(
			"\n!! WoW is running and new files were added. Quit WoW completely and start it again;\n!! /reload does not find new files.\n",
		);
	else if (running && result.updated > 0)
		console.log("WoW is running: type /reload in game.");

	// Starts nothing until the first question.
	const brain = new AcpBrain(settings.brain, {
		folder: dirname(settingsFile),
		log,
		version: VERSION,
	});
	const answer = async (question: Question): Promise<string> =>
		options.echo
			? echo(question.text)
			: clip(await brain.ask(question), MAX_ANSWER);
	const transport = new Transport({
		paths,
		log,
		welcome: `Familiar app ${VERSION}`,
	});
	transport.onMessage((body, { hello }) => {
		const text = new TextDecoder().decode(body);
		if (hello) return log.say(`The addon says hello: ${text}`);
		const question = parseQuestion(text);
		log.say(`Question: ${question.text}`);
		const asked = performance.now();
		void answer(question).then((reply) => {
			const bytes = new TextEncoder().encode(reply);
			try {
				transport.send(bytes);
				const s = ((performance.now() - asked) / 1000).toFixed(1);
				log.say(`Answered after ${s} s, ${bytes.length} bytes.`);
			} catch (error) {
				log.say(
					`Could not answer: ${error instanceof Error ? error.message : error}`,
				);
			}
		});
	});
	await transport.start();
	console.log(
		"\nReady. In game, ask with /familiar say <question>. Ctrl+C stops.\n",
	);
	const stop = () => {
		transport.stop();
		brain.stop();
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

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			wow: { type: "string" },
			logs: { type: "string" },
			settings: { type: "string" },
			echo: { type: "boolean" },
			help: { type: "boolean", short: "h" },
			version: { type: "boolean" },
		},
		allowPositionals: true,
	});
	if (values.help) return void console.log(USAGE);
	if (values.version) return void console.log(VERSION);
	const command = positionals[0] ?? "run";
	if (command === "check") return check(await resolveClient(values.wow));
	if (command === "uninstall") {
		const paths = await resolveClient(values.wow);
		if ((await clientProcesses()).length > 0)
			exitWith("Close WoW first, so it does not write the helpers' rows back.");
		const removed = uninstall(paths);
		return void console.log(
			`Removed ${removed.folders} addon folders and ${removed.rows} AddOns.txt rows.`,
		);
	}
	if (command !== "run") exitWith(USAGE);
	const settingsFile = resolve(
		values.settings ?? join(settingsFolder(), "settings.json"),
	);
	let settings: Settings;
	try {
		settings = loadSettings(settingsFile);
	} catch (error) {
		exitWith(error instanceof Error ? error.message : String(error));
	}
	await run(await resolveClient(values.wow), {
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
