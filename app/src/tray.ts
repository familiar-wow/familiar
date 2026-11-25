// The small panel above the tray icon. It shows what the main window sends and owns nothing.
import "@fontsource/cinzel/500.css";
import "@fontsource/cinzel/700.css";
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "./styles/theme.css";
import { mount } from "svelte";
import { inTauri, tauriHost } from "./lib/tauri.ts";
import type { Host } from "./lib/types.ts";
import Tray from "./Tray.svelte";

async function host(): Promise<Host> {
	if (inTauri()) return tauriHost();
	// A plain browser: run the main window's logic on a made-up core in this page, so the
	// panel gets real snapshots.
	const [{ mockHost }, { MainApp }] = await Promise.all([
		import("./lib/mock.ts"),
		import("./lib/main-app.ts"),
	]);
	const query = new URLSearchParams(location.search);
	const mock = mockHost(query.get("mock") ?? "connected", query.get("lang"));
	void new MainApp(mock, { systemLanguage: navigator.language }).start();
	return mock;
}

const target = document.getElementById("app");
if (target) mount(Tray, { target, props: { host: await host() } });
