// The only file that talks to Tauri: the shell's commands and events behind the Host interface,
// so the rest of the pages and their tests never need Tauri.
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { Host, SidecarState } from "./types.ts";

/** Whether the page runs inside the app, not in a plain browser. */
export function inTauri(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function tauriHost(): Host {
	return {
		state: () => invoke<SidecarState>("sidecar_state"),
		send: async (line) => {
			await invoke("sidecar_send", { line });
		},
		restart: async () => {
			await invoke("sidecar_restart");
		},
		trayUpdate: async (update) => {
			await invoke("tray_update", { ...update });
		},
		setCloseMode: async (mode) => {
			await invoke("set_close_mode", { mode });
		},
		showMain: async () => {
			await invoke("show_main");
		},
		quit: async () => {
			await invoke("quit");
		},
		pickFolder: async (title) => {
			const chosen = await open({ directory: true, multiple: false, title });
			return typeof chosen === "string" ? chosen : null;
		},
		on: (event, handler) => listen(event, (e) => handler(e.payload as never)),
		emit: (event, payload) => emit(event, payload),
	};
}
