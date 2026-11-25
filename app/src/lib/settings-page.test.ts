import { expect, test } from "bun:test";
import type { Settings } from "./brain.ts";
import { translator } from "./i18n.ts";
import { emptyView, type View } from "./overview.ts";
import {
	addonLine,
	closeSetting,
	DEFAULT_TIMEOUT,
	languageLabel,
	languageSetting,
	NEEDS_RESTART,
	oneLine,
	parseTimeout,
	permissionsSetting,
	platformName,
	presentSettings,
	SettingsController,
	type SettingsDeps,
	timeoutChoice,
	timeoutSetting,
} from "./settings-page.ts";
import type { Status } from "./types.ts";

const t = translator("en");
const de = translator("de");
const CLIENT = "C:\\Program Files (x86)\\World of Warcraft\\_forever_";

function status(over: Partial<Status> = {}): Status {
	return {
		running: true,
		client: CLIENT,
		addon: { installed: true },
		game: { running: false },
		brain: { kind: "agent", command: ["hermes", "acp"] },
		problems: [],
		...over,
	};
}

const view = (over: Partial<View> = {}): View => ({
	...emptyView("en"),
	gen: 1,
	version: "0.16.0",
	status: status(),
	settings: {
		app: { language: "system", close: "tray" },
		brain: { permissions: "ask" },
	},
	...over,
});

/** MainApp as the page sees it: saves change `saved`, or fail with the core's words. */
function fakes(start: Settings = {}) {
	let saved: Settings = structuredClone(start);
	const calls: string[] = [];
	const log: string[] = [];
	let fail: string | undefined;
	const waiting: (() => void)[] = [];
	let hold = false;
	let system: boolean | undefined;
	let systemFails = false;
	const replies: Record<string, unknown> = {
		"settings.get": {
			settings: saved,
			file: "/home/me/.config/familiar/settings.json",
		},
		"logs.folder": "/home/me/.config/familiar/logs",
		hello: { version: "0.16.0", platform: "linux", settingsFile: "x" },
		"logs.open": null,
	};
	const errors: Record<string, string> = {};
	const wait = async () => {
		if (hold) await new Promise<void>((r) => waiting.push(r));
		if (fail) throw fail;
	};
	const deps: SettingsDeps = {
		call: async <T>(method: string) => {
			calls.push(method);
			if (errors[method]) throw new Error(errors[method]);
			return replies[method] as T;
		},
		saved: () => saved,
		updateApp: async (change) => {
			log.push("updateApp");
			await wait();
			saved = { ...saved, app: change({ ...saved.app }) };
		},
		setAutostart: async (on) => {
			log.push(`setAutostart ${on}`);
			await wait();
			saved = { ...saved, app: { ...saved.app, autostart: on } };
		},
		updateSettings: async (change) => {
			log.push("updateSettings");
			await wait();
			saved = change(structuredClone(saved));
			return saved;
		},
		refreshStatus: async () => {
			log.push("refreshStatus");
		},
		// The system's entry follows a successful setAutostart, unless a test sets it apart.
		systemAutostart: async () => {
			if (systemFails) throw new Error("No access.");
			return system ?? saved.app?.autostart === true;
		},
		appVersion: async () => "0.16.1",
	};
	return {
		deps,
		calls,
		log,
		errors,
		saved: () => saved,
		failWith: (message: string | undefined) => {
			fail = message;
		},
		holdSaves: () => {
			hold = true;
		},
		setSystem: (on: boolean | undefined, fails = false) => {
			system = on;
			systemFails = fails;
		},
		release: () => {
			hold = false;
			for (const go of waiting.splice(0)) go();
		},
	};
}

test("the values shown: the saved ones, with the core's defaults", () => {
	expect(languageSetting(undefined)).toBe("system");
	expect(languageSetting({ app: { language: "de" } })).toBe("de");
	expect(languageSetting({ app: { language: "fr" } })).toBe("system");
	expect(closeSetting({ app: { close: "quit" } })).toBe("quit");
	expect(closeSetting({})).toBe("tray");
	expect(timeoutSetting({})).toBe(DEFAULT_TIMEOUT);
	expect(timeoutSetting({ brain: { timeout: 90 } })).toBe(90);
	expect(timeoutSetting({ brain: { timeout: -1 } })).toBe(DEFAULT_TIMEOUT);
	expect(permissionsSetting({})).toBe("ask");
	expect(permissionsSetting({ brain: { permissions: "deny" } })).toBe("deny");
});

test("the time limit: four choices, anything else is Other", () => {
	expect(timeoutChoice(120)).toBe(120);
	expect(timeoutChoice(300)).toBe(300);
	expect(timeoutChoice(90)).toBe("other");
	expect(timeoutChoice(900)).toBe("other");
});

test("the number field takes whole seconds from 30 to 600", () => {
	expect(parseTimeout("30")).toBe(30);
	expect(parseTimeout(" 600 ")).toBe(600);
	expect(parseTimeout("90")).toBe(90);
	expect(parseTimeout("29")).toBeUndefined();
	expect(parseTimeout("601")).toBeUndefined();
	expect(parseTimeout("90.5")).toBeUndefined();
	expect(parseTimeout("-60")).toBeUndefined();
	expect(parseTimeout("1e2")).toBeUndefined();
	expect(parseTimeout("")).toBeUndefined();
});

test("only the brain's settings need a restart", () => {
	expect(NEEDS_RESTART).toEqual({
		language: false,
		close: false,
		autostart: false,
		timeout: true,
		permissions: true,
	});
});

test("System says which language it means, each language in its own words", () => {
	expect(languageLabel("system", "de", t)).toBe("System (Deutsch)");
	expect(languageLabel("system", "en", de)).toBe("System (English)");
	expect(languageLabel("en", "de", de)).toBe("English");
	expect(languageLabel("de", "en", t)).toBe("Deutsch");
	const p = presentSettings({ busy: [], errors: {} }, view(), t, "de");
	expect(p.language.options.map((o) => o.label)).toEqual([
		"System (Deutsch)",
		"English",
		"Deutsch",
	]);
});

test("the core's words stay as they are, on one line", () => {
	expect(oneLine("The settings:\n  brain.timeout: too small")).toBe(
		"The settings: brain.timeout: too small",
	);
	expect(oneLine("<b>not html</b>")).toBe("<b>not html</b>");
	expect(platformName("win32")).toBe("Windows");
	expect(platformName("freebsd")).toBe("freebsd");
});

test("the addon in one line, from the status", () => {
	expect(addonLine(view(), t)).toEqual({
		text: "Installed",
		tone: "good",
		client: CLIENT,
	});
	expect(
		addonLine(view({ status: status({ addon: { installed: false } }) }), t)
			.text,
	).toBe("Not installed");
	const none = status();
	delete none.client;
	expect(addonLine(view({ status: none }), t)).toEqual({
		text: "No WoW Forever found.",
		tone: "off",
	});
});

test("the autostart switch shows what the system does, and says when the setting differs", async () => {
	const f = fakes({ app: { autostart: true } });
	f.setSystem(false);
	const c = new SettingsController(f.deps);
	await c.load();
	let p = presentSettings(c.state, view({ settings: f.saved() }), t, "en");
	expect(p.autostart.on).toBe(false);
	expect(p.autostart.differs).toBe(true);
	// Switching it on writes the entry; read again, the two agree.
	f.setSystem(undefined);
	await c.setAutostart(true);
	expect(f.log).toContain("setAutostart true");
	p = presentSettings(c.state, view({ settings: f.saved() }), t, "en");
	expect(p.autostart.on).toBe(true);
	expect(p.autostart.differs).toBe(false);
	// Not readable: the switch follows the setting, and nothing claims a difference.
	const g = fakes({ app: { autostart: true } });
	g.setSystem(undefined, true);
	const d = new SettingsController(g.deps);
	await d.load();
	p = presentSettings(d.state, view({ settings: g.saved() }), t, "en");
	expect(p.autostart.on).toBe(true);
	expect(p.autostart.differs).toBe(false);
});

test("an app version that cannot be read says so, instead of waiting forever", async () => {
	const f = fakes();
	f.deps.appVersion = async () => {
		throw new Error("Not allowed.");
	};
	const c = new SettingsController(f.deps);
	await c.load();
	expect(presentSettings(c.state, view(), t, "en").about.version).toBe(
		"unknown",
	);
});

test("presents the page: saved values, the banner, files and versions", () => {
	const p = presentSettings(
		{
			busy: ["close"],
			errors: { autostart: { kind: "core", message: "No\nentry" } },
			file: "/f/settings.json",
			folder: "/f/logs",
			coreVersion: "0.16.0",
			platform: "linux",
			appVersion: "0.16.0",
		},
		view({
			settings: {
				app: { language: "de", close: "quit", autostart: true },
				brain: { timeout: 90, permissions: "allow" },
			},
			status: status({ restartNeeded: true }),
		}),
		t,
		"en",
	);
	expect(p.ready).toBe(true);
	expect(p.restartNeeded).toBe(true);
	expect(p.language.value).toBe("de");
	expect(p.close).toEqual({ busy: true, value: "quit" });
	expect(p.autostart).toEqual({
		busy: false,
		error: "No entry",
		on: true,
		linux: true,
		differs: false,
	});
	expect(p.timeout).toEqual({
		busy: false,
		seconds: 90,
		choice: "other",
		field: { text: "90", editing: false },
	});
	expect(p.permissions.value).toBe("allow");
	expect(p.files).toEqual({
		file: "/f/settings.json",
		folder: "/f/logs",
		open: { busy: false },
	});
	expect(p.about).toEqual({ version: "0.16.0", core: "0.16.0 on Linux" });
});

test("no banner after the core stopped, no Linux hint elsewhere, nothing before the settings", () => {
	const p = presentSettings(
		{ busy: [], errors: {}, platform: "win32" },
		view({
			exited: true,
			status: status({ restartNeeded: true }),
			settings: undefined,
		}),
		t,
		"en",
	);
	expect(p.restartNeeded).toBe(false);
	expect(p.autostart.linux).toBe(false);
	expect(p.ready).toBe(false);
	expect(p.timeout.field).toBeUndefined();
});

test("load: the files' places and the core's version, each failing on its own", async () => {
	const f = fakes();
	const c = new SettingsController(f.deps);
	await c.load();
	expect(c.state).toMatchObject({
		file: "/home/me/.config/familiar/settings.json",
		folder: "/home/me/.config/familiar/logs",
		coreVersion: "0.16.0",
		platform: "linux",
	});
	f.errors["logs.folder"] = "Familiar's core stopped.";
	f.errors.hello = "Familiar's core stopped.";
	await c.load();
	expect(c.state.file).toBe("/home/me/.config/familiar/settings.json");
	expect(c.state.folderError).toBe("Familiar's core stopped.");
	// The last folder known stays; its error says why it may be old.
	expect(c.state.folder).toBe("/home/me/.config/familiar/logs");
	expect(c.state.coreVersion).toBe("0.16.0");
	delete f.errors["logs.folder"];
	await c.load();
	expect(c.state.folderError).toBeUndefined();
});

test("app settings go through updateApp and apply at once", async () => {
	const f = fakes({ app: { language: "system", close: "tray" } });
	const c = new SettingsController(f.deps);
	await c.setLanguage("de");
	await c.setClose("quit");
	expect(f.saved().app).toEqual({ language: "de", close: "quit" });
	expect(f.log).toEqual(["updateApp", "updateApp"]);
	// The saved value again: nothing to do.
	await c.setLanguage("de");
	await c.setClose("quit");
	expect(f.log).toHaveLength(2);
});

test("autostart goes through setAutostart, which sets the system's entry first", async () => {
	const f = fakes({ app: {} });
	const c = new SettingsController(f.deps);
	await c.setAutostart(false);
	expect(f.log).toEqual([]);
	await c.setAutostart(true);
	expect(f.log).toEqual(["setAutostart true"]);
	expect(f.saved().app?.autostart).toBe(true);
});

test("answer settings go through updateSettings, then the status for the banner", async () => {
	const f = fakes({
		brain: { permissions: "ask", command: ["hermes", "acp"] },
	});
	const c = new SettingsController(f.deps);
	await c.setPermissions("allow");
	await c.chooseTimeout(300);
	expect(f.saved().brain).toEqual({
		permissions: "allow",
		command: ["hermes", "acp"],
		timeout: 300,
	});
	expect(f.log).toEqual([
		"updateSettings",
		"refreshStatus",
		"updateSettings",
		"refreshStatus",
	]);
	await c.setPermissions("allow");
	await c.chooseTimeout(300);
	expect(f.log).toHaveLength(4);
});

test("a failed save: the core's words under that control, the saved value unchanged", async () => {
	const f = fakes({ app: { autostart: false }, brain: { permissions: "ask" } });
	const c = new SettingsController(f.deps);
	f.failWith("The autostart entry could not be written.");
	await c.setAutostart(true);
	expect(c.state.errors).toEqual({
		autostart: {
			kind: "core",
			message: "The autostart entry could not be written.",
		},
	});
	expect(c.state.busy).toEqual([]);
	const p = presentSettings(c.state, view({ settings: f.saved() }), t, "en");
	expect(p.autostart.on).toBe(false);
	expect(p.autostart.error).toBe("The autostart entry could not be written.");
	// Another control's save leaves that error alone; the next try of the same clears it.
	f.failWith(undefined);
	await c.setPermissions("deny");
	expect(c.state.errors.autostart).toBeDefined();
	await c.setAutostart(true);
	expect(c.state.errors).toEqual({});
	expect(f.saved().app?.autostart).toBe(true);
});

test("one change at a time per control; other controls may save meanwhile", async () => {
	const f = fakes({
		app: { language: "system" },
		brain: { permissions: "ask" },
	});
	const c = new SettingsController(f.deps);
	f.holdSaves();
	const first = c.setLanguage("de");
	await Promise.resolve();
	expect(c.state.busy).toEqual(["language"]);
	const presented = presentSettings(c.state, view(), t, "en");
	expect(presented.language.busy).toBe(true);
	// A second click on the same control while it saves does nothing.
	await c.setLanguage("en");
	const other = c.setPermissions("deny");
	await Promise.resolve();
	expect(c.state.busy).toEqual(["language", "permissions"]);
	f.release();
	await Promise.all([first, other]);
	expect(c.state.busy).toEqual([]);
	expect(f.log.filter((l) => l === "updateApp")).toHaveLength(1);
	expect(f.saved().app?.language).toBe("de");
});

test("Other…: opens with the saved number, saves a checked one, closes after", async () => {
	const f = fakes({ brain: { timeout: 120 } });
	const c = new SettingsController(f.deps);
	c.openOther();
	expect(c.state.other).toBe("120");
	expect(
		presentSettings(c.state, view({ settings: f.saved() }), t, "en").timeout
			.field,
	).toEqual({ text: "120", editing: true });
	c.editOther("700");
	await c.saveOther();
	expect(c.state.errors.timeout).toEqual({ kind: "range" });
	expect(presentSettings(c.state, view(), t, "en").timeout.error).toBe(
		"Enter a whole number of seconds from 30 to 600.",
	);
	expect(f.log).toEqual([]);
	c.editOther("90");
	await c.saveOther();
	expect(f.saved().brain?.timeout).toBe(90);
	expect(c.state.other).toBeUndefined();
	expect(c.state.errors).toEqual({});
	// A saved number that is no choice keeps the field open, not editing.
	expect(
		presentSettings(c.state, view({ settings: f.saved() }), t, "en").timeout,
	).toMatchObject({ choice: "other", field: { text: "90", editing: false } });
});

test("Other…: the same number saves nothing, Cancel and a choice close the field", async () => {
	const f = fakes({ brain: { timeout: 180 } });
	const c = new SettingsController(f.deps);
	c.openOther();
	await c.saveOther();
	expect(f.log).toEqual([]);
	expect(c.state.other).toBeUndefined();
	c.openOther();
	c.editOther("abc");
	await c.saveOther();
	expect(c.state.errors.timeout).toEqual({ kind: "range" });
	c.cancelOther();
	expect(c.state.other).toBeUndefined();
	expect(c.state.errors).toEqual({});
	c.openOther();
	await c.chooseTimeout(180);
	expect(c.state.other).toBeUndefined();
	expect(f.log).toEqual([]);
});

test("Other…: a failed save keeps the number typed, with the core's words", async () => {
	const f = fakes({ brain: { timeout: 120 } });
	const c = new SettingsController(f.deps);
	c.openOther();
	c.editOther("45");
	f.failWith("Could not save the settings.");
	await c.saveOther();
	expect(c.state.other).toBe("45");
	expect(c.state.errors.timeout).toEqual({
		kind: "core",
		message: "Could not save the settings.",
	});
	expect(f.saved().brain?.timeout).toBe(120);
});

test("Open the log folder: through the core, its error under the button", async () => {
	const f = fakes();
	const c = new SettingsController(f.deps);
	await c.openLogs();
	expect(f.calls).toEqual(["logs.open"]);
	f.errors["logs.open"] = "No file manager was found.";
	await c.openLogs();
	expect(presentSettings(c.state, view(), t, "en").files.open.error).toBe(
		"No file manager was found.",
	);
});
