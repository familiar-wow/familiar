// Puts the core where Tauri bundles it from: src-tauri/binaries/familiar-core-<target triple>.
// The app names it familiar-core, because Windows does not tell familiar.exe from Familiar.exe.
//   bun scripts/sidecar.ts                 builds the core for this computer, or the target
//                                          Tauri builds for (TAURI_ENV_TARGET_TRIPLE)
//   FAMILIAR_SIDECAR=<file> bun scripts/sidecar.ts   copies a core built before, as CI does
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import core from "../../core/package.json" with { type: "json" };

const TARGETS: Record<string, { platform: string; binary: string }> = {
	"x86_64-pc-windows-msvc": { platform: "windows-x64", binary: "familiar.exe" },
	"x86_64-unknown-linux-gnu": { platform: "linux-x64", binary: "familiar" },
};

function hostTriple(): string {
	const out = Bun.spawnSync(["rustc", "-vV"]).stdout.toString();
	const host = out.match(/^host: (\S+)$/m)?.[1];
	if (!host) throw new Error("rustc -vV printed no host; is Rust installed?");
	return host;
}

const triple = process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
const spec = TARGETS[triple];
if (!spec)
	throw new Error(
		`no core build for ${triple}; use ${Object.keys(TARGETS).join(" or ")}`,
	);

const root = join(import.meta.dir, "..");
const exe = spec.binary.endsWith(".exe") ? ".exe" : "";
const target = join(
	root,
	"src-tauri",
	"binaries",
	`familiar-core-${triple}${exe}`,
);

let source = process.env.FAMILIAR_SIDECAR;
if (!source) {
	const coreDir = join(root, "..", "core");
	const build = Bun.spawnSync(["bun", "scripts/build.ts", spec.platform], {
		cwd: coreDir,
		stdout: "inherit",
		stderr: "inherit",
	});
	if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);
	source = join(
		coreDir,
		"dist",
		`familiar-${core.version}-${spec.platform}`,
		spec.binary,
	);
}
if (!existsSync(source)) throw new Error(`no core at ${source}`);
mkdirSync(join(root, "src-tauri", "binaries"), { recursive: true });
copyFileSync(source, target);
if (!exe) chmodSync(target, 0o755);
console.log(`sidecar: ${target}`);
