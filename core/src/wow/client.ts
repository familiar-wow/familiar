// Finds the WoW: Forever client, its folders and its process. On Linux the game runs under Wine
// or Proton, so the client lives inside a Wine prefix and the process is a Wine process.
import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface WowPaths {
	/** The client folder, for example C:\Program Files (x86)\World of Warcraft\_forever_ */
	client: string;
	addons: string;
	accounts: string;
}

const CLIENT_EXE = /^wow\.exe$/i;

const INSTALL_DIRS = [
	["Program Files (x86)", "World of Warcraft"],
	["Program Files", "World of Warcraft"],
	["World of Warcraft"],
	["Games", "World of Warcraft"],
	["Battle.net", "World of Warcraft"],
];

/**
 * `dir/name` as it is spelled on disk. Linux is case-sensitive, the game under Wine is not:
 * creating Interface/AddOns next to an existing Interface/Addons would hide the player's addons.
 */
function entry(dir: string, name: string): string {
	try {
		const names = readdirSync(dir);
		const found = names.includes(name)
			? name
			: names.find((n) => n.toLowerCase() === name.toLowerCase());
		if (found) return join(dir, found);
	} catch {
		// The folder does not exist yet.
	}
	return join(dir, name);
}

export function wowPaths(client: string): WowPaths {
	return {
		client,
		addons: entry(entry(client, "Interface"), "AddOns"),
		accounts: entry(entry(client, "WTF"), "Account"),
	};
}

export function isClientFolder(dir: string): boolean {
	return ["Wow.exe", "WTF", "Interface"].some((name) =>
		existsSync(entry(dir, name)),
	);
}

async function capture(command: string[]): Promise<string> {
	try {
		const child = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" });
		const text = await new Response(child.stdout).text();
		await child.exited;
		return text;
	} catch {
		return "";
	}
}

function subdirs(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((d) => d.isDirectory())
			.map((d) => d.name);
	} catch {
		return [];
	}
}

const mtimeOf = (file: string) => {
	try {
		return statSync(file).mtimeMs;
	} catch {
		return undefined;
	}
};

/** Every client folder found, the most recently played first: the client writes Config.wtf on exit. */
export async function findClients(): Promise<string[]> {
	const candidates =
		process.platform === "win32"
			? await windowsCandidates()
			: process.platform === "linux"
				? linuxCandidates()
				: [];
	const found = new Set<string>();
	for (const candidate of candidates.filter(isClientFolder)) {
		try {
			found.add(realpathSync(candidate));
		} catch {
			// Vanished while we looked.
		}
	}
	const played = (client: string) => {
		const wtf = entry(client, "WTF");
		return mtimeOf(entry(wtf, "Config.wtf")) ?? mtimeOf(wtf) ?? 0;
	};
	return [...found].sort((a, b) => played(b) - played(a));
}

/** Registry first, then the usual install locations on drives C to H. */
async function windowsCandidates(): Promise<string[]> {
	const candidates: string[] = [];
	for (const key of [
		"HKLM\\SOFTWARE\\WOW6432Node\\Blizzard Entertainment\\World of Warcraft",
		"HKLM\\SOFTWARE\\Blizzard Entertainment\\World of Warcraft",
	]) {
		const output = await capture(["reg", "query", key, "/v", "InstallPath"]);
		const path = /InstallPath\s+REG_SZ\s+(.+)/i
			.exec(output)?.[1]
			?.trim()
			.replace(/[\\/]+$/, "");
		if (path)
			candidates.push(
				join(dirname(path), "_forever_"),
				join(path, "_forever_"),
			);
	}
	for (const drive of "CDEFGH")
		for (const dir of INSTALL_DIRS)
			candidates.push(join(`${drive}:\\`, ...dir, "_forever_"));
	return candidates;
}

/** The same search inside every Wine prefix: registry first, then each drive letter. */
function linuxCandidates(): string[] {
	const candidates: string[] = [];
	for (const prefix of winePrefixes()) {
		for (const installPath of registryInstallPaths(prefix)) {
			const dir = linuxPath(prefix, installPath);
			if (dir)
				candidates.push(
					join(dirname(dir), "_forever_"),
					join(dir, "_forever_"),
				);
		}
		for (const drive of driveRoots(prefix))
			for (const dir of INSTALL_DIRS)
				candidates.push(join(drive, ...dir, "_forever_"));
	}
	return candidates;
}

/** Wine prefixes of the usual launchers: Lutris, Steam (Proton), Bottles, Heroic, plain Wine. */
function winePrefixes(): string[] {
	const home = homedir();
	const prefixes = [process.env.WINEPREFIX ?? "", join(home, ".wine")];
	for (const parent of [
		join(home, "Games"), // Lutris installs Battle.net to ~/Games/battlenet
		join(home, "Games", "Heroic", "Prefixes", "default"),
		join(home, ".local", "share", "bottles", "bottles"),
		join(
			home,
			".var",
			"app",
			"com.usebottles.bottles",
			"data",
			"bottles",
			"bottles",
		),
		join(home, ".local", "share", "wineprefixes"),
	])
		for (const name of subdirs(parent)) prefixes.push(join(parent, name));
	for (const steam of [
		join(home, ".steam", "steam"),
		join(home, ".local", "share", "Steam"),
		join(home, ".var", "app", "com.valvesoftware.Steam", "data", "Steam"),
	]) {
		const compat = join(steam, "steamapps", "compatdata");
		for (const app of subdirs(compat)) prefixes.push(join(compat, app, "pfx"));
	}
	return prefixes.filter(
		(prefix) => prefix !== "" && existsSync(join(prefix, "drive_c")),
	);
}

/** InstallPath values that Battle.net wrote into the prefix's registry, as Windows paths. */
function registryInstallPaths(prefix: string): string[] {
	let text: string;
	try {
		text = readFileSync(join(prefix, "system.reg"), "utf8");
	} catch {
		return [];
	}
	const sections =
		/^\[Software\\\\(?:Wow6432Node\\\\)?Blizzard Entertainment\\\\World of Warcraft\][^\n]*\n([\s\S]*?)(?=^\[|(?![\s\S]))/gim;
	const paths: string[] = [];
	for (const section of text.matchAll(sections)) {
		const value = /^"InstallPath"="((?:[^"\\]|\\.)*)"/im.exec(
			section[1] ?? "",
		)?.[1];
		if (value) paths.push(value.replace(/\\\\/g, "\\"));
	}
	return paths;
}

/** C:\Program Files (x86)\... as a Linux path, through the prefix's drive letters. */
function linuxPath(prefix: string, windowsPath: string): string | undefined {
	const match = /^([a-z]):\\?(.*)$/i.exec(windowsPath.trim());
	if (!match) return undefined;
	try {
		const root = realpathSync(
			join(prefix, "dosdevices", `${(match[1] ?? "c").toLowerCase()}:`),
		);
		return join(root, ...(match[2] ?? "").split("\\").filter(Boolean));
	} catch {
		return undefined;
	}
}

function driveRoots(prefix: string): string[] {
	const dosdevices = join(prefix, "dosdevices");
	let names: string[];
	try {
		names = readdirSync(dosdevices);
	} catch {
		return [join(prefix, "drive_c")];
	}
	const roots: string[] = [];
	for (const name of names.filter((n) => /^[a-z]:$/i.test(n))) {
		try {
			roots.push(realpathSync(join(dosdevices, name)));
		} catch {
			// A drive letter that points nowhere.
		}
	}
	return roots;
}

/** Interface number from .build.info (version 1.60.1 means 16001); 16001 if unknown. */
export function clientVersion(client: string): {
	interface: number;
	version?: string;
} {
	try {
		const lines = readFileSync(join(dirname(client), ".build.info"), "utf8")
			.split(/\r?\n/)
			.filter(Boolean);
		const columns = (lines[0] ?? "").split("|").map((c) => c.split("!")[0]);
		const product = columns.indexOf("Product");
		const version = columns.indexOf("Version");
		for (const line of lines.slice(1)) {
			const cells = line.split("|");
			const name = cells[product] ?? "";
			const value = cells[version] ?? "";
			const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
			if (
				match &&
				(name === "wowf" || /forever/i.test(name) || value.startsWith("1.6"))
			)
				return {
					interface:
						Number(match[1]) * 10000 +
						Number(match[2]) * 100 +
						Number(match[3]),
					version: value,
				};
		}
	} catch {
		// Fall through to the default.
	}
	return { interface: 16001 };
}

/** PIDs of running Wow.exe processes: tasklist on Windows, /proc on Linux. */
export async function clientProcesses(): Promise<number[]> {
	if (process.platform === "linux") return linuxProcesses();
	if (process.platform !== "win32") return [];
	const output = await capture([
		"tasklist",
		"/FI",
		"IMAGENAME eq Wow.exe",
		"/FO",
		"CSV",
		"/NH",
	]);
	return [...output.matchAll(/^"Wow\.exe","(\d+)"/gim)].map((m) =>
		Number(m[1]),
	);
}

/** Wine names the process after the exe, and argv[0] holds its Windows path. */
function linuxProcesses(): number[] {
	const pids: number[] = [];
	for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
		try {
			const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
			const argv0 =
				readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0")[0] ?? "";
			if (
				CLIENT_EXE.test(comm) ||
				CLIENT_EXE.test(argv0.split(/[\\/]/).pop() ?? "")
			)
				pids.push(Number(pid));
		} catch {
			// The process ended while we looked.
		}
	}
	return pids;
}

/** Every WTF/Account/<account>/<realm>/<character>/AddOns.txt. */
export function addonsFiles(accounts: string): string[] {
	const found: string[] = [];
	for (const account of subdirs(accounts))
		for (const realm of subdirs(join(accounts, account))) {
			if (realm === "SavedVariables") continue;
			for (const character of subdirs(join(accounts, account, realm))) {
				const file = join(accounts, account, realm, character, "AddOns.txt");
				if (existsSync(file)) found.push(file);
			}
		}
	return found;
}
