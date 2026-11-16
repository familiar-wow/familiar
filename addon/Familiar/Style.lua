-- How the window looks (FAM-39): a flat, dark skin, the player's settings and the panel that
-- changes them. Chat.lua builds the window from these parts and applies the settings.
local _, ns = ...

local Style = {}
ns.Style = Style

local DEFAULTS = {
	font = "chat",
	size = 14,
	outline = false,
	opacity = 85, -- percent
	scale = 100, -- percent
	accent = "blue",
	copy = true,
}
-- The client's own font objects, so every locale gets a file that has its letters.
local FONTS = {
	{ "chat", "Chat", "ChatFontNormal" },
	{ "game", "Game", "GameFontNormal" },
	{ "quest", "Quest", "QuestFont" },
}
local ACCENTS = {
	{ "blue", 0.30, 0.60, 1.00 },
	{ "gold", 1.00, 0.82, 0.00 },
	{ "green", 0.35, 0.80, 0.45 },
	{ "purple", 0.66, 0.47, 0.95 },
	{ "red", 0.92, 0.38, 0.38 },
	{ "white", 0.90, 0.90, 0.92 },
}
local BACK, FIELD, LINE = { 0.04, 0.05, 0.08 }, { 0.09, 0.10, 0.15 }, { 0.22, 0.24, 0.31 }
local WIDTH = 220

-- FamiliarDB.window.style: only what the player changed, for all characters.
local db
local listeners = {}
local panel

local function entry(list, key)
	for _, row in ipairs(list) do
		if row[1] == key then
			return row
		end
	end
	return list[1]
end

function Style.Get(key)
	local value = db[key]
	if value == nil then
		return DEFAULTS[key]
	end
	return value
end

local function changed()
	for _, listener in ipairs(listeners) do
		listener()
	end
end

local function set(key, value)
	if Style.Get(key) ~= value then
		db[key] = value
		changed()
	end
end

-- Calls `listener` after every change of a setting.
function Style.OnChange(listener)
	listeners[#listeners + 1] = listener
end

function Style.Accent()
	local accent = entry(ACCENTS, Style.Get("accent"))
	return accent[2], accent[3], accent[4]
end

-- File, height and flags for the history and the input line.
function Style.Font()
	local object = _G[entry(FONTS, Style.Get("font"))[3]] or ChatFontNormal
	return (object:GetFont()), Style.Get("size"), Style.Get("outline") and "OUTLINE" or ""
end

-- Parts ----------------------------------------------------------------------------------

local function fill(frame, color, alpha)
	local texture = frame:CreateTexture(nil, "BACKGROUND")
	texture:SetAllPoints(frame)
	texture:SetColorTexture(color[1], color[2], color[3], alpha or 1)
	return texture
end

-- A line around `frame`. Returns a function that colors it.
local function border(frame)
	local sides = {}
	for i, corners in ipairs({
		{ "TOPLEFT", "TOPRIGHT" },
		{ "BOTTOMLEFT", "BOTTOMRIGHT" },
		{ "TOPLEFT", "BOTTOMLEFT" },
		{ "TOPRIGHT", "BOTTOMRIGHT" },
	}) do
		local side = frame:CreateTexture(nil, "BORDER")
		side:SetPoint(corners[1])
		side:SetPoint(corners[2])
		if i <= 2 then
			side:SetHeight(1)
		else
			side:SetWidth(1)
		end
		sides[i] = side
	end
	local function color(r, g, b, a)
		for _, side in ipairs(sides) do
			side:SetColorTexture(r, g, b, a or 1)
		end
	end
	color(LINE[1], LINE[2], LINE[3])
	return color
end

-- The dark background of a window. Returns a function that sets how opaque it is, 0 to 1; at 0
-- the line around it goes too.
function Style.Window(frame)
	local back, edge = fill(frame, BACK), border(frame)
	return function(alpha)
		back:SetColorTexture(BACK[1], BACK[2], BACK[3], alpha)
		edge(LINE[1], LINE[2], LINE[3], alpha > 0 and 1 or 0)
	end
end

-- A field to type or click in. Returns a function that marks it, as for focus or hover.
function Style.Field(frame)
	fill(frame, FIELD)
	local edge = border(frame)
	return function(marked)
		if marked then
			edge(Style.Accent())
		else
			edge(LINE[1], LINE[2], LINE[3])
		end
	end
end

local function label(frame, text, template)
	local caption = frame:CreateFontString(nil, "OVERLAY", template or "GameFontHighlightSmall")
	caption:SetText(text)
	return caption
end

function Style.Button(parent, text, width, onClick)
	local button = CreateFrame("Button", nil, parent)
	button:SetSize(width, 20)
	local mark = Style.Field(button)
	label(button, text):SetPoint("CENTER")
	button:SetScript("OnClick", onClick)
	button:SetScript("OnEnter", function()
		mark(true)
	end)
	button:SetScript("OnLeave", function()
		mark(false)
	end)
	return button
end

-- The settings panel ---------------------------------------------------------------------

-- Each control shows its setting again after every change, so Reset reaches all of them.
local function follow(refresh)
	Style.OnChange(refresh)
	refresh()
end

local function row(height)
	local frame = CreateFrame("Frame", nil, panel)
	frame:SetHeight(height)
	return frame
end

local function heading(text)
	local frame = row(14)
	local caption = label(frame, text, "GameFontNormalSmall")
	caption:SetPoint("LEFT")
	follow(function()
		caption:SetTextColor(Style.Accent())
	end)
	return frame
end

-- A slider for a whole number. `live` settings follow the thumb; the others wait for the mouse
-- button, as the scale moves the window the panel hangs on.
local function slider(text, key, low, high, step, pattern, live)
	local frame = row(32)
	label(frame, text):SetPoint("TOPLEFT")
	local value = label(frame, "")
	value:SetPoint("TOPRIGHT")

	local bar = CreateFrame("Slider", nil, frame)
	bar:SetPoint("BOTTOMLEFT", 0, 2)
	bar:SetPoint("BOTTOMRIGHT", 0, 2)
	bar:SetHeight(12)
	bar:SetOrientation("HORIZONTAL")
	bar:SetMinMaxValues(low, high)
	bar:SetValueStep(step)
	bar:SetObeyStepOnDrag(true)
	bar:EnableMouse(true)
	local track = bar:CreateTexture(nil, "BACKGROUND")
	track:SetPoint("LEFT")
	track:SetPoint("RIGHT")
	track:SetHeight(4)
	track:SetColorTexture(LINE[1], LINE[2], LINE[3])
	local thumb = bar:CreateTexture(nil, "OVERLAY")
	thumb:SetSize(8, 14)
	bar:SetThumbTexture(thumb)
	local filled = bar:CreateTexture(nil, "ARTWORK")
	filled:SetPoint("LEFT", track, "LEFT")
	filled:SetPoint("RIGHT", thumb, "CENTER")
	filled:SetHeight(4)

	local function chosen()
		return math.floor(bar:GetValue() / step + 0.5) * step
	end
	bar:SetScript("OnValueChanged", function()
		value:SetText(pattern:format(chosen()))
		if live then
			set(key, chosen())
		end
	end)
	bar:SetScript("OnMouseUp", function()
		set(key, chosen())
	end)
	follow(function()
		local r, g, b = Style.Accent()
		thumb:SetColorTexture(r, g, b)
		filled:SetColorTexture(r, g, b)
		bar:SetValue(Style.Get(key))
		value:SetText(pattern:format(Style.Get(key)))
	end)
	return frame
end

local function toggle(text, key)
	local button = CreateFrame("Button", nil, panel)
	button:SetHeight(18)
	label(button, text):SetPoint("LEFT")
	local box = CreateFrame("Frame", nil, button)
	box:SetSize(14, 14)
	box:SetPoint("RIGHT")
	Style.Field(box)
	local on = box:CreateTexture(nil, "ARTWORK")
	on:SetPoint("TOPLEFT", 3, -3)
	on:SetPoint("BOTTOMRIGHT", -3, 3)
	button:SetScript("OnClick", function()
		set(key, not Style.Get(key))
	end)
	follow(function()
		on:SetColorTexture(Style.Accent())
		on:SetShown(Style.Get(key))
	end)
	return button
end

-- A click moves on to the next font.
local function fonts()
	local button = CreateFrame("Button", nil, panel)
	button:SetHeight(18)
	label(button, "Font"):SetPoint("LEFT")
	local value = label(button, "")
	value:SetPoint("RIGHT")
	button:SetScript("OnClick", function()
		for i, font in ipairs(FONTS) do
			if font[1] == entry(FONTS, Style.Get("font"))[1] then
				return set("font", FONTS[i % #FONTS + 1][1])
			end
		end
	end)
	follow(function()
		value:SetText(entry(FONTS, Style.Get("font"))[2])
		value:SetTextColor(Style.Accent())
	end)
	return button
end

local function accents()
	local frame = row(18)
	label(frame, "Accent"):SetPoint("LEFT")
	for i, accent in ipairs(ACCENTS) do
		local swatch = CreateFrame("Button", nil, frame)
		swatch:SetSize(14, 14)
		swatch:SetPoint("RIGHT", (i - #ACCENTS) * 18, 0)
		fill(swatch, { accent[2], accent[3], accent[4] })
		local edge = border(swatch)
		swatch:SetScript("OnClick", function()
			set("accent", accent[1])
		end)
		follow(function()
			if entry(ACCENTS, Style.Get("accent")) == accent then
				edge(1, 1, 1)
			else
				edge(LINE[1], LINE[2], LINE[3])
			end
		end)
	end
	return frame
end

local function build(window)
	panel = CreateFrame("Frame", nil, UIParent)
	panel:SetFrameStrata("HIGH")
	panel:SetClampedToScreen(true)
	panel:EnableMouse(true)
	panel:SetPoint("TOPLEFT", window, "TOPRIGHT", 4, 0)
	Style.Window(panel)(0.95)

	local y = 12
	local function add(region, gap)
		region:SetPoint("TOPLEFT", 12, -y)
		region:SetPoint("TOPRIGHT", -12, -y)
		y = y + region:GetHeight() + (gap or 8)
	end
	add(heading("TEXT"))
	add(fonts())
	add(slider("Size", "size", 10, 24, 1, "%d", true))
	add(toggle("Outline", "outline"), 16)
	add(heading("WINDOW"))
	add(slider("Background", "opacity", 0, 100, 5, "%d%%", true))
	add(slider("Scale", "scale", 70, 150, 5, "%d%%", false))
	add(accents())
	add(toggle("Select text to copy", "copy"), 16)
	local reset = Style.Button(panel, "Reset", 60, function()
		for key in pairs(DEFAULTS) do
			db[key] = nil
		end
		changed()
	end)
	reset:SetPoint("TOPRIGHT", -12, -y)
	panel:SetSize(WIDTH, y + reset:GetHeight() + 12)
end

-- Opens and closes the settings next to `window`.
function Style.Toggle(window)
	if not panel then
		build(window)
	else
		panel:SetShown(not panel:IsShown())
	end
end

function Style.Hide()
	if panel then
		panel:Hide()
	end
end

function Style.Init(saved)
	saved.style = saved.style or {}
	db = saved.style
end
