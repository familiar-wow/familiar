// Runs the player's agent on another computer through OpenSSH: what a name resolves to
// (`ssh -G`), the command line that starts the agent there, the host key the player has to
// confirm once, and a connection test.
//
// Rules this file keeps:
// - Programs get their arguments as a list, never as a shell line. Only the command for the
//   other computer is one line in the end, because ssh sends it as one; its words are quoted
//   for the shell there (`quote`).
// - A password or passphrase never appears in an argument, the environment, an error or a
//   file. ssh asks for it through SSH_ASKPASS: it starts the Familiar program again, which
//   reads the secret from the system keychain and prints it to ssh's pipe (`askpassMain`).
//   The environment only names the secret (FAMILIAR_ASKPASS).
// - A host key is trusted only after the player confirmed its fingerprint (`trustHost`).
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Runner, run as spawn } from "./run.ts";
import { names, type SecretStore } from "./secrets.ts";

/** What `ssh -G` says applies to a name. */
export interface SshHost {
	/** The name as the player gave it. */
	host: string;
	hostname: string;
	user: string;
	port: number;
	/** As ssh prints them; `~` is not expanded. */
	identityFiles: string[];
	proxyJump?: string;
	/** True if the player's SSH config changes anything above for this name. */
	fromConfig: boolean;
}

export interface SshAgentConfig {
	/** A name, an IP address or a Host alias from the SSH config. */
	host: string;
	user?: string;
	identityFile?: string;
	auth: "key" | "passphrase" | "password";
	/** The agent's command on the other computer, one word per item. */
	command: string[];
	/** The folder on the other computer to start the agent in. */
	cwd?: string;
	/** The MCP port on this computer that the other computer may reach. */
	port: number;
}

/** A problem the player can act on; its message is fixed words. */
export class SshError extends Error {
	override name = "SshError";
}

/** What `testConnection` can report. Fixed words, safe to show. */
export const problems = {
	noSsh: "OpenSSH (ssh) was not found on this computer.",
	hostKeyUnknown: "The other computer's host key is not trusted yet.",
	hostKeyChanged:
		"The other computer's host key has changed since it was trusted. Check with its owner before you connect.",
	denied: "The other computer refused the sign-in (permission denied).",
	unreachable: "The other computer could not be reached.",
	timeout: "The other computer did not answer in time.",
	forward:
		"The other computer did not allow the connection back to Familiar (port forwarding).",
	closed:
		"The other computer closed the connection. After several failed tries it may refuse this computer for a minute.",
	agentMissing: "The agent program was not found on the other computer.",
	failed: "The connection failed.",
};

const BAD_HOST = "That computer name cannot be used.";

/**
 * What `ssh -G` resolves a name to. A second run with an empty config file gives ssh's
 * defaults for the same name; any difference comes from the player's SSH config.
 */
export async function resolveHost(
	host: string,
	opts: { run?: Runner } = {},
): Promise<SshHost> {
	const run = opts.run ?? spawn;
	checkHost(host);
	const folder = mkdtempSync(join(tmpdir(), "familiar-ssh-"));
	try {
		const empty = join(folder, "config");
		writeFileSync(empty, "", { mode: 0o600 });
		const [applied, plain] = await Promise.all([
			settings(host, run),
			settings(host, run, ["-F", empty]),
		]);
		const resolved = describe(host, applied);
		return {
			...resolved,
			fromConfig:
				JSON.stringify(resolved) !== JSON.stringify(describe(host, plain)),
		};
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
}

/**
 * The command that starts the agent on the other computer, with the MCP port forwarded back.
 *
 * `askpass` must be exactly one program path, without arguments: SSH_ASKPASS cannot carry
 * arguments, on Windows or Linux. The app passes its own program; ssh starts it with the
 * prompt as the only argument and FAMILIAR_ASKPASS in the environment, and the program then
 * has to call `askpassMain` before anything else. For `auth: "key"` it is not used.
 */
export function sshCommand(
	c: SshAgentConfig,
	opts: { askpass: string[] },
): { command: string[]; env: Record<string, string> } {
	checkHost(c.host);
	if (c.user && !validUser(c.user))
		throw new SshError("That user name cannot be used.");
	if (c.identityFile && /\p{Cc}/u.test(c.identityFile))
		throw new SshError("That key file cannot be used.");
	if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535)
		throw new SshError("That port cannot be used.");
	// ssh reads options even after the host, up to the first word that is not one. A command
	// starting with "-" would be taken as an option of ssh on this computer.
	const program = c.command[0];
	if (!program || program.startsWith("-"))
		throw new SshError("That agent command cannot be used.");

	const remote = c.command.map(quote);
	const auth =
		c.auth === "key"
			? ["-o", "BatchMode=yes"]
			: c.auth === "password"
				? ["-o", "NumberOfPasswordPrompts=1"]
				: // Only the key may sign in. Otherwise a server that turns the key down could ask
					// for a password, and ssh would send it the passphrase as the answer.
					[
						"-o",
						"NumberOfPasswordPrompts=1",
						"-o",
						"PreferredAuthentications=publickey",
					];
	const command = [
		"ssh",
		"-T",
		"-o",
		"ExitOnForwardFailure=yes",
		"-R",
		`127.0.0.1:${c.port}:127.0.0.1:${c.port}`,
		...(c.user ? ["-l", c.user] : []),
		...(c.identityFile ? ["-i", c.identityFile] : []),
		...auth,
		c.host,
		...(c.cwd ? ["cd", place(c.cwd), "&&", ...remote] : remote),
	];
	if (c.auth === "key") return { command, env: {} };

	const [askpass, ...more] = opts.askpass;
	if (!askpass || more.length > 0)
		throw new SshError(
			"The program that answers ssh's password prompt must be one path without arguments.",
		);
	return {
		command,
		env: {
			SSH_ASKPASS: askpass,
			// Without "force" ssh only uses SSH_ASKPASS when it has no terminal, and Windows'
			// ssh ignores it altogether (PowerShell/Win32-OpenSSH#2115).
			SSH_ASKPASS_REQUIRE: "force",
			// Older ssh on Linux only asks through SSH_ASKPASS when a display is set.
			DISPLAY: "familiar",
			// The name of the secret, never the secret.
			FAMILIAR_ASKPASS:
				c.auth === "password"
					? names.sshPassword(c.host)
					: names.sshPassphrase(c.host),
		},
	};
}

/**
 * Whether the computer's host key is already trusted, and its fingerprint: the trusted one, or
 * the one the computer shows now, for the player to compare and confirm. No fingerprint means
 * the computer did not answer. A computer behind a ProxyJump cannot be asked from here.
 */
export async function hostKey(
	host: string,
	opts: { run?: Runner; knownHosts?: string } = {},
): Promise<{ known: boolean; fingerprint?: string }> {
	const run = opts.run ?? spawn;
	const target = await find(host, run, opts.knownHosts);
	const known = await knownKeys(target, run);
	if (known[0]) return { known: true, fingerprint: fingerprint(known[0]) };
	const shown = await scan(target, run);
	return shown[0]
		? { known: false, fingerprint: fingerprint(shown[0]) }
		: { known: false };
}

/**
 * Adds the computer's host key to the known hosts file, after the player confirmed
 * `expectedFingerprint` as `hostKey` showed it. The key is fetched again here, and the very
 * key that is written must have that fingerprint; a computer that shows another key in the
 * meantime is refused. So is one that is already known under a different key: adding a
 * second key would silence ssh's warning about a changed host.
 */
export async function trustHost(
	host: string,
	expectedFingerprint: string,
	opts: { run?: Runner; knownHosts?: string } = {},
): Promise<void> {
	const run = opts.run ?? spawn;
	if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(expectedFingerprint))
		throw new SshError("That is not a host key fingerprint.");
	const target = await find(host, run, opts.knownHosts);
	const known = await knownKeys(target, run);
	if (known.length > 0) {
		if (known.some((key) => fingerprint(key) === expectedFingerprint)) return;
		throw new SshError(
			"That computer is already known with a different host key. Nothing was saved.",
		);
	}
	const shown = await scan(target, run);
	if (shown.length === 0)
		throw new SshError(
			"The other computer did not show a host key. Nothing was saved.",
		);
	const key = shown.find((k) => fingerprint(k) === expectedFingerprint);
	if (!key)
		throw new SshError(
			"The other computer shows a different host key than the one you confirmed. Nothing was saved.",
		);
	try {
		mkdirSync(dirname(target.file), { recursive: true, mode: 0o700 });
		const before = existsSync(target.file)
			? readFileSync(target.file, "utf8")
			: "";
		// The line is put together from the checked parts, not copied from the scan.
		appendFileSync(
			target.file,
			`${before && !before.endsWith("\n") ? "\n" : ""}${target.name} ${key.type} ${key.blob}\n`,
			{ mode: 0o600 },
		);
	} catch {
		throw new SshError("The known hosts file could not be written.");
	}
}

/**
 * Signs in the way `sshCommand` would and looks for the agent's program, without starting it.
 * Never throws; a problem comes back as fixed words. The other computer needs a POSIX shell.
 *
 * The program is looked up in a login shell, which reads the user's profile. The agent itself
 * is started without one, as ssh does, and may then not find a program that only the profile
 * puts on the PATH, such as one in ~/.local/bin. `agentPath` is where the program was found;
 * with that full path as the first word of the command the agent starts either way.
 */
export async function testConnection(
	c: SshAgentConfig,
	opts: { run?: Runner; askpass: string[] },
): Promise<{
	ok: boolean;
	problem?: string;
	agentFound?: boolean;
	agentPath?: string;
}> {
	const run = opts.run ?? spawn;
	let built: ReturnType<typeof sshCommand>;
	try {
		// Checks the real command too, though it is not the one that runs.
		sshCommand(c, opts);
		built = sshCommand(
			{
				...c,
				cwd: undefined,
				command: ["sh", "-lc", `command -v ${quote(c.command[0] ?? "")}`],
			},
			opts,
		);
	} catch (error) {
		return {
			ok: false,
			problem: error instanceof SshError ? error.message : problems.failed,
		};
	}
	const r = await run(built.command, { timeoutMs: 15_000, env: built.env });
	if (r.timedOut) return { ok: false, problem: problems.timeout };
	if (r.code === null) return { ok: false, problem: problems.noSsh };
	// ssh's own failures all end with 255; anything else is the answer of the other computer.
	if (r.code !== 255) {
		// The profile may print lines of its own first; the answer is the last one.
		const answer = r.stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
		if (r.code !== 0 || !answer)
			return { ok: false, problem: problems.agentMissing, agentFound: false };
		return {
			ok: true,
			agentFound: true,
			...(answer.startsWith("/") ? { agentPath: answer } : {}),
		};
	}
	const said = (pattern: RegExp) => pattern.test(r.stderr);
	if (said(/HOST IDENTIFICATION HAS CHANGED/i))
		return { ok: false, problem: problems.hostKeyChanged };
	if (said(/Host key verification failed|host key is known/i))
		return { ok: false, problem: problems.hostKeyUnknown };
	if (said(/Permission denied|Too many authentication failures/i))
		return { ok: false, problem: problems.denied };
	if (said(/timed out/i)) return { ok: false, problem: problems.timeout };
	if (
		said(
			/Could not resolve hostname|Connection refused|No route to host|Network is unreachable/i,
		)
	)
		return { ok: false, problem: problems.unreachable };
	if (said(/port forwarding failed/i))
		return { ok: false, problem: problems.forward };
	if (said(/Connection (closed|reset) by/i))
		return { ok: false, problem: problems.closed };
	return { ok: false, problem: problems.failed };
}

/**
 * The Familiar program in the role of SSH_ASKPASS. `argv` is what ssh passed: the prompt as
 * the only argument. Prints the secret that FAMILIAR_ASKPASS names and returns the exit code:
 * 0 if it answered, 1 with nothing printed otherwise. Never logs.
 *
 * It only gives out SSH secrets, and each only to the question it is the answer to:
 * - never an API key, whatever the environment asks for;
 * - no answer to "do you trust this host key?", which ssh also asks through SSH_ASKPASS; the
 *   player answers that one in the app (`trustHost`);
 * - a passphrase only to ssh's own passphrase prompt, never to a prompt a server wrote;
 * - a password never as the passphrase of a key.
 */
export async function askpassMain(
	argv: string[],
	opts: {
		store: SecretStore;
		env: Record<string, string | undefined>;
		/** Where the secret goes; ssh's pipe (stdout) unless a test listens. */
		write?: (text: string) => void | Promise<void>;
	},
): Promise<number> {
	const name = opts.env.FAMILIAR_ASKPASS ?? "";
	const passphrase = name.startsWith("ssh-passphrase/");
	if (!passphrase && !name.startsWith("ssh-password/")) return 1;
	// ssh marks some questions that want a click instead of a secret; the one about an
	// unknown host key it does not mark, so that one is told by its words.
	if (opts.env.SSH_ASKPASS_PROMPT) return 1;
	const prompt = argv[0] ?? "";
	if (/'yes'|yes\/no|continue connecting|fingerprint/i.test(prompt)) return 1;
	if (/^Enter passphrase for /i.test(prompt) !== passphrase) return 1;
	let secret: string | null;
	try {
		secret = await opts.store.get(name);
	} catch {
		return 1;
	}
	if (!secret) return 1;
	const write =
		opts.write ??
		(async (text: string) => {
			await Bun.write(Bun.stdout, text);
		});
	try {
		await write(`${secret}\n`);
	} catch {
		return 1;
	}
	return 0;
}

type Settings = Map<string, string[]>;

/** The lines of `ssh -G`, by keyword. */
async function settings(
	host: string,
	run: Runner,
	extra: string[] = [],
): Promise<Settings> {
	const r = await run(["ssh", "-G", ...extra, host]);
	if (r.code === null && !r.timedOut) throw new SshError(problems.noSsh);
	if (r.code !== 0)
		throw new SshError(
			"ssh could not work out that computer. Check the name and your SSH config file.",
		);
	const found: Settings = new Map();
	for (const line of r.stdout.split(/\r?\n/)) {
		const space = line.indexOf(" ");
		if (space < 1) continue;
		const keyword = line.slice(0, space).toLowerCase();
		const value = line.slice(space + 1).trim();
		found.set(keyword, [...(found.get(keyword) ?? []), value]);
	}
	return found;
}

function describe(host: string, s: Settings): Omit<SshHost, "fromConfig"> {
	const jump = s.get("proxyjump")?.[0];
	return {
		host,
		hostname: s.get("hostname")?.[0] ?? host,
		user: s.get("user")?.[0] ?? "",
		port: portOf(s),
		identityFiles: s.get("identityfile") ?? [],
		...(jump && jump !== "none" ? { proxyJump: jump } : {}),
	};
}

function portOf(s: Settings): number {
	const port = Number(s.get("port")?.[0]);
	return Number.isInteger(port) && port > 0 && port < 65536 ? port : 22;
}

/** Where a computer's host key is asked for and kept. */
interface Target {
	hostname: string;
	port: number;
	/** The name ssh looks the key up under in the known hosts file. */
	name: string;
	file: string;
}

async function find(
	host: string,
	run: Runner,
	knownHosts?: string,
): Promise<Target> {
	checkHost(host);
	const s = await settings(host, run);
	const hostname = s.get("hostname")?.[0] ?? "";
	const port = portOf(s);
	const name =
		s.get("hostkeyalias")?.[0] ??
		(port === 22 ? hostname : `[${hostname}]:${port}`);
	// Both come from the SSH config and become arguments below.
	if (!validHost(hostname) || !validHost(name)) throw new SshError(BAD_HOST);
	return {
		hostname,
		port,
		name,
		file: knownHosts ?? join(homedir(), ".ssh", "known_hosts"),
	};
}

interface PublicKey {
	type: string;
	/** The key itself, in base64 as it stands in the known hosts file. */
	blob: string;
}

/** The keys in lines of the known hosts format, the kind ssh prefers first. */
function keys(text: string): PublicKey[] {
	const found: PublicKey[] = [];
	for (const line of text.split(/\r?\n/)) {
		// "#" is a comment; "@" marks a revoked key or a certificate authority, not this host's key.
		if (/^\s*[#@]/.test(line)) continue;
		const key = line.match(
			/(?:^|\s)((?:ssh|ecdsa|sk)-[a-z0-9@.-]+)\s+([A-Za-z0-9+/]+={0,2})\s*$/,
		);
		if (key?.[1] && key[2]) found.push({ type: key[1], blob: key[2] });
	}
	return found.sort((a, b) => rank(a.type) - rank(b.type));
}

/** The order in which ssh picks a host key when it knows none yet. */
function rank(type: string): number {
	if (type === "ssh-ed25519") return 0;
	if (type.startsWith("ecdsa-")) return 1;
	if (type === "ssh-rsa") return 2;
	return 3;
}

/** The fingerprint as ssh shows it: SHA-256 of the key, in base64 without padding. */
function fingerprint(key: PublicKey): string {
	const hash = new Bun.CryptoHasher("sha256")
		.update(Buffer.from(key.blob, "base64"))
		.digest("base64");
	return `SHA256:${hash.replace(/=+$/, "")}`;
}

async function knownKeys(target: Target, run: Runner): Promise<PublicKey[]> {
	const r = await run(["ssh-keygen", "-F", target.name, "-f", target.file]);
	return r.code === 0 ? keys(r.stdout) : [];
}

/**
 * The host keys the computer shows right now. ssh-keyscan connects once per kind of key, and
 * a server counts every such visit against this computer: OpenSSH from 9.8 on shuts an
 * address out for a while after too many connections that never sign in. So it asks for the
 * kind nearly every server has, and for the older kinds only when that brought nothing.
 */
async function scan(target: Target, run: Runner): Promise<PublicKey[]> {
	for (const kinds of ["ed25519", "ecdsa,rsa"]) {
		const r = await run(
			[
				"ssh-keyscan",
				"-T",
				"5",
				"-p",
				String(target.port),
				"-t",
				kinds,
				target.hostname,
			],
			{ timeoutMs: 8000 },
		);
		if (r.code === null && !r.timedOut) throw new SshError(problems.noSsh);
		const found = keys(r.stdout);
		if (found.length > 0) return found;
	}
	return [];
}

function checkHost(host: string): void {
	if (!validHost(host)) throw new SshError(BAD_HOST);
}

/**
 * A name ssh may get as an argument. A leading "-" would be read as an option. The shell
 * characters are what OpenSSH itself refuses since 9.6, because a ProxyCommand in the
 * player's config may hand the name to a shell; older versions are still in use.
 */
function validHost(host: string): boolean {
	return (
		host.length > 0 &&
		host.length <= 255 &&
		!host.startsWith("-") &&
		!/[\s\p{Cc}'`"$\\;&<>|(){}]/u.test(host)
	);
}

/** A user name on the other computer; `DOMAIN\user` is allowed for Windows. */
function validUser(user: string): boolean {
	return (
		!user.startsWith("-") &&
		!user.endsWith("\\") &&
		!/[\s\p{Cc}'`"$;&<>|(){}]/u.test(user)
	);
}

/**
 * One word for the shell on the other computer. ssh joins the command with spaces and the
 * shell there splits it again, so a word with a space or a shell character has to be quoted
 * to arrive as one word. Plain words stay as they are.
 */
function quote(word: string): string {
	return /^[\w@%+=:,./-]+$/.test(word)
		? word
		: `'${word.replaceAll("'", "'\\''")}'`;
}

/** A folder for `cd`: quoted, but with a leading `~` left for the shell to expand. */
function place(folder: string): string {
	if (folder === "~") return folder;
	if (folder.startsWith("~/")) return `~/${quote(folder.slice(2))}`;
	return quote(folder.startsWith("-") ? `./${folder}` : folder);
}
