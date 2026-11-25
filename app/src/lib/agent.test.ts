import { expect, test } from "bun:test";
import {
	AgentController,
	type AgentDeps,
	agentRows,
	type FoundAgent,
	hostKeyFile,
	initialState,
	localChoice,
	presentAgent,
	type Resolved,
	resolvedLine,
	type SshForm,
	sshChoice,
	trustStep,
} from "./agent.ts";
import { applyChoice, type Choice, type Settings } from "./brain.ts";
import { translator } from "./i18n.ts";
import type { BrainTest, Outcome } from "./main-app.ts";
import { emptyView, type View } from "./overview.ts";

const t = translator("en");
const tick = () => new Promise((r) => setTimeout(r, 0));

const base: Settings = {
	app: { setupDone: true, brains: {} },
	brain: { use: "agent", command: ["hermes", "acp"], permissions: "ask" },
	mcp: { port: 27495 },
};

const view = (settings: Settings = base, running = true): View => ({
	...emptyView("en"),
	gen: 1,
	settings,
	// Familiar runs with the saved settings unless a test says otherwise.
	status: { running, restartNeeded: false } as View["status"],
});

const hermes: FoundAgent = {
	id: "hermes",
	name: "Hermes Agent",
	command: ["hermes", "acp"],
	path: "/home/p/.local/bin/hermes",
	version: "hermes 0.31.0",
	ready: true,
};
const claude: FoundAgent = {
	id: "claude",
	name: "Claude Code",
	command: ["npx", "-y", "@agentclientprotocol/claude-agent-acp"],
	path: "/usr/bin/claude",
	ready: false,
	needs: "an Anthropic API key (ANTHROPIC_API_KEY)",
};

const homelab: Resolved = {
	host: "homelab",
	hostname: "192.168.1.10",
	user: "p",
	port: 22,
	identityFiles: ["~/.ssh/id_ed25519"],
	proxyJump: "jump-host",
	fromConfig: true,
};

const sshForm = (over: Partial<SshForm> = {}): SshForm => ({
	host: "homelab",
	user: "",
	identityFile: "",
	auth: "key",
	command: "hermes acp",
	cwd: "/home/p",
	...over,
});

const FP = "SHA256:q3VxAbCdEfGhIjKlMnOpQrStUvWxYz0123456789T8kE";

/** A core and MainApp that answer as told and write down what they were asked. */
function fake(
	answers: Record<string, (params: Record<string, unknown>) => unknown> = {},
) {
	const calls: [string, Record<string, unknown>][] = [];
	const remembered: Choice[] = [];
	const used: Choice[] = [];
	const tested: Choice[] = [];
	let settings = structuredClone(base);
	let outcome: Outcome = { ok: true };
	let brainTest: Promise<BrainTest> | BrainTest = {
		ok: true,
		ms: 6400,
		answer: "Hello from Hermes.",
		tools: [],
	};
	const deps: AgentDeps = {
		call: async <T>(method: string, params: Record<string, unknown> = {}) => {
			calls.push([method, params]);
			const answer = answers[method];
			if (!answer) throw new Error(`unexpected ${method}`);
			return (await answer(params)) as T;
		},
		rememberBrain: async (choice) => {
			remembered.push(choice);
		},
		useBrain: async (choice) => {
			used.push(choice);
			settings = applyChoice(settings, choice);
			return outcome;
		},
		testBrain: async (choice) => {
			tested.push(choice);
			return brainTest;
		},
		updateSettings: async (change) => {
			settings = change(structuredClone(settings));
			return settings;
		},
		pickFolder: async () => "/home/p/wow-notes",
	};
	return {
		deps,
		calls,
		remembered,
		used,
		tested,
		settings: () => settings,
		failUse: (problem: string) => {
			outcome = { ok: false, problem };
		},
		holdTest: (p: Promise<BrainTest>) => {
			brainTest = p;
		},
	};
}

test("the tab opens on the place of the agent that answers, with each place's last form", () => {
	const s: Settings = {
		...base,
		app: {
			brains: {
				agent: { command: ["codex-acp"], cwd: "C:\\Notes" },
				ssh: {
					host: "homelab",
					user: "q",
					auth: "password",
					command: ["hermes", "acp"],
					cwd: "/home/q",
				},
			},
		},
	};
	const local = initialState(s);
	expect(local.where).toBe("local");
	expect(local.local).toEqual({
		command: "codex-acp",
		cwd: "C:\\Notes",
		custom: false,
	});
	expect(local.ssh).toEqual({
		host: "homelab",
		user: "q",
		identityFile: "",
		auth: "password",
		command: "hermes acp",
		cwd: "/home/q",
	});
	// An override from before: "Advanced" opens to show it.
	expect(local.advanced).toBe(true);
	expect(local.permissions).toBe("ask");

	const remote = initialState(
		applyChoice(base, {
			kind: "agent",
			where: "ssh",
			ssh: { host: "pi", auth: "key", command: ["hermes", "acp"] },
			cwd: "/home/pi",
		}),
	);
	expect(remote.where).toBe("ssh");
	expect(remote.ssh.host).toBe("pi");
	expect(remote.ssh.cwd).toBe("/home/pi");
	expect(remote.advanced).toBe(false);
	// A model answers: this PC, with the default agent, and an empty SSH form.
	const model = initialState({
		brain: { use: "model", model: { provider: "openai", name: "m" } },
	});
	expect(model.where).toBe("local");
	expect(model.local.command).toBe("hermes acp");
	expect(model.ssh.host).toBe("");
});

test("this PC: the command line becomes words, the folder is optional", () => {
	expect(
		localChoice({
			command: '"C:\\Program Files\\Agent\\agent.exe" acp',
			cwd: "",
			custom: true,
		}),
	).toEqual({
		choice: {
			kind: "agent",
			where: "local",
			command: ["C:\\Program Files\\Agent\\agent.exe", "acp"],
		},
		problems: {},
	});
	expect(
		localChoice({ command: "hermes acp", cwd: " /home/p ", custom: false })
			.choice,
	).toEqual({
		kind: "agent",
		where: "local",
		command: ["hermes", "acp"],
		cwd: "/home/p",
	});
	expect(
		localChoice({ command: "  ", cwd: "", custom: true }).problems,
	).toEqual({ command: "agent.err.command" });
	expect(
		localChoice({ command: '"agent acp', cwd: "", custom: true }).problems,
	).toEqual({ command: "agent.err.quote" });
	expect(
		localChoice({ command: "--version", cwd: "", custom: true }).problems,
	).toEqual({ command: "agent.err.dash" });
});

test("SSH: computer, command and an absolute folder there are required; overrides only when set", () => {
	expect(sshChoice(sshForm())).toEqual({
		choice: {
			kind: "agent",
			where: "ssh",
			ssh: { host: "homelab", auth: "key", command: ["hermes", "acp"] },
			cwd: "/home/p",
		},
		problems: {},
	});
	expect(
		sshChoice(
			sshForm({
				host: " homelab ",
				user: "q",
				identityFile: "~/.ssh/work",
				auth: "passphrase",
			}),
		).choice,
	).toEqual({
		kind: "agent",
		where: "ssh",
		ssh: {
			host: "homelab",
			user: "q",
			identityFile: "~/.ssh/work",
			auth: "passphrase",
			command: ["hermes", "acp"],
		},
		cwd: "/home/p",
	});
	expect(sshChoice(sshForm({ host: "", command: "", cwd: "" }))).toEqual({
		problems: {
			host: "agent.err.host",
			command: "agent.err.command",
			cwd: "agent.err.cwdRequired",
		},
	});
	expect(
		sshChoice(sshForm({ host: "my pc", user: "p q", cwd: "~/work" })).problems,
	).toEqual({
		host: "agent.err.hostSpaces",
		user: "agent.err.userSpaces",
		cwd: "agent.err.cwdAbsolute",
	});
	expect(sshChoice(sshForm({ host: "-oProxyCommand=x" })).problems).toEqual({
		host: "agent.err.hostDash",
	});
	expect(sshChoice(sshForm({ cwd: "C:\\Users\\p" })).problems.cwd).toBe(
		"agent.err.cwdAbsolute",
	);
});

test("the found agents: the form's command selected, the answering one marked, what is missing said", () => {
	const rows = agentRows(
		[hermes, claude],
		{ command: "hermes acp", cwd: "", custom: false },
		base,
		t,
	);
	expect(rows).toEqual([
		{
			id: "hermes",
			name: "Hermes Agent",
			command: "hermes acp",
			detail: "/home/p/.local/bin/hermes · hermes 0.31.0",
			status: "✓ ACP",
			ready: true,
			selected: true,
			inUse: true,
		},
		{
			id: "claude",
			name: "Claude Code",
			command: "npx -y @agentclientprotocol/claude-agent-acp",
			detail: "/usr/bin/claude",
			status: "not ready",
			ready: false,
			needs: "needs an Anthropic API key (ANTHROPIC_API_KEY)",
			selected: false,
			inUse: false,
		},
	]);
	// "Other command…" chosen: no row is selected even if the command matches.
	const custom = agentRows(
		[hermes],
		{ command: "hermes acp", cwd: "", custom: true },
		undefined,
		t,
	);
	expect(custom[0]?.selected).toBe(false);
	expect(custom[0]?.inUse).toBe(false);
});

test("the page selects “Other command…” when no found agent has the form's command", () => {
	const state = {
		...initialState({
			...base,
			app: { brains: { agent: { command: ["my-agent", "--acp"] } } },
		}),
		agents: [hermes],
	};
	const page = presentAgent(state, view(), t);
	expect(page.rows.map((r) => r.selected)).toEqual([false]);
	expect(page.other).toBe(true);
	// Before agents.find answered, nothing is decided yet.
	expect(presentAgent({ ...state, agents: undefined }, view(), t).other).toBe(
		false,
	);
	expect(presentAgent({ ...state, agents: [] }, view(), t).none).toBe(true);
});

test("the resolved line: what applies, then the overrides set here", () => {
	expect(resolvedLine(homelab, {}, t)).toBe(
		"homelab → 192.168.1.10, user p, port 22, key ~/.ssh/id_ed25519, through jump-host; from .ssh/config",
	);
	expect(
		resolvedLine(homelab, { user: "q", identityFile: "~/.ssh/work" }, t),
	).toBe(
		"homelab → 192.168.1.10, user q (set here), port 22, key ~/.ssh/work (set here), through jump-host; from .ssh/config",
	);
	// Without config: ssh lists every usual key file, whether it exists or not.
	expect(
		resolvedLine(
			{
				host: "192.168.1.20",
				hostname: "192.168.1.20",
				user: "pascal",
				port: 22,
				identityFiles: [
					"~/.ssh/id_rsa",
					"~/.ssh/id_ecdsa",
					"~/.ssh/id_ecdsa_sk",
					"~/.ssh/id_ed25519",
				],
				fromConfig: false,
			},
			{},
			t,
		),
	).toBe(
		"192.168.1.20, user pascal, port 22, your usual keys in ~/.ssh; no entry for it in .ssh/config",
	);
	expect(
		resolvedLine(
			{
				...homelab,
				proxyJump: undefined,
				proxyCommand: "cloudflared access ssh --hostname %h",
				port: 2222,
				identityFiles: ["~/.ssh/a", "~/.ssh/b"],
			},
			{},
			t,
		),
	).toBe(
		"homelab → 192.168.1.10, user p, port 2222, keys ~/.ssh/a, ~/.ssh/b, through a ProxyCommand; from .ssh/config",
	);
});

test("the trust flow: known goes on, a fingerprint asks, none explains", () => {
	expect(trustStep("homelab", { known: true, fingerprint: FP }, "use")).toBe(
		"go",
	);
	expect(
		trustStep("homelab", { known: false, fingerprint: FP }, "use"),
	).toEqual({ step: "ask", host: "homelab", fingerprint: FP, next: "use" });
	expect(trustStep("homelab", { known: false }, "connect")).toEqual({
		step: "unreachable",
		host: "homelab",
	});
	expect(trustStep("homelab", null, "connect")).toEqual({
		step: "unreachable",
		host: "homelab",
	});
	// The key's type names the file to compare it with there.
	expect(
		trustStep(
			"nas",
			{ known: false, fingerprint: FP, type: "ecdsa-sha2-nistp256" },
			"connect",
		),
	).toMatchObject({ step: "ask", type: "ecdsa-sha2-nistp256" });
	expect(hostKeyFile("ssh-ed25519")).toBe("/etc/ssh/ssh_host_ed25519_key.pub");
	expect(hostKeyFile("ecdsa-sha2-nistp256")).toBe(
		"/etc/ssh/ssh_host_ecdsa_key.pub",
	);
	expect(hostKeyFile("ssh-rsa")).toBe("/etc/ssh/ssh_host_rsa_key.pub");
	expect(hostKeyFile("sk-ssh-ed25519@openssh.com")).toBeUndefined();
	expect(hostKeyFile(undefined)).toBeUndefined();
});

test("whether a secret is stored is asked for the host and sign-in in the fields only", async () => {
	const f = fake({ "ssh.hasSecret": () => true });
	const c = new AgentController(f.deps, base);
	c.editSsh({ host: "homelab", auth: "password" });
	await c.checkStored();
	expect(c.state.stored).toEqual({
		host: "homelab",
		auth: "password",
		has: true,
	});
	expect(f.calls).toEqual([
		["ssh.hasSecret", { host: "homelab", kind: "password" }],
	]);
	// Asked once per host and sign-in; never for a key.
	await c.checkStored();
	c.editSsh({ auth: "key" });
	await c.checkStored();
	expect(f.calls).toHaveLength(1);
});

test("a resolve answer belongs to the host it was asked for", async () => {
	let answer: (r: Resolved) => void = () => {};
	const f = fake({
		"ssh.resolve": () => new Promise<Resolved>((r) => (answer = r)),
	});
	const c = new AgentController(f.deps, base);
	c.setWhere("ssh");
	c.editSsh({ host: "homelab" });
	const asked = c.resolve();
	expect(c.state.resolving).toBe("homelab");
	expect(presentAgent(c.state, view(), t).resolving).toBe(true);
	// The field changes while ssh -G runs: the late answer is dropped.
	c.editSsh({ host: "homelab2" });
	answer(homelab);
	await asked;
	expect(c.state.resolved).toBeUndefined();
	expect(c.state.resolving).toBeUndefined();

	const again = c.resolve();
	answer({ ...homelab, host: "homelab2" });
	await again;
	expect(c.state.resolved?.host).toBe("homelab2");
	expect(presentAgent(c.state, view(), t).resolved).toStartWith("homelab2 →");
	// The same host is not asked twice; another one drops what is shown at once.
	await c.resolve();
	expect(f.calls.filter(([m]) => m === "ssh.resolve")).toHaveLength(2);
	c.editSsh({ host: "homelab" });
	expect(c.state.resolved).toBeUndefined();
	expect(presentAgent(c.state, view(), t).resolved).toBeUndefined();
});

test("a resolve error is the core's words, for its host only", async () => {
	const f = fake({
		"ssh.resolve": () => {
			throw new Error(
				"ssh could not work out that computer. Check the name and your SSH config file.",
			);
		},
	});
	const c = new AgentController(f.deps, base);
	c.setWhere("ssh");
	c.editSsh({ host: "nowhere" });
	await c.resolve();
	expect(presentAgent(c.state, view(), t).resolveError).toBe(
		"ssh could not work out that computer. Check the name and your SSH config file.",
	);
	c.editSsh({ host: "elsewhere" });
	expect(presentAgent(c.state, view(), t).resolveError).toBeUndefined();
});

test("a complete form is remembered once on blur; a half-typed one never", async () => {
	const f = fake();
	const c = new AgentController(f.deps, base);
	// Unchanged since the tab opened: nothing to save.
	c.commit();
	expect(f.remembered).toEqual([]);
	c.setWhere("ssh");
	c.editSsh({ host: "homelab" });
	c.commit();
	expect(f.remembered).toEqual([]);
	c.editSsh({ cwd: "/home/p" });
	c.commit();
	c.commit();
	await tick();
	expect(f.remembered).toEqual([
		{
			kind: "agent",
			where: "ssh",
			ssh: { host: "homelab", auth: "key", command: ["hermes", "acp"] },
			cwd: "/home/p",
		},
	]);
	// A sign-in method is a choice made: remembered at once.
	c.setAuth("password");
	await tick();
	expect(f.remembered).toHaveLength(2);
	expect(f.remembered[1]).toMatchObject({ ssh: { auth: "password" } });
});

test("remembering fails: the core's words under the buttons, and the next blur tries again", async () => {
	const f = fake();
	let fail = true;
	f.deps.rememberBrain = async () => {
		if (fail) throw new Error("The settings file could not be written.");
	};
	const c = new AgentController(f.deps, base);
	c.pickAgent(claude);
	await tick();
	expect(presentAgent(c.state, view(), t).result).toEqual({
		tone: "bad",
		text: "The settings file could not be written.",
	});
	fail = false;
	let calls = 0;
	f.deps.rememberBrain = async () => {
		calls++;
	};
	c.commit();
	await tick();
	expect(calls).toBe(1);
});

test("picking agents and “Other command…” on this PC", async () => {
	const f = fake({ "agents.find": () => [hermes, claude] });
	const c = new AgentController(f.deps, base);
	await c.findAgents();
	expect(presentAgent(c.state, view(), t).rows[0]?.selected).toBe(true);
	c.pickAgent(claude);
	await tick();
	expect(c.state.local.command).toBe(
		"npx -y @agentclientprotocol/claude-agent-acp",
	);
	expect(f.remembered).toHaveLength(1);
	c.pickOther();
	const page = presentAgent(c.state, view(), t);
	expect(page.other).toBe(true);
	expect(page.rows.every((r) => !r.selected)).toBe(true);
	c.editLocal({ command: '"/opt/my agent/run" --acp' });
	c.commit();
	await tick();
	expect(f.remembered[1]).toEqual({
		kind: "agent",
		where: "local",
		command: ["/opt/my agent/run", "--acp"],
	});
	await c.chooseFolder("Choose the agent's working folder");
	await tick();
	expect(c.state.local.cwd).toBe("/home/p/wow-notes");
	expect(f.remembered[2]).toMatchObject({ cwd: "/home/p/wow-notes" });
});

test("agents.find fails: its words, and an empty list", async () => {
	const f = fake({
		"agents.find": () => {
			throw new Error("Something went wrong (TypeError).");
		},
	});
	const c = new AgentController(f.deps, base);
	await c.findAgents();
	const page = presentAgent(c.state, view(), t);
	expect(page.findError).toBe("Something went wrong (TypeError).");
	expect(page.finding).toBe(false);
});

test("Use this: a known host goes straight on and says who answers now", async () => {
	const f = fake({ "ssh.hostKey": () => ({ known: true, fingerprint: FP }) });
	const c = new AgentController(f.deps, base);
	c.setWhere("ssh");
	c.editSsh(sshForm());
	await c.use();
	expect(f.calls.map(([m]) => m)).toEqual(["ssh.hostKey"]);
	expect(f.used).toHaveLength(1);
	const page = presentAgent(c.state, view(f.settings()), t);
	expect(page.result).toEqual({
		tone: "good",
		text: "Familiar now answers with hermes acp on homelab.",
	});
	expect(page.inUse).toBe(true);
	expect(c.state.busy).toBeUndefined();
});

test("Use this: an unknown host shows its fingerprint; trusting it goes on with the use", async () => {
	let known = false;
	const f = fake({
		"ssh.hostKey": () =>
			known ? { known: true } : { known: false, fingerprint: FP },
		"ssh.trust": () => {
			known = true;
			return null;
		},
	});
	const c = new AgentController(f.deps, base);
	c.setWhere("ssh");
	c.editSsh(sshForm());
	await c.use();
	expect(f.used).toEqual([]);
	expect(c.state.trust).toEqual({
		step: "ask",
		host: "homelab",
		fingerprint: FP,
		next: "use",
	});
	await c.trust();
	expect(f.calls.map(([m]) => m)).toEqual([
		"ssh.hostKey",
		"ssh.trust",
		"ssh.hostKey",
	]);
	expect(f.calls[1]?.[1]).toEqual({ host: "homelab", fingerprint: FP });
	expect(f.used).toHaveLength(1);
	expect(c.state.trust).toEqual({ step: "none" });
});

test("no fingerprint: the page explains, offers no trust, and nothing runs", async () => {
	const f = fake({ "ssh.hostKey": () => ({ known: false }) });
	const c = new AgentController(f.deps, base);
	c.setWhere("ssh");
	c.editSsh(sshForm());
	await c.connect();
	expect(c.state.trust).toEqual({ step: "unreachable", host: "homelab" });
	expect(f.calls.map(([m]) => m)).toEqual(["ssh.hostKey"]);
	// trust() does nothing without a fingerprint to confirm.
	await c.trust();
	expect(f.calls).toHaveLength(1);
	// Another host: the explanation was about the old one.
	c.editSsh({ host: "pi" });
	expect(c.state.trust).toEqual({ step: "none" });
});

test("a refused trust is the core's words; nothing goes on", async () => {
	const f = fake({
		"ssh.hostKey": () => ({ known: false, fingerprint: FP }),
		"ssh.trust": () => {
			throw new Error(
				"The other computer shows a different host key than the one you confirmed. Nothing was saved.",
			);
		},
	});
	const c = new AgentController(f.deps, base);
	c.setWhere("ssh");
	c.editSsh(sshForm());
	await c.connect();
	await c.trust();
	expect(presentAgent(c.state, view(), t).result?.text).toBe(
		"The other computer shows a different host key than the one you confirmed. Nothing was saved.",
	);
	expect(f.calls.map(([m]) => m)).toEqual(["ssh.hostKey", "ssh.trust"]);
});

test("Test connection: the program's path there, “Use this path”, then the brain's own Test", async () => {
	const f = fake({
		"ssh.hostKey": () => ({ known: true }),
		"ssh.test": () => ({
			ok: true,
			agentFound: true,
			agentPath: "/home/p/.local/bin/hermes",
		}),
	});
	const c = new AgentController(f.deps, base);
	c.setWhere("ssh");
	c.editSsh(sshForm());
	expect(presentAgent(c.state, view(), t).connected).toBe(false);
	await c.connect();
	expect(f.calls[1]).toEqual([
		"ssh.test",
		{ ssh: { host: "homelab", auth: "key", command: ["hermes", "acp"] } },
	]);
	let page = presentAgent(c.state, view(), t);
	expect(page.connected).toBe(true);
	expect(page.connection).toEqual({
		tone: "good",
		text: "Signed in, and the agent's program is there: /home/p/.local/bin/hermes",
	});
	expect(page.usePath).toBe("/home/p/.local/bin/hermes");
	c.usePath();
	await tick();
	expect(c.state.ssh.command).toBe("/home/p/.local/bin/hermes acp");
	page = presentAgent(c.state, view(), t);
	expect(page.usePath).toBeUndefined();
	// Still the same sign-in: the connection holds.
	expect(page.connected).toBe(true);
	expect(f.remembered.at(-1)).toMatchObject({
		ssh: { command: ["/home/p/.local/bin/hermes", "acp"] },
	});
	await c.test();
	expect(f.tested).toHaveLength(1);
	expect(presentAgent(c.state, view(), t).result).toEqual({
		tone: "good",
		text: "Answered in 6.4 s.",
		detail: "“Hello from Hermes.”",
	});
	// Another user signs in differently: the connection must be tested again.
	c.editSsh({ user: "q" });
	expect(presentAgent(c.state, view(), t).connected).toBe(false);
});

test("a failed connection shows the core's words, and a jump host with a password is said before", async () => {
	const viaJump =
		"Familiar does not sign in with a saved password or passphrase when your SSH config reaches that computer through another one (ProxyJump or ProxyCommand). Use a key without a passphrase, or one that your SSH agent holds.";
	const f = fake({
		"ssh.resolve": () => homelab,
		"ssh.hostKey": () => ({ known: true }),
		"ssh.test": () => ({ ok: false, problem: viaJump }),
	});
	const c = new AgentController(f.deps, base);
	c.setWhere("ssh");
	c.editSsh(sshForm({ auth: "password" }));
	await c.resolve();
	let page = presentAgent(c.state, view(), t);
	expect(page.viaJump).toBe(
		"Your .ssh/config connects to homelab through jump-host. Familiar does not use a saved password or passphrase there; use a key without a passphrase or your SSH agent.",
	);
	await c.connect();
	page = presentAgent(c.state, view(), t);
	expect(page.connection).toEqual({ tone: "bad", text: viaJump });
	expect(page.connected).toBe(false);
	c.setAuth("key");
	expect(presentAgent(c.state, view(), t).viaJump).toBeUndefined();
});

test("Use this that does not start: the problem, and that the agent is saved", async () => {
	const f = fake({ "agents.find": () => [hermes] });
	f.failUse("The agent program was not found: hermes");
	const c = new AgentController(f.deps, base);
	await c.findAgents();
	await c.use();
	expect(presentAgent(c.state, view(), t).result).toEqual({
		tone: "bad",
		text: "The agent program was not found: hermes",
		detail: "This agent is saved, but Familiar did not start with it.",
	});
});

test("an incomplete form shows what is missing only after Use or Test", async () => {
	const f = fake();
	const c = new AgentController(f.deps, base);
	c.setWhere("ssh");
	expect(presentAgent(c.state, view(), t).problems).toEqual({});
	expect(presentAgent(c.state, view(), t).complete).toBe(false);
	// A wrong value shows at once, an empty field does not.
	c.editSsh({ cwd: "~/x" });
	expect(presentAgent(c.state, view(), t).problems).toEqual({
		cwd: "agent.err.cwdAbsolute",
	});
	await c.use();
	expect(f.calls).toEqual([]);
	expect(f.used).toEqual([]);
	expect(presentAgent(c.state, view(), t).problems).toEqual({
		host: "agent.err.host",
		cwd: "agent.err.cwdAbsolute",
	});
});

test("an SSH result counts only for the form it was asked with", async () => {
	// Host A is tested; the player types host B while the host key is looked up.
	let answer = () => {};
	const f = fake({
		"ssh.hostKey": () =>
			new Promise((resolve) => {
				answer = () => resolve({ known: true });
			}),
		"ssh.test": () => ({ ok: true, agentFound: true, agentPath: "/a/hermes" }),
	});
	const c = new AgentController(f.deps, base);
	c.setWhere("ssh");
	c.editSsh({ host: "a", command: "hermes acp", cwd: "/home/p" });
	const running = c.connect();
	await tick();
	c.editSsh({ host: "b" });
	answer();
	await running;
	expect(f.calls.map(([m]) => m)).toEqual(["ssh.hostKey"]);
	expect(c.state.connection).toBeUndefined();
	expect(c.state.trust).toEqual({ step: "none" });
	// A connection result goes when the command it was tested with changes.
	const g = fake({
		"ssh.hostKey": () => ({ known: true }),
		"ssh.test": () => ({ ok: true, agentFound: true }),
	});
	const d = new AgentController(g.deps, base);
	d.setWhere("ssh");
	d.editSsh({ host: "a", command: "hermes acp", cwd: "/home/p" });
	await d.connect();
	expect(d.state.connection?.result.ok).toBe(true);
	d.editSsh({ command: "codex-acp" });
	expect(d.state.connection).toBeUndefined();
});

test("trusting goes on only with the form the question was about", async () => {
	let trustDone = () => {};
	const f = fake({
		"ssh.hostKey": () => ({ known: false, fingerprint: FP }),
		"ssh.trust": () =>
			new Promise((resolve) => {
				trustDone = () => resolve(null);
			}),
		"ssh.test": () => ({ ok: true, agentFound: true }),
	});
	const c = new AgentController(f.deps, base);
	c.setWhere("ssh");
	c.editSsh({ host: "a", command: "hermes acp", cwd: "/home/p" });
	await c.connect();
	expect(c.state.trust).toMatchObject({ step: "ask" });
	const trusting = c.trust();
	await tick();
	// Another command typed while trusting: it is not tested by itself.
	c.editSsh({ command: "codex-acp" });
	trustDone();
	await trusting;
	expect(f.calls.map(([m]) => m)).toEqual(["ssh.hostKey", "ssh.trust"]);
});

test("Use this: a result for a form changed while it ran is not shown", async () => {
	let started = () => {};
	const f = fake({ "ssh.hostKey": () => ({ known: true }) });
	f.deps.useBrain = () =>
		new Promise((resolve) => {
			started = () => resolve({ ok: true });
		});
	const c = new AgentController(f.deps, base);
	c.setWhere("ssh");
	c.editSsh({ host: "a", command: "hermes acp", cwd: "/home/p" });
	const using = c.use();
	await tick();
	c.editSsh({ command: "codex-acp" });
	started();
	await using;
	expect(c.state.result).toBeUndefined();
});

test("a brain saved but not running is not in use", () => {
	const s = presentAgent(initialState(base), view(base, false), t);
	expect(s.inUse).toBe(false);
	expect(presentAgent(initialState(base), view(base, true), t).inUse).toBe(
		true,
	);
	// The found agents' rows too.
	const found = { ...initialState(base), agents: [hermes] };
	expect(presentAgent(found, view(base, false), t).rows[0]?.inUse).toBe(false);
	expect(presentAgent(found, view(base, true), t).rows[0]?.inUse).toBe(true);
});

test("a result about the form goes when the form changes; an error stays", async () => {
	const f = fake();
	const c = new AgentController(f.deps, base);
	await c.test();
	expect(c.state.result?.kind).toBe("answered");
	// Leaving a field unchanged keeps it.
	c.editLocal({ command: "hermes acp" });
	expect(c.state.result?.kind).toBe("answered");
	c.editLocal({ command: "hermes acp --debug" });
	expect(c.state.result).toBeUndefined();
	f.deps.rememberBrain = async () => {
		throw new Error("The settings file could not be written.");
	};
	c.commit();
	await tick();
	c.editLocal({ command: "hermes acp" });
	expect(c.state.result?.kind).toBe("error");
});

test("a test that fails says why; one that ends after the tab closed is dropped", async () => {
	const f = fake();
	f.holdTest(
		Promise.resolve({
			ok: false,
			ms: 80_000,
			problem: "The brain did not answer within 80 s.",
			tools: [],
		}),
	);
	const c = new AgentController(f.deps, base);
	await c.test();
	expect(presentAgent(c.state, view(), t).result).toEqual({
		tone: "bad",
		text: "The brain did not answer within 80 s.",
	});

	let finish: (r: BrainTest) => void = () => {};
	f.holdTest(new Promise((r) => (finish = r)));
	const late = new AgentController(f.deps, base);
	const seen: unknown[] = [];
	late.watch((s) => seen.push(s.result));
	const running = late.test();
	expect(late.state.busy).toBe("test");
	// One call at a time: Use waits for nothing and does nothing while the test runs.
	await late.use();
	expect(f.used).toEqual([]);
	late.dispose();
	finish({ ok: true, ms: 5000, answer: "late", tools: [] });
	await running;
	expect(late.state.result).toBeUndefined();
	expect(seen.every((r) => r === undefined)).toBe(true);
});

test("permissions: saved for every agent through the settings queue, put back when that fails", async () => {
	const f = fake();
	const c = new AgentController(f.deps, base);
	await c.setPermissions("deny");
	expect(f.settings().brain?.permissions).toBe("deny");
	expect(f.settings().brain?.command).toEqual(["hermes", "acp"]);
	expect(c.state.permissions).toBe("deny");
	f.deps.updateSettings = async () => {
		throw new Error("The settings file could not be written.");
	};
	await c.setPermissions("allow");
	expect(c.state.permissions).toBe("deny");
	expect(presentAgent(c.state, view(), t).result?.text).toBe(
		"The settings file could not be written.",
	);
});

test("a password goes to ssh.setSecret only and never into the state", async () => {
	const f = fake({
		"ssh.hostKey": () => ({ known: true }),
		"ssh.test": () => ({
			ok: false,
			problem: "The other computer refused the sign-in (permission denied).",
		}),
		"ssh.setSecret": () => null,
	});
	const c = new AgentController(f.deps, base);
	c.setWhere("ssh");
	c.editSsh(sshForm({ auth: "password" }));
	await c.connect();
	expect(presentAgent(c.state, view(), t).connection?.tone).toBe("bad");
	const secret = "correct horse battery staple";
	expect(await c.saveSecret(secret)).toBe(true);
	// The refusal was without the password: it goes.
	expect(presentAgent(c.state, view(), t).connection).toBeUndefined();
	expect(f.calls.slice(2)).toEqual([
		["ssh.setSecret", { host: "homelab", kind: "password", value: secret }],
	]);
	expect(JSON.stringify(c.state)).not.toContain(secret);
	expect(presentAgent(c.state, view(), t).result?.text).toBe(
		"Saved in the system keychain.",
	);
	// With a key there is nothing to save.
	c.setAuth("key");
	expect(await c.saveSecret(secret)).toBe(false);
	expect(f.calls).toHaveLength(3);
	// The keychain refuses: its words, still nothing kept.
	f.deps.call = async () => {
		throw new Error("No system keychain was found.");
	};
	c.setAuth("passphrase");
	expect(await c.saveSecret(secret)).toBe(false);
	expect(JSON.stringify(c.state)).not.toContain(secret);
	expect(presentAgent(c.state, view(), t).result?.text).toBe(
		"No system keychain was found.",
	);
});

test("switching places changes nothing saved and clears the last result", async () => {
	const f = fake({ "ssh.resolve": () => homelab });
	const c = new AgentController(f.deps, {
		...base,
		app: {
			brains: {
				ssh: {
					host: "homelab",
					auth: "key",
					command: ["hermes", "acp"],
					cwd: "/home/p",
				},
			},
		},
	});
	await c.test();
	expect(c.state.result).toBeDefined();
	c.setWhere("ssh");
	expect(c.state.result).toBeUndefined();
	await tick();
	// Opening the SSH form looks up the computer it holds.
	expect(f.calls).toEqual([["ssh.resolve", { host: "homelab" }]]);
	expect(f.remembered).toEqual([]);
	expect(f.used).toEqual([]);
});
