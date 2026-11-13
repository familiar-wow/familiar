-- Entry point: sessions, events, the OnUpdate driver and /fspike.
local addonName, ns = ...
local Probe, Font, Shot, Msg, Bench = ns.Probe, ns.Font, ns.Shot, ns.Msg, ns.Bench
local Settings = Probe.Settings
local format = string.format

-- The lane helpers' addon list category (src/install.ts).
local CATEGORY = "Familiar Spike lane"

function ns.Say(text)
	print("|cff8fd1ffFamiliar Spike:|r " .. text)
end

function ns.Fail(where, err)
	local message = tostring(where) .. ": " .. tostring(err)
	local session = ns.session
	if session and #session.errors < 20 then
		session.errors[#session.errors + 1] = message
	end
	ns.Say("|cffff6060error|r " .. message)
end

-- Collapses the helpers' category in the addon list once; after that it is the player's.
-- Returns the state found: 1 collapsed, 0 open, -1 unknown.
local function collapse(db)
	local collapsed = _G.g_addonCategoriesCollapsed
	if type(collapsed) ~= "table" then
		return -1
	end
	local before = collapsed[CATEGORY] and 1 or 0
	if not db.collapsedOnce then
		collapsed[CATEGORY], db.collapsedOnce = true, true
	end
	return before
end

local function helperCount()
	local n = 0
	for index = 1, C_AddOns.GetNumAddOns() do
		if (C_AddOns.GetAddOnInfo(index) or ""):find("^FamiliarSpike_") then
			n = n + 1
		end
	end
	return n
end

local function newSession(isReload)
	local db = ns.db
	local version, build, _, interface = GetBuildInfo()
	local epoch
	repeat
		epoch = math.random(1, 255)
	until epoch ~= db.lastEpoch
	db.lastEpoch = epoch
	local width, height = GetPhysicalScreenSize()
	local session = {
		epoch = epoch,
		-- Tells the companion this is a new session even if the epoch was used before.
		nonce = (time() % 1000000) * 2000 + math.random(0, 1999),
		started = time(),
		reload = isReload and true or false,
		build = tostring(version) .. "." .. tostring(build),
		interface = interface,
		screen = format("%dx%d", width, height),
		settings = Settings.Snapshot(),
		collapsed = collapse(db),
		helpers = helperCount(),
		recovered = ns.recovered,
		bells = {},
		lane = {},
		shots = {},
		trips = {},
		events = {},
		errors = {},
	}
	ns.recovered = nil
	-- 1 when this is the first session of a client process: the font bank starts over.
	session.fontRestart = Font.Begin(db) and 1 or 0
	session.fontProcess, session.fontFirst = db.fontProcess, db.fontNext
	db.sessions[#db.sessions + 1] = session
	while #db.sessions > 12 do
		table.remove(db.sessions, 1)
	end
	return session
end

-- A job or task died: put everything back the player could notice.
Probe.onFailure = function(name)
	Settings.RestoreAll()
	pcall(SetUIVisibility, true)
	Shot.Hide()
	Shot.Quiet(false)
	Probe.phase = "idle"
	if name == "worker" then
		Bench.running = false
		Msg.Reset()
		Probe.Spawn("worker", Msg.Worker)
	end
end
Probe.onListClosed = Msg.Invalidate

local frame = CreateFrame("Frame")
local broken = false

frame:RegisterEvent("ADDON_LOADED")
frame:RegisterEvent("PLAYER_ENTERING_WORLD")
frame:RegisterEvent("PLAYER_LOGOUT")
frame:SetScript("OnEvent", function(_, event, ...)
	if event == "ADDON_LOADED" and ... == addonName then
		FamiliarSpikeDB = FamiliarSpikeDB or {}
		local db = FamiliarSpikeDB
		-- Results of another version use other formats.
		local version = C_AddOns.GetAddOnMetadata(addonName, "Version")
		if db.version ~= version then
			db.sessions, db.version = {}, version
		end
		db.sessions = db.sessions or {}
		db.nextSignal = db.nextSignal or 1
		if db.soak == nil then
			db.soak = true
		end
		ns.db = db
		-- A benchmark that did not finish may have left picture or sound settings behind.
		ns.recovered = Settings.Recover(db)
	elseif event == "ADDON_LOADED" and ... == "Blizzard_AddOnList" and ns.db then
		collapse(ns.db)
	elseif event == "PLAYER_ENTERING_WORLD" then
		local isInitialLogin, isReloadingUi = ...
		if ns.session then
			Probe.Event("zone", isInitialLogin and "login" or "")
			return
		end
		ns.session = newSession(isReloadingUi)
		Msg.Setup(UnitGUID("player"))
		Probe.Event("session", isReloadingUi and "reload" or "login")
		if ns.session.recovered then
			ns.Say("Put back settings an interrupted benchmark had changed: " .. ns.session.recovered .. ".")
		end
		Probe.Spawn("worker", Msg.Worker)
		Probe.Spawn("start", Bench.Start, isReloadingUi)
		Probe.Spawn("soak", Bench.Soak)
	elseif event == "PLAYER_LOGOUT" and ns.session then
		Settings.RestoreAll()
		Settings.Remember(ns.db)
		local collapsed = _G.g_addonCategoriesCollapsed
		ns.session.collapsedAtEnd = type(collapsed) == "table" and (collapsed[CATEGORY] and 1 or 0) or -1
		Probe.Store(ns.session)
	end
end)

frame:SetScript("OnUpdate", function(_, elapsed)
	if broken or not ns.session then
		return
	end
	local ok, err = pcall(Probe.Frame, Probe.Now(), elapsed * 1000)
	if not ok then
		broken = true
		ns.Fail("update", err)
	end
end)

SLASH_FAMILIARSPIKE1 = "/fspike"
SlashCmdList.FAMILIARSPIKE = function(input, editBox)
	local command, rest = (input or ""):match("^%s*(%S*)%s*(.-)%s*$")
	command = (command or ""):lower()
	if command == "say" then
		Bench.Say(rest or "", editBox)
	elseif command == "bench" then
		if not ns.session or not ns.session.selftest then
			ns.Say("Not ready yet; the self-test is still running.")
		elseif InCombatLockdown() then
			ns.Say("Leave combat first.")
		elseif Bench.running then
			ns.Say("The benchmark is already running.")
		else
			Bench.running = true
			Msg.Post(Bench.Run)
		end
	elseif command == "soak" and (rest == "on" or rest == "off") then
		ns.db.soak = rest == "on"
		ns.Say("Soak " .. (ns.db.soak and "on." or "off."))
	elseif ns.session then
		ns.Say(Bench.Status())
	end
end
