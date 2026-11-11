// End-to-end run without the game: the real addon (in sim/wow.lua) talks to the real companion
// through real files. Needs Lua 5.1 with the bit library, or LuaJIT (set LUA=/path/to/lua).
//
//   bun sim/run.ts             ResetAddOns re-reads AddOns.txt; everything must pass
//   bun sim/run.ts --noreset   ResetAddOns keeps memory; the AddOns.txt downlink must time out
//   bun sim/run.ts --binary dist/familiar-spike-0.2.0-linux-x64/familiar-spike
//                              the built Linux program instead of the source. The game is a
//                              copy of Lua named Wow.exe, which is how Wine processes look.
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Companion } from "../src/companion.ts";
import { install } from "../src/install.ts";
import { EventLog } from "../src/log.ts";
import { buildReport } from "../src/report.ts";
import { savedVariablesFile, wowPaths } from "../src/wow.ts";

const { values: options } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		noreset: { type: "boolean" },
		keep: { type: "boolean" },
		binary: { type: "string" },
	},
});
const noReset = options.noreset === true;
const binary = options.binary ? resolve(options.binary) : undefined;
const root = mkdtempSync(join(tmpdir(), "familiar-sim-"));
const paths = wowPaths(join(root, "_forever_"));
const dataDir = join(root, "data");
const [ACCOUNT, REALM, CHARACTER] = ["SIM#1", "Forever", "Spike"];

for (const dir of [
	paths.addons,
	join(paths.accounts, ACCOUNT, REALM, CHARACTER),
	join(paths.accounts, ACCOUNT, "SavedVariables"),
	dataDir,
])
	mkdirSync(dir, { recursive: true });

function findLua(): string {
	const candidates = [process.env.LUA, "luajit", "lua5.1", "lua"].filter(
		Boolean,
	) as string[];
	for (const candidate of candidates) {
		const probe = Bun.spawnSync([
			candidate,
			"-e",
			"assert(bit and bit.bxor and setfenv)",
		]);
		if (probe.exitCode === 0) return candidate;
	}
	throw new Error(
		"No Lua 5.1 with bit found. Install LuaJIT or set LUA=/path/to/lua5.1",
	);
}

/** Collects a child's output line by line and echoes it. */
async function collect(
	stream: ReadableStream<Uint8Array>,
	lines: string[],
	prefix: string,
): Promise<void> {
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of stream) {
		buffer += decoder.decode(chunk, { stream: true });
		let at = buffer.indexOf("\n");
		while (at !== -1) {
			const line = buffer.slice(0, at);
			buffer = buffer.slice(at + 1);
			lines.push(line);
			console.log(`${prefix}${line}`);
			at = buffer.indexOf("\n");
		}
	}
}

async function waitFor(
	condition: () => boolean,
	seconds: number,
): Promise<boolean> {
	const end = Date.now() + seconds * 1000;
	while (!condition()) {
		if (Date.now() > end) return false;
		await Bun.sleep(100);
	}
	return true;
}

// Client side ---------------------------------------------------------------------
class Client {
	private readonly proc;
	private buffer = "";
	private lines: string[] = [];
	private waiting?: () => void;
	readonly chat: string[] = [];
	private readonly decoder = new TextDecoder();

	constructor(lua: string) {
		const names = join(root, "addons.list");
		writeFileSync(names, `${readdirSync(paths.addons).join("\n")}\n`);
		const args = [
			join(import.meta.dir, "wow.lua"),
			paths.client,
			ACCOUNT,
			REALM,
			CHARACTER,
			names,
		];
		if (noReset) args.push("noreset");
		this.proc = Bun.spawn([lua, ...args], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "inherit",
		});
		void this.pump();
	}

	private async pump(): Promise<void> {
		for await (const chunk of this.proc.stdout) {
			this.buffer += this.decoder.decode(chunk, { stream: true });
			let at = this.buffer.indexOf("\n");
			while (at !== -1) {
				const line = this.buffer.slice(0, at);
				this.buffer = this.buffer.slice(at + 1);
				if (line.startsWith("chat ")) {
					this.chat.push(line.slice(5));
					console.log(`  [game] ${line.slice(5)}`);
				} else this.lines.push(line);
				at = this.buffer.indexOf("\n");
			}
			this.waiting?.();
		}
		this.waiting?.();
	}

	private async reply(): Promise<void> {
		const deadline = Date.now() + 30_000;
		while (this.lines.length === 0) {
			if (Date.now() > deadline || this.proc.exitCode !== null)
				throw new Error("client stopped answering");
			await new Promise<void>((resolve) => {
				this.waiting = resolve;
				setTimeout(resolve, 100);
			});
		}
		const line = this.lines.shift() ?? "";
		if (line !== "ok") throw new Error(`client: ${line}`);
	}

	async ready(): Promise<void> {
		await this.reply();
	}

	async send(command: string): Promise<void> {
		this.proc.stdin.write(`${command}\n`);
		this.proc.stdin.flush();
		await this.reply();
	}

	/** Renders frames at about 60 fps until `until` returns true. */
	async play(seconds: number, until?: () => boolean): Promise<boolean> {
		const end = performance.now() + seconds * 1000;
		while (performance.now() < end) {
			const started = performance.now();
			await this.send(`frame ${Date.now()} ${performance.now().toFixed(3)}`);
			if (until?.()) return true;
			const rest = 16.7 - (performance.now() - started);
			if (rest > 0) await Bun.sleep(rest);
		}
		return false;
	}

	said(text: string, from = 0): boolean {
		return this.chat.slice(from).some((line) => line.includes(text));
	}

	async close(): Promise<void> {
		this.proc.stdin.end();
		await this.proc.exited;
	}
}

// Run --------------------------------------------------------------------------------
const failures: string[] = [];
const expect = (ok: boolean, what: string) => {
	console.log(`${ok ? "✔" : "✘"} ${what}`);
	if (!ok) failures.push(what);
};

const lua = findLua();
console.log(
	`Sim in ${root} with ${lua}${noReset ? " (ResetAddOns keeps memory)" : ""}${binary ? `, companion ${binary}` : ""}`,
);

let client: Client;
let finish: () => Promise<string>;

if (binary) {
	const output: string[] = [];
	const said = (text: string) => output.some((line) => line.includes(text));
	const program = Bun.spawn(
		[binary, "--wow", paths.client, "--data", dataDir],
		{ cwd: root, stdout: "pipe", stderr: "inherit" },
	);
	void collect(program.stdout, output, "  [companion] ");
	expect(
		await waitFor(() => said("Ctrl+C stops"), 30),
		"program installs the addon and starts",
	);
	const exe = join(root, "Wow.exe");
	copyFileSync(Bun.which(lua) ?? lua, exe);
	chmodSync(exe, 0o755);
	client = new Client(exe);
	await client.ready();
	expect(
		await waitFor(() => said("WoW started"), 10),
		"program finds the game process",
	);
	finish = async () => {
		const saved = join(dataDir, `savedvariables-${ACCOUNT}.lua`);
		expect(
			await waitFor(() => existsSync(saved), 10),
			"program picked up SavedVariables",
		);
		expect(
			await waitFor(() => said("WoW closed"), 10),
			"program notices the game closing",
		);
		program.kill("SIGINT");
		expect((await program.exited) === 0, "Ctrl+C ends the program cleanly");
		return readFileSync(join(dataDir, "report.md"), "utf8");
	};
} else {
	install(paths, 16001);
	let pids: number[] = [];
	let saved = 0;
	const companion = new Companion({
		paths,
		log: new EventLog(join(dataDir, "companion-sim.jsonl")),
		processes: async () => pids,
		onSaved: () => saved++,
	});
	companion.start();
	pids = [4242];
	client = new Client(lua);
	await client.ready();
	await companion.checkGame();
	finish = async () => {
		expect(
			await waitFor(() => saved > 0, 5),
			"companion picked up SavedVariables",
		);
		companion.stop();
		await Bun.write(
			join(dataDir, `savedvariables-${ACCOUNT}.lua`),
			Bun.file(savedVariablesFile(paths, ACCOUNT)),
		);
		const report = buildReport(dataDir);
		writeFileSync(join(dataDir, "report.md"), report);
		return report;
	};
}

expect(
	await client.play(15, () => client.said("Companion connected")),
	"first login connects",
);
await client.send("slash /fspike bench");
expect(
	await client.play(150, () => client.said("Benchmark done")),
	"benchmark finishes",
);

console.log("Soak: open the addon list, fight, reload, play on");
await client.send("list open");
await client.play(2);
await client.send("list close");
await client.send("combat on");
await client.play(8);
await client.send("combat off");
const before = client.chat.length;
await client.send("reload");
expect(
	await client.play(15, () => client.said("Companion connected", before)),
	"reload reconnects",
);
await client.play(10);
await client.send("logout");
await client.close();

// Report ------------------------------------------------------------------------------
const report = await finish();
console.log(`\n${report}`);

const verdict = (channel: string) =>
	report.split("\n").find((line) => line.includes(channel)) ?? "";
expect(report.includes("Self-test: ok"), "self-test passes");
expect(verdict("Uplink: AddOns.txt lane").startsWith("| ✔"), "uplink verdict");
expect(verdict("Doorbell:").startsWith("| ✔"), "doorbell verdict");
expect(verdict("load-on-demand slot").startsWith("| ✔"), "slot verdict");
// The sim plays for seconds, not the 60 minutes the verdict needs: "?" is expected.
expect(
	verdict("Soak while playing").startsWith("| ?") &&
		verdict("Soak while playing").includes(" 0 failed"),
	"soak has no failures",
);
if (noReset)
	expect(
		verdict("Downlink: AddOns.txt lane").includes("timeout"),
		"downlink times out without re-read",
	);
else
	expect(
		verdict("Downlink: AddOns.txt lane").startsWith("| ✔"),
		"downlink verdict",
	);
expect(!report.includes("## Addon errors"), "no addon errors");

if (!options.keep) rmSync(root, { recursive: true, force: true });
else console.log(`Kept ${root}`);
console.log(
	failures.length === 0
		? "\nSim passed."
		: `\nSim failed: ${failures.join("; ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
