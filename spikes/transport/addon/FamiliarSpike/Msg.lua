-- Messages, addon -> companion, over lane U or in a screenshot, and replies, companion ->
-- addon, in the font bank, announced by a doorbell. Formats: src/protocol.ts.
--
-- One worker sends everything, one job at a time: lane frames of two messages never mix, and
-- at most one message waits for a doorbell, so a doorbell always belongs to it.
local _, ns = ...
local Wire, Font, Shot, Probe = ns.Wire, ns.Font, ns.Shot, ns.Probe

local byte, char, format, sub = string.byte, string.char, string.format, string.sub
local ceil, floor, max = math.ceil, math.floor, math.max
local U16, U48 = Wire.U16, Wire.U48
local sleep = Probe.Sleep

local Msg = {
	KIND = { say = 1, soak = 2, lane = 3, bell = 4, shot = 5, trip = 6, hello = 7 },
	LANE = 1,
	SHOT = 2,
}
ns.Msg = Msg

local VERSION_BYTE, REPLY_HEADER, FONT_PAYLOAD = 5, 22, 490
local KIND_NAMES = {}
for name, kind in pairs(Msg.KIND) do
	KIND_NAMES[kind] = name
end

local writer, sentInFrame, lastShotSecond = nil, -1, nil

function Msg.Setup(character)
	local indices, missing = Wire.Resolve()
	Msg.missing = missing or 0
	writer = indices and Wire.NewWriter(indices, character) or nil
	return writer ~= nil
end

function Msg.HasLane()
	return writer ~= nil
end

function Msg.Invalidate()
	if writer then
		writer:Invalidate()
	end
end

function Msg.NextId(db)
	local id = (db.nextId or 0) % 65535 + 1
	db.nextId = id
	return id
end

-- m: kind, epoch, id, attempt, wallMs, retryOf, fontNext, replyBytes, path, style, body.
function Msg.Encode(m)
	local bytes = "FM"
		.. char(VERSION_BYTE, m.kind, m.epoch)
		.. U16(m.id)
		.. char(m.attempt or 1)
		.. U48(m.wallMs)
		.. U48(m.retryOf or 0)
		.. U16(m.fontNext or 0)
		.. U16(m.replyBytes or 0)
		.. char(m.path, m.style or 0)
		.. U16(#m.body)
		.. m.body
	return bytes .. Wire.U32(Wire.Crc32(bytes))
end

-- Sending ------------------------------------------------------------------------

-- Sends bytes over lane U: `code` 1, 2 or 3 uses 64, 128 or 256 helpers, `gap` is the least
-- time between saves, and a last save puts every helper back off. Never while the player has
-- the addon list open, and at most one save per rendered frame: a second save in the same
-- frame would overwrite the first before the companion could read it.
function Msg.SendLane(bytes, code, gap)
	local size = Wire.WIDTHS[code] - 3
	local r = { code = code, gap = gap, frames = ceil(#bytes / size), flips = 0, mismatches = 0 }
	local toggles, saves, lastAt = {}, {}, -1
	local function save(frame)
		while Probe.ListOpen() or sentInFrame == Probe.FrameNo() or Probe.Now() - lastAt < gap do
			sleep(Probe.ListOpen() and 0.25 or 0)
		end
		sentInFrame, lastAt = Probe.FrameNo(), Probe.Now()
		local at, started = Probe.WallMs(), debugprofilestop()
		local toggle, saved, flipped, bad = writer:Write(frame)
		Probe.Charge(debugprofilestop() - started)
		toggles[#toggles + 1], saves[#saves + 1] = toggle, saved
		r.flips, r.mismatches = r.flips + flipped, r.mismatches + bad
		return at
	end
	for k = 0, r.frames - 1 do
		local at = save(Wire.Frame(code, k == 0, k, sub(bytes, k * size + 1, (k + 1) * size)))
		r.first = r.first or at
		r.last = at
	end
	r.rest = save(Wire.REST)
	r.toggle, r.save = Probe.Summarize(toggles), Probe.Summarize(saves)
	return r
end

-- One picture per second at most, counting the player's: the file names count seconds.
function Msg.SendShot(bytes, style, anchor)
	while time() == lastShotSecond or time() == Shot.lastSecond do
		sleep(0.05)
	end
	local r = Shot.Take(bytes, style, anchor, sleep)
	lastShotSecond = time()
	return r
end

-- Format of a lane record: "id,attempt,kind,tag,code,gapMs,bytes,frames,firstMs,lastMs,restMs,
-- toggle,save,flips,mismatches,context", toggle and save as Probe.Summarize does.
local function laneRecord(m, r, bytes)
	return format(
		"%d,%d,%s,%s,%d,%.0f,%d,%d,%.0f,%.0f,%.0f,%s,%s,%d,%d,%s",
		m.id,
		m.attempt,
		KIND_NAMES[m.kind] or "?",
		m.tag or "-",
		r.code,
		r.gap * 1000,
		#bytes,
		r.frames,
		r.first,
		r.last,
		r.rest,
		r.toggle,
		r.save,
		r.flips,
		r.mismatches,
		m.context or "-"
	)
end

-- Builds and sends one attempt of a message. spec: kind, body, path, code, gap, style, anchor,
-- tag. Returns the attempt's start time.
local function sendAttempt(spec, m)
	local session = ns.session
	m.wallMs = Probe.WallMs()
	m.context = Probe.Context()
	local bytes = Msg.Encode(m)
	if m.path == Msg.LANE then
		local r = Msg.SendLane(bytes, spec.code or 3, spec.gap or 0.033)
		if #session.lane < 1500 then
			session.lane[#session.lane + 1] = laneRecord(m, r, bytes)
		end
	else
		local r = Msg.SendShot(bytes, m.style, spec.anchor or Shot.Anchor())
		r.id, r.attempt, r.tag = m.id, m.attempt, m.tag
		m.called = r.called
		if #session.shots < 500 then
			session.shots[#session.shots + 1] = Shot.Format(r)
		end
	end
	return m.wallMs
end

-- Sends a message that wants no answer.
function Msg.Send(spec)
	local m = {
		kind = spec.kind,
		epoch = ns.session.epoch,
		id = Msg.NextId(ns.db),
		attempt = 1,
		path = spec.path,
		style = spec.style or 0,
		body = spec.body,
		tag = spec.tag,
	}
	sendAttempt(spec, m)
	return m
end

-- Replies -------------------------------------------------------------------------

-- Reads the reply that starts at font `first`. Returns the reply, a result and the fonts read.
local function readReply(m, first)
	local db, parts, need, total = ns.db, {}, 1, nil
	local k = 0
	while k < need do
		local slot = first + k
		if slot > Font.BANK then
			return nil, "bank", k
		end
		Font.Used(db, slot)
		local r = Font.Read(slot, sleep, Probe.Charge)
		if r.result ~= "ok" then
			return nil, r.result, k + 1
		end
		if r.part ~= k then
			return nil, "other", k + 1
		end
		parts[#parts + 1] = r.payload
		if k == 0 then
			local head = r.payload
			if sub(head, 1, 2) ~= "FR" or byte(head, 3) ~= VERSION_BYTE then
				return nil, "other", 1
			end
			total = REPLY_HEADER + Wire.ReadU16(head, 21) + 4
			need = ceil(total / FONT_PAYLOAD)
		end
		k = k + 1
	end
	local bytes = sub(table.concat(parts), 1, total)
	if Wire.Crc32(bytes, 1, total - 4) ~= Wire.ReadU32(bytes, total - 3) then
		return nil, "corrupt", need
	end
	local reply = {
		epoch = byte(bytes, 4),
		id = Wire.ReadU16(bytes, 5),
		attempt = byte(bytes, 7),
		received = Wire.ReadU48(bytes, 8),
		written = Wire.ReadU48(bytes, 14),
		path = byte(bytes, 20),
		body = sub(bytes, REPLY_HEADER + 1, total - 4),
	}
	if reply.epoch ~= m.epoch or reply.id ~= m.id then
		return nil, "other", need
	end
	return reply, "ok", need
end

-- Format of a trip record: "id,attempts,kind,path,style,tag,startMs,sentMs,bellMs|-,doneMs,
-- receivedMs|-,writtenMs|-,firstFont,fonts,replyBytes,result,context". sentMs is when the last
-- attempt was out: the lane's rest frame, or the screenshot call.
local function tripRecord(m, t)
	local function stamp(v)
		return v and format("%.0f", v) or "-"
	end
	return format(
		"%d,%d,%s,%d,%d,%s,%.0f,%.0f,%s,%.0f,%s,%s,%d,%d,%d,%s,%s",
		m.id,
		m.attempt,
		KIND_NAMES[m.kind] or "?",
		m.path,
		m.style,
		m.tag or "-",
		t.start,
		t.sent,
		stamp(t.bell),
		t.done,
		stamp(t.reply and t.reply.received),
		stamp(t.reply and t.reply.written),
		m.fontNext,
		t.fonts or 0,
		m.replyBytes,
		t.result,
		m.context or "-"
	)
end

-- Sends a message and waits for its doorbell; with replyBytes > 0 the reply comes in the fonts
-- the message names. A screenshot without a doorbell is taken once more, held a frame longer.
-- spec: as Msg.Send, plus replyBytes and wait (seconds per attempt). Returns the trip.
function Msg.Exchange(spec)
	local db, session = ns.db, ns.session
	local m = {
		kind = spec.kind,
		epoch = session.epoch,
		id = Msg.NextId(db),
		attempt = 1,
		path = spec.path,
		style = spec.style or 0,
		body = spec.body,
		tag = spec.tag,
		fontNext = 0,
		replyBytes = 0,
	}
	local t = { start = Probe.WallMs() }
	if (spec.replyBytes or 0) > 0 then
		local first, fonts = Font.Peek(db), ceil((REPLY_HEADER + spec.replyBytes + 4) / FONT_PAYLOAD)
		if first and first + fonts - 1 <= Font.BANK then
			m.fontNext, m.replyBytes = first, spec.replyBytes
			Font.Used(db, first + fonts - 1)
		else
			t.bankFull = true
		end
	end
	local wait = spec.wait or (Probe.Fast() and 5 or 10)
	local attempts = m.path == Msg.SHOT and 2 or 1
	local heard = false
	while true do
		local bells = Probe.bellsHeard
		sendAttempt(spec, m)
		t.sent = m.path == Msg.SHOT and m.called or Probe.WallMs()
		local deadline = Probe.Now() + wait
		while Probe.bellsHeard == bells and Probe.Now() < deadline do
			sleep(0.05)
		end
		heard = Probe.bellsHeard > bells
		if heard or m.attempt >= attempts then
			break
		end
		m.retryOf, m.attempt = m.called or m.wallMs, m.attempt + 1
		m.style = bit.bor(m.style, Shot.HOLD)
	end
	t.bell = heard and Probe.lastBellAt or nil
	if not heard then
		t.result = "no-bell"
	elseif m.fontNext > 0 then
		t.reply, t.result, t.fonts = readReply(m, m.fontNext)
	else
		t.result = t.bankFull and "bank-full" or "ok"
	end
	t.done = Probe.WallMs()
	if #session.trips < 500 then
		session.trips[#session.trips + 1] = tripRecord(m, t)
	end
	t.message = m
	return t
end

-- Worker ---------------------------------------------------------------------------
local queue, busy = {}, false

-- Queues a job, a function that runs on the worker coroutine.
function Msg.Post(job)
	queue[#queue + 1] = job
end

function Msg.Busy()
	return busy or #queue > 0
end

function Msg.Worker()
	while true do
		local job = table.remove(queue, 1)
		if job then
			busy = true
			job()
			busy = false
		else
			sleep(0.1)
		end
	end
end

-- The worker died with this job: the next one may start.
function Msg.Reset()
	busy = false
end

function Msg.KindName(kind)
	return KIND_NAMES[kind] or "?"
end

-- "1.62 s: up 0.31 s, companion 0.02 s, doorbell 0.40 s, fonts 0.89 s"
function Msg.Timing(t)
	local function s(ms)
		return format("%.2f s", max(0, ms) / 1000)
	end
	local reply = t.reply
	if not (reply and t.bell) then
		return s(t.done - t.start)
	end
	return format(
		"%s: up %s, companion %s, doorbell %s, fonts %s",
		s(t.done - t.start),
		s(reply.received - t.start),
		s(reply.written - reply.received),
		s(t.bell - reply.written),
		s(t.done - t.bell)
	)
end

function Msg.FirstLine(text)
	return (text:match("^[^\n]*") or ""):sub(1, 120)
end

-- Rounds to whole ms for chat.
function Msg.Ms(v)
	return floor(v + 0.5)
end
