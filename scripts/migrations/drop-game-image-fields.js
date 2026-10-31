#!/usr/bin/env node
/**
 * One-off migration: the covers moved to public/assets/covers/<id>.png and
 * their URL now comes from the game's id. The games' "image" and "logo"
 * fields ("assets/<id>.png" or empty) are no longer read: removed.
 *
 * Idempotent.
 *
 * Usage:
 *   node scripts/migrations/drop-game-image-fields.js
 *   node scripts/migrations/drop-game-image-fields.js --dry-run
 */

const mongoose = require('mongoose');
const connectDB = require('../../config/database');

const isDryRun = process.argv.includes('--dry-run');

async function main() {
  await connectDB();
  const games = mongoose.connection.db.collection('games');
  const filter = { $or: [{ image: { $exists: true } }, { logo: { $exists: true } }] };
  const count = await games.countDocuments(filter);
  console.log(`${count} jeux avec un champ image ou logo${isDryRun ? ' (simulation)' : ''}`);
  if (!isDryRun && count) {
    const { modifiedCount } = await games.updateMany(filter, { $unset: { image: '', logo: '' } });
    console.log(`${modifiedCount} jeux mis à jour`);
  }
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
