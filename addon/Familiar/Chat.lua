-- The chat window (FAM-23): history, an input line, a status line that counts while the brain
-- works, and Allow/Deny when the agent asks for permission. Messages carry their kind on the
-- first line; formats: core/src/brain/chat.ts. Nothing here reads the game's chat (AGENTS.md,
-- rule 2), and text from the brain never becomes a link (rule 3).
local _, ns = ...
local Tasks, Transport = ns.Tasks, ns.Transport

local format, floor = string.format, math.floor

local Chat = {}
ns.Chat = Chat

local HISTORY = 200 -- lines kept per character across /reload
local MAX_BYTES = 400 -- per question: the lane carries about 0.9 KB/s
local YOU, FAMILIAR = "|cffffd100You:|r ", "|cff8fd1ffFamiliar:|r "
local GREY, TOOL = { 0.6, 0.6, 0.6 }, { 0.5, 0.7, 0.8 }

-- FamiliarDB.window: point, relativePoint, x, y, width, height and shown for every character;
-- histories["name-realm"]: the lines of each character, whose agent session is its own too
-- (core/src/brain/acp.ts).
local db
local kept -- the logged-in character's lines, once known
local frame, history, input, status, ask, askText
local pending, since, tool = 0, 0, nil
local requests = {} -- permission requests the player has not answered, oldest first

-- A | starts an escape sequence such as a link: || shows the character itself.
local function plain(text)
	return (text:gsub("\r", ""):gsub("|", "||"))
end

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

local function addLines(prefix, text, color)
	local first = true
	for line in plain(text):gmatch("[^\n]+") do
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
	row("name", UnitName("player"))
	row("realm", GetRealmName())
	row("level", UnitLevel("player"))
	row("race", (UnitRace("player")))
	row("class", (UnitClass("player")))
	row("faction", localizedFaction or faction)
	row("zone", zone)
	row("subzone", subzone ~= zone and subzone or nil)
	row("locale", GetLocale())
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
	addLines(YOU, text)
	if pending == 0 then
		since, tool = Tasks.Now(), nil
	end
	pending = pending + 1
	local started = Tasks.Now()
	Transport.Send("question\n" .. header() .. text, function(ok, why)
		if ok then
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
	if kind == "status" then
		tool = rest
		add("  > " .. plain(rest), TOOL)
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
		addLines(FAMILIAR, rest or body)
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

-- The window -----------------------------------------------------------------------------

local function save()
	local point, _, relativePoint, x, y = frame:GetPoint()
	db.point, db.relativePoint, db.x, db.y = point, relativePoint, x, y
	db.width, db.height = frame:GetWidth(), frame:GetHeight()
end

local function button(text, allow)
	local b = CreateFrame("Button", nil, ask, "UIPanelButtonTemplate")
	b:SetSize(80, 22)
	b:SetText(text)
	b:SetScript("OnClick", function()
		Chat.Answer(allow)
	end)
	return b
end

local function create()
	frame = CreateFrame("Frame", "FamiliarChatFrame", UIParent, "BasicFrameTemplateWithInset")
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
	end)
	frame:SetSize(db.width or 420, db.height or 300)
	frame:SetPoint(db.point or "CENTER", UIParent, db.relativePoint or "CENTER", db.x or 0, db.y or 0)
	if frame.TitleText then
		frame.TitleText:SetText("Familiar")
	end
	-- Escape closes the window, like other panels.
	table.insert(UISpecialFrames, "FamiliarChatFrame")

	history = CreateFrame("ScrollingMessageFrame", nil, frame)
	history:SetPoint("TOPLEFT", 12, -30)
	history:SetPoint("BOTTOMRIGHT", -12, 62)
	history:SetFontObject(ChatFontNormal)
	history:SetJustifyH("LEFT")
	history:SetFading(false)
	history:SetMaxLines(HISTORY * 2)
	history:EnableMouseWheel(true)
	history:SetScript("OnMouseWheel", function(self, delta)
		if delta > 0 then
			self:ScrollUp()
		else
			self:ScrollDown()
		end
	end)
	status = frame:CreateFontString(nil, "OVERLAY", "GameFontDisableSmall")
	status:SetPoint("BOTTOMLEFT", 14, 40)
	status:SetPoint("BOTTOMRIGHT", -14, 40)
	status:SetJustifyH("LEFT")
	status:SetWordWrap(false)

	ask = CreateFrame("Frame", nil, frame)
	ask:SetPoint("BOTTOMLEFT", 12, 34)
	ask:SetPoint("BOTTOMRIGHT", -12, 34)
	ask:SetHeight(24)
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

	input = CreateFrame("EditBox", nil, frame, "InputBoxTemplate")
	input:SetPoint("BOTTOMLEFT", 18, 10)
	input:SetPoint("BOTTOMRIGHT", -26, 10)
	input:SetHeight(20)
	input:SetAutoFocus(false)
	input:SetMaxBytes(MAX_BYTES)
	input:SetScript("OnEnterPressed", function(self)
		local text = self:GetText()
		self:SetText("")
		self:ClearFocus()
		Chat.Ask(text)
	end)
	input:SetScript("OnEscapePressed", input.ClearFocus)

	local resize = CreateFrame("Button", nil, frame, "PanelResizeButtonTemplate")
	resize:SetPoint("BOTTOMRIGHT", -2, 2)
	resize:Init(frame, 300, 180, 1200, 900)
	resize:HookScript("OnMouseUp", save)

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
	create()
	Tasks.Spawn("chat", function()
		while true do
			refresh()
			Tasks.Sleep(0.25)
		end
	end)
end
