// Locating the WoW: Forever client and its per-account files.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface WowPaths {
	/** The client folder, for example C:\Program Files (x86)\World of Warcraft\_forever_ */
	client: string;
	addons: string;
	accounts: string;
}

export function wowPaths(client: string): WowPaths {
	return {
		client,
		addons: join(client, "Interface", "AddOns"),
		accounts: join(client, "WTF", "Account"),
	};
}

export function isClientFolder(dir: string): boolean {
	return (
		existsSync(join(dir, "Wow.exe")) ||
		existsSync(join(dir, "WTF")) ||
		existsSync(join(dir, "Interface"))
	);
}

export async function capture(command: string[]): Promise<string> {
	try {
		const child = Bun.spawn(command, { stdout: "pipe", stderr: "ignore" });
		const text = await new Response(child.stdout).text();
		await child.exited;
		return text;
	} catch {
		return "";
	}
}

/** Registry first, then the usual install locations on drives C to H. */
export async function findClient(): Promise<string | undefined> {
	if (process.platform !== "win32") return undefined;
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
	for (const drive of "CDEFGH") {
		for (const base of [
			"Program Files (x86)\\World of Warcraft",
			"Program Files\\World of Warcraft",
			"World of Warcraft",
			"Games\\World of Warcraft",
			"Battle.net\\World of Warcraft",
		])
			candidates.push(`${drive}:\\${base}\\_forever_`);
	}
	return candidates.find(isClientFolder);
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

/** PIDs of running Wow.exe processes (Windows only). */
export async function clientProcesses(): Promise<number[]> {
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

function subdirs(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

export function accountNames(paths: WowPaths): string[] {
	return subdirs(paths.accounts);
}

/** Every WTF/Account/<account>/<realm>/<character>/AddOns.txt. */
export function addonsFiles(
	paths: WowPaths,
): { file: string; account: string }[] {
	const found: { file: string; account: string }[] = [];
	for (const account of accountNames(paths)) {
		for (const realm of subdirs(join(paths.accounts, account))) {
			if (realm === "SavedVariables") continue;
			for (const character of subdirs(join(paths.accounts, account, realm))) {
				const file = join(
					paths.accounts,
					account,
					realm,
					character,
					"AddOns.txt",
				);
				if (existsSync(file)) found.push({ file, account });
			}
		}
	}
	return found;
}

export function savedVariablesFile(paths: WowPaths, account: string): string {
	return join(paths.accounts, account, "SavedVariables", "FamiliarSpike.lua");
}

export function mtimeOf(file: string): number | undefined {
	try {
		return statSync(file).mtimeMs;
	} catch {
		return undefined;
	}
}
