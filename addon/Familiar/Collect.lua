-- Game-state collectors (FAM-3, FAM-46): read on demand when the app asks for a slice
-- ("fetch\n<id>\n<slice>"), and send compact TSV back ("state\n<id>\n<slice>\n<rev>\n...").
-- Between fetches the addon only bumps integer revision counters on WoW events, so nothing
-- travels over the lane until the player's agent actually calls a tool (ADR 0001, ADR 0007).
local _, ns = ...
local Transport = ns.Transport
local Tasks = ns.Tasks

local format, concat, sort = string.format, table.concat, table.sort

local Collect = {}
ns.Collect = Collect

-- Cap any single state reply so an unusually large bag or quest log never stalls the 0.9 KB/s lane.
local MAX_STATE = 8192

-- Revision counters per slice. Every question's header sends them so the app can serve unchanged
-- slices straight from its cache without a round trip. Last-seen slices (bank, merchant, trainer)
-- start at 0 until the player opens the window.
local revs = {
	eq = 1,
	bags = 1,
	quests = 1,
	talents = 1,
	stats = 1,
	prof = 1,
	rep = 1,
	spells = 1,
	bank = 0,
	merchant = 0,
	trainer = 0,
}

local REV_ORDER = {
	"eq",
	"bags",
	"quests",
	"talents",
	"stats",
	"prof",
	"rep",
	"spells",
	"bank",
	"merchant",
	"trainer",
}

-- Cached last-seen payloads captured while the player has the bank, a merchant or a trainer open.
local seen = {}
local bankOpen, trainerOpen = false, false

local function nowStamp()
	if type(date) == "function" then
		local ok, stamp = pcall(date, "%Y-%m-%d %H:%M")
		if ok and stamp then
			return stamp
		end
	end
	return ""
end

local SLOTS = {
	{ 1, "head" },
	{ 2, "neck" },
	{ 3, "shoulder" },
	{ 4, "shirt" },
	{ 5, "chest" },
	{ 6, "waist" },
	{ 7, "legs" },
	{ 8, "feet" },
	{ 9, "wrist" },
	{ 10, "hands" },
	{ 11, "finger1" },
	{ 12, "finger2" },
	{ 13, "trinket1" },
	{ 14, "trinket2" },
	{ 15, "back" },
	{ 16, "mainHand" },
	{ 17, "offHand" },
	{ 18, "ranged" },
	{ 19, "tabard" },
	{ 0, "ammo" },
}

-- Strips control characters, tabs and color escapes so every field stays on one TSV cell.
local function clean(text)
	if not text then
		return ""
	end
	local s = tostring(text)
	s = s:gsub("|[TA].-|[ta]", ""):gsub("|cn[^:|]*:", ""):gsub("|c%x%x%x%x%x%x%x%x", "")
	s = s:gsub("|[rn]", " "):gsub("|", ""):gsub("[\t\r\n]+", " ")
	return (s:gsub("%s+", " "):match("^%s*(.-)%s*$"))
end

-- Appends TSV lines up to MAX_STATE bytes; marks truncation if anything had to be left out.
local function pack(lines)
	local out, size = {}, 0
	for i = 1, #lines do
		local line = lines[i]
		local need = #line + (i > 1 and 1 or 0)
		if size + need + 10 > MAX_STATE then
			out[#out + 1] = "truncated"
			break
		end
		out[#out + 1] = line
		size = size + need
	end
	return concat(out, "\n")
end

-- Compact revision string for the question header.
function Collect.Revs()
	local parts = {}
	for i = 1, #REV_ORDER do
		local k = REV_ORDER[i]
		parts[i] = format("%s=%d", k, revs[k] or 0)
	end
	return concat(parts, " ")
end

-- Current UI map ID and percentage coordinates (0-100), or nil in instances/loading screens.
function Collect.Location()
	if not (C_Map and C_Map.GetBestMapForUnit) then
		return nil
	end
	local ok, map = pcall(C_Map.GetBestMapForUnit, "player")
	if not ok or not map then
		return nil
	end
	local x, y
	if C_Map.GetPlayerMapPosition then
		local pok, pos = pcall(C_Map.GetPlayerMapPosition, map, "player")
		if pok and pos and pos.GetXY then
			local px, py = pos:GetXY()
			if px and py and (px > 0 or py > 0) then
				x, y = px * 100, py * 100
			end
		end
	end
	return map, x, y
end

-- Player money in copper, or nil if unavailable.
function Collect.Money()
	if not GetMoney then
		return nil
	end
	local ok, copper = pcall(GetMoney)
	return ok and copper or nil
end

-- Collectors -----------------------------------------------------------------------------

local function collectEquipment()
	local lines = {}
	for _, entry in ipairs(SLOTS) do
		local slot, key = entry[1], entry[2]
		local ok, link = pcall(GetInventoryItemLink, "player", slot)
		if ok and link then
			local itemId, ench, g1, g2, g3, g4 =
				link:match("|Hitem:(%d+):(%d*):(%d*):(%d*):(%d*):(%d*)")
			if itemId then
				local name = clean(link:match("%[(.-)%]") or "")
				local ilvl = ""
				if C_Item and C_Item.GetDetailedItemLevelInfo then
					local iok, lvl = pcall(C_Item.GetDetailedItemLevelInfo, link)
					if iok and lvl then
						ilvl = tostring(lvl)
					end
				end
				local quality = ""
				if GetInventoryItemQuality then
					local qok, q = pcall(GetInventoryItemQuality, "player", slot)
					if qok and q then
						quality = tostring(q)
					end
				end
				local enchant = (ench and ench ~= "" and ench ~= "0") and ench or ""
				local gems = {}
				for _, g in ipairs({ g1, g2, g3, g4 }) do
					if g and g ~= "" and g ~= "0" then
						gems[#gems + 1] = g
					end
				end
				local dur = ""
				if GetInventoryItemDurability then
					local dok, cur, max = pcall(GetInventoryItemDurability, slot)
					if dok and cur and max and max > 0 then
						dur = format("%d/%d", cur, max)
					end
				end
				lines[#lines + 1] = concat({
					key,
					itemId,
					ilvl,
					quality,
					enchant,
					concat(gems, ","),
					dur,
					name,
				}, "\t")
			end
		end
	end
	return pack(lines)
end

local function collectBags()
	local total, free = 0, 0
	local byId, ids = {}, {}
	if C_Container and C_Container.GetContainerNumSlots then
		for bag = 0, 5 do
			local ok, slots = pcall(C_Container.GetContainerNumSlots, bag)
			if ok and slots and slots > 0 then
				total = total + slots
				if C_Container.GetContainerNumFreeSlots then
					local fok, f = pcall(C_Container.GetContainerNumFreeSlots, bag)
					if fok and f then
						free = free + f
					end
				end
				for slot = 1, slots do
					local iok, info = pcall(C_Container.GetContainerItemInfo, bag, slot)
					if iok and info and info.itemID then
						local id = info.itemID
						local count = info.stackCount or 1
						local rec = byId[id]
						if rec then
							rec.count = rec.count + count
						else
							local itemName = info.itemName
							if (not itemName or itemName == "") and info.hyperlink then
								itemName = info.hyperlink:match("%[(.-)%]")
							end
							byId[id] = {
								id = id,
								count = count,
								quality = info.quality,
								name = clean(itemName or ""),
							}
							ids[#ids + 1] = id
						end
					end
				end
			end
		end
	end
	sort(ids)
	local money = Collect.Money() or 0
	local lines = { format("meta\t%d\t%d\t%d", free, total, money) }
	for _, id in ipairs(ids) do
		local rec = byId[id]
		lines[#lines + 1] = concat({
			"item",
			tostring(rec.id),
			tostring(rec.count),
			rec.quality and tostring(rec.quality) or "",
			rec.name,
		}, "\t")
	end
	return pack(lines)
end

local function mapName(mapID)
	if C_Map and C_Map.GetMapInfo then
		local ok, info = pcall(C_Map.GetMapInfo, mapID)
		if ok and type(info) == "table" and info.name then
			return clean(info.name)
		end
	end
	return ""
end

local function percent(v)
	return format("%.1f", (tonumber(v) or 0) * 100)
end

-- The quests the world map marks on the player's map and on its parent zone (FAM-61).
local function questAreas()
	local areas = {}
	if not (C_Map and C_Map.GetBestMapForUnit and C_QuestLog.GetQuestsOnMap) then
		return areas
	end
	local ok, map = pcall(C_Map.GetBestMapForUnit, "player")
	if not ok or not map then
		return areas
	end
	local maps = { map }
	if C_Map.GetMapInfo then
		local iok, info = pcall(C_Map.GetMapInfo, map)
		if iok and type(info) == "table" and (info.parentMapID or 0) > 0 then
			maps[2] = info.parentMapID
		end
	end
	for _, m in ipairs(maps) do
		local qok, list = pcall(C_QuestLog.GetQuestsOnMap, m)
		if qok and type(list) == "table" then
			for _, poi in ipairs(list) do
				if type(poi) == "table" and poi.questID and poi.x and poi.y and not areas[poi.questID] then
					areas[poi.questID] = { map = poi.mapID or m, x = poi.x, y = poi.y }
				end
			end
		end
	end
	return areas
end

-- Where a quest leads, as the world map shows it: its next waypoint, else its area on the map.
-- Coordinates are in percent of the map, as players and guides write them.
local function questLocation(id, areas)
	if C_QuestLog.GetNextWaypoint then
		local ok, map, x, y = pcall(C_QuestLog.GetNextWaypoint, id)
		if ok and map and x and y and (x > 0 or y > 0) then
			local text = ""
			if C_QuestLog.GetNextWaypointText then
				local tok, t = pcall(C_QuestLog.GetNextWaypointText, id)
				if tok and t then
					text = clean(t)
				end
			end
			return concat({ "w", "waypoint", tostring(map), mapName(map), percent(x), percent(y), text }, "\t")
		end
	end
	local area = areas[id]
	if area then
		return concat({ "w", "map", tostring(area.map), mapName(area.map), percent(area.x), percent(area.y), "" }, "\t")
	end
end

local function collectQuests()
	local lines = {}
	if not (C_QuestLog and C_QuestLog.GetNumQuestLogEntries and C_QuestLog.GetInfo) then
		return ""
	end
	local ok, count = pcall(C_QuestLog.GetNumQuestLogEntries)
	if not ok or not count then
		return ""
	end
	local areas = questAreas()
	local category = ""
	for i = 1, count do
		local iok, info = pcall(C_QuestLog.GetInfo, i)
		if iok and info then
			if info.isHeader then
				category = clean(info.title or "")
			elseif not info.isHidden and info.questID and info.questID > 0 then
				local id = info.questID
				local complete = 0
				if C_QuestLog.IsComplete then
					local cok, done = pcall(C_QuestLog.IsComplete, id)
					if cok and done then
						complete = 1
					end
				end
				local watched = 0
				if C_QuestLog.GetQuestWatchType then
					local wok, wt = pcall(C_QuestLog.GetQuestWatchType, id)
					if wok and wt ~= nil then
						watched = 1
					end
				end
				lines[#lines + 1] = concat({
					"q",
					tostring(id),
					tostring(info.level or 0),
					tostring(complete),
					tostring(watched),
					category,
					clean(info.title or ""),
				}, "\t")
				local where = questLocation(id, areas)
				if where then
					lines[#lines + 1] = where
				end
				if C_QuestLog.GetQuestObjectives then
					local ook, objs = pcall(C_QuestLog.GetQuestObjectives, id)
					if ook and type(objs) == "table" then
						for _, obj in ipairs(objs) do
							if obj and obj.text and obj.text ~= "" then
								lines[#lines + 1] = format("o\t%d\t%s", obj.finished and 1 or 0, clean(obj.text))
							end
						end
					end
				end
			end
		end
	end
	return pack(lines)
end

-- WoW Forever (Camelot) stores its classic-style talent trees in C_ClassTalents / C_Traits,
-- with one tree per class and one trait group per specialization tab.
local function activeConfigId()
	if C_ClassTalents and C_ClassTalents.GetActiveConfigID then
		local ok, id = pcall(C_ClassTalents.GetActiveConfigID)
		if ok and id and id > 0 then
			return id
		end
	end
	if
		C_SpecializationInfo
		and C_SpecializationInfo.GetActiveSpecGroup
		and C_SpecializationInfo.GetCombatConfigIDForSpecGroup
	then
		local ok, group = pcall(C_SpecializationInfo.GetActiveSpecGroup)
		if ok and group then
			local cok, id = pcall(C_SpecializationInfo.GetCombatConfigIDForSpecGroup, group)
			if cok and id and id > 0 then
				return id
			end
		end
	end
	return nil
end

local function collectTalents()
	if not (C_Traits and C_Traits.GetConfigInfo and C_Traits.GetTreeNodes and C_Traits.GetNodeInfo) then
		return "meta\t0\t0"
	end
	local configId = activeConfigId()
	if not configId then
		return "meta\t0\t0"
	end
	local ok, cfg = pcall(C_Traits.GetConfigInfo, configId)
	if not ok or not cfg or type(cfg.treeIDs) ~= "table" then
		return "meta\t0\t0"
	end
	local unspent, spentTotal = 0, 0
	local treeLines, talentLines = {}, {}
	for _, treeId in ipairs(cfg.treeIDs) do
		if C_Traits.GetTreeCurrencyInfo then
			local cok, currencies = pcall(C_Traits.GetTreeCurrencyInfo, configId, treeId, true)
			if cok and type(currencies) == "table" then
				for _, c in ipairs(currencies) do
					unspent = unspent + (c.quantity or 0)
					spentTotal = spentTotal + (c.spent or 0)
				end
			end
		end
		local groupNames, groupIds, displays = {}, {}, {}
		if C_Traits.GetGroupDisplayInfoByTreeID then
			local dok, list = pcall(C_Traits.GetGroupDisplayInfoByTreeID, treeId)
			if dok and type(list) == "table" then
				for _, d in ipairs(list) do
					displays[#displays + 1] = d
					groupIds[#groupIds + 1] = d.groupID
					groupNames[d.groupID] = clean(d.displayName or "")
				end
				sort(displays, function(a, b)
					return (a.orderIndex or 0) < (b.orderIndex or 0)
				end)
			end
		end
		local groupSpent = {}
		if #groupIds > 0 and C_Traits.GetGroupCurrencyInfo then
			local gok, gInfos = pcall(C_Traits.GetGroupCurrencyInfo, configId, groupIds)
			if gok and type(gInfos) == "table" then
				for _, gi in ipairs(gInfos) do
					local s = 0
					for _, ci in ipairs(gi.currencyInfos or {}) do
						s = s + (ci.spent or 0)
					end
					groupSpent[gi.traitNodeGroupID] = s
				end
			end
		end
		for _, d in ipairs(displays) do
			treeLines[#treeLines + 1] = format("tree\t%s\t%d", groupNames[d.groupID], groupSpent[d.groupID] or 0)
		end
		local nok, nodes = pcall(C_Traits.GetTreeNodes, treeId)
		if nok and type(nodes) == "table" then
			sort(nodes)
			for _, nodeId in ipairs(nodes) do
				local iok, node = pcall(C_Traits.GetNodeInfo, configId, nodeId)
				if iok and node then
					local rank = node.ranksPurchased or node.activeRank or 0
					if rank > 0 then
						local treeName = ""
						for _, gid in ipairs(node.groupIDs or {}) do
							if groupNames[gid] then
								treeName = groupNames[gid]
								break
							end
						end
						local entryId = (node.activeEntry and node.activeEntry.entryID)
							or (node.entryIDs and node.entryIDs[1])
						local spellId, name = 0, ""
						if entryId and C_Traits.GetEntryInfo and C_Traits.GetDefinitionInfo then
							local eok, entry = pcall(C_Traits.GetEntryInfo, configId, entryId)
							if eok and entry and entry.definitionID then
								local defOk, def = pcall(C_Traits.GetDefinitionInfo, entry.definitionID)
								if defOk and def then
									spellId = def.spellID or 0
									if def.overrideName and def.overrideName ~= "" then
										name = clean(def.overrideName)
									elseif spellId > 0 and C_Spell and C_Spell.GetSpellName then
										local sok, sn = pcall(C_Spell.GetSpellName, spellId)
										if sok and sn then
											name = clean(sn)
										end
									end
								end
							end
						end
						if name == "" then
							name = "node " .. tostring(nodeId)
						end
						talentLines[#talentLines + 1] = concat({
							"t",
							treeName,
							tostring(rank),
							tostring(node.maxRanks or rank),
							spellId > 0 and tostring(spellId) or "",
							name,
						}, "\t")
					end
				end
			end
		end
	end
	local lines = { format("meta\t%d\t%d", unspent, spentTotal) }
	for _, l in ipairs(treeLines) do
		lines[#lines + 1] = l
	end
	for _, l in ipairs(talentLines) do
		lines[#lines + 1] = l
	end
	return pack(lines)
end

local function round1(n)
	return format("%.1f", n)
end

local function collectStats()
	local lines = {}
	local function add(key, value)
		if value ~= nil and value ~= "" then
			lines[#lines + 1] = format("%s\t%s", key, tostring(value))
		end
	end
	if UnitHealthMax then
		local ok, v = pcall(UnitHealthMax, "player")
		if ok and v then
			add("healthMax", v)
		end
	end
	if UnitPowerType then
		local ok, _, token = pcall(UnitPowerType, "player")
		if ok and token then
			add("powerType", token)
		end
	end
	if UnitPowerMax then
		local ok, v = pcall(UnitPowerMax, "player")
		if ok and v then
			add("powerMax", v)
		end
	end
	if UnitStat then
		local keys = { "str", "agi", "sta", "int", "spi" }
		for i = 1, 5 do
			local ok, _, effective = pcall(UnitStat, "player", i)
			if ok and effective then
				add(keys[i], effective)
			end
		end
	end
	if UnitArmor then
		local ok, _, effective = pcall(UnitArmor, "player")
		if ok and effective then
			add("armor", effective)
		end
	end
	if UnitAttackPower then
		local ok, base, pos, neg = pcall(UnitAttackPower, "player")
		if ok and base then
			add("meleeAP", base + (pos or 0) + (neg or 0))
		end
	end
	if UnitRangedAttackPower then
		local ok, base, pos, neg = pcall(UnitRangedAttackPower, "player")
		if ok and base then
			add("rangedAP", base + (pos or 0) + (neg or 0))
		end
	end
	if GetCritChance then
		local ok, v = pcall(GetCritChance)
		if ok and v then
			add("meleeCrit", round1(v))
		end
	end
	if GetRangedCritChance then
		local ok, v = pcall(GetRangedCritChance)
		if ok and v then
			add("rangedCrit", round1(v))
		end
	end
	if GetSpellCritChance then
		local ok, v = pcall(GetSpellCritChance)
		if ok and v then add("spellCrit", round1(v)) end
	end
	if GetSpellBonusDamage then
		local best = 0
		for school = 2, 7 do
			local ok, v = pcall(GetSpellBonusDamage, school)
			if ok and v and v > best then
				best = v
			end
		end
		add("spellDamage", best)
	end
	if GetSpellBonusHealing then
		local ok, v = pcall(GetSpellBonusHealing)
		if ok and v then
			add("spellHealing", v)
		end
	end
	if GetDodgeChance then
		local ok, v = pcall(GetDodgeChance)
		if ok and v then
			add("dodge", round1(v))
		end
	end
	if GetParryChance then
		local ok, v = pcall(GetParryChance)
		if ok and v then
			add("parry", round1(v))
		end
	end
	if GetBlockChance then
		local ok, v = pcall(GetBlockChance)
		if ok and v then
			add("block", round1(v))
		end
	end
	if UnitDefenseSkill then
		local ok, base, mod = pcall(UnitDefenseSkill, "player")
		if ok and base then
			add("defense", base + (mod or 0))
		end
	end
	return pack(lines)
end

local function collectProfessions()
	local lines = {}
	if not (C_SkillInfo and C_SkillInfo.GetNumSkillLines and C_SkillInfo.GetSkillLineInfo) then
		return ""
	end
	local ok, count = pcall(C_SkillInfo.GetNumSkillLines)
	if not ok or not count then
		return ""
	end
	local category = ""
	for i = 1, count do
		local iok, info = pcall(C_SkillInfo.GetSkillLineInfo, i)
		if iok and info then
			if info.isHeader then
				category = clean(info.name or "")
			elseif info.name and info.name ~= "" then
				lines[#lines + 1] = concat({
					"s",
					tostring(info.skillID or 0),
					category,
					tostring(info.rank or 0),
					tostring(info.maxRank or 0),
					tostring(info.modifier or 0),
					clean(info.name),
				}, "\t")
			end
		end
	end
	return pack(lines)
end

local function collectReputation()
	local lines = {}
	if not (C_Reputation and C_Reputation.GetNumFactions and C_Reputation.GetFactionDataByIndex) then
		return ""
	end
	local ok, count = pcall(C_Reputation.GetNumFactions)
	if not ok or not count then
		return ""
	end
	local category = ""
	for i = 1, count do
		local iok, info = pcall(C_Reputation.GetFactionDataByIndex, i)
		if iok and info then
			if info.isHeader and not info.isHeaderWithRep then
				category = clean(info.name or "")
			elseif info.name and info.name ~= "" then
				lines[#lines + 1] = concat({
					"r",
					tostring(info.factionID or 0),
					category,
					tostring(info.reaction or 0),
					tostring(info.currentStanding or 0),
					tostring(info.currentReactionThreshold or 0),
					tostring(info.nextReactionThreshold or 0),
					info.isWatched and "1" or "0",
					clean(info.name),
				}, "\t")
			end
		end
	end
	return pack(lines)
end

local function collectSpells()
	local lines = {}
	if not (C_SpellBook and C_SpellBook.GetNumSpellBookSkillLines and C_SpellBook.GetSpellBookSkillLineInfo and C_SpellBook.GetSpellBookItemInfo) then
		return ""
	end
	local bank = (Enum and Enum.SpellBookSpellBank and Enum.SpellBookSpellBank.Player) or 0
	local ok, tabs = pcall(C_SpellBook.GetNumSpellBookSkillLines)
	if not ok or not tabs then
		return ""
	end
	local seenSpell = {}
	for t = 1, tabs do
		local tok, tab = pcall(C_SpellBook.GetSpellBookSkillLineInfo, t)
		if tok and tab and not tab.shouldHide and not tab.isGuild then
			local category = clean(tab.name or "")
			local start = (tab.itemIndexOffset or 0) + 1
			local stop = start + (tab.numSpellBookItems or 0) - 1
			for slot = start, stop do
				local low = false
				if C_SpellBook.IsSpellBookItemLowRank then
					local lok, isLow = pcall(C_SpellBook.IsSpellBookItemLowRank, slot, bank)
					low = lok and isLow == true
				end
				if not low then
					local iok, info = pcall(C_SpellBook.GetSpellBookItemInfo, slot, bank)
					if iok and info and info.itemType == Enum.SpellBookItemType.Spell and not info.isOffSpec and info.name and info.name ~= "" and info.spellID and info.spellID > 0 then
						if not seenSpell[info.spellID] then
							seenSpell[info.spellID] = true
							lines[#lines + 1] = concat({
								"sp",
								tostring(info.spellID),
								category,
								info.isPassive and "1" or "0",
								clean(info.subName or ""),
								clean(info.name),
							}, "\t")
						end
					end
				end
			end
		end
	end
	return pack(lines)
end

-- Last-seen snapshots (captured when the player visits bank, merchant or trainer) ----------

local function bankBagIds()
	if not (C_Bank and C_Bank.FetchPurchasedBankTabData and Enum and Enum.BankType) then return nil end
	local ok, tabs = pcall(C_Bank.FetchPurchasedBankTabData, Enum.BankType.Character)
	if not ok or type(tabs) ~= "table" then return nil end
	local ids = {}
	for _, tab in ipairs(tabs) do ids[#ids + 1] = tab.ID end
	return ids
end

local function snapshotBank()
	local total, free = 0, 0
	local byId, ids = {}, {}
	local bankIds = bankBagIds()
	if not (bankIds and C_Container and C_Container.GetContainerNumSlots) then return end
	do
		for _, bag in ipairs(bankIds) do
			local ok, slots = pcall(C_Container.GetContainerNumSlots, bag)
			if ok and slots and slots > 0 then
				total = total + slots
				if C_Container.GetContainerNumFreeSlots then
					local fok, f = pcall(C_Container.GetContainerNumFreeSlots, bag)
					if fok and f then
						free = free + f
					end
				end
				for slot = 1, slots do
					local iok, info = pcall(C_Container.GetContainerItemInfo, bag, slot)
					if iok and info and info.itemID then
						local id = info.itemID
						local count = info.stackCount or 1
						local rec = byId[id]
						if rec then
							rec.count = rec.count + count
						else
							local itemName = info.itemName
							if (not itemName or itemName == "") and info.hyperlink then
								itemName = info.hyperlink:match("%[(.-)%]")
							end
							byId[id] = {
								id = id,
								count = count,
								quality = info.quality,
								name = clean(itemName or ""),
							}
							ids[#ids + 1] = id
						end
					end
				end
			end
		end
	end
	sort(ids)
	local lines = { format("meta\t%s\t%d\t%d", nowStamp(), free, total) }
	for _, id in ipairs(ids) do
		local rec = byId[id]
		lines[#lines + 1] = concat({
			"item",
			tostring(rec.id),
			tostring(rec.count),
			rec.quality and tostring(rec.quality) or "",
			rec.name,
		}, "\t")
	end
	seen.bank = pack(lines)
	revs.bank = (revs.bank or 0) + 1
end

local function snapshotMerchant()
	if not GetMerchantNumItems then
		return
	end
	local ok, count = pcall(GetMerchantNumItems)
	if not ok or not count then
		return
	end
	local npc = ""
	if UnitName then
		local nok, n = pcall(UnitName, "npc")
		if nok and n then
			npc = clean(n)
		end
	end
	local lines = { format("meta\t%s\t%s", nowStamp(), npc) }
	for i = 1, count do
		local info
		if C_MerchantFrame and C_MerchantFrame.GetItemInfo then
			local iok, res = pcall(C_MerchantFrame.GetItemInfo, i)
			if iok then
				info = res
			end
		end
		if info and info.name and info.name ~= "" then
			local itemId = ""
			if GetMerchantItemLink then
				local lok, link = pcall(GetMerchantItemLink, i)
				if lok and link then
					itemId = link:match("item:(%d+)") or ""
				end
			end
			lines[#lines + 1] = concat({
				"m",
				itemId,
				tostring(info.price or 0),
				tostring(info.stackCount or 1),
				tostring(info.numAvailable or -1),
				info.isUsable == false and "0" or "1",
				clean(info.name),
			}, "\t")
			-- Items and currencies the offer costs besides money, one "mc" line each after its item.
			if info.hasExtendedCost and GetMerchantItemCostInfo and GetMerchantItemCostItem then
				local cok, costs = pcall(GetMerchantItemCostInfo, i)
				for j = 1, (cok and costs) or 0 do
					local iok, _, value, costLink, currencyName = pcall(GetMerchantItemCostItem, i, j)
					if iok and value then
						local kind, costId = "", ""
						if costLink then
							costId = costLink:match("item:(%d+)") or ""
							if costId ~= "" then
								kind = "item"
							else
								costId = costLink:match("currency:(%d+)") or ""
								kind = costId ~= "" and "currency" or ""
							end
						end
						local costName = currencyName or (costLink and costLink:match("%[(.-)%]")) or ""
						lines[#lines + 1] = concat({ "mc", tostring(value), kind, costId, clean(costName) }, "\t")
					end
				end
			end
		end
	end
	seen.merchant = pack(lines)
	revs.merchant = (revs.merchant or 0) + 1
end

local function snapshotTrainer()
	if not (GetNumTrainerServices and GetTrainerServiceInfo) then
		return
	end
	local ok, count = pcall(GetNumTrainerServices)
	if not ok or not count then
		return
	end
	local npc = ""
	if UnitName then
		local nok, n = pcall(UnitName, "npc")
		if nok and n then
			npc = clean(n)
		end
	end
	-- Enum.TrainerType: a pet trainer's service cost is training points, not money.
	local trainerType = ""
	if C_Trainer and C_Trainer.GetTrainerType then
		local tok, t = pcall(C_Trainer.GetTrainerType)
		if tok and t then
			trainerType = tostring(t)
		end
	end
	local lines = { format("meta\t%s\t%s\t%s", nowStamp(), npc, trainerType) }
	for i = 1, count do
		local iok, name, serviceType, _, reqLevel, subText = pcall(GetTrainerServiceInfo, i)
		if iok and name and name ~= "" and serviceType ~= "header" then
			local cost = 0
			if GetTrainerServiceCost then
				local cok, c = pcall(GetTrainerServiceCost, i)
				if cok and c then
					cost = c
				end
			end
			lines[#lines + 1] = concat({
				"tr",
				clean(serviceType or ""),
				tostring(reqLevel or 0),
				tostring(cost),
				clean(subText or ""),
				clean(name),
			}, "\t")
		end
	end
	seen.trainer = pack(lines)
	revs.trainer = (revs.trainer or 0) + 1
end

local function collectSeen(key)
	return function()
		return seen[key] or "empty"
	end
end

local COLLECTORS = {
	eq = collectEquipment,
	bags = collectBags,
	quests = collectQuests,
	talents = collectTalents,
	stats = collectStats,
	prof = collectProfessions,
	rep = collectReputation,
	spells = collectSpells,
	bank = collectSeen("bank"),
	merchant = collectSeen("merchant"),
	trainer = collectSeen("trainer"),
}

-- Any item, spell or quest by ID, also ones the player never saw (FAM-61): what the client knows
-- about it. Data the client has not loaded yet is asked for and waited on, a few seconds at most.
local LOOKUP_WAIT = 3

-- Whether the thing exists, and whether its data is there; asks the client to load it if not.
local function loaded(kind, id)
	if kind == "item" then
		if C_Item.DoesItemExistByID and not C_Item.DoesItemExistByID(id) then
			return false, true
		end
		if C_Item.GetItemInfo(id) then
			return true, true
		end
		C_Item.RequestLoadItemDataByID(id)
		return true, false
	elseif kind == "spell" then
		if not C_Spell.DoesSpellExist(id) then
			return false, true
		end
		if C_Spell.IsSpellDataCached and not C_Spell.IsSpellDataCached(id) then
			C_Spell.RequestLoadSpellData(id)
			return true, false
		end
		return true, true
	elseif kind == "quest" then
		local title = C_QuestLog.GetTitleForQuestID(id)
		if title and title ~= "" then
			return true, true
		end
		-- The client cannot tell an unknown quest from one still loading.
		C_QuestLog.RequestLoadQuestByID(id)
		return false, false
	end
	return false, true
end

local function describeLookup(kind, id)
	local lines = {}
	if kind == "item" then
		local name, _, quality, ilvl, minLevel, itemType, subType, _, equip, _, sell = C_Item.GetItemInfo(id)
		lines[1] = concat({ "l", kind, tostring(id), clean(name or "") }, "\t")
		lines[2] = concat({
			"i",
			tostring(quality or ""),
			tostring(ilvl or ""),
			tostring(minLevel or ""),
			clean(itemType or ""),
			clean(subType or ""),
			clean(equip or ""),
			tostring(sell or ""),
		}, "\t")
	elseif kind == "spell" then
		lines[1] = concat({ "l", kind, tostring(id), clean(C_Spell.GetSpellName(id) or "") }, "\t")
		if C_Spell.GetSpellDescription then
			local ok, text = pcall(C_Spell.GetSpellDescription, id)
			if ok and text and text ~= "" then
				lines[#lines + 1] = "d\t" .. clean(text)
			end
		end
	else
		lines[1] = concat({ "l", kind, tostring(id), clean(C_QuestLog.GetTitleForQuestID(id) or "") }, "\t")
		local level, done, inLog = "", "", ""
		if C_QuestLog.GetQuestDifficultyLevel then
			local ok, v = pcall(C_QuestLog.GetQuestDifficultyLevel, id)
			level = ok and v and tostring(v) or ""
		end
		if C_QuestLog.IsQuestFlaggedCompleted then
			local ok, v = pcall(C_QuestLog.IsQuestFlaggedCompleted, id)
			done = ok and (v and "1" or "0") or ""
		end
		if C_QuestLog.GetLogIndexForQuestID then
			local ok, v = pcall(C_QuestLog.GetLogIndexForQuestID, id)
			inLog = ok and (v and "1" or "0") or ""
		end
		lines[2] = concat({ "qd", level, done, inLog }, "\t")
	end
	for _, line in ipairs(ns.Links.Tooltip(kind .. ":" .. id)) do
		lines[#lines + 1] = "t\t" .. line
	end
	return pack(lines)
end

local function lookup(id, arg)
	local kind, number = arg:match("^(%a+):(%d+)$")
	number = tonumber(number)
	if not (kind == "item" or kind == "spell" or kind == "quest") or not number then
		Transport.Send(format("state\n%s\nlookup\n0\nerror\tunknown lookup", id))
		return
	end
	Tasks.Spawn("lookup", function()
		local waited, exists, ready = 0, false, false
		while true do
			local ok, e, r = pcall(loaded, kind, number)
			if not ok then
				Transport.Send(format("state\n%s\nlookup\n0\nerror\t%s", id, clean(e)))
				return
			end
			exists, ready = e, r
			if ready or waited >= LOOKUP_WAIT then
				break
			end
			Tasks.Sleep(0.2)
			waited = waited + 0.2
		end
		local payload = "none"
		if exists then
			local ok, described = pcall(describeLookup, kind, number)
			payload = ok and described or ("error\t" .. clean(described))
		end
		Transport.Send(format("state\n%s\nlookup\n0\n%s", id, payload))
	end)
end

-- Responds to pull requests from the app: "fetch\n<id>\n<slice>", and for a lookup
-- "fetch\n<id>\nlookup\n<kind>:<id>".
Transport.OnMessage(function(body)
	local id, slice, arg = body:match("^fetch\n(%d+)\n([a-z]+)\n?([a-z]*:?%d*)$")
	if not id then
		return
	end
	if slice == "lookup" then
		lookup(id, arg)
		return
	end
	local fn = COLLECTORS[slice]
	if not fn then
		Transport.Send(format("state\n%s\n%s\n0\nerror\tunknown slice", id, slice))
		return
	end
	local rev = revs[slice] or 1
	local ok, payload = pcall(fn)
	if not ok then
		Transport.Send(format("state\n%s\n%s\n%d\nerror\t%s", id, slice, rev, clean(payload)))
		return
	end
	Transport.Send(format("state\n%s\n%s\n%d\n%s", id, slice, rev, payload))
end)

-- Event wiring: bumps integer revisions, and snapshots last-seen frames while they are open.
-- Events for the values collectStats reads, as the character sheet refreshes on them.
local UNIT_EVENTS = {
	UNIT_STATS = "stats",
	UNIT_MAXHEALTH = "stats",
	UNIT_MAXPOWER = "stats",
	UNIT_DISPLAYPOWER = "stats", -- power type, for example in a druid form
	UNIT_AURA = "stats",
	UNIT_RESISTANCES = "stats", -- armor
	UNIT_ATTACK_POWER = "stats",
	UNIT_RANGED_ATTACK_POWER = "stats",
	UNIT_DEFENSE = "stats",
	PLAYER_DAMAGE_DONE_MODS = "stats", -- spell damage and healing
}

local BUMP_EVENTS = {
	PLAYER_EQUIPMENT_CHANGED = { "eq", "stats" },
	BAG_UPDATE_DELAYED = { "bags" },
	PLAYER_MONEY = { "bags" },
	QUEST_LOG_UPDATE = { "quests" },
	QUEST_WATCH_LIST_CHANGED = { "quests" },
	-- Quest areas depend on the map the player is on.
	QUEST_POI_UPDATE = { "quests" },
	ZONE_CHANGED_NEW_AREA = { "quests" },
	TRAIT_CONFIG_UPDATED = { "talents" },
	ACTIVE_COMBAT_CONFIG_CHANGED = { "talents" },
	PLAYER_SPECIALIZATION_CHANGED = { "talents", "stats" },
	TRAIT_TREE_CHANGED = { "talents" },
	PLAYER_TALENT_UPDATE = { "talents", "stats" },
	ACTIVE_TALENT_GROUP_CHANGED = { "talents", "stats" },
	COMBAT_RATING_UPDATE = { "stats" },
	SPELL_POWER_CHANGED = { "stats" },
	PLAYER_LEVEL_UP = { "stats" },
	-- Skill lines include the defense skill.
	SKILL_LINES_CHANGED = { "prof", "stats" },
	UPDATE_FACTION = { "rep" },
	SPELLS_CHANGED = { "spells" },
	LEARNED_SPELL_IN_TAB = { "spells" },
}

local EXTRA_EVENTS = {
	"BANKFRAME_OPENED",
	"BANKFRAME_CLOSED",
	"PLAYERBANKSLOTS_CHANGED",
	"BANK_TABS_CHANGED",
	"MERCHANT_SHOW",
	"MERCHANT_UPDATE",
	"TRAINER_SHOW",
	"TRAINER_UPDATE",
	"TRAINER_SERVICE_INFO_NAME_UPDATE",
	"TRAINER_CLOSED",
}

function Collect.Init()
	local f = CreateFrame("Frame")
	for event in pairs(UNIT_EVENTS) do
		pcall(f.RegisterEvent, f, event)
	end
	for event in pairs(BUMP_EVENTS) do
		pcall(f.RegisterEvent, f, event)
	end
	for _, event in ipairs(EXTRA_EVENTS) do
		pcall(f.RegisterEvent, f, event)
	end
	f:SetScript("OnEvent", function(_, event, arg1)
		local unitSlice = UNIT_EVENTS[event]
		if unitSlice then
			if arg1 == "player" then
				revs[unitSlice] = (revs[unitSlice] or 0) + 1
			end
			return
		end
		local list = BUMP_EVENTS[event]
		if list then
			for i = 1, #list do
				local s = list[i]
				revs[s] = (revs[s] or 0) + 1
			end
			if event == "BAG_UPDATE_DELAYED" and bankOpen then
				pcall(snapshotBank)
			end
			return
		end
		if event == "BANKFRAME_OPENED" then
			bankOpen = true
			pcall(snapshotBank)
		elseif event == "BANKFRAME_CLOSED" then
			bankOpen = false
		elseif event == "PLAYERBANKSLOTS_CHANGED" or event == "BANK_TABS_CHANGED" then
			if bankOpen then
				pcall(snapshotBank)
			end
		elseif event == "MERCHANT_SHOW" or event == "MERCHANT_UPDATE" then
			pcall(snapshotMerchant)
		elseif event == "TRAINER_SHOW" then
			trainerOpen = true
			pcall(snapshotTrainer)
		elseif event == "TRAINER_CLOSED" then
			trainerOpen = false
		elseif event == "TRAINER_UPDATE" or event == "TRAINER_SERVICE_INFO_NAME_UPDATE" then
			-- Service names can arrive after the window opens; rows without one were left out.
			if trainerOpen then
				pcall(snapshotTrainer)
			end
		end
	end)
end
