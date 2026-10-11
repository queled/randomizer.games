// Merges several games of the site into one (see services/game-merge.js).
// Usage: node scripts/merge-games.js <targetId> <sourceId>... [--rename <newId>] [--short-name "<name>"]
// Example: node scripts/merge-games.js tes5s tes5sse --short-name "TES5S Randomizer"
//
// The target keeps its races and integrations and receives the sources' resources;
// the sources are deleted. --rename then gives the merged game another id.

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const connectDB = require('../config/database');
const { Game } = require('../models');
const { mergeGames, changeGameId } = require('../services/game-merge');

function takeOption(args, name) {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const [, value] = args.splice(i, 2);
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  const newId = takeOption(args, '--rename');
  const shortName = takeOption(args, '--short-name');
  const [targetId, ...sourceIds] = args;
  if (!targetId || (!sourceIds.length && !newId && !shortName)) {
    console.error('Usage: node scripts/merge-games.js <targetId> <sourceId>... [--rename <newId>] [--short-name "<name>"]');
    process.exit(2);
  }

  await connectDB();

  for (const sourceId of sourceIds) {
    const { mergedResources } = await mergeGames(targetId, sourceId);
    console.log(`✓ ${sourceId} → ${targetId} (${mergedResources} ressource(s) ajoutée(s))`);
  }

  let id = targetId;
  if (newId && newId !== targetId) {
    await changeGameId(targetId, newId);
    console.log(`✓ ${targetId} renommé en ${newId}`);
    id = newId;
  }
  if (shortName) {
    await Game.updateOne({ id }, { $set: { 'randomizer.shortName': shortName } });
  }

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error.message);
  await mongoose.disconnect();
  process.exit(1);
});
