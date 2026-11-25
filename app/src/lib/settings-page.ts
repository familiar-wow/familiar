// The Settings page: the app's own settings, which apply at once, the answer settings, which a
// running Familiar takes up after a restart, and where its files are. `presentSettings` is pure;
// `SettingsController` runs the saves, one at a time per control, with MainApp passed in, so both
// are tested without it. The values shown always come from the saved settings (`view.settings`),
// never from the click, so a failed save does not leave a control saying what is not saved.
import type { Permissions, Settings } from "./brain.ts";
import type { Key, Translate } from "./i18n.ts";
import type { View } from "./overview.ts";
import { type CloseMode, type Language, messageOf } from "./types.ts";

export type LanguageSetting = "system" | Language;
/** The controls that save something, and "Open" for the log folder. */
export type Control =
	| "language"
	| "close"
	| "autostart"
	| "timeout"
	| "permissions"
	| "openLogs";
export type SaveControl = Exclude<Control, "openLogs">;

/**
 * Which saves a running Familiar only takes up after a restart: those of the brain. The app's
 * own settings (`app.*`) apply at once (MainApp.updateApp), so they never show the banner.
 */
export const NEEDS_RESTART: Record<SaveControl, boolean> = {
	language: false,
	close: false,
	autostart: false,
	timeout: true,
	permissions: true,
};

/** The core's default (core/src/settings.ts). */
export const DEFAULT_TIMEOUT = 120;
export const TIMEOUT_CHOICES = [60, 120, 180, 300] as const;
/** The core takes any positive number; the page keeps to what makes sense for one answer. */
export const MIN_TIMEOUT = 30;
export const MAX_TIMEOUT = 600;

/** Each language in its own words, so a player who cannot read the other one finds theirs. */
export const LANGUAGE_NAMES: Record<Language, string> = {
	en: "English",
	de: "Deutsch",
};

export const REPOSITORY = "https://github.com/familiar-wow/familiar";

/** What went wrong at a control: the core's words, or the page's own check of the number. */
export type Problem = { kind: "core"; message: string } | { kind: "range" };

export interface SettingsPageState {
	/** The controls with a save (or the folder's opening) under way. */
	busy: Control[];
	errors: Partial<Record<Control, Problem>>;
	/** The number field after "Other…", while the player edits it; undefined when closed. */
	other?: string;
	/** The settings file (`settings.get` → `file`) and the log folder (`logs.folder`). */
	file?: string;
	fileError?: string;
	folder?: string;
	folderError?: string;
	/** From the core's `hello`: its version and the system it runs on. */
	coreVersion?: string;
	platform?: string;
	/** The desktop app's own version; `appVersionFailed` when it could not be read. */
	appVersion?: string;
	appVersionFailed?: boolean;
	/** Whether the system's autostart entry is there, read when the page opens and after a save. */
	systemAutostart?: boolean;
}

export interface SettingsDeps {
	call<T>(method: string, params?: Record<string, unknown>): Promise<T>;
	/** The settings as saved last (`view.settings`); undefined until the core sent them. */
	saved(): Settings | undefined;
	/** `app.*`, applied at once (MainApp.updateApp). */
	updateApp(
		change: (app: NonNullable<Settings["app"]>) => NonNullable<Settings["app"]>,
	): Promise<void>;
	/** The system's entry, then `app.autostart` (MainApp.setAutostart). */
	setAutostart(on: boolean): Promise<void>;
	/** Anything else, through the app's one queue of changes (MainApp.updateSettings). */
	updateSettings(change: (settings: Settings) => Settings): Promise<unknown>;
	/** The status again, so the restart banner shows as soon as the core knows. */
	refreshStatus(): Promise<void>;
	/** The system's own autostart entry (MainApp.systemAutostart). */
	systemAutostart(): Promise<boolean>;
	/** The desktop app's version (MainApp.appVersion). */
	appVersion(): Promise<string>;
}

/** `app.language` as the page offers it; anything else counts as "system", as in the core. */
export function languageSetting(
	settings: Settings | undefined,
): LanguageSetting {
	const value = settings?.app?.language;
	return value === "en" || value === "de" ? value : "system";
}

export function closeSetting(settings: Settings | undefined): CloseMode {
	return settings?.app?.close === "quit" ? "quit" : "tray";
}

export function timeoutSetting(settings: Settings | undefined): number {
	const value = settings?.brain?.timeout;
	return typeof value === "number" && value > 0 ? value : DEFAULT_TIMEOUT;
}

export function permissionsSetting(
	settings: Settings | undefined,
): Permissions {
	const value = settings?.brain?.permissions;
	return value === "allow" || value === "deny" ? value : "ask";
}

/** One of the fixed choices, or "other" for any other number of seconds. */
export function timeoutChoice(
	seconds: number,
): (typeof TIMEOUT_CHOICES)[number] | "other" {
	return (TIMEOUT_CHOICES as readonly number[]).includes(seconds)
		? (seconds as (typeof TIMEOUT_CHOICES)[number])
		: "other";
}

/** Whole seconds from 30 to 600, as typed; undefined for anything else. */
export function parseTimeout(text: string): number | undefined {
	const trimmed = text.trim();
	if (!/^\d+$/.test(trimmed)) return undefined;
	const seconds = Number(trimmed);
	return seconds >= MIN_TIMEOUT && seconds <= MAX_TIMEOUT ? seconds : undefined;
}

/** "System (Deutsch)": which language "system" means on this PC. */
export function languageLabel(
	setting: LanguageSetting,
	systemLanguage: Language,
	t: Translate,
): string {
	if (setting !== "system") return LANGUAGE_NAMES[setting];
	return t("settings.language.system", {
		language: LANGUAGE_NAMES[systemLanguage],
	});
}

/** The core's words on one line: a settings error can span several. */
export function oneLine(message: string): string {
	return message.replace(/\s+/g, " ").trim();
}

export function problemText(problem: Problem, t: Translate): string {
	return problem.kind === "range"
		? t("settings.timeout.invalid", { min: MIN_TIMEOUT, max: MAX_TIMEOUT })
		: oneLine(problem.message);
}

const PLATFORMS: Record<string, string> = {
	win32: "Windows",
	darwin: "macOS",
	linux: "Linux",
};

export function platformName(platform: string): string {
	return PLATFORMS[platform] ?? platform;
}

export type AddonTone = "good" | "off";

/** The addon in one line, from the status the overview shares: the Game page has the details. */
export function addonLine(
	view: View,
	t: Translate,
): { text: string; tone: AddonTone; client?: string } {
	const status = view.status;
	if (!status) return { text: "…", tone: "off" };
	if (!status.client) return { text: t("game.noClient"), tone: "off" };
	return status.addon.installed
		? { text: t("addon.installed"), tone: "good", client: status.client }
		: { text: t("addon.notInstalled"), tone: "off", client: status.client };
}

interface Field {
	busy: boolean;
	error?: string;
}

export interface SettingsPage {
	/** The settings are there; before that the controls wait. */
	ready: boolean;
	restartNeeded: boolean;
	language: Field & {
		value: LanguageSetting;
		options: { value: LanguageSetting; label: string }[];
	};
	close: Field & { value: CloseMode };
	/**
	 * `on` is what the system does (its entry), once known; `differs` when the setting says
	 * otherwise, such as after a failed write or an entry removed by hand.
	 */
	autostart: Field & { on: boolean; linux: boolean; differs: boolean };
	timeout: Field & {
		seconds: number;
		choice: (typeof TIMEOUT_CHOICES)[number] | "other";
		/** The number field: open after "Other…" or for a saved number that is no choice. */
		field?: { text: string; editing: boolean };
	};
	permissions: Field & { value: Permissions };
	files: {
		file?: string;
		fileError?: string;
		folder?: string;
		folderError?: string;
		open: Field;
	};
	addon: { text: string; tone: AddonTone; client?: string };
	about: { version?: string; core?: string };
}

export function presentSettings(
	state: SettingsPageState,
	view: View,
	t: Translate,
	systemLanguage: Language,
): SettingsPage {
	const settings = view.settings;
	const field = (control: Control): Field => {
		const problem = state.errors[control];
		return {
			busy: state.busy.includes(control),
			...(problem ? { error: problemText(problem, t) } : {}),
		};
	};
	const seconds = timeoutSetting(settings);
	const choice = timeoutChoice(seconds);
	const timeout: SettingsPage["timeout"] = {
		...field("timeout"),
		seconds,
		choice,
	};
	if (state.other !== undefined)
		timeout.field = { text: state.other, editing: true };
	else if (choice === "other")
		timeout.field = { text: String(seconds), editing: false };
	const about: SettingsPage["about"] = {};
	if (state.appVersion) about.version = state.appVersion;
	else if (state.appVersionFailed) about.version = t("settings.about.unknown");
	if (state.coreVersion)
		about.core = state.platform
			? t("settings.about.coreLine", {
					version: state.coreVersion,
					platform: platformName(state.platform),
				})
			: state.coreVersion;
	const files: SettingsPage["files"] = { open: field("openLogs") };
	if (state.file) files.file = state.file;
	if (state.fileError) files.fileError = oneLine(state.fileError);
	if (state.folder) files.folder = state.folder;
	if (state.folderError) files.folderError = oneLine(state.folderError);
	return {
		ready: settings !== undefined,
		restartNeeded: view.status?.restartNeeded === true && !view.exited,
		language: {
			...field("language"),
			value: languageSetting(settings),
			options: (["system", "en", "de"] as const).map((value) => ({
				value,
				label: languageLabel(value, systemLanguage, t),
			})),
		},
		close: { ...field("close"), value: closeSetting(settings) },
		autostart: {
			...field("autostart"),
			on: state.systemAutostart ?? settings?.app?.autostart === true,
			linux: state.platform === "linux",
			differs:
				state.systemAutostart !== undefined &&
				settings !== undefined &&
				state.systemAutostart !== (settings.app?.autostart === true),
		},
		timeout,
		permissions: {
			...field("permissions"),
			value: permissionsSetting(settings),
		},
		files,
		addon: addonLine(view, t),
		about,
	};
}

/** The labels of the choices, for the component. */
export const CLOSE_LABELS: Record<CloseMode, Key> = {
	tray: "settings.close.tray",
	quit: "settings.close.quit",
};
export const PERMISSION_LABELS: [Permissions, Key][] = [
	["ask", "settings.perm.ask"],
	["allow", "settings.perm.allow"],
	["deny", "settings.perm.deny"],
];

export class SettingsController {
	state: SettingsPageState = { busy: [], errors: {} };
	private readonly watchers = new Set<(state: SettingsPageState) => void>();

	constructor(private readonly deps: SettingsDeps) {}

	watch(fn: (state: SettingsPageState) => void): () => void {
		this.watchers.add(fn);
		return () => this.watchers.delete(fn);
	}

	/** When the page opens, and for each new core: where the files are, and the core's version. */
	async load(): Promise<void> {
		const { call } = this.deps;
		await Promise.all([
			call<{ file?: unknown }>("settings.get").then(
				(got) =>
					this.set(
						typeof got?.file === "string" && got.file !== ""
							? { file: got.file, fileError: undefined }
							: { fileError: undefined },
					),
				(error) => this.set({ fileError: messageOf(error) }),
			),
			call<unknown>("logs.folder").then(
				(folder) =>
					this.set(
						typeof folder === "string" && folder !== ""
							? { folder, folderError: undefined }
							: { folderError: undefined },
					),
				(error) => this.set({ folderError: messageOf(error) }),
			),
			// Without it the page only lacks the core's version and the Linux hint.
			call<{ version?: unknown; platform?: unknown }>("hello").then(
				(hello) => {
					const change: Partial<SettingsPageState> = {};
					if (typeof hello?.version === "string")
						change.coreVersion = hello.version;
					if (typeof hello?.platform === "string")
						change.platform = hello.platform;
					this.set(change);
				},
				() => {},
			),
			this.deps.appVersion().then(
				(appVersion) => this.set({ appVersion, appVersionFailed: false }),
				() => this.set({ appVersionFailed: true }),
			),
			this.readAutostart(),
		]);
	}

	/** The system's entry as it is; not knowing leaves the switch on the setting. */
	private readAutostart(): Promise<void> {
		return this.deps.systemAutostart().then(
			(systemAutostart) => this.set({ systemAutostart }),
			() => this.set({ systemAutostart: undefined }),
		);
	}

	setLanguage(language: LanguageSetting): Promise<void> {
		if (language === languageSetting(this.deps.saved())) return done;
		return this.save("language", () =>
			this.deps.updateApp((app) => ({ ...app, language })),
		);
	}

	setClose(close: CloseMode): Promise<void> {
		if (close === closeSetting(this.deps.saved())) return done;
		return this.save("close", () =>
			this.deps.updateApp((app) => ({ ...app, close })),
		);
	}

	setAutostart(on: boolean): Promise<void> {
		const now =
			this.state.systemAutostart ?? this.deps.saved()?.app?.autostart === true;
		if (on === now) return done;
		// Read again afterwards, also after a failure: the switch shows what the system does.
		return this.save("autostart", () =>
			this.deps.setAutostart(on).finally(() => this.readAutostart()),
		);
	}

	/** One of the fixed choices: saved at once, and the number field closes. */
	chooseTimeout(seconds: number): Promise<void> {
		if (this.busy("timeout")) return done;
		this.set({ other: undefined });
		if (seconds === timeoutSetting(this.deps.saved())) {
			this.clear("timeout");
			return done;
		}
		return this.saveTimeout(seconds);
	}

	/** "Other…": the number field opens with the saved number; nothing is saved yet. */
	openOther(): void {
		if (this.busy("timeout")) return;
		this.clear("timeout");
		this.set({ other: String(timeoutSetting(this.deps.saved())) });
	}

	editOther(text: string): void {
		this.set({ other: text });
	}

	cancelOther(): void {
		if (this.busy("timeout")) return;
		this.clear("timeout");
		this.set({ other: undefined });
	}

	/** The number field's Save: checked here first, since the core would take any number. */
	saveOther(): Promise<void> {
		if (this.busy("timeout")) return done;
		const saved = timeoutSetting(this.deps.saved());
		const seconds = parseTimeout(this.state.other ?? String(saved));
		if (seconds === undefined) {
			this.set({
				errors: { ...this.state.errors, timeout: { kind: "range" } },
			});
			return done;
		}
		if (seconds === saved) {
			this.clear("timeout");
			this.set({ other: undefined });
			return done;
		}
		return this.saveTimeout(seconds);
	}

	setPermissions(permissions: Permissions): Promise<void> {
		if (permissions === permissionsSetting(this.deps.saved())) return done;
		return this.save("permissions", () =>
			this.brain((brain) => ({ ...brain, permissions })),
		);
	}

	openLogs(): Promise<void> {
		return this.save("openLogs", async () => {
			await this.deps.call("logs.open");
		});
	}

	private saveTimeout(seconds: number): Promise<void> {
		return this.save("timeout", async () => {
			await this.brain((brain) => ({ ...brain, timeout: seconds }));
			// Saved: the field has done its job. After a failure it stays, with the number typed.
			this.set({ other: undefined });
		});
	}

	/** A change of `brain.*`; a running Familiar takes it up after a restart. */
	private async brain(
		change: (
			brain: NonNullable<Settings["brain"]>,
		) => NonNullable<Settings["brain"]>,
	): Promise<void> {
		await this.deps.updateSettings((settings) => ({
			...settings,
			brain: change({ ...settings.brain }),
		}));
	}

	private busy(control: Control): boolean {
		return this.state.busy.includes(control);
	}

	/** One change at a time per control; other controls may save meanwhile (MainApp queues them). */
	private async save(
		control: Control,
		action: () => Promise<void>,
	): Promise<void> {
		if (this.busy(control)) return;
		this.clear(control);
		this.set({ busy: [...this.state.busy, control] });
		try {
			await action();
			// The banner shows as soon as the core knows; app settings never bring it up.
			if (control !== "openLogs" && NEEDS_RESTART[control])
				await this.deps.refreshStatus().catch(() => {});
		} catch (error) {
			this.set({
				errors: {
					...this.state.errors,
					[control]: { kind: "core", message: messageOf(error) },
				},
			});
		} finally {
			this.set({ busy: this.state.busy.filter((c) => c !== control) });
		}
	}

	private clear(control: Control): void {
		if (!this.state.errors[control]) return;
		const errors = { ...this.state.errors };
		delete errors[control];
		this.set({ errors });
	}

	private set(change: Partial<SettingsPageState>): void {
		const next = { ...this.state, ...change };
		for (const key of Object.keys(change) as (keyof SettingsPageState)[])
			if (change[key] === undefined) delete next[key];
		this.state = next;
		for (const fn of this.watchers) fn(this.state);
	}
}

const done = Promise.resolve();
