// The main window: the overview, and the only connection to the core.
import "@fontsource/cinzel/500.css";
import "@fontsource/cinzel/700.css";
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "./styles/theme.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { MainApp } from "./lib/main-app.ts";
import { inTauri, tauriHost } from "./lib/tauri.ts";
import type { Host } from "./lib/types.ts";

async function host(): Promise<Host> {
	if (inTauri()) return tauriHost();
	// A plain browser: play a made-up core, so the look can be checked without the app.
	const { mockHost } = await import("./lib/mock.ts");
	const query = new URLSearchParams(location.search);
	return mockHost(query.get("mock") ?? "live", query.get("lang"));
}

// WebView2 may suspend a hidden page, and the main window is hidden most of the time while it
// still has to follow the core. Holding a Web Lock keeps it running (unverified on Windows yet).
navigator.locks
	?.request("familiar-alive", () => new Promise<never>(() => {}))
	.catch(() => {});

const app = new MainApp(await host(), { systemLanguage: navigator.language });
const target = document.getElementById("app");
if (target) mount(App, { target, props: { app } });
void app.start();
