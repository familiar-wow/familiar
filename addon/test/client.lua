-- A small stand-in for the WoW: Forever client, to run the real addon without the game. It
-- implements the calls the addon makes and the file behavior measured in FAM-15:
--   * AddOns.txt holds rows per character, the client one enabled state per process. Logging in
--     applies the character's rows; EnableAddOn and DisableAddOn give an addon a row only when
--     they change its state; SaveAddOns empties the logged-in character's file, then writes it.
--   * A font file loads once per process and is usable two frames after SetFont; until then a
--     font string measures with the font it had. Advances are rounded to whole pixels.
--   * PlaySoundFile reports even an empty file as played, C_Sound.IsPlaying tells for how long.
--     A file that played with sound stays cached for the process, a missing one stays missing.
--   * Widgets take any call; only what the tests read is modelled: text, shown, points, sizes,
--     focus, clicks and slider values. A few items, a spell and a quest stand in for the game's
--     data; one item and the quest load only once asked for, as uncached data does in the client.
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
--   stall <n> <ms>      the nth AddOns.txt write from now halts <ms> with the file emptied
--   focus               put the focus into the addon's input line
--   shiftclick <link>   shift-click something that has <link>, as the game's frames do
--   linkclick <button> <link>  click a link in the addon's history: LeftButton, RightButton or
--                       shift (a shift-click); reports "itemref <link>" or "questlog <id>"
--   enter <text>        type <text> into the addon's input line and press Enter
--   click <caption>     click the button with this caption
--   slide <caption> <n> drag the slider with this caption to <n> and let go
--   poke <addon>        something other than Familiar enables an addon, as an addon manager does
--   equip <slot> <id>   put an item into a slot for the active character and fire equipment changed
--   visit               open and close the bank, a merchant and a trainer
--   set <key> <value>   change what a stubbed game API answers (see `stub`)
--   fire <event> [arg]  fire a game event, with one optional argument
--   texts               report what the font strings show
-- Output: "chat <text>" for every line the addon prints, "window <text>" for every line added to
-- a message frame, "backfill <text>" for every line restored into one, "font <file> <height>
-- <flags>" whenever a message frame gets its font, "texts <a | b>" for the texts command,
-- "error <text>" for a Lua error, "tick" once a frame is done.

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
local stallIn, stallMs = 0, 0
local stalled = 0 -- seconds a stalled write added to the current frame
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
	if stallIn > 0 then
		stallIn = stallIn - 1
		if stallIn == 0 then
			-- Lua 5.1 cannot sleep; the file stays empty meanwhile.
			local stop = os.clock() + stallMs / 1000
			repeat
			until os.clock() >= stop
			stalled = stalled + stallMs / 1000
		end
	end
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

local function nothing() end
-- Any method a widget does not model does nothing; fields start lowercase and stay nil.
local function method(_, key)
	if type(key) == "string" and key:match("^%u") then
		return nothing
	end
end

local FontString = setmetatable({}, { __index = method })
FontString.__index = FontString

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

function FontString:GetText()
	return self.text
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
local Frame = setmetatable({}, { __index = method })
Frame.__index = Frame
local frames, editBoxes, strings = {}, {}, {}

local function newFrame(parent, kind)
	local frame = setmetatable({ parent = parent, kind = kind, events = {}, scripts = {}, shown = true, scale = 1 }, Frame)
	frames[#frames + 1] = frame
	if kind == "EditBox" then
		editBoxes[#editBoxes + 1] = frame
	end
	return frame
end

function Frame:SetPoint(point, ...)
	local relative, relativePoint, x, y = ...
	if type(relative) ~= "table" then
		relative, relativePoint, x, y = nil, point, ...
	end
	self.point = { point, relative, relativePoint, x, y }
end
function Frame:GetPoint()
	return unpack(self.point or {})
end
function Frame:SetSize(width, height)
	self.width, self.height = width, height
end
function Frame:SetWidth(width)
	self.width = width
end
function Frame:SetHeight(height)
	self.height = height
end
function Frame:GetWidth()
	return self.width
end
function Frame:GetHeight()
	return self.height
end
function Frame:GetScript(script)
	return self.scripts[script]
end
function Frame:HookScript(script, handler)
	local before = self.scripts[script] or nothing
	self.scripts[script] = function(...)
		before(...)
		handler(...)
	end
end
function Frame:SetShown(shown)
	if shown then
		self:Show()
	else
		self:Hide()
	end
end
function Frame:SetText(text)
	self.text = tostring(text or "")
end
local focused
function Frame:SetFocus()
	focused = self
end
function Frame:ClearFocus()
	if focused == self then
		focused = nil
	end
end
function Frame:HasFocus()
	return focused == self
end
function Frame:Insert(text)
	self.text = (self.text or "") .. text
end
function Frame:GetText()
	return self.text or ""
end
function Frame:AddMessage(text)
	out("window", text)
end
function Frame:BackFillMessage(text)
	out("backfill", text)
end
function Frame:RegisterEvent(event)
	self.events[event] = true
end
function Frame:SetScript(script, handler)
	self.scripts[script] = handler
end
function Frame:Show()
	if not self.shown and self.scripts.OnShow then
		self.scripts.OnShow(self)
	end
	self.shown = true
end
function Frame:Hide()
	if self.shown and self.scripts.OnHide then
		self.scripts.OnHide(self)
	end
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
	local fontString = setmetatable({ parent = self }, FontString)
	strings[#strings + 1] = fontString
	return fontString
end
function Frame:CreateTexture()
	return setmetatable({ parent = self, scripts = {}, shown = true }, Frame)
end
-- The font of the history shows what the settings did to the window.
function Frame:SetFont(path, size, flags)
	if self.kind == "ScrollingMessageFrame" then
		out("font", ("%s %d %s"):format(path, size, flags ~= "" and flags or "plain"))
	end
end
function Frame:SetValue(value)
	if self.value ~= value then
		self.value = value
		if self.scripts.OnValueChanged then
			self.scripts.OnValueChanged(self, value)
		end
	end
end
function Frame:GetValue()
	return self.value or 0
end
function Frame:IsVisible()
	return self.shown and (not self.parent or self.parent:IsVisible())
end

-- UI sessions ------------------------------------------------------------------------
local env

-- What a few game APIs answer, changed with "set <key> <value>"; it survives a reload.
-- Whether the click being simulated holds a modifier key, as IsModifiedClick reports.
local modifier = false

local stub = {
	defense = "100", -- UnitDefenseSkill
	merchantItem = "Water", -- the merchant's only offer
	token = "0", -- 1: the offer also costs 2 Badge of Justice
	trainerNames = "1", -- 0: service names have not loaded yet
	trainerType = "0", -- Enum.TrainerType; 3 is a pet trainer
	combat = "0", -- 1: the player is in combat (InCombatLockdown)
	questMapFails = "0", -- 1: opening the quest log raises an error
}

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
	-- Real time: it moves on while a write stalls, where GetTime keeps the frame's time.
	e.GetTimePreciseSec = function()
		return clock + stalled
	end
	e.GetSessionTime = function()
		return math.floor(clock - process.started)
	end
	e.GetBuildInfo = function()
		return "1.60.1", "70888", "Nov 1 2026", 16001
	end
	e.GetPhysicalScreenSize = function()
		return SCREEN_W, SCREEN_H
	end
	-- Who asks, for the header of a question.
	e.UnitName = function(unit)
		return unit == "npc" and "Test Vendor" or character
	end
	e.GetRealmName = function()
		return realm
	end
	e.UnitLevel = function()
		return 60
	end
	e.UnitRace = function()
		return "Orc", "Orc", 2
	end
	e.UnitClass = function()
		return "Warrior", "WARRIOR", 1
	end
	e.UnitFactionGroup = function()
		return "Horde", "Horde"
	end
	e.GetRealZoneText = function()
		return "Orgrimmar"
	end
	e.GetSubZoneText = function()
		return "Valley of Strength"
	end
	e.GetLocale = function()
		return "enUS"
	end
	e.UnitGUID = function()
		return "Player-1-" .. character
	end
	e.CreateFrame = function(kind, name, parent, template)
		local frame = newFrame(parent, kind)
		if name then
			e[name] = frame
		end
		return frame
	end
	e.UISpecialFrames = {}
	local fontObjects = { ChatFontNormal = "ARIALN", GameFontNormal = "FRIZQT__", QuestFont = "MORPHEUS" }
	for name, file in pairs(fontObjects) do
		e[name] = {
			GetFont = function()
				return "Fonts\\" .. file .. ".TTF", 14, ""
			end,
		}
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
	-- Game data: items, a spell, a quest, bags and talents, with tooltips.
	local function itemLink(id, quality, name, enchant)
		return ("|cnIQ%d:|Hitem:%d:%s:::::::60:::::|h[%s]|h|r"):format(quality, id, enchant or "", name)
	end
	local items = {
		[19019] = {
			link = itemLink(19019, 5, "Thunderfury, Blessed Blade of the Windseeker", "1900"),
			equip = "INVTYPE_WEAPON",
			ilvl = 80,
			quality = 5,
		},
		[13262] = {
			link = itemLink(13262, 5, "Ashbringer"),
			equip = "INVTYPE_2HWEAPON",
			ilvl = 88,
			quality = 5,
		},
		[2589] = { link = itemLink(2589, 1, "Linen Cloth"), equip = "", ilvl = 5, quality = 1, loads = true },
		[6948] = { link = itemLink(6948, 1, "Hearthstone"), equip = "", ilvl = 1, quality = 1 },
	}
	local worn = character == "Alt" and { [16] = 19019 } or { [16] = 13262 }
	local quests = {
		[783] = {
			link = "|cffffff00|Hquest:783:1|h[A Threat Within]|h|r",
			title = "A Threat Within",
			level = 1,
			category = "Elwynn Forest",
			loads = true,
		},
	}
	local tooltips = {
		["item:19019"] = { "Thunderfury, Blessed Blade of the Windseeker", "Binds when picked up", { "One-Hand", "Sword" } },
		["item:13262"] = { "Ashbringer", "Binds when picked up" },
	}
	local function itemID(info)
		return tonumber(info) or tonumber(tostring(info):match("item:(%d+)"))
	end
	e.C_Item = {
		DoesItemExistByID = function(id)
			return items[id] ~= nil
		end,
		GetItemInfo = function(info)
			local item = items[itemID(info)]
			if item and not item.loads then
				return item.link:match("%[(.-)%]"), item.link
			end
		end,
		GetItemInfoInstant = function(info)
			local id = itemID(info)
			return id, "Weapon", "Sword", items[id] and items[id].equip or ""
		end,
		GetDetailedItemLevelInfo = function(info)
			local item = items[itemID(info)]
			return item and item.ilvl or nil
		end,
		RequestLoadItemDataByID = function(id)
			if items[id] then
				items[id].loads = nil
			end
		end,
	}
	local spellNames = { [133] = "Fireball", [12294] = "Mortal Strike", [12320] = "Cruelty" }
	e.C_Spell = {
		DoesSpellExist = function(id)
			return spellNames[id] ~= nil
		end,
		IsSpellDataCached = function()
			return true
		end,
		RequestLoadSpellData = function() end,
		GetSpellLink = function(id)
			return id == 133 and "|cff71d5ff|Hspell:133:0|h[Fireball]|h|r" or nil
		end,
		GetSpellName = function(id)
			return spellNames[id]
		end,
	}
	e.GetQuestLink = function(id)
		local quest = quests[id]
		return quest and not quest.loads and quest.link or nil
	end
	e.C_QuestLog = {
		GetLogIndexForQuestID = function(id)
			return id == 783 and 2 or nil
		end,
		RequestLoadQuestByID = function(id)
			if quests[id] then
				quests[id].loads = nil
			end
		end,
		GetNumQuestLogEntries = function()
			return 2
		end,
		GetInfo = function(index)
			if index == 1 then
				return { isHeader = true, title = "Elwynn Forest" }
			elseif index == 2 then
				return { questID = 783, title = "A Threat Within", level = 1, isHeader = false, isHidden = false }
			end
		end,
		IsComplete = function()
			return false
		end,
		GetQuestWatchType = function(id)
			return id == 783 and 0 or nil
		end,
		GetQuestObjectives = function(id)
			if id == 783 then
				return { { text = "Speak with Marshal McBride: 0/1", finished = false } }
			end
			return {}
		end,
	}
	e.C_Map = {
		GetBestMapForUnit = function()
			return 1454
		end,
		GetPlayerMapPosition = function()
			return {
				GetXY = function()
					return 0.512, 0.624
				end,
			}
		end,
	}
	e.GetMoney = function()
		return 123456
	end
	e.C_Container = {
		GetContainerNumSlots = function(bag)
			return bag == 0 and 16 or bag == 22 and 4 or 0
		end,
		GetContainerNumFreeSlots = function(bag)
			return bag == 0 and 13 or bag == 22 and 4 or 0
		end,
		GetContainerItemInfo = function(bag, slot)
			if bag ~= 0 then
				return nil
			end
			if slot == 1 then
				return { itemID = 6948, stackCount = 1, quality = 1, itemName = "Hearthstone" }
			elseif slot == 2 then
				return { itemID = 2589, stackCount = 12, quality = 1, itemName = "Linen Cloth" }
			elseif slot == 3 then
				return { itemID = 2589, stackCount = 8, quality = 1, itemName = "Linen Cloth" }
			end
		end,
	}
	e.UnitHealthMax = function() return 1600 end
	e.UnitArmor = function() return 400, 421 end
	e.GetSpellCritChance = function(...) assert(select("#", ...) == 0); return 4.5 end
	e.Enum = { BankType = { Character = 0 }, SpellBookSpellBank = { Player = 0 }, SpellBookItemType = { Spell = 1, FutureSpell = 2 } }
	e.C_Bank = {FetchPurchasedBankTabData = function(kind) assert(kind == 0); return {{ ID = 22 }} end}
	e.C_SkillInfo = {GetNumSkillLines = function() return 2 end, GetSkillLineInfo = function(i)
		return i == 1 and {name="Professions", isHeader=true} or {name="Mining", skillID=186, rank=42, maxRank=75}
	end}
	e.C_Reputation = {GetNumFactions = function() return 1 end, GetFactionDataByIndex = function()
		return {name="Thunder Bluff", factionID=81, reaction=5, currentStanding=4750, currentReactionThreshold=3000, nextReactionThreshold=9000}
	end}
	e.C_SpellBook = {GetNumSpellBookSkillLines = function() return 1 end,
		GetSpellBookSkillLineInfo = function() return {name="Fire", itemIndexOffset=0, numSpellBookItems=2} end,
		GetSpellBookItemInfo = function(i) return i == 1 and {name="Fireball", spellID=133, itemType=1} or {name="Future", spellID=999, itemType=2} end}
	e.UnitDefenseSkill = function() return tonumber(stub.defense), 0 end
	e.GetMerchantNumItems = function() return 1 end
	e.C_MerchantFrame = {GetItemInfo = function()
		return {name=stub.merchantItem, price=stub.token == "1" and 0 or 25, hasExtendedCost=stub.token == "1"}
	end}
	e.GetMerchantItemCostInfo = function() return 1 end
	e.GetMerchantItemCostItem = function(i, j)
		assert(i == 1 and j == 1)
		return 133633, 2, "|cnIQ4:|Hitem:29434::::::::70:::::|h[Badge of Justice]|h|r", nil
	end
	e.GetNumTrainerServices = function() return 1 end
	e.GetTrainerServiceInfo = function()
		if stub.trainerNames == "0" then return nil end
		return "Charge", "available", nil, 4
	end
	e.GetTrainerServiceCost = function() return 100 end
	e.C_Trainer = {GetTrainerType = function() return tonumber(stub.trainerType) end}
	e.C_ClassTalents = {
		GetActiveConfigID = function()
			return 1
		end,
	}
	e.C_Traits = {
		GetConfigInfo = function(cid)
			return cid == 1 and { ID = 1, treeIDs = { 100 } } or nil
		end,
		GetTreeCurrencyInfo = function()
			return { { quantity = 2, spent = 6 } }
		end,
		GetGroupDisplayInfoByTreeID = function()
			return {
				{ groupID = 10, displayName = "Arms", orderIndex = 1 },
				{ groupID = 20, displayName = "Fury", orderIndex = 2 },
			}
		end,
		GetGroupCurrencyInfo = function()
			return {
				{ traitNodeGroupID = 10, currencyInfos = { { spent = 1 } } },
				{ traitNodeGroupID = 20, currencyInfos = { { spent = 5 } } },
			}
		end,
		GetTreeNodes = function()
			return { 1001, 1002, 1003 }
		end,
		GetNodeInfo = function(_, nodeId)
			if nodeId == 1001 then
				return { ranksPurchased = 1, maxRanks = 1, groupIDs = { 10 }, activeEntry = { entryID = 2001 } }
			elseif nodeId == 1002 then
				return { ranksPurchased = 5, maxRanks = 5, groupIDs = { 20 }, activeEntry = { entryID = 2002 } }
			elseif nodeId == 1003 then
				return { ranksPurchased = 0, maxRanks = 3, groupIDs = { 10 }, entryIDs = { 2003 } }
			end
		end,
		GetEntryInfo = function(_, entryId)
			return { definitionID = entryId + 1000 }
		end,
		GetDefinitionInfo = function(defId)
			if defId == 3001 then
				return { spellID = 12294 }
			elseif defId == 3002 then
				return { spellID = 12320 }
			end
			return {}
		end,
	}
	e.C_TooltipInfo = {
		GetHyperlink = function(hyperlink)
			local lines = tooltips[hyperlink:match("^%a+:%d+")]
			if not lines then
				return nil
			end
			local data = { lines = {} }
			for i, line in ipairs(lines) do
				local left, right = line, nil
				if type(line) == "table" then
					left, right = line[1], line[2]
				end
				data.lines[i] = { leftText = left, rightText = right }
			end
			return data
		end,
	}
	e.GetInventoryItemLink = function(_, slot)
		local id = worn[slot]
		return id and items[id] and items[id].link or nil
	end
	e.GetInventoryItemQuality = function(_, slot)
		local id = worn[slot]
		return id and items[id] and items[id].quality or nil
	end
	e.GetInventoryItemDurability = function(slot)
		if worn[slot] then
			return 95, 100
		end
	end
	e._equip = function(slot, id)
		worn[slot] = id
	end
	e.hooksecurefunc = function(target, name, hook)
		local original = target[name]
		target[name] = function(...)
			local result = original(...)
			hook(...)
			return result
		end
	end
	e.ChatFrameUtil = {
		InsertLink = function()
			return false
		end,
	}
	e.SetItemRef = function(link)
		out("itemref", link)
	end
	e.IsModifiedClick = function()
		return modifier
	end
	e.InCombatLockdown = function()
		return stub.combat == "1"
	end
	e.QuestMapFrame_OpenToQuestDetails = function(id)
		if stub.questMapFails == "1" then
			error("the quest map could not open")
		end
		out("questlog", tostring(id))
	end
	e.GameTooltip = newFrame(nil)
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
	frames, editBoxes, strings = {}, {}, {}
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
	clock, frameNo, stalled = ms / 1000, frameNo + 1, 0
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
		out("tick", "")
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
	elseif command == "focus" then
		editBoxes[#editBoxes]:SetFocus()
	elseif command == "linkclick" then
		local button, link = rest:match("^(%S+)%s+(.+)$")
		modifier = button == "shift"
		for _, frame in ipairs(frames) do
			if frame.scripts.OnHyperlinkClick then
				local ok, err = pcall(frame.scripts.OnHyperlinkClick, frame, link, link, modifier and "LeftButton" or button)
				if not ok then
					out("error", err)
				end
			end
		end
		modifier = false
	elseif command == "shiftclick" then
		env.ChatFrameUtil.InsertLink(rest)
	elseif command == "enter" then
		local box = editBoxes[#editBoxes]
		box:SetText(box.text and box.text ~= "" and box.text .. " " .. rest or rest)
		local ok, err = pcall(box.scripts.OnEnterPressed, box)
		if not ok then
			out("error", err)
		end
	elseif command == "click" or command == "slide" then
		-- A click on the button with this caption, or the slider with this caption set to a value.
		local caption, value = rest, nil
		if command == "slide" then
			caption, value = rest:match("^(.-)%s+(%S+)$")
		end
		for _, label in ipairs(strings) do
			if label.text == caption then
				local ok, err = true, nil
				if command == "click" and label.parent.scripts.OnClick then
					ok, err = pcall(label.parent.scripts.OnClick, label.parent, "LeftButton")
				end
				for _, frame in ipairs(command == "slide" and frames or {}) do
					if frame.kind == "Slider" and frame.parent == label.parent then
						ok, err = pcall(function()
							frame:SetValue(tonumber(value))
							frame.scripts.OnMouseUp(frame, "LeftButton")
						end)
					end
				end
				if not ok then
					out("error", err)
				end
			end
		end
	elseif command == "poke" then
		env.C_AddOns.EnableAddOn(rest)
	elseif command == "set" then
		local key, value = rest:match("^(%S+)%s+(.-)$")
		assert(stub[key], "unknown stub " .. tostring(key))
		stub[key] = value
	elseif command == "fire" then
		local event, arg = rest:match("^(%S+)%s*(.-)$")
		fire(event, arg ~= "" and arg or nil)
	elseif command == "visit" then
		for _, event in ipairs({"BANKFRAME_OPENED", "BANKFRAME_CLOSED", "MERCHANT_SHOW", "MERCHANT_CLOSED", "TRAINER_SHOW", "TRAINER_CLOSED"}) do fire(event) end
	elseif command == "equip" then
		local slot, id = rest:match("^(%d+)%s+(%d+)$")
		env._equip(tonumber(slot), tonumber(id))
		fire("PLAYER_EQUIPMENT_CHANGED", tonumber(slot), true)
	elseif command == "texts" then
		local shown = {}
		for _, fontString in ipairs(strings) do
			if (fontString.text or "") ~= "" then
				shown[#shown + 1] = fontString.text:gsub("%c", "?")
			end
		end
		out("texts", table.concat(shown, " | "))
	elseif command == "stall" then
		local n, ms = rest:match("^(%d+)%s+(%d+)$")
		stallIn, stallMs = tonumber(n), tonumber(ms)
	end
end
