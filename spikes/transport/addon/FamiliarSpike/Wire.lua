-- Frame codec and AddOns.txt lanes.
-- A lane is 256 empty helper addons. Each helper's per-character enable state carries one
-- bit. Helpers are addressed by index, as Blizzard's own addon list does.
local _, ns = ...

local band, bxor, rshift = bit.band, bit.bxor, bit.rshift
local byte, char, format, floor, rep = string.byte, string.char, string.format, math.floor, string.rep

local Wire = {
	BITS = 256,
	FRAME = 32,
	PAYLOAD = 20,
	DATA = 1,
	CONTROL = 3,
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

-- Six bytes, enough for a wall time in ms.
function Wire.ReadU48(s, i)
	return Wire.ReadU32(s, i) + Wire.ReadU16(s, i + 4) * 4294967296
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

function Wire.LaneName(letter, i)
	return format("FamiliarSpike_%s%03d", letter, i)
end

-- Indices of a lane's 256 helpers, or nil and the number of helpers the client does not know.
function Wire.Resolve(letter)
	local wanted, indices, found = {}, {}, 0
	for i = 0, Wire.BITS - 1 do
		wanted[Wire.LaneName(letter, i)] = i
	end
	for index = 1, C_AddOns.GetNumAddOns() do
		local bitIndex = wanted[(C_AddOns.GetAddOnInfo(index))]
		if bitIndex then
			indices[bitIndex] = index
			found = found + 1
		end
	end
	if found < Wire.BITS then
		return nil, Wire.BITS - found
	end
	return indices
end

local POW2 = { [0] = 1, 2, 4, 8, 16, 32, 64, 128 }

-- The writer cannot trust the state the client reports. Measured on build 70888 (FAM-15): a
-- character's AddOns.txt holds rows only for the addons set for that character, and the client
-- keeps one enable state for the whole process. Logging in and ResetAddOns apply the
-- character's rows; a helper without a row keeps whatever the previous character left in
-- memory. GetAddOnEnableState reports that memory, SaveAddOns writes only the rows, so a bit
-- that memory already holds never reaches the file. The writer therefore disables every helper
-- before its first frame and after anything that may have changed the lane: from then on each
-- enabled bit has a row of its own, written by a real change.
local Writer = {}
Writer.__index = Writer

function Wire.NewWriter(indices, character)
	return setmetatable({ indices = indices, character = character, bits = {}, stale = true }, Writer)
end

-- The client may have changed the lane, for example after ResetAddOns or the player's addon list.
function Writer:Invalidate()
	self.stale = true
end

-- Applies a frame and persists it. Returns toggle ms, save ms, flipped bits and how many
-- flipped bits the client did not take.
function Writer:Write(frame)
	local enable, disable, state = C_AddOns.EnableAddOn, C_AddOns.DisableAddOn, C_AddOns.GetAddOnEnableState
	local indices, bits, character = self.indices, self.bits, self.character
	local started, flipped = debugprofilestop(), {}
	if self.stale then
		for i = 0, Wire.BITS - 1 do
			disable(indices[i], character)
			bits[i] = false
		end
		self.stale = false
	end
	for index = 1, Wire.FRAME do
		local value, base = byte(frame, index), (index - 1) * 8
		for offset = 0, 7 do
			local wanted = floor(value / POW2[offset]) % 2 == 1
			local i = base + offset
			if bits[i] ~= wanted then
				if wanted then
					enable(indices[i], character)
				else
					disable(indices[i], character)
				end
				bits[i] = wanted
				flipped[#flipped + 1] = i
			end
		end
	end
	local toggled = debugprofilestop()
	C_AddOns.SaveAddOns()
	local saved = debugprofilestop()
	local mismatches = 0
	for _, i in ipairs(flipped) do
		if (state(indices[i], character) == 2) ~= bits[i] then
			mismatches = mismatches + 1
		end
	end
	return toggled - started, saved - toggled, #flipped, mismatches
end

local Reader = {}
Reader.__index = Reader

function Wire.NewReader(indices, character)
	return setmetatable({ indices = indices, character = character }, Reader)
end

-- Calls ResetAddOns, then reads the lane. Returns the frame, reset ms and read ms.
function Reader:Read()
	local started = debugprofilestop()
	C_AddOns.ResetAddOns()
	local reset = debugprofilestop()
	local state, indices, character, bytes = C_AddOns.GetAddOnEnableState, self.indices, self.character, {}
	for index = 1, Wire.FRAME do
		local value, base = 0, (index - 1) * 8
		for offset = 0, 7 do
			if state(indices[base + offset], character) == 2 then
				value = value + POW2[offset]
			end
		end
		bytes[index] = value
	end
	return char(unpack(bytes)), reset - started, debugprofilestop() - reset
end
