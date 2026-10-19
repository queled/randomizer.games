#!/usr/bin/env node
/**
 * One-off migration: a game had been matched to the rando-list entry of another
 * game with the same abbreviation, which gave it that official name and the
 * other randomizer as its site.
 *
 * - the game gets back its official name, linked to its own rando-list entry
 * - the other game gets the rando-list link and its randomizer site
 *
 * Idempotent.
 *
 * Usage:
 *   node scripts/migrations/fix-dragon-warrior-name.js
 *   node scripts/migrations/fix-dragon-warrior-name.js --dry-run
 */

const mongoose = require('mongoose');
const connectDB = require('../../config/database');
const { Game } = require('../../models');

const isDryRun = process.argv.includes('--dry-run');

async function randoListSites(seriesFile, gameName) {
  const series = await mongoose.connection.db.collection('rando_list_cache')
    .findOne({ seriesFile });
  return (series?.randomizers || [])
    .filter(r => r.url && !r.obsolete && r.games.includes(gameName))
    .map(r => ({
      url: r.url,
      name: r.name || r.identifier,
      source: 'rando-list',
      isArchipelago: r.isArchipelago || false,
      isObsolete: false
    }));
}

async function relink(gameId, { seriesFile, gameName }, extraSet = {}) {
  const game = await Game.findOne({ id: gameId }).lean();
  if (!game) throw new Error(`Jeu introuvable : ${gameId}`);

  const sites = [
    ...(game.resources?.sites || []).filter(s => s.source !== 'rando-list'),
    ...await randoListSites(seriesFile, gameName)
  ];
  const $set = {
    ...extraSet,
    'resources.sites': sites,
    'integrations.randoList.enabled': true,
    'integrations.randoList.seriesFile': seriesFile,
    'integrations.randoList.gameName': gameName,
    'integrations.randoList.gameNames': [],
    'integrations.randoList.confidence': 'manual'
  };
  console.log(`${gameId} → ${gameName} (${seriesFile}) : ${sites.map(s => s.url).join(', ')}`);
  if (!isDryRun) await Game.updateOne({ id: gameId }, { $set });
}

async function main() {
  await connectDB();
  if (isDryRun) console.log('[DRY-RUN]');

  await relink('dw', { seriesFile: 'Dragon_Quest.yml', gameName: 'Dragon Quest' },
    { 'official.name': 'Dragon Warrior' });
  await relink('digimonworld', { seriesFile: 'Digimon.yml', gameName: 'Digimon World' });

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
