<script lang="ts">
// A path or an address as plain text with a Copy button: Tauri does not open links, and the
// player may want to paste it into a file manager or a browser.
import type { Snippet } from "svelte";
import type { Translate } from "../../lib/i18n.ts";

let { text, t, children }: { text: string; t: Translate; children?: Snippet } =
	$props();

let copied = $state(false);
let timer: ReturnType<typeof setTimeout> | undefined;
$effect(() => () => clearTimeout(timer));

async function copy() {
	let ok = true;
	try {
		await navigator.clipboard.writeText(text);
	} catch {
		ok = copyByHand(text);
	}
	if (!ok) return;
	copied = true;
	clearTimeout(timer);
	timer = setTimeout(() => (copied = false), 1500);
}

// Without the clipboard API (an older WebView, or no permission): a hidden text field.
function copyByHand(value: string): boolean {
	const area = document.createElement("textarea");
	area.value = value;
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

<span class="copy-text">
	<span class="mono path">{text}</span>
	{@render children?.()}
	<button type="button" class="btn ghost small" onclick={copy}>
		{copied ? t("settings.copied") : t("settings.copy")}
	</button>
</span>

<style>
	.copy-text {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}

	.path {
		flex: 1;
		color: #cfc8b8;
		overflow-wrap: anywhere;
		user-select: text;
		min-width: 0;
	}

	.copy-text :global(.small) {
		flex: none;
		padding: 4px 10px;
		font-size: 12.5px;
	}
</style>
