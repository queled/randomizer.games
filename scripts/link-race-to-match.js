// Usage: node scripts/link-race-to-match.js <raceUrl> <matchId>
// Example: node scripts/link-race-to-match.js /ootr/priceless-mamamu-3174 693e974b0f2f2b79e46b3c48

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer';

async function main(){
  const raceUrl = process.argv[2];
  const matchId = process.argv[3];
  if (!raceUrl || !matchId){
    console.error('Usage: node scripts/link-race-to-match.js <raceUrl> <matchId>');
    process.exit(2);
  }

  await mongoose.connect(MONGODB_URI);
  console.log('Connected to DB');

  const { Race, Match } = require('../models');

  const race = await Race.findOne({ url: raceUrl }).lean();
  if (!race){
    console.error('Race not found for url', raceUrl);
    process.exit(1);
  }

  const targetMatch = await Match.findById(matchId).lean();
  if (!targetMatch){
    console.error('Match not found for id', matchId);
    process.exit(1);
  }

  // Unset raceUrl from any match currently using this raceUrl
  const linkedMatches = await Match.find({ raceUrl: raceUrl }).lean();
  for (const m of linkedMatches){
    if (m._id.toString() === matchId) continue;
    console.log('Unlinking race from match', m._id.toString(), m.player1Name, 'vs', m.player2Name);
    await Match.updateOne({ _id: m._id }, { $unset: { raceUrl: 1, completedAt: 1 }, $currentDate: { updatedAt: true } });
  }

  // Also clear any match that has completedAt equal to race.endedAt (to avoid duplicates)
  if (race.endedAt){
    const others = await Match.find({ tournamentId: race.tournamentId, completedAt: race.endedAt }).lean();
    for (const om of others){
      if (om._id.toString() === matchId) continue;
      console.log('Clearing completedAt on match', om._id.toString(), om.player1Name, 'vs', om.player2Name);
      await Match.updateOne({ _id: om._id }, { $unset: { completedAt: 1 }, $currentDate: { updatedAt: true } });
    }
  }

  // Set race.matchId and update target match
  console.log('Linking race', raceUrl, 'to match', matchId, targetMatch.player1Name, 'vs', targetMatch.player2Name);
  await Race.updateOne({ _id: race._id }, { $set: { matchId: matchId }, $unset: { previousMatchCompletedAt: 0 }, $currentDate: { updatedAt: true } });
  await Match.updateOne({ _id: matchId }, { $set: { raceUrl: raceUrl, completedAt: race.endedAt || targetMatch.completedAt }, $currentDate: { updatedAt: true } });

  console.log('Done');
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
