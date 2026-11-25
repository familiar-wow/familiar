<script lang="ts">
// The buttons every model tab ends with: Use this, Test, the tab's own, then one line about the
// last action. Everything shown is text: answers and errors come from the brain or the core.
import type { Snippet } from "svelte";
import { type Busy, type Result, resultLine } from "../../lib/brain-page.ts";
import type { Translate } from "../../lib/i18n.ts";
import type { Language } from "../../lib/types.ts";

let {
	t,
	language,
	busy,
	ready,
	inUse,
	result,
	onUse,
	onTest,
	hideButtons = false,
	children,
}: {
	t: Translate;
	language: Language;
	busy?: Busy;
	/** The tab holds a complete brain. */
	ready: boolean;
	/** That brain answers now. */
	inUse: boolean;
	result?: Result;
	onUse: () => void;
	onTest: () => void;
	/** Only the line, such as on the signed-out ChatGPT tab. */
	hideButtons?: boolean;
	children?: Snippet;
} = $props();

const line = $derived(result ? resultLine(result, t, language) : undefined);
</script>

{#if !hideButtons}
<div class="row">
	<button class="btn primary" disabled={!ready || busy !== undefined} onclick={onUse}>
		{t("brain.use")}
	</button>
	<button class="btn" disabled={!ready || busy !== undefined} onclick={onTest}>
		{t("brain.test")}
	</button>
	{@render children?.()}
	{#if inUse}<span class="in-use connected-text">{t("brain.inUse")}</span>{/if}
</div>
{/if}
{#if busy === "test" || busy === "use"}
	<p class="line waiting" role="status">
		<span class="spin" aria-hidden="true"></span>{busy === "test" ? t("brain.testing") : t("brain.using")}
	</p>
{:else if line}
	<div class="result {line.tone}" role="status">
		<p>{#if line.tone === "ok"}<span class="tick connected-text" aria-hidden="true">✓</span>{/if}{line.text}</p>
		{#if line.detail}<p class="detail">{line.detail}</p>{/if}
	</div>
{/if}

<style>
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		align-items: center;
		margin-top: 16px;
	}

	.in-use {
		font-size: 13px;
		margin-left: 4px;
	}

	.line {
		margin-top: 12px;
		font-size: 13px;
		color: var(--muted);
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.spin {
		width: 12px;
		height: 12px;
		flex: none;
		border-radius: 50%;
		border: 2px solid var(--gold-dim);
		border-top-color: var(--gold);
		animation: spin 0.9s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.result {
		margin-top: 14px;
		font-size: 13px;
		line-height: 1.5;
		padding: 10px 12px;
		border-radius: 8px;
		user-select: text;
		overflow-wrap: anywhere;
	}

	.result.ok {
		background: rgba(127, 194, 138, 0.08);
		border: 1px solid rgba(127, 194, 138, 0.3);
	}

	.result.error {
		background: rgba(212, 106, 95, 0.08);
		border: 1px solid rgba(212, 106, 95, 0.35);
	}

	.result.info {
		background: rgba(122, 162, 232, 0.07);
		border: 1px solid rgba(122, 162, 232, 0.28);
	}

	.tick {
		margin-right: 6px;
	}

	.detail {
		margin-top: 4px;
		color: #cfc8b8;
		white-space: pre-wrap;
	}

	.ok .detail {
		font-style: italic;
	}
</style>
