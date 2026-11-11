// Builds the Windows executable: bun scripts/build.ts [--target bun-linux-x64]
// The baseline build runs on CPUs without AVX2 too.
import { parseArgs } from "node:util";

const { values } = parseArgs({
	args: Bun.argv.slice(2),
	options: { target: { type: "string", default: "bun-windows-x64-baseline" } },
});
const target = values.target as Bun.Build.CompileTarget;
const windows = target.startsWith("bun-windows");
const outfile = `dist/familiar-spike${windows ? ".exe" : ""}`;

const result = await Bun.build({
	entrypoints: [new URL("../src/main.ts", import.meta.url).pathname],
	minify: true,
	compile: {
		target,
		outfile: new URL(`../${outfile}`, import.meta.url).pathname,
		...(windows
			? {
					windows: {
						title: "Familiar transport spike",
						publisher: "The Familiar contributors",
						version: "0.1.0.0",
						description: "Transport measurements for Familiar (FAM-15)",
					},
				}
			: {}),
	},
});
if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}
console.log(`Built ${outfile} for ${target}`);
