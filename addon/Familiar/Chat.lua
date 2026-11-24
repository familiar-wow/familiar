-- The chat window (FAM-23): history, an input line, a status line that counts while the brain
-- works, and Allow/Deny when the agent asks for permission. Messages carry their kind on the
-- first line; formats: core/src/brain/chat.ts. Nothing here reads the game's chat (AGENTS.md,
-- rule 2), and text from the brain becomes a link only through Links.Render (rule 3). Its look
-- and the player's settings for it: Style.lua.
local _, ns = ...
local Tasks, Transport, Links, Style, Collect =
	ns.Tasks, ns.Transport, ns.Links, ns.Style, ns.Collect

local format, floor = string.format, math.floor

local Chat = {}
ns.Chat = Chat

local HISTORY = 200 -- lines kept per character across /reload
local MAX_BYTES = 1000 -- per question, with links: the lane carries about 0.9 KB/s
local YOU, FAMILIAR = "|cffffd100You:|r ", "|cff8fd1ffFamiliar:|r "
local GREY, TOOL = { 0.6, 0.6, 0.6 }, { 0.5, 0.7, 0.8 }

-- FamiliarDB.window: point, relativePoint, x, y, width, height, shown and style for every
-- character; histories["name-realm"]: the lines of each character, whose agent session is its
-- own too (core/src/brain/acp.ts).
local db
local kept -- the logged-in character's lines, once known
local frame, history, input, status, ask, askText, title
local opacity, focus -- set how opaque the window is, and whether the input line shows as focused
-- pending: questions without an answer so far; sending: those of them the app has not confirmed
-- or refused yet; heard: when the app last confirmed a question or sent anything
local pending, sending, heard = 0, 0, 0
local since, tool = 0, nil
local requests = {} -- permission requests the player has not answered, oldest first

local plain = Links.Plain

local function add(text, color)
	color = color or {}
	history:AddMessage(text, color[1], color[2], color[3])
	if not kept then
		return
	end
	kept[#kept + 1] = { text, color[1], color[2], color[3] }
	if #kept > HISTORY then
		table.remove(kept, 1)
	end
end

-- Adds `text`, which is already escaped, line by line.
local function addLines(prefix, text, color)
	local first = true
	for line in text:gmatch("[^\n]+") do
		add(first and prefix .. line or line, color)
		first = false
	end
end

-- Who asks and from where, with every question (ADR 0001): "key: value" lines and a blank
-- line, as core/src/brain/chat.ts reads them.
local function header()
	local rows = {}
	local function row(key, value)
		if value and value ~= "" then
			rows[#rows + 1] = key .. ": " .. tostring(value)
		end
	end
	local faction, localizedFaction = UnitFactionGroup("player")
	local zone, subzone = GetRealZoneText(), GetSubZoneText()
	local realm = GetRealmName()
	if (not realm or realm == "") and GetNormalizedRealmName then
		realm = GetNormalizedRealmName()
	end
	row("name", UnitName("player"))
	row("realm", realm)
	row("level", UnitLevel("player"))
	row("race", (UnitRace("player")))
	row("class", (UnitClass("player")))
	row("faction", localizedFaction or faction)
	row("zone", zone)
	row("subzone", subzone ~= zone and subzone or nil)
	row("locale", GetLocale())
	local map, x, y = Collect.Location()
	row("map", map)
	if x and y then
		row("coords", format("%.1f,%.1f", x, y))
	end
	row("money", Collect.Money())
	row("revs", Collect.Revs())
	return table.concat(rows, "\n") .. "\n\n"
end

-- Status and permission requests ------------------------------------------------------------

local function refresh()
	local request = requests[1]
	ask:SetShown(request ~= nil)
	status:SetShown(request == nil)
	if request then
		askText:SetText(plain(request.title))
		return
	end
	if pending > 0 then
		local text = format("Thinking … %d s", floor(Tasks.Now() - since))
		status:SetText(tool and text .. " · " .. plain(tool) or text)
	elseif not Transport.connected then
		status:SetText(Transport.problem or "Waiting for the Familiar app …")
	else
		status:SetText("")
	end
end

-- The app answers every question it confirmed, if only to say why there is no answer, within the
-- seconds its welcome names as its patience (core/src/main.ts). After that nothing will come, as
-- when the app was started again meanwhile.
local function expire()
	local patience = tonumber((Transport.welcome or ""):match("\npatience: (%d+)"))
	local waited = Tasks.Now() - heard
	if patience and pending > 0 and sending == 0 and waited > pending * patience then
		pending, tool, requests = 0, nil, {}
		add(format("No answer from the app after %d s. The question is lost; ask it again.", floor(waited)), GREY)
	end
end

-- Answers the oldest permission request, once.
function Chat.Answer(allow)
	local request = table.remove(requests, 1)
	if not request then
		return ns.Print("The agent is not asking for anything.")
	end
	add((allow and "Allowed once: " or "Denied: ") .. plain(request.title), GREY)
	Transport.Send(format("permission\n%d\n%s", request.id, allow and "allow" or "deny"), function(ok, why)
		if not ok then
			add("Not sent: " .. why .. ".", GREY)
		end
	end)
	refresh()
end

-- Sending and receiving ------------------------------------------------------------------

function Chat.Ask(text)
	text = (text or ""):match("^%s*(.-)%s*$")
	if text == "" then
		return
	end
	addLines(YOU, Links.Show(text))
	if pending == 0 then
		since, tool = Tasks.Now(), nil
	end
	pending, sending = pending + 1, sending + 1
	local started = Tasks.Now()
	Transport.Send("question\n" .. header() .. Links.Describe(text), function(ok, why)
		sending = sending - 1
		if ok then
			heard = Tasks.Now()
			add(format("Sent in %.2f s.", Tasks.Now() - started), GREY)
		else
			pending = pending - 1
			add("Not sent: " .. why .. ".", GREY)
		end
		refresh()
	end)
	refresh()
end

Transport.OnMessage(function(body)
	local kind, rest = body:match("^(%a+)\n(.*)$")
	heard = Tasks.Now()
	if kind == "fetch" then
		-- Handled by Collect.lua; still counts as a sign of life from the app.
		return
	elseif kind == "status" then
		tool = rest
		add("  > " .. plain(rest), TOOL)
	elseif kind == "note" then
		add(plain(rest), TOOL)
	elseif kind == "permission" then
		local id, title = rest:match("^(%d+)\n(.*)$")
		requests[#requests + 1] = { id = tonumber(id), title = title }
		add("The agent asks: " .. plain(title), TOOL)
		frame:Show()
	else
		pending, tool = math.max(0, pending - 1), nil
		if pending == 0 then
			-- Requests of a question that has ended can no longer be answered.
			requests = {}
		end
		Links.Render(plain(rest or body), function(text)
			addLines(FAMILIAR, text)
		end)
	end
	refresh()
end)

-- A line from Familiar itself. Returns whether the player sees it in the window.
function Chat.System(text)
	if not history then
		return false
	end
	add(text, GREY)
	return frame:IsShown()
end

function Chat.Toggle()
	frame:SetShown(not frame:IsShown())
end

function Chat.Settings()
	frame:Show()
	Style.Toggle(frame)
end

-- The window -----------------------------------------------------------------------------

local function save()
	local point, _, relativePoint, x, y = frame:GetPoint()
	db.point, db.relativePoint, db.x, db.y = point, relativePoint, x, y
	db.width, db.height = frame:GetWidth(), frame:GetHeight()
end

local function button(text, allow)
	return Style.Button(ask, text, 80, function()
		Chat.Answer(allow)
	end)
end

-- Shows the window as the settings say.
local function apply()
	local file, size, flags = Style.Font()
	history:SetFont(file, size, flags)
	input:SetFont(file, size, flags)
	input:SetHeight(size + 10)
	-- Dragging over the text selects it, and releasing the button copies it.
	history:SetTextCopyable(Style.Get("copy"))
	frame:SetScale(Style.Get("scale") / 100)
	opacity(Style.Get("opacity") / 100)
	title:SetTextColor(Style.Accent())
	focus(input:HasFocus())
end

-- A left click on a quest the player has in the log opens the quest log at it, with its map,
-- as the game's quest tracker does. Anything else, a modified click or a click in combat, when
-- the game keeps windows from opening, goes to the game's usual handling. Returns whether it
-- opened the log.
local function openQuest(link, button)
	local id = tonumber(link:match("^quest:(%d+)"))
	if not id or button ~= "LeftButton" or IsModifiedClick() or InCombatLockdown() then
		return false
	end
	if not (QuestMapFrame_OpenToQuestDetails and C_QuestLog.GetLogIndexForQuestID) then
		return false
	end
	if not C_QuestLog.GetLogIndexForQuestID(id) then
		return false
	end
	return (pcall(QuestMapFrame_OpenToQuestDetails, id))
end

local function create()
	frame = CreateFrame("Frame", "FamiliarChatFrame", UIParent)
	frame:SetFrameStrata("MEDIUM")
	frame:SetToplevel(true)
	frame:SetClampedToScreen(true)
	frame:SetMovable(true)
	frame:SetResizable(true)
	frame:EnableMouse(true)
	frame:RegisterForDrag("LeftButton")
	frame:SetScript("OnDragStart", frame.StartMoving)
	frame:SetScript("OnDragStop", function()
		frame:StopMovingOrSizing()
		save()
	end)
	frame:SetScript("OnShow", function()
		db.shown = true
	end)
	frame:SetScript("OnHide", function()
		db.shown = false
		input:ClearFocus()
		Style.Hide()
	end)
	frame:SetSize(db.width or 420, db.height or 300)
	frame:SetPoint(db.point or "CENTER", UIParent, db.relativePoint or "CENTER", db.x or 0, db.y or 0)
	-- Escape closes the window, like other panels.
	table.insert(UISpecialFrames, "FamiliarChatFrame")
	opacity = Style.Window(frame)

	-- The title bar; the window moves by it.
	title = frame:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	title:SetPoint("TOPLEFT", 10, -9)
	title:SetText("Familiar")
	local close = Style.Button(frame, "x", 20, function()
		frame:Hide()
	end)
	close:SetPoint("TOPRIGHT", -4, -4)
	local settings = Style.Button(frame, "Settings", 64, Chat.Settings)
	settings:SetPoint("RIGHT", close, "LEFT", -4, 0)

	input = CreateFrame("EditBox", nil, frame)
	input:SetPoint("BOTTOMLEFT", 10, 10)
	input:SetPoint("BOTTOMRIGHT", -22, 10)
	input:SetFontObject(ChatFontNormal)
	input:SetTextInsets(6, 6, 0, 0)
	focus = Style.Field(input)
	input:SetScript("OnEditFocusGained", function()
		focus(true)
	end)
	input:SetScript("OnEditFocusLost", function()
		focus(false)
	end)
	input:SetAutoFocus(false)
	input:SetMaxBytes(MAX_BYTES)
	input:SetScript("OnEnterPressed", function(self)
		local text = self:GetText()
		self:SetText("")
		self:ClearFocus()
		Chat.Ask(text)
	end)
	input:SetScript("OnEscapePressed", input.ClearFocus)
	-- A shift-click inserts its link here while the input line has the focus, as into the chat.
	if ChatFrameUtil and ChatFrameUtil.InsertLink then
		hooksecurefunc(ChatFrameUtil, "InsertLink", function(link)
			if type(link) == "string" and input:HasFocus() then
				input:Insert(link)
			end
		end)
	end

	ask = CreateFrame("Frame", nil, frame)
	ask:SetPoint("BOTTOMLEFT", input, "TOPLEFT", 0, 6)
	ask:SetPoint("BOTTOMRIGHT", input, "TOPRIGHT", 12, 6)
	ask:SetHeight(20)

	history = CreateFrame("ScrollingMessageFrame", nil, frame)
	history:SetPoint("TOPLEFT", 10, -30)
	history:SetPoint("BOTTOMRIGHT", ask, "TOPRIGHT", 0, 6)
	history:SetFontObject(ChatFontNormal)
	history:SetJustifyH("LEFT")
	history:SetFading(false)
	history:SetMaxLines(HISTORY * 2)
	-- Links show their tooltip on hover and open like in the chat on click. A quest in the log
	-- opens the quest log with its map instead, as quest trackers do.
	history:SetHyperlinksEnabled(true)
	history:EnableMouse(true)
	history:SetScript("OnHyperlinkClick", function(self, link, text, button)
		if not openQuest(link, button) then
			SetItemRef(link, text, button, self)
		end
	end)
	history:SetScript("OnHyperlinkEnter", function(self, link)
		GameTooltip:SetOwner(self, "ANCHOR_CURSOR")
		if pcall(GameTooltip.SetHyperlink, GameTooltip, link) then
			GameTooltip:Show()
		end
	end)
	history:SetScript("OnHyperlinkLeave", function()
		GameTooltip:Hide()
	end)
	history:EnableMouseWheel(true)
	history:SetScript("OnMouseWheel", function(self, delta)
		if delta > 0 then
			self:ScrollUp()
		else
			self:ScrollDown()
		end
	end)
	status = frame:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	status:SetPoint("LEFT", ask, "LEFT", 2, 0)
	status:SetPoint("RIGHT", ask, "RIGHT", -2, 0)
	status:SetJustifyH("LEFT")
	status:SetWordWrap(false)

	local deny = button("Deny", false)
	deny:SetPoint("RIGHT")
	local allow = button("Allow once", true)
	allow:SetPoint("RIGHT", deny, "LEFT", -4, 0)
	askText = ask:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	askText:SetPoint("LEFT")
	askText:SetPoint("RIGHT", allow, "LEFT", -8, 0)
	askText:SetJustifyH("LEFT")
	askText:SetWordWrap(false)
	ask:Hide()

	local resize = CreateFrame("Button", nil, frame, "PanelResizeButtonTemplate")
	resize:SetPoint("BOTTOMRIGHT", -2, 2)
	resize:Init(frame, 300, 180, 1200, 900)
	resize:HookScript("OnMouseUp", save)

	Style.OnChange(apply)
	apply()
	frame:SetShown(db.shown ~= false)
end

-- Shows the logged-in character's lines above what the window holds so far.
function Chat.Login()
	local key = format("%s-%s", UnitName("player") or "?", GetRealmName() or "?")
	db.histories[key] = db.histories[key] or {}
	local lines = db.histories[key]
	for i = #lines, 1, -1 do
		local line = lines[i]
		history:BackFillMessage(line[1], line[2], line[3], line[4])
	end
	kept = lines
end

function Chat.Init(saved)
	db = saved
	db.history = nil -- one history for all characters, before 0.3.1
	db.histories = db.histories or {}
	Style.Init(db)
	create()
	Tasks.Spawn("chat", function()
		while true do
			expire()
			refresh()
			Tasks.Sleep(0.25)
		end
	end)
end
