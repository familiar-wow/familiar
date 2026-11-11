-- Benchmark and soak probes, run as coroutines from Spike.lua's OnUpdate.
--
-- Channels under test:
--   uplink   AddOns.txt lane U (addon writes, companion reads)
--   signals  pre-created .wav files the companion makes playable (PlaySoundFile)
--   slots    load-on-demand addons whose data.lua the companion rewrites
--   downlink AddOns.txt lane D (companion writes, addon reads after ResetAddOns)
--
-- Every record is a compact string so SavedVariables stay small. The companion's
-- report parses them; the formats are listed next to the functions that build them.
local _, ns = ...
local Wire = ns.Wire

local char, format, floor, max = string.char, string.format, math.floor, math.max
local concat, sort = table.concat, table.sort
local U16, U32 = Wire.U16, Wire.U32

local Probe = { tasks = {}, phase = "idle", spent = 0, carry = 0, soakOk = 0, soakFailed = 0 }
ns.Probe = Probe

local ROOT = "Interface\\AddOns\\FamiliarSpike\\"
local SIGNALS, SLOTS = 600, 64
local ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
local UPLINK = {
	{ stream = 1, interval = 0 }, -- every rendered frame
	{ stream = 2, interval = 0.033 },
	{ stream = 3, interval = 0.066 },
	{ stream = 4, interval = 0.1 },
}
local SLOT_SIZES = { 2048, 2048, 2048, 16384, 131072, 1048576 }
local FRAME_BOUNDS = { 8, 12, 17, 25, 34, 50, 100 } -- ms; one extra bin catches the rest

local function fast()
	return FamiliarSpike_Fast == true -- set only by the offline simulator
end

local precise = GetTimePreciseSec or function()
	return debugprofilestop() / 1000
end

function Probe.Now()
	return precise()
end

-- Wall clock ------------------------------------------------------------------
-- time() ticks in whole seconds. At the first frame after a tick the true offset is
-- at least second - now, so the largest estimate over many ticks converges on it.
local clock = { edges = 0 }

local function updateClock(now)
	local second = time()
	if clock.second and second ~= clock.second and clock.edges < 120 then
		local estimate = second - now
		if not clock.offset or estimate > clock.offset then
			clock.offset = estimate
		end
		clock.edges = clock.edges + 1
	end
	clock.second = second
end

function Probe.WallMs(now)
	return ((now or precise()) + (clock.offset or 0)) * 1000
end

-- Context and events ----------------------------------------------------------
function Probe.ListOpen()
	local list = _G.AddonList
	return list ~= nil and list:IsShown() and true or false
end

function Probe.Context()
	local parts = {}
	if InCombatLockdown() then
		parts[#parts + 1] = "combat"
	end
	local inside, kind = IsInInstance()
	if inside and kind then
		parts[#parts + 1] = kind
	end
	if Probe.ListOpen() then
		parts[#parts + 1] = "addonlist"
	end
	return #parts > 0 and concat(parts, "+") or "-"
end

-- Format: "wallMs|event|detail"
function Probe.Event(name, detail)
	local session = ns.session
	if session and #session.events < 400 then
		session.events[#session.events + 1] = format("%.0f|%s|%s", Probe.WallMs(), name, detail or "")
	end
end

-- Frame times -----------------------------------------------------------------
local frameStats, hitches = {}, {}

local function recordFrame(elapsedMs)
	local stats = frameStats[Probe.phase]
	if not stats then
		stats = { n = 0, sum = 0, max = 0, counts = {} }
		for i = 1, #FRAME_BOUNDS + 1 do
			stats.counts[i] = 0
		end
		frameStats[Probe.phase] = stats
	end
	local bin = #FRAME_BOUNDS + 1
	for i, bound in ipairs(FRAME_BOUNDS) do
		if elapsedMs < bound then
			bin = i
			break
		end
	end
	stats.counts[bin] = stats.counts[bin] + 1
	stats.n, stats.sum, stats.max = stats.n + 1, stats.sum + elapsedMs, max(stats.max, elapsedMs)
	-- Format: "wallMs,frameMs,phase,ourMsInPreviousFrame,context"
	if elapsedMs >= 50 and #hitches < 600 then
		hitches[#hitches + 1] =
			format("%.0f,%.1f,%s,%.3f,%s", Probe.WallMs(), elapsedMs, Probe.phase, Probe.carry, Probe.Context())
	end
end

-- Time spent in our own API calls during this frame.
function Probe.Charge(ms)
	Probe.spent = Probe.spent + ms
end

-- Scheduler -------------------------------------------------------------------
function Probe.Spawn(name, fn, ...)
	local args = { ... }
	local count = select("#", ...)
	Probe.tasks[#Probe.tasks + 1] = {
		name = name,
		wake = 0,
		co = coroutine.create(function()
			fn(unpack(args, 1, count))
		end),
	}
end

local function sleep(seconds)
	coroutine.yield(seconds or 0)
end

local function runTasks(now)
	local tasks = Probe.tasks
	for i = #tasks, 1, -1 do
		local task = tasks[i]
		if now >= task.wake then
			local ok, delay = coroutine.resume(task.co)
			if not ok then
				table.remove(tasks, i)
				ns.Fail(task.name, delay)
			elseif coroutine.status(task.co) == "dead" then
				table.remove(tasks, i)
			else
				task.wake = now + (delay or 0)
			end
		end
	end
end

local listOpen, writer, epoch, seq = false, nil, 0, 0
local frameNo, sentInFrame = 0, -1

function Probe.Frame(now, elapsedMs)
	frameNo = frameNo + 1
	updateClock(now)
	recordFrame(elapsedMs)
	Probe.spent = 0
	local open = Probe.ListOpen()
	if open ~= listOpen then
		listOpen = open
		Probe.Event(open and "list-open" or "list-close")
		if not open and writer then
			writer:Sync()
		end
	end
	runTasks(now)
	Probe.carry = Probe.spent
end

function Probe.Setup(character, session)
	Probe.character = character
	writer = Wire.NewWriter(Wire.UP, character)
	epoch, seq = session.epoch, 0
end

-- Uplink ----------------------------------------------------------------------
-- Writes one frame to lane U. Never writes while the player has the addon list open, and at
-- most once per rendered frame: a second save in the same frame would overwrite the first
-- before the companion could read it.
-- Returns the wall time before the write, toggle ms, save ms and flipped bits.
local function send(kind, payload, flags)
	while Probe.ListOpen() or sentInFrame == frameNo do
		sleep(Probe.ListOpen() and 0.25 or 0)
	end
	sentInFrame = frameNo
	seq = seq + 1
	local frame = Wire.Encode(kind, epoch, seq, payload, flags)
	local sent = Probe.WallMs()
	local toggleMs, saveMs, flipped = writer:Write(frame)
	Probe.Charge(toggleMs + saveMs)
	return sent, toggleMs, saveMs, flipped
end

local function control(op, args)
	return send(Wire.CONTROL, op .. (args or ""))
end

local function testBytes(stream, index, count)
	local out = {}
	for j = 1, count do
		out[j] = char((stream * 31 + index * 7 + j * 13) % 251)
	end
	return concat(out)
end

-- Sends `count` data frames back to back. Payload: stream, index (u16), 17 test bytes.
-- Format of sends: "index,sentMs,toggleMs,saveMs,flipped;..."
local function uplinkStream(mode, count)
	Probe.phase = "up" .. mode.stream
	control("M", char(mode.stream, 1))
	sleep(0.25)
	local rows = {}
	for index = 1, count do
		local sent, toggleMs, saveMs, flipped =
			send(Wire.DATA, char(mode.stream) .. U16(index) .. testBytes(mode.stream, index, 17))
		rows[index] = format("%d,%.1f,%.3f,%.3f,%d", index, sent, toggleMs, saveMs, flipped)
		sleep(mode.interval)
	end
	control("E", char(mode.stream) .. U16(count))
	sleep(0.3)
	Probe.phase = "idle"
	return { interval = mode.interval, count = count, sends = concat(rows, ";") }
end

-- Signals ---------------------------------------------------------------------
local function signalPath(n)
	return format("%ssig\\%04d.wav", ROOT, n)
end

local function playable(path)
	local started = debugprofilestop()
	local ok, willPlay, handle = pcall(PlaySoundFile, path, "Master")
	local cost = debugprofilestop() - started
	Probe.Charge(cost)
	if ok and willPlay and handle and StopSound then
		StopSound(handle)
	end
	return (ok and willPlay) and true or false, cost
end

-- Next signal file that is still silent. A raised file stays playable until the client restarts.
local function nextSignal()
	local db = ns.db
	while db.nextSignal <= SIGNALS do
		local n = db.nextSignal
		db.nextSignal = n + 1
		if not playable(signalPath(n)) then
			return n
		end
	end
end

-- Returns the wall time the signal was seen (or nil), the number of polls and the worst poll ms.
local function waitSignal(n, timeout, interval)
	local path, deadline, polls, worst = signalPath(n), Probe.Now() + timeout, 0, 0
	while Probe.Now() < deadline do
		local up, cost = playable(path)
		polls, worst = polls + 1, max(worst, cost)
		if up then
			return Probe.WallMs(), polls, worst
		end
		sleep(interval)
	end
	return nil, polls, worst
end

-- Format: "sig,requestedMs,seenMs|-,polls,worstPollMs"
local function signalRound(interval, timeout)
	local n = nextSignal()
	if not n then
		return nil, "no-signal-left"
	end
	local requested = control("S", U16(n))
	local seen, polls, worst = waitSignal(n, timeout, interval)
	return format("%d,%.1f,%s,%d,%.3f", n, requested, seen and format("%.1f", seen) or "-", polls, worst),
		seen and "ok" or "timeout"
end

-- Slots -----------------------------------------------------------------------
local usedSlots = {}

local function slotName(k)
	return format("FamiliarSpike_L%02d", k)
end

local function nextSlot()
	for k = 1, SLOTS do
		if not usedSlots[k] and not C_AddOns.IsAddOnLoaded(slotName(k)) then
			return k
		end
	end
end

local function loadSlot(k)
	usedSlots[k] = true
	FamiliarSpike_SlotData = nil
	local started = debugprofilestop()
	local loaded, reason = C_AddOns.LoadAddOn(slotName(k))
	local cost = debugprofilestop() - started
	Probe.Charge(cost)
	local data = FamiliarSpike_SlotData
	FamiliarSpike_SlotData = nil
	return loaded, reason, cost, data
end

local function expectedChar(nonce, i)
	local index = (nonce + i * 7) % 64 + 1
	return ALPHABET:sub(index, index)
end

local function verify(data, k, nonce, size)
	if type(data) ~= "table" then
		return "missing"
	end
	if data.nonce ~= nonce then
		return data.nonce == 0 and "stale" or "wrong-nonce"
	end
	local text = data.data
	if data.slot ~= k or type(text) ~= "string" or #text ~= size then
		return "corrupt"
	end
	local step = max(1, floor(size / 32))
	for i = 1, size, step do
		if text:sub(i, i) ~= expectedChar(nonce, i) then
			return "corrupt"
		end
	end
	return text:sub(size, size) == expectedChar(nonce, size) and "fresh" or "corrupt"
end

-- Requests `size` bytes in a slot, waits for its signal, loads it.
-- Format: "slot,size,sig,requestedMs,signaledMs|-,loadedMs|-,loadMs,polls,result"
local function answer(size, interval, timeout)
	local k, n = nextSlot(), nextSignal()
	if not k or not n then
		return nil, not k and "no-slot-left" or "no-signal-left"
	end
	local nonce = math.random(1, 2147483646)
	local requested = control("L", char(k) .. U32(size) .. U16(n) .. U32(nonce))
	local signaled, polls = waitSignal(n, timeout, interval)
	local loaded, loadedAt, cost, result = nil, nil, 0, "no-signal"
	if signaled then
		local ok, reason, data
		ok, reason, cost, data = loadSlot(k)
		loadedAt = Probe.WallMs()
		result = ok and verify(data, k, nonce, size) or ("load-" .. tostring(reason))
		loaded = ok
	end
	return format(
		"%d,%d,%d,%.1f,%s,%s,%.3f,%d,%s",
		k,
		size,
		n,
		requested,
		signaled and format("%.1f", signaled) or "-",
		loaded and format("%.1f", loadedAt) or "-",
		cost,
		polls,
		result
	),
		result
end

-- Downlink --------------------------------------------------------------------
local function downlinkBytes(nonce, count)
	local out, seed = {}, nonce % 251
	for j = 1, count do
		out[j] = char((seed + j * 17) % 256)
	end
	return concat(out)
end

-- Format: "count:p50/p95/max" in ms.
local function summarize(values)
	local n = #values
	if n == 0 then
		return "0"
	end
	local sorted = {}
	for i = 1, n do
		sorted[i] = values[i]
	end
	sort(sorted)
	local function pick(q)
		return sorted[max(1, math.ceil(q * n))]
	end
	return format("%d:%.3f/%.3f/%.3f", n, pick(0.5), pick(0.95), sorted[n])
end

-- The companion writes lane D; the addon reads it after ResetAddOns and acks every frame on lane U.
local function downlink(bytes, timeout)
	Probe.phase = "dl"
	local reader = Wire.NewReader(Wire.DOWN, Probe.character)
	local nonce = math.random(1, 2147483646)
	local started = control("D", U16(bytes) .. U32(nonce))
	local parts, nextSeq, resets, reads = {}, 1, {}, {}
	local deadline, result = Probe.Now() + timeout, "timeout"
	local ackedAt, reacks = 0, 0
	while Probe.Now() < deadline do
		if Probe.ListOpen() then
			sleep(0.25)
		else
			local frame, resetMs, readMs = reader:Read()
			Probe.Charge(resetMs + readMs)
			resets[#resets + 1], reads[#reads + 1] = resetMs, readMs
			local f = Wire.Decode(frame)
			if f and f.kind == Wire.DATA and f.epoch == epoch then
				if f.seq == nextSeq then
					parts[#parts + 1] = f.payload
					nextSeq = nextSeq + 1
					send(Wire.ACK, "D" .. U16(f.seq))
					ackedAt = Probe.Now()
					if f.flags % 4 >= Wire.LAST then
						result = "done"
						break
					end
				elseif f.seq == nextSeq - 1 and Probe.Now() - ackedAt > 1 then
					-- The companion still shows the old frame, so it missed our ack.
					send(Wire.ACK, "D" .. U16(f.seq))
					ackedAt, reacks = Probe.Now(), reacks + 1
				end
			end
			sleep(0)
		end
	end
	if result == "done" then
		result = concat(parts) == downlinkBytes(nonce, bytes) and "ok" or "corrupt"
	end
	Probe.phase = "idle"
	return {
		bytes = bytes,
		frames = nextSeq - 1,
		started = started,
		finished = Probe.WallMs(),
		result = result,
		reacks = reacks,
		reset = summarize(resets),
		read = summarize(reads),
	}
end

-- Benchmark -------------------------------------------------------------------
local function selfTest()
	local problems = {}
	for _, name in ipairs({ "EnableAddOn", "DisableAddOn", "GetAddOnEnableState", "SaveAddOns", "ResetAddOns" }) do
		if type(C_AddOns[name]) ~= "function" then
			problems[#problems + 1] = "C_AddOns." .. name .. " missing"
		end
	end
	local missing = 0
	for i = 0, Wire.BITS - 1 do
		if not C_AddOns.DoesAddOnExist(Wire.UP[i]) then
			missing = missing + 1
		end
		if not C_AddOns.DoesAddOnExist(Wire.DOWN[i]) then
			missing = missing + 1
		end
	end
	for k = 1, SLOTS do
		if not C_AddOns.DoesAddOnExist(slotName(k)) then
			missing = missing + 1
		end
	end
	if missing > 0 then
		problems[#problems + 1] = missing .. " helper addons missing (fully restart WoW after installing)"
	end
	if playable(ROOT .. "ctl\\empty.wav") then
		problems[#problems + 1] = "empty.wav reports playable"
	end
	if not playable(ROOT .. "ctl\\valid.wav") then
		problems[#problems + 1] = "valid.wav does not play (is Master sound off?)"
	end
	return #problems == 0 and "ok" or concat(problems, "; ")
end

function Probe.Bench()
	Probe.benchRunning = true
	local quick = fast()
	local bench = { started = Probe.WallMs() }
	ns.session.bench = bench
	ns.Say("Benchmark running, about two minutes. Please stay where you are and out of combat.")
	Probe.phase = "baseline"
	sleep(quick and 1 or 10)
	Probe.phase = "idle"
	bench.selftest = selfTest()
	ns.Say("Self-test: " .. bench.selftest)

	bench.up = {}
	for _, mode in ipairs(UPLINK) do
		bench.up[mode.stream] = uplinkStream(mode, quick and 30 or 150)
		sleep(1)
	end
	ns.Say("Uplink done.")

	Probe.phase = "signals"
	local rounds = {}
	for _ = 1, 10 do
		rounds[#rounds + 1] = signalRound(0, 5) or "-"
		sleep(0.3)
	end
	bench.signals = concat(rounds, ";")

	Probe.phase = "slots"
	local loads = {}
	for _, size in ipairs(SLOT_SIZES) do
		loads[#loads + 1] = answer(size, 0, 10) or "-"
		sleep(0.5)
	end
	bench.slots = concat(loads, ";")
	-- A slot nobody wrote must still hold the install-time placeholder.
	local k = nextSlot()
	if k then
		local ok, reason, cost, data = loadSlot(k)
		local verdict = ok and (type(data) == "table" and data.nonce == 0 and "placeholder" or "unexpected")
			or ("load-" .. tostring(reason))
		bench.placeholder = format("%d,%.3f,%s", k, cost, verdict)
	end
	Probe.phase = "idle"
	ns.Say("Signals and slots done. Testing the AddOns.txt downlink...")

	bench.dl = downlink(2048, quick and 30 or 60)
	bench.finished = Probe.WallMs()
	Probe.benchRunning = false
	ns.Say(
		format(
			"Benchmark done in %.0f s (downlink: %s). Type /reload once so the results are saved, then keep playing.",
			(bench.finished - bench.started) / 1000,
			bench.dl.result
		)
	)
end

-- Soak ------------------------------------------------------------------------
-- Formats: "S|context|<signal round>", "A|context|<answer>", "X|context|reason".
-- X marks a skipped round (addon list open, files used up); it counts as neither.
local function soakRecord(kind, record, result)
	if not record then
		kind = "X"
	end
	local soak = ns.session.soak
	if #soak < 3000 then
		soak[#soak + 1] = kind .. "|" .. Probe.Context() .. "|" .. (record or result)
	end
	if kind == "X" then
		return
	end
	if result == "ok" or result == "fresh" then
		Probe.soakOk = Probe.soakOk + 1
	else
		Probe.soakFailed = Probe.soakFailed + 1
	end
end

function Probe.Soak()
	local quick = fast()
	local nextSignalAt = Probe.Now() + (quick and 2 or 30)
	local nextAnswerAt = Probe.Now() + (quick and 4 or 90)
	while true do
		local now = Probe.Now()
		if ns.db.soak and not Probe.benchRunning then
			if now >= nextSignalAt then
				nextSignalAt = now + (quick and 3 or 30)
				if Probe.ListOpen() then
					soakRecord("X", nil, "addonlist")
				else
					Probe.phase = "soak"
					local record, result = signalRound(0.1, 15)
					soakRecord("S", record, result)
					Probe.phase = "idle"
				end
			elseif now >= nextAnswerAt then
				nextAnswerAt = now + (quick and 5 or 180)
				if not Probe.ListOpen() then
					Probe.phase = "soak"
					local record, result = answer(2048, 0.1, 20)
					soakRecord("A", record, result)
					Probe.phase = "idle"
				end
			end
		end
		sleep(1)
	end
end

-- Login handshake: announces the session, then checks the round trip once.
function Probe.Hello(isReload)
	sleep(1)
	-- Wall times are only meaningful once the clock has seen a tick of time().
	local deadline = Probe.Now() + 3
	while clock.edges < 1 and Probe.Now() < deadline do
		sleep(0.05)
	end
	local build = tonumber((select(2, GetBuildInfo()))) or 0
	control("H", char(isReload and 1 or 0) .. U32(build) .. U32(ns.session.nonce))
	sleep(0.5)
	local n = nextSignal()
	if not n then
		ns.Say("No unused signal files left. Fully restart WoW.")
		return
	end
	local requested = control("S", U16(n))
	local seen = waitSignal(n, 10, 0.1)
	if seen then
		ns.Say(format("Companion connected (round trip %.0f ms). Type /fspike bench to start.", seen - requested))
		Probe.Event("connected", format("%.0f", seen - requested))
	else
		ns.Say("No answer from the companion. Is familiar-spike running? The soak keeps measuring anyway.")
		Probe.Event("no-companion")
	end
end

function Probe.Status()
	local used = 0
	for k = 1, SLOTS do
		if usedSlots[k] or C_AddOns.IsAddOnLoaded(slotName(k)) then
			used = used + 1
		end
	end
	return format(
		"epoch %d, clock %d ticks, signals %d/%d, slots %d/%d, soak %d ok / %d failed%s%s",
		epoch,
		clock.edges,
		ns.db.nextSignal - 1,
		SIGNALS,
		used,
		SLOTS,
		Probe.soakOk,
		Probe.soakFailed,
		ns.db.soak and "" or " (soak off)",
		Probe.benchRunning and ", benchmark running" or ""
	)
end

-- Copies frame statistics into the session right before the client writes SavedVariables.
function Probe.Store(session)
	local frames = {}
	for phase, stats in pairs(frameStats) do
		-- Format: "n,sumMs,maxMs,count<8,<12,<17,<25,<34,<50,<100,>=100"
		frames[phase] = format("%d,%.1f,%.1f,%s", stats.n, stats.sum, stats.max, concat(stats.counts, ","))
	end
	session.frames = frames
	session.hitches = concat(hitches, ";")
	session.clock = { offset = clock.offset, edges = clock.edges }
	session.ended = Probe.WallMs()
end
