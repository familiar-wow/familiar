-- Entry point: sessions, events, OnUpdate driver and the /fspike command.
local addonName, ns = ...
local Probe = ns.Probe

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

local function newSession(isReload)
	local db = ns.db
	local version, build, _, interface = GetBuildInfo()
	local epoch
	repeat
		epoch = math.random(1, 255)
	until epoch ~= db.lastEpoch
	db.lastEpoch = epoch
	local session = {
		epoch = epoch,
		-- Tells the companion this is a new session even if the epoch was used before.
		nonce = (time() % 1000000) * 2000 + math.random(0, 1999),
		started = time(),
		reload = isReload and true or false,
		build = tostring(version) .. "." .. tostring(build),
		interface = interface,
		soak = {},
		events = {},
		errors = {},
	}
	db.sessions[#db.sessions + 1] = session
	while #db.sessions > 12 do
		table.remove(db.sessions, 1)
	end
	return session
end

local frame = CreateFrame("Frame")
local broken = false

frame:RegisterEvent("ADDON_LOADED")
frame:RegisterEvent("PLAYER_ENTERING_WORLD")
frame:RegisterEvent("PLAYER_LOGOUT")
frame:SetScript("OnEvent", function(_, event, ...)
	if event == "ADDON_LOADED" and ... == addonName then
		FamiliarSpikeDB = FamiliarSpikeDB or {}
		local db = FamiliarSpikeDB
		db.sessions = db.sessions or {}
		db.nextSignal = db.nextSignal or 1
		if db.soak == nil then
			db.soak = true
		end
		ns.db = db
	elseif event == "PLAYER_ENTERING_WORLD" then
		local isInitialLogin, isReloadingUi = ...
		if ns.session then
			Probe.Event("zone", isInitialLogin and "login" or "")
			return
		end
		if isInitialLogin then
			-- A new client process: the companion has reset all signal files.
			ns.db.nextSignal = 1
		end
		ns.session = newSession(isReloadingUi)
		Probe.Setup(UnitGUID("player"), ns.session)
		Probe.Event("session", isReloadingUi and "reload" or "login")
		Probe.Spawn("hello", Probe.Hello, isReloadingUi)
		Probe.Spawn("soak", Probe.Soak)
	elseif event == "PLAYER_LOGOUT" and ns.session then
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
SlashCmdList.FAMILIARSPIKE = function(input)
	local command = (input or ""):lower():gsub("^%s+", ""):gsub("%s+$", "")
	if command == "bench" then
		if not ns.session then
			ns.Say("Not ready yet.")
		elseif InCombatLockdown() then
			ns.Say("Leave combat first.")
		elseif Probe.benchRunning then
			ns.Say("The benchmark is already running.")
		else
			Probe.Spawn("bench", Probe.Bench)
		end
	elseif command == "soak on" or command == "soak off" then
		ns.db.soak = command == "soak on"
		ns.Say("Soak " .. (ns.db.soak and "on." or "off."))
	elseif ns.session then
		ns.Say(Probe.Status())
	end
end
