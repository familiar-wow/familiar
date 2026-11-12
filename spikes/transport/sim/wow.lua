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
--   login <character>            log out, then log in another character in the same process
--   screenshot                   the player presses Print Screen
-- Chat output is written as lines starting with "chat ". A screenshot is rendered as an
-- uncompressed TGA and announced as "shot <tga> <final path> <format>"; the runner encodes it
-- the way the client would.
--
-- Fonts are read from the real files, once per process like the real client, and are usable
-- two frames after SetFont. The screen is 1280 x 720 with a UI scale of 0.9.
--
-- AddOns.txt behaves as measured on build 70888 (FAM-15): a character's file holds rows only
-- for the addons set for that character, and the client keeps one enable state for the whole
-- process. Logging in and ResetAddOns apply the character's rows; an addon without a row keeps
-- whatever state the previous character left in memory. EnableAddOn and DisableAddOn give an
-- addon a row only when they change its state.
--
-- usage: lua wow.lua <client folder> <account> <realm> <character> <names file> [flags]
-- flags, comma-separated:
--   noreset     C_AddOns.ResetAddOns keeps the in-memory state instead of re-reading disk
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
local SAVED = ACCOUNT .. "SavedVariables/"
local MAIN = "FamiliarSpike"

local function guidOf(name)
	local hash = 0
	for i = 1, #name do
		hash = (hash * 31 + name:byte(i)) % 4294967296
	end
	return string.format("Player-4711-%08X", hash)
end

local GUID = guidOf(character)

math.randomseed(os.time())

-- Client state that survives /reload and character switches -------------------
local known, order, toc, indexOf = {}, {}, {}, {}
local enabled, default = {}, {}
local rows = {} -- addons with a row in the logged-in character's AddOns.txt
local sounds = {} -- length in ms of every file that played, cached per process like the real client
local absent = {} -- emptyplays: a file that was missing stays missing
local playing = {} -- sound handle -> end time in ms
local wallMs, preciseMs, lastPreciseMs = os.time() * 1000, 0, nil
local processStart = wallMs
local listShown, inCombat = false, false
local soundHandle = 0
local fonts = {} -- parsed font files, read once per process
local cvars = { screenshotFormat = "jpeg", screenshotQuality = "3" }
local frameCount, shotRequested, shotPending = 0, false, false
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
	enabled[name] = default[name]
end
table.sort(order)
for index, name in ipairs(order) do
	indexOf[name] = index
end

local function addonsTxt()
	return ACCOUNT .. realm .. "/" .. character .. "/AddOns.txt"
end

-- Applies the logged-in character's rows. Addons without a row keep their state in memory.
local function loadAddonsTxt()
	rows = {}
	for line in (readFile(addonsTxt()) or ""):gmatch("[^\r\n]+") do
		local name, state = line:match("^(.-):%s*(%a+)%s*$")
		if name and known[name] then
			enabled[name] = state == "enabled"
			rows[name] = true
		end
	end
end

local function saveAddonsTxt()
	local lines = {}
	for _, name in ipairs(order) do
		if rows[name] then
			lines[#lines + 1] = name .. ": " .. (enabled[name] and "enabled" or "disabled")
		end
	end
	writeFile(addonsTxt(), table.concat(lines, "\n") .. "\n")
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

-- Fonts -------------------------------------------------------------------------
local function u16(data, at)
	return data:byte(at + 1) * 256 + data:byte(at + 2)
end

-- Advance widths and a format 4 cmap with idDelta mappings: what the spike's fonts use.
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
	local cmap = tables.cmap
	local sub = cmap + u16(data, cmap + 8) * 65536 + u16(data, cmap + 10)
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

local function glyphWidth(font, code)
	for _, s in ipairs(font.segments) do
		if code >= s.first and code <= s.last then
			return font.advance[(code + s.delta) % 65536] or 0
		end
	end
	return font.advance[0]
end

local fontMethods = {}
fontMethods.__index = fontMethods
for _, name in ipairs({ "SetPoint", "SetAlpha", "SetWordWrap", "SetNonSpaceWrap" }) do
	fontMethods[name] = function() end
end
function fontMethods:SetFontObject(object)
	self.path, self.size, self.font = object.path, object.size, nil
end
function fontMethods:SetFont(path, size, flags)
	local file = client .. "/" .. path:gsub("\\", "/")
	if not fonts[file] then
		local data = readFile(file)
		if not data then
			return false
		end
		fonts[file] = parseFont(data)
		fonts[file].ready = frameCount + 2
	end
	self.path, self.size, self.flags, self.font = path, size, flags, fonts[file]
	return true
end
function fontMethods:GetFont()
	return self.path, self.size, self.flags
end
function fontMethods:SetText(text)
	self.text = tostring(text or "")
end
function fontMethods:GetStringWidth()
	local list, font = codes(self.text or ""), self.font
	if not font or frameCount < font.ready then
		return #list * self.size * 0.55 -- the standard font
	end
	local width = 0
	for _, code in ipairs(list) do
		width = width + glyphWidth(font, code) * self.size / font.upem
	end
	return width
end

-- Frames and textures -------------------------------------------------------------
local textureMethods = {}
textureMethods.__index = textureMethods
for _, name in ipairs({ "SetSnapToPixelGrid", "SetTexelSnappingBias" }) do
	textureMethods[name] = function() end
end
function textureMethods:SetPoint(_, _, _, x, y)
	self.x, self.y = x or 0, y or 0
end
function textureMethods:SetSize(w, h)
	self.w, self.h = w, h
end
function textureMethods:SetColorTexture(r, g, b)
	local function byte(v)
		return math.floor(v * 255 + 0.5)
	end
	self.pixel = string.char(byte(b), byte(g), byte(r))
end

local frameMethods = {}
frameMethods.__index = frameMethods
for _, name in ipairs({ "SetFrameStrata", "SetAlpha" }) do
	frameMethods[name] = function() end
end
function frameMethods:RegisterEvent(event)
	self.events[event] = true
end
function frameMethods:UnregisterEvent(event)
	self.events[event] = nil
end
function frameMethods:SetScript(script, handler)
	self.scripts[script] = handler
end
function frameMethods:Show()
	self.shown = true
end
function frameMethods:Hide()
	self.shown = false
end
function frameMethods:SetIgnoreParentScale(on)
	self.ignoreParentScale = on
end
function frameMethods:SetScale(scale)
	self.scale = scale
end
function frameMethods:GetEffectiveScale()
	local parent = self.parent and not self.ignoreParentScale and self.parent:GetEffectiveScale() or 1
	return parent * self.scale
end
-- Only TOPLEFT to the parent's TOPLEFT, which is all the spike uses.
function frameMethods:SetPoint(_, _, _, x, y)
	self.x, self.y = x or 0, y or 0
end
function frameMethods:SetSize(w, h)
	self.w, self.h = w, h
end
function frameMethods:CreateTexture()
	local texture = setmetatable({ x = 0, y = 0, w = 0, h = 0 }, textureMethods)
	self.textures[#self.textures + 1] = texture
	return texture
end
function frameMethods:CreateFontString()
	return setmetatable({ size = 12, text = "" }, fontMethods)
end

local function newFrame(parent, scale)
	return setmetatable({
		events = {},
		scripts = {},
		textures = {},
		parent = parent,
		scale = scale or 1,
		shown = true,
		x = 0,
		y = 0,
	}, frameMethods)
end

-- Screenshots ---------------------------------------------------------------------
local BACKGROUND = string.char(60, 120, 90)

-- Renders the shown textures; the block is a grid, so rows come in bands.
local function render()
	local bands, keys = {}, {}
	for _, frame in ipairs(frames) do
		if frame.shown and #frame.textures > 0 then
			local k = frame:GetEffectiveScale() * SCREEN_H / 768
			for _, t in ipairs(frame.textures) do
				if t.pixel then
					local x1 = math.floor((frame.x + t.x) * k + 0.5)
					local x2 = math.floor((frame.x + t.x + t.w) * k + 0.5)
					local y1 = math.floor(-(frame.y + t.y) * k + 0.5)
					local y2 = math.floor((t.h - frame.y - t.y) * k + 0.5)
					local key = y1 * 65536 + y2
					if not bands[key] then
						bands[key], keys[#keys + 1] = { y1 = y1, y2 = y2 }, key
					end
					local band = bands[key]
					band[#band + 1] = { x1, x2, t.pixel }
				end
			end
		end
	end
	local rowAt = {}
	for _, key in ipairs(keys) do
		local band = bands[key]
		table.sort(band, function(a, b)
			return a[1] < b[1]
		end)
		local parts, x = {}, 0
		for _, r in ipairs(band) do
			local x1, x2 = math.max(r[1], x), math.min(r[2], SCREEN_W)
			if x1 > x then
				parts[#parts + 1] = BACKGROUND:rep(x1 - x)
			end
			if x2 > x1 then
				parts[#parts + 1] = r[3]:rep(x2 - x1)
				x = x2
			end
		end
		parts[#parts + 1] = BACKGROUND:rep(SCREEN_W - x)
		local row = table.concat(parts)
		for y = math.max(0, band.y1), math.min(band.y2, SCREEN_H) - 1 do
			rowAt[y] = row
		end
	end
	local plain = BACKGROUND:rep(SCREEN_W)
	local out = {
		string.char(0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0),
		string.char(SCREEN_W % 256, math.floor(SCREEN_W / 256), SCREEN_H % 256, math.floor(SCREEN_H / 256), 24, 0x20),
	}
	for y = 0, SCREEN_H - 1 do
		out[#out + 1] = rowAt[y] or plain
	end
	return table.concat(out)
end

local EXTENSIONS = { jpeg = "jpg", png = "png", tga = "tga" }

local function takeScreenshot()
	local format = cvars.screenshotFormat
	local name = "WoWScrnShot_" .. os.date("%m%d%y_%H%M%S", math.floor(wallMs / 1000))
	local tga = client .. "/.shot-" .. name .. ".tga"
	writeFile(tga, render())
	io.write("shot ", tga, " ", client, "/Screenshots/", name, ".", EXTENSIONS[format] or "jpg", " ", format, "\n")
end

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
	env.UIParent = newFrame(nil, UI_SCALE)
	env.CreateFrame = function(_, _, parent)
		local frame = newFrame(parent or env.UIParent)
		frames[#frames + 1] = frame
		return frame
	end
	env.GameFontNormal = { path = "Fonts\\FRIZQT__.TTF", size = 12 }
	env.GetPhysicalScreenSize = function()
		return SCREEN_W, SCREEN_H
	end
	env.GetSessionTime = function()
		return math.floor((wallMs - processStart) / 1000)
	end
	env.C_CVar = {
		GetCVar = function(name)
			return cvars[name]
		end,
		SetCVar = function(name, value)
			cvars[name] = tostring(value)
			return true
		end,
	}
	env.Screenshot = function()
		shotRequested = true
	end
	-- Blizzard's "Screen captured" message.
	env.ActionStatus = env.CreateFrame("Frame")
	for _, event in ipairs({ "SCREENSHOT_STARTED", "SCREENSHOT_SUCCEEDED", "SCREENSHOT_FAILED" }) do
		env.ActionStatus:RegisterEvent(event)
	end
	-- The client takes an addon's name or its index, like the real API (uiAddon).
	local function addon(nameOrIndex)
		if type(nameOrIndex) == "number" then
			return order[nameOrIndex]
		end
		assert(type(nameOrIndex) == "string", "addon must be a name or an index")
		return known[nameOrIndex] and nameOrIndex or nil
	end
	local function player(who)
		assert(who == GUID, "character must be the player GUID")
	end
	local function setEnabled(nameOrIndex, who, value)
		player(who)
		local name = addon(nameOrIndex)
		if name and enabled[name] ~= value then
			enabled[name] = value
			rows[name] = true
		end
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
			player(who)
			return enabled[addon(nameOrIndex) or ""] and 2 or 0
		end,
		EnableAddOn = function(nameOrIndex, who)
			setEnabled(nameOrIndex, who, true)
		end,
		DisableAddOn = function(nameOrIndex, who)
			setEnabled(nameOrIndex, who, false)
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
		frameCount = frameCount + 1
		-- The picture of the previous frame is on disk now.
		if shotPending then
			shotPending = false
			fire("SCREENSHOT_SUCCEEDED")
		end
		for _, frame in ipairs(frames) do
			local handler = frame.scripts.OnUpdate
			if handler then
				handler(frame, elapsed)
			end
		end
		-- The client captures the frame it has just drawn.
		if shotRequested then
			shotRequested, shotPending = false, true
			fire("SCREENSHOT_STARTED")
			takeScreenshot()
		end
	end,
	screenshot = function()
		shotRequested = true
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
	login = function(name)
		assert(name, "login needs a character")
		logout()
		character, GUID = name, guidOf(name)
		loadAddonsTxt()
		login(false)
	end,
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
