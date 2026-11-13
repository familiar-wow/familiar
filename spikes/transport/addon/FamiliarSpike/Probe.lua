-- What every measurement needs: wall clock, frame times, a coroutine scheduler, events, the
-- doorbell and the client settings the benchmark changes for a moment. Records are compact
-- strings so SavedVariables stay small; the companion's report parses them, and their formats
-- are listed next to the functions that build them.
local _, ns = ...

local format, max = string.format, math.max
local concat, sort = table.concat, table.sort

local Probe = { tasks = {}, phase = "idle", spent = 0, carry = 0, bellsHeard = 0 }
ns.Probe = Probe

local ROOT = "Interface\\AddOns\\FamiliarSpike\\"
local SIGNALS = 600
local FRAME_BOUNDS = { 8, 12, 17, 25, 34, 50, 100 } -- ms; one extra bin catches the rest

-- Set only by the offline simulator, which plays for seconds instead of hours.
function Probe.Fast()
	return FamiliarSpike_Fast == true
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
	if UIParent and not UIParent:IsShown() then
		parts[#parts + 1] = "noui"
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
local frameStats, hitches, frameNo = {}, {}, 0

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

function Probe.FrameNo()
	return frameNo
end

-- Format: "count:p50/p95/max" in ms.
function Probe.Summarize(values)
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

-- Yields to the next frame, or for `seconds`.
function Probe.Sleep(seconds)
	coroutine.yield(seconds or 0)
end
local sleep = Probe.Sleep

local function runTasks(now)
	local tasks = Probe.tasks
	for i = #tasks, 1, -1 do
		local task = tasks[i]
		if now >= task.wake then
			local ok, delay = coroutine.resume(task.co)
			if not ok then
				table.remove(tasks, i)
				ns.Fail(task.name, delay)
				if Probe.onFailure then
					Probe.onFailure(task.name)
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
function Probe.WaitClock()
	local deadline = Probe.Now() + 3
	while clock.edges < 1 and Probe.Now() < deadline do
		sleep(0.05)
	end
end

local listOpen = false

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
		-- The player may have changed the helpers' states.
		if not open and Probe.onListClosed then
			Probe.onListClosed()
		end
	end
	runTasks(now)
	Probe.carry = Probe.spent
end

-- Client settings --------------------------------------------------------------
-- The benchmark sets picture and sound settings to their limits for a moment. The player's
-- values go into db.restore first and come back right after each test, on logout, and after a
-- /reload at the next login. A crash leaves no SavedVariables behind, so the login also
-- compares with the values of the last clean login: a setting that now sits on one of our test
-- values and was different then is put back.
local Settings = {
	WATCHED = {
		"Gamma",
		"Brightness",
		"Contrast",
		"colorblindSimulator",
		"colorblindWeaknessFactor",
		"Sound_EnableAllSound",
		"Sound_MasterVolume",
		"screenshotFormat",
		"screenshotQuality",
	},
	TEST_VALUES = {
		Gamma = { 0.3, 2.8 },
		Brightness = { 0, 100 },
		Contrast = { 0, 100 },
		colorblindSimulator = { 2 },
		colorblindWeaknessFactor = { 1 },
		Sound_EnableAllSound = { 0 },
		Sound_MasterVolume = { 0 },
	},
}
Probe.Settings = Settings

function Settings.Get(name)
	local ok, value = pcall(C_CVar.GetCVar, name)
	return ok and value or nil
end

-- Format: "name=value;..." for every watched setting the client knows.
function Settings.Snapshot()
	local parts = {}
	for _, name in ipairs(Settings.WATCHED) do
		local value = Settings.Get(name)
		if value then
			parts[#parts + 1] = name .. "=" .. value
		end
	end
	return concat(parts, ";")
end

local function put(name, value)
	local ok, result = pcall(C_CVar.SetCVar, name, value)
	return ok and result ~= false
end

-- Sets a test value. Returns whether the client took it and the value it reports now.
function Settings.Set(name, value)
	local db = ns.db
	db.restore = db.restore or {}
	if db.restore[name] == nil then
		db.restore[name] = Settings.Get(name) or false
	end
	put(name, tostring(value))
	local now = Settings.Get(name)
	return tonumber(now) == tonumber(value) or now == tostring(value), now
end

function Settings.Restore(name)
	local restore = ns.db.restore
	local value = restore and restore[name]
	if value == nil then
		return
	end
	if value ~= false then
		put(name, value)
	end
	restore[name] = nil
	if next(restore) == nil then
		ns.db.restore = nil
	end
end

function Settings.RestoreAll()
	local restore = ns.db and ns.db.restore
	if not restore then
		return 0
	end
	local names = {}
	for name in pairs(restore) do
		names[#names + 1] = name
	end
	for _, name in ipairs(names) do
		Settings.Restore(name)
	end
	return #names
end

local function isTestValue(name, value)
	local number = tonumber(value)
	for _, test in ipairs(Settings.TEST_VALUES[name] or {}) do
		if number == test then
			return true
		end
	end
	return false
end

-- At ADDON_LOADED. Returns a description of what it put back, or nil.
function Settings.Recover(db)
	local fixed = {}
	if db.restore then
		for name, value in pairs(db.restore) do
			if value ~= false then
				put(name, value)
				fixed[#fixed + 1] = name .. "=" .. value
			end
		end
		db.restore = nil
	elseif type(db.lastSettings) == "table" then
		for name, last in pairs(db.lastSettings) do
			local now = Settings.Get(name)
			if now and now ~= last and isTestValue(name, now) and not isTestValue(name, last) then
				put(name, last)
				fixed[#fixed + 1] = name .. "=" .. last
			end
		end
	end
	Settings.Remember(db)
	return #fixed > 0 and concat(fixed, ", ") or nil
end

-- The player's values, unless a test is running.
function Settings.Remember(db)
	if db.restore then
		return
	end
	db.lastSettings = {}
	for name in pairs(Settings.TEST_VALUES) do
		db.lastSettings[name] = Settings.Get(name)
	end
end

-- Doorbells -------------------------------------------------------------------
-- The companion makes sig\NNNN.wav playable to say "your reply is in the fonts" (or just "I
-- heard you"); the addon polls the next file four times a second.
local CTL = ROOT .. "ctl\\"
local doorbell = { mode = "untested" }

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
-- a valid one is still playing a moment later. "none": neither works.
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

function Probe.DoorbellOn()
	return doorbell.mode == "return" or doorbell.mode == "duration"
end

function Probe.ProbeDoorbell(session)
	local mode, why, sound = "none", "sound API missing", "-"
	if PlaySoundFile and C_Sound and C_Sound.IsPlaying then
		mode, why, sound = soundTest()
	end
	doorbell.mode, doorbell.why = mode, why
	session.sound, session.doorbell = sound, mode .. (why and (": " .. why) or "")
	return Probe.DoorbellOn()
end

function Probe.DescribeDoorbell()
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

-- Polls the next doorbell. While doorbells are off, tries the sound again every minute. A raised
-- file stays raised until the client restarts, and the companion silences all of them when the
-- game starts. A login is a new process only if the last doorbell heard is silent again; after
-- a character switch it still rings, and counting goes on from there.
-- Format of session.bells: "n,seenMs,context"
function Probe.Bells()
	local db, session = ns.db, ns.session
	while not Probe.DoorbellOn() do
		sleep(60)
		if Probe.ProbeDoorbell(session) then
			Probe.Event("doorbell", Probe.DescribeDoorbell())
			ns.Say("Doorbells: " .. Probe.DescribeDoorbell() .. ".")
		end
	end
	if not session.reload and db.nextSignal > 1 and not raised(db.nextSignal - 1) then
		db.nextSignal = 1
		Probe.Event("bells", "restart")
	end
	Probe.bellsReady = true
	local bells = session.bells
	while db.nextSignal <= SIGNALS do
		local n = db.nextSignal
		if raised(n) then
			db.nextSignal = n + 1
			Probe.bellsHeard, Probe.lastBellAt = Probe.bellsHeard + 1, Probe.WallMs()
			if #bells < SIGNALS then
				bells[#bells + 1] = format("%d,%.0f,%s", n, Probe.lastBellAt, Probe.Context())
			end
		else
			sleep(0.25)
		end
	end
end

-- Saving ------------------------------------------------------------------------

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
