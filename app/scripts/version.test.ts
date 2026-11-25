// The installer takes its version from app/package.json, the core reports its own, and the
// addon is installed with the core's: all three have to be the same release.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import core from "../../core/package.json" with { type: "json" };
import app from "../package.json" with { type: "json" };

test("app, Rust shell and core carry one version", () => {
	const cargo = readFileSync(
		join(import.meta.dir, "..", "src-tauri", "Cargo.toml"),
		"utf8",
	);
	const rust = cargo.match(/^version = "([^"]+)"$/m)?.[1];
	expect(app.version).toBe(core.version);
	expect(rust).toBe(core.version);
});

test("the installer reads its version from app/package.json", () => {
	const conf = JSON.parse(
		readFileSync(
			join(import.meta.dir, "..", "src-tauri", "tauri.conf.json"),
			"utf8",
		),
	);
	expect(conf.version).toBe("../package.json");
});
