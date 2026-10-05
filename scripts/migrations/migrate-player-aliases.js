#!/usr/bin/env node
/**
 * One-off migration: moves the former hard-coded player aliases
 * (config/player-aliases.js) into the `aliases` field of the Player collection.
 *
 * Idempotent (uses $addToSet). Each alias was verified against Racetime and Challonge.
 *
 * Usage:
 *   node scripts/migrations/migrate-player-aliases.js
 *   node scripts/migrations/migrate-player-aliases.js --dry-run
 */

const mongoose = require('mongoose');
const connectDB = require('../../config/database');
const { Player } = require('../../models');

const isDryRun = process.argv.includes('--dry-run');

// canonical Racetime name -> aliases
const ALIASES_BY_PLAYER = {
  Aranaut: ['TheAranaut'],
  Flouche: ['Flouflouche'],
  Cola: ['cola_osu'],
  Pyra: ['Pyra2366'],
  Volc: ['Volc-41'],
  Challensois_: ['Challensois'],
  Jaybone25: ['Jaybone25 (invitation pending)'],
  meanmido: ['Meanmido (invitation pending)'],
  r0bd0g: ['r0bd0g (invitation pending)'],
  Riley: ['Riley2w69t'],
  TrenteR: ['TrenteR_TR']
};

const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function main() {
  await connectDB();

  try {
    console.log(`\n🔗 Migrate player aliases${isDryRun ? ' (dry-run)' : ''}`);
    let updated = 0;

    for (const [name, aliases] of Object.entries(ALIASES_BY_PLAYER)) {
      const matches = await Player.find({ name: new RegExp(`^${escapeRegex(name)}$`, 'i') })
        .select('_id name userId aliases')
        .lean();

      if (matches.length !== 1) {
        console.warn(`⚠️ ${name}: ${matches.length} profils trouvés, ignoré`);
        continue;
      }

      const [player] = matches;
      const missing = aliases.filter(a => !(player.aliases || []).includes(a));
      console.log(`${missing.length ? '➕' : '✔️'} ${player.name} (${player.userId}): ${aliases.join(', ')}${missing.length ? '' : ' (déjà présent)'}`);

      if (missing.length && !isDryRun) {
        await Player.updateOne({ _id: player._id }, { $addToSet: { aliases: { $each: missing } } });
      }
      if (missing.length) updated += 1;
    }

    console.log(`✅ Profils ${isDryRun ? 'à mettre à jour' : 'mis à jour'}: ${updated}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(err => {
  console.error('❌ Erreur migration aliases:', err.message);
  process.exitCode = 1;
});
