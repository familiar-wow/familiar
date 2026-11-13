// End-to-end run without the game: the real addon (in sim/wow.lua) talks to the real companion
// through real files. Needs Lua 5.1 with the bit library, or LuaJIT (set LUA=/path/to/lua).
//
// Every run logs in, benchmarks, says four things, takes a screenshot of its own, soaks with
// combat and the addon list open, reloads, switches to a second character and back, then
// restarts the client; the client keeps addon states across the switch the way build 70888
// does (see sim/wow.lua). Screenshots are encoded as JPEG at quality 50, standing in for the
// client's encoder.
//
//   bun sim/run.ts               an older client: an empty .wav does not play
//   bun sim/run.ts --emptyplays  build 70888 as measured: an empty .wav "plays", a missing
//                                one stays missing; doorbells must switch to the sound length
//   bun sim/run.ts --binary dist/familiar-spike-0.5.0-linux-x64/familiar-spike
//                                the built Linux program instead of the source. The game is a
//                                copy of Lua named Wow.exe, which is how Wine processes look.
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Companion, FAST_TIMING } from "../src/companion.ts";
import { decodeTga, encodePng } from "../src/image.ts";
import { install } from "../src/install.ts";
import { EventLog, readLogs } from "../src/log.ts";
import { buildReport, loadSaved } from "../src/report.ts";
import { list, table, text } from "../src/savedvars.ts";
import { savedVariablesFile, screenshotsDir, wowPaths } from "../src/wow.ts";

const { values: options } = parseArgs({
	args: Bun.argv.slice(2),
	options: {
		emptyplays: { type: "boolean" },
		keep: { type: "boolean" },
		binary: { type: "string" },
	},
});
const flags = options.emptyplays ? ["emptyplays"] : [];
const binary = options.binary ? resolve(options.binary) : undefined;
const root = mkdtempSync(join(tmpdir(), "familiar-sim-"));
const paths = wowPaths(join(root, "_forever_"));
const dataDir = join(root, "data");
const [ACCOUNT, REALM, CHARACTER, SECOND] = [
	"SIM#1",
	"Forever",
	"Spike",
	"Bank",
];
const home = join(paths.accounts, ACCOUNT, REALM, CHARACTER);

for (const dir of [
	paths.addons,
	home,
	join(paths.accounts, ACCOUNT, REALM, SECOND),
	join(paths.accounts, ACCOUNT, "SavedVariables"),
	dataDir,
])
	mkdirSync(dir, { recursive: true });
// Results of version 0.2.0 in its own formats: the addon must drop them.
writeFileSync(
	savedVariablesFile(paths, ACCOUNT),
	'FamiliarSpikeDB = { ["sessions"] = { { ["epoch"] = 7, ["started"] = 1, ["soak"] = { "S|-|1,2,3,4,0.1" }, ["bench"] = { ["selftest"] = "from 0.2.0" } } }, ["nextSignal"] = 601 }\n',
);
// Helpers of 0.4.x that the installer must remove, with their AddOns.txt rows.
for (const name of ["FamiliarSpike_D000", "FamiliarSpike_L01"]) {
	mkdirSync(join(paths.addons, name), { recursive: true });
	writeFileSync(
		join(paths.addons, name, `${name}.toc`),
		"## Title: old\n## X-Familiar-Spike: 1\n",
	);
}
writeFileSync(
	join(home, "AddOns.txt"),
	"FamiliarSpike_D000: enabled\nFamiliarSpike_L01: disabled\n",
);

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

/** Encodes a rendered screenshot the way the client would and puts it in place at once. */
async function develop(announced: string): Promise<void> {
	const [tga = "", target = "", format = ""] = announced.split(" ");
	const raw = readFileSync(tga);
	const png = encodePng(decodeTga(raw));
	const data =
		format === "png"
			? png
			: format === "tga"
				? raw
				: await new Bun.Image(png).jpeg({ quality: 50 }).bytes();
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(`${target}.part`, data);
	renameSync(`${target}.part`, target);
	rmSync(tga);
}

// Client side ---------------------------------------------------------------------
class Client {
	private readonly proc;
	private buffer = "";
	private lines: string[] = [];
	private shots: string[] = [];
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
			flags.join(","),
		];
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
				} else if (line.startsWith("shot ")) this.shots.push(line.slice(5));
				else this.lines.push(line);
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
		for (const shot of this.shots.splice(0)) await develop(shot);
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
	`Sim in ${root} with ${lua}${flags.length ? ` (${flags.join(", ")})` : ""}${binary ? `, companion ${binary}` : ""}`,
);

let client: Client;
/** Quits the client and starts it again: a new process with empty caches. */
let restart: () => Promise<void>;
let finish: () => Promise<string>;

if (binary) {
	const output: string[] = [];
	const times = (text: string) =>
		output.filter((line) => line.includes(text)).length;
	const program = Bun.spawn(
		[binary, "--wow", paths.client, "--data", dataDir],
		{
			cwd: root,
			env: { ...process.env, FAMILIAR_SPIKE_FAST: "1" },
			stdout: "pipe",
			stderr: "inherit",
		},
	);
	void collect(program.stdout, output, "  [companion] ");
	expect(
		await waitFor(() => times("Ctrl+C stops") > 0, 30),
		"program installs the addon and starts",
	);
	const exe = join(root, "Wow.exe");
	copyFileSync(Bun.which(lua) ?? lua, exe);
	chmodSync(exe, 0o755);
	client = new Client(exe);
	await client.ready();
	expect(
		await waitFor(() => times("WoW started") >= 1, 10),
		"program finds the game process",
	);
	restart = async () => {
		expect(
			await waitFor(() => times("WoW closed") >= 1, 10),
			"program notices the game closing",
		);
		client = new Client(exe);
		await client.ready();
		expect(
			await waitFor(() => times("WoW started") >= 2, 10),
			"program finds the restarted game",
		);
	};
	finish = async () => {
		const saved = join(dataDir, `savedvariables-${ACCOUNT}.lua`);
		expect(
			await waitFor(() => existsSync(saved), 10),
			"program picked up SavedVariables",
		);
		expect(
			await waitFor(() => times("WoW closed") >= 2, 10),
			"program notices the game closing again",
		);
		program.kill("SIGINT");
		expect((await program.exited) === 0, "Ctrl+C ends the program cleanly");
		return readFileSync(join(dataDir, "report.md"), "utf8");
	};
} else {
	const result = install(paths, 16001);
	expect(
		result.removed === 2 && result.rows === 2,
		"install removes the helpers of 0.4.x and their rows",
	);
	let pids: number[] = [];
	let saved = 0;
	const companion = new Companion({
		paths,
		log: new EventLog(join(dataDir, "companion-sim.jsonl")),
		dataDir,
		processes: async () => pids,
		onSaved: () => saved++,
		timing: FAST_TIMING,
	});
	companion.start();
	pids = [4242];
	client = new Client(lua);
	await client.ready();
	await companion.checkGame();
	restart = async () => {
		pids = [];
		await companion.checkGame();
		pids = [4243];
		client = new Client(lua);
		await client.ready();
		await companion.checkGame();
	};
	finish = async () => {
		// The old file at start, then the writes at /reload, the logins and at logout.
		expect(
			await waitFor(() => saved >= 3, 5),
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
	!readdirSync(paths.addons).some((name) => /_(D|L)\d+$/.test(name)),
	"no lane D or slot helper is left",
);
const doorbellMode = options.emptyplays
	? "sound length"
	: "PlaySoundFile result";
expect(
	await client.play(15, () => client.said("Self-test:")),
	"login runs the self-test",
);
expect(client.said("Self-test: ok"), "self-test passes");
expect(
	client.said(`Doorbells: on (${doorbellMode})`),
	`doorbells use the ${doorbellMode}`,
);
expect(
	await client.play(15, () => client.said("Companion answered")),
	"the companion answers the hello",
);
await client.send("slash /fspike bench");
expect(
	await client.play(240, () => client.said("Benchmark done")),
	"benchmark finishes",
);
expect(client.said("Lane U done."), "benchmark sends over lane U");
expect(client.said("Doorbell normal: heard."), "doorbell heard");
expect(
	client.said("Doorbell soundoff:0: not heard while set."),
	"doorbell silent while the sound is off",
);
expect(
	client.said("Round trip via lane U: ") &&
		client.said("Round trip via screenshot (bright, 1 frame): "),
	"round trips over both paths",
);

console.log(
	"/fspike say, four times: lane, screenshot, lane, muted screenshot",
);
for (let n = 1; n <= 4; n++) {
	const from = client.chat.length;
	await client.send(
		`slash /fspike say Hello Familiar ${n}, where is the bank?`,
	);
	expect(
		await client.play(20, () => client.said(`#${n} answered in`, from)),
		`say #${n} is answered`,
	);
	expect(
		client.said(`heard: Hello Familiar ${n}, where is the bank?`, from),
		`say #${n} reply carries the text`,
	);
}
expect(
	client.said("#2 via screenshot (bright, 1 frame)") &&
		client.said("#4 via screenshot (muted, 1 frame)"),
	"say alternates the paths and cycles the styles",
);

// With the soak paused, so the player's picture cannot share a second with one of ours.
console.log("The player takes a screenshot: it must stay where it is");
await client.send("slash /fspike soak off");
await client.play(2);
await client.send("screenshot");
await client.play(2);
await client.send("slash /fspike soak on");
console.log("Soak: open the addon list, fight, reload, play on");
await client.send("list open");
await client.play(2);
await client.send("list close");
await client.send("combat on");
await client.play(14);
await client.send("combat off");
const before = client.chat.length;
await client.send("reload");
expect(
	await client.play(15, () => client.said("Self-test:", before)),
	"reload starts a new session",
);
await client.play(15);
console.log(
	`Switch to ${SECOND} and back: the client keeps addon states across logins`,
);
for (const who of [SECOND, CHARACTER]) {
	const from = client.chat.length;
	await client.send(`login ${who}`);
	expect(
		await client.play(15, () => client.said("Self-test:", from)),
		`login as ${who} starts a new session`,
	);
	await client.play(10);
}
console.log(
	"Restart the client: a new process reads the font bank from the start",
);
await client.send("logout");
await client.close();
await restart();
expect(
	await client.play(15, () => client.said("Companion answered")),
	"the restarted client logs in and hears the companion",
);
await client.send("slash /fspike say After the restart");
expect(
	await client.play(20, () => client.said("#5 answered in")),
	"say works after a restart, from the first font again",
);
await client.play(4);
await client.send("logout");
await client.close();

// Report ------------------------------------------------------------------------------
const report = await finish();
console.log(`\n${report}`);

const verdict = (check: string) =>
	report.split("\n").find((line) => line.includes(`| ${check} |`)) ?? "";
const passed = (check: string) => verdict(check).startsWith("| ✔ |");
for (const check of [
	"Lane U: every message arrives",
	"Addon list: lane category stays collapsed (in game)",
	"Screenshot: every style decodes",
	"Screenshot: picture settings at their limits",
	"Screenshot soak: every message arrives",
	"Screenshot: block shown for one frame is in the picture",
	"Round trip with a 2 KB reply",
	"Doorbell with normal sound, volume 0, sound off",
	"Font bank: replies read",
])
	expect(passed(check), `report: ${check}`);
expect(
	verdict("Screenshot: picture settings at their limits").includes(
		"bright all",
	) &&
		verdict("Screenshot: picture settings at their limits").includes(
			"muted fails at Gamma:0.3",
		),
	"report: the made-up curve breaks muted blocks at Gamma 0.3 only",
);
expect(
	verdict("Screenshot: interface hidden (Alt+Z)").includes(
		"ui parent not in it, world parent in the picture",
	),
	"report: with the interface hidden only the WorldFrame block is in the picture",
);
expect(
	verdict("Doorbell with normal sound, volume 0, sound off").includes(
		"normal heard, volume0 heard, soundoff not heard",
	),
	"report: doorbell rings at volume 0, not with the sound off",
);
// Our pictures with a block are removed; the player's and ours without a block stay.
const pictures = readdirSync(screenshotsDir(paths)).filter((name) =>
	name.startsWith("WoWScrnShot_"),
);
const blank = readLogs(dataDir).filter((e) => e.ev === "shot" && !e.found);
expect(
	pictures.length === blank.length && pictures.length >= 2,
	`screenshots: ${pictures.length} left, the ${blank.length} without a block`,
);
expect(
	report.includes("5 addon session(s)") && !report.includes("from 0.2.0"),
	"results of 0.2.0 are dropped",
);
// The session after /reload runs in the same client process as the benchmark.
const settings = list(loadSaved(dataDir)[0]?.db.sessions).map((s) =>
	text(table(s)?.settings),
);
expect(
	settings.length >= 2 &&
		settings[0] === settings[1] &&
		(settings[0] ?? "").includes("Gamma=1.0;Brightness=50;Contrast=50"),
	"the benchmark puts every setting back",
);
expect(report.includes("No addon errors."), "no addon errors");
expect(report.includes("No companion errors."), "no companion errors");

if (!options.keep) rmSync(root, { recursive: true, force: true });
else console.log(`Kept ${root}`);
console.log(
	failures.length === 0
		? "\nSim passed."
		: `\nSim failed: ${failures.join("; ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
