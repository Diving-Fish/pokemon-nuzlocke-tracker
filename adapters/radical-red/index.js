const fs = require('fs');
const path = require('path');

const ADAPTER_ID = 'radical-red';
const ROOT_DIR = __dirname;
const DATA_JS_PATH = path.join(ROOT_DIR, 'data', 'data.js');

const MAPSEC_NAMES = loadJson('data/mapsec_table.json', {});
const DATA = loadData();

const NATURE_NAMES_ZH = [
  '\u52e4\u594b', '\u6015\u5bc2\u5bde', '\u52c7\u6562', '\u56fa\u6267', '\u987d\u76ae',
  '\u5927\u80c6', '\u5766\u7387', '\u60a0\u95f2', '\u6dd8\u6c14', '\u4e50\u5929',
  '\u80c6\u5c0f', '\u6025\u8e81', '\u8ba4\u771f', '\u723d\u6717', '\u5929\u771f',
  '\u5185\u655b', '\u6162\u541e\u541e', '\u51b7\u9759', '\u5bb3\u7f9e', '\u9a6c\u864e',
  '\u6e29\u548c', '\u6e29\u987a', '\u81ea\u5927', '\u614e\u91cd', '\u6d6e\u8e81',
];

const NATURE_STATS = ['attack', 'defense', 'speed', 'spAttack', 'spDefense'];

function loadJson(relativePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT_DIR, relativePath), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`[adapter:${ADAPTER_ID}] failed to load ${relativePath}: ${error.message}`);
    }
    return fallback;
  }
}

function loadData() {
  const source = fs.readFileSync(DATA_JS_PATH, 'utf8');
  return Function(`"use strict"; return (${source});`)();
}

function getSprite(speciesId) {
  const sprite = DATA.sprites?.[String(speciesId)];
  return typeof sprite === 'string' && sprite.startsWith('data:image/png;base64,') ? sprite : null;
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
  dataJsPath: DATA_JS_PATH,
  loadData,
  getSprite,
  processPayload,
};

if (require.main === module) {
  console.log(`[adapter:${ADAPTER_ID}] This adapter is loaded by server/index.js now.`);
  console.log('[adapter:radical-red] Start the server process instead: node server/index.js');
}
