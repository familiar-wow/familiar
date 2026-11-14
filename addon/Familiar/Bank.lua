-- Down, app to addon: the font bank (ADR 0005). The app writes a 512-byte packet into the glyph
-- widths of a font the client has not loaded yet; the addon sets that font on a hidden font
-- string and measures every data glyph. Nothing in the file runs. Fonts:
-- core/src/transport/font.ts.
--
-- Two findings from FAM-15 shape the reader. After SetFont, a font string keeps measuring with
-- the font it had for a while, and GetFont does not name the new file yet: each read gets a fresh
-- font string and waits until GetFont names the file. And widths came out up to half a byte off,
-- which fits advances rounded to whole pixels: the font strings live in a frame scaled to one
-- pixel per unit, and two calibration glyphs turn widths into bytes.
local _, ns = ...
local Codec, Tasks = ns.Codec, ns.Tasks

local char, format, rep = string.char, string.format, string.rep
local floor = math.floor

local Bank = { FONTS = 256, BYTES = 512 }
ns.Bank = Bank

local ROOT = "Interface\\AddOns\\Familiar\\bank\\"
local SIZE = 64 -- font height at which the glyph for byte v is 16 + v pixels wide
local BATCH = 32 -- glyphs measured per frame
local RETRY = 0.5 -- seconds between attempts to set a font that has not loaded yet
local EMPTY = rep("\0", Bank.BYTES)

-- Each data glyph followed by "~", which ends every measurement the same way.
local GLYPHS = {}
for i = 0, Bank.BYTES - 1 do
	local code = 0xE000 + i
	GLYPHS[i + 1] = char(224 + floor(code / 4096), 128 + floor(code / 64) % 64, 128 + code % 64) .. "~"
end

function Bank.Path(slot)
	return format("%s%03d.ttf", ROOT, slot)
end

local holder

-- A fresh, invisible font string in a frame where one unit is one screen pixel.
local function newMeter()
	if not holder then
		holder = CreateFrame("Frame", nil, UIParent)
		holder:SetIgnoreParentScale(true)
		local _, height = GetPhysicalScreenSize()
		holder:SetScale(768 / height)
		holder:SetPoint("TOPLEFT")
		holder:SetSize(1, 1)
	end
	local meter = holder:CreateFontString(nil, "BACKGROUND", "GameFontNormal")
	meter:SetPoint("TOPLEFT")
	meter:SetAlpha(0)
	meter:SetWordWrap(false)
	meter:SetNonSpaceWrap(false)
	return meter
end

local function width(meter, text)
	meter:SetText(text)
	return meter:GetStringWidth()
end

-- Sets the font at `path` and waits until the client measures with it. Returns the font string
-- and the widths of byte 0 and 255, or nil when the font does not load within `timeout`.
local function load(path, timeout)
	local meter = newMeter()
	local started, tried = Tasks.Now(), -1
	while Tasks.Now() - started <= timeout do
		if Tasks.Now() - tried >= RETRY then
			tried = Tasks.Now()
			pcall(meter.SetFont, meter, path, SIZE, "")
			width(meter, "!~") -- laying out text starts the load
		end
		local current = meter:GetFont()
		if type(current) == "string" and current:lower() == path:lower() then
			local low, high = width(meter, "!~"), width(meter, '"~')
			if high - low >= 100 then
				return meter, low, high
			end
		end
		Tasks.Sleep(0)
	end
	meter:Hide()
end

-- All data glyphs as bytes, or nil if a width falls outside the byte range.
local function measure(meter, low, high)
	local values, scale = {}, 255 / (high - low)
	for i = 1, Bank.BYTES do
		local v = floor((width(meter, GLYPHS[i]) - low) * scale + 0.5)
		if v < 0 or v > 255 then
			return nil
		end
		values[i] = v
		if i % BATCH == 0 and i < Bank.BYTES then
			Tasks.Sleep(0)
		end
	end
	return char(unpack(values))
end

-- Reads font `slot` (task context): a packet that ends with the CRC-32 of the rest. Returns the
-- 512 bytes, or nil and why: "timeout", "unreadable", "empty" (never written) or "corrupt".
function Bank.Read(slot)
	local meter, low, high = load(Bank.Path(slot), 8)
	if not meter then
		return nil, "timeout"
	end
	local packet, why
	-- The client loaded the file once; measuring it again costs nothing.
	for _ = 1, 3 do
		packet, why = measure(meter, low, high), "unreadable"
		if packet == EMPTY then
			packet, why = nil, "empty"
			break
		elseif packet and Codec.Crc32(packet, 1, Bank.BYTES - 4) == Codec.ReadU32(packet, Bank.BYTES - 3) then
			break
		elseif packet then
			packet, why = nil, "corrupt"
		end
	end
	meter:SetText("")
	meter:Hide()
	return packet, packet == nil and why or nil
end

-- Whether a font at `path` loads at all within `timeout` seconds (task context).
function Bank.Loads(path, timeout)
	local meter = load(path, timeout)
	if meter then
		meter:Hide()
	end
	return meter ~= nil
end
