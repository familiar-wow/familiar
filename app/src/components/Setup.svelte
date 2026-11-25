<script lang="ts">
// The setup assistant on first start (T8 fills it in, see the M3 contract).
import type { Translate } from "../lib/i18n.ts";
import type { MainApp } from "../lib/main-app.ts";
import type { View } from "../lib/overview.ts";

let { app, view, t }: { app: MainApp; view: View; t: Translate } = $props();
</script>

<main>
	<h1>{t("setup.title")}</h1>
	<button type="button" onclick={() => app.finishSetup()}>Skip</button>
</main>
