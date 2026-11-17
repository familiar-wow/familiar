-- Familiar's entry point: saved state, events, the frame loop and /familiar.
local addonName, ns = ...
local Tasks, Lane, Transport, Chat = ns.Tasks, ns.Lane, ns.Transport, ns.Chat

local format = string.format

-- The helpers' category in the addon list, as core/src/wow/install.ts names it.
local CATEGORY = "Familiar transport"

-- A line from Familiar: into its window, and into the chat while the window is closed.
function ns.Print(text)
	if not (ns.Chat and ns.Chat.System(text)) then
		print("|cff8fd1ffFamiliar:|r " .. text)
	end
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

local HELP = "/familiar opens and closes the window; /familiar config opens its settings; "
	.. "/familiar say <question> asks from the chat line; /familiar allow or deny answers the agent's "
	.. "request; /familiar status shows the transport."

SLASH_FAMILIAR1 = "/familiar"
SlashCmdList.FAMILIAR = function(input)
	local command, rest = (input or ""):match("^%s*(%S*)%s*(.-)%s*$")
	command = command:lower()
	if command == "" then
		Chat.Toggle()
	elseif command == "say" and rest ~= "" then
		Chat.Ask(rest)
	elseif command == "allow" or command == "deny" then
		Chat.Answer(command == "allow")
	elseif command == "config" then
		Chat.Settings()
	elseif command == "status" then
		ns.Print(Transport.Status())
	else
		ns.Print(HELP)
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
		FamiliarDB.window = FamiliarDB.window or {}
		ns.db = FamiliarDB
		Chat.Init(FamiliarDB.window)
	elseif event == "ADDON_LOADED" and name == "Blizzard_AddOnList" then
		collapse()
	elseif event == "PLAYER_ENTERING_WORLD" and not ns.started then
		ns.started = true
		Chat.Login()
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
