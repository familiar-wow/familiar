<script lang="ts">
// The Settings page (T9 fills it in, see the M4 contract).
import type { Translate } from "../lib/i18n.ts";
import type { MainApp } from "../lib/main-app.ts";
import type { View } from "../lib/overview.ts";

let { app, view, t }: { app: MainApp; view: View; t: Translate } = $props();
</script>

<main>
	<h1>{t("settings.title")}</h1>
</main>
