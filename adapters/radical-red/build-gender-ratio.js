#!/usr/bin/env node
// Writes data/gender_ratio.json ({ speciesId: genderRatio }) from a Radical Red ROM. data.js
// has no gender field, and pokeapi's gender rates miss Radical Red's separate gender forms
// (Meowstic-F, Pyroar-F, Jellicent-F, ...), so the ratio comes from the ROM's base stats.
//
//   node adapters/radical-red/build-gender-ratio.js "<path to rom>.gba"
//
// Base stats are the vanilla 28-byte FireRed struct with genderRatio at +16: 0 always male,
// 254 always female, 255 genderless, otherwise female when (personality & 0xFF) < ratio.
// The table is located like quicksilver-fc/build-data.js does: CFRU repoints it but keeps
// FireRed's literal-pool call sites, so the most common pointer among them wins.

const fs = require('fs');
const path = require('path');

const ROM_BASE = 0x08000000;
const BASE_STATS_SITES = [0x1bc, 0x12754, 0x12fa8, 0x13230, 0x16a60, 0x1f008];
const BASE_STATS_SIZE = 28;
const GENDER_RATIO_OFFSET = 16;

const romPath = process.argv[2];
if (!romPath) {
  console.error('usage: node adapters/radical-red/build-gender-ratio.js <rom.gba>');
  process.exit(1);
}

const rom = fs.readFileSync(romPath);
const counts = new Map();
for (const site of BASE_STATS_SITES) {
  const value = rom.readUInt32LE(site);
  if (value >= ROM_BASE && value - ROM_BASE < rom.length) counts.set(value, (counts.get(value) || 0) + 1);
}
const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
if (!best) throw new Error('could not locate the base stats table');
const baseStats = best[0] - ROM_BASE;

const dataDir = path.join(__dirname, 'data');
const data = Function(`"use strict"; return (${fs.readFileSync(path.join(dataDir, 'data.js'), 'utf8')});`)();
const ratios = {};
for (const id of Object.keys(data.species)) {
  ratios[id] = rom[baseStats + Number(id) * BASE_STATS_SIZE + GENDER_RATIO_OFFSET];
}
const out = path.join(dataDir, 'gender_ratio.json');
fs.writeFileSync(out, JSON.stringify(ratios));
console.log(`base stats at 0x${baseStats.toString(16)}; wrote ${Object.keys(ratios).length} species to ${path.relative(process.cwd(), out)}`);
