// familiar-spike: installs the measuring addon, runs the companion and writes report.md.
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Companion } from "./companion.ts";
import { install, isInstalled, uninstall } from "./install.ts";
import { EventLog } from "./log.ts";
import { buildReport } from "./report.ts";
import {
	accountNames,
	clientProcesses,
	clientVersion,
	findClient,
	isClientFolder,
	savedVariablesFile,
	type WowPaths,
	wowPaths,
} from "./wow.ts";

const VERSION = "0.1.0";

const USAGE = `familiar-spike ${VERSION}: transport measurements for Familiar (FAM-15)

  familiar-spike              install or update the test addon, then measure until Ctrl+C
  familiar-spike report       rebuild report.md from the collected data
  familiar-spike uninstall    remove the test addon and its data from WoW (WoW must be closed)

Options:
  --wow <folder>    the _forever_ client folder, if it is not found automatically
  --data <folder>   where logs and report.md go (default: familiar-spike-data next to you)`;

function exitWith(message: string, code = 1): never {
	console.error(message);
	if (process.platform === "win32" && process.stdin.isTTY)
		prompt("Press Enter to close.");
	process.exit(code);
}

async function resolveClient(option?: string): Promise<WowPaths> {
	const client = option ? resolve(option) : await findClient();
	if (!client)
		exitWith(
			'WoW: Forever was not found. Pass the client folder, for example:\n  familiar-spike --wow "C:\\Program Files (x86)\\World of Warcraft\\_forever_"',
		);
	if (!isClientFolder(client))
		exitWith(`${client} does not look like a WoW client folder.`);
	return wowPaths(client);
}

function stamp(date = new Date()): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function writeReport(dataDir: string): string {
	const file = join(dataDir, "report.md");
	writeFileSync(file, buildReport(dataDir));
	return file;
}

function collectSaved(paths: WowPaths, dataDir: string): void {
	for (const account of accountNames(paths)) {
		const source = savedVariablesFile(paths, account);
		if (existsSync(source))
			copyFileSync(
				source,
				join(dataDir, `savedvariables-${account.replace(/[^\w#-]/g, "_")}.lua`),
			);
	}
}

async function run(paths: WowPaths, dataDir: string): Promise<void> {
	const { interface: iface, version } = clientVersion(paths.client);
	const running = (await clientProcesses()).length > 0;
	const firstInstall = !isInstalled(paths);
	const result = install(paths, iface);
	const log = new EventLog(join(dataDir, `companion-${stamp()}.jsonl`));
	log.add("start", {
		version: VERSION,
		client: paths.client,
		interface: iface,
		build: version,
		install: result,
	});
	console.log(`familiar-spike ${VERSION}`);
	console.log(
		`Client: ${paths.client} (interface ${iface}${version ? `, ${version}` : ""})`,
	);
	console.log(`Data:   ${dataDir}`);
	if (firstInstall) console.log("Test addon installed.");
	else if (result.added + result.updated > 0)
		console.log("Test addon updated.");
	if (running && result.added > 0)
		console.log(
			"\n!! WoW is running and new addon files were added. Quit WoW completely and start it again;\n!! /reload does not pick up new files.\n",
		);
	else if (running && result.updated > 0)
		console.log("WoW is running: type /reload in game to load the update.");

	const companion = new Companion({
		paths,
		log,
		onSaved: () => {
			collectSaved(paths, dataDir);
			writeReport(dataDir);
		},
	});
	companion.start();
	console.log(
		[
			"",
			"In game:",
			'  1. Log in. The addon reports "Companion connected" in chat.',
			"  2. Stand somewhere quiet, out of combat, and type /fspike bench (about two minutes).",
			"  3. Type /reload once when it is done, so the client saves the results.",
			"  4. Keep playing as usual. Every /reload or logout adds the soak results.",
			"Leave this window open. Ctrl+C stops and writes report.md.",
			"",
		].join("\n"),
	);
	const status = setInterval(() => log.say(companion.status()), 5 * 60_000);
	const shutdown = () => {
		clearInterval(status);
		companion.stop();
		collectSaved(paths, dataDir);
		console.log(`\nReport: ${writeReport(dataDir)}`);
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	// Windows sends this when the console window is closed.
	process.on("SIGHUP", shutdown);
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			wow: { type: "string" },
			data: { type: "string" },
			help: { type: "boolean", short: "h" },
			version: { type: "boolean" },
		},
		allowPositionals: true,
	});
	if (values.help) return void console.log(USAGE);
	if (values.version) return void console.log(VERSION);
	const command = positionals[0] ?? "run";
	const dataDir = resolve(values.data ?? "familiar-spike-data");
	mkdirSync(dataDir, { recursive: true });

	if (command === "report") {
		if (values.wow) collectSaved(await resolveClient(values.wow), dataDir);
		console.log(`Report: ${writeReport(dataDir)}`);
	} else if (command === "uninstall") {
		const paths = await resolveClient(values.wow);
		if ((await clientProcesses()).length > 0)
			exitWith("Close WoW first, so it does not write the rows back.");
		collectSaved(paths, dataDir);
		const removed = uninstall(paths);
		console.log(
			`Removed ${removed.folders} addon folders and ${removed.rows} AddOns.txt rows. Your data stays in ${dataDir}.`,
		);
	} else if (command === "run") {
		await run(await resolveClient(values.wow), dataDir);
	} else {
		exitWith(USAGE);
	}
}

main().catch((error) =>
	exitWith(
		String(error instanceof Error ? (error.stack ?? error.message) : error),
	),
);
