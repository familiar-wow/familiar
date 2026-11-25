<script lang="ts">
import { resolveLanguage, translator } from "./lib/i18n.ts";
import { duration } from "./lib/overview.ts";
import type { Host, TraySnapshot } from "./lib/types.ts";

let { host }: { host: Host } = $props();

let snap: TraySnapshot | undefined = $state.raw();

// The main window owns the connection; the panel shows what it sends and asks again when it
// loads or comes up, in case it missed a snapshot while hidden.
$effect(() => {
	let off: (() => void) | undefined;
	let gone = false;
	const ask = () =>
		void host.emit("familiar-snapshot-request", null).catch(() => {});
	host
		.on("familiar-snapshot", (next) => (snap = next))
		.then((unlisten) => {
			if (gone) unlisten();
			else off = unlisten;
			ask();
		})
		.catch(() => {});
	window.addEventListener("focus", ask);
	return () => {
		gone = true;
		off?.();
		window.removeEventListener("focus", ask);
	};
});

const language = $derived(
	snap?.language ?? resolveLanguage("system", navigator.language),
);
const t = $derived(translator(language));

$effect(() => {
	document.documentElement.lang = language;
});

// The main window owns the pages: ask it for the log, then bring it up.
async function openLogs() {
	await host.emit("familiar-open", { page: "logs" }).catch(() => {});
	await host.showMain().catch(() => {});
}

// A wrap breaks before a "·", never after it, and keeps "24.1 s" together.
function wrapWell(text: string): string {
	return text.replaceAll(" · ", " ·\u00a0").replace(/(\d) s\b/g, "$1\u00a0s");
}

const subline = $derived(
	snap
		? wrapWell(
				snap.connection === "connected"
					? (snap.characterLine ?? snap.gameLine)
					: snap.gameLine,
			)
		: undefined,
);
</script>

<div class="panel">
	<div class="sec top">
		<div class="sigil" aria-hidden="true">F</div>
		<div class="who">
			<b class="one-line">{snap?.character ?? "Familiar"}</b>
			{#if subline}<div class="subline two-lines">{subline}</div>{/if}
		</div>
		{#if snap}
			<span class="state {snap.connection}-text">
				<span class="dot {snap.connection}"></span>
				{t(`state.${snap.connection}`)}
			</span>
		{/if}
	</div>

	{#if snap}
		<div class="sec">
			<div class="label">{t("card.brain")}</div>
			<div class="brain two-lines">{wrapWell(snap.brain)}</div>
		</div>
		<div class="sec recent">
			<div class="label">{t("card.questions")}</div>
			{#if snap.recent.length === 0}
				<p class="empty">{t("questions.empty")}</p>
			{:else}
				{#each snap.recent as q, i (`${q.at}-${i}`)}
					<div class="q">
						{#if q.text !== undefined}
							<span class="one-line" title={q.text}>{q.text}</span>
						{:else}
							<span class="one-line cut">{t("questions.cut")}</span>
						{/if}
						<span class="ms">{duration(q, language)}</span>
						{#if q.tools.length > 0}<small class="one-line">{q.tools.join(" · ")}</small>{/if}
					</div>
				{/each}
			{/if}
		</div>
	{:else}
		<div class="spacer"></div>
	{/if}

	<div class="bar">
		<button class="btn ghost" onclick={openLogs}>{t("tray.logs")}</button>
		<button class="btn primary" onclick={() => host.showMain().catch(() => {})}>
			{t("tray.open")}
		</button>
	</div>
</div>

<style>
	/* The window is the panel: 340 × 400, no frame, so it fills the whole page. */
	.panel {
		height: 100%;
		display: flex;
		flex-direction: column;
		background: linear-gradient(180deg, var(--panel2), var(--panel));
		border: 1px solid var(--line);
		overflow: hidden;
	}

	.sec {
		padding: 13px 16px;
		border-bottom: 1px solid var(--line);
	}

	.top {
		display: flex;
		gap: 12px;
		align-items: center;
	}

	.who {
		min-width: 0;
		flex: 1;
		display: flex;
		flex-direction: column;
	}

	.who b {
		font-family: var(--serif);
		font-weight: 700;
		letter-spacing: 0.06em;
		color: var(--gold);
	}

	.subline {
		font-size: 12px;
		line-height: 1.4;
		color: var(--muted);
	}

	/* Up to two lines: what matters (the zone, the last answer's time) comes last. */
	.two-lines {
		display: -webkit-box;
		-webkit-box-orient: vertical;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		overflow: hidden;
	}

	.state {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 12px;
		white-space: nowrap;
	}

	.state .dot {
		width: 9px;
		height: 9px;
	}

	.brain {
		font-size: 13.5px;
	}

	.recent {
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.spacer {
		flex: 1;
	}

	.empty {
		color: var(--muted);
		font-size: 12.5px;
		line-height: 1.5;
	}

	.q {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 1px 10px;
		padding: 6px 0;
		font-size: 12.5px;
		border-top: 1px solid #222838;
	}

	.q:first-of-type {
		border-top: 0;
	}

	.q small {
		color: var(--muted);
		font-size: 11px;
		grid-column: 1;
	}

	.ms {
		color: var(--muted);
	}

	.cut {
		color: var(--muted);
		font-style: italic;
	}

	.bar {
		display: flex;
		gap: 8px;
		padding: 12px 16px;
	}

	.bar .btn {
		flex: 1;
	}
</style>
