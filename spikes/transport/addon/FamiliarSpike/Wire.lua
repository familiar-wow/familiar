-- Codecs and lane U. The lane is 256 empty helper addons; each helper's per-character enable
-- state carries one bit, and C_AddOns.SaveAddOns writes them to AddOns.txt for the companion.
-- A frame uses the first 64, 128 or all 256 helpers. Formats: src/protocol.ts.
local _, ns = ...

local band, bxor, lshift, rshift = bit.band, bit.bxor, bit.lshift, bit.rshift
local byte, char, format, floor, rep = string.byte, string.char, string.format, math.floor, string.rep

local Wire = { BITS = 256, WIDTHS = { 8, 16, 32 } }
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

-- CRC-16/CCITT-FALSE.
function Wire.Crc16(s, first, last)
	local crc = 0xFFFF
	for i = first or 1, last or #s do
		crc = bxor(crc, lshift(byte(s, i), 8))
		for _ = 1, 8 do
			if band(crc, 0x8000) ~= 0 then
				crc = band(bxor(lshift(crc, 1), 0x1021), 0xFFFF)
			else
				crc = band(lshift(crc, 1), 0xFFFF)
			end
		end
	end
	return crc
end

function Wire.U16(n)
	return char(n % 256, floor(n / 256) % 256)
end

function Wire.U32(n)
	return char(n % 256, floor(n / 256) % 256, floor(n / 65536) % 256, floor(n / 16777216) % 256)
end

function Wire.U48(n)
	n = floor(n)
	return Wire.U32(n % 4294967296) .. Wire.U16(floor(n / 4294967296))
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

-- One lane frame: width code (bits 7-6), first-frame flag (bit 5) and sequence (bits 4-0),
-- a chunk of the message, then a CRC-16 of everything before it.
function Wire.Frame(code, first, seq, chunk)
	local size = Wire.WIDTHS[code]
	local head = char(code * 64 + (first and 32 or 0) + seq % 32) .. chunk .. rep("\0", size - 3 - #chunk)
	local crc = Wire.Crc16(head)
	return head .. char(crc % 256, floor(crc / 256))
end

Wire.REST = rep("\0", 32)

function Wire.LaneName(i)
	return format("FamiliarSpike_U%03d", i)
end

-- Indices of the 256 helpers, or nil and the number of helpers the client does not know.
function Wire.Resolve()
	local wanted, indices, found = {}, {}, 0
	for i = 0, Wire.BITS - 1 do
		wanted[Wire.LaneName(i)] = i
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

-- The client may have changed the lane, for example after the player's addon list.
function Writer:Invalidate()
	self.stale = true
end

-- Whether every helper is off, as the addon list saw them when the UI loaded.
function Writer:AtRest()
	if self.stale then
		return false
	end
	for i = 0, Wire.BITS - 1 do
		if self.bits[i] then
			return false
		end
	end
	return true
end

-- Applies a frame of up to 32 bytes (missing bytes are zero) and persists it. Returns toggle
-- ms, save ms, flipped bits and how many flipped bits the client did not take.
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
	for index = 1, Wire.BITS / 8 do
		local value, base = byte(frame, index) or 0, (index - 1) * 8
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
