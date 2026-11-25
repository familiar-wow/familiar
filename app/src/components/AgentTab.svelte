<script lang="ts">
// The Brain page's "Your own agent" tab: on this PC or on another computer (T7 fills it in).
import type { Translate } from "../lib/i18n.ts";
import type { MainApp } from "../lib/main-app.ts";
import type { View } from "../lib/overview.ts";

let { app, view, t }: { app: MainApp; view: View; t: Translate } = $props();
</script>

<section>{t("agent.title")}</section>
