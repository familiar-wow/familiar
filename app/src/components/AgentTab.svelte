<script lang="ts">
// The Brain page's "Your own agent" tab: on this PC or on another computer through SSH. The
// logic is in lib/agent.ts; this file renders it and passes MainApp in.
import { untrack } from "svelte";
import {
	AgentController,
	type AgentDeps,
	type AgentState,
	type Busy,
	hostKeyFile,
	presentAgent,
	type Where,
} from "../lib/agent.ts";
import type { Permissions } from "../lib/brain.ts";
import type { Key, Translate } from "../lib/i18n.ts";
import type { MainApp } from "../lib/main-app.ts";
import type { View } from "../lib/overview.ts";
import LocalAgent from "./agent/LocalAgent.svelte";
import SshAgent from "./agent/SshAgent.svelte";
import RestartBanner from "./RestartBanner.svelte";

let { app, view, t }: { app: MainApp; view: View; t: Translate } = $props();

const deps: AgentDeps = {
	call: (method, params) => app.call(method, params),
	rememberBrain: (choice) => app.rememberBrain(choice),
	useBrain: (choice) => app.useBrain(choice),
	testBrain: (choice) => app.testBrain(choice),
	updateSettings: (change) => app.updateSettings(change),
	pickFolder: (title) => app.pickFolder(title),
};

// The draft is taken from the settings once, when they are first there; later refreshes of
// `view.settings` do not overwrite what the player is typing.
let controller: AgentController | undefined = $state.raw();
let s: AgentState | undefined = $state.raw();
$effect(() => {
	const settings = view.settings;
	if (!settings || untrack(() => controller)) return;
	untrack(() => {
		const c = new AgentController(deps, settings);
		c.watch((next) => (s = next));
		controller = c;
		s = c.state;
		void c.findAgents();
		if (c.state.where === "ssh") void c.resolve();
	});
});
// A test may still run when the tab goes: its result is dropped.
$effect(() => () => controller?.dispose());

const p = $derived(s ? presentAgent(s, view, t) : undefined);
const busy = $derived(p?.busy !== undefined);
const restartNeeded = $derived(
	view.status?.restartNeeded === true && !view.exited,
);
const PLACES: [Where, Key][] = [
	["local", "agent.where.local"],
	["ssh", "agent.where.ssh"],
];
const PERMISSIONS: [Permissions, Key][] = [
	["ask", "agent.perm.ask"],
	["deny", "agent.perm.deny"],
	["allow", "agent.perm.allow"],
];
const WAITING: Partial<Record<Busy, Key>> = {
	test: "agent.testing",
	use: "agent.using",
	connect: "agent.ssh.connecting",
};
const waiting = $derived(p?.busy ? WAITING[p.busy] : undefined);
</script>

<section class="agent-tab">
	{#if restartNeeded}
		<RestartBanner {t} onRestart={async () => void (await app.restartFamiliar())} />
	{/if}
	{#if controller && s && p}
		{@const c = controller}
		<div class="card">
			<div class="field">
				<span class="field-label" id="agent-where">{t("agent.where")}</span>
				<div class="seg" role="radiogroup" aria-labelledby="agent-where">
					{#each PLACES as [where, label] (where)}
						<button
							type="button"
							role="radio"
							aria-checked={s.where === where}
							class:on={s.where === where}
							disabled={busy}
							onclick={() => c.setWhere(where)}
						>
							{t(label)}
						</button>
					{/each}
				</div>
			</div>

			{#if s.where === "local"}
				<LocalAgent {c} {s} {p} {t} />
			{:else}
				<SshAgent {c} {s} {p} {t} />
			{/if}

			<div class="field">
				<span class="field-label" id="agent-permissions">{t("agent.permissions")}</span>
				<div class="seg" role="radiogroup" aria-labelledby="agent-permissions">
					{#each PERMISSIONS as [permission, label] (permission)}
						<button
							type="button"
							role="radio"
							aria-checked={s.permissions === permission}
							class:on={s.permissions === permission}
							disabled={busy}
							onclick={() => c.setPermissions(permission)}
						>
							{t(label)}
						</button>
					{/each}
				</div>
				<p class="note">{t("agent.permNote")}</p>
			</div>

			<div class="row actions">
				<button class="btn primary" disabled={busy} onclick={() => c.use()}>
					{t("agent.use")}
				</button>
				{#if s.where === "local"}
					<button class="btn" disabled={busy} onclick={() => c.test()}>{t("agent.test")}</button>
				{:else}
					<button class="btn" disabled={busy} onclick={() => c.connect()}>
						{t("agent.ssh.testConnection")}
					</button>
					{#if p.connected}
						<button class="btn" disabled={busy} onclick={() => c.test()}>
							{t("agent.ssh.testAgent")}
						</button>
					{/if}
				{/if}
				{#if p.inUse}<span class="chip in-use">{t("agent.inUse")}</span>{/if}
			</div>

			{#if waiting}
				<p class="box wait" role="status">
					<span class="dot waiting"></span>
					{t(waiting)}
				</p>
			{/if}

			{#if p.trust.step === "ask"}
				<div class="box warn" role="alert">
					<p>
						<span class="waiting-text">!</span>
						{t("agent.ssh.trustFirst", { host: p.trust.host })}
						<span class="code mono select">{p.trust.fingerprint}</span>
					</p>
					{#if hostKeyFile(p.trust.type)}
						<p class="small">{t("agent.ssh.trustCompare")}</p>
						<p class="small">
							<span class="code mono select nowrap"
								>ssh-keygen -lf {hostKeyFile(p.trust.type)}</span
							>
						</p>
					{/if}
					<div class="row">
						<button class="btn" disabled={busy} onclick={() => c.trust()}>
							{t("agent.ssh.trustButton")}
						</button>
					</div>
				</div>
			{:else if p.trust.step === "unreachable"}
				<div class="box warn" role="alert">
					<p>
						<span class="waiting-text">!</span>
						{t("agent.ssh.unreachable", { host: p.trust.host })}
					</p>
				</div>
			{/if}

			{#if s.where === "ssh" && p.connection}
				<div class="box {p.connection.tone}">
					<p class="select">
						<span class={p.connection.tone === "good" ? "connected-text" : "error-text"}
							>{p.connection.tone === "good" ? "✓" : "✕"}</span
						>
						{p.connection.text}
					</p>
					{#if p.usePath}
						<p class="small">{t("agent.ssh.pathHint")}</p>
						<div class="row">
							<button class="btn" disabled={busy} onclick={() => c.usePath()}>
								{t("agent.ssh.usePath")}
							</button>
						</div>
					{:else if p.connected}
						<p class="small">{t("agent.ssh.testAfter")}</p>
					{/if}
				</div>
			{/if}

			{#if p.result}
				<div class="box {p.result.tone}" role="status">
					<p class="select">
						<span class={p.result.tone === "good" ? "connected-text" : "error-text"}
							>{p.result.tone === "good" ? "✓" : "✕"}</span
						>
						{p.result.text}
					</p>
					{#if p.result.detail}<p class="small select">{p.result.detail}</p>{/if}
				</div>
			{/if}
		</div>
	{:else}
		<p class="note">{t("agent.searching")}</p>
	{/if}
</section>

<style>
	/* Shared with ./agent/*.svelte, which render inside this tab. */
	.agent-tab :global(.field) {
		margin-bottom: 16px;
	}

	.agent-tab :global(.field label),
	.agent-tab :global(.field-label) {
		display: block;
		font-size: 12px;
		color: var(--muted);
		margin-bottom: 6px;
	}

	.agent-tab :global(.input) {
		width: 100%;
		min-width: 0;
		background: #0f1219;
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 9px 12px;
		color: var(--text);
		font: inherit;
		font-size: 13.5px;
		user-select: text;
	}

	.agent-tab :global(.input:focus-visible) {
		outline: none;
		border-color: var(--gold-dim);
		box-shadow: 0 0 0 1px var(--gold-dim);
	}

	.agent-tab :global(.input[aria-invalid="true"]) {
		border-color: var(--bad);
	}

	.agent-tab :global(.input::placeholder) {
		color: #5d6575;
	}

	.agent-tab :global(.mono-input) {
		font-family: var(--mono);
		font-size: 12.5px;
	}

	.agent-tab :global(.with-button) {
		display: flex;
		gap: 10px;
	}

	.agent-tab :global(.two) {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: 14px;
	}

	.agent-tab :global(.spaced) {
		margin-top: 16px;
	}

	.agent-tab :global(.note) {
		font-size: 12.5px;
		color: var(--muted);
		margin-top: 6px;
		line-height: 1.5;
	}

	.agent-tab :global(.note.first) {
		margin: 0 0 10px;
	}

	.agent-tab :global(.note.error-text) {
		color: var(--bad);
	}

	.agent-tab :global(.note.waiting-text) {
		color: var(--warn);
		margin-bottom: 4px;
	}

	.agent-tab :global(.seg) {
		display: inline-flex;
		flex-wrap: wrap;
		background: #0f1219;
		border: 1px solid var(--line);
		border-radius: 9px;
		padding: 3px;
		gap: 3px;
	}

	.agent-tab :global(.seg button) {
		padding: 6px 14px;
		border-radius: 6px;
		border: 0;
		background: transparent;
		color: var(--muted);
		font-size: 13px;
		cursor: pointer;
	}

	.agent-tab :global(.seg button:hover:not(:disabled):not(.on)) {
		color: var(--text);
	}

	.agent-tab :global(.seg button.on) {
		background: var(--panel2);
		color: var(--gold);
		box-shadow: inset 0 0 0 1px var(--gold-dim);
	}

	.agent-tab :global(.seg button:disabled) {
		cursor: default;
	}

	.agent-tab :global(.seg button:focus-visible),
	.agent-tab :global(.toggle:focus-visible),
	.agent-tab :global(.found:focus-visible) {
		outline: 2px solid var(--gold);
		outline-offset: 2px;
	}

	.agent-tab :global(.list) {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.agent-tab :global(.found) {
		display: grid;
		grid-template-columns: 22px minmax(0, 1fr) auto;
		gap: 12px;
		align-items: center;
		width: 100%;
		padding: 11px 14px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--panel);
		color: var(--text);
		text-align: left;
		font-size: 14px;
		cursor: pointer;
	}

	.agent-tab :global(.found:hover:not(:disabled):not(.sel)) {
		border-color: var(--gold-dim);
	}

	.agent-tab :global(.found:disabled) {
		cursor: default;
	}

	.agent-tab :global(.found.sel) {
		border-color: var(--gold);
		box-shadow: 0 0 0 1px var(--gold);
	}

	.agent-tab :global(.found .status) {
		font-size: 12.5px;
		white-space: nowrap;
	}

	.agent-tab :global(.radio) {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		border: 2px solid #4a5060;
	}

	.agent-tab :global(.sel .radio) {
		border: 5px solid var(--gold);
	}

	.agent-tab :global(.what) {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.agent-tab :global(.what small) {
		color: var(--muted);
		font-size: 12px;
		overflow-wrap: anywhere;
	}

	.agent-tab :global(.code) {
		background: #0f1219;
		border: 1px solid var(--line);
		border-radius: 5px;
		padding: 1px 6px;
		color: #cfc8b8;
		overflow-wrap: anywhere;
	}

	.agent-tab :global(.row) {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		align-items: center;
		margin-top: 10px;
	}

	.agent-tab :global(.btn.small) {
		padding: 5px 10px;
		font-size: 12.5px;
	}

	.agent-tab :global(.list ~ .row) {
		margin-bottom: 18px;
	}

	/* What ssh makes of the computer: read-only, so a caption, not a field. */
	.agent-tab :global(.resolved) {
		margin-top: 6px;
		padding-left: 10px;
		border-left: 2px solid var(--gold-dim);
		color: #cfc8b8;
		line-height: 1.6;
		overflow-wrap: anywhere;
		user-select: text;
	}

	.agent-tab :global(.warn-box) {
		font-size: 12.5px;
		line-height: 1.6;
		color: #cfc8b8;
		background: rgba(224, 164, 78, 0.08);
		border: 1px solid rgba(224, 164, 78, 0.35);
		border-radius: 8px;
		padding: 10px 12px;
	}

	.agent-tab :global(.toggle) {
		display: inline-flex;
		gap: 6px;
		align-items: center;
		background: none;
		border: 0;
		padding: 2px 0;
		margin-bottom: 16px;
		color: var(--gold);
		font-size: 13px;
		cursor: pointer;
	}

	.agent-tab :global(.advanced) {
		margin: -6px 0 16px;
		padding: 10px 0 0 14px;
		border-left: 2px solid var(--line);
	}

	.agent-tab :global(.hint) {
		font-size: 12.5px;
		color: #cfc8b8;
		line-height: 1.6;
		background: rgba(122, 162, 232, 0.07);
		border: 1px solid rgba(122, 162, 232, 0.28);
		border-radius: 8px;
		padding: 10px 12px;
	}

	.agent-tab :global(.hint b) {
		color: var(--blue);
		font-weight: 600;
	}

	.actions {
		margin-top: 4px;
	}

	.in-use {
		border-color: var(--ok);
		color: var(--ok);
		margin-left: 4px;
	}

	.box {
		margin-top: 14px;
		font-size: 13px;
		line-height: 1.5;
		padding: 10px 12px;
		border-radius: 8px;
		border: 1px solid var(--line);
		background: rgba(255, 255, 255, 0.02);
	}

	.box p + p {
		margin-top: 4px;
	}

	.box .row {
		line-height: normal;
	}

	.box.good {
		background: rgba(127, 194, 138, 0.08);
		border-color: rgba(127, 194, 138, 0.3);
	}

	.box.bad {
		background: rgba(212, 106, 95, 0.08);
		border-color: rgba(212, 106, 95, 0.35);
	}

	.box.warn {
		background: rgba(224, 164, 78, 0.08);
		border-color: rgba(224, 164, 78, 0.35);
	}

	.box.wait {
		display: flex;
		gap: 10px;
		align-items: center;
		color: var(--muted);
	}

	.box .small {
		font-size: 12.5px;
		color: var(--muted);
	}

	.select {
		user-select: text;
		overflow-wrap: anywhere;
	}

	.nowrap {
		white-space: nowrap;
	}
</style>
