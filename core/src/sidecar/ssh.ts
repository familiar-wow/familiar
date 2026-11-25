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
//   The environment only names the secret and whom it is for (`askpassEnv`).
// - A secret goes to one recipient only: the computer, or the key file, that `ssh -G` named
//   before the sign-in (`checkAuth`). A computer reached through another one (ProxyJump,
//   ProxyCommand) gets no saved secret at all, because the one in between asks through the
//   same SSH_ASKPASS.
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
import { dirname, isAbsolute, join } from "node:path";
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
	/** A ProxyCommand from the SSH config: the other way to connect through something else. */
	proxyCommand?: string;
	/** The name the host key is kept under and ssh's prompts show, if the config sets one. */
	hostKeyAlias?: string;
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
	/**
	 * The MCP port on this computer that the other computer may reach. Left out for a test: the
	 * running Familiar may hold the same forward, and a test does not need the game tools.
	 */
	port?: number;
	/**
	 * What ssh makes of this sign-in, filled in by `checkAuth`. A password or passphrase is
	 * not used without it: it says whom the secret is for.
	 */
	resolved?: SshHost;
}

/**
 * The environment `sshCommand` sets for the Familiar program in its SSH_ASKPASS role. None of
 * it is a secret.
 */
export const askpassEnv = {
	/** The name of the secret in the keychain: `ssh-password/<host>` or `ssh-passphrase/<host>`. */
	secret: "FAMILIAR_ASKPASS",
	/** For a password: `user@host` as ssh's prompt will show it. Nobody else is answered. */
	host: "FAMILIAR_ASKPASS_HOST",
	/** For a passphrase: the key files it may open, one per line. */
	key: "FAMILIAR_ASKPASS_KEY",
} as const;

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
	viaJump:
		"Familiar does not sign in with a saved password or passphrase when your SSH config reaches that computer through another one (ProxyJump or ProxyCommand). Use a key without a passphrase, or one that your SSH agent holds.",
	failed: "The connection failed.",
};

const BAD_HOST = "That computer name cannot be used.";
const UNCHECKED = "The sign-in for that computer has not been checked yet.";

/**
 * What `ssh -G` resolves a name to. A second run with an empty config file gives ssh's
 * defaults for the same name; any difference comes from the player's SSH config.
 */
export async function resolveHost(
	host: string,
	opts: { run?: Runner } = {},
): Promise<SshHost> {
	checkHost(host);
	return await resolve(host, opts.run ?? spawn, [host]);
}

/**
 * Has to run before `sshCommand` whenever a password or passphrase signs in; the result goes
 * to `sshCommand`. It asks ssh what it would do with the very command line `sshCommand`
 * builds, user, key file and command included, because a `Match` block in the SSH config may
 * depend on any of them. From that come the recipient of the secret (`askpassEnv`) and the
 * refusal of a computer that is reached through another one: ssh starts a second ssh for
 * the one in between, with the same environment, and that one could ask for the secret.
 *
 * With `auth: "key"` there is no secret and nothing to check.
 */
export async function checkAuth(
	c: SshAgentConfig,
	opts: { run?: Runner } = {},
): Promise<SshAgentConfig> {
	if (c.auth === "key") return c;
	const resolved = await resolve(c.host, opts.run ?? spawn, words(c, false));
	if (resolved.proxyJump || resolved.proxyCommand)
		throw new SshError(problems.viaJump);
	return { ...c, resolved };
}

/**
 * The command that starts the agent on the other computer, with the MCP port forwarded back.
 *
 * `askpass` must be exactly one program path, without arguments: SSH_ASKPASS cannot carry
 * arguments, on Windows or Linux. The app passes its own program; ssh starts it with the
 * prompt as the only argument and `askpassEnv` in the environment, and the program then has
 * to call `askpassMain` before anything else. For `auth: "key"` it is not used.
 *
 * A password or passphrase needs `c.resolved` from `checkAuth`.
 */
export function sshCommand(
	c: SshAgentConfig,
	opts: { askpass: string[] },
): { command: string[]; env: Record<string, string> } {
	const secret = c.auth !== "key";
	const command = ["ssh", ...words(c, secret)];
	if (!secret) return { command, env: {} };

	const [askpass, ...more] = opts.askpass;
	if (!askpass || more.length > 0)
		throw new SshError(
			"The program that answers ssh's password prompt must be one path without arguments.",
		);
	const to = c.resolved;
	if (!to || to.host !== c.host) throw new SshError(UNCHECKED);
	if (to.proxyJump || to.proxyCommand) throw new SshError(problems.viaJump);
	// ssh's prompts name the user and, in lower case, the HostKeyAlias or else the host name
	// (OpenSSH sshconnect2.c, userauth_passwd; sshconnect.c, ssh_login; ssh.c lowercases the alias).
	const user = c.user || to.user;
	const keys = c.identityFile ? [c.identityFile] : to.identityFiles;
	if (c.auth === "password" ? !user || !to.hostname : keys.length === 0)
		throw new SshError(UNCHECKED);
	return {
		command,
		env: {
			SSH_ASKPASS: askpass,
			// Without "force" ssh only uses SSH_ASKPASS when it has no terminal, and Windows'
			// ssh ignores it altogether (PowerShell/Win32-OpenSSH#2115).
			SSH_ASKPASS_REQUIRE: "force",
			// Older ssh on Linux only asks through SSH_ASKPASS when a display is set.
			DISPLAY: "familiar",
			// The name of the secret and whom it is for, never the secret.
			...(c.auth === "password"
				? {
						[askpassEnv.secret]: names.sshPassword(c.host),
						[askpassEnv.host]: `${user}@${(to.hostKeyAlias ?? to.hostname).toLowerCase()}`,
					}
				: {
						[askpassEnv.secret]: names.sshPassphrase(c.host),
						[askpassEnv.key]: keys.join("\n"),
					}),
		},
	};
}

/**
 * ssh's arguments for the agent on the other computer. `direct` makes ssh connect to that
 * computer itself whatever the SSH config says; `checkAuth` leaves it out to see what the
 * config says.
 */
function words(c: SshAgentConfig, direct: boolean): string[] {
	checkHost(c.host);
	if (c.user && !validUser(c.user))
		throw new SshError("That user name cannot be used.");
	if (c.identityFile && /\p{Cc}/u.test(c.identityFile))
		throw new SshError("That key file cannot be used.");
	if (
		c.port !== undefined &&
		(!Number.isInteger(c.port) || c.port < 1 || c.port > 65535)
	)
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
	return [
		"-T",
		...(c.port === undefined
			? []
			: [
					"-o",
					"ExitOnForwardFailure=yes",
					"-R",
					`127.0.0.1:${c.port}:127.0.0.1:${c.port}`,
				]),
		...(c.user ? ["-l", c.user] : []),
		...(c.identityFile ? ["-i", c.identityFile] : []),
		...auth,
		// The first value ssh gets for an option is the one it keeps, so these win over the
		// SSH config even if it changed after `checkAuth` looked. ProxyCommand=none alone
		// already turns a ProxyJump off (OpenSSH readconf.c, parse_jump).
		...(direct ? ["-o", "ProxyCommand=none", "-o", "ProxyJump=none"] : []),
		c.host,
		...(c.cwd ? ["cd", place(c.cwd), "&&", ...remote] : remote),
	];
}

/**
 * Whether the computer's host key is already trusted, and its fingerprint: the trusted one, or
 * the one the computer shows now, for the player to compare and confirm. No fingerprint means
 * the computer did not answer. A computer behind a ProxyJump cannot be asked from here.
 *
 * Trusted means: in one of the known hosts files that ssh itself reads for this computer
 * (UserKnownHostsFile and GlobalKnownHostsFile, as `ssh -G` reports them). `knownHosts` names
 * one file to use instead of those; `home` is the player's home folder. Tests set both.
 */
export async function hostKey(
	host: string,
	opts: { run?: Runner; knownHosts?: string; home?: string } = {},
): Promise<{ known: boolean; fingerprint?: string; type?: string }> {
	const run = opts.run ?? spawn;
	const target = await find(host, run, opts);
	const known = await knownKeys(target, run);
	// The key's type too, such as ssh-ed25519: the player compares it with that key's file there.
	if (known[0])
		return {
			known: true,
			fingerprint: fingerprint(known[0]),
			type: known[0].type,
		};
	const shown = await scan(target, run);
	return shown[0]
		? { known: false, fingerprint: fingerprint(shown[0]), type: shown[0].type }
		: { known: false };
}

/**
 * Adds the computer's host key to the known hosts file, after the player confirmed
 * `expectedFingerprint` as `hostKey` showed it. The key is fetched again here, and the very
 * key that is written must have that fingerprint; a computer that shows another key in the
 * meantime is refused. So is one that is already known under a different key: adding a
 * second key would silence ssh's warning about a changed host.
 *
 * The file is the one ssh adds new keys to: the first UserKnownHostsFile for this computer.
 */
export async function trustHost(
	host: string,
	expectedFingerprint: string,
	opts: { run?: Runner; knownHosts?: string; home?: string } = {},
): Promise<void> {
	const run = opts.run ?? spawn;
	if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(expectedFingerprint))
		throw new SshError("That is not a host key fingerprint.");
	const target = await find(host, run, opts);
	const known = await knownKeys(target, run);
	if (known.length > 0) {
		if (known.some((key) => fingerprint(key) === expectedFingerprint)) return;
		throw new SshError(
			"That computer is already known with a different host key. Nothing was saved.",
		);
	}
	// "UserKnownHostsFile none", or a path that only ssh could make sense of (~other/...).
	const file = target.files[0];
	if (!target.writable || !file || !isAbsolute(file))
		throw new SshError(
			"Your SSH config names no known hosts file that Familiar can add this computer to. Nothing was saved.",
		);
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
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		const before = existsSync(file) ? readFileSync(file, "utf8") : "";
		// The line is put together from the checked parts, not copied from the scan.
		appendFileSync(
			file,
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
 * It runs `checkAuth` itself.
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
		const checked = await checkAuth(c, { run });
		sshCommand(checked, opts);
		built = sshCommand(
			{
				...checked,
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
 * It only gives out SSH secrets, and each only to the one question it is the answer to:
 * - never an API key, whatever the environment asks for;
 * - a password only to ssh's password prompt for the `user@host` in FAMILIAR_ASKPASS_HOST. A
 *   computer in between, or any other that asks, has another name in its prompt;
 * - a passphrase only to ssh's own passphrase prompt for a key file in FAMILIAR_ASKPASS_KEY,
 *   never to a prompt a server wrote;
 * - nothing to any other question, such as "do you trust this host key?", which ssh also asks
 *   through SSH_ASKPASS; the player answers that one in the app (`trustHost`).
 *
 * This keeps a secret from going to the wrong computer or to the wrong question. It cannot
 * tell who started this program: any program of the same user can start it with a fitting
 * environment and prompt, as it can read the keychain itself on most systems.
 */
export async function askpassMain(
	argv: string[],
	opts: {
		store: SecretStore;
		env: Record<string, string | undefined>;
		/** Where the secret goes; ssh's pipe (stdout) unless a test listens. */
		write?: (text: string) => void | Promise<void>;
		/** The player's home folder and the system, for comparing key files; tests set them. */
		home?: string;
		platform?: NodeJS.Platform;
	},
): Promise<number> {
	const name = opts.env[askpassEnv.secret] ?? "";
	const passphrase = name.startsWith("ssh-passphrase/");
	if (!passphrase && !name.startsWith("ssh-password/")) return 1;
	// ssh marks questions that want a click instead of a secret.
	if (opts.env.SSH_ASKPASS_PROMPT) return 1;
	// ssh ends its prompts with a space; that one may get lost on a command line.
	const prompt = (argv[0] ?? "").trimEnd();
	const mine = passphrase
		? forKey(
				prompt,
				(opts.env[askpassEnv.key] ?? "").split("\n"),
				opts.home ?? homedir(),
				opts.platform ?? process.platform,
			)
		: forPassword(prompt, opts.env[askpassEnv.host] ?? "");
	if (!mine) return 1;
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

/**
 * Whether `prompt` is ssh asking for the password of `who` (user@host). The two forms, from
 * OpenSSH's sshconnect2.c:
 * - userauth_passwd: "%s@%s's password: ";
 * - input_userauth_info_req (keyboard-interactive, which macOS and many PAM setups use
 *   instead): "(%s@%s) %s", where ssh writes the part in brackets (since OpenSSH 8.5) and the
 *   server the rest. Only PAM's plain "Password:" counts, not a code or anything else a
 *   server may ask for.
 */
function forPassword(prompt: string, who: string): boolean {
	if (!who) return false;
	return prompt === `${who}'s password:` || prompt === `(${who}) Password:`;
}

/**
 * Whether `prompt` is ssh asking for the passphrase of one of `keys`: "Enter passphrase for
 * key '%.100s': " (OpenSSH sshconnect2.c, load_identity_file). ssh shows the file with `~`
 * replaced by the home folder and cut off after 100 bytes; on Windows the slashes and the
 * case of a path may differ without it being another file.
 */
function forKey(
	prompt: string,
	keys: string[],
	home: string,
	platform: NodeJS.Platform,
): boolean {
	const start = "Enter passphrase for key '";
	if (!prompt.startsWith(start) || !prompt.endsWith("':")) return false;
	const form = (path: string) =>
		platform === "win32" ? path.replaceAll("\\", "/").toLowerCase() : path;
	const shown = form(prompt.slice(start.length, -2));
	return keys.some(
		(key) =>
			key !== "" &&
			shown ===
				form(
					Buffer.from(atHome(key, home, "ssh"))
						.subarray(0, 100)
						.toString(),
				),
	);
}

/**
 * A path with a leading `~` replaced by the home folder, as ssh does it: in this system's form
 * for opening the file, or as ssh writes it, `home/rest`, for comparing with what ssh prints.
 */
function atHome(
	path: string,
	home: string,
	as: "file" | "ssh" = "file",
): string {
	if (path === "~") return home;
	if (!/^~[\\/]/.test(path)) return path;
	return as === "file"
		? join(home, path.slice(2))
		: `${home.replace(/[\\/]+$/, "")}/${path.slice(2)}`;
}

type Settings = Map<string, string[]>;

/**
 * What ssh would do with these arguments (the host, with or without options and a command).
 * A second run with an empty config file gives ssh's defaults for the same; any difference
 * comes from the player's SSH config.
 */
async function resolve(
	host: string,
	run: Runner,
	args: string[],
): Promise<SshHost> {
	const folder = mkdtempSync(join(tmpdir(), "familiar-ssh-"));
	try {
		const empty = join(folder, "config");
		writeFileSync(empty, "", { mode: 0o600 });
		const [applied, plain] = await Promise.all([
			settings(run, args),
			settings(run, ["-F", empty, ...args]),
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

/** The lines of `ssh -G`, by keyword. */
async function settings(run: Runner, args: string[]): Promise<Settings> {
	const r = await run(["ssh", "-G", ...args]);
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
	// ssh leaves a setting out when it is off; "none" is how a config turns it off.
	const set = (keyword: string) => {
		const value = s.get(keyword)?.[0];
		return value && value.toLowerCase() !== "none" ? value : undefined;
	};
	const jump = set("proxyjump");
	const proxy = set("proxycommand");
	const alias = s.get("hostkeyalias")?.[0];
	return {
		host,
		hostname: s.get("hostname")?.[0] ?? host,
		user: s.get("user")?.[0] ?? "",
		port: portOf(s),
		identityFiles: s.get("identityfile") ?? [],
		...(jump ? { proxyJump: jump } : {}),
		...(proxy ? { proxyCommand: proxy } : {}),
		...(alias ? { hostKeyAlias: alias } : {}),
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
	/** The name ssh looks the key up under in the known hosts files. */
	name: string;
	/** The known hosts files ssh reads for this computer. */
	files: string[];
	/** True if the first of `files` is the player's own, the one ssh adds new keys to. */
	writable: boolean;
}

async function find(
	host: string,
	run: Runner,
	opts: { knownHosts?: string; home?: string },
): Promise<Target> {
	checkHost(host);
	const s = await settings(run, [host]);
	const hostname = s.get("hostname")?.[0] ?? "";
	const port = portOf(s);
	const name =
		s.get("hostkeyalias")?.[0] ??
		(port === 22 ? hostname : `[${hostname}]:${port}`);
	// Both come from the SSH config and become arguments below.
	if (!validHost(hostname) || !validHost(name)) throw new SshError(BAD_HOST);
	const home = opts.home ?? homedir();
	const own = opts.knownHosts
		? [opts.knownHosts]
		: listed(s.get("userknownhostsfile"), home);
	const shared = opts.knownHosts
		? []
		: listed(s.get("globalknownhostsfile"), home);
	return {
		hostname,
		port,
		name,
		files: [...own, ...shared],
		writable: own.length > 0,
	};
}

/**
 * The files of a UserKnownHostsFile or GlobalKnownHostsFile line of `ssh -G`.
 *
 * ssh prints them in a row, separated by spaces and without quotes, so a path with a space
 * in it (C:\Users\Max Muster\.ssh\known_hosts) looks like two. A word that does not start
 * the way a full path does is taken as the rest of the path before it.
 *
 * OpenSSH 10 prints the player's own files with `~` and the %-tokens already replaced, but
 * the system-wide ones as they were written (ssh.c replaces those after `-G` has printed).
 * So a `~` is replaced here wherever one is left, which also covers a version that prints
 * all of them as written. Windows' ssh calls the folder of its system-wide files
 * __PROGRAMDATA__ (config.h of Win32-OpenSSH) and replaces that only when it opens a file.
 */
function listed(values: string[] = [], home: string): string[] {
	const files: string[] = [];
	for (const word of values.join(" ").split(" ")) {
		if (
			files.length === 0 ||
			/^(~|\/|[A-Za-z]:[\\/]|\\\\|__PROGRAMDATA__)/.test(word)
		)
			files.push(word);
		else files[files.length - 1] += ` ${word}`;
	}
	// "none" turns the files off; ssh only takes it in the first place.
	if (!files[0] || files[0].toLowerCase() === "none") return [];
	return files.map((file) =>
		file.startsWith("__PROGRAMDATA__")
			? `${process.env.ProgramData ?? "C:\\ProgramData"}${file.slice("__PROGRAMDATA__".length)}`
			: atHome(file, home),
	);
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

/** The keys the computer is known by, from all the files. A file that is not there has none. */
async function knownKeys(target: Target, run: Runner): Promise<PublicKey[]> {
	const found = await Promise.all(
		target.files.map((file) =>
			run(["ssh-keygen", "-F", target.name, "-f", file]),
		),
	);
	return keys(
		found
			.filter((r) => r.code === 0)
			.map((r) => r.stdout)
			.join("\n"),
	);
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
