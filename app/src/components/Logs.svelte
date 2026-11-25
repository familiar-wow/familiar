<script lang="ts">
import type { Translate } from "../lib/i18n.ts";
import {
	clock,
	FILTERS,
	filterLines,
	type LogFilter,
	logEntries,
	plainText,
} from "../lib/logs.ts";
import type { View } from "../lib/overview.ts";
import { messageOf } from "../lib/types.ts";

let {
	view,
	t,
	onOpenFolder,
}: {
	view: View;
	t: Translate;
	onOpenFolder: () => Promise<void>;
} = $props();

let filter: LogFilter = $state("all");
let copied = $state(false);
let error: string | undefined = $state();
let box: HTMLDivElement | undefined = $state();
// Whether the view follows new lines: true while the player is at the bottom. Not reactive on
// purpose, so scrolling does not re-run the effect below.
let stuck = true;
let copiedTimer: ReturnType<typeof setTimeout> | undefined;

const entries = $derived(logEntries(view.lines, view.language));
const shown = $derived(filterLines(entries, filter));

$effect(() => {
	void shown;
	if (box && stuck) box.scrollTop = box.scrollHeight;
});

$effect(() => () => clearTimeout(copiedTimer));

function scrolled() {
	if (!box) return;
	stuck = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
}

function choose(next: LogFilter) {
	stuck = true;
	filter = next;
}

async function copy() {
	const text = plainText(shown);
	let ok = true;
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		ok = copyByHand(text);
	}
	if (!ok) return;
	copied = true;
	clearTimeout(copiedTimer);
	copiedTimer = setTimeout(() => (copied = false), 1500);
}

// Without the clipboard API (an older WebView, or no permission): a hidden text field.
function copyByHand(text: string): boolean {
	const area = document.createElement("textarea");
	area.value = text;
	area.setAttribute("readonly", "");
	area.style.position = "fixed";
	area.style.opacity = "0";
	document.body.append(area);
	area.select();
	try {
		return document.execCommand("copy");
	} catch {
		return false;
	} finally {
		area.remove();
	}
}

async function openFolder() {
	error = undefined;
	try {
		await onOpenFolder();
	} catch (e) {
		error = messageOf(e);
	}
}
</script>

<main>
	<h1>{t("page.logs.heading")}</h1>
	<p class="sub">{t("page.logs.sub")}</p>

	<div class="bar">
		<div class="filters" role="group">
			{#each FILTERS as f (f)}
				<button
					type="button"
					class="filter"
					class:on={filter === f}
					aria-pressed={filter === f}
					onclick={() => choose(f)}
				>
					{t(`logs.filter.${f}`)}
				</button>
			{/each}
		</div>
		<div class="actions">
			<button class="btn ghost" disabled={shown.length === 0} onclick={copy}>
				{copied ? t("logs.copied") : t("logs.copy")}
			</button>
			<button class="btn ghost" onclick={openFolder}>{t("logs.openFolder")}</button>
		</div>
	</div>
	{#if error}<p class="fail error-text">{error}</p>{/if}

	<div class="logs mono" bind:this={box} onscroll={scrolled}>
		{#if entries.length === 0}
			<p class="empty">{t("logs.empty")}</p>
		{:else if shown.length === 0}
			<p class="empty">{t("logs.emptyFilter")}</p>
		{:else}
			{#each shown as e, i (i)}
				<div class="ln">
					<span class="t">{clock(e.at)}</span>
					<span class="k {e.tone}">{e.kind}</span>
					<span class="x" class:dim={e.tone === "dim"}>{e.text}</span>
				</div>
			{/each}
		{/if}
	</div>
</main>

<style>
	main {
		padding: 28px 34px 28px;
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
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
		margin-bottom: 22px;
	}

	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 10px;
	}

	.filters,
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
	}

	.filter {
		font-size: 12px;
		padding: 4px 10px;
		border-radius: 99px;
		border: 1px solid var(--line);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}

	.filter:hover:not(.on) {
		color: var(--text);
	}

	.filter.on {
		border-color: var(--gold-dim);
		color: var(--gold);
		background: rgba(217, 178, 106, 0.08);
	}

	.filter:focus-visible {
		outline: 2px solid var(--gold);
		outline-offset: 2px;
	}

	.fail {
		font-size: 13px;
		margin-bottom: 10px;
		user-select: text;
	}

	.logs {
		flex: 1;
		min-height: 0;
		overflow: auto;
		padding: 12px 14px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: #0a0c11;
		line-height: 1.75;
		user-select: text;
	}

	/* In px: the bold labels may come from a face with other metrics than the bundled one. */
	.ln {
		line-height: 21px;
		display: grid;
		grid-template-columns: 9ch 10ch minmax(0, 1fr);
		gap: 0 1ch;
	}

	.t {
		color: #5d6575;
	}

	.k {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.x {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		color: var(--text);
	}

	.x.dim {
		color: var(--muted);
	}

	.k.info {
		color: #9ab0d0;
	}

	.k.good {
		color: var(--gold);
	}

	.k.warn {
		color: #f2884b;
		font-weight: 600;
	}

	.k.error {
		color: var(--bad);
		font-weight: 600;
	}

	.k.dim {
		color: #6c7280;
	}

	.empty {
		color: var(--muted);
		font-family: var(--sans);
		font-size: 13.5px;
	}
</style>
