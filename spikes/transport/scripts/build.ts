// Builds the release archives into dist/: bun scripts/build.ts [windows-x64] [linux-x64]
// Baseline builds also run on CPUs without AVX2. Packing needs zip and tar.
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../src/version.ts";

const PLATFORMS = {
	"windows-x64": {
		target: "bun-windows-x64-baseline",
		binary: "familiar-spike.exe",
	},
	"linux-x64": { target: "bun-linux-x64-baseline", binary: "familiar-spike" },
} as const;
type Platform = keyof typeof PLATFORMS;

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const args = Bun.argv.slice(2);
const wanted = (args.length > 0 ? args : Object.keys(PLATFORMS)) as Platform[];

for (const platform of wanted) {
	const spec = PLATFORMS[platform];
	if (!spec)
		throw new Error(
			`unknown platform ${platform}; use ${Object.keys(PLATFORMS).join(" or ")}`,
		);
	const windows = platform.startsWith("windows");
	const name = `familiar-spike-${VERSION}-${platform}`;
	const folder = join(dist, name);
	const binary = join(folder, spec.binary);
	rmSync(folder, { recursive: true, force: true });
	mkdirSync(folder, { recursive: true });

	const result = await Bun.build({
		entrypoints: [join(root, "src", "main.ts")],
		minify: true,
		compile: {
			target: spec.target,
			outfile: binary,
			...(windows
				? {
						windows: {
							title: "Familiar transport spike",
							publisher: "The Familiar contributors",
							version: `${VERSION}.0`,
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
	if (!windows) chmodSync(binary, 0o755);

	// tar keeps the executable bit; Windows users expect a zip.
	const archive = `${name}.${windows ? "zip" : "tar.gz"}`;
	rmSync(join(dist, archive), { force: true });
	const pack = windows
		? ["zip", "-q", "-r", "-9", archive, name]
		: ["tar", "-czf", archive, name];
	const packed = Bun.spawnSync(pack, { cwd: dist, stderr: "inherit" });
	if (packed.exitCode !== 0) throw new Error(`${pack[0]} failed`);

	const sha256 = new Bun.CryptoHasher("sha256")
		.update(await Bun.file(binary).arrayBuffer())
		.digest("hex");
	console.log(`dist/${archive}\n  ${spec.binary} sha256 ${sha256}`);
}
