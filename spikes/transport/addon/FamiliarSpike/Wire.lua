-- Frame codec and AddOns.txt lanes.
-- A lane is 256 empty helper addons. Each helper's per-character enable state
-- carries one bit, and C_AddOns.SaveAddOns() persists the whole frame at once.
local _, ns = ...

local band, bxor, rshift = bit.band, bit.bxor, bit.rshift
local byte, char, format, floor, rep = string.byte, string.char, string.format, math.floor, string.rep

local Wire = {
	BITS = 256,
	FRAME = 32,
	PAYLOAD = 20,
	DATA = 1,
	ACK = 2,
	CONTROL = 3,
	LAST = 2, -- flag on the final frame of a downlink message
}
ns.Wire = Wire

local CRC = {}
for i = 0, 255 do
	local c = i
	for _ = 1, 8 do
		if band(c, 1) == 1 then
			c = bxor(rshift(c, 1), 0xEDB88320)
		else
			c = rshift(c, 1)
		end
	end
	CRC[i] = c
end

-- CRC-32 (IEEE) as an unsigned number.
function Wire.Crc32(s, first, last)
	local crc = -1
	for i = first or 1, last or #s do
		crc = bxor(rshift(crc, 8), CRC[band(bxor(crc, byte(s, i)), 0xFF)])
	end
	crc = bxor(crc, -1)
	if crc < 0 then
		crc = crc + 4294967296
	end
	return crc
end

function Wire.U16(n)
	return char(n % 256, floor(n / 256) % 256)
end

function Wire.U32(n)
	return char(n % 256, floor(n / 256) % 256, floor(n / 65536) % 256, floor(n / 16777216) % 256)
end

function Wire.ReadU16(s, i)
	local a, b = byte(s, i, i + 1)
	return a + b * 256
end

function Wire.ReadU32(s, i)
	local a, b, c, d = byte(s, i, i + 3)
	return a + b * 256 + c * 65536 + d * 16777216
end

-- Layout: "FS", kind, epoch, seq (u16), length, flags, 20 payload bytes, CRC-32 of bytes 1-28.
function Wire.Encode(kind, epoch, seq, payload, flags)
	local body = "FS"
		.. char(kind, epoch)
		.. Wire.U16(seq)
		.. char(#payload, flags or 0)
		.. payload
		.. rep("\0", Wire.PAYLOAD - #payload)
	return body .. Wire.U32(Wire.Crc32(body))
end

function Wire.Decode(frame)
	if #frame ~= Wire.FRAME or frame:sub(1, 2) ~= "FS" then
		return nil
	end
	if Wire.Crc32(frame, 1, 28) ~= Wire.ReadU32(frame, 29) then
		return nil
	end
	local length = byte(frame, 7)
	if length > Wire.PAYLOAD then
		return nil
	end
	return {
		kind = byte(frame, 3),
		epoch = byte(frame, 4),
		seq = Wire.ReadU16(frame, 5),
		flags = byte(frame, 8),
		payload = frame:sub(9, 8 + length),
	}
end

local function laneNames(letter)
	local names = {}
	for i = 0, Wire.BITS - 1 do
		names[i] = format("FamiliarSpike_%s%03d", letter, i)
	end
	return names
end

Wire.UP, Wire.DOWN = laneNames("U"), laneNames("D")

local POW2 = { [0] = 1, 2, 4, 8, 16, 32, 64, 128 }

local Writer = {}
Writer.__index = Writer

function Wire.NewWriter(names, character)
	local writer = setmetatable({ names = names, character = character, bits = {} }, Writer)
	writer:Sync()
	return writer
end

-- Reads the client's current state, for example after the player used the addon list.
function Writer:Sync()
	for i = 0, Wire.BITS - 1 do
		self.bits[i] = C_AddOns.GetAddOnEnableState(self.names[i], self.character) == 2
	end
end

-- Applies a frame and persists it. Returns toggle ms, save ms and the number of flipped bits.
function Writer:Write(frame)
	local enable, disable = C_AddOns.EnableAddOn, C_AddOns.DisableAddOn
	local names, bits, character = self.names, self.bits, self.character
	local started, flipped = debugprofilestop(), 0
	for index = 1, Wire.FRAME do
		local value, base = byte(frame, index), (index - 1) * 8
		for offset = 0, 7 do
			local wanted = floor(value / POW2[offset]) % 2 == 1
			local i = base + offset
			if bits[i] ~= wanted then
				if wanted then
					enable(names[i], character)
				else
					disable(names[i], character)
				end
				bits[i] = wanted
				flipped = flipped + 1
			end
		end
	end
	local toggled = debugprofilestop()
	C_AddOns.SaveAddOns()
	return toggled - started, debugprofilestop() - toggled, flipped
end

local Reader = {}
Reader.__index = Reader

function Wire.NewReader(names, character)
	return setmetatable({ names = names, character = character }, Reader)
end

-- Reloads AddOns.txt from disk. Returns the lane as a frame, reset ms and read ms.
function Reader:Read()
	local started = debugprofilestop()
	C_AddOns.ResetAddOns()
	local reset = debugprofilestop()
	local get, names, character, bytes = C_AddOns.GetAddOnEnableState, self.names, self.character, {}
	for index = 1, Wire.FRAME do
		local value, base = 0, (index - 1) * 8
		for offset = 0, 7 do
			if get(names[base + offset], character) == 2 then
				value = value + POW2[offset]
			end
		end
		bytes[index] = value
	end
	local frame = char(unpack(bytes))
	return frame, reset - started, debugprofilestop() - reset
end
