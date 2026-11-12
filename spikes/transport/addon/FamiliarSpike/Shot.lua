-- Screenshot uplink, addon -> companion: the addon paints a block of cells into the top-left
-- corner, calls Screenshot() and hides the block again; the companion reads the file from the
-- Screenshots folder. Layout and variants: src/shot.ts.
--
-- The block has two layers: the sync border (row 0 and column 0) and the data cells. The data
-- is painted while the block is hidden, a few hundred cells per frame. A take keeps the data
-- up until the client reports the file saved, or hides it a given number of frames after the
-- call: that shows when the client captures the picture. The border stays until the file is
-- saved either way, so the companion can tell every one of our pictures from the player's.
local _, ns = ...
local Wire = ns.Wire

local char, format, floor, max = string.char, string.format, math.floor, math.max
local concat = table.concat

local Shot = {}
ns.Shot = Shot

local COLS, ROWS, CELL_PX = 258, 34, 4
local DATA_COLS, DATA_ROWS = 256, 32
local PAINT_BATCH = 512 -- cells painted per frame
Shot.VARIANTS = {
	A = { id = 1, cell = 2, bits = 1 },
	B = { id = 2, cell = 1, bits = 1 },
	C = { id = 3, cell = 1, bits = 2 },
	D = { id = 4, cell = 1, bits = 3 },
	E = { id = 5, cell = 1, bits = 24 },
}
local FORMATS = { jpeg = 1, jpg = 1, png = 2, tga = 3 }
local STATUS_EVENTS = { "SCREENSHOT_STARTED", "SCREENSHOT_SUCCEEDED", "SCREENSHOT_FAILED" }

local sync, data, cells, geometry
local heard = {}

local listener = CreateFrame("Frame")
for _, event in ipairs(STATUS_EVENTS) do
	listener:RegisterEvent(event)
end
listener:SetScript("OnEvent", function(_, event)
	heard[event] = heard[event] or ns.Probe.WallMs()
end)

local function capacity(v)
	return (DATA_COLS / v.cell) * (DATA_ROWS / v.cell) * v.bits / 8
end

-- Payload byte j (0-based), as in src/shot.ts shotByte().
local function payloadByte(seq, j)
	return (seq * 13 + j * 29 + floor(j / 256) * 7) % 251
end

function Shot.CVar(name)
	local ok, value = pcall(C_CVar.GetCVar, name)
	return ok and value or nil
end

function Shot.SetFormat(value)
	local ok, success = pcall(C_CVar.SetCVar, "screenshotFormat", value)
	return ok and success ~= false and Shot.CVar("screenshotFormat") == value
end

-- Keeps Blizzard's "Screen captured" message off while we take pictures.
function Shot.Quiet(on)
	local status = _G.ActionStatus
	if not (status and status.UnregisterEvent and status.RegisterEvent) then
		return false
	end
	for _, event in ipairs(STATUS_EVENTS) do
		pcall(on and status.UnregisterEvent or status.RegisterEvent, status, event)
	end
	return true
end

-- Creates the block once: 258 x 34 textures on the physical pixel grid, spread over frames.
function Shot.Build(sleep)
	if sync then
		return geometry
	end
	local layers = {}
	for k = 1, 2 do
		local frame = CreateFrame("Frame", nil, UIParent)
		frame:Hide()
		frame:SetFrameStrata("TOOLTIP")
		pcall(frame.SetIgnoreParentScale, frame, true)
		pcall(frame.SetScale, frame, 1)
		frame:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 0, 0)
		layers[k] = frame
	end
	local border, body = layers[1], layers[2]
	local width, height = GetPhysicalScreenSize()
	local size = CELL_PX * 768 / height / body:GetEffectiveScale()
	border:SetSize(COLS * size, ROWS * size)
	body:SetSize(COLS * size, ROWS * size)
	cells = {}
	for r = 0, ROWS - 1 do
		for c = 0, COLS - 1 do
			local parent = (r == 0 or c == 0) and border or body
			local t = parent:CreateTexture(nil, "OVERLAY")
			t:SetPoint("TOPLEFT", parent, "TOPLEFT", c * size, -r * size)
			t:SetSize(size, size)
			if t.SetSnapToPixelGrid then
				t:SetSnapToPixelGrid(true)
				t:SetTexelSnappingBias(0)
			end
			local v = 0
			if r == 0 then
				v = c % 2 == 0 and 1 or 0
			elseif c == 0 then
				v = r % 2 == 0 and 1 or 0
			end
			t:SetColorTexture(v, v, v, 1)
			cells[r * COLS + c] = t
		end
		if r % 3 == 2 then
			sleep(0)
		end
	end
	sync, data = border, body
	geometry = format("%dx%d px, block scale %.4f", width, height, body:GetEffectiveScale())
	return geometry
end

function Shot.Hide()
	if sync then
		sync:Hide()
		data:Hide()
	end
end

local function frameBytes(v, epoch, seq, formatCode, wallMs)
	local n = capacity(v) - 20
	local payload = {}
	for j = 0, n - 1 do
		payload[j + 1] = char(payloadByte(seq, j))
	end
	local body = "FSS"
		.. char(v.id, epoch)
		.. Wire.U16(seq)
		.. char(formatCode)
		.. Wire.U48(wallMs)
		.. Wire.U16(n)
		.. concat(payload)
	return body .. Wire.U32(Wire.Crc32(body))
end

-- Paints a frame while the block is hidden: bits MSB first, data cells row by row, at most
-- PAINT_BATCH cells per frame. Returns the time in total, the most in one frame, and frames.
local function paint(v, bytes, sleep)
	local cell, bits = v.cell, v.bits
	local levels = 2 ^ bits - 1
	local acc, have, pos = 0, 0, 1
	local total, most, frames, painted = 0, 0, 1, 0
	local batchStarted = debugprofilestop()
	for lr = 0, DATA_ROWS / cell - 1 do
		for lc = 0, DATA_COLS / cell - 1 do
			if painted >= PAINT_BATCH then
				local spent = debugprofilestop() - batchStarted
				ns.Probe.Charge(spent)
				total, most = total + spent, max(most, spent)
				sleep(0)
				frames, painted, batchStarted = frames + 1, 0, debugprofilestop()
			end
			while have < bits do
				acc, have, pos = acc * 256 + bytes:byte(pos), have + 8, pos + 1
			end
			local shift = 2 ^ (have - bits)
			local value = floor(acc / shift)
			acc, have = acc - value * shift, have - bits
			local red, green, blue
			if bits == 24 then
				red, green, blue = floor(value / 65536) / 255, floor(value / 256) % 256 / 255, value % 256 / 255
			else
				red = value / levels
				green, blue = red, red
			end
			for dy = 0, cell - 1 do
				local row = (1 + lr * cell + dy) * COLS + 1 + lc * cell
				for dx = 0, cell - 1 do
					cells[row + dx]:SetColorTexture(red, green, blue, 1)
				end
			end
			painted = painted + cell * cell
		end
	end
	local spent = debugprofilestop() - batchStarted
	ns.Probe.Charge(spent)
	return total + spent, max(most, spent), frames
end

-- Takes one screenshot. `hide` is nil to keep the data up until the file is saved, or the
-- number of frames after the call's frame after which the data goes. Returns the record
-- "seq,variant,format,drawnMs,calledMs,startedMs|-,doneMs|-,result,paintMs,frames,
-- worstFrameMs,hide|-,paintMaxMs,paintFrames" where frames counts the frames the border stayed
-- up after the call and worstFrameMs is the longest frame from the call until a second after.
function Shot.Take(name, hide, epoch, seq, formatName, sleep)
	local v = Shot.VARIANTS[name]
	local Probe = ns.Probe
	local drawn = Probe.WallMs()
	local paintMs, paintMax, paintFrames =
		paint(v, frameBytes(v, epoch, seq, FORMATS[formatName or ""] or 0, drawn), sleep)
	sync:Show()
	data:Show()
	sleep(0) -- one rendered frame with the block before the call
	heard = {}
	local called = Probe.WallMs()
	local ok = pcall(Screenshot)
	if hide == 0 then
		data:Hide()
	end
	local frames, worst, deadline = 0, 0, Probe.Now() + 5
	while ok and not (heard.SCREENSHOT_SUCCEEDED or heard.SCREENSHOT_FAILED) and Probe.Now() < deadline do
		sleep(0)
		frames, worst = frames + 1, max(worst, Probe.lastFrameMs or 0)
		if frames == hide then
			data:Hide()
		end
	end
	Shot.Hide()
	local after = Probe.Now() + 1
	while Probe.Now() < after do
		sleep(0)
		worst = max(worst, Probe.lastFrameMs or 0)
	end
	local result = not ok and "error"
		or heard.SCREENSHOT_SUCCEEDED and "saved"
		or heard.SCREENSHOT_FAILED and "failed"
		or "silent"
	local function stamp(t)
		return t and format("%.0f", t) or "-"
	end
	return format(
		"%d,%s,%s,%.0f,%.0f,%s,%s,%s,%.2f,%d,%.1f,%s,%.2f,%d",
		seq,
		name,
		formatName or "?",
		drawn,
		called,
		stamp(heard.SCREENSHOT_STARTED),
		stamp(heard.SCREENSHOT_SUCCEEDED or heard.SCREENSHOT_FAILED),
		result,
		paintMs,
		frames,
		worst,
		hide and tostring(hide) or "-",
		paintMax,
		paintFrames
	)
end
