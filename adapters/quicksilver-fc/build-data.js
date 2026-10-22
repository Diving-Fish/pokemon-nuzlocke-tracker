#!/usr/bin/env node
// Regenerates data/data.js and data/mapsec_table.json straight from a 宝可梦水银FC ROM.
//
//   node adapters/quicksilver-fc/build-data.js "<path to rom>.gba"
//
// 水银FC is a CFRU-based FireRed hack like Radical Red, but its species / move / ability
// tables, learnsets and map names all differ, and its species and move IDs are not
// aligned with Radical Red's. So gameplay fields are read from the ROM itself; Radical
// Red's data.js is only used to recover English names (the key the server translates
// with), form keys and sprites for species that exist in both games.
//
// Held items are copied from Radical Red by ID: this ROM obfuscates its item table, so
// held-item names may be off for items the hack added or renumbered.

const fs = require('fs');
const path = require('path');

const ROOT_DIR = __dirname;
const PROJECT_ROOT = path.join(ROOT_DIR, '..', '..');
const RR_DATA_JS_PATH = path.join(PROJECT_ROOT, 'adapters', 'radical-red', 'data', 'data.js');
const TRANSLATE_DIR = path.join(PROJECT_ROOT, 'server', 'data', 'translates');
const OUT_DATA_JS_PATH = path.join(ROOT_DIR, 'data', 'data.js');
const OUT_MAPSEC_PATH = path.join(ROOT_DIR, 'data', 'mapsec_table.json');

const ROM_BASE = 0x08000000;

// Offsets (vanilla FireRed code literal pools / the GameFreak ROM header) that hold a
// pointer to each table. CFRU repoints the tables but keeps these call sites, so they are
// stable across versions of the hack; the most common value among the sites wins.
const TABLE_SITES = {
  baseStats:    [0x1bc, 0x12754, 0x12fa8, 0x13230, 0x16a60, 0x1f008],
  speciesNames: [0x144, 0x11450, 0x1150c, 0x115a4, 0x116bc, 0x34d80],
  moveNames:    [0x308a4, 0x4ef84, 0x6be8c, 0x9b524, 0xbd830, 0xcc914],
  abilityNames: [0x1c0, 0xd8004, 0xd8624, 0x1367a0],
  moves:        [0x1cc, 0xe3d8, 0x128cc, 0x12ba4, 0x15060, 0x15fbc],
  learnsets:    [0x3ea7c, 0x3eb10, 0x3eb84, 0x43dc8, 0x43e20, 0x43f84],
  tmList:       [0x125a8c, 0x125aac],
  tutorList:    [0x120be4],
  tmCompat:     [0x43c68, 0x43c80],
  tutorCompat:  [0x120c30],
  evolutions:   [0x42f6c, 0x42fbc, 0x43138, 0x4599c, 0xce8c4],
  natdex:       [0x4323c, 0x432b0],
  eggMoves:     [0x45c50, 0x45cc8],
  mapNames:     [0xc0c94, 0xc4db8],
};

// GetMapName: `cmp r5, #N` bounds (mapsec - KANTO_MAPSEC_START) before indexing the table.
const MAP_NAME_BOUND_SITE = 0xc4d8a;
const KANTO_MAPSEC_START = 0x58;

const BASE_STATS_SIZE = 28;
const BATTLE_MOVE_SIZE = 12;
const COMPAT_SIZE = 16;          // 128 TM / tutor bits per species
const TM_COUNT = 128;
const TUTOR_COUNT = 128;
const EVOS_PER_MON = 16;
const EVO_SIZE = 8;
const EGG_MOVES_SPECIES_OFFSET = 20000; // gEggMoves: (species + 20000), moves..., ... 0xFFFF
const MAX_SPECIES = 2048;
const MAX_MOVES = 2048;
const MAX_ABILITIES = 512;

// ── text ─────────────────────────────────────────────────────────────────────
//
// The Chinese patch packs GB2312 hanzi densely into two-byte codes: lead byte 0x01-0x1E
// (0x06 is skipped) × low byte 0x00-0xF6, 247 characters per lead, in GB2312 order. Codes
// past the 6763 GB2312 hanzi are extra glyphs the translators appended; those are learned
// from known names (see learnExtraGlyphs). Everything else is the FireRed charset.

const CHARS_PER_LEAD = 247;
const HANZI = (() => {
  const decoder = new TextDecoder('gbk');
  const chars = [];
  for (let hi = 0xb0; hi <= 0xf7; hi++) {
    for (let lo = 0xa1; lo <= 0xfe; lo++) {
      if (hi === 0xd7 && lo >= 0xfa) continue; // unassigned in GB2312
      chars.push(decoder.decode(Uint8Array.from([hi, lo])));
    }
  }
  return chars;
})();

const FR_CHARS = {
  0x00: ' ', 0xab: '!', 0xac: '?', 0xad: '.', 0xae: '-', 0xaf: '・', 0xb0: '…',
  0xb1: '“', 0xb2: '”', 0xb3: '‘', 0xb4: '’', 0xb5: '♂', 0xb6: '♀', 0xb8: ',',
  0xba: '/', 0xf0: ':', 0x2d: '&', 0x5c: '(', 0x5d: ')',
};
for (let i = 0; i < 10; i++) FR_CHARS[0xa1 + i] = String(i);
for (let i = 0; i < 26; i++) {
  FR_CHARS[0xbb + i] = String.fromCharCode(65 + i);
  FR_CHARS[0xd5 + i] = String.fromCharCode(97 + i);
}

// Returns tokens: a string per decoded character, { code } for an unknown two-byte glyph,
// or { byte } for an unknown single byte (usually means this isn't text at all).
function readTokens(rom, offset, maxLength) {
  const tokens = [];
  const end = Math.min(rom.length, offset + maxLength);
  let terminated = false;
  for (let o = offset; o < end;) {
    const c = rom[o];
    if (c === 0xff) { terminated = true; break; }
    if (c >= 0x01 && c <= 0x1e && c !== 0x06 && o + 1 < end) {
      const low = rom[o + 1];
      const index = (c < 6 ? c - 1 : c - 2) * CHARS_PER_LEAD + low;
      tokens.push(low < CHARS_PER_LEAD && index < HANZI.length ? HANZI[index] : { code: (c << 8) | low });
      o += 2;
    } else {
      tokens.push(FR_CHARS[c] ?? { byte: c });
      o += 1;
    }
  }
  return { tokens, terminated };
}

function tokensToString(tokens, extraGlyphs) {
  return tokens.map((t) => {
    if (typeof t === 'string') return t;
    // An appended glyph no known name pinned down; show a box rather than raw codes.
    if (t.code != null) return extraGlyphs.get(t.code) ?? '□';
    return '□';
  }).join('');
}

function isCleanText({ tokens, terminated }) {
  return terminated && tokens.length > 0 && !tokens.some((t) => typeof t === 'object' && t.byte != null);
}

const containsChinese = (value) => /[㐀-鿿]/.test(value || '');
const containsKana = (value) => /[぀-ヿ]/.test(value || '');
const normalizeName = (value) => String(value || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, '');

// ── ROM access ───────────────────────────────────────────────────────────────

function createRom(buffer) {
  const isRomPointer = (value) => value >= ROM_BASE && value < ROM_BASE + buffer.length;
  const u16 = (o) => buffer.readUInt16LE(o);
  const u32 = (o) => buffer.readUInt32LE(o);

  function locate(name) {
    const counts = new Map();
    for (const site of TABLE_SITES[name]) {
      const value = u32(site);
      if (isRomPointer(value)) counts.set(value, (counts.get(value) || 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!best) throw new Error(`could not locate the ${name} table`);
    return best[0] - ROM_BASE;
  }

  // Names tables are fixed-width records; the width differs per table and per hack, so
  // pick the smallest width at which the first entries all decode as terminated text.
  function detectNameStride(base) {
    for (let stride = 7; stride <= 32; stride++) {
      let ok = true;
      for (let i = 1; i <= 80 && ok; i++) ok = isCleanText(readTokens(buffer, base + i * stride, stride));
      if (ok) return stride;
    }
    throw new Error(`could not detect name stride at 0x${base.toString(16)}`);
  }

  return { buffer, u16, u32, isRomPointer, locate, detectNameStride };
}

function readNameTable(rom, base, stride, maxCount) {
  const names = [];
  let misses = 0;
  for (let i = 0; i < maxCount && misses < 20; i++) {
    const text = readTokens(rom.buffer, base + i * stride, stride);
    if (isCleanText(text)) {
      names[i] = text.tokens;
      misses = 0;
    } else {
      names[i] = null;
      misses++;
    }
  }
  names.length = Math.max(0, names.length - misses);
  return names;
}

// ── translation tables (server/data/translates) ──────────────────────────────

function readTranslateLines(fileName) {
  return fs.readFileSync(path.join(TRANSLATE_DIR, fileName), 'utf8').split(/\r?\n/);
}

function loadSpeciesTranslations() {
  const enByDex = new Map();
  const zhByDex = new Map();
  for (const line of readTranslateLines('pokemons.txt')) {
    const cells = line.split('\t').map((c) => c.trim()).filter(Boolean);
    const match = /^#(\d+)/.exec(cells[0] || '');
    if (!match) continue;
    const dex = Number(match[1]);
    const kanaIndex = cells.findIndex((c) => containsKana(c));
    const zh = cells.find((c, i) => i > 0 && containsChinese(c) && !containsKana(c));
    const en = kanaIndex > 0 ? cells.slice(kanaIndex + 1).find((c) => /[A-Za-z]/.test(c)) : null;
    if (zh && !zhByDex.has(dex)) zhByDex.set(dex, zh);
    if (en && !enByDex.has(dex)) enByDex.set(dex, en);
  }
  return { enByDex, zhByDex };
}

// moves.txt / abilities.txt rows: 编号 中文名 日文名 英文名 ...
function loadNameTranslations(fileName) {
  const enByZh = new Map();
  const zhByEn = new Map();
  const zhByNumber = new Map();
  const enByNormalized = new Map();
  for (const line of readTranslateLines(fileName)) {
    const cells = line.split('\t').map((c) => c.trim());
    if (!/^\d+$/.test(cells[0] || '') || !cells[1] || !cells[3]) continue;
    if (!enByZh.has(cells[1])) enByZh.set(cells[1], cells[3]);
    if (!zhByEn.has(cells[3])) zhByEn.set(cells[3], cells[1]);
    if (!zhByNumber.has(Number(cells[0]))) zhByNumber.set(Number(cells[0]), cells[1]);
    enByNormalized.set(normalizeName(cells[3]), cells[3]);
  }
  return { enByZh, zhByEn, zhByNumber, enByNormalized };
}

// Fill in extra glyphs by lining names that contain them up against known Chinese names
// of the same length: a glyph is learned when exactly one candidate fits.
function learnExtraGlyphs(pairs, extraGlyphs) {
  let learned = true;
  while (learned) {
    learned = false;
    for (const { tokens, candidates } of pairs) {
      if (!tokens.some((t) => t?.code != null && !extraGlyphs.has(t.code))) continue;
      const fits = new Set();
      for (const candidate of candidates) {
        const chars = Array.from(candidate);
        if (chars.length !== tokens.length) continue;
        const assigned = new Map();
        const ok = tokens.every((t, i) => {
          if (typeof t === 'string') return t === chars[i];
          if (t.byte != null) return false;
          const known = extraGlyphs.get(t.code) ?? assigned.get(t.code);
          if (known != null) return known === chars[i];
          assigned.set(t.code, chars[i]);
          return true;
        });
        if (ok) fits.add(candidate);
      }
      if (fits.size !== 1) continue;
      const chars = Array.from([...fits][0]);
      tokens.forEach((t, i) => {
        if (t?.code != null && !extraGlyphs.has(t.code)) {
          extraGlyphs.set(t.code, chars[i]);
          learned = true;
        }
      });
    }
  }
}

// ── extraction ───────────────────────────────────────────────────────────────

function extractRom(romBuffer) {
  const rom = createRom(romBuffer);
  const { u16, buffer } = rom;
  const tables = Object.fromEntries(Object.keys(TABLE_SITES).map((name) => [name, rom.locate(name)]));

  const strides = {
    species: rom.detectNameStride(tables.speciesNames),
    moves: rom.detectNameStride(tables.moveNames),
    abilities: rom.detectNameStride(tables.abilityNames),
  };
  const speciesNames = readNameTable(rom, tables.speciesNames, strides.species, MAX_SPECIES);
  const moveNames = readNameTable(rom, tables.moveNames, strides.moves, MAX_MOVES);
  const abilityNames = readNameTable(rom, tables.abilityNames, strides.abilities, MAX_ABILITIES);

  const natdex = (speciesId) => (speciesId > 0 ? u16(tables.natdex + (speciesId - 1) * 2) : 0);

  // Egg moves are one flat u16 stream keyed by base species.
  const eggMovesBySpecies = new Map();
  for (let o = tables.eggMoves, current = null; o < buffer.length - 1; o += 2) {
    const value = u16(o);
    if (value === 0xffff) break;
    if (value > EGG_MOVES_SPECIES_OFFSET) {
      current = value - EGG_MOVES_SPECIES_OFFSET;
      if (!eggMovesBySpecies.has(current)) eggMovesBySpecies.set(current, []);
    } else if (current != null) {
      eggMovesBySpecies.get(current).push(value);
    }
  }

  const species = [];
  for (let id = 1; id < speciesNames.length; id++) {
    const nameTokens = speciesNames[id];
    if (!nameTokens) continue;
    const o = tables.baseStats + id * BASE_STATS_SIZE;
    const stats = [0, 1, 2, 3, 4, 5].map((i) => buffer[o + i]);
    if (stats.every((v) => v === 0)) continue;

    const learnsetPointer = rom.u32(tables.learnsets + id * 4);
    const levelupMoves = [];
    if (rom.isRomPointer(learnsetPointer)) {
      for (let p = learnsetPointer - ROM_BASE, n = 0; n < 128; p += 3, n++) {
        const move = u16(p);
        const level = buffer[p + 2];
        if (move === 0xffff || (move === 0 && level === 0xff)) break;
        levelupMoves.push([move, level]);
      }
    }

    const bitsOf = (base) => {
      const set = [];
      for (let bit = 0; bit < COMPAT_SIZE * 8; bit++) {
        if (buffer[base + id * COMPAT_SIZE + (bit >> 3)] & (1 << (bit & 7))) set.push(bit);
      }
      return set;
    };

    const evolutions = [];
    for (let e = 0; e < EVOS_PER_MON; e++) {
      const eo = tables.evolutions + id * EVOS_PER_MON * EVO_SIZE + e * EVO_SIZE;
      const entry = [u16(eo), u16(eo + 2), u16(eo + 4), u16(eo + 6)];
      if (entry[0] !== 0) evolutions.push(entry);
    }

    // Same conventions as Radical Red's data.js: a mono-type is a single entry, and an
    // ability slot that repeats an earlier one is dropped.
    const [type1, type2] = [buffer[o + 6], buffer[o + 7]];
    const [ability1, ability2, hidden] = [buffer[o + 22], buffer[o + 23], buffer[o + 26]];
    species.push({
      id,
      nameTokens,
      dex: natdex(id),
      stats,
      type: type1 === type2 ? [type1] : [type1, type2],
      items: [u16(o + 12), u16(o + 14)],
      // 0 always male, 254 always female, 255 genderless; else female when (personality & 0xFF) < ratio
      genderRatio: buffer[o + 16],
      growthRate: buffer[o + 19],
      eggGroup: [buffer[o + 20], buffer[o + 21]],
      // data.js convention: [hidden, first, second]
      abilities: [
        [hidden === ability1 || hidden === ability2 ? 0 : hidden, 0],
        [ability1, 0],
        [ability2 === ability1 ? 0 : ability2, 0],
      ],
      levelupMoves,
      tmMoves: bitsOf(tables.tmCompat),
      tutorMoves: bitsOf(tables.tutorCompat),
      eggMoves: eggMovesBySpecies.get(id) || [],
      evolutions,
    });
  }

  const moves = [];
  for (let id = 1; id < moveNames.length; id++) {
    if (!moveNames[id]) continue;
    const o = tables.moves + id * BATTLE_MOVE_SIZE;
    moves.push({
      id,
      nameTokens: moveNames[id],
      power: buffer[o + 1],
      type: buffer[o + 2],
      accuracy: buffer[o + 3],
      pp: buffer[o + 4],
      secondaryEffectChance: buffer[o + 5],
      target: buffer[o + 6],
      priority: (buffer[o + 7] << 24) >> 24,
      split: buffer[o + 10],
    });
  }

  const abilities = [];
  for (let id = 1; id < abilityNames.length; id++) {
    if (abilityNames[id]) abilities.push({ id, nameTokens: abilityNames[id] });
  }

  const tmList = Array.from({ length: TM_COUNT }, (_, i) => u16(tables.tmList + i * 2));
  const tutorList = Array.from({ length: TUTOR_COUNT }, (_, i) => u16(tables.tutorList + i * 2));

  // GetMapName only accepts indices up to the bound in its `cmp rX, #N`.
  const boundInsn = buffer.readUInt16LE(MAP_NAME_BOUND_SITE);
  if ((boundInsn >> 11) !== 0b00101) throw new Error('GetMapName bound check not found');
  const mapNameCount = (boundInsn & 0xff) + 1;
  const mapNames = [];
  for (let i = 0; i < mapNameCount; i++) {
    const pointer = rom.u32(tables.mapNames + i * 4);
    if (!rom.isRomPointer(pointer)) continue;
    const text = readTokens(buffer, pointer - ROM_BASE, 64);
    if (isCleanText(text)) mapNames.push({ mapsec: KANTO_MAPSEC_START + i, tokens: text.tokens });
  }

  return { tables, strides, species, moves, abilities, tmList, tutorList, mapNames };
}

// ── assembling data.js ───────────────────────────────────────────────────────

function loadRrData() {
  const source = fs.readFileSync(RR_DATA_JS_PATH, 'utf8');
  return Function(`"use strict"; return (${source});`)();
}

function buildData(extracted, rrData) {
  const { enByDex, zhByDex } = loadSpeciesTranslations();
  const moveNames = loadNameTranslations('moves.txt');
  const abilityNames = loadNameTranslations('abilities.txt');
  const report = { unresolvedMoves: [], unresolvedAbilities: [], speciesWithoutSprite: [] };

  // Species: match each ROM species to the Radical Red record of the same national dex
  // number (same types first, then closest base stats, then same internal ID) to borrow
  // its English name, form key and sprite.
  const rrByDex = new Map();
  for (const record of Object.values(rrData.species)) {
    if (!rrByDex.has(record.dexID)) rrByDex.set(record.dexID, []);
    rrByDex.get(record.dexID).push(record);
  }
  const statDistance = (a, b) => a.reduce((sum, v, i) => sum + Math.abs(v - (b?.[i] ?? 0)), 0);
  const sameTypes = (a, b) => Array.isArray(b) && a.length === b.length && a.every((t, i) => t === b[i]);
  const rrMatch = new Map();
  for (const s of extracted.species) {
    const ranked = (s.dex ? (rrByDex.get(s.dex) || []) : [])
      .map((r) => ({ r, key: [sameTypes(s.type, r.type) ? 1 : 0, -statDistance(s.stats, r.stats), r.ID === s.id ? 1 : 0] }))
      .sort((x, y) => y.key[0] - x.key[0] || y.key[1] - x.key[1] || y.key[2] - x.key[2]);
    if (ranked[0]) rrMatch.set(s.id, ranked[0].r);
  }

  // For each ROM ability ID, the English ability sets of the matched RR species that carry
  // it. Ability IDs don't follow the official numbering, so this is the best evidence of
  // what an ability is when its Chinese name doesn't match the translation table.
  const abilityEvidence = new Map();
  for (const s of extracted.species) {
    const rr = rrMatch.get(s.id);
    if (!rr) continue;
    const rrNames = new Set((rr.abilities || []).map(([id]) => rrData.abilities[String(id)]?.names?.[0]).filter(Boolean));
    for (const [id] of s.abilities) {
      if (!id) continue;
      if (!abilityEvidence.has(id)) abilityEvidence.set(id, []);
      abilityEvidence.get(id).push(rrNames);
    }
  }

  // Learn the appended glyphs first so every name below decodes fully. The precise pass
  // pairs each name with its likely official counterparts (same dex / official number /
  // Radical Red's name for the same ID / abilities of species carrying it); the broad pass
  // tries every known name.
  const extraGlyphs = new Map();
  const officialCandidates = (tables, id, rrName) => [tables.zhByNumber.get(id), tables.zhByEn.get(rrName)].filter(Boolean);
  const evidenceCandidates = (id) => [...new Set((abilityEvidence.get(id) || []).flatMap((set) => [...set]))]
    .map((en) => abilityNames.zhByEn.get(en)).filter(Boolean);
  learnExtraGlyphs([
    ...extracted.species.map((s) => ({ tokens: s.nameTokens, candidates: [zhByDex.get(s.dex)].filter(Boolean) })),
    ...extracted.moves.map((m) => ({ tokens: m.nameTokens, candidates: officialCandidates(moveNames, m.id, rrData.moves[String(m.id)]?.name) })),
    ...extracted.abilities.map((a) => ({ tokens: a.nameTokens, candidates: officialCandidates(abilityNames, a.id, rrData.abilities[String(a.id)]?.names?.[0]) })),
    ...extracted.abilities.map((a) => ({ tokens: a.nameTokens, candidates: evidenceCandidates(a.id) })),
  ], extraGlyphs);
  // Each move / ability name occurs once, so names the ROM already spells out in full are
  // not candidates for the ones still missing glyphs.
  const unusedNames = (tables, entries) => {
    const present = new Set(entries.map((e) => tokensToString(e.nameTokens, extraGlyphs)));
    return [...tables.enByZh.keys()].filter((zh) => !present.has(zh));
  };
  const allSpeciesZh = [...zhByDex.values()];
  const unusedMoveZh = unusedNames(moveNames, extracted.moves);
  const unusedAbilityZh = unusedNames(abilityNames, extracted.abilities);
  learnExtraGlyphs([
    ...extracted.species.map((s) => ({ tokens: s.nameTokens, candidates: allSpeciesZh })),
    ...extracted.moves.map((m) => ({ tokens: m.nameTokens, candidates: unusedMoveZh })),
    ...extracted.abilities.map((a) => ({ tokens: a.nameTokens, candidates: unusedAbilityZh })),
  ], extraGlyphs);
  const text = (tokens) => tokensToString(tokens, extraGlyphs);

  // Chinese ROM name → English name the server's translation tables know. Names the ROM
  // left untranslated are English already (possibly with typographic apostrophes).
  const resolveEnglish = (zh, tables, fallback) => {
    if (!containsChinese(zh)) {
      const known = tables.enByNormalized.get(normalizeName(zh));
      if (known) return known;
    }
    return tables.enByZh.get(zh) ?? fallback?.() ?? null;
  };
  // The ROM sometimes uses an older translation (漂浮 for 飘浮, 技师 for 技术高手). IDs mostly
  // line up with Radical Red's, so accept RR's name for the same ID when its official
  // Chinese name shares a character with the ROM's.
  const sharesHanzi = (a, b) => Array.from(a || '').some((ch) => containsChinese(ch) && (b || '').includes(ch));
  const sameIdRrName = (rrName, zh, tables) => (rrName && sharesHanzi(zh, tables.zhByEn.get(rrName)) ? rrName : null);

  const rrMoveEnByNormalized = new Map(Object.values(rrData.moves).map((m) => [normalizeName(m.name), m.name]));
  const moves = {};
  for (const m of extracted.moves) {
    const zh = text(m.nameTokens);
    const rr = rrData.moves[String(m.id)];
    const sameAsRr = rr && rr.power === m.power && rr.type === m.type && rr.accuracy === m.accuracy
      && rr.pp === m.pp && rr.split === m.split;
    let name = resolveEnglish(zh, moveNames, () => rrMoveEnByNormalized.get(normalizeName(zh))
      ?? (sameAsRr ? rr.name : null) ?? sameIdRrName(rr?.name, zh, moveNames));
    if (!name) {
      report.unresolvedMoves.push(`${m.id}:${zh}`);
      name = zh;
    }
    const rrByName = Object.values(rrData.moves).find((r) => r.name === name);
    moves[m.id] = {
      ID: m.id,
      name,
      power: m.power,
      type: m.type,
      accuracy: m.accuracy,
      pp: m.pp,
      secondaryEffectChance: m.secondaryEffectChance,
      target: m.target,
      priority: m.priority,
      split: m.split,
      description: rrByName?.description ?? null,
    };
  }

  // Last resort: the ability most RR counterparts of the species carrying this ability
  // share. Radical Red rebalanced abilities too, so require a clear, unique majority.
  const evidenceName = (id) => {
    const sets = abilityEvidence.get(id) || [];
    const votes = new Map();
    for (const set of sets) for (const en of set) votes.set(en, (votes.get(en) || 0) + 1);
    const [best, runnerUp] = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    if (!best || best[1] < 2 || best[1] * 2 < sets.length || (runnerUp && runnerUp[1] === best[1])) return null;
    return best[0];
  };
  const rrAbilityByName = new Map(Object.values(rrData.abilities).map((a) => [a.names?.[0], a]));
  const abilities = {};
  const resolvedAbilities = extracted.abilities.map((a) => {
    const zh = text(a.nameTokens);
    return { a, zh, name: resolveEnglish(zh, abilityNames, () => sameIdRrName(rrData.abilities[String(a.id)]?.names?.[0], zh, abilityNames)) };
  });
  const takenAbilityNames = new Set(resolvedAbilities.map((r) => r.name).filter(Boolean));
  for (const { a, zh, name: resolved } of resolvedAbilities) {
    let name = resolved;
    if (!name) {
      const guess = evidenceName(a.id);
      if (guess && !takenAbilityNames.has(guess)) name = guess;
    }
    if (!name) {
      report.unresolvedAbilities.push(`${a.id}:${zh}`);
      name = zh;
    }
    abilities[a.id] = { ID: a.id, names: [name], description: rrAbilityByName.get(name)?.description ?? '' };
  }

  const species = {};
  const sprites = {};
  if (rrData.sprites?.['0']) sprites['0'] = rrData.sprites['0'];
  for (const s of extracted.species) {
    const zh = text(s.nameTokens);
    const match = rrMatch.get(s.id) ?? null;
    const name = match?.name ?? enByDex.get(s.dex) ?? zh;
    species[s.id] = {
      ID: s.id,
      name,
      nameZh: zh,
      stats: s.stats,
      type: s.type,
      abilities: s.abilities,
      eggGroup: s.eggGroup,
      items: s.items,
      genderRatio: s.genderRatio,
      growthRate: s.growthRate,
      levelupMoves: s.levelupMoves,
      evolutions: s.evolutions,
      tmMoves: s.tmMoves,
      tutorMoves: s.tutorMoves,
      eggMoves: s.eggMoves,
      key: match?.key ?? name,
      dexID: s.dex || null,
      order: match?.order ?? 0,
    };
    const sprite = match ? rrData.sprites?.[String(match.ID)] : null;
    if (sprite) sprites[s.id] = sprite;
    else report.speciesWithoutSprite.push(`${s.id}:${zh}`);
  }

  const mapsecTable = Object.fromEntries(extracted.mapNames.map((m) => [String(m.mapsec), text(m.tokens)]));

  const data = {
    species,
    moves,
    tmMoves: Object.fromEntries(extracted.tmList.map((move, i) => [i, move])),
    tutorMoves: Object.fromEntries(extracted.tutorList.map((move, i) => [i, move])),
    types: rrData.types,
    abilities,
    items: rrData.items,
    natures: rrData.natures,
    eggGroups: rrData.eggGroups,
    splits: rrData.splits,
    evolutions: rrData.evolutions,
    sprites,
  };
  return { data, mapsecTable, report, extraGlyphs };
}

function main() {
  const romPath = process.argv[2];
  if (!romPath) {
    console.error('usage: node adapters/quicksilver-fc/build-data.js <rom.gba>');
    process.exit(1);
  }
  const extracted = extractRom(fs.readFileSync(romPath));
  const { data, mapsecTable, report, extraGlyphs } = buildData(extracted, loadRrData());

  fs.mkdirSync(path.dirname(OUT_DATA_JS_PATH), { recursive: true });
  fs.writeFileSync(OUT_DATA_JS_PATH, JSON.stringify(data), 'utf8');
  fs.writeFileSync(OUT_MAPSEC_PATH, `${JSON.stringify(mapsecTable, null, 2)}\n`, 'utf8');

  const hex = (v) => `0x${(v + ROM_BASE).toString(16)}`;
  console.log('tables:', Object.fromEntries(Object.entries(extracted.tables).map(([k, v]) => [k, hex(v)])));
  console.log('name strides:', extracted.strides);
  console.log(`species ${Object.keys(data.species).length}, moves ${Object.keys(data.moves).length}, `
    + `abilities ${Object.keys(data.abilities).length}, map names ${Object.keys(mapsecTable).length}, `
    + `sprites ${Object.keys(data.sprites).length}, extra glyphs learned ${extraGlyphs.size}`);
  const list = (label, items) => console.log(`${label} (${items.length}): ${items.slice(0, 40).join(' ')}${items.length > 40 ? ' …' : ''}`);
  list('moves without an English name', report.unresolvedMoves);
  list('abilities without an English name', report.unresolvedAbilities);
  list('species without a sprite', report.speciesWithoutSprite);
  console.log(`wrote ${path.relative(PROJECT_ROOT, OUT_DATA_JS_PATH)} and ${path.relative(PROJECT_ROOT, OUT_MAPSEC_PATH)}`);
}

module.exports = { extractRom, buildData, loadRrData };

if (require.main === module) main();
