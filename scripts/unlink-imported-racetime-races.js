// Usage: node scripts/unlink-imported-racetime-races.js
// This script finds specific racetime races and removes their tournamentId.
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer';

(async function(){
  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  const { Race, Tournament } = require('../models');

  const urls = [
    '/ootr/dazzling-talon-4323',
    '/ootr/invincible-kakariko-0885',
    '/ootr/graceful-mido-0999',
    '/ootr/hot-shiro-5231'
  ];

  for (const u of urls) {
    const race = await Race.findOne({ url: u }).lean();
    if (!race) {
      console.log('Race not found:', u);
      continue;
    }
    console.log('\nRace:', race.url, ' _id:', race._id.toString());
    if (race.tournamentId) {
      try {
        const t = await Tournament.findById(race.tournamentId).lean();
        console.log('  Linked tournament:', t ? t.name : race.tournamentId.toString());
      } catch (e) {
        console.log('  Linked tournament id:', race.tournamentId.toString());
      }
    } else {
      console.log('  No tournament linked');
    }

    // Unlink tournamentId
    const updated = await Race.findByIdAndUpdate(race._id, { $unset: { tournamentId: true } }, { new: true });
    console.log('  Unlinked tournamentId.');
  }

  await mongoose.disconnect();
  console.log('\nDone.');
  process.exit(0);
})();
