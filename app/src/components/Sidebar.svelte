<script lang="ts">
import type { Key, Translate } from "../lib/i18n.ts";

let { t, version }: { t: Translate; version?: string } = $props();

// Only the overview exists in this version; the others come with later pull requests.
const later: { icon: string; key: Key }[] = [
	{ icon: "⚔", key: "nav.game" },
	{ icon: "✦", key: "nav.brain" },
	{ icon: "☰", key: "nav.logs" },
	{ icon: "⚙", key: "nav.settings" },
];
</script>

<aside>
	<div class="brand">
		<div class="sigil" aria-hidden="true">F</div>
		<b>FAMILIAR</b>
	</div>
	<nav>
		<span class="nav-item on" aria-current="page">
			<span class="icon" aria-hidden="true">◈</span>{t("nav.overview")}
		</span>
		{#each later as item (item.key)}
			<span class="nav-item off" aria-disabled="true" title={t("nav.later")}>
				<span class="icon" aria-hidden="true">{item.icon}</span>{t(item.key)}
			</span>
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
		padding: 9px 12px;
		border-radius: 8px;
		color: var(--muted);
		font-size: 14px;
		border-left: 2px solid transparent;
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
