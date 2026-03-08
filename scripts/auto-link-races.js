// Usage: node scripts/auto-link-races.js <raceUrl1> [raceUrl2 ...]
// If no args provided, will attempt to link all races without matchId in DB (use with caution).

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer';
const {
  rankMatchesForRace,
  selectBestCandidate,
  getMatchPlayers
} = require('../helpers/race-match-linking');

async function main(){
  await mongoose.connect(MONGODB_URI);
  console.log('Connected');
  const { Race, Match } = require('../models');
  const rawArgs = process.argv.slice(2);
  const isDryRun = rawArgs.includes('--dry-run');
  const args = rawArgs.filter(arg => arg !== '--dry-run');
  let races;
  if (args.length) {
    races = await Race.find({ url: { $in: args } }).lean();
  } else {
    races = await Race.find({}).lean();
  }

  for(const race of races){
    console.log('Processing race', race.url);
    const matches = await Match.find({ tournamentId: race.tournamentId }).lean();
    const scored = rankMatchesForRace(race, matches, {
      requireDirect: true,
      allowOccupiedMatchReassign: false
    });

    if (!scored.length || scored[0].score <= 0) {
      console.log('No candidate matches for', race.url);
      continue;
    }

    const chosen = selectBestCandidate(scored, {
      threshold: 320,
      minGap: 80,
      raceUrl: race.url
    });

    console.log('Top candidates:');
    scored.slice(0, 5).forEach((entry, index) => {
      const players = getMatchPlayers(entry.match);
      console.log(
        `  ${index + 1}. score=${entry.score} match=${entry.match._id} players=${players.player1} vs ${players.player2} linked=${entry.match.raceUrl || 'no'}`
      );
    });

    if (chosen) {
      console.log('Chosen match', chosen.match._id.toString(), 'score', chosen.score, 'for race', race.url, isDryRun ? '[DRY-RUN]' : '');

      if (isDryRun) continue;

      await Race.updateOne(
        { _id: race._id },
        { $set: { matchId: chosen.match._id, matchConfidence: chosen.score }, $currentDate: { updatedAt: true } }
      );
      await Match.updateOne(
        { _id: chosen.match._id },
        { $set: { raceUrl: race.url, completedAt: race.endedAt || chosen.match.completedAt }, $currentDate: { updatedAt: true } }
      );
      await Match.updateMany(
        { raceUrl: race.url, _id: { $ne: chosen.match._id } },
        { $unset: { raceUrl: 1 }, $currentDate: { updatedAt: true } }
      );
    } else {
      console.log('No unambiguous match candidate above threshold for', race.url);
    }
  }

  console.log('Done');
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
