<script lang="ts">
// "On another computer (SSH)": one field for the computer, what .ssh/config makes of it, the
// overrides under "Advanced", the sign-in, the command and the working folder there.
import type {
	AgentController,
	AgentPage,
	AgentState,
} from "../../lib/agent.ts";
import type { SshAuth } from "../../lib/brain.ts";
import type { Key, Translate } from "../../lib/i18n.ts";

let {
	c,
	s,
	p,
	t,
}: { c: AgentController; s: AgentState; p: AgentPage; t: Translate } = $props();

const busy = $derived(p.busy !== undefined);
const AUTHS: [SshAuth, Key, Key][] = [
	["key", "agent.ssh.auth.key", "agent.ssh.hint.key"],
	["passphrase", "agent.ssh.auth.passphrase", "agent.ssh.hint.passphrase"],
	["password", "agent.ssh.auth.password", "agent.ssh.hint.password"],
];
const hint = $derived(
	AUTHS.find(([auth]) => auth === s.ssh.auth)?.[2] ?? "agent.ssh.hint.key",
);

// The computer is looked up after a short pause in typing, or when the field is left.
let timer: ReturnType<typeof setTimeout> | undefined;
function typedHost(value: string) {
	c.editSsh({ host: value });
	clearTimeout(timer);
	timer = setTimeout(() => {
		void c.resolve();
		void c.checkStored();
	}, 700);
}
// The sign-in method changed, or the tab opened with a computer: is a secret stored for it?
$effect(() => {
	void s.ssh.auth;
	void c.checkStored();
});
const stored = $derived(
	s.stored?.host === s.ssh.host.trim() && s.stored.auth === s.ssh.auth
		? s.stored.has
		: undefined,
);
$effect(() => () => clearTimeout(timer));

const resolved = $derived(
	s.resolved?.host === s.ssh.host.trim() ? s.resolved.result : undefined,
);
const fromConfig = $derived(t("agent.ssh.fromConfigPlaceholder"));
const keyPlaceholder = $derived(
	resolved?.identityFiles.length === 1
		? (resolved.identityFiles[0] ?? fromConfig)
		: fromConfig,
);

// The password or passphrase lives only in this field until it goes to the keychain.
let secret = $state("");
async function saveSecret() {
	const value = secret;
	secret = "";
	await c.saveSecret(value);
}
</script>

<div class="field">
	<label for="ssh-host">{t("agent.ssh.computer")}</label>
	<input
		id="ssh-host"
		class="input"
		spellcheck="false"
		autocomplete="off"
		placeholder="homelab"
		value={s.ssh.host}
		aria-invalid={p.problems.host !== undefined}
		oninput={(e) => typedHost(e.currentTarget.value)}
		onblur={() => {
			clearTimeout(timer);
			void c.resolve();
			void c.checkStored();
			c.commit();
		}}
	/>
	{#if p.problems.host}
		<p class="note error-text">{t(p.problems.host)}</p>
	{:else if p.resolveError}
		<p class="note error-text">{p.resolveError}</p>
	{:else if p.resolved}
		<p class="resolved mono">{p.resolved}</p>
	{:else if p.resolving}
		<p class="note">{t("agent.ssh.resolving")}</p>
	{:else}
		<p class="note">{t("agent.ssh.computerHint")}</p>
	{/if}
</div>

<button
	type="button"
	class="toggle"
	aria-expanded={s.advanced}
	aria-controls="ssh-advanced"
	onclick={() => c.toggleAdvanced()}
>
	<span aria-hidden="true">{s.advanced ? "▾" : "▸"}</span>
	{t("agent.ssh.advanced")}
</button>
{#if s.advanced}
	<div id="ssh-advanced" class="advanced">
		<p class="note first">{t("agent.ssh.advancedHint")}</p>
		<div class="two">
			<div class="field">
				<label for="ssh-user">{t("agent.ssh.user")}</label>
				<input
					id="ssh-user"
					class="input"
					spellcheck="false"
					autocomplete="off"
					placeholder={resolved?.user || fromConfig}
					value={s.ssh.user}
					aria-invalid={p.problems.user !== undefined}
					oninput={(e) => c.editSsh({ user: e.currentTarget.value })}
					onblur={() => c.commit()}
				/>
				{#if p.problems.user}<p class="note error-text">{t(p.problems.user)}</p>{/if}
			</div>
			<div class="field">
				<label for="ssh-key">{t("agent.ssh.key")}</label>
				<input
					id="ssh-key"
					class="input"
					spellcheck="false"
					autocomplete="off"
					placeholder={keyPlaceholder}
					value={s.ssh.identityFile}
					oninput={(e) => c.editSsh({ identityFile: e.currentTarget.value })}
					onblur={() => c.commit()}
				/>
			</div>
		</div>
	</div>
{/if}

<div class="field">
	<span class="field-label" id="ssh-auth">{t("agent.ssh.auth")}</span>
	<div class="seg" role="radiogroup" aria-labelledby="ssh-auth">
		{#each AUTHS as [auth, label] (auth)}
			<button
				type="button"
				role="radio"
				aria-checked={s.ssh.auth === auth}
				class:on={s.ssh.auth === auth}
				disabled={busy}
				onclick={() => c.setAuth(auth)}
			>
				{t(label)}
			</button>
		{/each}
	</div>
</div>

{#if p.viaJump}
	<p class="warn-box">{p.viaJump}</p>
{:else if s.ssh.auth !== "key"}
	<div class="field">
		<label for="ssh-secret">
			{s.ssh.auth === "password" ? t("agent.ssh.password") : t("agent.ssh.passphrase")}
		</label>
		<div class="with-button">
			<input
				id="ssh-secret"
				class="input"
				type="password"
				autocomplete="new-password"
				spellcheck="false"
				bind:value={secret}
				onkeydown={(e) => {
					if (e.key === "Enter" && secret) void saveSecret();
				}}
			/>
			<button
				class="btn"
				disabled={busy || !secret || !s.ssh.host.trim()}
				onclick={saveSecret}
			>
				{t("agent.ssh.secretSave")}
			</button>
		</div>
		<p class="note">
			{stored ? t("agent.ssh.secretStored") : t("agent.ssh.secretNote")}
		</p>
	</div>
{/if}

{#if !p.viaJump}
	<div class="hint">
		<b>{t("agent.ssh.hintLead")}</b>
		{t(hint)}
	</div>
{/if}

<div class="two spaced">
	<div class="field">
		<label for="ssh-command">{t("agent.ssh.command")}</label>
		<input
			id="ssh-command"
			class="input mono-input"
			spellcheck="false"
			autocomplete="off"
			value={s.ssh.command}
			aria-invalid={p.problems.command !== undefined}
			oninput={(e) => c.editSsh({ command: e.currentTarget.value })}
			onblur={() => c.commit()}
		/>
		{#if p.problems.command}
			<p class="note error-text">{t(p.problems.command)}</p>
		{:else}
			<p class="note">{t("agent.ssh.commandHint")}</p>
		{/if}
	</div>
	<div class="field">
		<label for="ssh-cwd">{t("agent.ssh.cwd")}</label>
		<input
			id="ssh-cwd"
			class="input mono-input"
			spellcheck="false"
			autocomplete="off"
			placeholder="/home/you"
			value={s.ssh.cwd}
			aria-invalid={p.problems.cwd !== undefined}
			oninput={(e) => c.editSsh({ cwd: e.currentTarget.value })}
			onblur={() => c.commit()}
		/>
		{#if p.problems.cwd}
			<p class="note error-text">{t(p.problems.cwd)}</p>
		{:else}
			<p class="note">{t("agent.ssh.cwdHint")}</p>
		{/if}
	</div>
</div>
