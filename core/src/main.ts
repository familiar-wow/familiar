// familiar: the companion for development builds, until the desktop app exists (FAM-6). It
// installs the addon and carries messages between the game and an echo that stands in for a
// brain until Hermes is connected (FAM-24).
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { fileLog } from "./log.ts";
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

const USAGE = `familiar ${VERSION}: the Familiar app for development builds

  familiar              install or update the addon, then carry messages until Ctrl+C
  familiar check        show which client it found, without changing anything
  familiar uninstall    remove the addon and its helpers (close WoW first)

Options:
  --wow <folder>    the _forever_ client folder, if it is not found automatically
  --logs <folder>   where the log goes (default: familiar-logs in the current folder)`;

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

/** The echo: "heard: <text>"; a number n as text asks for a reply of n bytes, up to 8000. */
export function echo(text: string): string {
	const heard = `heard: ${text}`;
	const size = /^\d+$/.test(text) ? Math.min(Number(text), 8000) : 0;
	if (size <= heard.length) return heard;
	return `${heard}\n${"familiar ".repeat(Math.ceil(size / 9))}`.slice(0, size);
}

const stamp = () =>
	new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");

async function run(paths: WowPaths, logs: string): Promise<void> {
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
	});
	console.log(`familiar ${VERSION}`);
	console.log(
		`Client: ${paths.client} (interface ${iface}${build ? `, ${build}` : ""})`,
	);
	console.log(`Log:    ${logFile}`);
	if (fresh) console.log("Addon installed.");
	else if (result.added + result.updated > 0) console.log("Addon updated.");
	if (running && result.added > 0)
		console.log(
			"\n!! WoW is running and new files were added. Quit WoW completely and start it again;\n!! /reload does not find new files.\n",
		);
	else if (running && result.updated > 0)
		console.log("WoW is running: type /reload in game.");

	const transport = new Transport({
		paths,
		log,
		welcome: `Familiar app ${VERSION}`,
	});
	transport.onMessage((body, { hello }) => {
		const text = new TextDecoder().decode(body);
		if (hello) return log.say(`The addon says hello: ${text}`);
		log.say(`Message: ${text.split("\n")[0]}`);
		try {
			transport.send(new TextEncoder().encode(echo(text)));
		} catch (error) {
			log.say(
				`Could not answer: ${error instanceof Error ? error.message : error}`,
			);
		}
	});
	await transport.start();
	console.log("\nReady. In game, type /familiar say hello. Ctrl+C stops.\n");
	const stop = () => {
		transport.stop();
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
	await run(
		await resolveClient(values.wow),
		resolve(values.logs ?? "familiar-logs"),
	);
}

if (import.meta.main)
	main().catch((error) =>
		exitWith(
			String(error instanceof Error ? (error.stack ?? error.message) : error),
		),
	);
