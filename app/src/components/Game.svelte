<script lang="ts">
import { untrack } from "svelte";
import { GameController, type GameState, presentGame } from "../lib/game.ts";
import type { Translate } from "../lib/i18n.ts";
import type { MainApp } from "../lib/main-app.ts";
import type { View } from "../lib/overview.ts";
import RestartBanner from "./RestartBanner.svelte";

let {
	app,
	view,
	t,
	restartNeeded,
	onRestartFamiliar,
}: {
	app: MainApp;
	view: View;
	t: Translate;
	restartNeeded: boolean;
	onRestartFamiliar: () => Promise<void>;
} = $props();

const game = new GameController({
	call: (method, params, timeoutMs) => app.call(method, params, timeoutMs),
	pickFolder: () => app.pickFolder(),
	refreshStatus: () => app.refreshStatus(),
	statusClient: () => app.view.status?.client,
	running: () => app.view.status?.running === true,
	start: () => app.startFamiliar(),
});

let current: GameState = $state.raw(game.state);
$effect(() => game.watch((next) => (current = next)));

// Ask when the page opens, and again for each new core; a stopped core answers nothing.
const gen = $derived(view.exited ? 0 : view.gen);
$effect(() => {
	if (gen > 0) untrack(() => void game.load());
});

const p = $derived(presentGame(current, view, t));
const dot = $derived(
	p.addon.tone === "good"
		? "connected"
		: p.addon.tone === "warn"
			? "waiting"
			: "off",
);
</script>

<main>
	<h1>{t("page.game.heading")}</h1>
	<p class="sub">{t("page.game.sub")}</p>

	{#if restartNeeded}
		<RestartBanner {t} onRestart={onRestartFamiliar} />
	{/if}

	<section class="card">
		<div class="label">{t("client.found")}</div>
		{#if p.rows.length > 0}
			<div class="clients" role="radiogroup" aria-label={t("client.found")}>
				{#each p.rows as row (row.client)}
					<button
						type="button"
						role="radio"
						aria-checked={row.inUse}
						class="client"
						class:sel={row.inUse}
						disabled={p.busy !== undefined}
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
			<p class="empty">{p.empty ? t("client.none") : t("client.searching")}</p>
		{/if}
		<div class="row">
			<button class="btn ghost" disabled={p.busy !== undefined} onclick={() => game.load()}>
				↻ {p.busy === "find" ? t("client.searching") : t("client.search")}
			</button>
			<button class="btn" disabled={p.busy !== undefined} onclick={() => game.choose()}>
				{t("client.choose")}
			</button>
		</div>
		{#if p.findError}<p class="line error-text">{p.findError}</p>{/if}
	</section>

	<h2>{t("addon.title")}</h2>
	<section class="card">
		<dl class="kv">
			<dt>{t("addon.status")}</dt>
			<dd><span class="dot {dot}"></span>{p.addon.status}</dd>
			<dt>{t("addon.connection")}</dt>
			<dd>{p.addon.connection}</dd>
			<dt>{t("addon.running")}</dt>
			<dd>
				{p.addon.wowRunning}{#if p.addon.hint}<span class="waiting-text">{` · ${p.addon.hint}`}</span>{/if}
			</dd>
		</dl>
		{#if p.confirming}
			<div class="row confirm" role="alertdialog" aria-label={t("addon.confirm")}>
				<span>{t("addon.confirm")}</span>
				<button class="btn" onclick={() => game.uninstall()}>{t("addon.confirmYes")}</button>
				<button class="btn ghost" onclick={() => game.cancelUninstall()}>
					{t("addon.cancel")}
				</button>
			</div>
		{:else}
			<div class="row">
				<button
					class="btn"
					disabled={p.busy !== undefined || !p.client}
					onclick={() => game.repair()}
				>
					<!-- The same call installs what is missing: say so when nothing is there yet. -->
					{p.addon.tone === "off" ? t("addon.install") : t("addon.repair")}
				</button>
				<button
					class="btn ghost"
					disabled={p.busy !== undefined || !p.client}
					onclick={() => game.askUninstall()}
				>
					{t("addon.uninstall")}
				</button>
			</div>
		{/if}
		{#if p.outcome}
			<p class="line" class:error-text={p.outcome.error}>{p.outcome.text}</p>
		{/if}
	</section>
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

	h2 {
		font-family: var(--serif);
		font-size: 15px;
		font-weight: 700;
		letter-spacing: 0.04em;
		color: var(--gold);
		margin: 22px 0 10px;
	}

	.sub {
		color: var(--muted);
		font-size: 13px;
		margin-bottom: 22px;
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

	.client:hover:not(:disabled):not(.sel) {
		border-color: var(--gold-dim);
	}

	.client:disabled {
		cursor: default;
	}

	.client:focus-visible {
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

	.confirm span {
		font-size: 13.5px;
		margin-right: 4px;
	}

	.line {
		margin-top: 12px;
		font-size: 13px;
		line-height: 1.5;
		user-select: text;
	}

	.kv {
		display: grid;
		grid-template-columns: 150px minmax(0, 1fr);
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
</style>
