// familiar-spike: installs the measuring addon, runs the companion and writes report.md.
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Companion, FAST_TIMING } from "./companion.ts";
import { install, isInstalled, uninstall } from "./install.ts";
import { EventLog } from "./log.ts";
import { buildReport } from "./report.ts";
import { VERSION } from "./version.ts";
import {
	accountNames,
	addonsFiles,
	clientProcesses,
	clientVersion,
	findClients,
	isClientFolder,
	savedVariablesFile,
	type WowPaths,
	wowPaths,
} from "./wow.ts";

const USAGE = `familiar-spike ${VERSION}: transport measurements for Familiar (FAM-15)

  familiar-spike              install or update the test addon, then measure until Ctrl+C
  familiar-spike check        show which client it found, without changing anything
  familiar-spike report       collect the addon's saved results from WoW and rebuild report.md
  familiar-spike uninstall    remove the test addon and its data from WoW (WoW must be closed)

Options:
  --wow <folder>    the _forever_ client folder, if it is not found automatically
  --data <folder>   where logs and report.md go (default: familiar-spike-data in the current folder)`;

const NOT_FOUND =
	process.platform === "win32"
		? 'WoW: Forever was not found. Pass the client folder, for example:\n  familiar-spike --wow "C:\\Program Files (x86)\\World of Warcraft\\_forever_"'
		: 'WoW: Forever was not found in the Wine prefixes of Lutris, Steam (Proton), Bottles, Heroic or ~/.wine.\nPass the client folder, for example:\n  ./familiar-spike --wow "$HOME/Games/battlenet/drive_c/Program Files (x86)/World of Warcraft/_forever_"';

function exitWith(message: string, code = 1): never {
	console.error(message);
	if (process.platform === "win32" && process.stdin.isTTY)
		prompt("Press Enter to close.");
	process.exit(code);
}

/** The shell does not expand ~ inside quotes. */
function clientOption(option: string): string {
	return resolve(option.replace(/^~(?=$|[\\/])/, homedir()));
}

async function resolveClient(option?: string): Promise<WowPaths> {
	const client = option ? clientOption(option) : (await findClients())[0];
	if (!client) exitWith(NOT_FOUND);
	if (!isClientFolder(client))
		exitWith(`${client} does not look like a WoW client folder.`);
	return wowPaths(client);
}

async function check(option?: string): Promise<void> {
	const found = option ? [clientOption(option)] : await findClients();
	console.log(`familiar-spike ${VERSION} on ${process.platform}`);
	const client = found[0];
	if (!client) exitWith(NOT_FOUND);
	if (!isClientFolder(client))
		exitWith(`${client} does not look like a WoW client folder.`);
	const paths = wowPaths(client);
	const { interface: iface, version } = clientVersion(paths.client);
	const others = existsSync(paths.addons)
		? readdirSync(paths.addons).filter((n) => !n.startsWith("FamiliarSpike"))
				.length
		: 0;
	const characters = addonsFiles(paths).length;
	const pids = await clientProcesses();
	const rows: [string, string][] = [
		["Client", paths.client],
		[
			"Version",
			version
				? `${version} (interface ${iface})`
				: `unknown, assuming interface ${iface}`,
		],
		[
			"Addons",
			`${paths.addons} (${others} other addon${others === 1 ? "" : "s"}, test addon ${isInstalled(paths) ? "installed" : "not installed"})`,
		],
		[
			"Characters",
			characters ? `${characters} with AddOns.txt` : "none yet; log in once",
		],
		["WoW running", pids.length ? `yes (pid ${pids.join(", ")})` : "no"],
		...found.slice(1).map((other): [string, string] => ["Also found", other]),
	];
	for (const [label, value] of rows)
		console.log(`${`${label}:`.padEnd(13)}${value}`);
	if (found.length > 1)
		console.log(
			"\nThe first one was played most recently. Use --wow to pick another.",
		);
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
		dataDir,
		// Set only by the simulator.
		timing: process.env.FAMILIAR_SPIKE_FAST ? FAST_TIMING : undefined,
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
			"  1. Log in. Chat shows the self-test and whether doorbells work on this client.",
			"  2. Stand somewhere quiet, out of combat, and type /fspike bench (about two minutes).",
			"  3. Type /reload once when it is done, so the client saves the results.",
			"  4. Keep playing as usual for at least an hour. Switch characters once and come back.",
			"  5. Type /reload once more at the end: WoW saves the addon's results only then.",
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
		if (companion.gameRunning)
			console.log(
				"\n!! WoW is still running: the addon's results since your last /reload or logout are not\n!! saved yet. Type /reload in game, then run: familiar-spike report\n",
			);
		process.exit(0);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	// Sent when the console window or terminal is closed.
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
	if (command === "check") return check(values.wow);
	const dataDir = resolve(values.data ?? "familiar-spike-data");
	mkdirSync(dataDir, { recursive: true });

	if (command === "report") {
		// Without a client the report uses the results collected so far.
		const client = values.wow
			? clientOption(values.wow)
			: (await findClients())[0];
		if (client && isClientFolder(client))
			collectSaved(wowPaths(client), dataDir);
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
