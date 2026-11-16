-- Links between the player, the window and the brain.
--   in:  a shift-click inserts a link into the window's input line, as into the chat. The brain
--        gets each link as [kind:id name] with the text of its tooltip, and for an item the
--        items the character wears in its slots.
--   out: the brain writes [item:id], [spell:id] or [quest:id]. The client checks the ID and
--        makes the link (AGENTS.md, rule 3); what it does not know stays text.
local _, ns = ...
local Tasks = ns.Tasks

local format, concat = string.format, table.concat

local Links = {}
ns.Links = Links

local MAX_LINKS = 4 -- links per question that bring their tooltip along
local MAX_LINES = 20 -- tooltip lines per link
local MAX_EXTRA = 1800 -- bytes of tooltips per question: the lane carries about 0.9 KB/s
local WAIT = 2 -- seconds the client may take to load what the brain links

-- The equipment slots of each item type.
local SLOTS = {
	INVTYPE_HEAD = { 1 },
	INVTYPE_NECK = { 2 },
	INVTYPE_SHOULDER = { 3 },
	INVTYPE_BODY = { 4 },
	INVTYPE_CHEST = { 5 },
	INVTYPE_ROBE = { 5 },
	INVTYPE_WAIST = { 6 },
	INVTYPE_LEGS = { 7 },
	INVTYPE_FEET = { 8 },
	INVTYPE_WRIST = { 9 },
	INVTYPE_HAND = { 10 },
	INVTYPE_FINGER = { 11, 12 },
	INVTYPE_TRINKET = { 13, 14 },
	INVTYPE_CLOAK = { 15 },
	INVTYPE_WEAPON = { 16, 17 },
	INVTYPE_2HWEAPON = { 16, 17 },
	INVTYPE_WEAPONMAINHAND = { 16 },
	INVTYPE_WEAPONOFFHAND = { 17 },
	INVTYPE_SHIELD = { 17 },
	INVTYPE_HOLDABLE = { 17 },
	INVTYPE_RANGED = { 18 },
	INVTYPE_RANGEDRIGHT = { 18 },
	INVTYPE_THROWN = { 18 },
	INVTYPE_RELIC = { 18 },
	INVTYPE_TABARD = { 19 },
}

-- A link as the client writes it: an optional color, |H<kind>:<data>|h<name>|h, and |r.
local FULL = "|c[^|]*|H[^|]*|h.-|h|r"
local BARE = "|H(%a+):([^|]*)|h(.-)|h"

-- A | starts an escape sequence such as a link: || shows the character itself.
function Links.Plain(text)
	return (text:gsub("\r", ""):gsub("|", "||"))
end

-- Text without escape sequences: colors, textures, atlases.
local function clean(text)
	text = text:gsub("|[TA].-|[ta]", ""):gsub("|cn[^:|]*:", ""):gsub("|c%x%x%x%x%x%x%x%x", "")
	return (text:gsub("|[rn]", " "):gsub("|", ""):gsub("%s+", " "):match("^%s*(.-)%s*$"))
end

local function name(text)
	return (clean(text):gsub("^%[(.*)%]$", "%1"))
end

-- The tooltip of a link as lines of text, without the first, which is its name.
local function tooltip(hyperlink)
	local ok, data = pcall(C_TooltipInfo.GetHyperlink, hyperlink)
	local lines = {}
	if not ok or type(data) ~= "table" or type(data.lines) ~= "table" then
		return lines
	end
	for i = 2, #data.lines do
		-- In combat some text may be secret; such a line is skipped.
		local fine, line = pcall(function(l)
			local left, right = clean(l.leftText or ""), clean(l.rightText or "")
			return right ~= "" and left .. "  " .. right or left
		end, data.lines[i])
		if fine and line ~= "" then
			lines[#lines + 1] = line
			if #lines == MAX_LINES then
				break
			end
		end
	end
	return lines
end

-- The links in what the player typed. Returns the question for the brain: each link as
-- [kind:id name], then the tooltips.
function Links.Describe(text)
	local described, seen, extra, size = {}, {}, {}, 0
	local function add(label, hyperlink)
		if seen[hyperlink] or size >= MAX_EXTRA then
			return
		end
		seen[hyperlink] = true
		local block = { label }
		for _, line in ipairs(tooltip(hyperlink)) do
			block[#block + 1] = "  " .. line
		end
		local piece = concat(block, "\n")
		if size + #piece > MAX_EXTRA then
			piece = label .. "\n  (tooltip left out: too long)"
		end
		extra[#extra + 1] = piece
		size = size + #piece
	end
	text = text:gsub("|c[^|]*(|H[^|]*|h.-|h)|r", "%1")
	text = text:gsub(BARE, function(kind, data, shown)
		-- Most links start with an ID; a profession's starts with the character's GUID instead.
		local id = data:match("^(%d+)")
		local label = format("[%s%s %s]", kind, id and ":" .. id or "", name(shown))
		if #described < MAX_LINKS then
			described[#described + 1] = { kind = kind, data = data, label = label }
		end
		return label
	end)
	for _, link in ipairs(described) do
		local hyperlink = link.kind .. ":" .. link.data
		add(link.label, hyperlink)
		if link.kind == "item" then
			local ok, _, _, _, equip = pcall(C_Item.GetItemInfoInstant, hyperlink)
			for _, slot in ipairs(ok and SLOTS[equip] or {}) do
				local worn = GetInventoryItemLink("player", slot)
				local data, shown = (worn or ""):match("|Hitem:([^|]*)|h(.-)|h")
				if data and not seen["item:" .. data] then
					add(format("Worn: [item:%s %s]", data:match("^%d+"), name(shown)), "item:" .. data)
				end
			end
		end
	end
	if #extra == 0 then
		return text
	end
	return text .. "\n\nLinked by the player (game data):\n" .. concat(extra, "\n")
end

-- What the player typed, as the window shows it: the links work, everything else is text.
function Links.Show(text)
	local out, at = {}, 1
	while true do
		local first, last = text:find(FULL, at)
		if not first then
			break
		end
		out[#out + 1] = Links.Plain(text:sub(at, first - 1))
		out[#out + 1] = text:sub(first, last)
		at = last + 1
	end
	out[#out + 1] = Links.Plain(text:sub(at))
	return concat(out)
end

-- The client's link for an ID the brain wrote. Returns the link, or nil and whether the client
-- may still be loading it.
local function resolve(kind, id)
	if kind == "item" then
		if not C_Item.DoesItemExistByID(id) then
			return nil, false
		end
		local _, link = C_Item.GetItemInfo(id)
		if link then
			return link
		end
		C_Item.RequestLoadItemDataByID(id)
		return nil, true
	elseif kind == "spell" then
		if not C_Spell.DoesSpellExist(id) then
			return nil, false
		end
		if not C_Spell.IsSpellDataCached(id) then
			C_Spell.RequestLoadSpellData(id)
			return nil, true
		end
		return C_Spell.GetSpellLink(id), false
	elseif kind == "quest" then
		local link = GetQuestLink(id)
		if link then
			return link
		end
		C_QuestLog.RequestLoadQuestByID(id)
		return nil, true
	end
	return nil, false
end

local MARKUP = "%[(%a+):(%d+)[^%]]*%]"

-- Turns the brain's [kind:id] into links in `text`, which Links.Plain escaped, and calls
-- done(text) once the client knows them all or WAIT has passed.
function Links.Render(text, done)
	if not text:find(MARKUP) then
		return done(text)
	end
	Tasks.Spawn("links", function()
		local links, waited = {}, 0
		while true do
			local loading = false
			for kind, id in text:gmatch(MARKUP) do
				local key = kind .. ":" .. id
				if links[key] == nil then
					local ok, link, more = pcall(resolve, kind, tonumber(id))
					if ok and link then
						links[key] = link
					elseif ok and more then
						loading = true
					else
						links[key] = false
					end
				end
			end
			if not loading or waited >= WAIT then
				break
			end
			Tasks.Sleep(0.1)
			waited = waited + 0.1
		end
		done((text:gsub(MARKUP, function(kind, id)
			return links[kind .. ":" .. id] or nil
		end)))
	end)
end
