-- Measurements for FAM-15, run as coroutines from Spike.lua's OnUpdate.
--
-- Every channel is measured on its own, so one channel that does not work cannot hide another:
--   uplink    the addon writes lane U and calls SaveAddOns; the companion logs what reaches
--             AddOns.txt
--   lane D    the companion rewrites lane D every 2 s; the addon calls ResetAddOns and reads it
--   slots     the companion keeps every slot's data.lua fresh; the addon loads one on a timer
--   doorbells the companion makes sig\NNNN.wav "ring" every 30 s; the addon polls the next one
--   fonts     the companion rewrites the font bank round-robin; the addon reads one font after
--             login and one every 2 minutes
--   shots     the addon takes screenshots in the benchmark or on /fspike shots; the companion
--             reads the Screenshots folder
--
-- Records are compact strings so SavedVariables stay small. The companion's report parses
-- them; the formats are listed next to the functions that build them.
local _, ns = ...
local Wire, Font, Shot = ns.Wire, ns.Font, ns.Shot

local char, format, floor, max = string.char, string.format, math.floor, math.max
local concat, sort = table.concat, table.sort
local U16, U32 = Wire.U16, Wire.U32

local Probe = { tasks = {}, phase = "idle", spent = 0, carry = 0 }
ns.Probe = Probe

local ROOT = "Interface\\AddOns\\FamiliarSpike\\"
local SIGNALS, SLOTS, BENCH_SLOTS = 600, 64, 6
local ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
local UPLINK = {
	{ stream = 1, interval = 0, count = 150, quick = 30 }, -- every rendered frame
	{ stream = 2, interval = 0.033, count = 150, quick = 30 },
	{ stream = 3, interval = 0.066, count = 150, quick = 30 },
	{ stream = 4, interval = 0.1, count = 150, quick = 30 },
	{ stream = 5, interval = 2, count = 15, quick = 5 }, -- Witchcraft's pace
}
local SOAK_STREAM = 9
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
				if Probe.shotsRunning then
					Probe.EndShots()
				end
			elseif coroutine.status(task.co) == "dead" then
				table.remove(tasks, i)
			else
				task.wake = now + (delay or 0)
			end
		end
	end
end

-- Wall times are only meaningful once the clock has seen a tick of time().
local function waitClock()
	local deadline = Probe.Now() + 3
	while clock.edges < 1 and Probe.Now() < deadline do
		sleep(0.05)
	end
end

local listOpen, writer, reader, epoch, seq = false, nil, nil, 0, 0
local frameNo, sentInFrame = 0, -1
local doorbell = { mode = "untested" }
local laneD = { seen = 0, reads = 0 }
local usedSlots, companionSeen = {}, false

function Probe.Frame(now, elapsedMs)
	frameNo = frameNo + 1
	updateClock(now)
	recordFrame(elapsedMs)
	Probe.lastFrameMs = elapsedMs
	Probe.spent = 0
	local open = Probe.ListOpen()
	if open ~= listOpen then
		listOpen = open
		Probe.Event(open and "list-open" or "list-close")
		if not open and writer then
			writer:Invalidate()
		end
	end
	runTasks(now)
	Probe.carry = Probe.spent
end

function Probe.Setup(character, session)
	Probe.character = character
	epoch, seq = session.epoch, 0
	local up, upMissing = Wire.Resolve("U")
	local down, downMissing = Wire.Resolve("D")
	Probe.missingHelpers = (upMissing or 0) + (downMissing or 0)
	writer = up and Wire.NewWriter(up, character) or nil
	reader = down and Wire.NewReader(down, character) or nil
end

local function noteCompanion(channel)
	if not companionSeen then
		companionSeen = true
		ns.Say("Companion seen via " .. channel .. ".")
		Probe.Event("companion", channel)
	end
end

-- Uplink ----------------------------------------------------------------------
-- Writes one frame to lane U. Never writes while the player has the addon list open, and at
-- most once per rendered frame: a second save in the same frame would overwrite the first
-- before the companion could read it.
-- Returns the wall time before the write, toggle ms, save ms, flipped bits and mismatches.
local function send(kind, payload)
	while Probe.ListOpen() or sentInFrame == frameNo do
		sleep(Probe.ListOpen() and 0.25 or 0)
	end
	sentInFrame = frameNo
	seq = seq + 1
	local frame = Wire.Encode(kind, epoch, seq, payload)
	local sent, started = Probe.WallMs(), debugprofilestop()
	local toggleMs, saveMs, flipped, mismatches = writer:Write(frame)
	Probe.Charge(debugprofilestop() - started)
	return sent, toggleMs, saveMs, flipped, mismatches
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

-- Sends `count` data frames. Payload: stream, index (u16), 17 test bytes.
-- Format of sends: "index,sentMs,toggleMs,saveMs,flipped,mismatches;..."
local function uplinkStream(mode, count)
	Probe.phase = "up" .. mode.stream
	control("M", char(mode.stream, 1))
	sleep(0.25)
	local rows = {}
	for index = 1, count do
		local sent, toggleMs, saveMs, flipped, mismatches =
			send(Wire.DATA, char(mode.stream) .. U16(index) .. testBytes(mode.stream, index, 17))
		rows[index] = format("%d,%.1f,%.3f,%.3f,%d,%d", index, sent, toggleMs, saveMs, flipped, mismatches)
		sleep(mode.interval)
	end
	control("E", char(mode.stream) .. U16(count))
	sleep(0.3)
	Probe.phase = "idle"
	return { interval = mode.interval, count = count, sends = concat(rows, ";") }
end

-- Lane D ----------------------------------------------------------------------
-- Calls ResetAddOns and reads lane D. Returns the counter and the companion's write time of a
-- frame newer than any seen before, false if nothing is new, or nil if it could not read.
-- The second and third results are reset ms and read ms.
local function readLaneD()
	if not reader or Probe.ListOpen() then
		return nil
	end
	local frame, resetMs, readMs = reader:Read()
	Probe.Charge(resetMs + readMs)
	laneD.reads = laneD.reads + 1
	-- If ResetAddOns reloaded AddOns.txt, lane U may have changed under the writer.
	if writer then
		writer:Invalidate()
	end
	local f = Wire.Decode(frame)
	if not f or f.kind ~= Wire.DATA or #f.payload < 10 then
		return false, nil, resetMs, readMs
	end
	if f.epoch ~= laneD.epoch then
		laneD.epoch, laneD.last = f.epoch, -1 -- a new companion run starts counting again
	end
	local counter = Wire.ReadU32(f.payload, 1)
	if counter <= laneD.last then
		return false, nil, resetMs, readMs
	end
	laneD.last, laneD.seen = counter, laneD.seen + 1
	noteCompanion("lane D")
	return counter, Wire.ReadU48(f.payload, 5), resetMs, readMs
end

-- Reads lane D every 0.1 s. Format of frames: "counter,writtenMs,seenMs;..."
local function laneDPhase(seconds)
	Probe.phase = "laneD"
	local frames, resets, reads, started = {}, {}, {}, Probe.WallMs()
	local deadline = Probe.Now() + seconds
	while Probe.Now() < deadline do
		local counter, written, resetMs, readMs = readLaneD()
		if resetMs then
			resets[#resets + 1], reads[#reads + 1] = resetMs, readMs
		end
		if counter then
			frames[#frames + 1] = format("%d,%.0f,%.0f", counter, written, Probe.WallMs())
		end
		sleep(0.1)
	end
	Probe.phase = "idle"
	return {
		started = started,
		finished = Probe.WallMs(),
		frames = concat(frames, ";"),
		reads = #reads,
		reset = summarize(resets),
		read = summarize(reads),
	}
end

-- Slots -----------------------------------------------------------------------
local function slotName(k)
	return format("FamiliarSpike_L%02d", k)
end

local function slotUsed(k)
	return usedSlots[k] or C_AddOns.IsAddOnLoaded(slotName(k))
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

local function expectedChar(seed, i)
	local index = (seed + i * 7) % 64 + 1
	return ALPHABET:sub(index, index)
end

-- fresh: rewritten by the companion within its refresh interval; stale: older; placeholder:
-- never rewritten since the install; corrupt or missing otherwise.
local function judge(data, k, now)
	if type(data) ~= "table" then
		return "missing"
	end
	if data.refresh == 0 then
		return "placeholder"
	end
	local size, text = data.size, data.data
	if data.slot ~= k or type(text) ~= "string" or #text ~= size then
		return "corrupt"
	end
	for i = 1, size, max(1, floor(size / 32)) do
		if text:sub(i, i) ~= expectedChar(data.refresh, i) then
			return "corrupt"
		end
	end
	if size > 0 and text:sub(size, size) ~= expectedChar(data.refresh, size) then
		return "corrupt"
	end
	return now - data.written <= data.every + 5000 and "fresh" or "stale"
end

-- Format: "slot,size,loadMs,ageMs|-,result"
local function slotRound(k)
	local loaded, reason, cost, data = loadSlot(k)
	local now = Probe.WallMs()
	local result = loaded and judge(data, k, now) or ("load-" .. tostring(reason))
	local age = type(data) == "table" and (data.written or 0) > 0 and now - data.written or nil
	if result == "fresh" then
		noteCompanion("slot")
	end
	local size = type(data) == "table" and data.size or 0
	return format("%d,%d,%.3f,%s,%s", k, size, cost, age and format("%.0f", age) or "-", result), result
end

local function nextSoakSlot()
	for k = BENCH_SLOTS + 1, SLOTS do
		if not slotUsed(k) then
			return k
		end
	end
end

-- Loads the benchmark slots 1-6 (2 KB, 2 KB, 2 KB, 16 KB, 128 KB, 1 MB), 2 s apart.
local function slotPhase()
	Probe.phase = "slots"
	local rows = {}
	for k = 1, BENCH_SLOTS do
		rows[#rows + 1] = slotUsed(k) and format("%d,0,0,-,used", k) or (slotRound(k))
		sleep(2)
	end
	Probe.phase = "idle"
	return concat(rows, ";")
end

-- Doorbells -------------------------------------------------------------------
local CTL = ROOT .. "ctl\\"

local function play(path)
	local started = debugprofilestop()
	local ok, willPlay, handle = pcall(PlaySoundFile, path, "Master")
	Probe.Charge(debugprofilestop() - started)
	if not ok then
		return false
	end
	return willPlay and true or false, handle
end

local function isPlaying(handle)
	local ok, playing = pcall(C_Sound.IsPlaying, handle)
	return ok and playing == true
end

-- Plays each control file and asks C_Sound.IsPlaying 0.3 s and 0.8 s later. "return": an empty
-- file does not play, so PlaySoundFile's result is the doorbell. "duration": both play, but only
-- a valid one is still playing a moment later. "none": neither works. The second look catches a
-- sound that starts late, as one test on Linux right after /reload suggested.
-- Format of the result: "empty=willPlay/isPlaying,valid=...,long=...,missing=...,secure=..."
-- where isPlaying holds one digit per look, or - for "no handle". secure is 1 while
-- PlaySoundFile is Blizzard's own function, otherwise the name of the addon that replaced it.
local function soundTest()
	local names, probes = { "empty", "valid", "long", "missing" }, {}
	for _, name in ipairs(names) do
		local will, handle = play(CTL .. name .. ".wav")
		probes[name] = { will = will, handle = handle, looks = "" }
	end
	for _, wait in ipairs({ 0.3, 0.5 }) do
		sleep(wait)
		for _, name in ipairs(names) do
			local p = probes[name]
			if p.handle then
				local now = isPlaying(p.handle)
				p.looks, p.playing = p.looks .. (now and "1" or "0"), p.playing or now
			end
		end
	end
	local parts = {}
	for _, name in ipairs(names) do
		local p = probes[name]
		if p.handle then
			pcall(StopSound, p.handle)
		end
		parts[#parts + 1] = format("%s=%s/%s", name, p.will and "1" or "0", p.handle and p.looks or "-")
	end
	doorbell.late = probes.long.looks == "01"
	if issecurevariable then
		local secure, taint = issecurevariable("PlaySoundFile")
		parts[#parts + 1] = "secure=" .. (secure and "1" or tostring(taint or "0"))
	end
	local empty, valid, long = probes.empty, probes.valid, probes.long
	local mode, why
	if not valid.will then
		mode, why = "none", "the test sound does not play (game sound off?)"
	elseif not empty.will then
		mode = "return"
	elseif long.playing and not empty.playing then
		mode = "duration"
	else
		mode, why = "none", "an empty file plays like a valid one"
	end
	return mode, why, concat(parts, ",")
end

local function doorbellOn()
	return doorbell.mode == "return" or doorbell.mode == "duration"
end

local function probeDoorbell(session)
	local mode, why, sound = "none", "sound API missing", "-"
	if PlaySoundFile and C_Sound and C_Sound.IsPlaying then
		mode, why, sound = soundTest()
	end
	doorbell.mode, doorbell.why = mode, why
	session.sound, session.doorbell = sound, mode .. (why and (": " .. why) or "")
	return doorbellOn()
end

local function describeDoorbell()
	if doorbell.mode == "return" then
		return "on (PlaySoundFile result)"
	elseif doorbell.mode == "duration" then
		return "on (sound length)"
	end
	return "off: " .. (doorbell.why or doorbell.mode)
end

local function signalPath(n)
	return format("%ssig\\%04d.wav", ROOT, n)
end

local function raised(n)
	local will, handle = play(signalPath(n))
	if doorbell.mode == "return" then
		if handle then
			pcall(StopSound, handle)
		end
		return will
	end
	if not (will and handle) then
		return false
	end
	sleep(0.25)
	local playing = isPlaying(handle)
	if not playing and doorbell.late then
		sleep(0.5)
		playing = isPlaying(handle)
	end
	pcall(StopSound, handle)
	return playing
end

-- Polls the next doorbell four times a second. While doorbells are off, tries the sound again
-- every minute. A raised file stays raised until the client restarts, and the companion
-- silences all of them when the game starts. A login is a new process only if the last
-- doorbell heard is silent again; after a character switch it still rings, and counting
-- goes on from there.
-- Format of session.bells: "n,seenMs,context"
function Probe.Bells()
	local db, session = ns.db, ns.session
	while not doorbellOn() do
		sleep(60)
		if probeDoorbell(session) then
			Probe.Event("doorbell", describeDoorbell())
			ns.Say("Doorbells: " .. describeDoorbell() .. ".")
		end
	end
	if not session.reload and db.nextSignal > 1 and not raised(db.nextSignal - 1) then
		db.nextSignal = 1
		Probe.Event("bells", "restart")
	end
	-- Doorbells raised before this moment waited for the login, not for the doorbell.
	session.listening = Probe.WallMs()
	local bells = session.bells
	while db.nextSignal <= SIGNALS do
		local n = db.nextSignal
		if raised(n) then
			db.nextSignal = n + 1
			if #bells < SIGNALS then
				bells[#bells + 1] = format("%d,%.0f,%s", n, Probe.WallMs(), Probe.Context())
			end
			noteCompanion("doorbell")
		else
			sleep(0.25)
		end
	end
end

-- Fonts -----------------------------------------------------------------------
local fontBusy, fontsRead = false, 0

-- Reads the next font of the bank. Returns the record and its result, or nil and a reason
-- when another read is running or the bank is used up for this client process.
local function fontRound()
	if fontBusy then
		return nil, "busy"
	end
	local slot = Font.Next(ns.db)
	if not slot then
		return nil, "exhausted"
	end
	fontBusy = true
	local r = Font.Read(slot, sleep, Probe.Charge)
	fontBusy = false
	fontsRead = fontsRead + 1
	if r.result == "ok" then
		noteCompanion("font")
	end
	return Font.Format(r), r.result
end

-- Reads `count` fonts back to back. Format: Font.Format records separated by ";".
local function fontPhase(count)
	Probe.phase = "fonts"
	local rows, ok = {}, 0
	for _ = 1, count do
		local record, result = fontRound()
		if not record then
			break
		end
		rows[#rows + 1] = record
		ok = ok + (result == "ok" and 1 or 0)
	end
	Probe.phase = "idle"
	ns.Say(format("Fonts done: %d of %d decoded.", ok, #rows))
	return concat(rows, ";")
end

-- Screenshots -------------------------------------------------------------------
-- A letter is a variant kept up until the file is saved; a digit after it hides the data that
-- many frames after the call, which shows when the client captures the picture.
local SHOTS = { first = { "A", "B", "C", "D", "B0", "B1", "B2", "A" }, png = { "C", "D", "E", "E" } }
local SHOTS_FAST = { first = { "A", "B", "C", "D", "B0", "B1" }, png = { "C", "E" } }

-- One run: screenshots in the player's format, then in PNG if the client lets an addon
-- switch the format, which is restored right after. Never two in the same second, since the
-- file names count seconds. Format of run.shots: Shot.Take records separated by ";".
function Probe.Shots()
	local session = ns.session
	local run = { started = Probe.WallMs() }
	session.shots[#session.shots + 1] = run
	if type(Screenshot) ~= "function" then
		run.result = "Screenshot missing"
		return
	end
	Probe.shotsRunning = true
	local plan = fast() and SHOTS_FAST or SHOTS
	ns.Say(format("Screenshot test: the top-left corner flashes %d times.", #plan.first + #plan.png))
	Probe.phase = "shots"
	run.geometry = Shot.Build(sleep)
	run.format, run.quality = Shot.CVar("screenshotFormat"), Shot.CVar("screenshotQuality")
	run.quiet = Shot.Quiet(true) and 1 or 0
	local rows, second = {}, nil
	local function series(list, formatName)
		for _, entry in ipairs(list) do
			while time() == second do
				sleep(0.05)
			end
			session.shotSeq = (session.shotSeq or 0) + 1
			rows[#rows + 1] = Shot.Take(
				entry:sub(1, 1),
				tonumber(entry:sub(2)),
				session.epoch,
				session.shotSeq,
				formatName,
				sleep
			)
			second = time()
		end
	end
	series(plan.first, run.format)
	if run.format == "png" then
		run.png = "already"
		series(plan.png, "png")
	elseif run.format then
		-- Remembered in case the client stops before the format is back.
		ns.db.shotFormat = run.format
		if Shot.SetFormat("png") then
			run.png = "switched"
			series(plan.png, "png")
		else
			run.png = "denied"
		end
	end
	Probe.EndShots()
	run.restored = ns.db.shotFormat == nil and 1 or 0
	run.shots, run.finished = concat(rows, ";"), Probe.WallMs()
	ns.Say(format("Screenshot test done: %d pictures.", #rows))
end

-- Also runs when a screenshot run fails halfway: block off, message back, format back.
function Probe.EndShots()
	Shot.Hide()
	Shot.Quiet(false)
	if ns.db.shotFormat and Shot.SetFormat(ns.db.shotFormat) then
		ns.db.shotFormat = nil
	end
	Probe.phase = "idle"
	Probe.shotsRunning = false
end

-- Benchmark -------------------------------------------------------------------
local function checkSetup()
	local problems = {}
	for _, name in ipairs({ "EnableAddOn", "DisableAddOn", "GetAddOnEnableState", "SaveAddOns", "ResetAddOns" }) do
		if type(C_AddOns[name]) ~= "function" then
			problems[#problems + 1] = "C_AddOns." .. name .. " missing"
		end
	end
	local missing = Probe.missingHelpers or 0
	for k = 1, SLOTS do
		if not C_AddOns.DoesAddOnExist(slotName(k)) then
			missing = missing + 1
		end
	end
	if missing > 0 then
		problems[#problems + 1] = missing .. " helper addons missing: quit WoW completely and start it again"
	end
	for _, name in ipairs({ "Screenshot", "GetPhysicalScreenSize", "GetSessionTime" }) do
		if type(_G[name]) ~= "function" then
			problems[#problems + 1] = name .. " missing"
		end
	end
	return #problems == 0 and "ok" or concat(problems, "; ")
end

function Probe.Bench()
	Probe.benchRunning = true
	local quick, session = fast(), ns.session
	local bench = {
		started = Probe.WallMs(),
		selftest = session.selftest,
		sound = session.sound,
		doorbell = session.doorbell,
	}
	session.bench = bench
	ns.Say("Benchmark running, about three minutes. Please stay where you are and out of combat.")
	Probe.phase = "baseline"
	sleep(quick and 1 or 10)
	Probe.phase = "idle"

	if writer then
		bench.up = {}
		for _, mode in ipairs(UPLINK) do
			bench.up[mode.stream] = uplinkStream(mode, quick and mode.quick or mode.count)
			sleep(1)
		end
		ns.Say("Uplink done.")
	end
	-- The companion leaves lane D alone for 3 s after the client wrote AddOns.txt.
	sleep(4)
	if reader then
		bench.laneD = laneDPhase(quick and 10 or 20)
		local seen = bench.laneD.frames == "" and 0 or select(2, bench.laneD.frames:gsub(";", "")) + 1
		ns.Say(format("Lane D done: %d new frames.", seen))
	end
	bench.slots = slotPhase()
	bench.fonts = fontPhase(quick and 4 or 8)
	Probe.Shots()
	bench.finished = Probe.WallMs()
	Probe.benchRunning = false
	ns.Say(
		format(
			"Benchmark done in %.0f s. Type /reload once so the results are saved, then keep playing.",
			(bench.finished - bench.started) / 1000
		)
	)
end

-- Soak ------------------------------------------------------------------------
-- Format: "kind|context|wallMs|detail" with these kinds:
--   U  an uplink frame on stream 9; detail is its index
--   D  a lane D read; detail "counter,writtenMs", or "-" if no new frame had arrived
--   L  a slot load; detail as in slotRound
--   F  a font read; detail as in Font.Format
--   X  a skipped round; detail is the reason
local function soakRecord(kind, detail, at)
	local soak = ns.session.soak
	if #soak < 3000 then
		soak[#soak + 1] = format("%s|%s|%.0f|%s", kind, Probe.Context(), at or Probe.WallMs(), detail)
	end
end

-- Lane D is read half a round after the uplink frame: the client's save writes its own copy of
-- lane D back, and the companion waits a moment before it writes again.
function Probe.Soak()
	waitClock()
	local quick = fast()
	local every, slotEvery, fontEvery = quick and 4 or 30, quick and 6 or 180, quick and 5 or 120
	local nextUp = Probe.Now() + (quick and 1 or 20)
	local nextD, nextSlot = nextUp + every / 2, Probe.Now() + (quick and 4 or 90)
	local nextFont, fontsDone = Probe.Now() + (quick and 3 or 60), false
	local index = 0
	while true do
		local now = Probe.Now()
		if ns.db.soak and not Probe.benchRunning and not Probe.shotsRunning then
			if writer and now >= nextUp then
				nextUp = now + every
				if Probe.ListOpen() then
					soakRecord("X", "addonlist")
				else
					index = index + 1
					Probe.phase = "soak"
					local sent = send(Wire.DATA, char(SOAK_STREAM) .. U16(index) .. testBytes(SOAK_STREAM, index, 17))
					soakRecord("U", tostring(index), sent)
					Probe.phase = "idle"
				end
			elseif reader and now >= nextD then
				nextD = now + every
				local counter, written = readLaneD()
				if counter then
					soakRecord("D", format("%d,%.0f", counter, written))
				elseif counter == false then
					soakRecord("D", "-")
				else
					soakRecord("X", "addonlist")
				end
			elseif now >= nextSlot then
				nextSlot = now + slotEvery
				local k = nextSoakSlot()
				if k and not Probe.ListOpen() then
					Probe.phase = "soak"
					soakRecord("L", (slotRound(k)))
					Probe.phase = "idle"
				end
			elseif now >= nextFont and not fontsDone then
				nextFont = now + fontEvery
				Probe.phase = "soak"
				local record, result = fontRound()
				Probe.phase = "idle"
				if record then
					soakRecord("F", record)
				elseif result == "exhausted" then
					soakRecord("X", "fonts used up")
					fontsDone = true
				end
			end
		end
		sleep(0.25)
	end
end

-- Login: self-test, hello on lane U, then one slot and one font to see whether the companion
-- is there.
function Probe.Start(isReload)
	sleep(1)
	waitClock()
	local session = ns.session
	session.selftest = checkSetup()
	for attempt = 1, 3 do
		if probeDoorbell(session) or attempt == 3 then
			break
		end
		Probe.Event("sound-retry", session.sound)
		sleep(2)
	end
	if writer then
		local build = tonumber((select(2, GetBuildInfo()))) or 0
		control("H", char(isReload and 1 or 0) .. U32(build) .. U32(session.nonce))
	end
	ns.Say(format("Self-test: %s. Doorbells: %s. Type /fspike bench to start.", session.selftest, describeDoorbell()))
	Probe.Spawn("bells", Probe.Bells)
	sleep(4)
	local k = nextSoakSlot()
	if k then
		local record, result = slotRound(k)
		soakRecord("L", record)
		if result ~= "fresh" then
			ns.Say(format("No fresh data in a slot (%s). Is familiar-spike running? The measurements go on; this is a result too.", result))
		end
	end
	local record = fontRound()
	if record then
		soakRecord("F", record)
	end
end

function Probe.Status()
	local used = 0
	for k = 1, SLOTS do
		if slotUsed(k) then
			used = used + 1
		end
	end
	return format(
		"doorbells %s, %d heard; lane D %d new frames in %d reads; slots %d/%d used; fonts %d read, next %d of %d; screenshot runs %d; uplink %s; soak %s%s",
		describeDoorbell(),
		#ns.session.bells,
		laneD.seen,
		laneD.reads,
		used,
		SLOTS,
		fontsRead,
		ns.db.fontNext or 1,
		Font.BANK,
		#ns.session.shots,
		writer and (seq .. " frames sent") or "off",
		ns.db.soak and "on" or "off",
		Probe.benchRunning and "; benchmark running" or ""
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
	session.nextSignal = ns.db.nextSignal
	session.fontNext = ns.db.fontNext
	session.ended = Probe.WallMs()
end
