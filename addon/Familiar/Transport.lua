-- The transport to the Familiar app (ADR 0005). Up, the addon sends a message over the lane and
-- the app confirms it by raising the ack doorbell the message names; without that the addon
-- sends it again. Down, the app writes a message into the next fonts of the bank and raises the
-- next message doorbell; the addon reads the fonts once that doorbell rings. Formats:
-- core/src/transport/codec.ts.
--
-- Doorbells and fonts work once per game start, so the addon counts them per client process in
-- its saved state, and the app empties them when the game starts. If the app did not run then,
-- doorbells from an earlier game may still be raised. Fonts carry a session key, random per game
-- start and account, so the addon counts as connected only once a welcome with its own key
-- answers its hello. The app then silences what the earlier game left.
local _, ns = ...
local Codec, Tasks, Lane, Bells, Bank = ns.Codec, ns.Tasks, ns.Lane, ns.Bells, ns.Bank

local byte, char, format, sub = string.byte, string.char, string.format, string.sub
local abs, floor, min, random = math.abs, math.floor, math.min, math.random
local U16, U32, ReadU16, ReadU32 = Codec.U16, Codec.U32, Codec.ReadU16, Codec.ReadU32

local Transport = { connected = false }
ns.Transport = Transport

local VERSION = 1
local DOWN_PAYLOAD = 492 -- payload bytes per font
local ACK_WAIT, ATTEMPTS = 3, 3 -- seconds per attempt, attempts per message
local HELLO_WAIT, HELLO_WAIT_MAX = 5, 30 -- seconds to wait for a welcome, doubling up to the max
-- Where the transport looks whether the client reads files of an addon that never loads.
local PROBE = "Interface\\AddOns\\Familiar_L000\\probe."

local state -- FamiliarDB.transport: process, key, id, ack, bell, font
local queue, handlers = {}, {}
local problem -- why this session cannot send, if it cannot
local helloBody
local function nothing() end

-- Sending -----------------------------------------------------------------------------

local function encode(hello, ack, body)
	state.id = state.id % 65535 + 1
	local bytes = "FU"
		.. char(VERSION, hello and 1 or 0)
		.. U32(state.key)
		.. U16(state.id)
		.. U16(ack)
		.. U16(state.bell)
		.. U16(state.font)
		.. U16(#body)
		.. body
	return bytes .. U32(Codec.Crc32(bytes))
end

local function disconnect(text)
	Transport.connected = false
	ns.Print(text)
	for _, job in ipairs(queue) do
		job.done(false, "lost the connection to the app")
	end
	queue = {}
end

-- An attempt that goes unconfirmed is sent again, with the same id and ack doorbell: the app
-- may have the message already.
local function send(job)
	if state.ack > Bells.COUNT then
		return job.done(false, "all doorbells are used until WoW restarts")
	end
	local ack = state.ack
	state.ack = ack + 1
	local bytes = encode(false, ack, job.body)
	for _ = 1, ATTEMPTS do
		Lane.Send(bytes)
		local deadline = Tasks.Now() + ACK_WAIT
		repeat
			if Bells.Rings(Bells.Path("ack", ack)) then
				return job.done(true)
			end
		until Tasks.Now() >= deadline
	end
	job.done(false, "no answer from the app")
	disconnect("The Familiar app stopped answering. Familiar keeps trying.")
end

-- Says hello until a welcome comes back. A hello names the last ack doorbell used, so the app
-- knows from where on doorbells may be left over from an earlier game.
local function connect()
	local wait, said = HELLO_WAIT, false
	while not Transport.connected do
		Lane.Send(encode(true, state.ack - 1, helloBody))
		local deadline = Tasks.Now() + wait
		repeat
			Tasks.Sleep(0.1)
		until Transport.connected or Tasks.Now() >= deadline
		if not Transport.connected and not said then
			ns.Print("The Familiar app does not answer. Start it; Familiar keeps trying.")
			said = true
		end
		wait = min(wait * 2, HELLO_WAIT_MAX)
	end
end

-- The only task that uses the lane.
local function worker()
	while true do
		if not Transport.connected then
			connect()
		end
		local job = table.remove(queue, 1)
		if job then
			send(job)
		else
			Tasks.Sleep(0.05)
		end
	end
end

-- Queues `body` for the app. done(ok, why) runs once the app confirmed it or the addon gave up.
function Transport.Send(body, done)
	done = done or nothing
	if problem or not Transport.connected then
		return done(false, problem or "not connected to the Familiar app")
	end
	queue[#queue + 1] = { body = body, done = done }
end

-- Receiving ---------------------------------------------------------------------------

function Transport.OnMessage(handler)
	handlers[#handlers + 1] = handler
end

local function decode(packet)
	if not packet or sub(packet, 1, 2) ~= "FD" or byte(packet, 3) ~= VERSION then
		return nil
	end
	local p = {
		welcome = byte(packet, 4) % 2 == 1,
		key = ReadU32(packet, 5),
		bell = ReadU16(packet, 9),
		slot = ReadU16(packet, 11),
		part = byte(packet, 13),
		parts = byte(packet, 14),
	}
	local length = ReadU16(packet, 15)
	if p.part >= p.parts or length > DOWN_PAYLOAD then
		return nil
	end
	p.payload = sub(packet, 17, 16 + length)
	return p
end

local function lost(why)
	ns.Print(format("A message from the app was lost (%s).", why))
end

-- Reads the message whose doorbell just rang. A font that was read is used up either way.
local function read()
	local slot = state.font
	if slot > Bank.FONTS then
		state.bell = state.bell + 1
		return lost("the font bank is used up until WoW restarts")
	end
	local packet, why = Bank.Read(slot)
	local p = decode(packet)
	if not p or p.slot ~= slot then
		state.font, state.bell = slot + 1, state.bell + 1
		return lost(why or "unknown format")
	end
	state.font = slot - p.part + p.parts
	if p.key ~= state.key or p.part ~= 0 then
		-- Written for an earlier game, or we lost track: skip its fonts unread.
		state.bell = state.bell + 1
		return
	end
	state.bell = p.bell + 1
	local parts = { p.payload }
	for part = 1, p.parts - 1 do
		local q = decode((Bank.Read(slot + part)))
		if not (q and q.key == p.key and q.bell == p.bell and q.slot == slot + part and q.part == part) then
			return lost("part " .. part .. " unreadable")
		end
		parts[part + 1] = q.payload
	end
	local body = table.concat(parts)
	if p.welcome then
		if not Transport.connected then
			Transport.connected = true
			ns.Print(format("Connected to %s.", body))
		end
		return
	end
	for _, handler in ipairs(handlers) do
		local ok, err = pcall(handler, body)
		if not ok then
			ns.Error("message handler", err)
		end
	end
end

local function receiver()
	while true do
		if state.bell <= Bells.COUNT and Bells.Rings(Bells.Path("msg", state.bell)) then
			read()
		end
		Tasks.Sleep(0)
	end
end

-- Session -----------------------------------------------------------------------------

-- A new client process starts with empty caches. time() - GetSessionTime() is when the client
-- started; a /reload or a character switch keeps the process. As a second sign, the last
-- doorbell heard falls silent in a new process, once the app has emptied the bank.
local function newProcess(started)
	if not state.process or abs(started - state.process) > 10 then
		return true
	end
	return state.bell > 1 and not Bells.Rings(Bells.Path("msg", state.bell - 1))
end

local function hello()
	local version = C_AddOns.GetAddOnMetadata("Familiar", "Version") or "?"
	local _, build = GetBuildInfo()
	local font = Bank.Loads(PROBE .. "ttf", 2)
	local sound = Bells.Rings(PROBE .. "wav")
	Transport.probe = format("font %s, sound %s", font and "yes" or "no", sound and "yes" or "no")
	return format("Familiar %s, build %s; files of an addon that never loads: %s", version, tostring(build), Transport.probe)
end

local function fail(text)
	problem = text
	ns.Print(text)
end

local function session()
	local missing = Lane.Resolve()
	if missing > 0 then
		return fail(
			format("%d of 256 transport helpers are missing. Run the Familiar app, then restart WoW completely.", missing)
		)
	end
	local sound = Bells.SelfTest()
	Transport.sound = sound
	if sound == "broken" then
		return fail("This client cannot ring Familiar's doorbells: an empty sound plays like a long one.")
	end
	if sound == "off" then
		fail("Familiar needs the game sound: turn on Enable Sound in Settings > Audio. Volume 0 is enough.")
		repeat
			Tasks.Sleep(10)
			sound = Bells.SelfTest()
		until sound == "ok"
		Transport.sound, problem = sound, nil
	end

	local started = time() - floor(GetSessionTime())
	if newProcess(started) then
		state.process, state.key = started, random(0, 65535) * 65536 + random(0, 65535)
		state.ack, state.bell, state.font = 1, 1, 1
	end
	state.id = state.id or 0
	helloBody = hello()
	Tasks.Spawn("receiver", receiver)
	Tasks.Spawn("sender", worker)
end

-- At the start of every UI session: login, character switch or /reload.
function Transport.Start(saved)
	state = saved
	Tasks.Spawn("session", session)
end

function Transport.Status()
	if not state or not state.key then
		return "starting"
	end
	return format(
		"%s, sound %s; used since the game started: %d of %d confirmations, %d of %d message doorbells, %d of %d fonts; probe: %s",
		Transport.connected and "connected" or "not connected",
		Transport.sound or "untested",
		state.ack - 1,
		Bells.COUNT,
		state.bell - 1,
		Bells.COUNT,
		state.font - 1,
		Bank.FONTS,
		Transport.probe or "not run"
	)
end
