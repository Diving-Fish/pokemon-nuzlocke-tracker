const fs = require('fs');
const path = require('path');

const ADAPTER_ID = 'rnb';
const ROOT_DIR = __dirname;

// MVP data source: Run & Bun is an Emerald/pokeemerald-expansion hack whose RAM stores
// NATIONAL DEX species IDs (390 = Chimchar). We do not yet have a Run & Bun-specific
// Pokedex export, so we reuse Radical Red's data.js, which is keyed by RR's *internal*
// species IDs (its `dexID` field is the national dex number). loadData() re-indexes
// species and sprites by dexID so lookups by the national dex ID the ROM reports work.
// moves / abilities / types / natures use canonical gen IDs in RR's data, which match
// the expansion's numbering, so they are reused as-is. Held-item IDs may differ slightly
// between CFRU and the expansion — acceptable for now. Swap this for a real Run & Bun
// dataset later; the rest of the adapter does not care where DATA comes from.
const RR_DATA_JS_PATH = path.join(ROOT_DIR, '..', 'radical-red', 'data', 'data.js');

// Emerald location IDs differ from FireRed, so the RR mapsec table does not apply. Until
// a Run & Bun location table is built, capture-location names resolve to null.
const MAPSEC_NAMES = {};

const NATURE_NAMES_ZH = [
  '勤奋', '怕寂寞', '勇敢', '固执', '顽皮',
  '大胆', '坦率', '悠闲', '淘气', '乐天',
  '胆小', '急躁', '认真', '爽朗', '天真',
  '内敛', '慢吞吞', '冷静', '害羞', '马虎',
  '温和', '温顺', '自大', '慎重', '浮躁',
];

const NATURE_STATS = ['attack', 'defense', 'speed', 'spAttack', 'spDefense'];

function loadRrData() {
  const source = fs.readFileSync(RR_DATA_JS_PATH, 'utf8');
  return Function(`"use strict"; return (${source});`)();
}

// Re-key species + sprites from RR's internal IDs to national dex IDs. First-wins on
// ascending internal ID keeps the base form when several entries share a dexID (regional
// forms / megas, which RR appends at higher internal IDs).
function remapToNationalDex(rrData) {
  const species = {};
  const sprites = {};
  const internalIds = Object.keys(rrData.species || {}).map(Number).sort((a, b) => a - b);
  for (const internalId of internalIds) {
    const record = rrData.species[String(internalId)];
    const dexId = record && record.dexID;
    if (!Number.isInteger(dexId) || dexId <= 0 || species[dexId]) continue;
    species[dexId] = { ...record, ID: dexId, internalId };
    const sprite = rrData.sprites?.[String(internalId)];
    if (sprite) sprites[dexId] = sprite;
  }
  return { ...rrData, species, sprites };
}

function loadData() {
  return remapToNationalDex(loadRrData());
}

const DATA = loadData();

function getSprite(speciesId) {
  const sprite = DATA.sprites?.[String(speciesId)];
  return typeof sprite === 'string' && sprite.startsWith('data:image/png;base64,') ? sprite : null;
}

// split is the ROM's name for what the games now call the damage category.
const MOVE_CATEGORY_BY_SPLIT = ['physical', 'special', 'status'];

function typeName(typeId) {
  return DATA.types?.[String(typeId)]?.name ?? null;
}

// Resolve a move to the ROM's actual data. The server layers Chinese name/description on
// top by English name and fills any gaps.
function moveEntry(moveId) {
  const move = DATA.moves?.[String(moveId)];
  if (!move || !move.name) return null;
  return {
    name: move.name,
    type: typeName(move.type),
    category: MOVE_CATEGORY_BY_SPLIT[move.split] ?? null,
    power: Number.isFinite(move.power) ? move.power : null,
    accuracy: Number.isFinite(move.accuracy) ? move.accuracy : null,
    pp: Number.isFinite(move.pp) ? move.pp : null,
    description: move.description ?? null,
  };
}

// A species' learnable moves. Entries are deduplicated by name; for level-up moves the
// lowest level the move first appears at is kept. (Move IDs are canonical, so these are
// RR's movesets — close to, but not necessarily identical to, Run & Bun's.)
function getLearnableMoves(speciesId) {
  const species = DATA.species?.[String(speciesId)];
  if (!species) return null;

  const levelUpSeen = new Set();
  const levelUpMoves = [];
  for (const entry of Array.isArray(species.levelupMoves) ? species.levelupMoves : []) {
    const [id, level] = Array.isArray(entry) ? entry : [entry, 0];
    const move = moveEntry(id);
    if (!move || levelUpSeen.has(move.name)) continue;
    levelUpSeen.add(move.name);
    levelUpMoves.push({ ...move, level: Number(level) || 0 });
  }

  const entriesOf = (ids) => {
    const seen = new Set();
    const out = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      const move = moveEntry(id);
      if (!move || seen.has(move.name)) continue;
      seen.add(move.name);
      out.push(move);
    }
    return out;
  };

  return {
    levelUpMoves,
    tmMoves: entriesOf(species.tmMoves),
    tutorMoves: entriesOf(species.tutorMoves),
  };
}

function resolveLocationName(mon) {
  const mapsecId = mon.metMapsec ?? mon.metLocation ?? null;
  return mapsecId != null ? (MAPSEC_NAMES[String(mapsecId)] ?? null) : null;
}

function resolveNature(mon) {
  const natureId = Number.isInteger(mon.natureId)
    ? mon.natureId
    : Number.isInteger(mon.personality)
      ? mon.personality % 25
      : null;
  if (natureId == null || natureId < 0 || natureId > 24) {
    return { natureId: null, natureName: null, natureNameZh: null, natureUp: null, natureDown: null };
  }
  const up = NATURE_STATS[Math.floor(natureId / 5)] ?? null;
  const down = NATURE_STATS[natureId % 5] ?? null;
  return {
    natureId,
    natureName: DATA.natures?.[String(natureId)] ?? null,
    natureNameZh: NATURE_NAMES_ZH[natureId] ?? null,
    natureUp: up !== down ? up : null,
    natureDown: up !== down ? down : null,
  };
}

function estimatePp(mon) {
  if (!mon.ppEstimated || !Array.isArray(mon.moves)) return mon.pp;
  return mon.moves.map((id, index) => {
    const current = Array.isArray(mon.pp) ? mon.pp[index] : null;
    return current || DATA.moves?.[String(id)]?.pp || 0;
  });
}

function processPayload(rawPayload) {
  if (!rawPayload || !Array.isArray(rawPayload.party)) return rawPayload;
  const enrichMon = (mon) => {
    const locationNameZh = resolveLocationName(mon);
    const nature = resolveNature(mon);
    return {
      ...mon,
      pp: estimatePp(mon),
      metLocationNameZh: locationNameZh,
      metMapsecNameZh: locationNameZh,
      natureId: nature.natureId,
      natureName: nature.natureName,
      natureNameZh: nature.natureNameZh,
      natureUp: nature.natureUp,
      natureDown: nature.natureDown,
    };
  };

  return {
    adapterId: ADAPTER_ID,
    gameCode: rawPayload.gameCode ?? null,
    frame: rawPayload.frame ?? null,
    party: rawPayload.party.map(enrichMon),
    pc: rawPayload.pc
      ? {
          ...rawPayload.pc,
          boxes: Array.isArray(rawPayload.pc.boxes)
            ? rawPayload.pc.boxes.map((box) => ({
                ...box,
                pokemon: Array.isArray(box.pokemon) ? box.pokemon.map(enrichMon) : [],
              }))
            : [],
        }
      : null,
  };
}

module.exports = {
  id: ADAPTER_ID,
  loadData,
  getSprite,
  getLearnableMoves,
  processPayload,
};

if (require.main === module) {
  console.log(`[adapter:${ADAPTER_ID}] Loaded by server/index.js. Start: node server/index.js`);
}
