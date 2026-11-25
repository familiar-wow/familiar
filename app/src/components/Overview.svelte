<script lang="ts">
import type { Translate } from "../lib/i18n.ts";
import type { Overview } from "../lib/overview.ts";

let {
	o,
	t,
	onRestartCore,
	onRestartFamiliar,
}: {
	o: Overview;
	t: Translate;
	onRestartCore: () => Promise<void>;
	onRestartFamiliar: () => Promise<void>;
} = $props();

let busy = $state(false);

// One click at a time: a restart takes a moment, and a second one would only queue up.
async function once(action: () => Promise<void>) {
	if (busy) return;
	busy = true;
	try {
		await action();
	} finally {
		busy = false;
	}
}
</script>

<main>
	<h1>{o.heading}</h1>
	<p class="sub">{o.sub}</p>

	{#if o.restartNeeded}
		<div class="banner" role="status">
			<span>{t("restart.banner")}</span>
			<button class="btn" disabled={busy} onclick={() => once(onRestartFamiliar)}>
				{t("restart.button")}
			</button>
		</div>
	{/if}

	<div class="grid">
		<section class="card">
			<div class="label">{t("card.game")}</div>
			<div class="big">
				<span class="dot {o.connection}"></span>
				<span>{o.game.headline}</span>
			</div>
			{#if o.game.name || o.game.who || o.game.contact}
				<div class="meta">
					{#if o.game.name}<em>{o.game.name}</em>{/if}{o.game.name && o.game.who
						? " · "
						: ""}{o.game.who ?? ""}
					{#if o.game.contact}<br />{o.game.contact}{/if}
				</div>
			{/if}
			{#if o.game.stderr}
				<div class="stderr mono">{o.game.stderr}</div>
			{/if}
			{#if o.game.canRestart}
				<div class="row">
					<button class="btn primary" disabled={busy} onclick={() => once(onRestartCore)}>
						{t("game.restart")}
					</button>
				</div>
			{/if}
		</section>

		<section class="card">
			<div class="label">{t("card.brain")}</div>
			<div class="big">{o.brain.name}</div>
			{#if o.brain.detail || o.brain.last}
				<div class="meta">
					{#if o.brain.detail}<span class="mono">{o.brain.detail}</span>{/if}
					{#if o.brain.detail && o.brain.last}<br />{/if}
					{#if o.brain.last}{o.brain.last}{/if}
				</div>
			{/if}
		</section>

		{#if o.problems.length > 0}
			<section class="card wide problems">
				<div class="label">{t("card.problems")}</div>
				<ul>
					{#each o.problems as problem, i (i)}
						<li>{problem}</li>
					{/each}
				</ul>
			</section>
		{/if}

		<section class="card wide">
			<div class="label">{t("card.questions")}</div>
			{#if o.questions.length === 0}
				<p class="empty">{t("questions.empty")}</p>
			{:else}
				<ol class="questions">
					{#each o.questions as q, i (`${q.at}-${i}`)}
						<li>
							<span class="time">{q.time}</span>
							<span class="body">
								{#if q.text !== undefined}
									<span class="text one-line" title={q.text}>{q.text}</span>
								{:else}
									<span class="text cut">{t("questions.cut")}</span>
								{/if}
								{#if q.tools.length > 0}
									<span class="tools">
										{#each q.tools as tool (tool)}<span class="chip">{tool}</span>{/each}
									</span>
								{/if}
							</span>
							<span class="duration">{q.duration}</span>
						</li>
					{/each}
				</ol>
			{/if}
		</section>
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
		margin-bottom: 22px;
	}

	.banner {
		display: flex;
		align-items: center;
		gap: 14px;
		justify-content: space-between;
		margin-bottom: 16px;
		padding: 10px 14px;
		border-radius: 10px;
		font-size: 13px;
		background: rgba(224, 164, 78, 0.08);
		border: 1px solid rgba(224, 164, 78, 0.35);
	}

	.grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 16px;
	}

	.wide {
		grid-column: 1 / -1;
	}

	.big {
		font-size: 18px;
		font-weight: 600;
		display: flex;
		align-items: center;
		gap: 10px;
		line-height: 1.35;
	}

	.meta {
		color: var(--muted);
		font-size: 13px;
		margin-top: 8px;
		line-height: 1.6;
	}

	.meta em {
		color: var(--text);
		font-style: normal;
	}

	.stderr {
		margin-top: 10px;
		padding: 6px 10px;
		border-radius: 6px;
		background: #0a0c11;
		border: 1px solid var(--line);
		color: #cfc8b8;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		user-select: text;
	}

	.row {
		display: flex;
		gap: 10px;
		margin-top: 14px;
	}

	.problems ul {
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 8px;
		font-size: 13.5px;
		user-select: text;
	}

	.problems li {
		padding-left: 16px;
		position: relative;
		line-height: 1.5;
	}

	.problems li::before {
		content: "!";
		position: absolute;
		left: 0;
		color: var(--bad);
		font-weight: 700;
	}

	.empty {
		color: var(--muted);
		font-size: 13.5px;
	}

	.questions {
		list-style: none;
		font-size: 13.5px;
	}

	.questions li {
		display: grid;
		grid-template-columns: 54px minmax(0, 1fr) 70px;
		gap: 0 6px;
		padding: 10px 6px;
		border-top: 1px solid var(--line);
	}

	.questions li:first-child {
		border-top: 0;
	}

	.time,
	.duration {
		color: var(--muted);
	}

	.duration {
		text-align: right;
		white-space: nowrap;
	}

	.body {
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.text {
		display: block;
	}

	.cut {
		color: var(--muted);
		font-style: italic;
	}

	.tools {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 4px;
	}
</style>
