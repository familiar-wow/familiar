<script lang="ts">
// The setup assistant on first start: game, addon, then the kind of brain, which hands over to
// the Brain page. The game and the addon run through the Game page's GameController; the
// steps, when Next is allowed and what the lines say come from lib/setup.ts.
import { untrack } from "svelte";
import { GameController, type GameState } from "../lib/game.ts";
import type { Key, Translate } from "../lib/i18n.ts";
import type { MainApp } from "../lib/main-app.ts";
import type { View } from "../lib/overview.ts";
import {
	presentSetup,
	SetupController,
	type SetupState,
	type SetupStep,
} from "../lib/setup.ts";

let { app, view, t }: { app: MainApp; view: View; t: Translate } = $props();

const game = new GameController({
	call: (method, params, timeoutMs) => app.call(method, params, timeoutMs),
	pickFolder: () => app.pickFolder(),
	refreshStatus: () => app.refreshStatus(),
	statusClient: () => app.view.status?.client,
	running: () => app.view.status?.running === true,
	// Familiar does not run during the first start: finishing the assistant starts it
	// (MainApp.finishSetup), so installing the addon here must not.
	start: async () => {},
	updateSettings: (change) =>
		app.updateSettings((settings) =>
			change(settings as Record<string, unknown>),
		),
});
const setup = new SetupController({
	finishSetup: (then, tab) => app.finishSetup(then, tab),
});

let gameState: GameState = $state.raw(game.state);
let setupState: SetupState = $state.raw(setup.state);
$effect(() => game.watch((next) => (gameState = next)));
$effect(() => setup.watch((next) => (setupState = next)));

// Ask when the page opens, and again for each new core; a stopped core answers nothing.
const gen = $derived(view.exited ? 0 : view.gen);
$effect(() => {
	if (gen > 0) untrack(() => void game.load());
});

const p = $derived(presentSetup(setupState, gameState, view, t));
const stepName: Record<SetupStep, Key> = {
	game: "setup.step.game",
	addon: "setup.step.addon",
	brain: "setup.step.brain",
};
const dot = $derived(
	p.addon.tone === "good"
		? "connected"
		: p.addon.tone === "warn"
			? "waiting"
			: "off",
);

// A new step: its heading gets the focus, so a screen reader hears where the player is.
let heading: HTMLElement | undefined = $state();
let firstStep = true;
$effect(() => {
	void p.step;
	if (firstStep) firstStep = false;
	else untrack(() => heading?.focus());
});
</script>

<main>
	<div class="wizard">
		<header>
			<div class="sigil" aria-hidden="true">F</div>
			<div>
				<h1>{t("setup.title")}</h1>
				<p class="sub">{t("setup.sub")}</p>
			</div>
		</header>

		<ol class="steps" aria-label={t("setup.progress")}>
			{#each p.progress as item (item.step)}
				<li class={item.state} aria-current={item.state === "current" ? "step" : undefined}>
					<span class="num" aria-hidden="true">{item.state === "done" ? "✓" : item.n}</span>
					<span>{t(stepName[item.step])}</span>
				</li>
			{/each}
		</ol>

		<section class="card">
			{#if p.step === "game"}
				<h2 tabindex="-1" bind:this={heading}>{t("setup.game.heading")}</h2>
				<p class="text">{t("setup.game.text")}</p>
				{#if view.status?.running !== true}
					<p class="hint">{t("setup.startsLater")}</p>
				{/if}
				<div class="label">{t("client.found")}</div>
				{#if p.game.rows.length > 0}
					<div class="clients" role="radiogroup" aria-label={t("client.found")}>
						{#each p.game.rows as row (row.client)}
							<button
								type="button"
								role="radio"
								aria-checked={row.inUse}
								class="client"
								class:sel={row.inUse}
								disabled={p.busy}
								onclick={() => game.select(row.client)}
							>
								<span class="radio" aria-hidden="true"></span>
								<span class="what">
									<span class="path mono">{row.client}</span>
									<small>
										{row.version ? t("client.version", { version: row.version }) : ""}
										{#if row.inUse}<span class="connected-text"
												>{row.version ? " · " : ""}{t("client.inUse")}</span
											>{/if}
									</small>
								</span>
								{#if row.inUse}<span class="check connected-text" aria-hidden="true">✓</span>{/if}
							</button>
						{/each}
					</div>
				{:else}
					<p class="empty">{p.game.empty ? t("client.none") : t("client.searching")}</p>
				{/if}
				<div class="row">
					<button class="btn ghost" disabled={p.busy} onclick={() => game.load()}>
						↻ {p.game.busy === "find" ? t("client.searching") : t("client.search")}
					</button>
					<button class="btn" disabled={p.busy} onclick={() => game.choose()}>
						{t("client.choose")}
					</button>
				</div>
				{#if p.game.findError}
					<p class="line error-text">{p.game.findError}</p>
				{:else if p.game.rows.length > 0 && !p.canNext && !p.busy}
					<p class="line muted">{t("setup.game.pick")}</p>
				{/if}
			{:else if p.step === "addon"}
				<h2 tabindex="-1" bind:this={heading}>{t("setup.addon.heading")}</h2>
				<p class="text">{t("setup.addon.text")}</p>
				<dl class="kv">
					<dt>{t("setup.addon.client")}</dt>
					<dd class="path mono">{p.addon.client ?? ""}</dd>
					<dt>{t("addon.status")}</dt>
					<dd><span class="dot {dot}"></span>{p.addon.status}</dd>
					<dt>{t("addon.running")}</dt>
					<dd>{p.addon.wowRunning}</dd>
				</dl>
				{#if p.addon.action}
					<div class="row">
						<button class="btn primary" disabled={p.busy} onclick={() => game.repair()}>
							{p.game.busy === "repair"
								? t("setup.addon.installing")
								: p.addon.action === "update"
									? t("setup.addon.update")
									: t("addon.install")}
						</button>
					</div>
				{/if}
				{#if p.addon.result}
					<p
						class="line"
						class:error-text={p.addon.result.error}
						class:connected-text={!p.addon.result.error}
					>
						{p.addon.result.error ? "" : "✓ "}{p.addon.result.text}
					</p>
					{#if p.addon.result.hint}
						<p class="hint" class:warn={p.addon.result.hint.waiting}>{p.addon.result.hint.text}</p>
					{/if}
				{:else if p.addon.current}
					<p class="line connected-text">✓ {t("setup.addon.current")}</p>
				{/if}
			{:else}
				<h2 tabindex="-1" bind:this={heading}>{t("setup.brain.heading")}</h2>
				<p class="text">{t("setup.brain.text")}</p>
				<div class="kinds">
					{#each p.brain.cards as card (card.kind)}
						<button
							type="button"
							class="kind"
							class:sel={card.inUse}
							disabled={p.busy}
							onclick={() => setup.choose(card.kind)}
						>
							<span class="name">
								{card.name}
								{#if card.inUse}<span class="chip">{t("setup.brain.inUse")}</span>{/if}
							</span>
							<ul>
								{#each card.pros as pro (pro)}<li class="pro">{pro}</li>{/each}
								{#each card.cons as con (con)}<li class="con">{con}</li>{/each}
							</ul>
							<span class="go">{t("setup.brain.setUp")} →</span>
						</button>
					{/each}
				</div>
				<div class="later">
					<p>{p.brain.later}</p>
					<button class="btn" disabled={p.busy} onclick={() => setup.finish()}>
						{t("setup.later")}
					</button>
				</div>
			{/if}
		</section>

		{#if p.error}<p class="line error-text">{p.error}</p>{/if}
		<footer>
			<button class="btn ghost" disabled={setupState.finishing} onclick={() => setup.finish()}>
				{setupState.finishing ? t("setup.finishing") : t("setup.skip")}
			</button>
			<span class="push"></span>
			{#if p.canBack}
				<button class="btn ghost" disabled={p.busy} onclick={() => setup.back()}>
					← {t("setup.back")}
				</button>
			{/if}
			{#if p.step !== "brain"}
				<button class="btn primary" disabled={!p.canNext} onclick={() => setup.next(p.canNext)}>
					{t("setup.next")} →
				</button>
			{/if}
		</footer>
	</div>
</main>

<style>
	/* Only the step's card scrolls, so Back, Next and Skip stay in sight in a small window. */
	main {
		padding: 28px 34px 24px;
		overflow: hidden;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}

	.wizard {
		width: 100%;
		max-width: 760px;
		min-height: 0;
		margin: 0 auto;
		display: flex;
		flex-direction: column;
	}

	.wizard > section {
		min-height: 0;
		overflow: auto;
	}

	header,
	.steps {
		flex: none;
	}

	header {
		display: flex;
		align-items: center;
		gap: 14px;
		margin-bottom: 22px;
	}

	h1 {
		font-family: var(--serif);
		font-size: 22px;
		font-weight: 700;
		letter-spacing: 0.04em;
		margin-bottom: 4px;
	}

	h2 {
		font-family: var(--serif);
		font-size: 16px;
		font-weight: 700;
		letter-spacing: 0.04em;
		color: var(--gold);
		margin-bottom: 6px;
	}

	h2:focus {
		outline: none;
	}

	.sub {
		color: var(--muted);
		font-size: 13px;
	}

	.text {
		color: var(--muted);
		font-size: 13.5px;
		line-height: 1.5;
		margin-bottom: 14px;
	}

	.steps {
		list-style: none;
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 16px;
		font-size: 13px;
		color: var(--muted);
	}

	.steps li {
		display: flex;
		align-items: center;
		gap: 8px;
		flex: 1;
	}

	/* A line between the steps, gold up to the current one. */
	.steps li:not(:last-child)::after {
		content: "";
		flex: 1;
		height: 1px;
		background: var(--line);
		margin-left: 4px;
	}

	.steps li.done:not(:last-child)::after {
		background: var(--gold);
	}

	.steps li:last-child {
		flex: none;
	}

	.num {
		width: 24px;
		height: 24px;
		flex: none;
		border-radius: 50%;
		border: 1px solid var(--line);
		display: grid;
		place-items: center;
		font-size: 12px;
		font-weight: 600;
	}

	.current {
		color: var(--gold);
	}

	.current .num {
		border-color: var(--gold);
		background: var(--gold);
		color: #1a1408;
		box-shadow: 0 0 12px rgba(217, 178, 106, 0.35);
	}

	.done {
		color: var(--text);
	}

	.done .num {
		border-color: var(--gold);
		background: rgba(217, 178, 106, 0.16);
		color: var(--gold);
	}

	.hint {
		font-size: 12.5px;
		color: #cfc8b8;
		line-height: 1.6;
		background: rgba(122, 162, 232, 0.07);
		border: 1px solid rgba(122, 162, 232, 0.28);
		border-radius: 8px;
		padding: 9px 12px;
		margin: 0 0 16px;
		user-select: text;
	}

	.line + .hint {
		margin-top: 10px;
		margin-bottom: 0;
	}

	.hint.warn {
		background: rgba(224, 164, 78, 0.08);
		border-color: rgba(224, 164, 78, 0.35);
		color: var(--warn);
	}

	.clients {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.client {
		display: grid;
		grid-template-columns: 22px minmax(0, 1fr) auto;
		gap: 12px;
		align-items: center;
		width: 100%;
		padding: 12px 14px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--panel);
		color: var(--text);
		text-align: left;
		cursor: pointer;
	}

	.client:hover:not(:disabled):not(.sel),
	.kind:hover:not(:disabled) {
		border-color: var(--gold-dim);
	}

	.client:disabled,
	.kind:disabled {
		cursor: default;
	}

	.client:focus-visible,
	.kind:focus-visible {
		outline: 2px solid var(--gold);
		outline-offset: 2px;
	}

	.client.sel {
		border-color: var(--gold);
		box-shadow: 0 0 0 1px var(--gold);
	}

	.radio {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		border: 2px solid #4a5060;
	}

	.sel .radio {
		border: 5px solid var(--gold);
	}

	.what {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.path {
		color: #cfc8b8;
		overflow-wrap: anywhere;
		user-select: text;
	}

	.what small {
		color: var(--muted);
		font-size: 12px;
	}

	.check {
		font-size: 15px;
	}

	.empty {
		color: var(--muted);
		font-size: 13.5px;
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		align-items: center;
		margin-top: 14px;
	}

	.line {
		margin-top: 12px;
		font-size: 13px;
		line-height: 1.5;
		user-select: text;
	}

	.muted {
		color: var(--muted);
	}

	.kv {
		display: grid;
		grid-template-columns: 130px minmax(0, 1fr);
		gap: 9px 14px;
		font-size: 13.5px;
		line-height: 1.5;
	}

	.kv dt {
		color: var(--muted);
	}

	.kv dd {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.kv .dot {
		width: 9px;
		height: 9px;
		margin-right: 8px;
		vertical-align: 0;
	}

	.dot.off {
		background: #4a5060;
	}

	.kinds {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 10px;
	}

	.kind {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 13px 14px;
		border: 1px solid var(--line);
		border-radius: 10px;
		background: var(--panel);
		color: var(--text);
		text-align: left;
		cursor: pointer;
	}

	.kind.sel {
		border-color: var(--gold-dim);
	}

	.name {
		display: flex;
		align-items: center;
		gap: 8px;
		font-family: var(--serif);
		font-weight: 700;
		font-size: 14px;
		letter-spacing: 0.03em;
	}

	.name .chip {
		font-family: var(--sans);
		font-weight: 400;
		letter-spacing: 0;
		border-color: rgba(127, 194, 138, 0.5);
		color: var(--ok);
	}

	.kind ul {
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 3px;
		font-size: 12.5px;
		line-height: 1.45;
		flex: 1;
	}

	.kind li::before {
		display: inline-block;
		width: 16px;
	}

	.pro::before {
		content: "+";
		color: var(--ok);
	}

	.con {
		color: var(--muted);
	}

	.con::before {
		content: "–";
	}

	.go {
		font-size: 12.5px;
		color: var(--gold);
	}

	.later {
		display: flex;
		align-items: center;
		gap: 14px;
		margin-top: 14px;
		padding-top: 14px;
		border-top: 1px solid var(--line);
		font-size: 13px;
		line-height: 1.5;
		color: var(--muted);
	}

	.later p {
		flex: 1;
	}

	footer {
		flex: none;
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 14px;
	}

	.push {
		flex: 1;
	}
</style>
