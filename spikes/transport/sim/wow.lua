-- A small stand-in for the WoW: Forever client, to test the spike without the game.
-- It runs the real addon files against the API calls the spike uses. Files are real:
-- AddOns.txt, SavedVariables, slot data.lua and doorbell .wav files live in a client folder.
--
-- Commands on stdin, one per line; each is answered with "ok" (or "error <message>"):
--   frame <wallMs> <preciseMs>   run one rendered frame
--   slash <text>                 run a slash command, e.g. "slash /fspike bench"
--   list open|close              show or hide the addon list
--   combat on|off                enter or leave combat
--   reload                       /reload: save, then start a fresh UI
--   logout                       fire PLAYER_LOGOUT and write SavedVariables
-- Chat output is written as lines starting with "chat ".
--
-- usage: lua wow.lua <client folder> <account> <realm> <character> <names file> [flags]
-- flags, comma-separated:
--   noreset     C_AddOns.ResetAddOns keeps the in-memory state instead of re-reading disk
--   sparse      SaveAddOns writes only rows whose state differs from the addon's default
--   emptyplays  PlaySoundFile succeeds for an empty file and returns nothing for a missing
--               one, which then stays missing; as Sven saw on build 70888

local client, account, realm, character, namesFile, flagList = ...
assert(namesFile, "usage: lua wow.lua <client> <account> <realm> <character> <names file> [flags]")
local flags = {}
for flag in (flagList or ""):gmatch("[^,]+") do
	flags[flag] = true
end

local ADDONS = client .. "/Interface/AddOns/"
local ACCOUNT = client .. "/WTF/Account/" .. account .. "/"
local ADDONS_TXT = ACCOUNT .. realm .. "/" .. character .. "/AddOns.txt"
local SAVED = ACCOUNT .. "SavedVariables/"
local MAIN = "FamiliarSpike"
local GUID = "Player-4711-0ABC1234"

math.randomseed(os.time())

-- Client state that survives /reload ------------------------------------------
local known, order, toc, indexOf = {}, {}, {}, {}
local enabled, default = {}, {}
local sounds = {} -- length in ms of every file that played, cached per process like the real client
local absent = {} -- emptyplays: a file that was missing stays missing
local playing = {} -- sound handle -> end time in ms
local wallMs, preciseMs, lastPreciseMs = os.time() * 1000, 0, nil
local listShown, inCombat = false, false
local soundHandle = 0

local function readFile(path)
	local f = io.open(path, "rb")
	if not f then
		return nil
	end
	local data = f:read("*a")
	f:close()
	return data
end

local function writeFile(path, data)
	local f = assert(io.open(path, "wb"))
	f:write(data)
	f:close()
end

local function parseToc(name)
	local info = { files = {} }
	for line in (readFile(ADDONS .. name .. "/" .. name .. ".toc") or ""):gmatch("[^\r\n]+") do
		local key, value = line:match("^##%s*([%w%-]+)%s*:%s*(.-)%s*$")
		if key then
			info[key] = value
		elseif not line:match("^#") and line:match("%S") then
			info.files[#info.files + 1] = line
		end
	end
	return info
end

-- Addon folders are indexed once, at client start.
for name in (readFile(namesFile) or ""):gmatch("[^\r\n]+") do
	known[name] = true
	order[#order + 1] = name
	toc[name] = parseToc(name)
	default[name] = toc[name].DefaultState ~= "disabled"
end
table.sort(order)
for index, name in ipairs(order) do
	indexOf[name] = index
end

local function loadAddonsTxt()
	for _, name in ipairs(order) do
		enabled[name] = default[name]
	end
	for line in (readFile(ADDONS_TXT) or ""):gmatch("[^\r\n]+") do
		local name, state = line:match("^(.-):%s*(%a+)%s*$")
		if name and known[name] then
			enabled[name] = state == "enabled"
		end
	end
end

local function saveAddonsTxt()
	local lines = {}
	for _, name in ipairs(order) do
		if not flags.sparse or enabled[name] ~= default[name] then
			lines[#lines + 1] = name .. ": " .. (enabled[name] and "enabled" or "disabled")
		end
	end
	writeFile(ADDONS_TXT, table.concat(lines, "\n") .. "\n")
end

-- Length of a canonical PCM .wav in ms, or nil if the data is no playable sound.
local function wavLength(data)
	if #data <= 44 or data:sub(1, 4) ~= "RIFF" or data:sub(9, 12) ~= "WAVE" then
		return nil
	end
	local function u32(at)
		local a, b, c, d = data:byte(at, at + 3)
		return a + b * 256 + c * 65536 + d * 16777216
	end
	return u32(41) / u32(29) * 1000
end

loadAddonsTxt()

-- SavedVariables in the client's format ---------------------------------------
local function quote(s)
	return '"'
		.. s:gsub('[%c"\\]', function(c)
			if c == "\n" then
				return "\\n"
			elseif c == '"' or c == "\\" then
				return "\\" .. c
			end
			return string.format("\\%03d", c:byte())
		end)
		.. '"'
end

local function serialize(value, indent, out)
	local kind = type(value)
	if kind == "string" then
		out[#out + 1] = quote(value)
	elseif kind == "number" then
		out[#out + 1] = value == math.floor(value) and string.format("%d", value) or string.format("%.17g", value)
	elseif kind == "boolean" then
		out[#out + 1] = tostring(value)
	elseif kind == "table" then
		out[#out + 1] = "{\n"
		local n = #value
		for i = 1, n do
			out[#out + 1] = indent .. "\t"
			serialize(value[i], indent .. "\t", out)
			out[#out + 1] = ", -- [" .. i .. "]\n"
		end
		local keys = {}
		for k in pairs(value) do
			if not (type(k) == "number" and k >= 1 and k <= n and k == math.floor(k)) then
				keys[#keys + 1] = k
			end
		end
		table.sort(keys, function(a, b)
			return tostring(a) < tostring(b)
		end)
		for _, k in ipairs(keys) do
			out[#out + 1] = indent .. "\t[" .. (type(k) == "string" and quote(k) or tostring(k)) .. "] = "
			serialize(value[k], indent .. "\t", out)
			out[#out + 1] = ",\n"
		end
		out[#out + 1] = indent .. "}"
	else
		out[#out + 1] = "nil"
	end
end

-- One UI session ----------------------------------------------------------------
local env, frames, loaded

local function say(...)
	local parts = {}
	for i = 1, select("#", ...) do
		parts[#parts + 1] = tostring((select(i, ...)))
	end
	io.write("chat ", (table.concat(parts, " "):gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", "")), "\n")
end

local function fire(event, ...)
	for _, frame in ipairs(frames) do
		local handler = frame.scripts.OnEvent
		if frame.events[event] and handler then
			handler(frame, event, ...)
		end
	end
end

local function runFile(path, ...)
	local chunk = assert(loadfile(path))
	setfenv(chunk, env)
	return chunk(...)
end

local function loadAddon(name)
	if not known[name] then
		return false, "MISSING"
	end
	if loaded[name] then
		return true
	end
	if not enabled[name] then
		return false, "DISABLED"
	end
	local ns = {}
	for _, file in ipairs(toc[name].files) do
		runFile(ADDONS .. name .. "/" .. file, name, ns)
	end
	loaded[name] = true
	return true
end

local function newEnvironment()
	frames, loaded = {}, {}
	env = setmetatable({}, { __index = _G })
	env._G = env
	env.print = say
	env.FamiliarSpike_Fast = true
	env.SlashCmdList = {}
	env.AddonList = {
		IsShown = function()
			return listShown
		end,
	}
	env.time = function()
		return math.floor(wallMs / 1000)
	end
	env.GetTimePreciseSec = function()
		return preciseMs / 1000
	end
	env.debugprofilestop = function()
		return os.clock() * 1000
	end
	env.GetBuildInfo = function()
		return "1.60.1", "65432", "Nov 1 2026", 16001
	end
	env.UnitGUID = function(unit)
		return unit == "player" and GUID or nil
	end
	env.InCombatLockdown = function()
		return inCombat
	end
	env.IsInInstance = function()
		return false, "none"
	end
	env.PlaySoundFile = function(path)
		local file = client .. "/" .. path:gsub("\\", "/")
		local length = sounds[file]
		if not length then
			if absent[file] then
				return
			end
			local data = readFile(file)
			if not data and flags.emptyplays then
				absent[file] = true
				return
			end
			length = data and wavLength(data)
			if length then
				sounds[file] = length
			elseif flags.emptyplays then
				length = 0 -- plays nothing, and is read again next time
			else
				return false
			end
		end
		soundHandle = soundHandle + 1
		playing[soundHandle] = preciseMs + length
		return true, soundHandle
	end
	env.StopSound = function(handle)
		playing[handle] = nil
	end
	env.C_Sound = {
		IsPlaying = function(handle)
			local ends = playing[handle]
			return ends ~= nil and preciseMs < ends
		end,
	}
	env.CreateFrame = function()
		local frame = { events = {}, scripts = {} }
		function frame:RegisterEvent(event)
			self.events[event] = true
		end
		function frame:SetScript(script, handler)
			self.scripts[script] = handler
		end
		frames[#frames + 1] = frame
		return frame
	end
	-- The client takes an addon's name or its index, like the real API (uiAddon).
	local function addon(nameOrIndex)
		if type(nameOrIndex) == "number" then
			return order[nameOrIndex]
		end
		assert(type(nameOrIndex) == "string", "addon must be a name or an index")
		return known[nameOrIndex] and nameOrIndex or nil
	end
	local function character(who)
		assert(who == GUID, "character must be the player GUID")
	end
	env.C_AddOns = {
		GetNumAddOns = function()
			return #order
		end,
		GetAddOnInfo = function(nameOrIndex)
			local name = addon(nameOrIndex)
			if name then
				return name, toc[name].Title or name, toc[name].Notes, true, nil, "INSECURE"
			end
		end,
		DoesAddOnExist = function(nameOrIndex)
			return addon(nameOrIndex) ~= nil
		end,
		GetAddOnMetadata = function(nameOrIndex, field)
			local name = addon(nameOrIndex)
			return name and toc[name][field] or nil
		end,
		IsAddOnLoaded = function(nameOrIndex)
			return loaded[addon(nameOrIndex) or ""] == true
		end,
		LoadAddOn = function(nameOrIndex)
			return loadAddon(addon(nameOrIndex) or tostring(nameOrIndex))
		end,
		GetAddOnEnableState = function(nameOrIndex, who)
			character(who)
			return enabled[addon(nameOrIndex) or ""] and 2 or 0
		end,
		EnableAddOn = function(nameOrIndex, who)
			character(who)
			local name = addon(nameOrIndex)
			if name then
				enabled[name] = true
			end
		end,
		DisableAddOn = function(nameOrIndex, who)
			character(who)
			local name = addon(nameOrIndex)
			if name then
				enabled[name] = false
			end
		end,
		SaveAddOns = saveAddonsTxt,
		ResetAddOns = function()
			if not flags.noreset then
				loadAddonsTxt()
			end
		end,
	}
end

local function login(isReload)
	newEnvironment()
	local saved = SAVED .. MAIN .. ".lua"
	if readFile(saved) then
		runFile(saved)
	end
	loadAddon(MAIN)
	fire("ADDON_LOADED", MAIN)
	fire("PLAYER_LOGIN")
	fire("PLAYER_ENTERING_WORLD", not isReload, isReload)
end

local function logout()
	fire("PLAYER_LOGOUT")
	local out = { "\nFamiliarSpikeDB = " }
	serialize(env.FamiliarSpikeDB, "", out)
	out[#out + 1] = "\n"
	writeFile(SAVED .. MAIN .. ".lua", table.concat(out))
end

local function slash(text)
	local command, rest = text:match("^(/%S+)%s*(.-)$")
	for key, value in pairs(env) do
		local id = type(key) == "string" and key:match("^SLASH_(.+)%d$")
		if id and value == command then
			return env.SlashCmdList[id](rest)
		end
	end
	error("unknown slash command " .. tostring(command))
end

local commands = {
	frame = function(wall, precise)
		wallMs, preciseMs = tonumber(wall), tonumber(precise)
		local elapsed = lastPreciseMs and (preciseMs - lastPreciseMs) / 1000 or 0.016
		lastPreciseMs = preciseMs
		for _, frame in ipairs(frames) do
			local handler = frame.scripts.OnUpdate
			if handler then
				handler(frame, elapsed)
			end
		end
	end,
	slash = function(...)
		slash(table.concat({ ... }, " "))
	end,
	list = function(state)
		listShown = state == "open"
	end,
	combat = function(state)
		inCombat = state == "on"
	end,
	reload = function()
		logout()
		login(true)
	end,
	logout = logout,
}

login(false)
io.write("ok\n")
io.flush()
for line in io.lines() do
	local words = {}
	for word in line:gmatch("%S+") do
		words[#words + 1] = word
	end
	local handler = commands[words[1]]
	local ok, err = pcall(handler or error, select(2, unpack(words)))
	if not handler then
		err = "unknown command " .. tostring(words[1])
	end
	io.write(ok and handler and "ok\n" or ("error " .. tostring(err):gsub("\n", " ") .. "\n"))
	io.flush()
end
