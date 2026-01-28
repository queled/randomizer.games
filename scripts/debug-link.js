// Usage: node scripts/debug-link.js <tournamentId> <raceUrl>
// Example: node scripts/debug-link.js 69680b012350fef4ef3947c9 /mmr/graceful-shulk-4276

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer';

async function main(){
  const args = process.argv.slice(2);
  if(!args[0] || !args[1]){
    console.error('tournamentId and raceUrl required'); process.exit(1);
  }
  const [tournamentId, raceUrl] = args;
  await mongoose.connect(MONGODB_URI);
  const { Match, Race } = require('../models');

  const matches = await Match.find({ tournamentId }).lean();
  console.log('Matches for tournament', tournamentId, 'count=', matches.length);
  for(const m of matches.slice(0,100)){
    console.log('MATCH', m._id.toString(), 'p1:', m.player1Name, 'p2:', m.player2Name, 'state:', m.state, 'round:', m.round, 'completedAt:', m.completedAt, 'scores:', m.scoresCsv, 'raceUrl:', m.raceUrl);
  }

  const race = await Race.findOne({ url: raceUrl }).lean();
  if(!race){ console.log('Race not found', raceUrl); await mongoose.disconnect(); process.exit(0); }
  console.log('Race tournamentId:', race.tournamentId);
  console.log('Race entrants (count=', (race.entrants||[]).length, ')');
  (race.entrants||[]).forEach((e,i) => console.log(i+1, JSON.stringify(e)));

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
