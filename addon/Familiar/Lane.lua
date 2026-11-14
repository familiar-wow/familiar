-- Up, addon to app: the AddOns.txt lane (ADR 0005). 256 empty helper addons carry one bit each
-- as their enabled state; C_AddOns.SaveAddOns writes them into the character's AddOns.txt, where
-- the app reads them. Frame format: core/src/transport/codec.ts.
local _, ns = ...
local Codec, Tasks = ns.Codec, ns.Tasks

local byte, char, format, rep, sub = string.byte, string.char, string.format, string.rep, string.sub
local ceil, floor = math.ceil, math.floor

local Lane = { HELPERS = 256 }
ns.Lane = Lane

local CHUNK = 29 -- message bytes per frame, between the head byte and the CRC-16
local GAP = 0.033 -- seconds between saves; at this pace the client lost no frame in FAM-15
local REST = rep("\0", 32)
local POW2 = { [0] = 1, 2, 4, 8, 16, 32, 64, 128 }

local indices -- helper number -> addon index, once all helpers are known
local bits, stale = {}, true
local lastSave, lastFrame, listWasOpen = -1, -1, false

function Lane.HelperName(i)
	return format("Familiar_L%03d", i)
end

-- Looks the helpers up. Returns how many are missing; the lane works only with all of them.
function Lane.Resolve()
	local wanted, found, count = {}, {}, 0
	for i = 0, Lane.HELPERS - 1 do
		wanted[Lane.HelperName(i)] = i
	end
	for index = 1, C_AddOns.GetNumAddOns() do
		local i = wanted[(C_AddOns.GetAddOnInfo(index))]
		if i then
			found[i], count = index, count + 1
		end
	end
	indices, stale = count == Lane.HELPERS and found or nil, true
	return Lane.HELPERS - count
end

function Lane.Ready()
	return indices ~= nil
end

local function listOpen()
	local list = _G.AddonList
	return list ~= nil and list:IsShown()
end

-- Called every frame: once the player closes the addon list, the helpers may have changed.
function Lane.Watch()
	local open = listOpen()
	if listWasOpen and not open then
		stale = true
	end
	listWasOpen = open
end

-- The client keeps one enabled state per process but writes rows per character, so the state it
-- reports cannot be trusted (FAM-15). After anything that may have changed the helpers, every
-- helper is switched off first; from then on each bit that is on has a row of its own.
local function apply(frame, character)
	local enable, disable = C_AddOns.EnableAddOn, C_AddOns.DisableAddOn
	if stale then
		for i = 0, Lane.HELPERS - 1 do
			disable(indices[i], character)
			bits[i] = false
		end
		stale = false
	end
	for b = 1, #REST do
		local value, base = byte(frame, b), (b - 1) * 8
		for offset = 0, 7 do
			local i, on = base + offset, floor(value / POW2[offset]) % 2 == 1
			if bits[i] ~= on then
				if on then
					enable(indices[i], character)
				else
					disable(indices[i], character)
				end
				bits[i] = on
			end
		end
	end
	C_AddOns.SaveAddOns()
end

-- At most one save per rendered frame and GAP apart: a second save in the same frame would
-- overwrite the first before the app could read it. Never while the addon list is open.
local function save(frame, character)
	while listOpen() or Tasks.frame == lastFrame or Tasks.Now() - lastSave < GAP do
		Tasks.Sleep(listOpen() and 0.25 or 0)
	end
	apply(frame, character)
	lastSave, lastFrame = Tasks.Now(), Tasks.frame
end

-- Sends a message (task context), then switches every helper off. That rest state also keeps the
-- addon list's OK button from turning into Reload UI.
function Lane.Send(bytes)
	local character = UnitGUID("player")
	for k = 0, ceil(#bytes / CHUNK) - 1 do
		local head = char((k == 0 and 128 or 0) + k % 128) .. sub(bytes, k * CHUNK + 1, (k + 1) * CHUNK)
		head = head .. rep("\0", CHUNK + 1 - #head)
		local crc = Codec.Crc16(head)
		save(head .. char(crc % 256, floor(crc / 256)), character)
	end
	save(REST, character)
end
