-- The login check, the benchmark, the soak and /fspike say. Everything that sends runs as a job
-- on the message worker (Msg.lua), so nothing here sends at the same time.
local _, ns = ...
local Probe, Msg, Shot = ns.Probe, ns.Msg, ns.Shot
local Settings = Probe.Settings

local format, floor, rep = string.format, math.floor, string.rep
local concat = table.concat
local sleep = Probe.Sleep
local KIND, LANE, SHOT = Msg.KIND, Msg.LANE, Msg.SHOT
local MUTED, SMALL, HOLD, WORLD = Shot.MUTED, Shot.SMALL, Shot.HOLD, Shot.WORLD

local Bench = { sent = 0, answered = 0 }
ns.Bench = Bench

local REPLY = 2048 -- bytes in a /fspike say or round-trip reply
local SAY_STYLES = { 0, MUTED, HOLD, MUTED + HOLD }
local LANE_TESTS = {
	{ code = 1, gap = 0.033, count = 2, bytes = 300 },
	{ code = 2, gap = 0.033, count = 2, bytes = 300 },
	{ code = 3, gap = 0.033, count = 2, bytes = 300 },
	{ code = 3, gap = 0.017, count = 2, bytes = 300 },
	{ code = 3, gap = 0, count = 2, bytes = 300 },
	{ code = 3, gap = 0.033, count = 1, bytes = 2048 },
}
local BELL_TESTS = {
	{ tag = "normal" },
	{ tag = "volume0", name = "Sound_MasterVolume", value = 0 },
	{ tag = "soundoff", name = "Sound_EnableAllSound", value = 0 },
}
local SHOT_TESTS = {
	{ 0, "bright" },
	{ MUTED, "muted" },
	{ SMALL, "small" },
	{ SMALL + MUTED, "small-muted" },
	{ HOLD, "hold" },
	{ MUTED + HOLD, "muted-hold" },
	{ WORLD, "world" },
}
local PICTURE_TESTS = {
	{ "Gamma", 0.3 },
	{ "Gamma", 2.8 },
	{ "Brightness", 0 },
	{ "Brightness", 100 },
	{ "Contrast", 0 },
	{ "Contrast", 100 },
	{ "colorblindSimulator", 2, "colorblindWeaknessFactor", 1 },
}
local PICTURE_STYLES = { { 0, "bright" }, { MUTED, "muted" }, { SMALL, "small" }, { SMALL + MUTED, "small-muted" } }
local RESULTS = {
	["no-bell"] = "no doorbell",
	placeholder = "the reply font was still empty",
	corrupt = "the reply did not decode",
	other = "the reply font held something else",
	bank = "the font bank is used up",
	["bank-full"] = "the font bank is used up",
}

-- A body of exactly `size` bytes that starts with `text`.
local function body(text, size)
	local filler = rep(" familiar", floor(size / 9) + 1)
	return (text .. filler):sub(1, size)
end

function Bench.Describe(path, style)
	if path == LANE then
		return "lane U"
	end
	local parts = { (floor(style / MUTED) % 2 == 1) and "muted" or "bright" }
	if floor(style / SMALL) % 2 == 1 then
		parts[#parts + 1] = "2 px"
	end
	parts[#parts + 1] = floor(style / HOLD) % 2 == 1 and "2 frames" or "1 frame"
	if floor(style / WORLD) % 2 == 1 then
		parts[#parts + 1] = "world"
	end
	return "screenshot (" .. concat(parts, ", ") .. ")"
end

local function result(t)
	return RESULTS[t.result] or t.result
end

-- Login ----------------------------------------------------------------------------

local function checkSetup()
	local problems = {}
	for _, name in ipairs({ "EnableAddOn", "DisableAddOn", "GetAddOnEnableState", "SaveAddOns" }) do
		if type(C_AddOns[name]) ~= "function" then
			problems[#problems + 1] = "C_AddOns." .. name .. " missing"
		end
	end
	if (Msg.missing or 0) > 0 then
		problems[#problems + 1] = Msg.missing .. " lane helpers missing: quit WoW completely and start it again"
	end
	for _, name in ipairs({ "Screenshot", "GetPhysicalScreenSize", "GetSessionTime", "SetUIVisibility" }) do
		if type(_G[name]) ~= "function" then
			problems[#problems + 1] = name .. " missing"
		end
	end
	return #problems == 0 and "ok" or concat(problems, "; ")
end

-- Self-test, doorbell probe, then a hello over lane U that the companion answers with a
-- doorbell: the player sees at once whether the companion runs.
function Bench.Start(isReload)
	sleep(1)
	Probe.WaitClock()
	local session = ns.session
	session.selftest = checkSetup()
	for attempt = 1, 3 do
		if Probe.ProbeDoorbell(session) or attempt == 3 then
			break
		end
		Probe.Event("sound-retry", session.sound)
		sleep(2)
	end
	Probe.Spawn("bells", Probe.Bells)
	ns.Say(
		format(
			"Self-test: %s. Doorbells: %s. Type /fspike bench to start.",
			session.selftest,
			Probe.DescribeDoorbell()
		)
	)
	if not Msg.HasLane() then
		return
	end
	local deadline = Probe.Now() + 5
	while not Probe.bellsReady and Probe.Now() < deadline do
		sleep(0.1)
	end
	local width, height = GetPhysicalScreenSize()
	local hello = format(
		"build=%s;reload=%d;nonce=%d;screen=%dx%d;uiscale=%.3f;%s",
		session.build,
		isReload and 1 or 0,
		session.nonce,
		width,
		height,
		UIParent:GetEffectiveScale(),
		session.settings
	)
	Msg.Post(function()
		local spec = { kind = KIND.hello, path = LANE, body = hello, tag = "hello" }
		if not Probe.DoorbellOn() then
			Msg.Send(spec)
			return
		end
		local t = Msg.Exchange(spec)
		if t.result == "ok" then
			ns.Say(format("Companion answered in %.2f s.", (t.done - t.start) / 1000))
		else
			ns.Say("No answer from the companion. Is familiar-spike running? The measurements go on; this is a result too.")
		end
	end)
end

-- /fspike say ------------------------------------------------------------------------

-- Sends the text alternately over lane U and in a screenshot; the screenshots cycle through
-- bright and muted, held one frame or two. The reply is 2 KB in the font bank.
function Bench.Say(text, editBox)
	if text == "" then
		ns.Say("Usage: /fspike say <text>")
		return
	end
	if not (ns.session and ns.session.selftest) then
		ns.Say("Not ready yet; the self-test is still running.")
		return
	end
	local db = ns.db
	db.says = (db.says or 0) + 1
	local n = db.says
	local path = (n % 2 == 1 and Msg.HasLane()) and LANE or SHOT
	local style = path == SHOT and SAY_STYLES[floor((n - 1) / 2) % #SAY_STYLES + 1] or 0
	local how = Bench.Describe(path, style)
	local anchor = Shot.Anchor(editBox)
	ns.Say(format("#%d via %s%s", n, how, Msg.Busy() and ", queued" or ""))
	Msg.Post(function()
		Probe.phase = "say"
		local spec = { kind = KIND.say, path = path, style = style, body = text, anchor = anchor, tag = "say" }
		if not Probe.DoorbellOn() then
			Msg.Send(spec)
			Probe.phase = "idle"
			ns.Say(format("#%d sent; doorbells are off on this client, so no reply.", n))
			return
		end
		spec.replyBytes = REPLY
		local t = Msg.Exchange(spec)
		Probe.phase = "idle"
		Bench.sent = Bench.sent + 1
		if t.result == "ok" and t.reply then
			Bench.answered = Bench.answered + 1
			local tries = t.message.attempt > 1 and ", second picture" or ""
			ns.Say(format("#%d answered in %s%s.", n, Msg.Timing(t), tries))
			ns.Say("|cffb0b0b0" .. Msg.FirstLine(t.reply.body) .. "|r")
		else
			ns.Say(format("#%d: %s after %.1f s.", n, result(t), (t.done - t.start) / 1000))
		end
	end)
end

-- Benchmark --------------------------------------------------------------------------

local function laneTests()
	for _, test in ipairs(LANE_TESTS) do
		local bits, gapMs = test.code == 1 and 64 or test.code == 2 and 128 or 256, floor(test.gap * 1000 + 0.5)
		Probe.phase = format("lane%d-%d", bits, gapMs)
		for i = 1, test.count do
			Msg.Send({
				kind = KIND.lane,
				path = LANE,
				code = test.code,
				gap = test.gap,
				body = body(format("lane test %d bits, %d ms, #%d", bits, gapMs, i), test.bytes),
				tag = format("%d/%d", bits, gapMs),
			})
			sleep(0.3)
		end
	end
	Probe.phase = "idle"
end

-- The companion rings for a bell message; muted or with the sound off the addon may not hear
-- it until the setting is back. Then it waits for that doorbell, so the next test starts clean.
local function bellTests()
	Probe.phase = "bells"
	for _, test in ipairs(BELL_TESTS) do
		local tag = test.tag
		if test.name then
			local ok, now = Settings.Set(test.name, test.value)
			tag = format("%s:%s%s", tag, now or "?", ok and "" or "!")
			sleep(0.3)
		end
		local bells = Probe.bellsHeard
		local t = Msg.Exchange({ kind = KIND.bell, path = LANE, body = "bell " .. tag, tag = tag, wait = 4 })
		if test.name then
			Settings.Restore(test.name)
		end
		if t.result ~= "ok" then
			local deadline = Probe.Now() + 4
			while Probe.bellsHeard == bells and Probe.Now() < deadline do
				sleep(0.05)
			end
			Probe.Event("bell-after", format("%s,%s", tag, Probe.bellsHeard > bells and format("%.0f", Probe.lastBellAt) or "-"))
		end
		ns.Say(format("Doorbell %s: %s.", tag, t.result == "ok" and "heard" or "not heard while set"))
	end
	Probe.phase = "idle"
end

local function roundTrips()
	Probe.phase = "trips"
	for _, path in ipairs({ LANE, SHOT }) do
		if path == SHOT or Msg.HasLane() then
			local t = Msg.Exchange({
				kind = KIND.trip,
				path = path,
				body = body("round trip", 120),
				replyBytes = REPLY,
				tag = "bench",
			})
			local how = Bench.Describe(path, 0)
			ns.Say(format("Round trip via %s: %s.", how, t.result == "ok" and Msg.Timing(t) or result(t)))
		end
	end
	Probe.phase = "idle"
end

local function shot(style, tag, anchor)
	Msg.Send({ kind = KIND.shot, path = SHOT, style = style, body = body("shot " .. tag, 200), tag = tag, anchor = anchor })
end

-- Pictures in every style, then with each picture setting at a limit, then with the interface
-- hidden as with Alt+Z: a block on UIParent should vanish with it, one on WorldFrame not.
local function shotTests()
	local anchor = Shot.Anchor()
	Probe.phase = "shots"
	for _, test in ipairs(SHOT_TESTS) do
		shot(test[1], test[2], anchor)
	end
	Probe.phase = "settings"
	for _, test in ipairs(PICTURE_TESTS) do
		local labels = {}
		for k = 1, #test, 2 do
			local ok, now = Settings.Set(test[k], test[k + 1])
			labels[#labels + 1] = format("%s:%s%s", test[k], now or "?", ok and "" or "!")
		end
		sleep(0.3)
		for _, style in ipairs(PICTURE_STYLES) do
			shot(style[1], labels[1] .. "/" .. style[2], anchor)
		end
		for k = 1, #test, 2 do
			Settings.Restore(test[k])
		end
		sleep(0.3)
	end
	-- A blocked call does not raise an error, so look whether the interface really went.
	Probe.phase = "noui"
	pcall(SetUIVisibility, false)
	sleep(0.3)
	if not UIParent:IsShown() then
		shot(0, "noui/ui", anchor)
		shot(WORLD, "noui/world", anchor)
	else
		Probe.Event("noui", "UIParent stayed visible")
		ns.Say("Could not hide the interface; that test is skipped.")
	end
	pcall(SetUIVisibility, true)
	Probe.phase = "idle"
end

function Bench.Run()
	Bench.running = true
	local session, fast = ns.session, Probe.Fast()
	local bench = {
		started = Probe.WallMs(),
		selftest = session.selftest,
		sound = session.sound,
		doorbell = session.doorbell,
		settings = Settings.Snapshot(),
	}
	session.bench = bench
	ns.Say(
		"Benchmark, about two minutes: stay out of combat. The screen flashes a few dozen times, picture and sound settings change for moments, and the interface disappears for a second."
	)
	Probe.phase = "baseline"
	sleep(fast and 1 or 10)
	Probe.phase = "idle"
	if Msg.HasLane() then
		laneTests()
		ns.Say("Lane U done.")
	end
	if Probe.DoorbellOn() then
		bellTests()
		roundTrips()
	end
	shotTests()
	bench.finished = Probe.WallMs()
	Bench.running = false
	ns.Say(
		format(
			"Benchmark done in %.0f s. Type /reload once so the results are saved, then keep playing.",
			(bench.finished - bench.started) / 1000
		)
	)
end

-- Soak -------------------------------------------------------------------------------

-- A short lane U message every minute, and every two minutes a screenshot that the companion
-- confirms with a doorbell and a one-font reply, taken again once if it does not. Both also in
-- combat; neither while another message is on its way.
function Bench.Soak()
	Probe.WaitClock()
	local fast = Probe.Fast()
	local laneEvery, shotEvery = fast and 4 or 60, fast and 6 or 120
	local nextLane, nextShot = Probe.Now() + (fast and 2 or 30), Probe.Now() + (fast and 5 or 90)
	local lanes, shots = 0, 0
	while true do
		local now = Probe.Now()
		if ns.db.soak and ns.session.selftest and not Msg.Busy() then
			if Msg.HasLane() and now >= nextLane then
				nextLane, lanes = now + laneEvery, lanes + 1
				local n = lanes
				Msg.Post(function()
					Probe.phase = "soak"
					Msg.Send({ kind = KIND.soak, path = LANE, body = format("soak %d %s", n, Probe.Context()), tag = "soak" })
					Probe.phase = "idle"
				end)
			elseif now >= nextShot then
				nextShot, shots = now + shotEvery, shots + 1
				local n = shots
				Msg.Post(function()
					Probe.phase = "soak"
					local spec = {
						kind = KIND.soak,
						path = SHOT,
						style = n % 2 == 0 and MUTED or 0,
						body = format("soak %d %s", n, Probe.Context()),
						tag = "soak",
					}
					if Probe.DoorbellOn() then
						spec.replyBytes = 64
						Msg.Exchange(spec)
					else
						Msg.Send(spec)
					end
					Probe.phase = "idle"
				end)
			end
		end
		sleep(0.25)
	end
end

function Bench.Status()
	return format(
		"doorbells %s, %d heard; /fspike say %d sent, %d answered; fonts next %d of %d; soak %s%s",
		Probe.DescribeDoorbell(),
		Probe.bellsHeard,
		Bench.sent,
		Bench.answered,
		ns.db.fontNext or 1,
		ns.Font.BANK,
		ns.db.soak and "on" or "off",
		Bench.running and "; benchmark running" or ""
	)
end
