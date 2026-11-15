-- Doorbells, app to addon (ADR 0005): the app raises a doorbell by turning an empty .wav into
-- 1.5 s of silence. The addon plays the file on the master channel and asks a quarter second
-- later whether it still plays; the client reports even an empty file as played. A raised file
-- stays raised until the client restarts, so each doorbell rings once per game start.
-- Two rows: ack\NNN.wav confirms a message from the addon, msg\NNN.wav announces one in the
-- font bank.
local _, ns = ...
local Tasks = ns.Tasks

local format = string.format

local Bells = { COUNT = 600 }
ns.Bells = Bells

local ROOT = "Interface\\AddOns\\Familiar\\"
-- Set by the self-test on clients that report a sound as playing only after ~0.8 s.
local late = false

function Bells.Path(row, n)
	return format("%s%s\\%03d.wav", ROOT, row, n)
end

local function play(path)
	local ok, willPlay, handle = pcall(PlaySoundFile, path, "Master")
	if ok and willPlay and handle then
		return handle
	end
end

local function playing(handle)
	local ok, on = pcall(C_Sound.IsPlaying, handle)
	return ok and on == true
end

-- Whether the doorbell at `path` rings (task context). Always waits, so a loop around it never
-- spins within one frame, not even without game sound.
function Bells.Rings(path)
	local handle = play(path)
	Tasks.Sleep(0.25)
	if not handle then
		return false
	end
	local on = playing(handle)
	if not on and late then
		Tasks.Sleep(0.5)
		on = playing(handle)
	end
	pcall(StopSound, handle)
	return on
end

-- Whether doorbells can ring: a long sound must play and an empty one must not. Looks twice,
-- because once, right after a /reload under Proton, even the long file played late (FAM-15).
-- Returns "ok", "off" (no game sound) or "broken".
local function check()
	local long, empty = play(ROOT .. "test\\long.wav"), play(ROOT .. "test\\empty.wav")
	if not long then
		if empty then
			pcall(StopSound, empty)
		end
		return "off"
	end
	local seen = {}
	for look, wait in ipairs({ 0.3, 0.5 }) do
		Tasks.Sleep(wait)
		seen[look] = { playing(long), empty and playing(empty) }
	end
	pcall(StopSound, long)
	if empty then
		pcall(StopSound, empty)
	end
	if (seen[1][1] or seen[2][1]) and not (seen[1][2] or seen[2][2]) then
		late = not seen[1][1]
		return "ok"
	end
	return "broken"
end

-- Up to three tries, two seconds apart (task context).
function Bells.SelfTest()
	local result
	for try = 1, 3 do
		result = check()
		if result == "ok" then
			break
		end
		if try < 3 then
			Tasks.Sleep(2)
		end
	end
	return result
end
