<script lang="ts">
import { untrack } from "svelte";
import Overview from "./components/Overview.svelte";
import Sidebar from "./components/Sidebar.svelte";
import { translator } from "./lib/i18n.ts";
import type { MainApp } from "./lib/main-app.ts";
import { present, type View } from "./lib/overview.ts";

let { app }: { app: MainApp } = $props();

// The app object never changes; only its view does, and watch() reports each new one.
let view: View = $state.raw(untrack(() => app.view));
let now = $state(Date.now());

$effect(() => app.watch((next) => (view = next)));

// "last contact 4 s ago" moves on by itself.
$effect(() => {
	const timer = setInterval(() => (now = Date.now()), 5000);
	return () => clearInterval(timer);
});

$effect(() => {
	document.documentElement.lang = view.language;
});

const t = $derived(translator(view.language));
const o = $derived(present(view, now));
</script>

<div class="app">
	<Sidebar {t} version={view.version} />
	<Overview
		{o}
		{t}
		onRestartCore={() => app.restartCore()}
		onRestartFamiliar={() => app.restartFamiliar()}
	/>
</div>

<style>
	.app {
		display: grid;
		grid-template-columns: 220px minmax(0, 1fr);
		height: 100%;
		background-image:
			radial-gradient(ellipse at 20% 0%, rgba(217, 178, 106, 0.1), transparent 55%),
			radial-gradient(ellipse at 100% 100%, rgba(80, 110, 180, 0.1), transparent 50%);
	}
</style>
