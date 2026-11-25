<script lang="ts">
// The ChatGPT plan tab: sign in through the browser, choose a model, see where usage is managed.
import { untrack } from "svelte";
import { activeKind, choiceFor, isActive } from "../../lib/brain.ts";
import { type ChatGptState, ChatGptTab } from "../../lib/brain-page.ts";
import type { Translate } from "../../lib/i18n.ts";
import type { MainApp } from "../../lib/main-app.ts";
import type { View } from "../../lib/overview.ts";
import Actions from "./Actions.svelte";

let { app, view, t }: { app: MainApp; view: View; t: Translate } = $props();

// What the tab held last, read once when it opens; later saves come from the tab itself.
const initial = untrack(() => choiceFor(view.settings ?? {}, "chatgpt"));
const tab = new ChatGptTab(
	{
		call: (method, params) => app.call(method, params),
		useBrain: (choice) => app.useBrain(choice),
		testBrain: (choice) => app.testBrain(choice),
		rememberBrain: (choice) => app.rememberBrain(choice),
		signIn: () => app.signInChatGpt(),
	},
	initial?.kind === "chatgpt" ? initial.name : undefined,
);

let s: ChatGptState = $state.raw(tab.state);
$effect(() => {
	const off = tab.watch((next) => (s = next));
	return () => {
		off();
		tab.dispose();
	};
});

$effect(() => {
	untrack(() => {
		// A sign-in that already waits, started before the tab opened: wait for that one.
		if (view.chatgptUrl) void tab.signIn();
		else void tab.load();
	});
});

const choice = $derived(s.account && s.model ? tab.choice() : undefined);
const inUse = $derived(
	choice !== undefined &&
		view.settings !== undefined &&
		isActive(view.settings, choice),
);
const answersWithChatGpt = $derived(
	view.settings !== undefined && activeKind(view.settings) === "chatgpt",
);

let copied = $state(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
$effect(() => () => clearTimeout(copiedTimer));

async function copy(text: string) {
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
</script>

<section class="card">
	{#if s.account === undefined}
		<p class="muted">{t("brain.gpt.checking")}</p>
	{:else if s.account === null}
		{#if s.waiting}
			<p class="waiting" role="status">
				<span class="spin" aria-hidden="true"></span>{t("brain.gpt.waiting")}
			</p>
			{#if view.chatgptUrl}
				<p class="muted small">{t("brain.gpt.notOpened")}</p>
				<div class="url-row">
					<span class="path mono">{view.chatgptUrl}</span>
					<button class="btn ghost small-btn" onclick={() => copy(view.chatgptUrl ?? "")}>
						{copied ? t("brain.gpt.copied") : t("brain.gpt.copy")}
					</button>
				</div>
			{/if}
			<div class="row">
				<button class="btn ghost" onclick={() => tab.cancel()}>{t("brain.gpt.cancel")}</button>
			</div>
		{:else}
			<p class="text">{t("brain.gpt.signedOut")}</p>
			{#if answersWithChatGpt}
				<p class="warn-box">{t("brain.gpt.activeSignedOut")}</p>
			{/if}
			<div class="row">
				<button class="btn primary" disabled={s.busy !== undefined} onclick={() => tab.signIn()}>
					{t("brain.gpt.signIn")}
				</button>
			</div>
		{/if}
		{#if s.result && !s.waiting}
			<!-- A failed sign-in or "Signed out": the same line as after a test. -->
			<Actions
				{t}
				language={view.language}
				busy={s.busy}
				ready={false}
				inUse={false}
				result={s.result}
				onUse={() => {}}
				onTest={() => {}}
				hideButtons
			/>
		{/if}
	{:else}
		<dl class="kv">
			<dt>{t("brain.gpt.account")}</dt>
			<dd>{s.account}</dd>
			<dt><label for="gpt-model">{t("brain.gpt.model")}</label></dt>
			<dd>
				{#if s.models}
					<select
						id="gpt-model"
						class="input"
						value={s.model}
						disabled={s.busy !== undefined}
						onchange={(e) => tab.pick(e.currentTarget.value)}
					>
						{#each s.models as m (m.slug)}
							<option value={m.slug}>{m.name}</option>
						{/each}
					</select>
				{:else}
					<span class="muted">{t("brain.gpt.loadingModels")}</span>
				{/if}
			</dd>
			<dt>{t("brain.gpt.usage")}</dt>
			<dd>
				<span>{t("brain.gpt.usageText")}</span>
				<span class="url-row">
					<span class="path mono">{s.usage}</span>
					<button class="btn ghost small-btn" onclick={() => copy(s.usage)}>
						{copied ? t("brain.gpt.copied") : t("brain.gpt.copy")}
					</button>
				</span>
			</dd>
		</dl>
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
			<button class="btn ghost" disabled={s.busy !== undefined} onclick={() => tab.signOut()}>
				{t("brain.gpt.signOut")}
			</button>
		</Actions>
	{/if}
</section>

<style>
	.muted {
		color: var(--muted);
		font-size: 13.5px;
	}

	.small {
		font-size: 12.5px;
		margin-top: 10px;
	}

	.text {
		font-size: 13.5px;
		line-height: 1.55;
	}

	.waiting {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 13.5px;
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

	.warn-box {
		margin-top: 12px;
		font-size: 13px;
		line-height: 1.5;
		padding: 10px 12px;
		border-radius: 8px;
		background: rgba(224, 164, 78, 0.08);
		border: 1px solid rgba(224, 164, 78, 0.35);
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		align-items: center;
		margin-top: 16px;
	}

	.kv {
		display: grid;
		grid-template-columns: 120px minmax(0, 1fr);
		gap: 12px 14px;
		align-items: baseline;
		font-size: 13.5px;
		line-height: 1.5;
	}

	.kv dt {
		color: var(--muted);
	}

	.kv dd {
		min-width: 0;
		overflow-wrap: anywhere;
		user-select: text;
	}

	.url-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-top: 6px;
	}

	.path {
		background: #0f1219;
		border: 1px solid var(--line);
		border-radius: 6px;
		padding: 3px 8px;
		color: #cfc8b8;
		overflow-wrap: anywhere;
		user-select: text;
	}

	.small-btn {
		padding: 3px 10px;
		font-size: 12px;
	}

	.input {
		max-width: 360px;
		width: 100%;
		background: #0f1219;
		border: 1px solid var(--line);
		border-radius: 8px;
		padding: 7px 10px;
		color: var(--text);
		font: inherit;
		font-size: 13.5px;
	}

	.input:focus-visible {
		outline: 2px solid var(--gold);
		outline-offset: 1px;
	}
</style>
