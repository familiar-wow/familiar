<script lang="ts">
import type { Key, Translate } from "../lib/i18n.ts";
import type { Page } from "../lib/types.ts";

let {
	t,
	version,
	page,
	onOpen,
}: {
	t: Translate;
	version?: string;
	page: Page;
	onOpen: (page: Page) => void;
} = $props();

// Brain and Settings come with later pull requests; they stay in the list, dimmed.
const items: { icon: string; key: Key; page?: Page }[] = [
	{ icon: "◈", key: "nav.overview", page: "overview" },
	{ icon: "⚔", key: "nav.game", page: "game" },
	{ icon: "✦", key: "nav.brain" },
	{ icon: "☰", key: "nav.logs", page: "logs" },
	{ icon: "⚙", key: "nav.settings" },
];
</script>

<aside>
	<div class="brand">
		<div class="sigil" aria-hidden="true">F</div>
		<b>FAMILIAR</b>
	</div>
	<nav>
		{#each items as item (item.key)}
			{#if item.page}
				{@const target = item.page}
				<button
					type="button"
					class="nav-item"
					class:on={page === target}
					aria-current={page === target ? "page" : undefined}
					onclick={() => onOpen(target)}
				>
					<span class="icon" aria-hidden="true">{item.icon}</span>{t(item.key)}
				</button>
			{:else}
				<span class="nav-item off" aria-disabled="true" title={t("nav.later")}>
					<span class="icon" aria-hidden="true">{item.icon}</span>{t(item.key)}
				</span>
			{/if}
		{/each}
	</nav>
	<div class="foot">
		{version ? t("foot.version", { version }) : "Familiar"}<br />
		{t("foot.private")}
	</div>
</aside>

<style>
	aside {
		border-right: 1px solid var(--line);
		padding: 22px 16px;
		background: rgba(13, 15, 20, 0.6);
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-height: 0;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 22px;
		padding: 0 6px;
	}

	.brand b {
		font-family: var(--serif);
		letter-spacing: 0.08em;
		font-size: 17px;
		color: var(--gold);
	}

	nav {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.nav-item {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 9px 12px;
		border: 0;
		border-left: 2px solid transparent;
		border-radius: 8px;
		background: none;
		color: var(--muted);
		font-size: 14px;
		text-align: left;
	}

	button.nav-item {
		cursor: pointer;
	}

	button.nav-item:hover:not(.on) {
		background: var(--panel);
		color: var(--text);
	}

	.icon {
		width: 16px;
		text-align: center;
	}

	.nav-item.on {
		background: linear-gradient(90deg, rgba(217, 178, 106, 0.16), transparent);
		color: var(--gold);
		border-left-color: var(--gold);
	}

	.nav-item.off {
		opacity: 0.45;
		cursor: default;
	}

	.foot {
		margin-top: auto;
		font-size: 12px;
		color: var(--muted);
		padding: 0 8px;
		line-height: 1.7;
	}
</style>
