<script lang="ts">
// The Brain page: one tab per kind of brain (T6 fills it in, see the M3 contract).
import type { Translate } from "../lib/i18n.ts";
import type { MainApp } from "../lib/main-app.ts";
import type { View } from "../lib/overview.ts";
import AgentTab from "./AgentTab.svelte";

let { app, view, t }: { app: MainApp; view: View; t: Translate } = $props();
</script>

<main>
	<h1>{t("brain.title")}</h1>
	<AgentTab {app} {view} {t} />
</main>
