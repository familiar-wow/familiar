-- Byte helpers and checksums, the same as in core/src/transport/codec.ts.
local _, ns = ...

local band, bxor, lshift, rshift = bit.band, bit.bxor, bit.lshift, bit.rshift
local byte, char, floor = string.byte, string.char, math.floor

local Codec = {}
ns.Codec = Codec

local CRC32 = {}
for i = 0, 255 do
	local c = i
	for _ = 1, 8 do
		if band(c, 1) == 1 then
			c = bxor(rshift(c, 1), 0xEDB88320)
		else
			c = rshift(c, 1)
		end
	end
	CRC32[i] = c
end

-- CRC-32 (IEEE) of s from byte `first` to `last`, as an unsigned number.
function Codec.Crc32(s, first, last)
	local crc = -1
	for i = first or 1, last or #s do
		crc = bxor(rshift(crc, 8), CRC32[band(bxor(crc, byte(s, i)), 0xFF)])
	end
	crc = bxor(crc, -1)
	return crc < 0 and crc + 4294967296 or crc
end

-- CRC-16/CCITT-FALSE of s.
function Codec.Crc16(s)
	local crc = 0xFFFF
	for i = 1, #s do
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

-- Little-endian numbers.
function Codec.U16(n)
	return char(n % 256, floor(n / 256) % 256)
end

function Codec.U32(n)
	return char(n % 256, floor(n / 256) % 256, floor(n / 65536) % 256, floor(n / 16777216) % 256)
end

function Codec.ReadU16(s, i)
	local a, b = byte(s, i, i + 1)
	return a + b * 256
end

function Codec.ReadU32(s, i)
	local a, b, c, d = byte(s, i, i + 3)
	return a + b * 256 + c * 65536 + d * 16777216
end
