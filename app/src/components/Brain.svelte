<script lang="ts">
// The Brain page: one tab per kind of brain, each with its own settings. Switching tabs never
// changes the brain that answers; only a tab's "Use this" does.
import { untrack } from "svelte";
import { answersNow, type BrainKind } from "../lib/brain.ts";
import { openingTab, prosCons, TABS, tabRows } from "../lib/brain-page.ts";
import type { Translate } from "../lib/i18n.ts";
import type { MainApp } from "../lib/main-app.ts";
import type { View } from "../lib/overview.ts";
import AgentTab from "./AgentTab.svelte";
import ChatGptTab from "./brain/ChatGptTab.svelte";
import KeyTab from "./brain/KeyTab.svelte";
import LocalTab from "./brain/LocalTab.svelte";

let { app, view, t }: { app: MainApp; view: View; t: Translate } = $props();

// The tab the player clicked; until then the one a page asked for, else the brain that answers.
let chosen: BrainKind | undefined = $state();
// A page may ask for a tab while this one is open (the setup assistant opens the page, then the
// tab): follow a hint that changes, but not one that was there when the page opened.
let lastHint: BrainKind | undefined = untrack(() => view.brainTab);
$effect(() => {
	const hint = view.brainTab;
	if (hint && hint !== lastHint) chosen = hint;
	lastHint = hint;
});
const opening = untrack(() => view.brainTab);
const tab = $derived(chosen ?? openingTab(view.settings, opening));
const rows = $derived(tabRows(view.settings, t, answersNow(view.status)));
const pc = $derived(prosCons(tab, t));

const tabButtons: Partial<Record<BrainKind, HTMLButtonElement>> = $state({});

// Arrow keys move between the tabs, as in any tab list.
function keydown(event: KeyboardEvent) {
	const step =
		event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
	if (!step) return;
	event.preventDefault();
	const i = TABS.indexOf(tab);
	const next = TABS[(i + step + TABS.length) % TABS.length] ?? tab;
	chosen = next;
	tabButtons[next]?.focus();
}
</script>

<main>
	<h1>{t("brain.title")}</h1>
	<p class="sub">{t("brain.sub")}</p>

	<div class="tabs" role="tablist" aria-label={t("brain.tabs")} tabindex="-1" onkeydown={keydown}>
		{#each rows as row (row.kind)}
			<button
				bind:this={tabButtons[row.kind]}
				type="button"
				role="tab"
				id="brain-tab-{row.kind}"
				aria-selected={tab === row.kind}
				aria-controls="brain-panel"
				tabindex={tab === row.kind ? 0 : -1}
				class:on={tab === row.kind}
				onclick={() => (chosen = row.kind)}
			>
				{row.label}{#if row.inUse}<span class="in-use connected-text">{t("brain.tab.inUse")}</span>{/if}
			</button>
		{/each}
	</div>

	<div id="brain-panel" role="tabpanel" aria-labelledby="brain-tab-{tab}">
		<div class="pc">
			<ul class="pros" aria-label={t("brain.pros")}>
				{#each pc.pros as text (text)}
					<li><span aria-hidden="true">+</span>{text}</li>
				{/each}
			</ul>
			<ul class="cons" aria-label={t("brain.cons")}>
				{#each pc.cons as text (text)}
					<li><span aria-hidden="true">−</span>{text}</li>
				{/each}
			</ul>
		</div>

		{#if !view.settings}
			<p class="loading">{t("brain.loading")}</p>
		{:else if tab === "chatgpt"}
			<ChatGptTab {app} {view} {t} />
		{:else if tab === "key"}
			<KeyTab {app} {view} {t} />
		{:else if tab === "local"}
			<LocalTab {app} {view} {t} />
		{:else}
			<AgentTab {app} {view} {t} />
		{/if}
	</div>
</main>

<style>
	main {
		padding: 28px 34px 40px;
		overflow: auto;
		min-width: 0;
	}

	h1 {
		font-family: var(--serif);
		font-size: 22px;
		font-weight: 700;
		letter-spacing: 0.04em;
		margin-bottom: 4px;
	}

	.sub {
		color: var(--muted);
		font-size: 13px;
		margin-bottom: 20px;
		max-width: 720px;
		line-height: 1.5;
	}

	.tabs {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-bottom: 14px;
		border-bottom: 1px solid var(--line);
	}

	.tabs button {
		padding: 9px 14px;
		margin-bottom: -1px;
		border: 0;
		border-bottom: 2px solid transparent;
		background: transparent;
		color: var(--muted);
		font-size: 13.5px;
		cursor: pointer;
	}

	.tabs button:hover:not(.on) {
		color: var(--text);
	}

	.tabs button.on {
		color: var(--gold);
		border-bottom-color: var(--gold);
	}

	.tabs button:focus-visible {
		outline: 2px solid var(--gold);
		outline-offset: -2px;
	}

	.in-use {
		margin-left: 6px;
		font-size: 12px;
	}

	.pc {
		display: flex;
		flex-direction: column;
		gap: 5px;
		margin-bottom: 14px;
		font-size: 12.5px;
		color: var(--muted);
	}

	.pc ul {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: 4px 18px;
	}

	.pc li {
		display: inline-flex;
		gap: 6px;
	}

	.pros span {
		color: var(--ok);
		font-weight: 600;
	}

	.cons span {
		color: var(--warn);
		font-weight: 600;
	}

	.loading {
		color: var(--muted);
		font-size: 13.5px;
	}
</style>
