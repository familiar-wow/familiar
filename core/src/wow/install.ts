// Installs what the transport needs into the client (ADR 0005): the main addon with its font
// bank and doorbells, and the 256 lane helpers. Until the desktop app exists (FAM-6), this tool
// installs the main addon too.
//
// The helpers form one group under Familiar_L000 in their own addon list category, which the
// addon collapses once. Forever's AddonList.lua files a group under the category of its parent
// addon only, so Familiar_L000 is the parent and every helper names the category.
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "../files.ts";
import { BELLS, bellPath, FONTS, fontPath } from "../transport/bank.ts";
import { HELPERS } from "../transport/codec.ts";
import { emptyFont } from "../transport/font.ts";
import { helperName } from "../transport/lane.ts";
import { RAISED } from "../transport/wav.ts";
import { FILES, TOC } from "./addon.ts";
import { addonsFiles, type WowPaths } from "./client.ts";

export const MAIN = "Familiar";
export const CATEGORY = "Familiar transport";
/** Marks folders this tool created; only those are updated or removed. */
const MARKER = "## X-Familiar-Installer: 1";

export interface InstallResult {
	/** New files and folders: a running game sees them only after a full restart. */
	added: number;
	updated: number;
}

function mainToc(iface: number, version: string): string {
	return `${TOC.replace(/^## Interface: .*$/m, `## Interface: ${iface}`)
		.replace("@project-version@", version)
		.trimEnd()
		.replace(/\n\n/, `\n${MARKER}\n\n`)}\n`;
}

function helperToc(iface: number, i: number): string {
	return [
		`## Interface: ${iface}`,
		`## Title: Familiar transport ${String(i).padStart(3, "0")}`,
		"## Notes: Carries messages from Familiar to its app. Leave it as it is.",
		`## Group: ${helperName(0)}`,
		`## Category: ${CATEGORY}`,
		"## DefaultState: disabled",
		"## LoadOnDemand: 1",
		MARKER,
		"",
	].join("\n");
}

function owned(folder: string): boolean {
	const name = folder.split(/[\\/]/).pop() ?? "";
	try {
		return readFileSync(join(folder, `${name}.toc`), "utf8").includes(MARKER);
	} catch {
		return false;
	}
}

export function isInstalled(paths: WowPaths): boolean {
	return owned(join(paths.addons, MAIN));
}

export function install(
	paths: WowPaths,
	iface: number,
	version: string,
): InstallResult {
	const result: InstallResult = { added: 0, updated: 0 };
	const folder = (name: string) => {
		const dir = join(paths.addons, name);
		if (existsSync(dir) && !owned(dir) && readdirSync(dir).length > 0)
			throw new Error(`${dir} exists, but Familiar did not install it`);
		mkdirSync(dir, { recursive: true });
		return dir;
	};
	/** `replace` false: a file the transport rewrites while the game runs is only created. */
	const write = (
		file: string,
		content: string | Uint8Array,
		replace = true,
	) => {
		if (!existsSync(file)) {
			mkdirSync(join(file, ".."), { recursive: true });
			writeFileSync(file, content);
			result.added++;
		} else if (replace && !readFileSync(file).equals(Buffer.from(content))) {
			atomicWrite(file, content);
			result.updated++;
		}
	};

	const main = folder(MAIN);
	write(join(main, `${MAIN}.toc`), mainToc(iface, version));
	for (const [name, source] of Object.entries(FILES))
		write(join(main, name), source);
	for (let slot = 1; slot <= FONTS; slot++)
		write(fontPath(main, slot), emptyFont(slot), false);
	for (let n = 1; n <= BELLS; n++) {
		write(bellPath(main, "ack", n), "", false);
		write(bellPath(main, "msg", n), "", false);
	}
	// The sound self-test: a long file plays, an empty one does not.
	write(join(main, "test", "long.wav"), RAISED);
	write(join(main, "test", "empty.wav"), "");

	for (let i = 0; i < HELPERS; i++) {
		const name = helperName(i);
		write(join(folder(name), `${name}.toc`), helperToc(iface, i));
	}
	// Does the client read files of an addon that never loads? The answer decides where the
	// desktop app puts the bank (FAM-6).
	const probe = join(paths.addons, helperName(0));
	write(join(probe, "probe.ttf"), emptyFont(0));
	write(join(probe, "probe.wav"), RAISED);
	return result;
}

/** Removes the folders this tool installed and, with the game closed, their AddOns.txt rows. */
export function uninstall(paths: WowPaths): { folders: number; rows: number } {
	let folders = 0;
	for (const name of existsSync(paths.addons)
		? readdirSync(paths.addons)
		: []) {
		const dir = join(paths.addons, name);
		if ((name === MAIN || name.startsWith("Familiar_L")) && owned(dir)) {
			rmSync(dir, { recursive: true, force: true });
			folders++;
		}
	}
	let rows = 0;
	for (const file of addonsFiles(paths.accounts)) {
		const lines = readFileSync(file, "latin1").split("\n");
		const kept = lines.filter((line) => !/^Familiar(_L\d{3})?:/.test(line));
		if (kept.length !== lines.length) {
			rows += lines.length - kept.length;
			atomicWrite(file, Buffer.from(kept.join("\n"), "latin1"));
		}
	}
	return { folders, rows };
}
