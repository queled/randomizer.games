// Usage: node scripts/unlink-race.js <raceUrl>
// Example: node scripts/unlink-race.js /ootr/priceless-mamamu-3174

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer';

async function main(){
  const arg = process.argv[2];
  if (!arg){
    console.error('Usage: node scripts/unlink-race.js <raceUrl>');
    process.exit(2);
  }
  const raceUrl = arg;

  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  console.log('Connected to DB');

  const models = require('../models');
  const { Race, Match } = models;

  const race = await Race.findOne({ url: raceUrl }).lean();
  if (!race){
    console.error('Race not found for url', raceUrl);
    process.exit(1);
  }

  const correctMatchId = race.matchId ? race.matchId.toString() : null;
  console.log('Race:', race._id.toString(), 'matchId:', correctMatchId);

  const matches = await Match.find({ raceUrl: raceUrl }).lean();
  if (!matches || matches.length === 0){
    console.log('No matches currently linked to this race url. Nothing to do.');
    await mongoose.disconnect();
    return;
  }

  for (const m of matches){
    const mid = m._id.toString();
    if (correctMatchId && mid === correctMatchId){
      console.log('Keeping correct match', mid, '(', m.player1Name, 'vs', m.player2Name, ')');
      continue;
    }
    console.log('Unlinking race from match', mid, '(', m.player1Name, 'vs', m.player2Name, ')');
    // remove raceUrl and clear completedAt to avoid showing incorrect finish time
    await Match.updateOne({ _id: m._id }, { $unset: { raceUrl: 1, completedAt: 1 }, $currentDate: { updatedAt: true } });
  }

  // Also clear any other matches in the same tournament that have the same completedAt as the race endedAt
  if (race.endedAt) {
    const otherMatches = await Match.find({ tournamentId: race.tournamentId, completedAt: race.endedAt }).lean();
    for (const om of otherMatches) {
      const omid = om._id.toString();
      if (omid === correctMatchId) continue;
      if (om.raceUrl && om.raceUrl === raceUrl) continue; // already handled
      console.log('Clearing completedAt on match', omid, '(', om.player1Name, 'vs', om.player2Name, ') because it matches race endedAt');
      await Match.updateOne({ _id: om._id }, { $unset: { completedAt: 1 }, $currentDate: { updatedAt: true } });
    }
  }

  // Ensure race.matchId points to correct match (or unset if none)
  if (correctMatchId){
    console.log('Ensuring race.matchId is set to', correctMatchId);
    // set race.matchId and apply race endedAt to the correct match's completedAt
    await Race.updateOne({ _id: race._id }, { $set: { matchId: correctMatchId }, $currentDate: { updatedAt: true } });
    await Match.updateOne({ _id: correctMatchId }, { $set: { raceUrl: raceUrl, completedAt: race.endedAt || null }, $currentDate: { updatedAt: true } });
  } else {
    console.log('No correct match id present – unsetting race.matchId');
    await Race.updateOne({ _id: race._id }, { $unset: { matchId: 1 }, $currentDate: { updatedAt: true } });
  }

  console.log('Done');
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
