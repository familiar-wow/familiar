-- Font bank, companion -> addon: the companion writes bytes into the glyph widths of TrueType
-- fonts the client has not loaded yet; the addon sets such a font on a hidden font string and
-- measures every data glyph. Nothing in the file runs. The client reads a font file only on its
-- first use per process, so every file carries one packet per process. Format: src/font.ts.
--
-- Two findings from build 70888 shape the reader. After SetFont, a font string that already
-- shows one of our fonts keeps measuring with it at first, and GetFont does not name the new
-- file yet; the calibration glyphs are alike in every font of the bank, so they cannot tell.
-- Each read therefore gets a fresh font string and waits until GetFont names the new file.
-- And widths came out close to half a byte off, which fits glyph advances rounded to whole
-- pixels in UI units that are not one pixel. The font strings live in a frame scaled to one
-- pixel per unit.
local _, ns = ...
local Wire = ns.Wire

local char, format, floor, abs = string.char, string.format, math.floor, math.abs

local Font = { BANK = 256, PACKET = 512 }
ns.Font = Font

local ROOT = "Interface\\AddOns\\FamiliarSpike\\fonts\\"
local SIZE = 64 -- font height: a data glyph for byte v is 48 + v wide, "~" included
local BATCH = 32 -- glyph measurements per frame
local TIMEOUT, RETRY = 8, 0.5 -- seconds

-- Every data glyph with the "~" that follows it in each measurement.
local GLYPHS = {}
for i = 0, Font.PACKET - 1 do
	local code = 0xE000 + i
	GLYPHS[i] = char(224 + floor(code / 4096), 128 + floor(code / 64) % 64, 128 + code % 64) .. "~"
end

local holder

-- One UI unit of this frame is one physical pixel.
local function getHolder()
	if not holder then
		holder = CreateFrame("Frame", nil, UIParent)
		pcall(holder.SetIgnoreParentScale, holder, true)
		local _, height = GetPhysicalScreenSize()
		pcall(holder.SetScale, holder, 768 / height)
		holder:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 0, 0)
		holder:SetSize(1, 1)
	end
	return holder
end

local function newMeter()
	local m = getHolder():CreateFontString(nil, "OVERLAY", "GameFontNormal")
	m:SetPoint("TOPLEFT", holder, "TOPLEFT", 0, 0)
	m:SetAlpha(0)
	m:SetWordWrap(false)
	m:SetNonSpaceWrap(false)
	return m
end

local function width(m, text)
	m:SetText(text)
	return m:GetStringWidth()
end

local function calibrate(m)
	local okLow, low = pcall(width, m, "!~")
	local okHigh, high = pcall(width, m, '"~')
	if okLow and okHigh and low and high and high - low >= 100 then
		return low, high
	end
end

function Font.Path(slot)
	return format("%sF%03d.ttf", ROOT, slot)
end

-- A client process starts with an empty font cache, so its first session may use the bank
-- from the start again. GetSessionTime counts from the client's start; a /reload or a
-- character switch keeps the process and the cache. Returns true for a new process.
function Font.Begin(db)
	local process = GetSessionTime and (time() - floor(GetSessionTime())) or nil
	if process and (not db.fontProcess or abs(process - db.fontProcess) > 10) then
		db.fontProcess, db.fontNext = process, 1
		return true
	end
	db.fontNext = db.fontNext or 1
	return false
end

-- The next unused file, or nil when the bank is used up for this process.
function Font.Next(db)
	local slot = db.fontNext or 1
	if slot > Font.BANK then
		return nil
	end
	db.fontNext = slot + 1
	return slot
end

-- Reads one font. `sleep` yields to the next frame, `charge` books our time in a frame.
-- Results: ok, placeholder (never written by the companion), other (the packet names another
-- slot), corrupt (checksum), unstable (checksum, and the calibration changed while measuring),
-- unreadable (a width outside the byte range), timeout (the font never became usable).
function Font.Read(slot, sleep, charge)
	local m, path = newMeter(), Font.Path(slot)
	local r = { slot = slot, start = ns.Probe.WallMs(), counter = 0, epoch = 0, written = 0, header = -1 }
	local started = debugprofilestop()
	local ok, set = pcall(m.SetFont, m, path, SIZE, "")
	r.set = ok and (set and 1 or 0) or -1
	-- Laying out text starts a lazy load; waiting for SetFont alone can stall it.
	pcall(width, m, "!~")
	local low, high, lastTry, frames = nil, nil, started, 0
	while true do
		local current = m:GetFont()
		r.matched = type(current) == "string" and current:lower() == path:lower()
		if r.matched then
			low, high = calibrate(m)
			if low then
				break
			end
		end
		local elapsed = debugprofilestop() - started
		if elapsed > TIMEOUT * 1000 then
			r.result, r.ready, r.readyFrames = "timeout", elapsed, frames
			m:Hide()
			return r
		end
		if debugprofilestop() - lastTry >= RETRY * 1000 then
			lastTry = debugprofilestop()
			pcall(m.SetFont, m, path, SIZE, "")
			pcall(width, m, "!~")
		end
		frames = frames + 1
		sleep(0)
	end
	r.ready, r.readyFrames, r.low, r.high = debugprofilestop() - started, frames, low, high

	-- Widths off the integer grid are kept, not rejected: the checksum decides, and the largest
	-- deviation shows how much room the channel has.
	local values, scale, i, dev = {}, 255 / (high - low), 0, 0
	local decodeStarted, decodeFrames, worst = debugprofilestop(), 0, 0
	while i < Font.PACKET do
		local batchStarted = debugprofilestop()
		for _ = 1, BATCH do
			local v = (width(m, GLYPHS[i]) - low) * scale
			local n = floor(v + 0.5)
			if n < 0 or n > 255 then
				r.result, r.dev = "unreadable", abs(v - n)
				r.decode, r.decodeFrames, r.cost = debugprofilestop() - decodeStarted, decodeFrames, worst
				m:Hide()
				return r
			end
			if abs(v - n) > dev then
				dev = abs(v - n)
			end
			values[i + 1] = n
			i = i + 1
		end
		local spent = debugprofilestop() - batchStarted
		charge(spent)
		if spent > worst then
			worst = spent
		end
		decodeFrames = decodeFrames + 1
		if i < Font.PACKET then
			sleep(0)
		end
	end
	r.decode, r.decodeFrames, r.cost, r.dev = debugprofilestop() - decodeStarted, decodeFrames, worst, dev
	-- The font must not have changed under the measurement.
	local lowAfter, highAfter = calibrate(m)
	local stable = lowAfter == low and highAfter == high
	m:SetText("")
	m:Hide()

	local packet = char(unpack(values))
	if packet:sub(1, 2) == "FF" then
		r.header = Wire.ReadU16(packet, 5)
	end
	if packet:sub(1, 2) ~= "FF" and packet == string.rep("\0", Font.PACKET) then
		r.result = "placeholder"
	elseif packet:sub(1, 2) ~= "FF" or Wire.Crc32(packet, 1, Font.PACKET - 4) ~= Wire.ReadU32(packet, Font.PACKET - 3) then
		r.result = stable and "corrupt" or "unstable"
	else
		r.epoch = packet:byte(4)
		r.counter = Wire.ReadU32(packet, 7)
		r.written = Wire.ReadU48(packet, 11)
		r.result = r.header == slot and "ok" or "other"
	end
	return r
end

-- Format: "slot,startMs,set,matched,readyMs,readyFrames,decodeMs,decodeFrames,worstFrameMs,
-- epoch,counter,writtenMs,result,maxDeviation,low,high,headerSlot". set is 1 or 0 as SetFont
-- returned, -1 if it raised; maxDeviation is the largest distance of a measured byte from its
-- integer; low and high are the calibration widths (48 and 303 at one pixel per unit);
-- headerSlot is the slot named in the packet header, -1 without a header.
function Font.Format(r)
	return format(
		"%d,%.0f,%d,%d,%.1f,%d,%.1f,%d,%.3f,%d,%d,%.0f,%s,%.3f,%.3f,%.3f,%d",
		r.slot,
		r.start,
		r.set or -1,
		r.matched and 1 or 0,
		r.ready or 0,
		r.readyFrames or 0,
		r.decode or 0,
		r.decodeFrames or 0,
		r.cost or 0,
		r.epoch or 0,
		r.counter or 0,
		r.written or 0,
		r.result or "?",
		r.dev or 0,
		r.low or 0,
		r.high or 0,
		r.header or -1
	)
end
