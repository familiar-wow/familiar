-- Familiar's entry point: saved state, events, the frame loop and /familiar.
local addonName, ns = ...
local Tasks, Lane, Transport = ns.Tasks, ns.Lane, ns.Transport

local format = string.format

-- The helpers' category in the addon list, as core/src/wow/install.ts names it.
local CATEGORY = "Familiar transport"

function ns.Print(text)
	print("|cff8fd1ffFamiliar:|r " .. text)
end

function ns.Error(where, err)
	ns.Print(format("|cffff6060%s failed:|r %s", tostring(where), tostring(err)))
end

-- Collapses the helpers' category once; after that, open or closed is the player's choice. The
-- addon list restores its saved state when it loads, so this waits for that.
local function collapse()
	local collapsed = _G.g_addonCategoriesCollapsed
	if ns.db and not ns.db.collapsed and type(collapsed) == "table" then
		collapsed[CATEGORY], ns.db.collapsed = true, true
	end
end

-- For testing the transport until the chat window exists: /familiar say <text> -----------
local asked

Transport.OnMessage(function(body)
	local line = body:match("^[^\n]*")
	local took = asked and format(" after %.2f s", Tasks.Now() - asked) or ""
	ns.Print(format("Reply%s, %d bytes: %s", took, #body, line))
	asked = nil
end)

SLASH_FAMILIAR1 = "/familiar"
SlashCmdList.FAMILIAR = function(input)
	local command, rest = (input or ""):match("^%s*(%S*)%s*(.-)%s*$")
	command = command:lower()
	if command == "say" and rest ~= "" then
		local started = Tasks.Now()
		asked = started
		Transport.Send(rest, function(ok, why)
			if ok then
				ns.Print(format("Sent in %.2f s.", Tasks.Now() - started))
			else
				ns.Print("Not sent: " .. why .. ".")
			end
		end)
	elseif command == "status" then
		ns.Print(Transport.Status())
	else
		ns.Print("/familiar say <text> sends a test message to the app; /familiar status shows the transport.")
	end
end

-- Events and the frame loop -----------------------------------------------------------
local frame = CreateFrame("Frame")
frame:RegisterEvent("ADDON_LOADED")
frame:RegisterEvent("PLAYER_ENTERING_WORLD")
frame:SetScript("OnEvent", function(_, event, name)
	if event == "ADDON_LOADED" and name == addonName then
		FamiliarDB = FamiliarDB or {}
		FamiliarDB.transport = FamiliarDB.transport or {}
		ns.db = FamiliarDB
	elseif event == "ADDON_LOADED" and name == "Blizzard_AddOnList" then
		collapse()
	elseif event == "PLAYER_ENTERING_WORLD" and not ns.started then
		ns.started = true
		collapse()
		Transport.Start(ns.db.transport)
	end
end)

local function step()
	Lane.Watch()
	Tasks.Step()
end

local broken = false
frame:SetScript("OnUpdate", function()
	if not ns.started or broken then
		return
	end
	local ok, err = pcall(step)
	if not ok then
		broken = true
		ns.Error("frame loop", err)
	end
end)
