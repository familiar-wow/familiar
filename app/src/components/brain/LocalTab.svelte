<script lang="ts">
// The local model tab: Ollama and LM Studio on this PC, or any OpenAI-compatible server by its
// address, and one of its models.
import { untrack } from "svelte";
import { answersNow, choiceFor, isActive } from "../../lib/brain.ts";
import {
	type LocalState,
	LocalTab,
	serverCard,
	toolsHint,
} from "../../lib/brain-page.ts";
import type { Translate } from "../../lib/i18n.ts";
import type { MainApp } from "../../lib/main-app.ts";
import type { View } from "../../lib/overview.ts";
import Actions from "./Actions.svelte";

let { app, view, t }: { app: MainApp; view: View; t: Translate } = $props();

const initial = untrack(() => choiceFor(view.settings ?? {}, "local"));
const tab = new LocalTab(
	{
		call: (method, params) => app.call(method, params),
		useBrain: (choice) => app.useBrain(choice),
		testBrain: (choice) => app.testBrain(choice),
		rememberBrain: (choice) => app.rememberBrain(choice),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	},
	initial?.kind === "local" ? initial : undefined,
);

let s: LocalState = $state.raw(tab.state);
$effect(() => {
	const off = tab.watch((next) => (s = next));
	return () => {
		off();
		tab.dispose();
	};
});
$effect(() => untrack(() => void tab.load()));

let address = $state(tab.initialAddress);

const cards = $derived(
	(s.servers ?? []).map((server) => serverCard(server, t)),
);
const models = $derived.by(() => {
	void s;
	return tab.models();
});
const chosen = $derived(models.find((m) => m.id === s.model));
const choice = $derived.by(() => {
	void s;
	return tab.choice();
});
const inUse = $derived(
	choice !== undefined &&
		view.settings !== undefined &&
		answersNow(view.status) &&
		isActive(view.settings, choice),
);
const busy = $derived(s.busy !== undefined);
// Ollama tells whether a model can call tools; the others do not, so theirs is "not known".
function option(id: string, tools: boolean | undefined): string {
	return `${id} · ${toolsHint(tools, t).text}`;
}
</script>

<section class="card">
	<div class="label">{t("brain.local.found")}</div>
	{#if !s.servers}
		<p class="muted">{t("brain.local.searching")}</p>
	{:else}
		<div class="servers" role="radiogroup" aria-label={t("brain.local.found")}>
			{#each cards as card (card.kind)}
				<div class="found" class:sel={s.source === card.kind} class:off={card.state !== "running"}>
					<button
						type="button"
						role="radio"
						class="pick"
						aria-checked={s.source === card.kind}
						disabled={card.state !== "running" || busy}
						onclick={() => tab.select(card.kind)}
					>
						<span class="radio" aria-hidden="true"></span>
						<span class="what">
							<span>
								{card.name}
								<span
									class:connected-text={card.state === "running"}
									class:waiting-text={card.state === "off"}
									class:muted-text={card.state === "missing"}>· {card.status}</span
								>
							</span>
							<small>{card.detail}</small>
						</span>
					</button>
					{#if card.canStart}
						<button class="btn" disabled={busy} onclick={() => tab.start(card.kind)}>
							{s.busy === "start" ? t("brain.local.starting") : t("brain.local.start")}
						</button>
					{:else if card.state === "running"}
						{#if s.source === card.kind}<span class="connected-text" aria-hidden="true">✓</span>{/if}
					{/if}
				</div>
			{/each}

			<div class="found" class:sel={s.source === "other"}>
				<button
					type="button"
					role="radio"
					class="pick"
					aria-checked={s.source === "other"}
					disabled={busy}
					onclick={() => tab.selectOther()}
				>
					<span class="radio" aria-hidden="true"></span>
					<span class="what">
						<span>{t("brain.local.other")}</span>
						<small>{s.other ? s.other.baseUrl : t("brain.local.otherText")}</small>
					</span>
				</button>
				{#if s.source === "other" && s.other}<span class="connected-text" aria-hidden="true">✓</span>{/if}
			</div>
		</div>

		{#if s.source === "other"}
			<form
				class="field address"
				onsubmit={(e) => {
					e.preventDefault();
					void tab.search(address);
				}}
			>
				<label class="lbl" for="local-address">{t("brain.local.address")}</label>
				<div class="inline">
					<input
						id="local-address"
						class="input mono"
						type="text"
						autocomplete="off"
						spellcheck="false"
						placeholder="http://192.168.1.20:11434/v1"
						bind:value={address}
						disabled={busy}
					/>
					<button class="btn" type="submit" disabled={busy || !address.trim()}>
						{s.busy === "search" ? t("brain.local.searching") : t("brain.local.search")}
					</button>
				</div>
				<p class="note">{t("brain.local.addressHint")}</p>
			</form>
		{/if}

		{#if s.source && (s.source !== "other" || s.other)}
			<div class="field">
				<label class="lbl" for="local-model">{t("brain.local.model")}</label>
				{#if models.length > 0}
					<select
						id="local-model"
						class="input"
						value={s.model}
						disabled={busy}
						onchange={(e) => tab.pick(e.currentTarget.value)}
					>
						{#each models as m (m.id)}
							<option value={m.id}>{option(m.id, m.tools)}</option>
						{/each}
					</select>
					{#if chosen?.tools === false}
						<!-- The list already says it; a model without tools gets a warning of its own. -->
						<p class="note warn">{s.model}: {t("brain.local.toolsNo")}</p>
					{/if}
				{:else}
					<p class="muted">{t("brain.local.noModels")}</p>
				{/if}
			</div>
		{/if}
		<p class="note">{t("brain.local.note")}</p>
	{/if}

	<Actions
		{t}
		language={view.language}
		busy={s.busy}
		ready={choice !== undefined}
		{inUse}
		result={s.result}
		onUse={() => tab.use()}
		onTest={() => tab.test()}
	>
		<button class="btn ghost" disabled={busy} onclick={() => tab.load()}>
			{s.busy === "find" ? t("brain.local.searching") : t("brain.local.searchAgain")}
		</button>
	</Actions>
</section>

<style>
	.muted {
		color: var(--muted);
		font-size: 13.5px;
	}

	.muted-text {
		color: var(--muted);
	}

	.servers {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.found {
		display: flex;
		align-items: center;
		gap: 12px;
		padding-right: 14px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--panel);
	}

	.found.sel {
		border-color: var(--gold);
		box-shadow: 0 0 0 1px var(--gold);
	}

	.found:hover:not(.sel):not(.off) {
		border-color: var(--gold-dim);
	}

	.pick {
		flex: 1;
		min-width: 0;
		display: grid;
		grid-template-columns: 22px minmax(0, 1fr);
		gap: 12px;
		align-items: center;
		padding: 12px 0 12px 14px;
		border: 0;
		background: transparent;
		color: var(--text);
		text-align: left;
		font-size: 13.5px;
		cursor: pointer;
	}

	.pick:disabled {
		cursor: default;
	}

	.pick:focus-visible {
		outline: 2px solid var(--gold);
		outline-offset: 2px;
		border-radius: 8px;
	}

	.radio {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		border: 2px solid #4a5060;
	}

	.off .radio {
		opacity: 0.4;
	}

	.sel .radio {
		border: 5px solid var(--gold);
	}

	.what {
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
	}

	.what small {
		color: var(--muted);
		font-size: 12px;
		line-height: 1.45;
		overflow-wrap: anywhere;
	}

	.field {
		margin-top: 14px;
	}

	.lbl {
		display: block;
		font-size: 12px;
		color: var(--muted);
		margin-bottom: 6px;
	}

	.inline {
		display: flex;
		gap: 10px;
		align-items: center;
	}

	.input {
		width: 100%;
		background: #0f1219;
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 9px 12px;
		color: var(--text);
		font: inherit;
		font-size: 13.5px;
	}

	.input.mono {
		font-family: var(--mono);
		font-size: 12.5px;
	}

	.input:focus-visible {
		outline: none;
		border-color: var(--gold-dim);
		box-shadow: 0 0 0 3px rgba(217, 178, 106, 0.12);
	}

	.note {
		font-size: 12.5px;
		color: var(--muted);
		margin-top: 8px;
		line-height: 1.5;
	}

	.note.warn {
		color: var(--warn);
	}
</style>
