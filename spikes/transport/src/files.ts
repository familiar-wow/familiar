import { renameSync, rmSync, writeFileSync } from "node:fs";

const BUSY = new Set(["EBUSY", "EPERM", "EACCES"]);

/**
 * Writes a temporary file and renames it over the target, so the game never reads a
 * half-written file. Retries while the game holds the target open. Returns the retries.
 */
export function atomicWrite(file: string, data: string | Uint8Array): number {
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, data);
	for (let attempt = 0; ; attempt++) {
		try {
			renameSync(temp, file);
			return attempt;
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
