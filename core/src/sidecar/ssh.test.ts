import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Runner, type RunResult, run as realRun } from "./run.ts";
import { memoryStore, names } from "./secrets.ts";
import {
	askpassEnv,
	askpassMain,
	checkAuth,
	hostKey,
	problems,
	resolveHost,
	type SshAgentConfig,
	SshError,
	type SshHost,
	sshCommand,
	testConnection,
	trustHost,
} from "./ssh.ts";

const SECRET = "hunter2-correct-horse";
const ASKPASS = ["C:\\Program Files\\Familiar\\familiar.exe"];

// `ssh -G gamer` with a Host entry in the config (OpenSSH 10.0), shortened.
const G_ALIAS = `host gamer
user max
hostname 192.168.1.50
port 2222
addressfamily any
batchmode no
hostkeyalias gamerbox
identityfile ~/.ssh/work key
identityfile /abs/id_x
globalknownhostsfile /etc/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2
userknownhostsfile /home/max/.ssh/known_hosts /home/max/.ssh/known_hosts2
proxyjump bastion
`;

/** `ssh -G <name>` for a name no config knows: ssh's defaults. */
function gPlain(hostname: string, port = 22): string {
	return `host ${hostname}
user player
hostname ${hostname}
port ${port}
addressfamily any
identityfile ~/.ssh/id_rsa
identityfile ~/.ssh/id_ecdsa
identityfile ~/.ssh/id_ed25519
globalknownhostsfile /etc/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2
userknownhostsfile /home/player/.ssh/known_hosts /home/player/.ssh/known_hosts2
`;
}

interface Call {
	cmd: string[];
	opts?: Parameters<Runner>[1];
}

/** A runner that answers from `answer` and notes what it was asked to run. */
function fakeRunner(answer: (cmd: string[]) => Partial<RunResult>): {
	run: Runner;
	calls: Call[];
} {
	const calls: Call[] = [];
	return {
		calls,
		run: async (cmd, opts) => {
			calls.push({ cmd, opts });
			return {
				code: 0,
				stdout: "",
				stderr: "",
				timedOut: false,
				...answer(cmd),
			};
		},
	};
}

/** A real key pair made by ssh-keygen, with the fingerprint ssh-keygen prints for it. */
interface TestKey {
	type: string;
	blob: string;
	fingerprint: string;
}

let dir: string;
let ed: TestKey;
let rsa: TestKey;
let ecdsa: TestKey;
let other: TestKey;

async function makeKey(name: string, type: string): Promise<TestKey> {
	const file = join(dir, name);
	const made = await realRun(
		["ssh-keygen", "-q", "-t", type, "-N", "", "-f", file],
		{ timeoutMs: 30_000 },
	);
	expect(made.code).toBe(0);
	const [keyType = "", blob = ""] = readFileSync(`${file}.pub`, "utf8").split(
		" ",
	);
	const printed = await realRun(["ssh-keygen", "-lf", `${file}.pub`]);
	const fingerprint = printed.stdout.match(/SHA256:\S+/)?.[0] ?? "";
	expect(fingerprint).not.toBe("");
	return { type: keyType, blob, fingerprint };
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "familiar-ssh-test-"));
	[ed, rsa, ecdsa, other] = await Promise.all([
		makeKey("ed", "ed25519"),
		makeKey("rsa", "rsa"),
		makeKey("ecdsa", "ecdsa"),
		makeKey("other", "ed25519"),
	]);
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** What ssh-keyscan prints for a host with these keys. */
function scanned(name: string, ...keys: TestKey[]): string {
	return keys.map((k) => `${name} ${k.type} ${k.blob}\n`).join("");
}

/**
 * ssh and ssh-keyscan are played; ssh-keygen is the real one and reads the known hosts file
 * of the test.
 */
function hostRunner(g: string, scan: string): { run: Runner; calls: Call[] } {
	const calls: Call[] = [];
	return {
		calls,
		run: async (cmd, opts) => {
			calls.push({ cmd, opts });
			if (cmd[0] === "ssh-keygen") return await realRun(cmd, opts);
			if (cmd[0] === "ssh")
				return { code: 0, stdout: g, stderr: "", timedOut: false };
			// Like the real one, it only returns the kinds of key it was asked for.
			const kinds = (cmd[cmd.indexOf("-t") + 1] ?? "").split(",");
			const stdout = scan
				.split("\n")
				.filter((line) =>
					kinds.some(
						(kind) => line.includes(` ${kind}-`) || line.includes(`-${kind} `),
					),
				)
				.map((line) => `${line}\n`)
				.join("");
			return { code: stdout ? 0 : 1, stdout, stderr: "", timedOut: false };
		},
	};
}

let files = 0;
/** A fresh path for a known hosts file; nothing is there yet. */
function knownHostsPath(): string {
	files += 1;
	return join(dir, `home-${files}`, ".ssh", "known_hosts");
}

async function failure(work: () => Promise<unknown>): Promise<unknown> {
	try {
		await work();
		return undefined;
	} catch (error) {
		return error;
	}
}

// --- resolveHost

test("resolveHost reads an alias and sees that the config changed it", async () => {
	let emptyConfig = "";
	const { run, calls } = fakeRunner((cmd) => {
		const flag = cmd.indexOf("-F");
		if (flag < 0) return { stdout: G_ALIAS };
		emptyConfig = cmd[flag + 1] ?? "";
		// The file for the second run must be there, and empty.
		expect(readFileSync(emptyConfig, "utf8")).toBe("");
		return { stdout: gPlain("gamer") };
	});
	expect(await resolveHost("gamer", { run })).toEqual({
		host: "gamer",
		hostname: "192.168.1.50",
		user: "max",
		port: 2222,
		identityFiles: ["~/.ssh/work key", "/abs/id_x"],
		proxyJump: "bastion",
		hostKeyAlias: "gamerbox",
		fromConfig: true,
	});
	expect(calls.map((c) => c.cmd)).toEqual([
		["ssh", "-G", "gamer"],
		["ssh", "-G", "-F", emptyConfig, "gamer"],
	]);
	expect(existsSync(emptyConfig)).toBe(false);
});

test("resolveHost gives ssh's defaults for a name no config knows", async () => {
	// ssh prints the name in lower case; that alone is no sign of a config entry.
	const { run } = fakeRunner(() => ({ stdout: gPlain("some-box") }));
	expect(await resolveHost("Some-Box", { run })).toEqual({
		host: "Some-Box",
		hostname: "some-box",
		user: "player",
		port: 22,
		identityFiles: ["~/.ssh/id_rsa", "~/.ssh/id_ecdsa", "~/.ssh/id_ed25519"],
		fromConfig: false,
	});
});

test("resolveHost understands what the real ssh -G prints", async () => {
	const config = join(dir, "config");
	writeFileSync(
		config,
		'Host gamer\n  HostName 192.168.1.50\n  User max\n  Port 2222\n  IdentityFile "~/.ssh/work key"\n  ProxyJump bastion\nHost piped\n  HostKeyAlias PipedBox\n  ProxyCommand nc %h %p\nHost direct\n  ProxyJump none\n  ProxyCommand none\n',
	);
	// The player's config is replaced by the test's; the second run brings its own -F.
	const run: Runner = (cmd, opts) =>
		realRun(
			cmd.includes("-F") ? cmd : ["ssh", "-G", "-F", config, ...cmd.slice(2)],
			opts,
		);
	expect(await resolveHost("gamer", { run })).toEqual({
		host: "gamer",
		hostname: "192.168.1.50",
		user: "max",
		port: 2222,
		identityFiles: ["~/.ssh/work key"],
		proxyJump: "bastion",
		fromConfig: true,
	});
	// The other way through something else, and the name ssh's prompts will show.
	const piped = await resolveHost("piped", { run });
	expect(piped.proxyCommand).toBe("nc %h %p");
	expect(piped.proxyJump).toBeUndefined();
	expect(piped.hostKeyAlias).toBe("pipedbox");
	const direct = await resolveHost("direct", { run });
	expect(direct.proxyJump).toBeUndefined();
	expect(direct.proxyCommand).toBeUndefined();
	const plain = await resolveHost("Other-Box", { run });
	expect(plain.hostname).toBe("other-box");
	expect(plain.port).toBe(22);
	expect(plain.user).not.toBe("");
	expect(plain.identityFiles.length).toBeGreaterThan(0);
	expect(plain.proxyJump).toBeUndefined();
	expect(plain.fromConfig).toBe(false);
});

test("a name that ssh could take for an option or a shell could run is refused", async () => {
	const { run, calls } = fakeRunner(() => ({ stdout: gPlain("x") }));
	for (const host of [
		"",
		"-oProxyCommand=calc",
		"box name",
		"box;calc",
		"$(calc)",
		"box\nname",
		"`calc`",
	]) {
		for (const work of [
			() => resolveHost(host, { run }),
			() => hostKey(host, { run, knownHosts: knownHostsPath() }),
			() =>
				trustHost(host, ed.fingerprint, { run, knownHosts: knownHostsPath() }),
			async () => sshCommand(agent({ host }), { askpass: ASKPASS }),
		]) {
			const error = await failure(work);
			expect(error).toBeInstanceOf(SshError);
			expect((error as Error).message).toBe(
				"That computer name cannot be used.",
			);
		}
	}
	expect(calls).toEqual([]);
});

test("resolveHost says so when ssh is missing or refuses", async () => {
	const missing = fakeRunner(() => ({ code: null, stderr: "ENOENT" }));
	expect(
		((await failure(() => resolveHost("box", missing))) as Error).message,
	).toBe(problems.noSsh);
	const refused = fakeRunner(() => ({
		code: 255,
		stderr: "/home/player/.ssh/config: line 3: Bad configuration option: hots",
	}));
	const error = await failure(() => resolveHost("box", refused));
	expect(error).toBeInstanceOf(SshError);
	expect((error as Error).message).toBe(
		"ssh could not work out that computer. Check the name and your SSH config file.",
	);
});

// --- sshCommand

function agent(over: Partial<SshAgentConfig> = {}): SshAgentConfig {
	return {
		host: "gamer",
		auth: "key",
		command: ["hermes", "acp"],
		port: 47100,
		...over,
	};
}

/** What `checkAuth` found: ssh reaches the computer itself. */
function to(over: Partial<SshHost> = {}): SshHost {
	return {
		host: "gamer",
		hostname: "192.168.1.50",
		user: "max",
		port: 22,
		identityFiles: ["~/.ssh/id_rsa", "~/.ssh/id_ed25519"],
		fromConfig: false,
		...over,
	};
}

test("a test's command forwards no port: the running Familiar may hold it", () => {
	const { command } = sshCommand(
		{ ...agent(), port: undefined },
		{ askpass: [] },
	);
	expect(command).toEqual([
		"ssh",
		"-T",
		"-o",
		"BatchMode=yes",
		"gamer",
		"hermes",
		"acp",
	]);
});

test("sshCommand with a key never asks", () => {
	expect(sshCommand(agent(), { askpass: [] })).toEqual({
		command: [
			"ssh",
			"-T",
			"-o",
			"ExitOnForwardFailure=yes",
			"-R",
			"127.0.0.1:47100:127.0.0.1:47100",
			"-o",
			"BatchMode=yes",
			"gamer",
			"hermes",
			"acp",
		],
		env: {},
	});
});

test("sshCommand with a password lets ssh ask the Familiar program", () => {
	expect(
		sshCommand(
			agent({
				host: "Gamer-PC",
				user: "max",
				auth: "password",
				command: ["npx", "-y", "@agentclientprotocol/codex-acp"],
				resolved: to({ host: "Gamer-PC", hostname: "Gamer-PC.lan" }),
			}),
			{ askpass: ASKPASS },
		),
	).toEqual({
		command: [
			"ssh",
			"-T",
			"-o",
			"ExitOnForwardFailure=yes",
			"-R",
			"127.0.0.1:47100:127.0.0.1:47100",
			"-l",
			"max",
			"-o",
			"NumberOfPasswordPrompts=1",
			"-o",
			"ProxyCommand=none",
			"-o",
			"ProxyJump=none",
			"Gamer-PC",
			"npx",
			"-y",
			"@agentclientprotocol/codex-acp",
		],
		env: {
			SSH_ASKPASS: "C:\\Program Files\\Familiar\\familiar.exe",
			SSH_ASKPASS_REQUIRE: "force",
			DISPLAY: "familiar",
			FAMILIAR_ASKPASS: "ssh-password/gamer-pc",
			// Whom the password is for, as ssh's prompt will name them: in lower case.
			FAMILIAR_ASKPASS_HOST: "max@gamer-pc.lan",
		},
	});
});

test("the password is for the user and the name that ssh's prompt will show", () => {
	const who = (over: Partial<SshAgentConfig>, resolved: Partial<SshHost>) =>
		sshCommand(agent({ auth: "password", ...over, resolved: to(resolved) }), {
			askpass: ASKPASS,
		}).env[askpassEnv.host];
	// Without a user of its own the config's or the local one signs in.
	expect(who({}, { user: "player" })).toBe("player@192.168.1.50");
	expect(who({ user: "root" }, { user: "player" })).toBe("root@192.168.1.50");
	// With a HostKeyAlias ssh shows that instead of the host name.
	expect(who({}, { hostKeyAlias: "GamerBox" })).toBe("max@gamerbox");
});

test("sshCommand with a passphrase lets only the key sign in", () => {
	expect(
		sshCommand(
			agent({
				auth: "passphrase",
				identityFile: "C:\\Users\\Max Muster\\.ssh\\id_ed25519",
				resolved: to(),
			}),
			{ askpass: ASKPASS },
		),
	).toEqual({
		command: [
			"ssh",
			"-T",
			"-o",
			"ExitOnForwardFailure=yes",
			"-R",
			"127.0.0.1:47100:127.0.0.1:47100",
			"-i",
			"C:\\Users\\Max Muster\\.ssh\\id_ed25519",
			"-o",
			"NumberOfPasswordPrompts=1",
			"-o",
			"PreferredAuthentications=publickey",
			"-o",
			"ProxyCommand=none",
			"-o",
			"ProxyJump=none",
			"gamer",
			"hermes",
			"acp",
		],
		env: {
			SSH_ASKPASS: "C:\\Program Files\\Familiar\\familiar.exe",
			SSH_ASKPASS_REQUIRE: "force",
			DISPLAY: "familiar",
			FAMILIAR_ASKPASS: "ssh-passphrase/gamer",
			// The one key the player picked, not every key ssh might try.
			FAMILIAR_ASKPASS_KEY: "C:\\Users\\Max Muster\\.ssh\\id_ed25519",
		},
	});
	// No key picked: the passphrase may open the keys ssh uses for that computer.
	expect(
		sshCommand(agent({ auth: "passphrase", resolved: to() }), {
			askpass: ASKPASS,
		}).env,
	).toMatchObject({
		FAMILIAR_ASKPASS_KEY: "~/.ssh/id_rsa\n~/.ssh/id_ed25519",
	});
});

test("sshCommand uses no saved secret before checkAuth has looked", () => {
	const refused = (over: Partial<SshAgentConfig>) => {
		try {
			sshCommand(agent(over), { askpass: ASKPASS });
		} catch (error) {
			expect(error).toBeInstanceOf(SshError);
			return (error as Error).message;
		}
		return "accepted";
	};
	const unchecked = "The sign-in for that computer has not been checked yet.";
	for (const auth of ["password", "passphrase"] as const) {
		expect(refused({ auth })).toBe(unchecked);
		// What was found out about another computer says nothing about this one.
		expect(refused({ auth, resolved: to({ host: "other" }) })).toBe(unchecked);
		// The computer in between would ask through the same SSH_ASKPASS.
		expect(refused({ auth, resolved: to({ proxyJump: "bastion" }) })).toBe(
			problems.viaJump,
		);
		expect(
			refused({ auth, resolved: to({ proxyCommand: "ssh -W %h:%p bastion" }) }),
		).toBe(problems.viaJump);
		expect(refused({ auth, resolved: to() })).toBe("accepted");
	}
	expect(refused({ auth: "password", resolved: to({ user: "" }) })).toBe(
		unchecked,
	);
	expect(
		refused({ auth: "passphrase", resolved: to({ identityFiles: [] }) }),
	).toBe(unchecked);
	// A key that needs no secret may go through another computer.
	expect(refused({ auth: "key", resolved: to({ proxyJump: "bastion" }) })).toBe(
		"accepted",
	);
});

// --- checkAuth

/** `ssh -G` for the agent's computer; `more` are lines the SSH config adds. */
function gGamer(more = ""): string {
	return `${gPlain("gamer").replace("user player", "user max")}${more}`;
}

test("checkAuth asks ssh about the very command that will run", async () => {
	const { run, calls } = fakeRunner(() => ({ stdout: gGamer() }));
	const c = agent({
		auth: "password",
		user: "max",
		identityFile: "/keys/id",
		cwd: "/srv/my games",
	});
	const checked = await checkAuth(c, { run });
	expect(checked).toEqual({
		...c,
		resolved: {
			host: "gamer",
			hostname: "gamer",
			user: "max",
			port: 22,
			identityFiles: ["~/.ssh/id_rsa", "~/.ssh/id_ecdsa", "~/.ssh/id_ed25519"],
			fromConfig: false,
		},
	});
	// The user, the key and the command are there for `Match` blocks to see; the options
	// that switch a ProxyJump off are not, or there would be nothing to find.
	const words = [
		"-T",
		"-o",
		"ExitOnForwardFailure=yes",
		"-R",
		"127.0.0.1:47100:127.0.0.1:47100",
		"-l",
		"max",
		"-i",
		"/keys/id",
		"-o",
		"NumberOfPasswordPrompts=1",
		"gamer",
		"cd",
		"'/srv/my games'",
		"&&",
		"hermes",
		"acp",
	];
	expect(calls.map((call) => call.cmd)).toEqual([
		["ssh", "-G", ...words],
		["ssh", "-G", "-F", calls[1]?.cmd[3] ?? "", ...words],
	]);
	// The result is what sshCommand needs.
	expect(sshCommand(checked, { askpass: ASKPASS }).env).toMatchObject({
		FAMILIAR_ASKPASS_HOST: "max@gamer",
	});
});

test("checkAuth refuses a saved secret for a computer behind another one", async () => {
	for (const auth of ["password", "passphrase"] as const) {
		for (const line of ["proxyjump bastion\n", "proxycommand nc %h %p\n"]) {
			const { run } = fakeRunner(() => ({ stdout: gGamer(line) }));
			const error = await failure(() => checkAuth(agent({ auth }), { run }));
			expect(error).toBeInstanceOf(SshError);
			expect((error as Error).message).toBe(problems.viaJump);
		}
	}
});

test("checkAuth takes a jump that the config switched off for none", async () => {
	// ssh leaves such a setting out; should a version print it, "none" is not a computer.
	const { run } = fakeRunner(() => ({
		stdout: gGamer("proxyjump none\nproxycommand none\n"),
	}));
	const checked = await checkAuth(agent({ auth: "password" }), { run });
	expect(checked.resolved?.proxyJump).toBeUndefined();
	expect(checked.resolved?.proxyCommand).toBeUndefined();
});

test("checkAuth has nothing to ask when a key signs in", async () => {
	const { run, calls } = fakeRunner(() => ({
		stdout: gGamer("proxyjump x\n"),
	}));
	const c = agent();
	expect(await checkAuth(c, { run })).toBe(c);
	expect(calls).toEqual([]);
});

test("checkAuth does not run ssh for settings it cannot use", async () => {
	const { run, calls } = fakeRunner(() => ({ stdout: gGamer() }));
	for (const over of [
		{ host: "-oProxyCommand=calc" },
		{ user: "-oProxyCommand=calc" },
		{ command: ["-oProxyCommand=calc"] },
	])
		expect(
			await failure(() =>
				checkAuth(agent({ auth: "password", ...over }), { run }),
			),
		).toBeInstanceOf(SshError);
	expect(calls).toEqual([]);
});

test("with the real ssh: a jump that depends on the user is seen, and switched off", async () => {
	const config = join(dir, "config-jump");
	writeFileSync(
		config,
		"Host gamer\n  HostName 192.168.1.50\n  User max\nHost behind\n  ProxyJump bastion\nHost piped\n  ProxyCommand nc %h %p\nMatch originalhost gamer user root\n  ProxyJump bastion\n",
	);
	// The player's config is replaced by the test's; the second run brings its own -F.
	const run: Runner = (cmd, opts) =>
		realRun(
			cmd.includes("-F") ? cmd : ["ssh", "-G", "-F", config, ...cmd.slice(2)],
			opts,
		);
	const checked = await checkAuth(agent({ auth: "password" }), { run });
	expect(checked.resolved).toMatchObject({
		hostname: "192.168.1.50",
		user: "max",
		fromConfig: true,
	});
	// The same computer as root goes through the bastion: only seen with the user passed on.
	for (const over of [{ user: "root" }, { host: "behind" }, { host: "piped" }])
		expect(
			(
				(await failure(() =>
					checkAuth(agent({ auth: "password", ...over }), { run }),
				)) as Error
			).message,
		).toBe(problems.viaJump);

	// Whatever the config says by the time ssh runs, the command itself goes direct.
	for (const over of [
		{ user: "root" },
		{ host: "behind" },
		{ host: "piped" },
	]) {
		const c = agent({ auth: "password", ...over });
		const { command } = sshCommand(
			{ ...c, resolved: to({ host: c.host }) },
			{ askpass: ASKPASS },
		);
		const asRun = await realRun([
			"ssh",
			"-G",
			"-F",
			config,
			...command.slice(1),
		]);
		expect(asRun.code).toBe(0);
		expect(asRun.stdout).toContain("\nhostname ");
		expect(asRun.stdout).not.toMatch(/^proxy(jump|command) /m);
	}
});

test("command words arrive as single words on the other computer", () => {
	const words = (over: Partial<SshAgentConfig>) =>
		sshCommand(agent(over), { askpass: [] }).command.slice(9);
	// Each word stays its own item; one that the shell there would split or run is quoted.
	expect(
		words({ command: ["/opt/my agent/run", "--name=it's", "a;b", ""] }),
	).toEqual(["'/opt/my agent/run'", "'--name=it'\\''s'", "'a;b'", "''"]);
	expect(words({ cwd: "/srv/my games" })).toEqual([
		"cd",
		"'/srv/my games'",
		"&&",
		"hermes",
		"acp",
	]);
	// The shell there still expands the home folder.
	expect(words({ cwd: "~/my games" }).slice(0, 3)).toEqual([
		"cd",
		"~/'my games'",
		"&&",
	]);
	expect(words({ cwd: "-" })[1]).toBe("./-");
});

test("the quoted words mean the same to a real shell", async () => {
	const command = ["printf", "%s\\n", "two words", "it's", "a;b", "$HOME", ""];
	const words = sshCommand(agent({ command }), { askpass: [] }).command.slice(
		9,
	);
	// What ssh does: join with spaces, and the shell on the other side reads the line.
	const r = await realRun(["sh", "-c", words.join(" ")]);
	expect(r.stdout).toBe("two words\nit's\na;b\n$HOME\n\n");
});

test("sshCommand refuses what would not run as meant", () => {
	const refused = (over: Partial<SshAgentConfig>, askpass = ASKPASS) => {
		try {
			sshCommand(agent(over), { askpass });
		} catch (error) {
			expect(error).toBeInstanceOf(SshError);
			return (error as Error).message;
		}
		return "accepted";
	};
	// ssh would take a leading "-" after the host for one of its own options.
	expect(refused({ command: ["-oProxyCommand=calc"] })).toBe(
		"That agent command cannot be used.",
	);
	expect(refused({ command: [] })).toBe("That agent command cannot be used.");
	expect(refused({ user: "-oProxyCommand=calc" })).toBe(
		"That user name cannot be used.",
	);
	expect(refused({ user: "max;calc" })).toBe("That user name cannot be used.");
	expect(refused({ user: "WORKGROUP\\max" })).toBe("accepted");
	expect(refused({ identityFile: "key\nfile" })).toBe(
		"That key file cannot be used.",
	);
	for (const port of [0, 65536, 1.5, Number.NaN])
		expect(refused({ port })).toBe("That port cannot be used.");
	// SSH_ASKPASS is one program; ssh would not pass arguments on.
	for (const askpass of [[], ["familiar", "askpass"], [""]])
		expect(refused({ auth: "password", resolved: to() }, askpass)).toBe(
			"The program that answers ssh's password prompt must be one path without arguments.",
		);
});

// --- hostKey and trustHost

test("the fingerprint is the one ssh-keygen prints", async () => {
	const { run, calls } = hostRunner(gPlain("box"), scanned("box", ed));
	const knownHosts = knownHostsPath();
	expect(await hostKey("box", { run, knownHosts })).toEqual({
		known: false,
		fingerprint: ed.fingerprint,
	});
	expect(calls.map((c) => c.cmd)).toEqual([
		["ssh", "-G", "box"],
		["ssh-keygen", "-F", "box", "-f", knownHosts],
		["ssh-keyscan", "-T", "5", "-p", "22", "-t", "ed25519", "box"],
	]);
});

test("hostKey shows the key ssh would pick, with as few visits as possible", async () => {
	// A server counts every scan against this computer, so the usual kind is asked for alone.
	const usual = hostRunner(gPlain("box"), scanned("box", rsa, ecdsa, ed));
	const shown = await hostKey("box", {
		run: usual.run,
		knownHosts: knownHostsPath(),
	});
	expect(shown.fingerprint).toBe(ed.fingerprint);
	expect(usual.calls.filter((c) => c.cmd[0] === "ssh-keyscan")).toHaveLength(1);

	// Only an older server is asked a second time, and ssh would pick ECDSA before RSA there.
	const older = hostRunner(gPlain("box"), scanned("box", rsa, ecdsa));
	expect(
		(await hostKey("box", { run: older.run, knownHosts: knownHostsPath() }))
			.fingerprint,
	).toBe(ecdsa.fingerprint);
	expect(
		older.calls
			.filter((c) => c.cmd[0] === "ssh-keyscan")
			.map((c) => c.cmd[c.cmd.indexOf("-t") + 1]),
	).toEqual(["ed25519", "ecdsa,rsa"]);
});

test("hostKey has no fingerprint when the computer does not answer", async () => {
	const { run } = hostRunner(gPlain("box"), "");
	expect(await hostKey("box", { run, knownHosts: knownHostsPath() })).toEqual({
		known: false,
	});
});

test("trustHost saves the confirmed key, and ssh-keygen then knows the host", async () => {
	const { run } = hostRunner(gPlain("box"), scanned("box", rsa, ed));
	const knownHosts = knownHostsPath();
	await trustHost("box", ed.fingerprint, { run, knownHosts });
	// Only the confirmed key, not everything the scan returned.
	expect(readFileSync(knownHosts, "utf8")).toBe(`box ${ed.type} ${ed.blob}\n`);
	expect(await hostKey("box", { run, knownHosts })).toEqual({
		known: true,
		fingerprint: ed.fingerprint,
	});
	// Trusting it again changes nothing.
	await trustHost("box", ed.fingerprint, { run, knownHosts });
	expect(readFileSync(knownHosts, "utf8")).toBe(`box ${ed.type} ${ed.blob}\n`);
});

test("trustHost refuses a key other than the confirmed one", async () => {
	// The player confirmed `ed`; by the time of saving the computer shows `other`.
	const { run } = hostRunner(gPlain("box"), scanned("box", other, rsa));
	const knownHosts = knownHostsPath();
	const error = await failure(() =>
		trustHost("box", ed.fingerprint, { run, knownHosts }),
	);
	expect(error).toBeInstanceOf(SshError);
	expect((error as Error).message).toBe(
		"The other computer shows a different host key than the one you confirmed. Nothing was saved.",
	);
	expect(existsSync(knownHosts)).toBe(false);
});

test("trustHost refuses what is not a fingerprint, before it runs anything", async () => {
	const { run, calls } = hostRunner(gPlain("box"), scanned("box", ed));
	for (const fingerprint of [
		"",
		"SHA256:",
		"yes",
		`MD5:${"ab:".repeat(15)}ab`,
		`${ed.fingerprint}=`,
		ed.fingerprint.toLowerCase().replace("sha256", "SHA256").slice(0, -1),
	]) {
		const error = await failure(() =>
			trustHost("box", fingerprint, { run, knownHosts: knownHostsPath() }),
		);
		expect((error as Error).message).toBe(
			"That is not a host key fingerprint.",
		);
	}
	expect(calls).toEqual([]);
});

test("trustHost does not add a second key to a host that is already known", async () => {
	const knownHosts = knownHostsPath();
	const first = hostRunner(gPlain("box"), scanned("box", ed));
	await trustHost("box", ed.fingerprint, { run: first.run, knownHosts });
	// Later the computer, or someone in its place, shows another key.
	const later = hostRunner(gPlain("box"), scanned("box", other));
	const error = await failure(() =>
		trustHost("box", other.fingerprint, { run: later.run, knownHosts }),
	);
	expect((error as Error).message).toBe(
		"That computer is already known with a different host key. Nothing was saved.",
	);
	expect(readFileSync(knownHosts, "utf8")).toBe(`box ${ed.type} ${ed.blob}\n`);
});

test("trustHost says so when the computer shows no key", async () => {
	const { run } = hostRunner(gPlain("box"), "");
	const knownHosts = knownHostsPath();
	const error = await failure(() =>
		trustHost("box", ed.fingerprint, { run, knownHosts }),
	);
	expect((error as Error).message).toBe(
		"The other computer did not show a host key. Nothing was saved.",
	);
	expect(existsSync(knownHosts)).toBe(false);
});

test("the key is kept under the name ssh looks it up by", async () => {
	// Another port: ssh looks for "[name]:port".
	const ported = hostRunner(gPlain("box", 2222), scanned("[box]:2222", ed));
	const knownHosts = knownHostsPath();
	await trustHost("box", ed.fingerprint, { run: ported.run, knownHosts });
	expect(ported.calls.map((c) => c.cmd).slice(1)).toEqual([
		["ssh-keygen", "-F", "[box]:2222", "-f", knownHosts],
		["ssh-keyscan", "-T", "5", "-p", "2222", "-t", "ed25519", "box"],
	]);
	expect(readFileSync(knownHosts, "utf8")).toBe(
		`[box]:2222 ${ed.type} ${ed.blob}\n`,
	);

	// An alias: the scan goes to the address, the key is kept under HostKeyAlias. The file
	// had no line end; the new line must not be glued to the last one.
	const alias = hostRunner(G_ALIAS, scanned("[192.168.1.50]:2222", rsa));
	await Bun.write(knownHosts, `[box]:2222 ${ed.type} ${ed.blob}`);
	await trustHost("gamer", rsa.fingerprint, { run: alias.run, knownHosts });
	expect(alias.calls.map((c) => c.cmd).slice(1)).toEqual([
		["ssh-keygen", "-F", "gamerbox", "-f", knownHosts],
		["ssh-keyscan", "-T", "5", "-p", "2222", "-t", "ed25519", "192.168.1.50"],
		["ssh-keyscan", "-T", "5", "-p", "2222", "-t", "ecdsa,rsa", "192.168.1.50"],
	]);
	expect(readFileSync(knownHosts, "utf8")).toBe(
		`[box]:2222 ${ed.type} ${ed.blob}\ngamerbox ${rsa.type} ${rsa.blob}\n`,
	);
	expect(await hostKey("gamer", { run: alias.run, knownHosts })).toEqual({
		known: true,
		fingerprint: rsa.fingerprint,
	});
});

test("a host name from the config that looks like an option is not passed on", async () => {
	const { run, calls } = hostRunner(
		gPlain("box").replace("hostname box", "hostname -oProxyCommand=calc"),
		"",
	);
	const error = await failure(() =>
		hostKey("box", { run, knownHosts: knownHostsPath() }),
	);
	expect((error as Error).message).toBe("That computer name cannot be used.");
	expect(calls.map((c) => c.cmd)).toEqual([["ssh", "-G", "box"]]);
});

// --- the known hosts files ssh really uses

/** `ssh -G` for "box" with these known hosts settings instead of the usual ones. */
function gFiles(own: string, shared = "none"): string {
	return gPlain("box")
		.replace(/^userknownhostsfile .*$/m, `userknownhostsfile ${own}`)
		.replace(/^globalknownhostsfile .*$/m, `globalknownhostsfile ${shared}`);
}

/** The known hosts files ssh-keygen was asked to look in. */
function looked(calls: Call[]): (string | undefined)[] {
	return calls
		.filter((c) => c.cmd[0] === "ssh-keygen")
		.map((c) => c.cmd[c.cmd.indexOf("-f") + 1]);
}

test("trustHost writes the file ssh adds keys to, not ~/.ssh/known_hosts", async () => {
	const own = join(dir, "custom", "hosts");
	const second = join(dir, "custom", "hosts2");
	const shared = join(dir, "custom", "system hosts");
	const { run, calls } = hostRunner(
		gFiles(`${own} ${second}`, shared),
		scanned("box", ed),
	);
	// A home folder of the test's: nothing may fall back to the real one.
	const home = join(dir, "home-unused");
	expect(await hostKey("box", { run, home })).toEqual({
		known: false,
		fingerprint: ed.fingerprint,
	});
	expect(looked(calls)).toEqual([own, second, shared]);
	await trustHost("box", ed.fingerprint, { run, home });
	expect(readFileSync(own, "utf8")).toBe(`box ${ed.type} ${ed.blob}\n`);
	expect(existsSync(second)).toBe(false);
	expect(existsSync(shared)).toBe(false);
	expect(existsSync(home)).toBe(false);
	expect(await hostKey("box", { run, home })).toEqual({
		known: true,
		fingerprint: ed.fingerprint,
	});
});

test("a key in any file that ssh reads counts as known", async () => {
	const own = join(dir, "any", "hosts");
	const second = join(dir, "any", "hosts2");
	const shared = join(dir, "any", "system");
	const g = gFiles(`${own} ${second}`, `${join(dir, "any", "none")} ${shared}`);
	for (const file of [second, shared]) {
		await Bun.write(file, `box ${ed.type} ${ed.blob}\n`);
		const { run } = hostRunner(g, scanned("box", other));
		expect(await hostKey("box", { run })).toEqual({
			known: true,
			fingerprint: ed.fingerprint,
		});
		// Trusting what is trusted already writes nothing.
		await trustHost("box", ed.fingerprint, { run });
		// ssh would warn about a changed key; a second key in the player's file would hide that.
		const error = await failure(() =>
			trustHost("box", other.fingerprint, { run }),
		);
		expect((error as Error).message).toBe(
			"That computer is already known with a different host key. Nothing was saved.",
		);
		expect(existsSync(own)).toBe(false);
		rmSync(file);
	}
});

test("a ~ that ssh left in a file name means the home folder", async () => {
	const home = join(dir, "home of max");
	// Older ssh prints the player's files as written; every ssh does so for the system's.
	const { run, calls } = hostRunner(
		gFiles("~/.ssh/known_hosts ~/.ssh/known_hosts2", "~/system /etc/x"),
		scanned("box", ed),
	);
	await trustHost("box", ed.fingerprint, { run, home });
	expect(looked(calls)).toEqual([
		join(home, ".ssh", "known_hosts"),
		join(home, ".ssh", "known_hosts2"),
		join(home, "system"),
		"/etc/x",
	]);
	expect(readFileSync(join(home, ".ssh", "known_hosts"), "utf8")).toBe(
		`box ${ed.type} ${ed.blob}\n`,
	);
});

test("file names with spaces are told apart as far as ssh -G allows", async () => {
	const files = async (own: string, shared?: string) => {
		const { run, calls } = fakeRunner((cmd) =>
			cmd[0] === "ssh" ? { stdout: gFiles(own, shared) } : { code: 1 },
		);
		expect(await hostKey("box", { run, home: "/home/max" })).toEqual({
			known: false,
		});
		return looked(calls);
	};
	expect(
		await files(
			"/home/Max Muster/.ssh/known_hosts /home/Max Muster/.ssh/known  hosts2",
		),
	).toEqual([
		"/home/Max Muster/.ssh/known_hosts",
		"/home/Max Muster/.ssh/known  hosts2",
	]);
	// What ssh prints on Windows for a user name with a space.
	expect(
		await files(
			"C:\\Users\\Max Muster/.ssh/known_hosts C:\\Users\\Max Muster/.ssh/known_hosts2",
			"__PROGRAMDATA__\\ssh/ssh_known_hosts __PROGRAMDATA__\\ssh/ssh_known_hosts2",
		),
	).toEqual([
		"C:\\Users\\Max Muster/.ssh/known_hosts",
		"C:\\Users\\Max Muster/.ssh/known_hosts2",
		`${process.env.ProgramData ?? "C:\\ProgramData"}\\ssh/ssh_known_hosts`,
		`${process.env.ProgramData ?? "C:\\ProgramData"}\\ssh/ssh_known_hosts2`,
	]);
});

test("trustHost saves nothing when the SSH config keeps no file it could write", async () => {
	const shared = join(dir, "nofile", "system");
	// "none" is a setting, not a file name; "~other" only ssh could look up.
	for (const own of ["none", "~other/known_hosts"]) {
		const { run, calls } = hostRunner(gFiles(own, shared), scanned("box", ed));
		const error = await failure(() =>
			trustHost("box", ed.fingerprint, { run }),
		);
		expect(error).toBeInstanceOf(SshError);
		expect((error as Error).message).toBe(
			"Your SSH config names no known hosts file that Familiar can add this computer to. Nothing was saved.",
		);
		// The computer was not even asked, and the system's file is not written instead.
		expect(calls.some((c) => c.cmd[0] === "ssh-keyscan")).toBe(false);
		expect(existsSync(shared)).toBe(false);
		expect(existsSync(own)).toBe(false);
	}
	const { run, calls } = hostRunner(gFiles("none", shared), scanned("box", ed));
	expect(looked(calls)).toEqual([]);
	expect(await hostKey("box", { run })).toEqual({
		known: false,
		fingerprint: ed.fingerprint,
	});
	expect(looked(calls)).toEqual([shared]);
});

test("with the real ssh: the known hosts files of the SSH config are the ones used", async () => {
	const own = join(dir, "real home", "my hosts");
	const shared = join(dir, "real home", "system");
	const config = join(dir, "config-files");
	writeFileSync(
		config,
		`Host box\n  UserKnownHostsFile "${own}" ${join(dir, "real home", "second")}\n  GlobalKnownHostsFile ${shared}\n`,
	);
	const calls: Call[] = [];
	const run: Runner = async (cmd, opts) => {
		calls.push({ cmd, opts });
		if (cmd[0] === "ssh")
			return await realRun(["ssh", "-G", "-F", config, ...cmd.slice(2)], opts);
		if (cmd[0] === "ssh-keygen") return await realRun(cmd, opts);
		return {
			code: 0,
			stdout: scanned("box", ed),
			stderr: "",
			timedOut: false,
		};
	};
	await trustHost("box", ed.fingerprint, { run });
	expect(looked(calls)).toEqual([
		own,
		join(dir, "real home", "second"),
		shared,
	]);
	expect(readFileSync(own, "utf8")).toBe(`box ${ed.type} ${ed.blob}\n`);
	expect(await hostKey("box", { run })).toEqual({
		known: true,
		fingerprint: ed.fingerprint,
	});
});

// --- testConnection

test("testConnection signs in as the agent would and looks for its program", async () => {
	const { run, calls } = fakeRunner((cmd) => ({
		stdout: cmd[1] === "-G" ? gGamer() : "/home/max/.local/bin/hermes\n",
	}));
	expect(
		await testConnection(
			agent({ auth: "password", cwd: "/srv/games", user: "max" }),
			{ run, askpass: ASKPASS },
		),
	).toEqual({
		ok: true,
		agentFound: true,
		agentPath: "/home/max/.local/bin/hermes",
	});
	// First it asks ssh where the real command would go, twice (checkAuth).
	expect(calls.slice(0, 2).map((c) => c.cmd.slice(0, 2))).toEqual([
		["ssh", "-G"],
		["ssh", "-G"],
	]);
	// About the real command, not the one that looks for the program.
	expect(calls[0]?.cmd.slice(-6)).toEqual([
		"gamer",
		"cd",
		"/srv/games",
		"&&",
		"hermes",
		"acp",
	]);
	expect(calls.slice(2)).toEqual([
		{
			cmd: [
				"ssh",
				"-T",
				"-o",
				"ExitOnForwardFailure=yes",
				"-R",
				"127.0.0.1:47100:127.0.0.1:47100",
				"-l",
				"max",
				"-o",
				"NumberOfPasswordPrompts=1",
				"-o",
				"ProxyCommand=none",
				"-o",
				"ProxyJump=none",
				"gamer",
				"sh",
				"-lc",
				// One word for the shell there; unquoted, sh would run "command" alone.
				"'command -v hermes'",
			],
			opts: {
				timeoutMs: 15_000,
				env: {
					SSH_ASKPASS: ASKPASS[0] ?? "",
					SSH_ASKPASS_REQUIRE: "force",
					DISPLAY: "familiar",
					FAMILIAR_ASKPASS: "ssh-password/gamer",
					FAMILIAR_ASKPASS_HOST: "max@gamer",
				},
			},
		},
	]);
});

test("testConnection does not sign in with a saved secret through another computer", async () => {
	for (const auth of ["password", "passphrase"] as const) {
		const { run, calls } = fakeRunner(() => ({
			stdout: gGamer("proxyjump bastion\n"),
		}));
		expect(
			await testConnection(agent({ auth }), { run, askpass: ASKPASS }),
		).toEqual({ ok: false, problem: problems.viaJump });
		// Only the two questions to ssh; no connection was made.
		expect(calls.map((c) => c.cmd[1])).toEqual(["-G", "-G"]);
	}
	// A key without a secret may: ssh is run as before.
	const { run, calls } = fakeRunner(() => ({ stdout: "/usr/bin/hermes\n" }));
	expect(await testConnection(agent(), { run, askpass: [] })).toMatchObject({
		ok: true,
	});
	expect(calls).toHaveLength(1);
});

test("the test command finds a program through a real shell", async () => {
	const check = async (program: string) => {
		const { run, calls } = fakeRunner(() => ({ stdout: "x" }));
		await testConnection(agent({ command: [program, "acp"] }), {
			run,
			askpass: [],
		});
		const words = calls[0]?.cmd.slice(9) ?? [];
		return await realRun(["sh", "-c", words.join(" ")]);
	};
	const found = await check("sh");
	expect(found.code).toBe(0);
	expect(found.stdout.trim()).toEndWith("/sh");
	const missing = await check("familiar no such program; echo found");
	expect(missing.code).not.toBe(0);
	expect(missing.stdout).not.toContain("found");
});

test("testConnection names the problem in fixed words", async () => {
	const cases: [Partial<RunResult>, string, boolean?][] = [
		[
			{ code: 255, stderr: "max@gamer: Permission denied (publickey)." },
			problems.denied,
		],
		[
			{
				code: 255,
				stderr:
					"max@gamer: Permission denied (publickey,password,keyboard-interactive).",
			},
			problems.denied,
		],
		[
			{ code: 255, stderr: "Host key verification failed.\r\n" },
			problems.hostKeyUnknown,
		],
		[
			{
				code: 255,
				stderr:
					"No ED25519 host key is known for gamer and you have requested strict checking.\r\nHost key verification failed.\r\n",
			},
			problems.hostKeyUnknown,
		],
		[
			{
				code: 255,
				stderr:
					"@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nHost key verification failed.\n",
			},
			problems.hostKeyChanged,
		],
		[
			{
				code: 255,
				stderr:
					"ssh: Could not resolve hostname gamer: Name or service not known",
			},
			problems.unreachable,
		],
		[
			{
				code: 255,
				stderr: "ssh: connect to host gamer port 22: Connection refused",
			},
			problems.unreachable,
		],
		[
			{
				code: 255,
				stderr: "ssh: connect to host gamer port 22: Connection timed out",
			},
			problems.timeout,
		],
		[{ code: null, timedOut: true }, problems.timeout],
		[
			{
				code: 255,
				stderr: "Error: remote port forwarding failed for listen port 47100",
			},
			problems.forward,
		],
		[
			{
				code: 255,
				stderr:
					"kex_exchange_identification: read: Connection reset by peer\r\nConnection reset by 192.168.1.50 port 22\r\n",
			},
			problems.closed,
		],
		[
			{ code: 255, stderr: "Connection closed by 192.168.1.50 port 22\r\n" },
			problems.closed,
		],
		[{ code: null, stderr: "ENOENT" }, problems.noSsh],
		[{ code: 255, stderr: "something new" }, problems.failed],
		[
			{ code: 127, stderr: "sh: 1: hermes: not found" },
			problems.agentMissing,
			false,
		],
		[{ code: 1 }, problems.agentMissing, false],
		// Exit code 0 without a path is no proof that the program is there.
		[{ code: 0, stdout: "\n" }, problems.agentMissing, false],
	];
	for (const [result, problem, agentFound] of cases) {
		const { run } = fakeRunner(() => result);
		expect(await testConnection(agent(), { run, askpass: [] })).toEqual({
			ok: false,
			problem,
			...(agentFound === undefined ? {} : { agentFound }),
		});
	}
});

test("testConnection tells where the program is, past what a profile prints", async () => {
	const found = async (stdout: string) => {
		const { run } = fakeRunner(() => ({ stdout }));
		return await testConnection(agent(), { run, askpass: [] });
	};
	expect(await found("Welcome back!\r\n/usr/local/bin/hermes\r\n")).toEqual({
		ok: true,
		agentFound: true,
		agentPath: "/usr/local/bin/hermes",
	});
	// A shell function or an alias is found, but has no path to start it by.
	expect(await found("hermes\n")).toEqual({ ok: true, agentFound: true });
});

test("testConnection does not run ssh for settings it cannot use", async () => {
	const { run, calls } = fakeRunner(() => ({}));
	expect(
		await testConnection(agent({ host: "-oProxyCommand=calc" }), {
			run,
			askpass: [],
		}),
	).toEqual({ ok: false, problem: "That computer name cannot be used." });
	expect(
		await testConnection(agent({ command: ["-oProxyCommand=calc"] }), {
			run,
			askpass: [],
		}),
	).toEqual({ ok: false, problem: "That agent command cannot be used." });
	expect(calls).toEqual([]);
});

// --- askpassMain

const PASSWORD = {
	FAMILIAR_ASKPASS: "ssh-password/gamer",
	FAMILIAR_ASKPASS_HOST: "max@gamer",
};
const PASSPHRASE = {
	FAMILIAR_ASKPASS: "ssh-passphrase/gamer",
	FAMILIAR_ASKPASS_KEY: "~/.ssh/id_ed25519\n/keys/work key",
};
const NOTHING = { code: 1, printed: "" };

/** Runs askpassMain against a store that holds one password and one passphrase. */
async function ask(
	env: Record<string, string | undefined>,
	prompt = "max@gamer's password: ",
	where: { home?: string; platform?: NodeJS.Platform } = {},
): Promise<{ code: number; printed: string }> {
	const store = memoryStore();
	await store.set(names.sshPassword("gamer"), SECRET);
	await store.set(names.sshPassphrase("gamer"), `${SECRET}-key`);
	await store.set(names.apiKey("openai"), `${SECRET}-api`);
	let printed = "";
	const code = await askpassMain([prompt], {
		store,
		env,
		write: (text) => {
			printed += text;
		},
		home: "/home/max",
		platform: "linux",
		...where,
	});
	return { code, printed };
}

test("askpassMain prints the named secret and a newline", async () => {
	const password = { code: 0, printed: `${SECRET}\n` };
	const passphrase = { code: 0, printed: `${SECRET}-key\n` };
	expect(await ask(PASSWORD)).toEqual(password);
	// Keyboard-interactive, as macOS and PAM ask: ssh names the computer, PAM the rest.
	expect(await ask(PASSWORD, "(max@gamer) Password: ")).toEqual(password);
	expect(await ask(PASSWORD, "(max@gamer) Password:")).toEqual(password);
	// The space at the end may get lost on a command line.
	expect(await ask(PASSWORD, "max@gamer's password:")).toEqual(password);
	expect(
		await ask(
			PASSPHRASE,
			"Enter passphrase for key '/home/max/.ssh/id_ed25519': ",
		),
	).toEqual(passphrase);
	expect(
		await ask(PASSPHRASE, "Enter passphrase for key '/keys/work key': "),
	).toEqual(passphrase);
});

test("askpassMain prints nothing when there is nothing to give", async () => {
	expect(await ask({})).toEqual(NOTHING);
	expect(await ask({ ...PASSWORD, FAMILIAR_ASKPASS: "" })).toEqual(NOTHING);
	expect(
		await ask({ ...PASSWORD, FAMILIAR_ASKPASS: "ssh-password/other" }),
	).toEqual(NOTHING);
	const broken = await askpassMain(["max@gamer's password: "], {
		store: {
			get: async () => {
				throw new Error(`keychain broke near ${SECRET}`);
			},
			set: async () => {},
			delete: async () => false,
		},
		env: PASSWORD,
		write: () => {
			throw new Error("must not print");
		},
	});
	expect(broken).toBe(1);
});

test("askpassMain never gives out an API key", async () => {
	expect(
		await ask({ ...PASSWORD, FAMILIAR_ASKPASS: "api-key/openai" }),
	).toEqual(NOTHING);
});

test("askpassMain gives the password to the one computer it is for", async () => {
	for (const prompt of [
		// What the review got an answer to.
		"",
		"unrelated@bastion's password: ",
		// A computer in between, another user, another spelling.
		"max@bastion's password: ",
		"root@gamer's password: ",
		"Max@gamer's password: ",
		"max@gamer.evil.example's password: ",
		"(max@bastion) Password: ",
		// The right name is no reason to answer any question.
		"(max@gamer) Verification code: ",
		"(max@gamer) Enter your API key: ",
		"(max@gamer) ",
		"Enter max@gamer's old password: ",
		"max@gamer's password: \nand more",
		"bastion says: max@gamer's password: ",
		// "Do you trust this host?" is asked through SSH_ASKPASS too.
		"The authenticity of host 'gamer (192.168.1.50)' can't be established.\nED25519 key fingerprint is SHA256:abc.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ",
		// A password is not tried as the passphrase of a key.
		"Enter passphrase for key '/home/max/.ssh/id_ed25519': ",
	])
		expect(await ask(PASSWORD, prompt)).toEqual(NOTHING);
	// A click instead of a secret, whatever the words.
	expect(await ask({ ...PASSWORD, SSH_ASKPASS_PROMPT: "confirm" })).toEqual(
		NOTHING,
	);
	// Without a recipient nobody is one, and a key file is not a computer.
	expect(await ask({ FAMILIAR_ASKPASS: "ssh-password/gamer" })).toEqual(
		NOTHING,
	);
	expect(await ask({ ...PASSWORD, FAMILIAR_ASKPASS_HOST: "" })).toEqual(
		NOTHING,
	);
	expect(
		await ask(
			{ ...PASSWORD, FAMILIAR_ASKPASS_KEY: "/home/max/.ssh/id_ed25519" },
			"Enter passphrase for key '/home/max/.ssh/id_ed25519': ",
		),
	).toEqual(NOTHING);
});

test("askpassMain gives the passphrase to ssh's question about its key only", async () => {
	for (const prompt of [
		"",
		// Another key, also one whose path only starts or ends the same.
		"Enter passphrase for key '/home/max/.ssh/id_rsa': ",
		"Enter passphrase for key '/home/max/.ssh/id_ed25519_sk': ",
		"Enter passphrase for key '/tmp/home/max/.ssh/id_ed25519': ",
		"Enter passphrase for key '~/.ssh/id_ed25519': ",
		"Enter passphrase for key '': ",
		"Enter passphrase for key '/keys/work key'",
		"Enter PIN for ED25519-SK key /home/max/.ssh/id_ed25519: ",
		// A passphrase never goes to a server, whatever it writes.
		"max@gamer's password: ",
		"(max@gamer) Password: ",
		"(max@gamer) Enter passphrase for key '/home/max/.ssh/id_ed25519': ",
	])
		expect(await ask(PASSPHRASE, prompt)).toEqual(NOTHING);
	const mine = "Enter passphrase for key '/home/max/.ssh/id_ed25519': ";
	expect(await ask({ FAMILIAR_ASKPASS: "ssh-passphrase/gamer" }, mine)).toEqual(
		NOTHING,
	);
	expect(await ask({ ...PASSPHRASE, FAMILIAR_ASKPASS_KEY: "" }, mine)).toEqual(
		NOTHING,
	);
	// The computer the password is for is no key file.
	expect(
		await ask(
			{
				FAMILIAR_ASKPASS: "ssh-passphrase/gamer",
				FAMILIAR_ASKPASS_HOST: "max@gamer",
			},
			mine,
		),
	).toEqual(NOTHING);
});

test("askpassMain knows the key file by the path ssh shows for it", async () => {
	const answered = { code: 0, printed: `${SECRET}-key\n` };
	const key = (path: string) => ({
		FAMILIAR_ASKPASS: "ssh-passphrase/gamer",
		FAMILIAR_ASKPASS_KEY: path,
	});
	const prompt = (path: string) => `Enter passphrase for key '${path}': `;
	// On Windows the home folder has backslashes and ssh adds the rest with slashes; upper
	// and lower case name the same file there.
	const windows = {
		home: "C:\\Users\\Max Muster",
		platform: "win32" as const,
	};
	for (const shown of [
		"C:\\Users\\Max Muster/.ssh/id_ed25519",
		"C:\\Users\\Max Muster\\.ssh\\id_ed25519",
		"c:/users/max muster/.ssh/id_ed25519",
	]) {
		expect(await ask(key("~/.ssh/id_ed25519"), prompt(shown), windows)).toEqual(
			answered,
		);
		// Elsewhere these are different files.
		expect(
			await ask(key("~/.ssh/id_ed25519"), prompt(shown), {
				home: "C:\\Users\\Max Muster",
			}),
		).toEqual(shown.includes("Max Muster/") ? answered : NOTHING);
	}
	expect(
		await ask(
			key("~/.ssh/id_ed25519"),
			prompt("C:\\Users\\Other/.ssh/id_ed25519"),
			windows,
		),
	).toEqual(NOTHING);

	// ssh cuts the path off after 100 bytes ("%.100s").
	const long = `/home/max/${"k".repeat(120)}/id_ed25519`;
	expect(await ask(key(long), prompt(long.slice(0, 100)))).toEqual(answered);
	expect(await ask(key(long), prompt(long.slice(0, 99)))).toEqual(NOTHING);
	expect(await ask(key(long), prompt(long))).toEqual(NOTHING);
});

test("as a program, askpassMain writes the secret to stdout and nothing else", async () => {
	const script = `
		import { askpassMain } from ${JSON.stringify(join(import.meta.dir, "ssh.ts"))};
		import { memoryStore } from ${JSON.stringify(join(import.meta.dir, "secrets.ts"))};
		const store = memoryStore();
		await store.set("ssh-password/gamer", ${JSON.stringify(SECRET)});
		process.exit(await askpassMain(process.argv.slice(2), { store, env: process.env }));
	`;
	const file = join(dir, "askpass.ts");
	writeFileSync(file, script);
	const answered = await realRun(
		[process.execPath, file, "max@gamer's password: "],
		{
			env: {
				FAMILIAR_ASKPASS: "ssh-password/gamer",
				FAMILIAR_ASKPASS_HOST: "max@gamer",
			},
		},
	);
	expect(answered).toEqual({
		code: 0,
		stdout: `${SECRET}\n`,
		stderr: "",
		timedOut: false,
	});
	// The same program asked on behalf of another computer stays silent.
	const silent = await realRun(
		[process.execPath, file, "max@bastion's password: "],
		{
			env: {
				FAMILIAR_ASKPASS: "ssh-password/gamer",
				FAMILIAR_ASKPASS_HOST: "max@gamer",
			},
		},
	);
	expect(silent).toEqual({ code: 1, stdout: "", stderr: "", timedOut: false });
});
