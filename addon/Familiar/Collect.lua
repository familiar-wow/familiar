-- Game-state collectors (FAM-3, FAM-46): read on demand when the app asks for a slice
-- ("fetch\n<id>\n<slice>"), and send compact TSV back ("state\n<id>\n<slice>\n<rev>\n...").
-- Between fetches the addon only bumps integer revision counters on WoW events, so nothing
-- travels over the lane until the player's agent actually calls a tool (ADR 0001, ADR 0007).
local _, ns = ...
local Transport = ns.Transport

local format, concat, sort = string.format, table.concat, table.sort

local Collect = {}
ns.Collect = Collect

-- Cap any single state reply so an unusually large bag or quest log never stalls the 0.9 KB/s lane.
local MAX_STATE = 8192

-- Revision counters per slice. Every question's header sends them so the app can serve unchanged
-- slices straight from its cache without a round trip.
local revs = { eq = 1, bags = 1, quests = 1, talents = 1 }

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
	return format("eq=%d bags=%d quests=%d talents=%d", revs.eq, revs.bags, revs.quests, revs.talents)
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

local function collectQuests()
	local lines = {}
	if not (C_QuestLog and C_QuestLog.GetNumQuestLogEntries and C_QuestLog.GetInfo) then
		return ""
	end
	local ok, count = pcall(C_QuestLog.GetNumQuestLogEntries)
	if not ok or not count then
		return ""
	end
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

local COLLECTORS = {
	eq = collectEquipment,
	bags = collectBags,
	quests = collectQuests,
	talents = collectTalents,
}

-- Responds to pull requests from the app: "fetch\n<id>\n<slice>".
Transport.OnMessage(function(body)
	local id, slice = body:match("^fetch\n(%d+)\n([a-z]+)$")
	if not id then
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

-- Event wiring: only bumps integer revisions, never serializes or sends.
local EVENTS = {
	PLAYER_EQUIPMENT_CHANGED = "eq",
	BAG_UPDATE_DELAYED = "bags",
	PLAYER_MONEY = "bags",
	QUEST_LOG_UPDATE = "quests",
	QUEST_WATCH_LIST_CHANGED = "quests",
	TRAIT_CONFIG_UPDATED = "talents",
	ACTIVE_COMBAT_CONFIG_CHANGED = "talents",
	PLAYER_SPECIALIZATION_CHANGED = "talents",
	TRAIT_TREE_CHANGED = "talents",
}

function Collect.Init()
	local f = CreateFrame("Frame")
	for event in pairs(EVENTS) do
		-- pcall so an event name absent in a client revision never breaks login.
		pcall(f.RegisterEvent, f, event)
	end
	f:SetScript("OnEvent", function(_, event)
		local slice = EVENTS[event]
		if slice then
			revs[slice] = (revs[slice] or 0) + 1
		end
	end)
end
