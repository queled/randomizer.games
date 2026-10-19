#!/usr/bin/env node
/**
 * Download the seed hash icons of every game from racetime.gg
 *
 * Each racetime.gg category lists its emotes (/<category>/data). Those of the
 * seed hash (HashGoldScale, HashCape, NoteA...) are saved under
 * public/assets/hash/<game id>/<emote>.<ext>, named after the emote, and
 * listed in public/data/hash-icons.json, which race pages read to show the
 * icons in place of the words. Chat emotes are left out. The categories of a
 * game (integrations.racetime.gameSlug / gameSlugs) share its icons.
 *
 * Games whose hash is a few words (enemy or character names...) have their
 * list in data/hash-sets/<game id>.json, taken from the randomizer's source:
 * word -> source page of its image, saved as public/assets/hash/<game id>/<word>.png,
 * or null when nothing shows it (the word stays as text among the icons).
 *
 * Usage:
 *   node scripts/sync-hash-icons.js
 *   node scripts/sync-hash-icons.js --force    # download the images again
 *   node scripts/sync-hash-icons.js --dry-run
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const connectDB = require('../config/database');
const { Race, Game } = require('../models');

const ICONS_DIR = path.join(__dirname, '..', 'public', 'assets', 'hash');
const MANIFEST = path.join(__dirname, '..', 'public', 'data', 'hash-icons.json');
const HASH_SETS_DIR = path.join(__dirname, '..', 'data', 'hash-sets');
const DELAY_MS = 300;

// Which emotes of a game are hash icons, by game id. Most categories prefix them
// (HashX, and NoteX for the OoTR ocarina password); a few name them after the item.
const HASH_EMOTE = /^(Hash|Note)[A-Z]/;
const ICON_RULES = {
  dk64: () => true,
  z1: (name) => !['Link', 'OldMan', 'Merchant'].includes(name)
};

// Other spellings of the hash items found in race infos, kept to the item they
// name without doubt. Matched without case.
const ALTTPR_ALIASES = {
  'Big Key': 'HashBigKey', BigKey: 'HashBigKey',
  'Ice Rod': 'HashIceRod', IceRod: 'HashIceRod',
  'Magic Powder': 'HashMagicPowder', Powder: 'HashMagicPowder',
  'Empty Bottle': 'HashEmptyBottle', EmptyBottle: 'HashEmptyBottle', Bottle: 'HashEmptyBottle',
  'Green Potion': 'HashGreenPotion', GreenPotion: 'HashGreenPotion',
  'Moon Pearl': 'HashMoonPearl', MoonPearl: 'HashMoonPearl', Pearl: 'HashMoonPearl',
  'Bug Net': 'HashBugnet', BugNet: 'HashBugnet',
  Cane: 'HashSomaria', Ocarina: 'HashFlute', Glove: 'HashGloves', Bomb: 'HashBombs',
  Shroom: 'HashMushroom', BK: 'HashBigKey',
  // French community races
  Livre: 'HashBook', Poudre: 'HashMagicPowder', 'Bouteille vide': 'HashEmptyBottle',
  Bouteille: 'HashEmptyBottle', Flacon: 'HashEmptyBottle', 'Pendentif vert': 'HashPendant',
  Pendentif: 'HashPendant', Boussole: 'HashCompass', Arc: 'HashBow', Champignon: 'HashMushroom',
  Marteau: 'HashHammer', Pelle: 'HashShovel', Lampe: 'HashLamp', Lanterne: 'HashLamp',
  Bottes: 'HashBoots', Palmes: 'HashFlippers', Carte: 'HashMap', Grappin: 'HashHookshot',
  Gants: 'HashGloves', 'Cœur': 'HashHeart', Coeur: 'HashHeart', 'Flûte': 'HashFlute',
  Bouclier: 'HashShield', Tunique: 'HashTunic', Miroir: 'HashMirror',
  'Perle de lune': 'HashMoonPearl', Perle: 'HashMoonPearl', 'Potion verte': 'HashGreenPotion',
  Filet: 'HashBugnet', 'Baguette de glace': 'HashIceRod', 'Grande clé': 'HashBigKey', Bombes: 'HashBombs'
};
// The plain item names (Bow, Lens Of Truth...) of the Hash emotes are added by buildAliases
const ALIASES = {
  alttp: ALTTPR_ALIASES,
  oot: {
    'Megaton Hammer': 'HashHammer', 'Silver Gauntlets': 'HashSilvers', 'Heart Container': 'HashHeart',
    Stick: 'HashDekuStick', Nut: 'HashDekuNut', Agony: 'HashStoneOfAgony', Ocarina: 'HashFairyOcarina',
    Lens: 'HashLensOfTruth', Chu: 'HashBombchu', Skull: 'HashSkullToken'
  },
  mm: {
    'Gold Dust Bottle': 'HashGoldDust', 'Hot Spring Water': 'HashHotWater', 'Ocarina of Time': 'HashOcarina',
    'Fire Arrows': 'HashFireArrow', 'Ice Arrows': 'HashIceArrow', 'Light Arrows': 'HashLightArrow',
    'Don Gero': 'HashDonGeroMask', 'Big Poe Bottle': 'HashBigPoe', 'Mushroom Bottle': 'HashMushroom',
    Bombchus: 'HashBombchu', 'Great Fairy Sword': 'HashGFS'
  },
  z1: {
    Meat: 'Bait', WoodSword: 'WoodenSword', 'Wood Sword': 'WoodenSword',
    Bomb: 'Bombs', Arrow: 'WoodenArrow', PB: 'PowerBracelet',
    'Power Bracelet': 'PowerBracelet', AnyKey: 'MagicKey', Mags: 'MagicSword',
    WoodenBoomer: 'Boomerang', Whistle: 'Recorder', Shield: 'MagicShield'
  },
  dk64: {
    Sax: 'Saxophone', 'Nintendo Coin': 'NintendoCoin', 'Rareware Coin': 'RarewareCoin',
    'Rainbow Coin': 'RainbowCoin', Rainbow: 'RainbowCoin', 'Race Coin': 'RaceCoin',
    'Rare Coin': 'RarewareCoin', Rareware: 'RarewareCoin', 'Nint Coin': 'NintendoCoin',
    NinCoin: 'NintendoCoin', Oranges: 'Orange'
  }
};
// Games where the item names of the HashX emotes (Cape, Lens Of Truth) are written too
const PLAIN_NAMES = ['alttp', 'oot', 'mm'];

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    force: args.includes('--force'),
    dryRun: args.includes('--dry-run')
  };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchEmotes(category) {
  const res = await fetch(`https://racetime.gg/${encodeURIComponent(category)}/data`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.emotes || {};
}

function isHashEmote(gameId, name) {
  const rule = ICON_RULES[gameId];
  return rule ? rule(name) : HASH_EMOTE.test(name);
}

function buildAliases(gameId, files) {
  const aliases = {};
  if (PLAIN_NAMES.includes(gameId)) {
    for (const name of Object.keys(files)) {
      if (!name.startsWith('Hash')) continue;
      const plain = name.slice(4);
      aliases[plain] = name;
      // GoldScale -> Gold Scale
      const spaced = plain.replace(/([a-z])([A-Z])/g, '$1 $2');
      if (spaced !== plain) aliases[spaced] = name;
    }
  }
  for (const [alias, name] of Object.entries(ALIASES[gameId] || {})) {
    if (files[name] && !files[alias]) aliases[alias] = name;
  }
  return aliases;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

// racetime.gg category -> game id, for the categories of the races in the database
async function loadCategoryGames() {
  await connectDB();
  try {
    const categories = (await Race.distinct('category')).filter(Boolean);
    const games = await Game.find({}, { id: 1, 'integrations.racetime': 1 }).lean();
    const gameBySlug = {};
    for (const game of games) {
      const rt = game.integrations?.racetime || {};
      for (const slug of [rt.gameSlug, ...(rt.gameSlugs || [])]) {
        if (slug) gameBySlug[String(slug).toLowerCase()] = game.id;
      }
    }
    return categories.sort().map(category => ({ category, gameId: gameBySlug[category.toLowerCase()] || null }));
  } finally {
    await mongoose.disconnect();
  }
}

// Word lists of data/hash-sets, merged with the racetime.gg emotes of the same game.
// A set can include other sets (a game mixing the words of two games): their
// icons stay in their own folder and are listed as "<set id>/<word>.png".
function loadHashSets() {
  if (!fs.existsSync(HASH_SETS_DIR)) return {};
  const sets = {};
  for (const file of fs.readdirSync(HASH_SETS_DIR).filter(f => f.endsWith('.json')).sort()) {
    sets[file.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(HASH_SETS_DIR, file), 'utf8'));
  }
  return sets;
}

// word -> icon file (relative to the game's folder, or "<set id>/<file>"), and words without one
function resolveHashSet(sets, setId, gameId, seen = new Set()) {
  const set = sets[setId];
  const result = { icons: {}, words: new Set(), aliases: {} };
  if (!set || seen.has(setId)) return result;
  seen.add(setId);
  for (const other of set.include || []) {
    const sub = resolveHashSet(sets, other, gameId, seen);
    Object.assign(result.icons, sub.icons);
    sub.words.forEach(w => result.words.add(w));
    Object.assign(result.aliases, sub.aliases);
  }
  for (const [word, source] of Object.entries(set.words || {})) {
    const iconFile = word + '.png';
    if (source && fs.existsSync(path.join(ICONS_DIR, setId, iconFile))) {
      result.icons[word] = setId === gameId ? iconFile : `${setId}/${iconFile}`;
      result.words.delete(word);
    } else {
      if (source) console.warn(`  ⚠ ${setId}: no image ${iconFile} for ${word}`);
      if (!result.icons[word]) result.words.add(word);
    }
  }
  Object.assign(result.aliases, set.aliases || {});
  return result;
}

function addHashSets(manifest, categoryGames) {
  const sets = loadHashSets();
  for (const [gameId, set] of Object.entries(sets)) {
    const categories = categoryGames.filter(c => c.gameId === gameId).map(c => c.category);
    if (!categories.length) {
      if (!set.library) console.warn(`  ⚠ ${gameId}.json: no race of game ${gameId} in the database`);
      continue;
    }
    const entry = manifest[gameId] || (manifest[gameId] = { categories: [], icons: {} });
    for (const category of categories) {
      if (!entry.categories.includes(category)) entry.categories.push(category);
    }
    const { icons, words, aliases } = resolveHashSet(sets, gameId, gameId);
    Object.assign(entry.icons, icons);
    if (words.size) entry.words = [...words];
    if (Object.keys(aliases).length) entry.aliases = aliases;
    if (set.afterHash) entry.afterHash = true;
    if (set.minRun) entry.minRun = set.minRun;
  }
}

async function main() {
  const opts = parseArgs();
  const categoryGames = await loadCategoryGames();

  // game id -> { categories, icons: emote -> file }
  const manifest = {};
  let downloaded = 0;

  for (const { category, gameId } of categoryGames) {
    let emotes;
    try {
      emotes = await fetchEmotes(category);
    } catch (err) {
      console.error(`  ✗ ${category}: ${err.message}`);
      continue;
    } finally {
      await sleep(DELAY_MS);
    }
    const hashEmotes = Object.entries(emotes || {})
      .filter(([name]) => /^[A-Za-z0-9]+$/.test(name) && isHashEmote(gameId, name));
    if (!hashEmotes.length) continue;
    if (!gameId) {
      console.warn(`  ⚠ ${category}: ${hashEmotes.length} hash emotes, but no game has this racetime category`);
      continue;
    }

    const entry = manifest[gameId] || (manifest[gameId] = { categories: [], icons: {} });
    entry.categories.push(category);
    const dir = path.join(ICONS_DIR, gameId);
    for (const [name, url] of hashEmotes) {
      // A game's first category gives the image of an emote both have
      if (entry.icons[name]) continue;
      const file = name + (path.extname(new URL(url).pathname) || '.png').toLowerCase();
      entry.icons[name] = file;
      const dest = path.join(dir, file);
      if (opts.dryRun || (!opts.force && fs.existsSync(dest))) continue;
      fs.mkdirSync(dir, { recursive: true });
      await download(url, dest);
      downloaded++;
      await sleep(50);
    }
  }

  addHashSets(manifest, categoryGames);

  const sorted = {};
  for (const gameId of Object.keys(manifest).sort()) {
    const entry = manifest[gameId];
    sorted[gameId] = { ...entry, aliases: { ...buildAliases(gameId, entry.icons), ...entry.aliases } };
    const words = entry.words ? `, ${entry.words.length} words as text` : '';
    console.log(`  ✓ ${gameId} (${entry.categories.join(', ')}): ${Object.keys(entry.icons).length} icons${words}`);
  }
  if (opts.dryRun) {
    console.log(`Dry run: ${Object.keys(sorted).length} games with hash icons`);
    return;
  }
  fs.writeFileSync(MANIFEST, JSON.stringify(sorted, null, 2) + '\n');
  console.log(`${downloaded} images downloaded, ${Object.keys(sorted).length} games in ${path.relative(process.cwd(), MANIFEST)}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
