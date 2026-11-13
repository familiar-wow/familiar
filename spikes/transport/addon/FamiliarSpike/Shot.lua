-- Screenshot uplink, addon -> companion. A message becomes a block of cells next to the chat
-- box the player typed in. The addon paints it while hidden, a few hundred cells per frame,
-- then shows it, calls Screenshot() in the same frame and hides it in the next one: 0.4.1
-- showed that the picture is the frame of the call. The "hold" style keeps it one frame
-- longer. Black and white, or dark grey and black in the "muted" style. Layout: src/shot.ts.
local _, ns = ...

local band = bit.band
local byte, format, floor, max, min, ceil, sqrt = string.byte, string.format, math.floor, math.max, math.min, math.ceil, math.sqrt

local Shot = { MUTED = 1, SMALL = 2, WORLD = 4, HOLD = 8 }
ns.Shot = Shot

local QUIET, MUTED_LEVEL, PAINT_BATCH = 2, 0.3, 512
local STATUS_EVENTS = { "SCREENSHOT_STARTED", "SCREENSHOT_SUCCEEDED", "SCREENSHOT_FAILED" }

local heard = {}
local listener = CreateFrame("Frame")
for _, event in ipairs(STATUS_EVENTS) do
	listener:RegisterEvent(event)
end
listener:SetScript("OnEvent", function(_, event)
	heard[event] = heard[event] or ns.Probe.WallMs()
	-- Any picture, the player's too: file names count seconds, so a second one would replace it.
	if event == "SCREENSHOT_STARTED" then
		Shot.lastSecond = time()
	end
end)

function Shot.CVar(name)
	local ok, value = pcall(C_CVar.GetCVar, name)
	return ok and value or nil
end

-- Keeps Blizzard's "Screen captured" message off while we take a picture.
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

-- Ring columns and rows, both odd, about four times as wide as high. As in src/shot.ts.
function Shot.Layout(bytes)
	local bits = bytes * 8
	local dataRows = max(3, ceil(sqrt(bits / 4)))
	local dataCols = max(3, ceil(bits / dataRows))
	local cols, rows = dataCols + 2, dataRows + 2
	if cols % 2 == 0 then
		cols = cols + 1
	end
	if rows % 2 == 0 then
		rows = rows + 1
	end
	return cols, rows
end

-- One frame per parent, scaled so that one of its units is one physical pixel.
local holders, pools = {}, {}

local function holder(world)
	local key = world and "world" or "ui"
	if not holders[key] then
		local frame = CreateFrame("Frame", nil, world and WorldFrame or UIParent)
		frame:Hide()
		frame:SetFrameStrata("TOOLTIP")
		pcall(frame.SetIgnoreParentScale, frame, true)
		local _, height = GetPhysicalScreenSize()
		pcall(frame.SetScale, frame, 768 / height)
		holders[key], pools[key] = frame, {}
	end
	return holders[key], pools[key]
end

function Shot.Hide()
	for _, frame in pairs(holders) do
		frame:Hide()
	end
end

-- Bottom-left corner for the block in physical pixels: on top of the chat box the player typed
-- in, else on top of the default chat frame.
function Shot.Anchor(box)
	local width, height = GetPhysicalScreenSize()
	local k = height / 768
	local function corner(frame)
		if not (frame and frame.GetLeft and frame.GetTop and frame.GetEffectiveScale) then
			return nil
		end
		local left, top, scale = frame:GetLeft(), frame:GetTop(), frame:GetEffectiveScale()
		if left and top and scale then
			return left * scale * k, top * scale * k
		end
	end
	local x, y = corner(box)
	if not x then
		x, y = corner(_G.DEFAULT_CHAT_FRAME)
	end
	if not x then
		x, y = 0.02 * width, 0.3 * height
	end
	return { x = floor(x + 0.5), y = floor(y + 0.5) }
end

-- Paints the block while it is hidden, at most PAINT_BATCH cells per frame. Returns the time in
-- total, the most in one frame, and frames.
local function paint(frame, pool, bytes, cols, rows, px, level, sleep)
	local width, height = cols + 2 * QUIET, rows + 2 * QUIET
	local total, most, frames, done = 0, 0, 1, 0
	local started = debugprofilestop()
	local function step()
		done = done + 1
		if done >= PAINT_BATCH then
			local spent = debugprofilestop() - started
			ns.Probe.Charge(spent)
			total, most = total + spent, max(most, spent)
			sleep(0)
			frames, done, started = frames + 1, 0, debugprofilestop()
		end
	end
	for i = #pool + 1, width * height do
		local t = frame:CreateTexture(nil, "OVERLAY")
		if t.SetSnapToPixelGrid then
			t:SetSnapToPixelGrid(true)
			t:SetTexelSnappingBias(0)
		end
		pool[i] = t
		step()
	end
	local dataCols = cols - 2
	for r = 0, height - 1 do
		for c = 0, width - 1 do
			local on, rr, cc = false, r - QUIET, c - QUIET
			if rr >= 0 and cc >= 0 and rr < rows and cc < cols then
				if rr == 0 or cc == 0 or rr == rows - 1 or cc == cols - 1 then
					on = (rr + cc) % 2 == 0
				else
					local k = (rr - 1) * dataCols + cc - 1
					on = floor((byte(bytes, floor(k / 8) + 1) or 0) / 2 ^ (7 - k % 8)) % 2 == 1
				end
			end
			local t, v = pool[r * width + c + 1], on and level or 0
			t:ClearAllPoints()
			t:SetPoint("TOPLEFT", frame, "TOPLEFT", c * px, -r * px)
			t:SetSize(px, px)
			t:SetColorTexture(v, v, v, 1)
			t:Show()
			step()
		end
	end
	for i = width * height + 1, #pool do
		pool[i]:Hide()
	end
	local spent = debugprofilestop() - started
	ns.Probe.Charge(spent)
	return total + spent, max(most, spent), frames
end

-- Takes one picture of a message. `style` holds the Shot.MUTED, SMALL, WORLD and HOLD bits.
-- Returns a record; Shot.Format makes it a string.
function Shot.Take(bytes, style, anchor, sleep, formatName)
	local Probe = ns.Probe
	local hold = band(style, Shot.HOLD) ~= 0
	local px = band(style, Shot.SMALL) ~= 0 and 2 or 4
	local level = band(style, Shot.MUTED) ~= 0 and MUTED_LEVEL or 1
	local frame, pool = holder(band(style, Shot.WORLD) ~= 0)
	local cols, rows = Shot.Layout(#bytes)
	local w, h = (cols + 2 * QUIET) * px, (rows + 2 * QUIET) * px
	local screenW, screenH = GetPhysicalScreenSize()
	local x, y = min(max(0, anchor.x), screenW - w), min(max(0, anchor.y), screenH - h)
	frame:Hide()
	frame:ClearAllPoints()
	frame:SetPoint("BOTTOMLEFT", frame:GetParent(), "BOTTOMLEFT", x, y)
	frame:SetSize(w, h)
	local r = { style = style, format = formatName or Shot.CVar("screenshotFormat") or "?", bytes = #bytes }
	r.cols, r.rows, r.x, r.y, r.w, r.h = cols, rows, x, y, w, h
	r.paint, r.paintMax, r.paintFrames = paint(frame, pool, bytes, cols, rows, px, level, sleep)
	local quiet = Shot.Quiet(true)
	heard = {}
	frame:Show()
	r.called = Probe.WallMs()
	local ok = pcall(Screenshot)
	sleep(0)
	if hold then
		sleep(0)
	end
	frame:Hide()
	local worst, deadline = Probe.lastFrameMs or 0, Probe.Now() + 5
	while ok and not (heard.SCREENSHOT_SUCCEEDED or heard.SCREENSHOT_FAILED) and Probe.Now() < deadline do
		sleep(0)
		worst = max(worst, Probe.lastFrameMs or 0)
	end
	if quiet then
		Shot.Quiet(false)
	end
	r.started, r.done, r.worst = heard.SCREENSHOT_STARTED, heard.SCREENSHOT_SUCCEEDED or heard.SCREENSHOT_FAILED, worst
	r.result = not ok and "error" or heard.SCREENSHOT_SUCCEEDED and "saved" or heard.SCREENSHOT_FAILED and "failed" or "silent"
	return r
end

-- Format: "id,attempt,tag,style,format,bytes,cols,rows,x,y,w,h,paintMs,paintMaxMs,paintFrames,
-- calledMs,startedMs|-,doneMs|-,result,worstFrameMs". x and y are the block's bottom-left
-- corner in screen pixels, w and h its size with the quiet zone; tag names the test or the
-- setting it ran under.
function Shot.Format(r)
	local function stamp(t)
		return t and format("%.0f", t) or "-"
	end
	return format(
		"%d,%d,%s,%d,%s,%d,%d,%d,%d,%d,%d,%d,%.2f,%.2f,%d,%.0f,%s,%s,%s,%.1f",
		r.id or 0,
		r.attempt or 1,
		r.tag or "-",
		r.style,
		r.format,
		r.bytes,
		r.cols,
		r.rows,
		r.x,
		r.y,
		r.w,
		r.h,
		r.paint,
		r.paintMax,
		r.paintFrames,
		r.called,
		stamp(r.started),
		stamp(r.done),
		r.result,
		r.worst
	)
end
