import { resolve } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// Two pages: the main window and the small panel above the tray icon. Tauri loads them from
// dist/ in the installer and from this dev server while developing.
export default defineConfig({
	plugins: [svelte()],
	clearScreen: false,
	server: { port: 1420, strictPort: true },
	build: {
		target: "es2022",
		rollupOptions: {
			input: {
				main: resolve(import.meta.dirname, "index.html"),
				tray: resolve(import.meta.dirname, "tray.html"),
			},
		},
	},
});
