const fs = require('fs');
const path = require('path');

const ADAPTER_ID = 'radical-red';
const ROOT_DIR = __dirname;
const DATA_PATH = path.join(ROOT_DIR, 'data', 'data.json');

const MAPSEC_NAMES = loadJson('data/mapsec_table.json', {});

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

function resolveLocationName(mon) {
  const mapsecId = mon.metMapsec ?? mon.metLocation ?? null;
  return mapsecId != null ? (MAPSEC_NAMES[String(mapsecId)] ?? null) : null;
}

function processPayload(rawPayload) {
  if (!rawPayload || !Array.isArray(rawPayload.party)) return rawPayload;
  const enrichLocation = (mon) => {
    const locationNameZh = resolveLocationName(mon);
    return { ...mon, metLocationNameZh: locationNameZh, metMapsecNameZh: locationNameZh };
  };

  return {
    adapterId: ADAPTER_ID,
    gameCode: rawPayload.gameCode ?? null,
    frame: rawPayload.frame ?? null,
    party: rawPayload.party.map(enrichLocation),
    pc: rawPayload.pc
      ? {
          ...rawPayload.pc,
          boxes: Array.isArray(rawPayload.pc.boxes)
            ? rawPayload.pc.boxes.map((box) => ({
                ...box,
                pokemon: Array.isArray(box.pokemon) ? box.pokemon.map(enrichLocation) : [],
              }))
            : [],
        }
      : null,
  };
}

module.exports = {
  id: ADAPTER_ID,
  dataPath: DATA_PATH,
  processPayload,
};

if (require.main === module) {
  console.log(`[adapter:${ADAPTER_ID}] This adapter is loaded by server/index.js now.`);
  console.log('[adapter:radical-red] Start the server process instead: node server/index.js');
}
