/**
 * Remove tournamentId from specific imported races
 * Usage: node scripts/remove-tournament-from-races.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer';

async function main() {
  await mongoose.connect(MONGODB_URI);
  const models = require('../models');
  const Race = models.Race;

  const urls = ['/ootr/mega-ruto-1573','/ootr/silly-bongobongo-3654','/ootr/mecha-kokiri-0294'];

  for (const url of urls) {
    try {
      const r = await Race.findOneAndUpdate({ url }, { $unset: { tournamentId: '' } }, { new: true });
      if (r) console.log('Updated:', r.url, 'tournamentId now=', r.tournamentId);
      else console.log('Not found:', url);
    } catch (e) {
      console.error('Error updating', url, e.message || e);
    }
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
