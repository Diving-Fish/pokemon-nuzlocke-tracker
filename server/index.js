const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const HTTP_PORT = Number(process.env.HTTP_PORT || 8787);
const TCP_PORT = Number(process.env.TCP_PORT || 8765);
const ROOT_DIR = __dirname;
const PROJECT_ROOT = path.resolve(ROOT_DIR, '..');
const DASHBOARD_PATH = path.join(ROOT_DIR, 'public', 'dashboard.html');
const NUZLOCKE_PATH = path.join(ROOT_DIR, 'public', 'nuzlocke.html');
const OBS_PATH = path.join(ROOT_DIR, 'public', 'obs.html');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

// Static assets (vendored JS/CSS + self-hosted fonts) live under public/vendor
// and public/fonts so the dashboards have no remote CDN dependency.
const STATIC_PREFIXES = ['/vendor/', '/fonts/'];
const STATIC_CONTENT_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
const NUZLOCKE_STATE_PATH = path.join(PROJECT_ROOT, '.game', 'nuzlocke-state.json');

const ADAPTERS = new Map([
  ['radical-red', require(path.join(PROJECT_ROOT, 'adapters', 'radical-red'))],
  ['rnb', require(path.join(PROJECT_ROOT, 'adapters', 'rnb'))],
]);
const DEFAULT_ADAPTER_ID = process.env.ADAPTER_ID || 'radical-red';

// Route an incoming raw payload to the right adapter so two ROMs can be tracked without
// reconfiguring. A Lua script may tag its payload with `romHack` (authoritative); else we
// fall back to the GBA game code (FireRed=BPRE → Radical Red, Emerald=BPEE → Run & Bun).
const ADAPTER_BY_GAME_CODE = { BPRE: 'radical-red', BPEE: 'rnb' };

function resolveAdapterForPayload(payload) {
  const hinted = payload?.romHack;
  if (hinted && ADAPTERS.has(hinted)) return getAdapter(hinted);
  const byGameCode = ADAPTER_BY_GAME_CODE[String(payload?.gameCode || '').toUpperCase()];
  return getAdapter(byGameCode || DEFAULT_ADAPTER_ID);
}

// ── data loading ──────────────────────────────────────────────────────────────

function loadJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`[server] failed to load ${filePath}: ${error.message}`);
    return fallback;
  }
}

function saveJsonFile(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

function readText(relativePath) {
  try {
    return fs.readFileSync(path.join(ROOT_DIR, relativePath), 'utf8');
  } catch {
    return '';
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ''));
    rows.push(row);
  }
  const header = rows.shift() || [];
  return rows
    .filter((cells) => cells.length === header.length)
    .map((cells) => Object.fromEntries(header.map((key, index) => [key, cells[index]])));
}

function loadGrowthRateData(adapterId) {
  const dataDir = path.join(PROJECT_ROOT, 'adapters', adapterId, 'data');
  const speciesPath = path.join(dataDir, 'pokeapi_pokemon_species.csv');
  const ratesPath = path.join(dataDir, 'pokeapi_growth_rates.csv');
  try {
    const speciesRows = parseCsv(fs.readFileSync(speciesPath, 'utf8'));
    const rateRows = parseCsv(fs.readFileSync(ratesPath, 'utf8'));
    return {
      speciesGrowthRateIds: new Map(speciesRows.map((row) => [Number(row.id), Number(row.growth_rate_id)])),
      growthRateNames: new Map(rateRows.map((row) => [Number(row.id), row.identifier])),
    };
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`[server] failed to load growth rate CSVs: ${error.message}`);
    return null;
  }
}

const adapterCache = new Map();

function getAdapter(adapterId = DEFAULT_ADAPTER_ID) {
  const adapter = ADAPTERS.get(adapterId);
  if (!adapter) throw new Error(`Unknown adapter: ${adapterId}`);
  return adapter;
}

function getAdapterContext(adapterId = DEFAULT_ADAPTER_ID) {
  const adapter = getAdapter(adapterId);
  if (!adapterCache.has(adapter.id)) {
    const data = typeof adapter.loadData === 'function' ? adapter.loadData() : loadJsonFile(adapter.dataPath, {});
    const translations = buildTranslations(data);
    adapterCache.set(adapter.id, {
      adapter,
      data,
      growthRateData: loadGrowthRateData(adapter.id),
      translations,
      moveInfo: buildMoveInfo(data),
      translationsJson: JSON.stringify({
        species: Object.fromEntries(translations.species),
        moves: Object.fromEntries(translations.moves),
        abilities: Object.fromEntries(translations.abilities),
        items: Object.fromEntries(translations.items),
      }),
    });
  }
  return adapterCache.get(adapter.id);
}

function spriteSlug(value) {
  return String(value || '').toLowerCase()
    .replace(/♀/g, '-f')
    .replace(/♂/g, '-m')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function defaultSpriteUrl(mon) {
  const species = spriteSlug(mon.speciesName || '');
  const form = spriteSlug(mon.formName || '');
  const slug = form ? `${species}-${form}` : species;
  return `https://www.diving-fish.com/showdown/sprites/${slug}.png`;
}

function localSpriteUrl(adapterId, speciesId) {
  if (speciesId == null) return null;
  return `/sprite?adapterId=${encodeURIComponent(adapterId)}&species=${encodeURIComponent(speciesId)}`;
}

function sendPngDataUri(res, dataUri) {
  const match = /^data:image\/png;base64,(.+)$/i.exec(dataUri || '');
  if (!match) return false;
  res.writeHead(200, {
    'content-type': 'image/png',
    'cache-control': 'public, max-age=31536000, immutable',
    'access-control-allow-origin': '*',
  });
  res.end(Buffer.from(match[1], 'base64'));
  return true;
}

// ── name helpers ──────────────────────────────────────────────────────────────

function getRecordName(record) {
  if (!record) return null;
  return Array.isArray(record.names) ? (record.names[0] || null) : (record.name || null);
}

function lookupById(records, id) {
  if (!id) return null;
  return records ? (records[String(id)] || null) : null;
}

// ── translation builder ───────────────────────────────────────────────────────

function normalizeName(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function buildKnownNames(records) {
  const knownNames = new Map();
  for (const record of Object.values(records || {})) {
    const name = getRecordName(record);
    if (name) knownNames.set(normalizeName(name), name);
  }
  return knownNames;
}

function containsChinese(value) { return /[㐀-鿿]/.test(value || ''); }
function containsKana(value)    { return /[぀-ヿ]/.test(value || ''); }

function findChineseCell(cells, englishIndex) {
  for (let i = englishIndex - 1; i >= 0; i--) {
    const cell = cells[i].replace(/^#+\d+\s*/, '').trim();
    if (containsChinese(cell) && !containsKana(cell)) return cell.replace(/\*$/, '').trim();
  }
  return null;
}

function parseTranslationFile(relativePath, knownNames) {
  const translations = new Map();
  const lines = readText(relativePath).split(/\r?\n/);
  for (const line of lines) {
    const cells = line.split('\t').map((c) => c.trim()).filter(Boolean);
    for (let i = 0; i < cells.length; i++) {
      const englishName = knownNames.get(normalizeName(cells[i]));
      if (!englishName || translations.has(englishName)) continue;
      const chineseName = findChineseCell(cells, i);
      if (chineseName) translations.set(englishName, chineseName);
    }
  }
  return translations;
}

// English (adapter/ROM) → Chinese, so a custom or type-tweaked move still shows a
// localized, color-coded type even when it isn't in the official move table.
const TYPE_NAMES_ZH = {
  Normal: '一般', Fighting: '格斗', Flying: '飞行', Poison: '毒', Ground: '地面',
  Rock: '岩石', Bug: '虫', Ghost: '幽灵', Steel: '钢', Fire: '火', Water: '水',
  Grass: '草', Electric: '电', Psychic: '超能力', Ice: '冰', Dragon: '龙',
  Dark: '恶', Fairy: '妖精',
};

const MOVE_CATEGORY_ZH = { physical: '物理', special: '特殊', status: '变化' };

// moves.txt is richer than a plain name list: it carries the Chinese name, type,
// category, power/accuracy/PP and a Chinese description per move. Radical Red reorders
// move IDs, so we join to the ROM data by (normalized) English name — the same key the
// translation parser already uses — rather than by ID.
function parseMoveInfoFile(relativePath, knownNames) {
  const info = new Map();
  const lines = readText(relativePath).split(/\r?\n/);
  for (const line of lines) {
    const cells = line.split('\t');
    if (!/^\d+$/.test((cells[0] || '').trim()) || cells.length < 10) continue;
    const englishName = knownNames.get(normalizeName(cells[3]));
    if (!englishName || info.has(englishName)) continue;
    const clean = (value) => {
      const text = String(value || '').trim();
      return text || null;
    };
    info.set(englishName, {
      nameZh: clean(cells[1]),
      type: clean(cells[4]),
      category: clean(cells[5]),
      power: clean(cells[6]),
      accuracy: clean(cells[7]),
      pp: clean(cells[8]),
      description: clean(cells[9]),
    });
  }
  return info;
}

function buildMoveInfo(data) {
  return parseMoveInfoFile('data/translates/moves.txt', buildKnownNames(data.moves));
}

function buildTranslations(data) {
  const speciesNames  = buildKnownNames(data.species);
  const moveNames     = buildKnownNames(data.moves);
  const abilityNames  = buildKnownNames(data.abilities);
  const itemNames     = buildKnownNames(data.items);
  return {
    species:   parseTranslationFile('data/translates/pokemons.txt',   speciesNames),
    moves:     parseTranslationFile('data/translates/moves.txt',      moveNames),
    abilities: parseTranslationFile('data/translates/abilities.txt',  abilityNames),
    items:     parseTranslationFile('data/translates/items.txt',      itemNames),
  };
}

// ── party enrichment (adapter raw IDs → English names) ───────────────────────

function resolveAbility(mon, speciesRecord, data) {
  const abilityGroups = Array.isArray(speciesRecord?.abilities) ? speciesRecord.abilities : [];
  const hiddenGroup = abilityGroups[0] || [];
  const standardSlot = Number.isInteger(mon.abilityNum) ? mon.abilityNum : 0;
  const firstAbilityId = (group) => Array.isArray(group) ? group.find((id) => id) : group;
  const secondAbilityId = firstAbilityId(abilityGroups[2]);
  const standardIndex = standardSlot === 1 && secondAbilityId ? 2 : 1;
  const standardGroup = abilityGroups[standardIndex] || abilityGroups[1] || hiddenGroup;
  const hiddenAbilityId = firstAbilityId(hiddenGroup);
  const standardAbilityId = firstAbilityId(standardGroup);
  const abilityId = mon.hiddenAbility && hiddenAbilityId ? hiddenAbilityId : standardAbilityId;
  const abilityName = getRecordName(lookupById(data.abilities, abilityId));

  const abilityCandidates = abilityGroups
    .map((g, idx) => {
      const candidateId = firstAbilityId(g);
      const candidateName = getRecordName(lookupById(data.abilities, candidateId));
      if (!candidateId || !candidateName) return null;
      const slot = idx === 0 ? 'hidden' : idx === 1 ? 'first' : 'second';
      return { slot, abilityId: candidateId, abilityName: candidateName };
    })
    .filter(Boolean);

  return { abilityId: abilityId || null, abilityName, abilityCandidates };
}

const NATURE_STAT_KEYS = ['attack', 'defense', 'speed', 'spAttack', 'spDefense'];
const GROWTH_RATE_NAMES = ['erratic', 'fast', 'medium', 'medium-slow', 'slow', 'fluctuating'];

function canonicalGrowthRateName(name) {
  if (name === 'slow-then-very-fast') return 'erratic';
  if (name === 'fast-then-very-slow') return 'fluctuating';
  return name;
}

function expForLevel(growthRateName, level) {
  const n = level;
  const rate = canonicalGrowthRateName(growthRateName);
  if (n <= 1) return 0;
  switch (rate) {
    case 'slow':
      return Math.floor(5 * n ** 3 / 4);
    case 'medium':
      return n ** 3;
    case 'fast':
      return Math.floor(4 * n ** 3 / 5);
    case 'medium-slow':
      return Math.floor(6 * n ** 3 / 5 - 15 * n ** 2 + 100 * n - 140);
    case 'erratic':
      if (n <= 50) return Math.floor(n ** 3 * (100 - n) / 50);
      if (n <= 68) return Math.floor(n ** 3 * (150 - n) / 100);
      if (n <= 98) return Math.floor(n ** 3 * Math.floor((1911 - 10 * n) / 3) / 500);
      return Math.floor(n ** 3 * (160 - n) / 100);
    case 'fluctuating':
      if (n <= 15) return Math.floor(n ** 3 * (Math.floor((n + 1) / 3) + 24) / 50);
      if (n <= 36) return Math.floor(n ** 3 * (n + 14) / 50);
      return Math.floor(n ** 3 * (Math.floor(n / 2) + 32) / 50);
    default:
      return null;
  }
}

function levelFromExperience(growthRateName, experience) {
  if (!growthRateName || !Number.isFinite(experience)) return null;
  let level = 1;
  for (let candidate = 2; candidate <= 100; candidate++) {
    const requiredExp = expForLevel(growthRateName, candidate);
    if (requiredExp == null || experience < requiredExp) break;
    level = candidate;
  }
  return level;
}

function levelOptionsFromExperience(experience, selectedGrowthRateName = null) {
  if (!Number.isFinite(experience)) return [];
  const selected = canonicalGrowthRateName(selectedGrowthRateName);
  return GROWTH_RATE_NAMES.map((growthRateName) => ({
    growthRateName,
    level: levelFromExperience(growthRateName, experience),
    selected: selected === growthRateName,
  })).filter((option) => option.level);
}

// Growth rate for any mon (party mons don't carry an inferred growthRateName since
// their level comes straight from RAM). Mirrors the resolution inside inferLevel.
function resolveGrowthRateName(mon, growthRateData, adapterId) {
  if (!growthRateData) return null;
  const overrideName = nuzlockeState?.growthRateOverrides?.[monIdentity(mon, adapterId)] || null;
  const dexId = mon?.dexId ?? mon?.species;
  const growthRateId = growthRateData.speciesGrowthRateIds.get(Number(dexId));
  const defaultGrowthRateName = growthRateData.growthRateNames.get(growthRateId);
  return overrideName || canonicalGrowthRateName(defaultGrowthRateName) || null;
}

// Find a 32-bit personality whose nature (p % 25) and ability slot bit (p & 1) match
// the desired values, preferring the smallest value at/above `base`. Nature and parity
// are coprime cycles (lengths 25 and 2), so any 50 consecutive non-wrapping integers
// cover every (nature, parity) combo. We avoid wrapping mid-search because 2^32 is not
// a multiple of 50, which would skip residues; if `base` sits within 50 of the ceiling
// we fall back to the [0, 49] window, which always contains a match. Changing
// personality can also shift gender/shininess — an accepted side effect of a cheat tool.
function personalityForNatureAndAbility(base, nature, abilityBit) {
  const TOP = 0x100000000;
  const start = base >>> 0;
  for (let k = 0; k < 50; k++) {
    const p = start + k;
    if (p < TOP && p % 25 === nature && (p & 1) === abilityBit) return p >>> 0;
  }
  for (let p = 0; p < 50; p++) {
    if (p % 25 === nature && (p & 1) === abilityBit) return p;
  }
  return start;
}

function inferLevel(mon, speciesRecord, growthRateData, adapterId) {
  if (!growthRateData || Number.isInteger(mon.level)) return null;
  const overrideName = nuzlockeState?.growthRateOverrides?.[monIdentity(mon, adapterId)] || null;
  const dexId = speciesRecord?.dexID ?? mon.species;
  const growthRateId = growthRateData.speciesGrowthRateIds.get(Number(dexId));
  const defaultGrowthRateName = growthRateData.growthRateNames.get(growthRateId);
  const growthRateName = overrideName || canonicalGrowthRateName(defaultGrowthRateName);
  const level = levelFromExperience(growthRateName, mon.experience);
  return level ? {
    level,
    growthRateName,
    defaultGrowthRateName,
    growthRateOverride: overrideName,
    levelOptions: levelOptionsFromExperience(mon.experience, growthRateName),
  } : null;
}

function statNatureModifier(natureId, statKey) {
  if (!Number.isInteger(natureId) || natureId < 0 || natureId > 24) return 1;
  const up = NATURE_STAT_KEYS[Math.floor(natureId / 5)] ?? null;
  const down = NATURE_STAT_KEYS[natureId % 5] ?? null;
  if (up === down) return 1;
  if (statKey === up) return 1.1;
  if (statKey === down) return 0.9;
  return 1;
}

function calculateStats(mon, baseStats, speciesRecord) {
  if (!baseStats || !mon?.ivs || !mon?.evs) return null;
  const level = Number.isInteger(mon.level) && mon.level > 0 ? mon.level : null;
  if (!level) return null;

  const calcBase = (statKey) => {
    const base = baseStats[statKey] ?? 0;
    const iv = mon.ivs[statKey] ?? 0;
    const ev = mon.evs[statKey] ?? 0;
    return Math.floor(((base * 2 + iv + Math.floor(ev / 4)) * level) / 100);
  };
  const calcStat = (statKey) => {
    const raw = calcBase(statKey) + 5;
    return Math.floor(raw * statNatureModifier(mon.natureId, statKey));
  };

  const maxHP = speciesRecord?.dexID === 292
    ? 1
    : calcBase('hp') + level + 10;

  return {
    level,
    maxHP,
    stats: {
      attack:    calcStat('attack'),
      defense:   calcStat('defense'),
      speed:     calcStat('speed'),
      spAttack:  calcStat('spAttack'),
      spDefense: calcStat('spDefense'),
    },
  };
}

function enrichMon(mon, data, adapterId = DEFAULT_ADAPTER_ID, growthRateData = null) {
  const speciesRecord = lookupById(data.species, mon.species);
  const speciesName   = getRecordName(speciesRecord);
  const speciesKey    = speciesRecord?.key || speciesName || null;
  const formSuffix    = speciesKey && speciesName && speciesKey !== speciesName
    ? speciesKey.slice(speciesName.length).replace(/^-/, '') || null
    : null;
  const itemRecord    = lookupById(data.items, mon.heldItem);
  const heldItemName  = getRecordName(itemRecord);
  const moveNames     = Array.isArray(mon.moves)
    ? mon.moves.map((id) => getRecordName(lookupById(data.moves, id)))
    : [];
  const ability = resolveAbility(mon, speciesRecord, data);

  const speciesStats = Array.isArray(speciesRecord?.stats) ? speciesRecord.stats : null;
  const baseStats = speciesStats ? {
    hp:        speciesStats[0] ?? 0,
    attack:    speciesStats[1] ?? 0,
    defense:   speciesStats[2] ?? 0,
    speed:     speciesStats[3] ?? 0,
    spAttack:  speciesStats[4] ?? 0,
    spDefense: speciesStats[5] ?? 0,
  } : null;
  const inferredLevel = inferLevel(mon, speciesRecord, growthRateData, adapterId);
  const monWithLevel = inferredLevel ? { ...mon, level: inferredLevel.level } : mon;
  const calculatedStats = calculateStats(monWithLevel, baseStats, speciesRecord);
  const shouldUseCalculatedStats = calculatedStats && (!mon.stats || mon.maxHP == null);

  return {
    ...mon,
    ...(inferredLevel ? {
      level: inferredLevel.level,
      levelEstimated: true,
      growthRateName: inferredLevel.growthRateName,
      defaultGrowthRateName: inferredLevel.defaultGrowthRateName,
      growthRateOverride: inferredLevel.growthRateOverride,
      levelOptions: inferredLevel.levelOptions,
    } : {}),
    ...(shouldUseCalculatedStats ? {
      level: mon.level ?? calculatedStats.level,
      maxHP: mon.maxHP ?? calculatedStats.maxHP,
      stats: mon.stats ?? calculatedStats.stats,
      statsEstimated: true,
    } : {}),
    speciesName,
    speciesKey,
    dexId:             speciesRecord?.dexID ?? mon.species,
    formOrder:         speciesRecord?.order ?? 0,
    formName:          formSuffix,
    isRegionalForm:    Boolean(formSuffix),
    moveNames,
    heldItemName,
    abilityId:         ability.abilityId,
    abilityName:       ability.abilityName,
    abilityCandidates: ability.abilityCandidates,
    baseStats,
    spriteUrl:          localSpriteUrl(adapterId, mon.species) || defaultSpriteUrl({ speciesName, formName: formSuffix }),
  };
}

function enrichPc(pc, data, adapterId = DEFAULT_ADAPTER_ID, growthRateData = null) {
  if (!pc || !Array.isArray(pc.boxes)) return pc ?? null;
  return {
    ...pc,
    boxes: pc.boxes.map((box) => ({
      ...box,
      pokemon: Array.isArray(box.pokemon)
        ? box.pokemon.map((mon) => enrichMon(mon, data, adapterId, growthRateData))
        : [],
    })),
  };
}

function enrichStatus(payload) {
  if (!payload || !Array.isArray(payload.party)) return payload;
  const context = getAdapterContext(payload.adapterId || DEFAULT_ADAPTER_ID);
  return {
    ...payload,
    adapterId: context.adapter.id,
    party: payload.party.map((mon) => enrichMon(mon, context.data, context.adapter.id, context.growthRateData)),
    pc: enrichPc(payload.pc, context.data, context.adapter.id, context.growthRateData),
  };
}

// ---- Nuzlocke state --------------------------------------------------------

function createNuzlockeState() {
  return { version: 1, mons: {}, locationLimits: {}, growthRateOverrides: {} };
}

function loadNuzlockeState() {
  const state = loadJsonFile(NUZLOCKE_STATE_PATH, createNuzlockeState());
  return {
    version: 1,
    mons: state.mons && typeof state.mons === 'object' ? state.mons : {},
    locationLimits: state.locationLimits && typeof state.locationLimits === 'object' ? state.locationLimits : {},
    growthRateOverrides: state.growthRateOverrides && typeof state.growthRateOverrides === 'object'
      ? state.growthRateOverrides
      : {},
  };
}

let nuzlockeState = loadNuzlockeState();

function persistNuzlockeState() {
  saveJsonFile(NUZLOCKE_STATE_PATH, nuzlockeState);
}

function monIdentity(mon, adapterId = DEFAULT_ADAPTER_ID) {
  if (mon?.personality != null) return `${adapterId}:personality:${mon.personality}`;
  const location = mon?.metMapsec ?? mon?.metLocation ?? 'unknown';
  const place = mon?.slot ? `party:${mon.slot}` : `box:${mon?.box ?? '?'}:${mon?.position ?? '?'}`;
  return `${adapterId}:fallback:${mon?.species ?? '?'}:${location}:${place}`;
}

function locationKey(mon) {
  const location = mon?.metMapsec ?? mon?.metLocation;
  return location == null ? null : `mapsec:${location}`;
}

function locationLabel(mon) {
  const fallback = mon?.metMapsec ?? mon?.metLocation;
  return mon?.metLocationNameZh || mon?.metMapsecNameZh || (fallback == null ? null : `区域 #${fallback}`);
}

function collectPokemon(status) {
  const adapterId = status?.adapterId || DEFAULT_ADAPTER_ID;
  const party = Array.isArray(status?.party)
    ? status.party.map((mon) => ({ ...mon, source: 'party', sourceLabel: `随行 ${mon.slot ?? ''}`.trim() }))
    : [];
  const boxed = [];
  for (const box of status?.pc?.boxes || []) {
    for (const mon of box.pokemon || []) {
      boxed.push({ ...mon, source: 'box', sourceLabel: `盒子 ${mon.box ?? box.index ?? '?'}-${mon.position ?? '?'}` });
    }
  }
  return [...party, ...boxed].map((mon) => {
    const key = monIdentity(mon, adapterId);
    return { ...mon, nuzlockeKey: key };
  });
}

// Locate an enriched mon in the latest status by its nuzlocke key, noting whether it
// lives in the party (so the caller knows it has a writable battle-stat block).
function findMonByKey(status, key) {
  const adapterId = status?.adapterId || DEFAULT_ADAPTER_ID;
  for (const mon of status?.party || []) {
    if (monIdentity(mon, adapterId) === key) return { mon, isParty: true };
  }
  for (const box of status?.pc?.boxes || []) {
    for (const mon of box.pokemon || []) {
      if (monIdentity(mon, adapterId) === key) return { mon, isParty: false };
    }
  }
  return null;
}

function syncNuzlockeMon(mon) {
  const now = new Date().toISOString();
  const hp = Number.isFinite(mon.hp) ? mon.hp : null;
  const record = nuzlockeState.mons[mon.nuzlockeKey] || { dead: false, previousHp: null };
  if (hp === 0 && (record.previousHp == null || record.previousHp > 0)) {
    record.dead = true;
    record.updatedAt = now;
  }
  if (hp != null) record.previousHp = hp;
  record.species = mon.speciesName || mon.species || record.species || null;
  record.nickname = mon.nickname || record.nickname || null;
  nuzlockeState.mons[mon.nuzlockeKey] = record;
  mon.dead = Boolean(record.dead);
  return mon;
}

function applyNuzlockeState(status) {
  if (!status) return status;
  let changed = false;
  for (const mon of collectPokemon(status)) {
    const before = JSON.stringify(nuzlockeState.mons[mon.nuzlockeKey] || null);
    syncNuzlockeMon(mon);
    const after = JSON.stringify(nuzlockeState.mons[mon.nuzlockeKey] || null);
    changed = changed || before !== after;
  }
  const applyToMon = (mon) => {
    const key = monIdentity(mon, status.adapterId || DEFAULT_ADAPTER_ID);
    const record = nuzlockeState.mons[key];
    mon.nuzlockeKey = key;
    mon.dead = Boolean(record?.dead);
    return mon;
  };
  status.party = Array.isArray(status.party) ? status.party.map(applyToMon) : [];
  if (status.pc?.boxes) {
    status.pc.boxes = status.pc.boxes.map((box) => ({
      ...box,
      pokemon: Array.isArray(box.pokemon) ? box.pokemon.map(applyToMon) : [],
    }));
  }
  if (changed) persistNuzlockeState();
  return status;
}

function buildNuzlockeView(status) {
  if (!status) return null;
  const pokemon = collectPokemon(status).map((mon) => syncNuzlockeMon(mon));
  const locationMap = new Map();
  for (const mon of pokemon) {
    const key = locationKey(mon);
    const label = locationLabel(mon);
    if (!key || !label) continue;
    if (!locationMap.has(key)) {
      const limit = Math.max(0, Number(nuzlockeState.locationLimits[key] ?? 1) || 0);
      locationMap.set(key, { key, label, limit, pokemon: [] });
    }
    locationMap.get(key).pokemon.push(mon);
  }

  const locations = Array.from(locationMap.values())
    .map((location) => ({
      ...location,
      count: location.pokemon.length,
      overLimit: location.pokemon.length > location.limit,
    }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));

  persistNuzlockeState();
  return {
    adapterId: status.adapterId,
    gameCode: status.gameCode,
    frame: status.frame,
    pokemon,
    locations,
  };
}

// ── state ─────────────────────────────────────────────────────────────────────

let latestRawPayload = null;
let latestStatus = null;
let latestReceivedAt = null;

function rebuildLatestStatus() {
  if (!latestRawPayload) return;
  latestStatus = applyNuzlockeState(enrichStatus(latestRawPayload));
}

function acceptParty(payload) {
  latestRawPayload = payload;
  rebuildLatestStatus();
  latestReceivedAt = new Date().toISOString();
  const summary = latestStatus.party
    .map((m) => `${m.slot}:${m.speciesName || m.species} Lv${m.level}`)
    .join(', ');
  console.log(`[${latestReceivedAt}] (${latestStatus.adapterId || 'unknown'}) ${summary}`);
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

function sendJson(res, status, payload, body) {
  const b = body ?? JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  });
  res.end(b);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) { reject(new Error('Request too large')); req.destroy(); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,authorization',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    sendJson(res, 200, {
      ok: true,
      httpPort: HTTP_PORT,
      tcpPort: TCP_PORT,
      defaultAdapterId: DEFAULT_ADAPTER_ID,
      latestReceivedAt,
      endpoints: {
        dashboard:    'GET  /dashboard',
        nuzlocke:     'GET  /nuzlocke',
        nuzlockeData: 'GET  /nuzlocke/status',
        nuzlockeMoves: 'GET  /nuzlocke/moves?species=',
        nuzlockeEdit: 'POST /nuzlocke/edit',
        obs:          'GET  /obs',
        status:       'GET  /status',
        latest:       'GET  /party/latest',
        receive:      'POST /party',
        translations: 'GET  /meta/translations',
        health:       'GET  /health',
      },
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/nuzlocke') {
    try {
      sendHtml(res, 200, fs.readFileSync(NUZLOCKE_PATH, 'utf8'));
    } catch {
      sendJson(res, 500, { ok: false, error: 'nuzlocke.html not found' });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/obs') {
    try {
      sendHtml(res, 200, fs.readFileSync(OBS_PATH, 'utf8'));
    } catch {
      sendJson(res, 500, { ok: false, error: 'obs.html not found' });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/dashboard') {
    try {
      sendHtml(res, 200, fs.readFileSync(DASHBOARD_PATH, 'utf8'));
    } catch {
      sendJson(res, 500, { ok: false, error: 'dashboard.html not found' });
    }
    return;
  }

  if (req.method === 'GET' && STATIC_PREFIXES.some((p) => url.pathname.startsWith(p))) {
    // Resolve under PUBLIC_DIR and reject anything that escapes it (path traversal).
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
      sendJson(res, 403, { ok: false, error: 'Forbidden' });
      return;
    }
    try {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'content-type': STATIC_CONTENT_TYPES[ext] || 'application/octet-stream',
        'cache-control': 'public, max-age=86400',
        'access-control-allow-origin': '*',
      });
      res.end(fs.readFileSync(filePath));
    } catch {
      sendJson(res, 404, { ok: false, error: 'Asset not found' });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true, latestReceivedAt });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/meta/translations') {
    try {
      const adapterId = url.searchParams.get('adapterId') || latestStatus?.adapterId || DEFAULT_ADAPTER_ID;
      const context = getAdapterContext(adapterId);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=3600',
      });
      res.end(context.translationsJson);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/sprite') {
    try {
      const adapterId = url.searchParams.get('adapterId') || latestStatus?.adapterId || DEFAULT_ADAPTER_ID;
      const speciesId = url.searchParams.get('species');
      const context = getAdapterContext(adapterId);
      const sprite = typeof context.adapter.getSprite === 'function'
        ? context.adapter.getSprite(speciesId)
        : null;
      if (sprite && sendPngDataUri(res, sprite)) return;

      const speciesRecord = lookupById(context.data.species, Number(speciesId));
      const speciesName = getRecordName(speciesRecord) || url.searchParams.get('speciesName') || '';
      const speciesKey = speciesRecord?.key || speciesName;
      const formName = speciesKey && speciesName && speciesKey !== speciesName
        ? speciesKey.slice(speciesName.length).replace(/^-/, '') || ''
        : (url.searchParams.get('formName') || '');
      const fallback = defaultSpriteUrl({ speciesName, formName });
      res.writeHead(302, { location: fallback, 'cache-control': 'public, max-age=3600' });
      res.end();
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/nuzlocke/status') {
    if (!latestStatus) {
      sendJson(res, 404, { ok: false, error: 'No status received yet' });
      return;
    }
    sendJson(res, 200, { ok: true, receivedAt: latestReceivedAt, data: buildNuzlockeView(latestStatus) });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/nuzlocke/moves') {
    try {
      const adapterId = url.searchParams.get('adapterId') || latestStatus?.adapterId || DEFAULT_ADAPTER_ID;
      const speciesId = url.searchParams.get('species');
      const context = getAdapterContext(adapterId);
      if (typeof context.adapter.getLearnableMoves !== 'function') {
        throw new Error('Adapter does not support move lookup');
      }
      const learnable = context.adapter.getLearnableMoves(speciesId);
      if (!learnable) {
        sendJson(res, 404, { ok: false, error: 'Unknown species' });
        return;
      }
      // Gameplay fields come from the adapter (the live ROM, including custom/tweaked
      // moves); the official table only supplies the Chinese name/description and fills
      // any field the adapter left null. type/category are emitted in Chinese for display.
      const decorate = (move) => {
        const info = context.moveInfo.get(move.name) || null;
        const prefer = (adapterValue, officialValue) => (adapterValue != null ? adapterValue : (officialValue ?? null));
        return {
          name: move.name,
          nameZh: info?.nameZh ?? null,
          type: (move.type != null ? (TYPE_NAMES_ZH[move.type] ?? move.type) : null) ?? info?.type ?? null,
          category: (move.category != null ? (MOVE_CATEGORY_ZH[move.category] ?? move.category) : null) ?? info?.category ?? null,
          power: prefer(move.power, info?.power),
          accuracy: prefer(move.accuracy, info?.accuracy),
          pp: prefer(move.pp, info?.pp),
          description: info?.description ?? move.description ?? null,
          ...(move.level != null ? { level: move.level } : {}),
        };
      };
      sendJson(res, 200, {
        ok: true,
        adapterId: context.adapter.id,
        species: Number(speciesId),
        levelUpMoves: learnable.levelUpMoves.map(decorate),
        tmMoves: learnable.tmMoves.map(decorate),
        tutorMoves: learnable.tutorMoves.map(decorate),
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/nuzlocke/mon') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body.key || typeof body.dead !== 'boolean') throw new Error('Expected { key, dead }');
      const now = new Date().toISOString();
      nuzlockeState.mons[body.key] = {
        ...(nuzlockeState.mons[body.key] || {}),
        dead: body.dead,
        updatedAt: now,
      };
      persistNuzlockeState();
      if (latestStatus) applyNuzlockeState(latestStatus);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/nuzlocke/location-limit') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      const limit = Number(body.limit);
      if (!body.key || !Number.isFinite(limit) || limit < 0) throw new Error('Expected { key, limit >= 0 }');
      nuzlockeState.locationLimits[body.key] = Math.floor(limit);
      persistNuzlockeState();
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/nuzlocke/growth-rate') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body.key) throw new Error('Expected { key, growthRateName }');
      const growthRateName = body.growthRateName == null ? null : canonicalGrowthRateName(String(body.growthRateName));
      if (growthRateName && !GROWTH_RATE_NAMES.includes(growthRateName)) {
        throw new Error(`Unknown growthRateName: ${body.growthRateName}`);
      }
      const now = new Date().toISOString();
      if (growthRateName) {
        nuzlockeState.growthRateOverrides[body.key] = growthRateName;
      } else {
        delete nuzlockeState.growthRateOverrides[body.key];
      }
      nuzlockeState.mons[body.key] = {
        ...(nuzlockeState.mons[body.key] || {}),
        growthRateOverride: growthRateName,
        updatedAt: now,
      };
      persistNuzlockeState();
      rebuildLatestStatus();
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/nuzlocke/edit') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body.key) throw new Error('Expected { key, changes }');
      if (!latestStatus) throw new Error('尚未收到任何状态');
      const adapterId = latestStatus.adapterId || DEFAULT_ADAPTER_ID;
      const found = findMonByKey(latestStatus, body.key);
      if (!found) throw new Error('找不到该宝可梦（可能已离开队伍/盒子）');
      const { mon, isParty } = found;
      const context = getAdapterContext(adapterId);
      const changes = body.changes || {};

      const clamp = (value, lo, hi, fallback) => {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(lo, Math.min(hi, Math.floor(n)));
      };
      const STAT6 = ['hp', 'attack', 'defense', 'speed', 'spAttack', 'spDefense'];

      const parts = [`personality=${mon.personality >>> 0}`, `otId=${mon.otId >>> 0}`];

      // EVs / IVs are always sent so a party mon's recomputed stat block stays consistent.
      const evs = {};
      const ivs = {};
      for (const stat of STAT6) {
        evs[stat] = clamp(changes.evs?.[stat] ?? mon.evs?.[stat] ?? 0, 0, 255, 0);
        ivs[stat] = clamp(changes.ivs?.[stat] ?? mon.ivs?.[stat] ?? 0, 0, 31, 0);
      }
      parts.push(`evHp=${evs.hp}`, `evAtk=${evs.attack}`, `evDef=${evs.defense}`,
        `evSpd=${evs.speed}`, `evSpAtk=${evs.spAttack}`, `evSpDef=${evs.spDefense}`);
      parts.push(`ivHp=${ivs.hp}`, `ivAtk=${ivs.attack}`, `ivDef=${ivs.defense}`,
        `ivSpd=${ivs.speed}`, `ivSpAtk=${ivs.spAttack}`, `ivSpDef=${ivs.spDefense}`);

      // Nature + ability slot fold into the personality value (and the hidden-ability bit).
      const targetNature = changes.nature != null
        ? clamp(changes.nature, 0, 24, mon.natureId ?? 0)
        : (mon.natureId ?? 0);
      let hiddenAbility = mon.hiddenAbility ? 1 : 0;
      let abilityBit = mon.abilityNum ? 1 : 0;
      if (changes.ability === 'hidden') hiddenAbility = 1;
      else if (changes.ability === 'first') { hiddenAbility = 0; abilityBit = 0; }
      else if (changes.ability === 'second') { hiddenAbility = 0; abilityBit = 1; }
      parts.push(`hiddenAbility=${hiddenAbility}`);
      const newPersonality = personalityForNatureAndAbility(mon.personality >>> 0, targetNature, abilityBit);
      if ((newPersonality >>> 0) !== (mon.personality >>> 0)) {
        parts.push(`set_personality=${newPersonality >>> 0}`);
      }

      // Level → experience (the actual stored field; level is derived from it on read).
      let targetLevel = Number.isInteger(mon.level) ? mon.level : null;
      if (changes.level != null) {
        targetLevel = clamp(changes.level, 1, 100, mon.level || 1);
        const growthRateName = resolveGrowthRateName(mon, context.growthRateData, adapterId);
        const exp = expForLevel(growthRateName, targetLevel);
        if (exp == null) throw new Error('无法推断该宝可梦的成长曲线，等级修改已跳过');
        parts.push(`experience=${exp}`);
      }

      if (changes.heldItem != null) parts.push(`heldItem=${clamp(changes.heldItem, 0, 65535, 0)}`);
      if (changes.friendship != null) parts.push(`friendship=${clamp(changes.friendship, 0, 255, 0)}`);

      // Party-only battle-stat block: recompute from the new level/EV/IV/nature so the
      // change is visible immediately. Lua ignores these fields for boxed mons.
      if (isParty && Number.isInteger(targetLevel)) {
        const speciesRecord = lookupById(context.data.species, mon.species);
        const calc = calculateStats({ ivs, evs, natureId: targetNature, level: targetLevel }, mon.baseStats, speciesRecord);
        parts.push(`level=${targetLevel}`);
        if (calc) {
          parts.push(`maxHp=${calc.maxHP}`, `hp=${calc.maxHP}`,
            `stAtk=${calc.stats.attack}`, `stDef=${calc.stats.defense}`, `stSpd=${calc.stats.speed}`,
            `stSpAtk=${calc.stats.spAttack}`, `stSpDef=${calc.stats.spDefense}`);
        }
      }

      const result = await sendEditCommand(parts);
      sendJson(res, 200, { ok: true, message: result.message || '', applied: parts });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/status' || url.pathname === '/party/latest')) {
    if (!latestStatus) {
      sendJson(res, 404, { ok: false, error: 'No status received yet' });
      return;
    }
    sendJson(res, 200, { ok: true, receivedAt: latestReceivedAt, data: latestStatus });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/party') {
    try {
      const body = await readBody(req);
      const payload = JSON.parse(body || '{}');
      acceptParty(payload.adapterId ? payload : resolveAdapterForPayload(payload).processPayload(payload));
      sendJson(res, 200, { ok: true, receivedAt: latestReceivedAt });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not found' });
});

// ── mGBA TCP bridge ──────────────────────────────────────────────────────────

const tcpSockets = new Set();

// ── edit (cheat) command channel ───────────────────────────────────────────────
// We push pipe-delimited EDIT commands back over the mGBA socket and correlate the
// Lua ACK reply by id. The Lua side does the memory writes; see party_export.lua.

const pendingEdits = new Map();
let editCommandSeq = 0;

function sendEditCommand(parts) {
  const sockets = [...tcpSockets];
  if (!sockets.length) return Promise.reject(new Error('mGBA 未连接（Lua 脚本未运行？）'));
  const id = String(++editCommandSeq);
  const line = ['EDIT', `id=${id}`, ...parts].join('|') + '\n';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingEdits.delete(id);
      reject(new Error('mGBA 未在超时内确认（命令可能仍已执行，请观察游戏）'));
    }, 2000);
    pendingEdits.set(id, { resolve, reject, timer });
    for (const socket of sockets) {
      try { socket.write(line); } catch { /* a dead socket will be cleaned up on close */ }
    }
  });
}

function handleEditAck(line) {
  const fields = {};
  for (const part of line.split('|')) {
    const eq = part.indexOf('=');
    if (eq > 0) fields[part.slice(0, eq)] = part.slice(eq + 1);
  }
  const pending = pendingEdits.get(fields.id);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingEdits.delete(fields.id);
  if (fields.ok === '1') pending.resolve({ ok: true, message: fields.msg || '' });
  else pending.reject(new Error(fields.msg || '修改失败'));
}

const tcpServer = net.createServer((socket) => {
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;
  tcpSockets.add(socket);
  console.log(`[tcp] connected ${remote}`);
  socket.setEncoding('utf8');
  let buffer = '';

  socket.on('data', (chunk) => {
    buffer += chunk;
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line) {
        if (line.startsWith('ACK|')) {
          handleEditAck(line);
        } else {
          try {
            const parsed = JSON.parse(line);
            acceptParty(resolveAdapterForPayload(parsed).processPayload(parsed));
          } catch (err) {
            console.error(`[tcp] invalid JSON: ${err.message}`);
          }
        }
      }
      idx = buffer.indexOf('\n');
    }
  });

  socket.on('close', () => {
    tcpSockets.delete(socket);
    console.log(`[tcp] disconnected ${remote}`);
  });
  socket.on('error', (err) => console.error(`[tcp] ${err.message}`));
});

httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
  console.log(`[server] HTTP listening on http://127.0.0.1:${HTTP_PORT}`);
});

tcpServer.listen(TCP_PORT, '127.0.0.1', () => {
  console.log(`[server] mGBA TCP listening on 127.0.0.1:${TCP_PORT} (${DEFAULT_ADAPTER_ID})`);
});

function closeServer(server) {
  return new Promise((resolve) => {
    server.close((error) => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
        console.error(`[shutdown] ${error.message}`);
      }
      resolve();
    });
  });
}

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] received ${signal}, shutting down...`);

  for (const socket of tcpSockets) {
    socket.destroy();
  }

  await Promise.all([closeServer(httpServer), closeServer(tcpServer)]);
  process.exit(0);
}

process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });
