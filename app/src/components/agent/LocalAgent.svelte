<script lang="ts">
// "On this PC": the agents the core found, or any command, and the working folder here.
import type {
	AgentController,
	AgentPage,
	AgentState,
} from "../../lib/agent.ts";
import type { Translate } from "../../lib/i18n.ts";

let {
	c,
	s,
	p,
	t,
}: { c: AgentController; s: AgentState; p: AgentPage; t: Translate } = $props();

const busy = $derived(p.busy !== undefined);
</script>

<div class="label">{t("agent.found")}</div>
<div class="list" role="radiogroup" aria-label={t("agent.found")}>
	{#each p.rows as row, i (row.id)}
		<button
			type="button"
			role="radio"
			aria-checked={row.selected}
			class="found"
			class:sel={row.selected}
			disabled={busy}
			onclick={() => {
				const agent = s.agents?.[i];
				if (agent) c.pickAgent(agent);
			}}
		>
			<span class="radio" aria-hidden="true"></span>
			<span class="what">
				<span class="name">
					{row.name}{#if row.inUse}<span class="connected-text">{` · ${t("agent.rowInUse")}`}</span>{/if}
				</span>
				<small><span class="code mono">{row.command}</span></small>
				{#if row.detail}<small>{row.detail}</small>{/if}
				{#if row.needs}<small class="waiting-text">{row.needs}</small>{/if}
			</span>
			<span class="status" class:connected-text={row.ready} class:waiting-text={!row.ready}
				>{row.status}</span
			>
		</button>
	{/each}
	<button
		type="button"
		role="radio"
		aria-checked={p.other}
		class="found"
		class:sel={p.other}
		disabled={busy}
		onclick={() => c.pickOther()}
	>
		<span class="radio" aria-hidden="true"></span>
		<span class="what">
			<span class="name">{t("agent.other")}</span>
			<small>{t("agent.otherSub")}</small>
		</span>
		<span class="status"></span>
	</button>
</div>
{#if p.finding && !s.agents}
	<p class="note">{t("agent.searching")}</p>
{:else if p.none}
	<p class="note">{t("agent.none")}</p>
{/if}
{#if p.findError}<p class="note error-text">{p.findError}</p>{/if}
<div class="row">
	<button class="btn ghost small" disabled={p.finding} onclick={() => c.findAgents()}>
		↻ {p.finding ? t("agent.searching") : t("agent.search")}
	</button>
</div>

{#if p.other}
	<div class="field">
		<label for="agent-command">{t("agent.command")}</label>
		<input
			id="agent-command"
			class="input mono-input"
			spellcheck="false"
			autocomplete="off"
			value={s.local.command}
			aria-invalid={p.problems.command !== undefined}
			oninput={(e) => c.editLocal({ command: e.currentTarget.value })}
			onblur={() => c.commit()}
		/>
		{#if p.problems.command}
			<p class="note error-text">{t(p.problems.command)}</p>
		{:else}
			<p class="note">{t("agent.commandHint")}</p>
		{/if}
	</div>
{/if}

<div class="field">
	<label for="agent-cwd">{t("agent.cwd")}</label>
	<div class="with-button">
		<input
			id="agent-cwd"
			class="input"
			spellcheck="false"
			autocomplete="off"
			value={s.local.cwd}
			oninput={(e) => c.editLocal({ cwd: e.currentTarget.value })}
			onblur={() => c.commit()}
		/>
		<button class="btn" disabled={busy} onclick={() => c.chooseFolder(t("agent.pickTitle"))}>
			{t("agent.choose")}
		</button>
	</div>
	<p class="note">{t("agent.cwdHint")}</p>
</div>
