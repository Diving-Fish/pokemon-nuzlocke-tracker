-- mGBA Pokemon party exporter for FireRed-based ROM hacks such as Radical Red.
-- Load this script in mGBA after starting the tracker server.

local EXPORT_HOST = "127.0.0.1"
local EXPORT_PORT = 8765
local EXPORT_INTERVAL_FRAMES = 60

local PARTY_COUNT_ADDRESS = 0x02024029
local PARTY_ADDRESS = 0x02024284
local PC_STORAGE_POINTER_ADDRESS = 0x03005010
local PC_BOXES_OFFSET = 4
local PC_BOX_COUNT = 25
local PC_BOX_SIZE = 30
local PC_MON_SIZE = 58
local PARTY_MON_SIZE = 100
local MON_NAME_LENGTH = 10
local PLAYER_NAME_LENGTH = 7
local TEXT_TERMINATOR = 0xFF

local exporterSocket = nil
local frameCounter = 0
local lastPayload = nil
local lastConnectAttemptFrame = -300

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

local function readDecryptedSubstructures(address)
	local personality = emu:read32(address)
	local otId = emu:read32(address + 4)
	local key = personality ~ otId
	local orderTable = {
		[0] = {0, 1, 2, 3}, {0, 1, 3, 2}, {0, 2, 1, 3}, {0, 3, 1, 2},
		{0, 2, 3, 1}, {0, 3, 2, 1}, {1, 0, 2, 3}, {1, 0, 3, 2},
		{2, 0, 1, 3}, {3, 0, 1, 2}, {2, 0, 3, 1}, {3, 0, 2, 1},
		{1, 2, 0, 3}, {1, 3, 0, 2}, {2, 1, 0, 3}, {3, 1, 0, 2},
		{2, 3, 0, 1}, {3, 2, 0, 1}, {1, 2, 3, 0}, {1, 3, 2, 0},
		{2, 1, 3, 0}, {3, 1, 2, 0}, {2, 3, 1, 0}, {3, 2, 1, 0}
	}
	local order = orderTable[personality % 24]
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

local function readPartyMon(slot)
	local address = PARTY_ADDRESS + (slot - 1) * PARTY_MON_SIZE
	local mon = readBoxMon(address)
	mon.slot = slot
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

local function isValidStoragePointer(address)
	return address >= 0x02000000 and address < 0x03008000
end

local function isValidBoxMon(mon)
	return mon.species and mon.species > 0 and mon.species < 2000 and mon.isEgg == 0 and mon.personality ~= 0 and mon.personality ~= 0xFFFFFFFF
end

local function readPcMon(address)
	local personality = emu:read32(address)
	local flags = emu:read8(address + 19)
	return {
		personality = personality,
		otId = emu:read32(address + 4),
		boxChecksum = 0,
		calculatedChecksum = 0,
		checksumValid = false,
		dataFormat = "pcPlain58",
		nickname = readPokemonString(address + 8, MON_NAME_LENGTH),
		otName = readPokemonString(address + 20, PLAYER_NAME_LENGTH),
		species = emu:read16(address + 28),
		heldItem = emu:read16(address + 30),
		experience = emu:read32(address + 32),
		friendship = emu:read8(address + 37),
		moves = {0, 0, 0, 0},
		pp = {0, 0, 0, 0},
		pokerus = 0,
		metLocation = 0,
		metMapsec = 0,
		metLevel = 0,
		metGame = 0,
		originBytes = { byte0 = 0, byte1 = 0, byte2 = 0, byte3 = 0 },
		pokeball = 0,
		otGender = 0,
		evs = { hp = 0, attack = 0, defense = 0, speed = 0, spAttack = 0, spDefense = 0 },
		ivs = { hp = 0, attack = 0, defense = 0, speed = 0, spAttack = 0, spDefense = 0 },
		isEgg = (flags >> 2) & 1,
		hiddenAbility = 0,
		abilityNum = personality & 1
	}
end

local function readPcBoxes()
	local storageAddress = emu:read32(PC_STORAGE_POINTER_ADDRESS)
	local boxes = {}
	local debugSlots = {}
	if not isValidStoragePointer(storageAddress) then
		return {
			storageAddress = storageAddress,
			boxesOffset = PC_BOXES_OFFSET,
			debugSlots = debugSlots,
			boxes = boxes
		}
	end

	for boxIndex = 0, PC_BOX_COUNT - 1 do
		local box = {
			index = boxIndex + 1,
			pokemon = {}
		}
		for position = 0, PC_BOX_SIZE - 1 do
			local address = storageAddress + PC_BOXES_OFFSET + (boxIndex * PC_BOX_SIZE + position) * PC_MON_SIZE
			local mon = readPcMon(address)
			if mon.species == 163 or (mon.species and mon.species > 0 and mon.species < 2000 and mon.personality ~= 0 and mon.personality ~= 0xFFFFFFFF) then
				debugSlots[#debugSlots + 1] = {
					box = boxIndex + 1,
					position = position + 1,
					address = address,
					personality = mon.personality,
					otId = mon.otId,
					flags = emu:read8(address + 19),
					species = mon.species,
					heldItem = mon.heldItem,
					experience = mon.experience,
					friendship = mon.friendship
				}
			end
			if isValidBoxMon(mon) then
				mon.box = boxIndex + 1
				mon.position = position + 1
				box.pokemon[#box.pokemon + 1] = mon
			end
		end
		boxes[#boxes + 1] = box
	end

	return {
		storageAddress = storageAddress,
		boxesOffset = PC_BOXES_OFFSET,
		debugSlots = debugSlots,
		boxes = boxes
	}
end

local function pcDebugSlotsToJson(slots)
	local parts = {}
	for index, slot in ipairs(slots) do
		parts[index] = string.format('{"box":%d,"position":%d,"address":%d,"personality":%d,"otId":%d,"flags":%d,"species":%d,"heldItem":%d,"experience":%d,"friendship":%d}',
			slot.box,
			slot.position,
			slot.address,
			slot.personality,
			slot.otId,
			slot.flags,
			slot.species,
			slot.heldItem,
			slot.experience,
			slot.friendship)
	end
	return "[" .. table.concat(parts, ",") .. "]"
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
		originBytes.byte0,
		originBytes.byte1,
		originBytes.byte2,
		originBytes.byte3)
end

local function monToJson(mon)
	return string.format('{"slot":%d,"species":%d,"nickname":"%s","otName":"%s","level":%d,"hp":%d,"maxHP":%d,"status":%d,"heldItem":%d,"experience":%d,"friendship":%d,"moves":%s,"pp":%s,"pokerus":%d,"metLocation":%d,"metMapsec":%d,"metLevel":%d,"metGame":%d,"originBytes":%s,"pokeball":%d,"otGender":%d,"ivs":%s,"evs":%s,"stats":%s,"isEgg":%d,"hiddenAbility":%d,"abilityNum":%d,"personality":%d,"otId":%d,"boxChecksum":%d,"calculatedChecksum":%d,"checksumValid":%s,"dataFormat":"%s"}',
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
		mon.otId,
		mon.boxChecksum,
		mon.calculatedChecksum,
		tostring(mon.checksumValid),
		jsonEscape(mon.dataFormat))
end

local function pcMonToJson(mon)
	return string.format('{"box":%d,"position":%d,"species":%d,"nickname":"%s","otName":"%s","heldItem":%d,"experience":%d,"friendship":%d,"moves":%s,"pp":%s,"pokerus":%d,"metLocation":%d,"metMapsec":%d,"metLevel":%d,"metGame":%d,"originBytes":%s,"pokeball":%d,"otGender":%d,"ivs":%s,"evs":%s,"isEgg":%d,"hiddenAbility":%d,"abilityNum":%d,"personality":%d,"otId":%d,"boxChecksum":%d,"calculatedChecksum":%d,"checksumValid":%s,"dataFormat":"%s"}',
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
		boxes[boxIndex] = string.format('{"index":%d,"pokemon":[%s]}',
			box.index,
			table.concat(mons, ","))
	end
	return string.format('{"storageAddress":%d,"boxesOffset":%d,"debugSlots":%s,"boxes":[%s]}',
		pc.storageAddress,
		pc.boxesOffset,
		pcDebugSlotsToJson(pc.debugSlots or {}),
		table.concat(boxes, ","))
end

local function readParty()
	local count = emu:read8(PARTY_COUNT_ADDRESS)
	if count < 0 or count > 6 then
		count = 0
	end
	local party = {}
	for slot = 1, count do
		party[slot] = readPartyMon(slot)
	end
	return party
end

local function statusToJson(party, pc)
	local mons = {}
	for index, mon in ipairs(party) do
		mons[index] = monToJson(mon)
	end
	return string.format('{"source":"mgba","gameCode":"%s","frame":%d,"partyCount":%d,"party":[%s],"pc":%s}',
		jsonEscape(emu:getGameCode() or ""),
		frameCounter,
		#party,
		table.concat(mons, ","),
		pcBoxesToJson(pc))
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
	if frameCounter % EXPORT_INTERVAL_FRAMES ~= 0 then
		return
	end
	local payload = statusToJson(readParty(), readPcBoxes())
	if payload ~= lastPayload then
		lastPayload = payload
		sendPayload(payload)
	end
end

callbacks:add("frame", exportParty)
callbacks:add("stop", closeExporterSocket)
callbacks:add("crashed", closeExporterSocket)
callbacks:add("reset", function()
	lastPayload = nil
	closeExporterSocket()
end)

console:log("Party Export loaded. Start server/index.js on TCP port " .. EXPORT_PORT .. ".")
