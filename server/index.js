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
const NUZLOCKE_STATE_PATH = path.join(PROJECT_ROOT, '.game', 'nuzlocke-state.json');

const ADAPTERS = new Map([
  ['radical-red', require(path.join(PROJECT_ROOT, 'adapters', 'radical-red'))],
]);
const DEFAULT_ADAPTER_ID = process.env.ADAPTER_ID || 'radical-red';

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
      acceptParty(payload.adapterId ? payload : getAdapter(DEFAULT_ADAPTER_ID).processPayload(payload));
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

const tcpServer = net.createServer((socket) => {
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;
  const adapter = getAdapter(DEFAULT_ADAPTER_ID);
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
        try {
          acceptParty(adapter.processPayload(JSON.parse(line)));
        } catch (err) {
          console.error(`[tcp] invalid JSON: ${err.message}`);
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
