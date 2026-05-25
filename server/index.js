const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

const HTTP_PORT = Number(process.env.HTTP_PORT || 8787);
const TCP_PORT = Number(process.env.TCP_PORT || 8765);
const ROOT_DIR = __dirname;
const PROJECT_ROOT = path.resolve(ROOT_DIR, '..');
const DASHBOARD_PATH = path.join(ROOT_DIR, 'public', 'dashboard.html');

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

function readText(relativePath) {
  try {
    return fs.readFileSync(path.join(ROOT_DIR, relativePath), 'utf8');
  } catch {
    return '';
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
    const data = loadJsonFile(adapter.dataPath, {});
    const translations = buildTranslations(data);
    adapterCache.set(adapter.id, {
      adapter,
      data,
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
  const standardIndex = standardSlot === 1 && abilityGroups[2] ? 2 : 1;
  const group = mon.hiddenAbility ? hiddenGroup : (abilityGroups[standardIndex] || abilityGroups[1] || hiddenGroup);
  const abilityId = Array.isArray(group) ? group.find((id) => id) : group;
  const abilityName = getRecordName(lookupById(data.abilities, abilityId));

  const abilityCandidates = abilityGroups
    .map((g, idx) => {
      const candidateId = Array.isArray(g) ? g.find((id) => id) : g;
      const candidateName = getRecordName(lookupById(data.abilities, candidateId));
      if (!candidateId || !candidateName) return null;
      const slot = idx === 0 ? 'hidden' : idx === 1 ? 'first' : 'second';
      return { slot, abilityId: candidateId, abilityName: candidateName };
    })
    .filter(Boolean);

  return { abilityId: abilityId || null, abilityName, abilityCandidates };
}

function enrichMon(mon, data) {
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

  return {
    ...mon,
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
  };
}

function enrichPc(pc, data) {
  if (!pc || !Array.isArray(pc.boxes)) return pc ?? null;
  return {
    ...pc,
    boxes: pc.boxes.map((box) => ({
      ...box,
      pokemon: Array.isArray(box.pokemon) ? box.pokemon.map((mon) => enrichMon(mon, data)) : [],
    })),
  };
}

function enrichStatus(payload) {
  if (!payload || !Array.isArray(payload.party)) return payload;
  const context = getAdapterContext(payload.adapterId || DEFAULT_ADAPTER_ID);
  return {
    ...payload,
    adapterId: context.adapter.id,
    party: payload.party.map((mon) => enrichMon(mon, context.data)),
    pc: enrichPc(payload.pc, context.data),
  };
}

// ── state ─────────────────────────────────────────────────────────────────────

let latestStatus = null;
let latestReceivedAt = null;

function acceptParty(payload) {
  latestStatus = enrichStatus(payload);
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
        status:       'GET  /status',
        latest:       'GET  /party/latest',
        receive:      'POST /party',
        translations: 'GET  /meta/translations',
        health:       'GET  /health',
      },
    });
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
