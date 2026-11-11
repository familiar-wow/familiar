// Installs and removes the spike addon, its lane helpers, slots and signal files.
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
import {
	LANE_BITS,
	type Lane,
	LONG_WAV,
	laneFolder,
	placeholderSource,
	SHORT_WAV,
	SIGNALS,
	SLOTS,
	signalName,
	slotFolder,
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
		"Wire.lua",
		"Probe.lua",
		"Spike.lua",
	]);
}

function helperToc(iface: number, name: string): string {
	return toc([
		`## Interface: ${iface}`,
		`## Title: Familiar Spike ${name.slice(MAIN.length + 1)}`,
		"## Notes: Transport test helper without code.",
		`## Group: ${MAIN}`,
		"## DefaultState: disabled",
		"## LoadOnDemand: 1",
		MARKER,
	]);
}

function slotToc(iface: number, name: string): string {
	return toc([
		`## Interface: ${iface}`,
		`## Title: Familiar Spike ${name.slice(MAIN.length + 1)}`,
		"## Notes: Transport test slot.",
		`## Group: ${MAIN}`,
		"## LoadOnDemand: 1",
		MARKER,
		"",
		"data.lua",
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
}

export function spikeFolders(paths: WowPaths): string[] {
	if (!existsSync(paths.addons)) return [];
	return readdirSync(paths.addons).filter((name) => name.startsWith(MAIN));
}

export function isInstalled(paths: WowPaths): boolean {
	return owned(join(paths.addons, MAIN));
}

export function install(paths: WowPaths, iface: number): InstallResult {
	const result: InstallResult = { added: 0, updated: 0 };
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

	for (const lane of ["U", "D"] as Lane[])
		for (let i = 0; i < LANE_BITS; i++) {
			const name = laneFolder(lane, i);
			write(join(folder(name), `${name}.toc`), helperToc(iface, name));
		}
	for (let k = 1; k <= SLOTS; k++) {
		const name = slotFolder(k);
		const dir = folder(name);
		write(join(dir, `${name}.toc`), slotToc(iface, name));
		write(join(dir, "data.lua"), placeholderSource(k), false);
	}
	return result;
}

/** Silences raised signals and restores slot placeholders. Only safe while the game is closed. */
export function resetVolatile(paths: WowPaths): {
	signals: number;
	slots: number;
} {
	let signals = 0;
	let slots = 0;
	const sig = join(paths.addons, MAIN, "sig");
	if (existsSync(sig))
		for (const name of readdirSync(sig)) {
			const file = join(sig, name);
			if (name.endsWith(".wav") && statSync(file).size > 0) {
				atomicWrite(file, "");
				signals++;
			}
		}
	for (let k = 1; k <= SLOTS; k++) {
		const file = join(paths.addons, slotFolder(k), "data.lua");
		if (
			existsSync(file) &&
			readFileSync(file, "utf8") !== placeholderSource(k)
		) {
			atomicWrite(file, placeholderSource(k));
			slots++;
		}
	}
	return { signals, slots };
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
	let rows = 0;
	for (const { file } of addonsFiles(paths)) {
		const text = readFileSync(file, "latin1");
		const lines = text.split("\n");
		const kept = lines.filter(
			(line) => !/^FamiliarSpike(_[UDL]\d+)?:/.test(line),
		);
		if (kept.length !== lines.length) {
			rows += lines.length - kept.length;
			atomicWrite(file, Buffer.from(kept.join("\n"), "latin1"));
		}
	}
	return { folders, rows };
}
