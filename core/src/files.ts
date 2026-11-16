import {
	copyFileSync,
	linkSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";

const BUSY = new Set(["EBUSY", "EPERM", "EACCES"]);

/** Renames `temp` over `file`, retrying for a moment while Windows still holds the target open. */
function replace(temp: string, file: string): void {
	for (let attempt = 0; ; attempt++) {
		try {
			renameSync(temp, file);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "";
			if (attempt >= 50 || !BUSY.has(code)) {
				rmSync(temp, { force: true });
				throw error;
			}
			Bun.sleepSync(4);
		}
	}
}

const tempOf = (file: string) => `${file}.${process.pid}.tmp`;

/**
 * Writes a temporary file and renames it over the target, so the game never reads a half-written
 * file.
 */
export function atomicWrite(file: string, data: string | Uint8Array): void {
	const temp = tempOf(file);
	writeFileSync(temp, data);
	replace(temp, file);
}

/**
 * Makes `file` another name of `source`, replacing it atomically. Where the file system has no
 * hard links, such as exFAT, it copies `source` instead.
 */
export function atomicLink(source: string, file: string): void {
	const temp = tempOf(file);
	rmSync(temp, { force: true });
	try {
		linkSync(source, temp);
	} catch {
		copyFileSync(source, temp);
	}
	replace(temp, file);
}
