#!/usr/bin/env node
/**
 * One-off migration: lists the event platforms of Zelda randomizers in the
 * "other" resources of their games, in English and French.
 *
 * - Mido's House: Ocarina of Time only, the link exists and gets its French text
 * - Hyrule Town Hall: the randomizers it hosts (its Breath of the Wild and
 *   Twilight Princess events are speedrun ones, so those games are left out)
 * - an existing link (same URL) is updated instead of being added twice
 * - a new link goes before the ones the community APWorld sync manages
 *
 * Idempotent.
 *
 * Usage:
 *   node scripts/migrations/add-event-platforms.js
 *   node scripts/migrations/add-event-platforms.js --dry-run
 */

const mongoose = require('mongoose');
const connectDB = require('../../config/database');
const { Game } = require('../../models');

const isDryRun = process.argv.includes('--dry-run');

// "d'A Link to the Past", "de The Wind Waker"
const frOf = game => /^[aeiouh]/i.test(game) ? `d'${game}` : `de ${game}`;

const hthDescriptions = game => ({
  en: `Hyrule Town Hall is a platform where ${game} randomizer events like tournaments or community races can be organized.`,
  fr: `Hyrule Town Hall est une plateforme où peuvent être organisés des événements ${frOf(game)} Randomizer, comme des tournois ou des courses communautaires.`
});

const PLATFORMS = [
  {
    games: { oot: 'Ocarina of Time' },
    url: 'https://midos.house/',
    name: "Mido's House",
    descriptions: () => ({
      en: "Mido's House is a platform where Ocarina of Time randomizer events like tournaments or community races can be organized.",
      fr: "Mido's House est une plateforme où peuvent être organisés des événements d'Ocarina of Time Randomizer, comme des tournois ou des courses communautaires."
    })
  },
  {
    games: { alttp: 'A Link to the Past', mm: "Majora's Mask", tww: 'The Wind Waker' },
    url: 'https://hyruletownhall.com/',
    name: 'Hyrule Town Hall',
    descriptions: hthDescriptions
  }
];

const normUrl = url => (url || '').trim().replace(/\/+$/, '').toLowerCase();

function entryFor(platform, gameName, existing) {
  const descriptions = platform.descriptions(gameName);
  const translations = Object.fromEntries(Object.entries(descriptions).map(([lang, description]) =>
    [lang, { name: platform.name, description }]));
  return {
    ...(existing || {}),
    url: existing?.url || platform.url,
    name: platform.name,
    description: descriptions.en,
    translations: { ...(existing?.translations || {}), ...translations },
    type: existing?.type || 'resource',
    source: existing?.source || 'manual'
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  await connectDB();
  if (isDryRun) console.log('[DRY-RUN]');

  const gameIds = [...new Set(PLATFORMS.flatMap(p => Object.keys(p.games)))];
  const games = await Game.find({ id: { $in: gameIds } }).select('id resources.other').lean();
  const missing = gameIds.filter(id => !games.some(g => g.id === id));
  if (missing.length) console.log(`⚠️  Jeux introuvables : ${missing.join(', ')}`);

  let added = 0, updated = 0;
  for (const game of games) {
    const other = [...(game.resources?.other || [])];
    let changed = false;

    for (const platform of PLATFORMS.filter(p => p.games[game.id])) {
      const index = other.findIndex(item => normUrl(item.url) === normUrl(platform.url));
      if (index >= 0) {
        const entry = entryFor(platform, platform.games[game.id], other[index]);
        if (same(entry, other[index])) continue;
        other[index] = entry;
        console.log(`${game.id} : mis à jour → ${platform.name}`);
        updated++;
      } else {
        const synced = item => item.source === 'apworld' || item.source === 'archipelago';
        const firstSynced = other.findIndex(synced);
        other.splice(firstSynced >= 0 ? firstSynced : other.length, 0, entryFor(platform, platform.games[game.id]));
        console.log(`${game.id} : ajouté → ${platform.name}`);
        added++;
      }
      changed = true;
    }

    if (changed && !isDryRun) {
      await Game.updateOne({ id: game.id }, { $set: { 'resources.other': other } });
    }
  }

  console.log(`\n${added} ajout(s), ${updated} mise(s) à jour${isDryRun ? ' (dry-run)' : ''}`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
