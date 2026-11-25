<script lang="ts">
// The Settings page. The logic is in lib/settings-page.ts; this file renders it and passes
// MainApp in. Every control shows the saved value from `view.settings`.
import { untrack } from "svelte";
import { resolveLanguage, type Translate } from "../lib/i18n.ts";
import type { MainApp } from "../lib/main-app.ts";
import type { View } from "../lib/overview.ts";
import {
	CLOSE_LABELS,
	MAX_TIMEOUT,
	MIN_TIMEOUT,
	PERMISSION_LABELS,
	presentSettings,
	REPOSITORY,
	SettingsController,
	type SettingsPageState,
	TIMEOUT_CHOICES,
} from "../lib/settings-page.ts";
import type { CloseMode } from "../lib/types.ts";
import RestartBanner from "./RestartBanner.svelte";
import CopyText from "./settings/CopyText.svelte";
import Segmented from "./settings/Segmented.svelte";

let { app, view, t }: { app: MainApp; view: View; t: Translate } = $props();

const c = new SettingsController({
	call: (method, params) => app.call(method, params),
	saved: () => app.view.settings,
	updateApp: (change) => app.updateApp(change),
	setAutostart: (on) => app.setAutostart(on),
	updateSettings: (change) => app.updateSettings(change),
	refreshStatus: () => app.refreshStatus(),
	systemAutostart: () => app.systemAutostart(),
	appVersion: () => app.appVersion(),
});

let s: SettingsPageState = $state.raw(c.state);
$effect(() => c.watch((next) => (s = next)));

// Ask when the page opens, and again for each new core; a stopped core answers nothing.
const gen = $derived(view.exited ? 0 : view.gen);
$effect(() => {
	if (gen > 0) untrack(() => void c.load());
});

// What "System" means here, as MainApp resolves it (main.ts passes the same).
const system = resolveLanguage("system", navigator.language);
const p = $derived(presentSettings(s, view, t, system));

const closeOptions = $derived(
	(["tray", "quit"] as CloseMode[]).map((value) => ({
		value,
		label: t(CLOSE_LABELS[value]),
	})),
);
const timeoutOptions = $derived([
	...TIMEOUT_CHOICES.map((n) => ({
		value: n as number | "other",
		label: t("settings.timeout.seconds", { n }),
	})),
	{ value: "other" as const, label: t("settings.timeout.other") },
]);
const permissionOptions = $derived(
	PERMISSION_LABELS.map(([value, key]) => ({ value, label: t(key) })),
);

function chooseTimeout(value: number | "other") {
	if (value === "other") c.openOther();
	else void c.chooseTimeout(value);
}

function timeoutKey(event: KeyboardEvent) {
	if (event.key === "Enter") void c.saveOther();
	else if (event.key === "Escape") c.cancelOther();
}
</script>

<main>
	<h1>{t("settings.title")}</h1>
	<p class="sub">{t("settings.sub")}</p>

	{#if p.restartNeeded}
		<RestartBanner {t} onRestart={async () => void (await app.restartFamiliar())} />
	{/if}

	<h2>{t("settings.app.title")}</h2>
	<section class="card">
		<p class="card-note">{t("settings.app.note")}</p>
		<div class="field">
			<span class="field-label" id="settings-language">{t("settings.language")}</span>
			<Segmented
				labelledby="settings-language"
				options={p.language.options}
				value={p.language.value}
				disabled={!p.ready || p.language.busy}
				onchoose={(value) => c.setLanguage(value)}
			/>
			{#if p.language.busy}<p class="note">{t("settings.saving")}</p>{/if}
			{#if p.language.error}<p class="note error-text">{p.language.error}</p>{/if}
		</div>

		<div class="field">
			<span class="field-label" id="settings-close">{t("settings.close")}</span>
			<Segmented
				labelledby="settings-close"
				options={closeOptions}
				value={p.close.value}
				disabled={!p.ready || p.close.busy}
				onchoose={(value) => c.setClose(value)}
			/>
			{#if p.close.busy}<p class="note">{t("settings.saving")}</p>{/if}
			{#if p.close.error}<p class="note error-text">{p.close.error}</p>{/if}
		</div>

		<div class="field last">
			<div class="switch-row">
				<span class="field-label inline" id="settings-autostart">{t("settings.autostart")}</span>
				<button
					type="button"
					role="switch"
					class="switch"
					class:on={p.autostart.on}
					aria-checked={p.autostart.on}
					aria-labelledby="settings-autostart"
					disabled={!p.ready || p.autostart.busy}
					onclick={() => c.setAutostart(!p.autostart.on)}
				>
					<span class="knob" aria-hidden="true"></span>
				</button>
			</div>
			{#if p.autostart.busy}<p class="note">{t("settings.saving")}</p>{/if}
			{#if p.autostart.error}<p class="note error-text">{p.autostart.error}</p>{/if}
			{#if p.autostart.differs}<p class="note error-text">{t("settings.autostart.differs")}</p>{/if}
			<p class="note">{t("settings.autostart.hint")}</p>
			{#if p.autostart.linux}<p class="note">{t("settings.autostart.linux")}</p>{/if}
		</div>
	</section>

	<h2>{t("settings.answers.title")}</h2>
	<section class="card">
		<p class="card-note">{t("settings.answers.note")}</p>
		<div class="field">
			<span class="field-label" id="settings-timeout">{t("settings.timeout")}</span>
			<Segmented
				labelledby="settings-timeout"
				options={timeoutOptions}
				value={p.timeout.choice}
				disabled={!p.ready || p.timeout.busy}
				onchoose={chooseTimeout}
			/>
			{#if p.timeout.field}
				<div class="row">
					<input
						class="number"
						type="number"
						inputmode="numeric"
						min={MIN_TIMEOUT}
						max={MAX_TIMEOUT}
						step="1"
						aria-label={t("settings.timeout.field")}
						value={p.timeout.field.text}
						disabled={p.timeout.busy}
						oninput={(event) => c.editOther(event.currentTarget.value)}
						onkeydown={timeoutKey}
					/>
					<span class="unit">{t("settings.timeout.range", { min: MIN_TIMEOUT, max: MAX_TIMEOUT })}</span>
					{#if p.timeout.field.editing}
						<button class="btn small" disabled={p.timeout.busy} onclick={() => c.saveOther()}>
							{t("settings.timeout.save")}
						</button>
						<button class="btn ghost small" disabled={p.timeout.busy} onclick={() => c.cancelOther()}>
							{t("settings.timeout.cancel")}
						</button>
					{/if}
				</div>
			{/if}
			{#if p.timeout.busy}<p class="note">{t("settings.saving")}</p>{/if}
			{#if p.timeout.error}<p class="note error-text">{p.timeout.error}</p>{/if}
		</div>

		<div class="field last">
			<span class="field-label" id="settings-permissions">{t("settings.permissions")}</span>
			<Segmented
				labelledby="settings-permissions"
				options={permissionOptions}
				value={p.permissions.value}
				disabled={!p.ready || p.permissions.busy}
				onchoose={(value) => c.setPermissions(value)}
			/>
			{#if p.permissions.busy}<p class="note">{t("settings.saving")}</p>{/if}
			{#if p.permissions.error}<p class="note error-text">{p.permissions.error}</p>{/if}
			<p class="note">{t("settings.permissions.note")}</p>
		</div>
	</section>

	<h2>{t("settings.files.title")}</h2>
	<section class="card">
		<dl class="kv">
			<dt>{t("settings.files.settings")}</dt>
			<dd>
				{#if p.files.file}
					<CopyText text={p.files.file} {t} />
				{:else if !p.files.fileError}
					<span class="muted">…</span>
				{/if}
				{#if p.files.fileError}<p class="note error-text">{p.files.fileError}</p>{/if}
			</dd>
			<dt>{t("settings.files.logs")}</dt>
			<dd>
				{#if p.files.folder}
					<CopyText text={p.files.folder} {t}>
						<button class="btn ghost small" disabled={p.files.open.busy} onclick={() => c.openLogs()}>
							{t("settings.files.open")}
						</button>
					</CopyText>
				{:else if !p.files.folderError}
					<span class="muted">…</span>
				{/if}
				{#if p.files.folderError}<p class="note error-text">{p.files.folderError}</p>{/if}
				{#if p.files.open.error}<p class="note error-text">{p.files.open.error}</p>{/if}
			</dd>
		</dl>
		<p class="line">{t("settings.files.keychain")}</p>
	</section>

	<h2>{t("settings.addon.title")}</h2>
	<section class="card">
		<div class="addon">
			<span class="dot {p.addon.tone === 'good' ? 'connected' : 'off'}"></span>
			<span class="addon-text">
				{p.addon.text}{#if p.addon.client}<span class="mono path">{` · ${p.addon.client}`}</span>{/if}
			</span>
		</div>
		<div class="row">
			<button class="btn" onclick={() => app.open("game")}>{t("settings.addon.go")}</button>
			<span class="unit">{t("settings.addon.note")}</span>
		</div>
	</section>

	<h2>{t("settings.about.title")}</h2>
	<section class="card">
		<dl class="kv">
			<dt>{t("settings.about.version")}</dt>
			<dd>{p.about.version ?? "…"}</dd>
			<dt>{t("settings.about.core")}</dt>
			<dd>{p.about.core ?? "…"}</dd>
			<dt>{t("settings.about.repo")}</dt>
			<dd><CopyText text={REPOSITORY} {t} /></dd>
		</dl>
		<p class="line">{t("settings.about.license")}</p>
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

	.card-note {
		color: var(--muted);
		font-size: 12.5px;
		margin-bottom: 16px;
	}

	.field {
		margin-bottom: 18px;
	}

	.field.last {
		margin-bottom: 0;
	}

	.field-label {
		display: block;
		font-size: 13.5px;
		margin-bottom: 8px;
	}

	.field-label.inline {
		margin-bottom: 0;
	}

	.note {
		max-width: 68ch;
		margin-top: 7px;
		font-size: 12.5px;
		line-height: 1.5;
		color: var(--muted);
		user-select: text;
	}

	.note.error-text {
		color: var(--bad);
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		align-items: center;
		margin-top: 10px;
	}

	.number {
		width: 90px;
		padding: 6px 10px;
		border-radius: 8px;
		border: 1px solid var(--line);
		background: #0f1219;
		color: var(--text);
		font: inherit;
		font-size: 13px;
	}

	.number:focus-visible {
		outline: 2px solid var(--gold);
		outline-offset: 1px;
	}

	.unit {
		color: var(--muted);
		font-size: 12.5px;
	}

	.btn.small {
		padding: 5px 10px;
		font-size: 12.5px;
	}

	.switch-row {
		display: flex;
		align-items: center;
		gap: 14px;
	}

	.switch {
		position: relative;
		width: 40px;
		height: 22px;
		flex: none;
		border-radius: 99px;
		border: 1px solid #4a5060;
		background: #0f1219;
		cursor: pointer;
	}

	.switch .knob {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: #b5b0a5;
		transition: left 0.15s;
	}

	.switch.on {
		border-color: var(--gold-dim);
		background: rgba(217, 178, 106, 0.18);
	}

	.switch.on .knob {
		left: 20px;
		background: var(--gold);
	}

	.switch:disabled {
		cursor: default;
		opacity: 0.6;
	}

	.switch:focus-visible {
		outline: 2px solid var(--gold);
		outline-offset: 2px;
	}

	.kv {
		display: grid;
		grid-template-columns: 150px minmax(0, 1fr);
		gap: 9px 14px;
		font-size: 13.5px;
		line-height: 1.5;
		align-items: center;
	}

	.kv dt {
		color: var(--muted);
	}

	.kv dd {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.muted {
		color: var(--muted);
	}

	.line {
		margin-top: 14px;
		font-size: 13px;
		line-height: 1.5;
		color: var(--muted);
	}

	.addon {
		display: flex;
		align-items: center;
		gap: 10px;
		font-size: 13.5px;
	}

	.addon-text {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.path {
		color: #cfc8b8;
		user-select: text;
	}

	.addon .dot {
		width: 9px;
		height: 9px;
	}

	.dot.off {
		background: #4a5060;
	}
</style>
