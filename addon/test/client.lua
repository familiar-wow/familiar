-- A small stand-in for the WoW: Forever client, to run the real addon without the game. It
-- implements the calls the addon makes and the file behavior measured in FAM-15:
--   * AddOns.txt holds rows per character, the client one enabled state per process. Logging in
--     applies the character's rows; EnableAddOn and DisableAddOn give an addon a row only when
--     they change its state; SaveAddOns writes the logged-in character's file.
--   * A font file loads once per process and is usable two frames after SetFont; until then a
--     font string measures with the font it had. Advances are rounded to whole pixels.
--   * PlaySoundFile reports even an empty file as played, C_Sound.IsPlaying tells for how long.
--     A file that played with sound stays cached for the process, a missing one stays missing.
-- What it shows is our own logic, never the client's behavior.
--
-- usage: lua client.lua <client folder> <account> <realm> <character> <file listing the addons>
-- Commands on stdin, one per line:
--   frame <ms>          run one frame at <ms> since the start
--   slash <text>        type a slash command
--   reload              /reload
--   login <character>   log out and log in another character, in the same process
--   restart             quit the game and start it again a minute later: a new process
--   list open|close     show or hide the addon list
--   sound on|off        switch all game sound
--   drop <n>            the next n AddOns.txt writes get lost
-- Output: "chat <text>" for every line the addon prints, "error <text>" for a Lua error.

local client, account, realm, character, addonList = ...
assert(addonList, "usage: lua client.lua <client> <account> <realm> <character> <addon list>")
local bit = bit or require("bit")

local ADDONS = client .. "/Interface/AddOns/"
local SCREEN_W, SCREEN_H, UI_SCALE = 1280, 720, 0.9

local function readFile(path)
	local f = io.open(path, "rb")
	if not f then
		return nil
	end
	local data = f:read("*a")
	f:close()
	return data
end

local function out(kind, text)
	io.write(kind, " ", (tostring(text):gsub("\n", "\\n")), "\n")
	io.flush()
end

local function copy(value)
	if type(value) ~= "table" then
		return value
	end
	local t = {}
	for k, v in pairs(value) do
		t[k] = copy(v)
	end
	return t
end

-- Addons, known from the client's start -------------------------------------------
local names, toc = {}, {}
for name in (readFile(addonList) or ""):gmatch("[^\r\n]+") do
	local info = { files = {} }
	for line in (readFile(ADDONS .. name .. "/" .. name .. ".toc") or ""):gmatch("[^\r\n]+") do
		local key, value = line:match("^##%s*([%w%-]+)%s*:%s*(.-)%s*$")
		if key then
			info[key] = value
		elseif not line:match("^#") and line:match("%S") then
			info.files[#info.files + 1] = line
		end
	end
	names[#names + 1], toc[name] = name, info
end
table.sort(names)

-- Process state ---------------------------------------------------------------------
local clock, wallStart, frameNo = 0, os.time(), 0 -- wallStart moves on with every restart
local process -- started, enabled, fonts, sounds, absent
local rows = {} -- addons with a row in the logged-in character's AddOns.txt
local saved = {} -- SavedVariables of the account
local collapsed = {} -- the addon list's categories, kept per machine
local soundOn, drops = true, 0
local handles, nextHandle = {}, 0

local function startProcess()
	process = { started = clock, enabled = {}, fonts = {}, sounds = {}, absent = {} }
	for _, name in ipairs(names) do
		process.enabled[name] = toc[name].DefaultState ~= "disabled"
	end
end

local function addonsTxt()
	return client .. "/WTF/Account/" .. account .. "/" .. realm .. "/" .. character .. "/AddOns.txt"
end

local function loadRows()
	rows = {}
	for line in (readFile(addonsTxt()) or ""):gmatch("[^\r\n]+") do
		local name, state = line:match("^(.-):%s*(%a+)%s*$")
		if name and toc[name] then
			process.enabled[name], rows[name] = state == "enabled", true
		end
	end
end

local function saveRows()
	if drops > 0 then
		drops = drops - 1
		return
	end
	local lines = {}
	for _, name in ipairs(names) do
		if rows[name] then
			lines[#lines + 1] = name .. ": " .. (process.enabled[name] and "enabled" or "disabled")
		end
	end
	local f = assert(io.open(addonsTxt(), "wb"))
	f:write(table.concat(lines, "\r\n"), "\r\n")
	f:close()
end

-- Fonts ------------------------------------------------------------------------------
local function u16(data, at)
	return data:byte(at + 1) * 256 + data:byte(at + 2)
end

-- Advance widths and a format 4 cmap: what Familiar's fonts use.
local function parseFont(data)
	local tables = {}
	for i = 0, u16(data, 4) - 1 do
		local at = 12 + 16 * i
		tables[data:sub(at + 1, at + 4)] = u16(data, at + 8) * 65536 + u16(data, at + 10)
	end
	local font = { upem = u16(data, tables.head + 18), advance = {}, segments = {} }
	for gid = 0, u16(data, tables.hhea + 34) - 1 do
		font.advance[gid] = u16(data, tables.hmtx + 4 * gid)
	end
	local sub = tables.cmap + u16(data, tables.cmap + 8) * 65536 + u16(data, tables.cmap + 10)
	local count = u16(data, sub + 6) / 2
	for k = 0, count - 1 do
		font.segments[#font.segments + 1] = {
			last = u16(data, sub + 14 + 2 * k),
			first = u16(data, sub + 16 + 2 * count + 2 * k),
			delta = u16(data, sub + 16 + 4 * count + 2 * k),
		}
	end
	return font
end

local function codes(text)
	local list, i = {}, 1
	while i <= #text do
		local c = text:byte(i)
		if c < 0x80 then
			list[#list + 1], i = c, i + 1
		elseif c < 0xE0 then
			list[#list + 1], i = (c - 0xC0) * 64 + text:byte(i + 1) - 0x80, i + 2
		else
			list[#list + 1], i = ((c - 0xE0) * 64 + text:byte(i + 1) - 0x80) * 64 + text:byte(i + 2) - 0x80, i + 3
		end
	end
	return list
end

local function advance(font, code)
	for _, s in ipairs(font.segments) do
		if code >= s.first and code <= s.last then
			return font.advance[(code + s.delta) % 65536] or 0
		end
	end
	return font.advance[0]
end

local FontString = {}
FontString.__index = FontString
for _, name in ipairs({ "SetPoint", "SetAlpha", "SetWordWrap", "SetNonSpaceWrap", "Show", "Hide" }) do
	FontString[name] = function() end
end

local function current(self)
	local pending = self.pending
	if pending and frameNo >= pending.font.ready then
		self.font, self.pending = pending, nil
	end
	return self.font
end

function FontString:SetFont(path, size)
	local file = client .. "/" .. path:gsub("\\", "/")
	if not process.fonts[file] then
		local data = readFile(file)
		if not data then
			return
		end
		process.fonts[file] = parseFont(data)
		process.fonts[file].ready = frameNo + 2
	end
	self.pending = { font = process.fonts[file], path = path, size = size }
end

function FontString:GetFont()
	local font = current(self)
	if font then
		return font.path, font.size
	end
	return "Fonts\\FRIZQT__.TTF", 12
end

function FontString:SetText(text)
	self.text = tostring(text or "")
end

function FontString:GetStringWidth()
	local font, list = current(self), codes(self.text or "")
	if not font then
		return #list * 7
	end
	local k = self.parent:GetEffectiveScale() * SCREEN_H / 768 -- pixels per unit
	local pixels = 0
	for _, code in ipairs(list) do
		pixels = pixels + math.floor(advance(font.font, code) * font.size / font.font.upem * k + 0.5)
	end
	return pixels / k
end

-- Sounds -----------------------------------------------------------------------------
-- Length of a canonical PCM .wav in seconds; 0 for an empty file.
local function wavLength(data)
	if #data <= 44 or data:sub(1, 4) ~= "RIFF" then
		return 0
	end
	local function u32(at)
		local a, b, c, d = data:byte(at, at + 3)
		return a + b * 256 + c * 65536 + d * 16777216
	end
	return u32(41) / u32(29)
end

local function playSoundFile(path)
	if not soundOn then
		return false
	end
	local file = client .. "/" .. path:gsub("\\", "/")
	if process.absent[file] then
		return nil
	end
	local length = process.sounds[file]
	if not length then
		local data = readFile(file)
		if not data then
			process.absent[file] = true
			return nil
		end
		length = wavLength(data)
		if length > 0 then
			process.sounds[file] = length
		end
	end
	nextHandle = nextHandle + 1
	handles[nextHandle] = clock + length
	return true, nextHandle
end

-- Frames -----------------------------------------------------------------------------
local Frame = {}
Frame.__index = Frame
local frames = {}

local function newFrame(parent)
	local frame = setmetatable({ parent = parent, events = {}, scripts = {}, shown = true, scale = 1 }, Frame)
	frames[#frames + 1] = frame
	return frame
end

for _, name in ipairs({ "SetPoint", "SetSize", "SetAlpha" }) do
	Frame[name] = function() end
end
function Frame:RegisterEvent(event)
	self.events[event] = true
end
function Frame:SetScript(script, handler)
	self.scripts[script] = handler
end
function Frame:Show()
	self.shown = true
end
function Frame:Hide()
	self.shown = false
end
function Frame:IsShown()
	return self.shown
end
function Frame:SetIgnoreParentScale(on)
	self.ignoreParentScale = on
end
function Frame:SetScale(scale)
	self.scale = scale
end
function Frame:GetEffectiveScale()
	local parent = self.parent and not self.ignoreParentScale and self.parent:GetEffectiveScale() or 1
	return parent * self.scale
end
function Frame:CreateFontString()
	return setmetatable({ parent = self }, FontString)
end

-- UI sessions ------------------------------------------------------------------------
local env

local function fire(event, ...)
	for _, frame in ipairs(frames) do
		if frame.events[event] and frame.scripts.OnEvent then
			local ok, err = pcall(frame.scripts.OnEvent, frame, event, ...)
			if not ok then
				out("error", err)
			end
		end
	end
end

local function api()
	local e = {}
	for _, name in ipairs({
		"assert", "error", "ipairs", "next", "pairs", "pcall", "select", "setmetatable", "getmetatable",
		"tonumber", "tostring", "type", "unpack", "coroutine", "math", "string", "table",
	}) do
		e[name] = _G[name]
	end
	e._G, e.bit = e, bit
	e.print = function(...)
		local parts = {}
		for i = 1, select("#", ...) do
			parts[i] = tostring((select(i, ...)))
		end
		out("chat", table.concat(parts, " "))
	end
	e.time = function()
		return math.floor(wallStart + clock)
	end
	e.GetTime = function()
		return clock
	end
	e.GetTimePreciseSec = e.GetTime
	e.GetSessionTime = function()
		return math.floor(clock - process.started)
	end
	e.GetBuildInfo = function()
		return "1.60.1", "70888", "Nov 1 2026", 16001
	end
	e.GetPhysicalScreenSize = function()
		return SCREEN_W, SCREEN_H
	end
	e.UnitGUID = function()
		return "Player-1-" .. character
	end
	e.CreateFrame = function(_, _, parent)
		return newFrame(parent)
	end
	e.UIParent = newFrame(nil)
	e.UIParent.scale = UI_SCALE
	e.AddonList = newFrame(e.UIParent)
	e.AddonList.shown = false
	e.g_addonCategoriesCollapsed = collapsed
	e.SlashCmdList = {}
	e.PlaySoundFile = playSoundFile
	e.StopSound = function(handle)
		handles[handle] = nil
	end
	e.C_Sound = {
		IsPlaying = function(handle)
			return handles[handle] ~= nil and clock < handles[handle]
		end,
	}
	local function nameOf(addon)
		return type(addon) == "number" and names[addon] or addon
	end
	local function set(addon, on)
		local name = nameOf(addon)
		if toc[name] and process.enabled[name] ~= on then
			process.enabled[name], rows[name] = on, true
		end
	end
	e.C_AddOns = {
		GetNumAddOns = function()
			return #names
		end,
		GetAddOnInfo = function(addon)
			return nameOf(addon)
		end,
		GetAddOnMetadata = function(addon, field)
			return toc[nameOf(addon)] and toc[nameOf(addon)][field]
		end,
		EnableAddOn = function(addon)
			set(addon, true)
		end,
		DisableAddOn = function(addon)
			set(addon, false)
		end,
		SaveAddOns = saveRows,
	}
	return e
end

local function startUI(isLogin, isReload)
	frames = {}
	env = api()
	env.FamiliarDB = copy(saved.FamiliarDB)
	local ns = {}
	for _, file in ipairs(toc.Familiar.files) do
		local chunk = assert(loadfile(ADDONS .. "Familiar/" .. file))
		setfenv(chunk, env)
		local ok, err = pcall(chunk, "Familiar", ns)
		if not ok then
			out("error", err)
		end
	end
	fire("ADDON_LOADED", "Familiar")
	fire("PLAYER_ENTERING_WORLD", isLogin, isReload)
end

local function endUI()
	saved.FamiliarDB = copy(env.FamiliarDB)
end

local function runFrame(ms)
	local elapsed = ms / 1000 - clock
	clock, frameNo = ms / 1000, frameNo + 1
	for _, frame in ipairs(frames) do
		local script = frame.scripts.OnUpdate
		if script then
			local ok, err = pcall(script, frame, elapsed)
			if not ok then
				out("error", err)
			end
		end
	end
end

-- Commands ---------------------------------------------------------------------------
math.randomseed(os.time())
startProcess()
loadRows()
startUI(true, false)

for line in io.lines() do
	local command, rest = line:match("^(%S+)%s*(.-)%s*$")
	if command == "frame" then
		runFrame(tonumber(rest))
	elseif command == "slash" then
		local slash, text = rest:match("^(/%S+)%s*(.-)$")
		for key, handler in pairs(env.SlashCmdList) do
			if env["SLASH_" .. key .. "1"] == slash then
				local ok, err = pcall(handler, text)
				if not ok then
					out("error", err)
				end
			end
		end
	elseif command == "reload" then
		endUI()
		startUI(false, true)
	elseif command == "login" then
		endUI()
		character = rest
		loadRows()
		startUI(true, false)
	elseif command == "restart" then
		endUI()
		wallStart = wallStart + 60
		startProcess()
		loadRows()
		startUI(true, false)
	elseif command == "list" then
		env.AddonList.shown = rest == "open"
	elseif command == "sound" then
		soundOn = rest == "on"
	elseif command == "drop" then
		drops = tonumber(rest)
	end
end
