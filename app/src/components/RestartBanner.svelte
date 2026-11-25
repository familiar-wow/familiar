<script lang="ts">
import type { Translate } from "../lib/i18n.ts";

let { t, onRestart }: { t: Translate; onRestart: () => Promise<void> } =
	$props();

let busy = $state(false);

// One click at a time: a restart takes a moment, and a second one would only queue up.
async function restart() {
	if (busy) return;
	busy = true;
	try {
		await onRestart();
	} finally {
		busy = false;
	}
}
</script>

<div class="banner" role="status">
	<span>{t("restart.banner")}</span>
	<button class="btn" disabled={busy} onclick={restart}>{t("restart.button")}</button>
</div>

<style>
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
</style>
