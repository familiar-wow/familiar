// The shapes the pages share with the Rust shell (docs: the M2 contract) and with the core
// (docs/sidecar.md, core/src/sidecar/sidecar.ts). The core is a separate program, so its status
// is typed here again instead of imported: the pages must not pull core code into the bundle.

/** The core's status, as the `status` method and event send it. */
export interface Status {
	running: boolean;
	client?: string;
	addon: { installed: boolean };
	game: { running: boolean; lastContact?: number; hello?: string };
	character?: Record<string, string | undefined>;
	brain: Record<string, unknown>;
	last?: { at: number; ms: number; tools: string[] };
	problems: string[];
	restartNeeded?: boolean;
}

/** What Rust knows about the current core, so a page that loads late knows where things are. */
export interface SidecarState {
	gen: number;
	running: boolean;
	exitCode?: number | null;
	stderrTail: string[];
	/** The number of the last line in `stderrTail`; each core counts its lines from 1. */
	stderrSeq: number;
}

export type Connection = "connected" | "waiting" | "error";
export type Language = "en" | "de";
export type CloseMode = "tray" | "quit";
/** The main window's pages; Brain and Settings come later. */
export type Page = "overview" | "game" | "brain" | "logs" | "setup";

/** A WoW Forever client, as `game.find` and `game.check` describe it. */
export interface GameClient {
	/** The client folder, its `_forever_` folder. */
	client: string;
	version?: string;
	interface?: number;
	installed: boolean;
	/** The version in the installed addon's `.toc`; absent when it is not installed. */
	addonVersion?: string;
}

export interface TraySnapshot {
	connection: Connection;
	language: Language;
	gameLine: string;
	character?: string;
	characterLine?: string;
	brain: string;
	recent: {
		at: number;
		text?: string;
		ms?: number;
		undelivered?: true;
		tools: string[];
	}[];
}

export interface TrayUpdate {
	state: Connection;
	tooltip: string;
	open: string;
	quit: string;
}

/** Events Rust emits to every window, and the two the pages send each other. */
export interface HostEvents {
	"sidecar-line": { gen: number; line: string };
	"sidecar-stderr": { gen: number; seq: number; line: string };
	"sidecar-exit": { gen: number; code: number | null };
	"sidecar-started": { gen: number };
	"familiar-snapshot": TraySnapshot;
	"familiar-snapshot-request": null;
	/** The tray panel asks the main window to show a page. */
	"familiar-open": { page: Page };
}

/**
 * Everything a page needs from the shell. lib/tauri.ts implements it with Tauri, lib/mock.ts
 * without, and the tests with a fake, so the logic never imports Tauri.
 */
export interface Host {
	state(): Promise<SidecarState>;
	send(line: string): Promise<void>;
	restart(): Promise<void>;
	trayUpdate(update: TrayUpdate): Promise<void>;
	setCloseMode(mode: CloseMode): Promise<void>;
	showMain(): Promise<void>;
	quit(): Promise<void>;
	/** Asks the player for a folder; null when they cancel. Only the main window may. */
	pickFolder(title: string): Promise<string | null>;
	on<K extends keyof HostEvents>(
		event: K,
		handler: (payload: HostEvents[K]) => void,
	): Promise<() => void>;
	emit<K extends keyof HostEvents>(
		event: K,
		payload: HostEvents[K],
	): Promise<void>;
}

/** A message from an error of any kind: Tauri rejects with strings, our code with Errors. */
export function messageOf(error: unknown): string {
	if (typeof error === "string") return error;
	if (error instanceof Error) return error.message;
	return String(error);
}
