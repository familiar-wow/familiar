// Writes app/src-tauri/THIRD-PARTY-LICENSES.txt, which the installer ships: the license texts
// of the fonts the pages embed. The core carries its own list (core/scripts/build.ts).
//   bun scripts/licenses.ts
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FONTS = [
	"@fontsource/cinzel",
	"@fontsource-variable/inter",
	"@fontsource/jetbrains-mono",
];

const root = join(import.meta.dir, "..");
const text = FONTS.map((name) => {
	const pkg = Bun.resolveSync(`${name}/package.json`, root);
	const license = readFileSync(join(dirname(pkg), "LICENSE"), "utf8");
	return `${name}\n\n${license.trim()}\n`;
}).join(`\n${"-".repeat(72)}\n\n`);

writeFileSync(join(root, "src-tauri", "THIRD-PARTY-LICENSES.txt"), text);
console.log(`licenses: ${FONTS.length} fonts`);
