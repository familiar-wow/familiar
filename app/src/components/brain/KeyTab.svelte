<script lang="ts">
// The API key tab: a provider, its key in the system keychain, and a model from its list.
import { untrack } from "svelte";
import {
	choiceFor,
	isActive,
	KEY_PROVIDERS,
	type KeyProvider,
} from "../../lib/brain.ts";
import {
	filterModels,
	KEY_PAGES,
	type KeyState,
	KeyTab,
	keyField,
	keySourceText,
	modelRow,
	PROVIDER_NAMES,
} from "../../lib/brain-page.ts";
import type { Translate } from "../../lib/i18n.ts";
import type { MainApp } from "../../lib/main-app.ts";
import type { View } from "../../lib/overview.ts";
import Actions from "./Actions.svelte";

let { app, view, t }: { app: MainApp; view: View; t: Translate } = $props();

/** The list shows this many rows at most; typing narrows it down. */
const MAX_ROWS = 200;

const initial = untrack(() => choiceFor(view.settings ?? {}, "key"));
const tab = new KeyTab(
	{
		call: (method, params) => app.call(method, params),
		useBrain: (choice) => app.useBrain(choice),
		testBrain: (choice) => app.testBrain(choice),
		rememberBrain: (choice) => app.rememberBrain(choice),
		setKey: (provider, key) => app.setKey(provider, key),
		deleteKey: (provider) => app.deleteKey(provider),
		keys: () => app.view.keys,
		keySources: () => app.view.keySources,
	},
	initial?.kind === "key" ? initial : undefined,
);

let s: KeyState = $state.raw(tab.state);
$effect(() => {
	const off = tab.watch((next) => (s = next));
	return () => {
		off();
		tab.dispose();
	};
});
$effect(() => untrack(() => void tab.load()));

// The key is only ever in this field until it is saved; it never goes into the tab's state.
let key = $state("");
// The model field: what it shows, and whether the player typed since it got the focus.
let query = $state(untrack(() => tab.state.model ?? ""));
let typed = $state(false);
let open = $state(false);
let active = $state(0);

const field = $derived(
	keyField(s.provider, view.keys, view.keySources, s.replacing),
);
const hits = $derived(filterModels(s.models ?? [], typed ? query : ""));
const rows = $derived(
	hits.slice(0, MAX_ROWS).map((m) => modelRow(m, t, view.language)),
);
const chosen = $derived(s.models?.find((m) => m.id === s.model));
const choice = $derived(s.model ? tab.choice() : undefined);
const inUse = $derived(
	choice !== undefined &&
		view.settings !== undefined &&
		isActive(view.settings, choice),
);
const busy = $derived(s.busy !== undefined);

async function provider(p: KeyProvider) {
	key = "";
	const going = tab.selectProvider(p);
	query = tab.state.model ?? "";
	typed = false;
	await going;
}

async function save() {
	if (await tab.saveKey(key)) key = "";
}

function pick(id: string) {
	tab.pick(id);
	query = id;
	typed = false;
	open = false;
}

function focus() {
	open = true;
	typed = false;
	active = Math.max(
		0,
		rows.findIndex((r) => r.id === s.model),
	);
}

function blur() {
	open = false;
	// Half-typed text is no model: the field shows the one the tab holds again.
	if (typed) query = s.model ?? "";
	typed = false;
}

function input() {
	typed = true;
	open = true;
	active = 0;
}

function keydown(event: KeyboardEvent) {
	if (event.key === "ArrowDown" || event.key === "ArrowUp") {
		event.preventDefault();
		open = true;
		const step = event.key === "ArrowDown" ? 1 : -1;
		active = Math.min(Math.max(active + step, 0), Math.max(rows.length - 1, 0));
		document
			.getElementById(`key-model-${active}`)
			?.scrollIntoView({ block: "nearest" });
	} else if (event.key === "Enter") {
		const row = rows[active];
		if (open && row) {
			event.preventDefault();
			pick(row.id);
		}
	} else if (event.key === "Escape" && open) {
		event.preventDefault();
		open = false;
		query = s.model ?? "";
		typed = false;
	}
}
</script>

<section class="card">
	<div class="field">
		<span class="lbl" id="key-provider">{t("brain.key.provider")}</span>
		<div class="seg" role="radiogroup" aria-labelledby="key-provider">
			{#each KEY_PROVIDERS as p (p)}
				<button
					type="button"
					role="radio"
					aria-checked={s.provider === p}
					class:on={s.provider === p}
					disabled={busy && s.busy !== "models"}
					onclick={() => provider(p)}
				>
					{PROVIDER_NAMES[p]}
				</button>
			{/each}
		</div>
	</div>

	<div class="field">
		<label class="lbl" for="key-input">{t("brain.key.key")}</label>
		{#if field.state === "stored"}
			<div class="stored">
				<span><span class="connected-text">✓</span> {t("brain.key.stored")}
					<span class="muted">· {keySourceText(s.provider, field.source, t)}</span></span>
				<button class="btn ghost small-btn" disabled={busy} onclick={() => tab.replace()}>
					{t("brain.key.replace")}
				</button>
				{#if field.removable}
					<button class="btn ghost small-btn" disabled={busy} onclick={() => tab.removeKey()}>
						{t("brain.key.remove")}
					</button>
				{/if}
			</div>
		{:else}
			<form
				class="key-row"
				onsubmit={(e) => {
					e.preventDefault();
					void save();
				}}
			>
				<input
					id="key-input"
					class="input mono"
					type="password"
					autocomplete="off"
					spellcheck="false"
					placeholder={t("brain.key.placeholder")}
					bind:value={key}
					disabled={busy}
				/>
				<button class="btn" type="submit" disabled={busy || !key.trim()}>
					{s.busy === "key" ? t("brain.key.saving") : t("brain.key.save")}
				</button>
				{#if s.replacing}
					<button class="btn ghost" type="button" onclick={() => tab.cancelReplace()}>
						{t("brain.key.cancel")}
					</button>
				{/if}
			</form>
			<p class="note">{t("brain.key.where")}</p>
		{/if}
		<p class="note">{t("brain.key.get", { site: KEY_PAGES[s.provider] })}</p>
	</div>

	<div class="field combo-field">
		<div class="lbl-row">
			<label class="lbl" for="key-model">{t("brain.key.model")}</label>
			<span class="lbl-side">
				{#if s.models}<span class="muted">{t("brain.key.count", { n: s.models.length })}</span>{/if}
				<button
					class="link"
					disabled={busy || !view.keys[s.provider]}
					onclick={() => tab.listModels()}
				>
					{t("brain.key.refresh")}
				</button>
			</span>
		</div>
		{#if s.models}
			<input
				id="key-model"
				class="input"
				class:combo={open}
				role="combobox"
				aria-expanded={open}
				aria-controls="key-models"
				aria-autocomplete="list"
				aria-activedescendant={open && rows[active] ? `key-model-${active}` : undefined}
				autocomplete="off"
				spellcheck="false"
				placeholder={t("brain.key.search", { example: s.models[0]?.id ?? "" })}
				bind:value={query}
				disabled={busy}
				onfocus={focus}
				onblur={blur}
				oninput={input}
				onkeydown={keydown}
			/>
			{#if open}
				<div class="drop" id="key-models" role="listbox" aria-label={t("brain.key.model")}>
					{#each rows as row, i (row.id)}
						<!-- The input keeps the focus; the keyboard works through it. -->
						<div
							id="key-model-{i}"
							class="opt"
							class:hi={i === active}
							class:sel={row.id === s.model}
							role="option"
							tabindex="-1"
							aria-selected={row.id === s.model}
							onmousedown={(e) => e.preventDefault()}
							onclick={() => pick(row.id)}
							onkeydown={() => {}}
							onmouseenter={() => (active = i)}
						>
							<div class="opt-top">
								<b class="mono">{row.id}</b>
								{#if row.recommended}<span class="chip">{t("brain.key.recommended")}</span>{/if}
							</div>
							{#if row.name || row.price || row.noTools}
								<small>
									{[row.name, row.price].filter(Boolean).join(" · ")}
									{#if row.noTools}<span class="waiting-text"
											>{row.name || row.price ? " · " : ""}{t("brain.key.noTools")}</span
										>{/if}
								</small>
							{/if}
						</div>
					{:else}
						<div class="opt empty">{t("brain.key.noMatch")}</div>
					{/each}
				</div>
			{/if}
			{#if chosen?.tools === false}
				<p class="note warn">{t("brain.key.noTools")}</p>
			{/if}
		{:else}
			<p class="muted">
				{s.busy === "models"
					? t("brain.key.loading")
					: view.keys[s.provider]
						? t("brain.key.refreshHint")
						: t("brain.key.needKey")}
			</p>
		{/if}
	</div>

	<Actions
		{t}
		language={view.language}
		busy={s.busy}
		ready={choice !== undefined}
		{inUse}
		result={s.result}
		onUse={() => tab.use()}
		onTest={() => tab.test()}
	/>
</section>

<style>
	.field {
		margin-bottom: 16px;
	}

	.lbl {
		display: block;
		font-size: 12px;
		color: var(--muted);
		margin-bottom: 6px;
	}

	.lbl-row {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: 10px;
	}

	.lbl-side {
		display: inline-flex;
		gap: 12px;
		align-items: baseline;
		font-size: 12px;
	}

	.link {
		border: 0;
		background: transparent;
		color: var(--gold);
		font-size: 12px;
		cursor: pointer;
	}

	.link:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.link:focus-visible {
		outline: 2px solid var(--gold);
		outline-offset: 2px;
	}

	.seg {
		display: inline-flex;
		flex-wrap: wrap;
		background: #0f1219;
		border: 1px solid var(--line);
		border-radius: 9px;
		padding: 3px;
		gap: 3px;
	}

	.seg button {
		padding: 6px 14px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--muted);
		font-size: 13px;
		cursor: pointer;
	}

	.seg button:hover:not(.on):not(:disabled) {
		color: var(--text);
	}

	.seg button.on {
		background: var(--panel2);
		color: var(--gold);
		box-shadow: inset 0 0 0 1px var(--gold-dim);
	}

	.seg button:disabled {
		cursor: default;
	}

	.seg button:focus-visible {
		outline: 2px solid var(--gold);
		outline-offset: 1px;
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

	.key-row {
		display: flex;
		gap: 10px;
		align-items: center;
	}

	.stored {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		align-items: center;
		font-size: 13.5px;
	}

	.small-btn {
		padding: 3px 10px;
		font-size: 12px;
	}

	.note {
		font-size: 12.5px;
		color: var(--muted);
		margin-top: 8px;
		line-height: 1.5;
		user-select: text;
	}

	.muted {
		color: var(--muted);
		font-size: 13px;
	}

	.combo-field {
		position: relative;
	}

	.drop {
		position: absolute;
		left: 0;
		right: 0;
		top: calc(100% + 4px);
		max-height: 300px;
		overflow: auto;
		background: #10141c;
		border: 1px solid var(--gold-dim);
		border-radius: 8px;
		box-shadow: 0 12px 30px rgba(0, 0, 0, 0.5);
		z-index: 5;
	}

	.opt {
		padding: 8px 12px;
		font-size: 13px;
		border-bottom: 1px solid #1d2330;
		cursor: pointer;
	}

	.opt:last-child {
		border-bottom: 0;
	}

	.opt.hi {
		background: rgba(217, 178, 106, 0.1);
	}

	.opt.sel b {
		color: var(--gold);
	}

	.opt.empty {
		color: var(--muted);
		cursor: default;
	}

	.opt-top {
		display: flex;
		justify-content: space-between;
		gap: 10px;
		align-items: center;
	}

	.opt b {
		font-weight: 500;
		font-size: 12.5px;
		overflow-wrap: anywhere;
	}

	.opt small {
		display: block;
		color: var(--muted);
		font-size: 11.5px;
		margin-top: 2px;
	}

	.note.warn {
		color: var(--warn);
	}
</style>
