// Usage: node scripts/auto-link-races-global.js <raceUrl>
// Tries to match the given race against ALL matches in DB (not restricted to tournamentId)

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
  if(!args[0]){ console.error('raceUrl required'); process.exit(1); }
  const races = await Race.find({ url: args[0] }).lean();
  if(!races.length){ console.error('No race found with url', args[0]); process.exit(0); }
  for(const race of races){
    console.log('Processing', race.url);
    const matches = await Match.find({}).lean();
    const scored = rankMatchesForRace(race, matches, {
      requireDirect: true,
      allowOccupiedMatchReassign: false
    });
    if(!scored.length){ console.log('No candidates found for', race.url); continue; }
    scored.slice(0, 5).forEach((entry, index) => {
      const players = getMatchPlayers(entry.match);
      console.log(`  ${index + 1}. score=${entry.score} match=${entry.match._id} players=${players.player1} vs ${players.player2} linked=${entry.match.raceUrl || 'no'}`);
    });
    const chosen = selectBestCandidate(scored, { threshold: 320, minGap: 80, raceUrl: race.url });
    if(chosen){
      console.log('Linking race to match', chosen.match._id.toString(), isDryRun ? '[DRY-RUN]' : '');
      if (isDryRun) continue;
      await require('mongoose').model('Match').updateOne(
        { _id: chosen.match._id },
        { $set: { raceUrl: race.url, completedAt: race.endedAt || chosen.match.completedAt }, $currentDate: { updatedAt: true } }
      );
      await require('mongoose').model('Race').updateOne(
        { _id: race._id },
        { $set: { matchId: chosen.match._id, matchConfidence: chosen.score }, $currentDate: { updatedAt: true } }
      );
      // unlink other matches pointing to same race
      await require('mongoose').model('Match').updateMany(
        { raceUrl: race.url, _id: { $ne: chosen.match._id } },
        { $unset: { raceUrl: 1 }, $currentDate: { updatedAt: true } }
      );
    } else {
      console.log('No unambiguous candidate above threshold');
    }
  }
  await mongoose.disconnect();
  console.log('Done');
}

main().catch(err=>{ console.error(err); process.exit(1); });
