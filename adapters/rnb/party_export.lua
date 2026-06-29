-- mGBA Pokemon party exporter for Emerald-based ROM hacks such as Run & Bun.
--
-- Reads the 6-slot PARTY and the PC boxes. The gen3 Pokemon data structure (encrypted +
-- shuffled substructures, checksum-based plain/encrypted detection) is identical to
-- FireRed, so that logic is copied verbatim from the radical-red adapter; only how we
-- LOCATE the party / PC storage differs (Emerald addresses, discovered by scanning).
--
-- Run & Bun is built on the pokeemerald decomp/expansion, so gPlayerParty is NOT at the
-- vanilla Emerald address. Instead of hardcoding, this script SCANS EWRAM on load for
-- the first run of checksum-valid gen3 mons (= the player party) and uses that base
-- directly. The discovered address is printed so it can be hardcoded later for speed.
--
-- Not yet ported from radical-red: the remote-edit (cheat) channel and timed save-state
-- auto-saving.

local EXPORT_HOST = "127.0.0.1"
local EXPORT_PORT = 8765
local EXPORT_INTERVAL_FRAMES = 60

-- Remote edit (cheat) channel: when true, the script reads EDIT command lines sent back
-- over the same TCP connection and writes Pokemon data into emulator memory. Set to false
-- to make the bridge strictly read-only.
local ENABLE_REMOTE_EDIT = true

local PARTY_MON_SIZE = 100
local MON_NAME_LENGTH = 10
local PLAYER_NAME_LENGTH = 7
local TEXT_TERMINATOR = 0xFF

-- EWRAM scan window. We stop short of the end so reading a full 100-byte mon never runs
-- past 0x02040000.
local SCAN_START = 0x02000000
local SCAN_LIMIT = 0x02040000 - 0x100
local SCAN_CHUNK = 0x4000 -- bytes scanned per frame, so the scan never freezes mGBA

-- Party location. Discovered by EWRAM scan on Run & Bun 1.07: gPlayerParty is at the
-- address below. We validate it on load and only fall back to a full scan if it ever
-- fails (different ROM version or save). gPlayerParty is a fixed BSS global, so it does
-- NOT move during play — unlike the DMA-shuffled save block, whose party copy showed up
-- as a separate, stale candidate during discovery.
local KNOWN_PARTY_ADDRESS = 0x02023A98
local partyAddress = nil
local partyAddressConfirmed = false

-- PC storage (discovered on Run & Bun 1.07). gPokemonStorage is a fixed EWRAM global, so
-- this base is constant (the DMA-shuffled copy lives in the save block and is ignored).
-- Layout is standard Emerald: u8 currentBox at base+0, then boxes[PC_BOX_COUNT][PC_BOX_SIZE]
-- of 80-byte box mons at base+4. IWRAM pointers at 0x03005DA4 / 0x03002A24 also hold it.
-- PC_BOX_COUNT is the vanilla Emerald default; raise it if Run & Bun has more boxes (extra
-- slots just read empty/invalid memory, which per-slot validation filters out).
local KNOWN_STORAGE_BASE = 0x02028848
local PC_BOX_COUNT = 14
local PC_BOX_SIZE = 30
local PC_BOX_MON_SIZE = 80

local exporterSocket = nil
local frameCounter = 0
local lastPayload = nil
local lastConnectAttemptFrame = -300

-- Scan state (chunked across frames).
local scanCursor = SCAN_START
local scanning = false
local scanResults = {}
local scanReported = false
local lastScanRestart = 0

-- PC-storage discovery (diagnostic). The storage base is now known and hardcoded above,
-- so this stays off. Flip to true to re-discover gPokemonStorage on a different build or
-- save (it scans EWRAM for boxed mons and reverse-finds the IWRAM pointer).
local PC_DISCOVERY = false
local pcScanCursor = SCAN_START
local pcScanning = false
local pcReported = false
local pcMons = {}

-- Western charmap. Run & Bun is Chinese-patched, so nicknames/OT names may decode to
-- "?" — that is expected and harmless; verification relies on numeric species/level/HP.
local CHARMAP = { [0]=
	" ", "A", "A", "A", "C", "E", "E", "E", "E", "I", " ", "I", "I", "O", "O", "O",
	"OE", "U", "U", "U", "N", "ss", "a", "a", " ", "c", "e", "e", "e", "e", "i", " ",
	"i", "i", "o", "o", "o", "oe", "u", "u", "u", "n", "o", "a", " ", "&", "+", " ",
	" ", " ", " ", " ", "v", "=", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ",
	" ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ",
	" ", "?", "!", "P", "M", "P", "Ke", " ", " ", " ", "I", "%", "(", ")", " ", " ",
	" ", " ", " ", " ", " ", " ", " ", " ", "a", " ", " ", " ", " ", " ", " ", "i",
	" ", " ", " ", " ", " ", " ", " ", " ", " ", "up", "down", "left", "right", " ", " ", " ",
	" ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ", " ",
	" ", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "!", "?", ".", "-", ".",
	"...", "\"", "\"", "'", "'", "M", "F", "$", ",", "x", "/", "A", "B", "C", "D", "E",
	"F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U",
	"V", "W", "X", "Y", "Z", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k",
	"l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z", ">",
	":", "A", "O", "U", "a", "o", "u", "up", "down", "left", " ", " ", " ", " ", " ", ""
}

local function jsonEscape(value)
	value = tostring(value or "")
	value = value:gsub("\\", "\\\\")
	value = value:gsub('"', '\\"')
	value = value:gsub("\b", "\\b")
	value = value:gsub("\f", "\\f")
	value = value:gsub("\n", "\\n")
	value = value:gsub("\r", "\\r")
	value = value:gsub("\t", "\\t")
	value = value:gsub("[%z\1-\31]", function(char)
		return string.format("\\u%04x", char:byte())
	end)
	return value
end

local function readPokemonString(address, length)
	local result = ""
	for offset = 0, length - 1 do
		local byte = emu:read8(address + offset)
		if byte == TEXT_TERMINATOR then
			break
		end
		result = result .. (CHARMAP[byte] or "?")
	end
	return result:gsub("%s+$", "")
end

-- Maps personality % 24 to the physical order of the four 12-byte substructures
-- (logical order is always growth, attacks, evs/condition, misc). Standard gen3.
local SUBSTRUCTURE_ORDER = {
	[0] = {0, 1, 2, 3}, {0, 1, 3, 2}, {0, 2, 1, 3}, {0, 3, 1, 2},
	{0, 2, 3, 1}, {0, 3, 2, 1}, {1, 0, 2, 3}, {1, 0, 3, 2},
	{2, 0, 1, 3}, {3, 0, 1, 2}, {2, 0, 3, 1}, {3, 0, 2, 1},
	{1, 2, 0, 3}, {1, 3, 0, 2}, {2, 1, 0, 3}, {3, 1, 0, 2},
	{2, 3, 0, 1}, {3, 2, 0, 1}, {1, 2, 3, 0}, {1, 3, 2, 0},
	{2, 1, 3, 0}, {3, 1, 2, 0}, {2, 3, 1, 0}, {3, 2, 1, 0}
}

local function readDecryptedSubstructures(address)
	local personality = emu:read32(address)
	local otId = emu:read32(address + 4)
	local key = personality ~ otId
	local order = SUBSTRUCTURE_ORDER[personality % 24]
	local substructures = {}
	for logicalIndex = 1, 4 do
		local physicalIndex = order[logicalIndex]
		substructures[logicalIndex] = {}
		for word = 0, 2 do
			substructures[logicalIndex][word + 1] = emu:read32(address + 32 + physicalIndex * 12 + word * 4) ~ key
		end
	end
	return personality, otId, substructures
end

local function readPlainSubstructures(address)
	local substructures = {}
	for logicalIndex = 1, 4 do
		substructures[logicalIndex] = {}
		for word = 0, 2 do
			substructures[logicalIndex][word + 1] = emu:read32(address + 32 + (logicalIndex - 1) * 12 + word * 4)
		end
	end
	return substructures
end

local function calculateBoxChecksum(address, key)
	local checksum = 0
	for word = 0, 11 do
		local decrypted = emu:read32(address + 32 + word * 4) ~ key
		checksum = checksum + (decrypted & 0xFFFF) + (decrypted >> 16)
	end
	return checksum & 0xFFFF
end

-- Cheap validity probe used by the scanner AND by per-slot party reading: a real gen3
-- mon has a nonzero personality and a stored checksum that matches the decrypted data.
-- Returns species, level on success (level only meaningful for party mons), else nil.
local function partyMonLooksValid(address)
	local personality = emu:read32(address)
	if personality == 0 or personality == 0xFFFFFFFF then
		return nil
	end
	local otId = emu:read32(address + 4)
	local key = personality ~ otId
	if emu:read16(address + 28) ~= calculateBoxChecksum(address, key) then
		return nil
	end
	local growthPhysical = SUBSTRUCTURE_ORDER[personality % 24][1]
	local species = (emu:read32(address + 32 + growthPhysical * 12) ~ key) & 0xFFFF
	if species == 0 or species >= 2000 then
		return nil
	end
	return species, emu:read8(address + 84)
end

-- Reads the 80-byte "box" portion shared by party and PC mons. Vanilla Emerald keeps
-- these encrypted + shuffled; the checksum mismatch path also tolerates a plain layout.
local function readBoxMon(address)
	local personality, otId, substructures = readDecryptedSubstructures(address)
	local key = personality ~ otId
	local storedChecksum = emu:read16(address + 28)
	local calculatedChecksum = calculateBoxChecksum(address, key)
	local dataFormat = "encryptedShuffled"
	if storedChecksum ~= calculatedChecksum then
		substructures = readPlainSubstructures(address)
		dataFormat = "plainFixed"
	end
	local growth = substructures[1]
	local attacks = substructures[2]
	local evs = substructures[3]
	local misc = substructures[4]
	local originFlags = misc[1] >> 16
	local ivFlags = misc[2]
	local pokerus = misc[1] & 0xFF
	local originByte0 = misc[1] & 0xFF
	local originByte1 = (misc[1] >> 8) & 0xFF
	local originByte2 = (misc[1] >> 16) & 0xFF
	local originByte3 = (misc[1] >> 24) & 0xFF
	local metLocation = (misc[1] >> 8) & 0xFF
	local metLevel = originFlags & 0x7F
	local metGame = (originFlags >> 7) & 0xF
	local pokeball = (originFlags >> 11) & 0xF
	local otGender = (originFlags >> 15) & 0x1

	if dataFormat == "plainFixed" then
		metLocation = originByte1
		metLevel = originByte2
		metGame = originByte3
		pokeball = 0
		otGender = 0
	end

	return {
		personality = personality,
		natureId = personality % 25,
		otId = otId,
		boxChecksum = storedChecksum,
		calculatedChecksum = calculatedChecksum,
		checksumValid = storedChecksum == calculatedChecksum,
		dataFormat = dataFormat,
		nickname = readPokemonString(address + 8, MON_NAME_LENGTH),
		otName = readPokemonString(address + 20, PLAYER_NAME_LENGTH),
		species = growth[1] & 0xFFFF,
		heldItem = growth[1] >> 16,
		experience = growth[2],
		friendship = (growth[3] >> 8) & 0xFF,
		moves = {
			attacks[1] & 0xFFFF,
			attacks[1] >> 16,
			attacks[2] & 0xFFFF,
			attacks[2] >> 16
		},
		pp = {
			attacks[3] & 0xFF,
			(attacks[3] >> 8) & 0xFF,
			(attacks[3] >> 16) & 0xFF,
			attacks[3] >> 24
		},
		pokerus = pokerus,
		metLocation = metLocation,
		metMapsec = metLocation,
		metLevel = metLevel,
		metGame = metGame,
		originBytes = {
			byte0 = originByte0,
			byte1 = originByte1,
			byte2 = originByte2,
			byte3 = originByte3
		},
		pokeball = pokeball,
		otGender = otGender,
		evs = {
			hp = evs[1] & 0xFF,
			attack = (evs[1] >> 8) & 0xFF,
			defense = (evs[1] >> 16) & 0xFF,
			speed = evs[1] >> 24,
			spAttack = evs[2] & 0xFF,
			spDefense = (evs[2] >> 8) & 0xFF
		},
		ivs = {
			hp = ivFlags & 0x1F,
			attack = (ivFlags >> 5) & 0x1F,
			defense = (ivFlags >> 10) & 0x1F,
			speed = (ivFlags >> 15) & 0x1F,
			spAttack = (ivFlags >> 20) & 0x1F,
			spDefense = (ivFlags >> 25) & 0x1F
		},
		isEgg = (ivFlags >> 30) & 1,
		hiddenAbility = (ivFlags >> 31) & 1,
		abilityNum = personality & 1
	}
end

-- The party-only stat block (status/level/HP/stats) lives at a fixed offset after the
-- 80-byte box portion; these offsets are identical across all gen3 games.
local function readPartyMon(address)
	local mon = readBoxMon(address)
	mon.status = emu:read32(address + 80)
	mon.level = emu:read8(address + 84)
	mon.hp = emu:read16(address + 86)
	mon.maxHP = emu:read16(address + 88)
	mon.stats = {
		attack = emu:read16(address + 90),
		defense = emu:read16(address + 92),
		speed = emu:read16(address + 94),
		spAttack = emu:read16(address + 96),
		spDefense = emu:read16(address + 98)
	}
	return mon
end

-- Reads up to 6 contiguous party slots from the discovered base, stopping at the first
-- slot that does not look like a valid mon (this replaces reading gPlayerPartyCount,
-- whose address we have not located in this build).
local function readParty()
	if not partyAddressConfirmed then
		return {}
	end
	local party = {}
	for slot = 1, 6 do
		local address = partyAddress + (slot - 1) * PARTY_MON_SIZE
		if not partyMonLooksValid(address) then
			break
		end
		local mon = readPartyMon(address)
		mon.slot = slot
		party[slot] = mon
	end
	return party
end

local function arrayToJson(values)
	local parts = {}
	for index, value in ipairs(values) do
		parts[index] = tostring(value)
	end
	return "[" .. table.concat(parts, ",") .. "]"
end

local function statMapToJson(values)
	return string.format('{"hp":%d,"attack":%d,"defense":%d,"speed":%d,"spAttack":%d,"spDefense":%d}',
		values.hp, values.attack, values.defense, values.speed, values.spAttack, values.spDefense)
end

local function battleStatsToJson(values)
	return string.format('{"attack":%d,"defense":%d,"speed":%d,"spAttack":%d,"spDefense":%d}',
		values.attack, values.defense, values.speed, values.spAttack, values.spDefense)
end

local function originBytesToJson(originBytes)
	return string.format('{"byte0":%d,"byte1":%d,"byte2":%d,"byte3":%d}',
		originBytes.byte0, originBytes.byte1, originBytes.byte2, originBytes.byte3)
end

local function monToJson(mon)
	return string.format('{"slot":%d,"species":%d,"nickname":"%s","otName":"%s","level":%d,"hp":%d,"maxHP":%d,"status":%d,"heldItem":%d,"experience":%d,"friendship":%d,"moves":%s,"pp":%s,"pokerus":%d,"metLocation":%d,"metMapsec":%d,"metLevel":%d,"metGame":%d,"originBytes":%s,"pokeball":%d,"otGender":%d,"ivs":%s,"evs":%s,"stats":%s,"isEgg":%d,"hiddenAbility":%d,"abilityNum":%d,"personality":%d,"natureId":%d,"otId":%d,"boxChecksum":%d,"calculatedChecksum":%d,"checksumValid":%s,"dataFormat":"%s"}',
		mon.slot,
		mon.species,
		jsonEscape(mon.nickname),
		jsonEscape(mon.otName),
		mon.level,
		mon.hp,
		mon.maxHP,
		mon.status,
		mon.heldItem,
		mon.experience,
		mon.friendship,
		arrayToJson(mon.moves),
		arrayToJson(mon.pp),
		mon.pokerus,
		mon.metLocation,
		mon.metMapsec,
		mon.metLevel,
		mon.metGame,
		originBytesToJson(mon.originBytes),
		mon.pokeball,
		mon.otGender,
		statMapToJson(mon.ivs),
		statMapToJson(mon.evs),
		battleStatsToJson(mon.stats),
		mon.isEgg,
		mon.hiddenAbility,
		mon.abilityNum,
		mon.personality,
		mon.natureId,
		mon.otId,
		mon.boxChecksum,
		mon.calculatedChecksum,
		tostring(mon.checksumValid),
		jsonEscape(mon.dataFormat))
end

-- Read the PC boxes from the fixed gPokemonStorage. Each slot is a standard 80-byte box
-- mon (no party stat block); per-slot checksum validation skips empty/garbage slots, so
-- an over-estimated PC_BOX_COUNT is harmless.
local function readPcBoxes()
	if KNOWN_STORAGE_BASE < 0x02000000 or KNOWN_STORAGE_BASE >= 0x02040000 then
		return { storageBase = KNOWN_STORAGE_BASE, currentBox = 0, boxes = {} }
	end
	local boxesStart = KNOWN_STORAGE_BASE + 4
	local boxes = {}
	for boxIndex = 0, PC_BOX_COUNT - 1 do
		local box = { index = boxIndex + 1, pokemon = {} }
		for position = 0, PC_BOX_SIZE - 1 do
			local address = boxesStart + (boxIndex * PC_BOX_SIZE + position) * PC_BOX_MON_SIZE
			if partyMonLooksValid(address) then
				local mon = readBoxMon(address)
				mon.box = boxIndex + 1
				mon.position = position + 1
				box.pokemon[#box.pokemon + 1] = mon
			end
		end
		boxes[#boxes + 1] = box
	end
	return { storageBase = KNOWN_STORAGE_BASE, currentBox = emu:read8(KNOWN_STORAGE_BASE), boxes = boxes }
end

local function pcMonToJson(mon)
	return string.format('{"box":%d,"position":%d,"species":%d,"nickname":"%s","otName":"%s","heldItem":%d,"experience":%d,"friendship":%d,"moves":%s,"pp":%s,"pokerus":%d,"metLocation":%d,"metMapsec":%d,"metLevel":%d,"metGame":%d,"originBytes":%s,"pokeball":%d,"otGender":%d,"ivs":%s,"evs":%s,"isEgg":%d,"hiddenAbility":%d,"abilityNum":%d,"personality":%d,"natureId":%d,"otId":%d,"boxChecksum":%d,"calculatedChecksum":%d,"checksumValid":%s,"dataFormat":"%s"}',
		mon.box,
		mon.position,
		mon.species,
		jsonEscape(mon.nickname),
		jsonEscape(mon.otName),
		mon.heldItem,
		mon.experience,
		mon.friendship,
		arrayToJson(mon.moves),
		arrayToJson(mon.pp),
		mon.pokerus,
		mon.metLocation,
		mon.metMapsec,
		mon.metLevel,
		mon.metGame,
		originBytesToJson(mon.originBytes),
		mon.pokeball,
		mon.otGender,
		statMapToJson(mon.ivs),
		statMapToJson(mon.evs),
		mon.isEgg,
		mon.hiddenAbility,
		mon.abilityNum,
		mon.personality,
		mon.natureId,
		mon.otId,
		mon.boxChecksum,
		mon.calculatedChecksum,
		tostring(mon.checksumValid),
		jsonEscape(mon.dataFormat))
end

local function pcBoxesToJson(pc)
	local boxes = {}
	for boxIndex, box in ipairs(pc.boxes) do
		local mons = {}
		for monIndex, mon in ipairs(box.pokemon) do
			mons[monIndex] = pcMonToJson(mon)
		end
		boxes[boxIndex] = string.format('{"index":%d,"pokemon":[%s]}', box.index, table.concat(mons, ","))
	end
	return string.format('{"storageBase":%d,"currentBox":%d,"boxes":[%s]}',
		pc.storageBase, pc.currentBox or 0, table.concat(boxes, ","))
end

local function statusToJson(party, pc)
	local mons = {}
	for index, mon in ipairs(party) do
		mons[index] = monToJson(mon)
	end
	-- romHack tags the payload so the server routes it to the rnb adapter deterministically,
	-- regardless of the GBA game code.
	return string.format('{"source":"mgba","romHack":"rnb","gameCode":"%s","frame":%d,"partyCount":%d,"party":[%s],"pc":%s}',
		jsonEscape(emu:getGameCode() or ""),
		frameCounter,
		#party,
		table.concat(mons, ","),
		pcBoxesToJson(pc))
end

-- Verification helper: one human-readable line per export so you can eyeball whether the
-- discovered party base is right without standing up the server or the data layer.
local function logPartySummary(party)
	local parts = {}
	for index, mon in ipairs(party) do
		parts[index] = string.format("#%d sp=%d Lv%d %d/%d", mon.slot, mon.species, mon.level, mon.hp, mon.maxHP)
	end
	console:log("[rnb] party " .. #party .. ": " .. table.concat(parts, " | "))
end

-- ── EWRAM party scan ───────────────────────────────────────────────────────────
-- Walk EWRAM in per-frame chunks looking for run-starts: a checksum-valid mon whose
-- preceding 100-byte slot is NOT valid. The first such run is the player party
-- (gPlayerParty sits at a lower address than gEnemyParty / the daycare).

local function finishScan()
	if scanReported then
		return
	end
	scanReported = true
	if #scanResults == 0 then
		console:error("[rnb] scan found no party yet. Load a save that has mons in your party, then it will retry.")
		return
	end
	for index, result in ipairs(scanResults) do
		console:log(string.format("[rnb] candidate %d: base=0x%08X count=%d [%s]",
			index, result.base, result.count, result.summary))
	end
	partyAddress = scanResults[1].base
	partyAddressConfirmed = true
	console:log(string.format("[rnb] using party base 0x%08X (gPlayerPartyCount likely a few bytes before it). Live export active.",
		partyAddress))
end

local function stepScan()
	local processed = 0
	while scanCursor < SCAN_LIMIT and processed < SCAN_CHUNK do
		if partyMonLooksValid(scanCursor) then
			local previousValid = scanCursor - PARTY_MON_SIZE >= SCAN_START
				and partyMonLooksValid(scanCursor - PARTY_MON_SIZE) ~= nil
			if not previousValid then
				local slots = {}
				while #slots < 6 do
					local species, level = partyMonLooksValid(scanCursor + #slots * PARTY_MON_SIZE)
					if not species then
						break
					end
					slots[#slots + 1] = string.format("sp=%d Lv%d", species, level)
				end
				scanResults[#scanResults + 1] = {
					base = scanCursor,
					count = #slots,
					summary = table.concat(slots, ", ")
				}
			end
		end
		scanCursor = scanCursor + 4
		processed = processed + 4
	end
	if scanCursor >= SCAN_LIMIT then
		scanning = false
		finishScan()
	end
end

local function restartScan()
	scanCursor = SCAN_START
	scanning = true
	scanResults = {}
	scanReported = false
	lastScanRestart = frameCounter
end

-- Prefer the known gPlayerParty address (instant, no scan). Only scan if it does not
-- validate — e.g. a different ROM version, or the save is not loaded yet.
local function beginLocate()
	if partyMonLooksValid(KNOWN_PARTY_ADDRESS) then
		partyAddress = KNOWN_PARTY_ADDRESS
		partyAddressConfirmed = true
		scanning = false
		console:log(string.format("[rnb] using known party base 0x%08X (validated). gameCode=%s. Live export active.",
			partyAddress, tostring(emu:getGameCode() or "?")))
	else
		console:log("[rnb] known party base did not validate (different build, or no save loaded yet); scanning EWRAM...")
		restartScan()
	end
end

-- ── PC-storage discovery ───────────────────────────────────────────────────────

-- True for any address inside the player party or the enemy party that sits right after
-- it (6 + 6 slots of 100 bytes), so the PC scan ignores the mons we already account for.
local function pcInPartyRegion(address)
	if not partyAddress then
		return false
	end
	return address >= partyAddress and address < partyAddress + 12 * PARTY_MON_SIZE
end

-- Reverse-find gPokemonStorage: any IWRAM word that points into EWRAM such that the
-- given boxed mon sits at base + 4 + slot * 80 (the Emerald PokemonStorage layout:
-- u8 currentBox, then a flat array of 80-byte box mons). Returns {ptrAddr, base, slot}.
local function findStoragePointer(monAddress)
	local matches = {}
	local pointer = 0x03000000
	while pointer < 0x03008000 do
		local base = emu:read32(pointer)
		if base >= 0x02000000 and base < 0x02040000 then
			local delta = monAddress - 4 - base
			if delta >= 0 and delta % 80 == 0 then
				local slot = delta // 80
				if slot < 1200 then
					matches[#matches + 1] = { ptrAddr = pointer, base = base, slot = slot }
				end
			end
		end
		pointer = pointer + 4
	end
	return matches
end

local function finishPcScan()
	if pcReported then
		return
	end
	pcReported = true
	if #pcMons == 0 then
		console:log("[rnb][pc] no boxed mons found outside the party. Put a known mon in a box and reset to retry.")
		return
	end
	for _, mon in ipairs(pcMons) do
		console:log(string.format("[rnb][pc] box mon @0x%08X sp=%d", mon.addr, mon.species))
	end
	-- Resolve the storage base via the IWRAM pointer for each boxed mon. The live storage
	-- is the copy an IWRAM pointer actually references (save-block copies are not pointed to).
	for _, mon in ipairs(pcMons) do
		for _, match in ipairs(findStoragePointer(mon.addr)) do
			console:log(string.format("[rnb][pc]   sp=%d @0x%08X => base 0x%08X, box %d pos %d (slot %d) via ptr@0x%08X",
				mon.species, mon.addr, match.base, match.slot // 30 + 1, match.slot % 30 + 1, match.slot, match.ptrAddr))
		end
	end
end

local function stepPcScan()
	local processed = 0
	while pcScanCursor < SCAN_LIMIT and processed < SCAN_CHUNK do
		if not pcInPartyRegion(pcScanCursor) then
			local species = partyMonLooksValid(pcScanCursor)
			if species then
				pcMons[#pcMons + 1] = { addr = pcScanCursor, species = species }
			end
		end
		pcScanCursor = pcScanCursor + 4
		processed = processed + 4
	end
	if pcScanCursor >= SCAN_LIMIT then
		pcScanning = false
		finishPcScan()
	end
end

-- ── remote edit (cheat) channel ───────────────────────────────────────────────
-- The bridge pushes pipe-delimited EDIT command lines back over the same socket; we
-- locate the mon by (personality, otId) and write the requested fields into memory. All
-- numeric heavy lifting (level→exp, stat recompute, nature/ability→personality) happens
-- on the Node side. We avoid JSON in Lua — every value is a plain integer or short string.

local commandBuffer = ""
local commandPollErrorShown = false

local function splitString(value, sep)
	local parts = {}
	for token in value:gmatch("([^" .. sep .. "]+)") do
		parts[#parts + 1] = token
	end
	return parts
end

local function parseCommandFields(line)
	local parts = splitString(line, "|")
	local fields = { verb = parts[1] }
	for index = 2, #parts do
		local token = parts[index]
		local eq = token:find("=", 1, true)
		if eq then
			fields[token:sub(1, eq - 1)] = token:sub(eq + 1)
		end
	end
	return fields
end

local function fieldNumber(fields, name)
	local raw = fields[name]
	if raw == nil then return nil end
	return tonumber(raw)
end

-- Locate a mon by its (personality, otId) pair (together effectively unique). Both the
-- party (stride 100) and PC (stride 80 from a 4-aligned base) are 4-byte aligned in
-- Emerald, so aligned reads suffice. Returns address and "party"/"pc", or nil.
local function findMonAddress(personality, otId)
	if partyAddressConfirmed then
		for slot = 0, 5 do
			local address = partyAddress + slot * PARTY_MON_SIZE
			if emu:read32(address) == personality and emu:read32(address + 4) == otId then
				return address, "party"
			end
		end
	end
	if KNOWN_STORAGE_BASE >= 0x02000000 and KNOWN_STORAGE_BASE < 0x02040000 then
		local boxesStart = KNOWN_STORAGE_BASE + 4
		for slot = 0, PC_BOX_COUNT * PC_BOX_SIZE - 1 do
			local address = boxesStart + slot * PC_BOX_MON_SIZE
			if emu:read32(address) == personality and emu:read32(address + 4) == otId then
				return address, "pc"
			end
		end
	end
	return nil
end

-- Apply a patch to the 80-byte box portion that party and PC mons share in Emerald
-- (encrypted + shuffled, checksum-validated; the plain branch is a safety net). We read
-- AND write back in the SAME format — writing the wrong format corrupts untouched fields.
-- Only requested fields change; the checksum is recomputed. The party-only stat block at
-- +80.. is written only when those fields are present (the bridge sends them for party
-- mons only), so the same function is safe for boxed mons.
local function applyEdit(address, fields)
	local curPersonality = emu:read32(address)
	local otId = emu:read32(address + 4)
	local key = curPersonality ~ otId
	local order = SUBSTRUCTURE_ORDER[curPersonality % 24]

	local storedChecksum = emu:read16(address + 28)
	local calculatedChecksum = calculateBoxChecksum(address, key)
	local encrypted = storedChecksum == calculatedChecksum

	local words = {}
	for li = 1, 4 do
		local pi = encrypted and order[li] or (li - 1)
		words[li] = {}
		for w = 0, 2 do
			local raw = emu:read32(address + 32 + pi * 12 + w * 4)
			words[li][w + 1] = encrypted and (raw ~ key) or raw
		end
	end
	local growth, attacks, evs, misc = words[1], words[2], words[3], words[4]

	local experience = fieldNumber(fields, "experience")
	if experience then growth[2] = experience & 0xFFFFFFFF end

	local heldItem = fieldNumber(fields, "heldItem")
	if heldItem then growth[1] = (growth[1] & 0xFFFF) | ((heldItem & 0xFFFF) << 16) end

	local friendship = fieldNumber(fields, "friendship")
	if friendship then growth[3] = (growth[3] & 0xFFFF00FF) | ((friendship & 0xFF) << 8) end

	if fields.evHp then
		evs[1] = (fieldNumber(fields, "evHp") & 0xFF)
			| ((fieldNumber(fields, "evAtk") & 0xFF) << 8)
			| ((fieldNumber(fields, "evDef") & 0xFF) << 16)
			| ((fieldNumber(fields, "evSpd") & 0xFF) << 24)
		evs[2] = (evs[2] & 0xFFFF0000)
			| (fieldNumber(fields, "evSpAtk") & 0xFF)
			| ((fieldNumber(fields, "evSpDef") & 0xFF) << 8)
	end

	-- IVs occupy bits 0-29 of misc word 1. The top two bits differ from RR here: in Run & Bun
	-- (pokeemerald-expansion) writing bit 31 turns the mon into an EGG (it is the isEgg flag,
	-- not the hidden-ability bit CFRU uses). So we PRESERVE both top bits (0xC0000000) exactly
	-- and rewrite only the IV bits. Ability editing is intentionally not applied via this word;
	-- nature edits still work through set_personality below.
	if fields.ivHp then
		local ivBits = (fieldNumber(fields, "ivHp") & 0x1F)
			| ((fieldNumber(fields, "ivAtk") & 0x1F) << 5)
			| ((fieldNumber(fields, "ivDef") & 0x1F) << 10)
			| ((fieldNumber(fields, "ivSpd") & 0x1F) << 15)
			| ((fieldNumber(fields, "ivSpAtk") & 0x1F) << 20)
			| ((fieldNumber(fields, "ivSpDef") & 0x1F) << 25)
		misc[2] = (misc[2] & 0xC0000000) | (ivBits & 0x3FFFFFFF)
	end

	local newPersonality = fieldNumber(fields, "set_personality") or curPersonality
	if newPersonality ~= curPersonality then
		emu:write32(address, newPersonality & 0xFFFFFFFF)
	end

	-- The checksum is the sum of the logical/decrypted words' 16-bit halves regardless of
	-- storage format, so it is computed the same way here.
	local checksum = 0
	for li = 1, 4 do
		for w = 1, 3 do
			local d = words[li][w]
			checksum = checksum + (d & 0xFFFF) + ((d >> 16) & 0xFFFF)
		end
	end
	emu:write16(address + 28, checksum & 0xFFFF)

	if encrypted then
		local newKey = newPersonality ~ otId
		local newOrder = SUBSTRUCTURE_ORDER[newPersonality % 24]
		for li = 1, 4 do
			local pi = newOrder[li]
			for w = 0, 2 do
				emu:write32(address + 32 + pi * 12 + w * 4, (words[li][w + 1] ~ newKey) & 0xFFFFFFFF)
			end
		end
	else
		for li = 1, 4 do
			for w = 0, 2 do
				emu:write32(address + 32 + (li - 1) * 12 + w * 4, words[li][w + 1] & 0xFFFFFFFF)
			end
		end
	end

	-- Party-only battle-stat block (present only for party edits).
	local level = fieldNumber(fields, "level")
	if level then emu:write8(address + 84, level & 0xFF) end
	local maxHp = fieldNumber(fields, "maxHp")
	if maxHp then emu:write16(address + 88, maxHp & 0xFFFF) end
	local hp = fieldNumber(fields, "hp")
	if hp then emu:write16(address + 86, hp & 0xFFFF) end
	if fields.stAtk then
		emu:write16(address + 90, fieldNumber(fields, "stAtk") & 0xFFFF)
		emu:write16(address + 92, fieldNumber(fields, "stDef") & 0xFFFF)
		emu:write16(address + 94, fieldNumber(fields, "stSpd") & 0xFFFF)
		emu:write16(address + 96, fieldNumber(fields, "stSpAtk") & 0xFFFF)
		emu:write16(address + 98, fieldNumber(fields, "stSpDef") & 0xFFFF)
	end
end

local function sendAck(id, ok, message)
	if not exporterSocket then return end
	local line = string.format("ACK|id=%s|ok=%s|msg=%s\n",
		tostring(id or ""), ok and "1" or "0", jsonEscape(message or ""))
	exporterSocket:send(line)
end

local function handleCommand(line)
	local fields = parseCommandFields(line)
	if fields.verb ~= "EDIT" then return end
	local personality = fieldNumber(fields, "personality")
	local otId = fieldNumber(fields, "otId")
	if not personality or not otId then
		sendAck(fields.id, false, "missing personality/otId")
		return
	end
	-- Everything touching emulator memory runs inside this pcall so a bad address can never
	-- bubble up and kill the frame callback that drives the export.
	local kind
	local ok, err = pcall(function()
		local address, monKind = findMonAddress(personality, otId)
		if not address then error("mon not found", 0) end
		kind = monKind
		applyEdit(address, fields)
	end)
	if ok then
		console:log("[rnb] applied edit to " .. tostring(kind) .. " mon")
		sendAck(fields.id, true, kind)
	else
		console:error("[rnb] edit failed: " .. tostring(err))
		sendAck(fields.id, false, tostring(err))
	end
end

-- Read whatever has arrived and dispatch complete lines. Never closes the socket on a
-- read hiccup — real disconnects are handled by the "error" event and by send failures.
local function drainCommands()
	if not exporterSocket then return end
	while true do
		local data = exporterSocket:receive(4096)
		if data and #data > 0 then
			commandBuffer = commandBuffer .. data
		else
			break
		end
	end
	local idx = commandBuffer:find("\n", 1, true)
	while idx do
		local rawLine = commandBuffer:sub(1, idx - 1):gsub("\r$", "")
		commandBuffer = commandBuffer:sub(idx + 1)
		if #rawLine > 0 then handleCommand(rawLine) end
		idx = commandBuffer:find("\n", 1, true)
	end
end

local function pollCommands()
	if not exporterSocket then return end
	local ok, err = pcall(drainCommands)
	if not ok and not commandPollErrorShown then
		console:error("[rnb] command poll error (further errors suppressed): " .. tostring(err))
		commandPollErrorShown = true
	end
end

local function closeExporterSocket()
	if exporterSocket then
		exporterSocket:close()
		exporterSocket = nil
	end
end

local function ensureConnected()
	if exporterSocket then
		return true
	end
	if frameCounter - lastConnectAttemptFrame < 300 then
		return false
	end
	lastConnectAttemptFrame = frameCounter
	exporterSocket = socket.tcp()
	exporterSocket:add("error", function(err)
		console:error("Party Export socket error: " .. tostring(err))
		closeExporterSocket()
	end)
	if exporterSocket:connect(EXPORT_HOST, EXPORT_PORT) then
		console:log("Party Export connected to " .. EXPORT_HOST .. ":" .. EXPORT_PORT)
		if ENABLE_REMOTE_EDIT then
			exporterSocket:add("received", pollCommands)
		end
		return true
	end
	console:log("Party Export waiting for bridge on " .. EXPORT_HOST .. ":" .. EXPORT_PORT)
	closeExporterSocket()
	return false
end

local function sendPayload(payload)
	if not ensureConnected() then
		return
	end
	local ok, err = exporterSocket:send(payload .. "\n")
	if not ok and err ~= socket.ERRORS.AGAIN then
		console:error("Party Export send failed: " .. tostring(err))
		closeExporterSocket()
	end
end

local function exportParty()
	frameCounter = frameCounter + 1
	if ENABLE_REMOTE_EDIT then
		pollCommands()
	end

	if scanning then
		stepScan()
		return
	end

	-- Not found yet (e.g. script loaded before the save): retry periodically, re-trying
	-- the fast known-address path before falling back to a scan.
	if not partyAddressConfirmed then
		if frameCounter - lastScanRestart >= 300 then
			beginLocate()
		end
		return
	end

	-- One-time PC-storage discovery once the party is known (prints findings, then yields
	-- to normal export). Scaffolding for implementing PC reading on this build.
	if PC_DISCOVERY and not pcReported then
		if not pcScanning then
			pcScanCursor = SCAN_START
			pcScanning = true
			console:log("[rnb][pc] scanning EWRAM for boxed mons...")
		end
		stepPcScan()
		return
	end

	if frameCounter % EXPORT_INTERVAL_FRAMES ~= 0 then
		return
	end
	local party = readParty()
	local pc = readPcBoxes()
	local payload = statusToJson(party, pc)
	if payload ~= lastPayload then
		lastPayload = payload
		logPartySummary(party)
		local boxed = 0
		for _, box in ipairs(pc.boxes) do
			boxed = boxed + #box.pokemon
		end
		console:log(string.format("[rnb] pc: %d boxed mon(s) across %d boxes", boxed, #pc.boxes))
		sendPayload(payload)
	end
end

callbacks:add("frame", exportParty)
callbacks:add("stop", closeExporterSocket)
callbacks:add("crashed", closeExporterSocket)
callbacks:add("reset", function()
	lastPayload = nil
	partyAddress = nil
	partyAddressConfirmed = false
	pcReported = false
	pcScanning = false
	pcMons = {}
	commandBuffer = ""
	closeExporterSocket()
	beginLocate()
end)

console:log("[rnb] Party Export loaded (party + PC boxes).")
if ENABLE_REMOTE_EDIT then
	console:log("[rnb] remote edit channel ENABLED (web cheat panel can write to memory). Set ENABLE_REMOTE_EDIT=false to disable.")
end
beginLocate()
