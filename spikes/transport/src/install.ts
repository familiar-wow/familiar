// Installs and removes the spike addon, its lane helpers, doorbell files and fonts.
//
// The 256 lane helpers form one group under FamiliarSpike_U000, and that group sits in its own
// addon list category, which the addon collapses once: the list then shows the main addon and
// one closed "Familiar Spike lane" entry. Forever's AddonList.lua files a group under the
// category of its parent addon only, so U000 is the parent and every helper names the
// category. Helpers of older spike versions (lane D, slots) are removed.
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ADDON_FILES } from "./assets.ts";
import { atomicWrite } from "./files.ts";
import { FONTS, fontName, placeholderFont } from "./font.ts";
import {
	LANE_BITS,
	LONG_WAV,
	laneFolder,
	SHORT_WAV,
	SIGNALS,
	signalName,
} from "./protocol.ts";
import { VERSION } from "./version.ts";
import {
	accountNames,
	addonsFiles,
	savedVariablesFile,
	type WowPaths,
} from "./wow.ts";

const MARKER = "## X-Familiar-Spike: 1";
const MAIN = "FamiliarSpike";
export const CATEGORY = "Familiar Spike lane";
/** Lane D, slots: helpers of spike versions before 0.5.0. */
const OLD_HELPER = /^FamiliarSpike_(D\d{3}|L\d{2})$/;
const OLD_ROW = /^FamiliarSpike_(D\d{3}|L\d{2}):/;

function toc(lines: string[]): string {
	return `${lines.join("\n")}\n`;
}

function mainToc(iface: number): string {
	return toc([
		`## Interface: ${iface}`,
		"## Title: Familiar Spike",
		"## Notes: Measures transport channels for Familiar (FAM-15). Temporary.",
		"## Author: Familiar",
		`## Version: ${VERSION}`,
		"## SavedVariables: FamiliarSpikeDB",
		MARKER,
		"",
		...Object.keys(ADDON_FILES),
	]);
}

function helperToc(iface: number, name: string): string {
	return toc([
		`## Interface: ${iface}`,
		`## Title: Familiar Spike lane ${name.slice(-3)}`,
		"## Notes: Transport test helper without code.",
		`## Group: ${laneFolder(0)}`,
		`## Category: ${CATEGORY}`,
		"## DefaultState: disabled",
		"## LoadOnDemand: 1",
		MARKER,
	]);
}

function owned(folder: string): boolean {
	try {
		const name = folder.split(/[\\/]/).pop() ?? "";
		return readFileSync(join(folder, `${name}.toc`), "utf8").includes(MARKER);
	} catch {
		return false;
	}
}

/** Writes `content` unless the file already holds exactly that. Returns true if it wrote. */
function ensure(
	file: string,
	content: string | Uint8Array,
	overwrite = true,
): boolean {
	if (existsSync(file)) {
		if (!overwrite) return false;
		const current = readFileSync(file);
		if (Buffer.compare(current, Buffer.from(content)) === 0) return false;
	}
	writeFileSync(file, content);
	return true;
}

export interface InstallResult {
	/** New files or folders the running game cannot see until it restarts. */
	added: number;
	updated: number;
	/** Old helper folders; the running game lists them until it restarts. */
	removed: number;
	/** Their rows in the characters' AddOns.txt, removed only while the game is closed. */
	rows: number;
}

export function spikeFolders(paths: WowPaths): string[] {
	if (!existsSync(paths.addons)) return [];
	return readdirSync(paths.addons).filter((name) => name.startsWith(MAIN));
}

export function isInstalled(paths: WowPaths): boolean {
	return owned(join(paths.addons, MAIN));
}

/** Drops rows matching `pattern` from every character's AddOns.txt. */
function dropRows(paths: WowPaths, pattern: RegExp): number {
	let rows = 0;
	for (const { file } of addonsFiles(paths)) {
		const lines = readFileSync(file, "latin1").split("\n");
		const kept = lines.filter((line) => !pattern.test(line));
		if (kept.length !== lines.length) {
			rows += lines.length - kept.length;
			atomicWrite(file, Buffer.from(kept.join("\n"), "latin1"));
		}
	}
	return rows;
}

export function install(
	paths: WowPaths,
	iface: number,
	gameRunning = false,
): InstallResult {
	const result: InstallResult = { added: 0, updated: 0, removed: 0, rows: 0 };
	const folder = (name: string) => {
		const dir = join(paths.addons, name);
		if (existsSync(dir) && !owned(dir) && readdirSync(dir).length > 0)
			throw new Error(`${dir} exists and was not created by this tool`);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
			result.added++;
		}
		return dir;
	};
	const write = (
		file: string,
		content: string | Uint8Array,
		overwrite = true,
	) => {
		const isNew = !existsSync(file);
		if (ensure(file, content, overwrite)) {
			if (isNew) result.added++;
			else result.updated++;
		}
	};

	const main = folder(MAIN);
	write(join(main, `${MAIN}.toc`), mainToc(iface));
	for (const [name, source] of Object.entries(ADDON_FILES))
		write(join(main, name), source);
	mkdirSync(join(main, "sig"), { recursive: true });
	mkdirSync(join(main, "ctl"), { recursive: true });
	for (let n = 1; n <= SIGNALS; n++)
		write(join(main, "sig", signalName(n)), "", false);
	// The sound probe compares an empty, a short, a long and a missing file.
	write(join(main, "ctl", "empty.wav"), "");
	write(join(main, "ctl", "valid.wav"), SHORT_WAV);
	write(join(main, "ctl", "long.wav"), LONG_WAV);
	const missing = join(main, "ctl", "missing.wav");
	if (existsSync(missing)) {
		rmSync(missing);
		result.updated++;
	}
	// The client finds only fonts that exist when it starts; the companion fills them later.
	mkdirSync(join(main, "fonts"), { recursive: true });
	for (let slot = 1; slot <= FONTS; slot++) {
		const file = join(main, "fonts", fontName(slot));
		if (!existsSync(file)) write(file, placeholderFont(slot));
	}
	for (let i = 0; i < LANE_BITS; i++) {
		const name = laneFolder(i);
		write(join(folder(name), `${name}.toc`), helperToc(iface, name));
	}
	for (const name of spikeFolders(paths)) {
		const dir = join(paths.addons, name);
		if (OLD_HELPER.test(name) && owned(dir)) {
			rmSync(dir, { recursive: true, force: true });
			result.removed++;
		}
	}
	if (!gameRunning) result.rows = dropRows(paths, OLD_ROW);
	return result;
}

/**
 * Silences raised doorbells and empties the font bank. Only safe while the game is closed:
 * a running client may still read them.
 */
export function resetVolatile(paths: WowPaths): {
	signals: number;
	fonts: number;
} {
	let signals = 0;
	let fonts = 0;
	const main = join(paths.addons, MAIN);
	const sig = join(main, "sig");
	if (existsSync(sig))
		for (const name of readdirSync(sig)) {
			const file = join(sig, name);
			if (name.endsWith(".wav") && statSync(file).size > 0) {
				atomicWrite(file, "");
				signals++;
			}
		}
	for (let slot = 1; slot <= FONTS; slot++) {
		const file = join(main, "fonts", fontName(slot));
		if (!existsSync(file)) continue;
		const placeholder = placeholderFont(slot);
		if (Buffer.compare(readFileSync(file), Buffer.from(placeholder)) !== 0) {
			atomicWrite(file, placeholder);
			fonts++;
		}
	}
	return { signals, fonts };
}

/** Removes everything the tool created, including saved results and AddOns.txt rows. */
export function uninstall(paths: WowPaths): { folders: number; rows: number } {
	let folders = 0;
	for (const name of spikeFolders(paths)) {
		const dir = join(paths.addons, name);
		if (owned(dir)) {
			rmSync(dir, { recursive: true, force: true });
			folders++;
		}
	}
	for (const account of accountNames(paths)) {
		const file = savedVariablesFile(paths, account);
		rmSync(file, { force: true });
		rmSync(`${file}.bak`, { force: true });
	}
	return { folders, rows: dropRows(paths, /^FamiliarSpike(_[UDL]\d+)?:/) };
}
