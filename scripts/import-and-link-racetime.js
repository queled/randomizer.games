// Usage: node scripts/import-and-link-racetime.js <racePathOrUrl> [tournamentId]
// Example: node scripts/import-and-link-racetime.js /ootr/proud-kakariko-8125 693e97490f2f2b79e46b3c09

const mongoose = require('mongoose');
const path = require('path');
const { execFileSync } = require('child_process');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer';

async function toMs(durationStr){
  if(!durationStr) return null;
  // Accept PT#H#M#S or P0DT#H#M#S
  try{
    const cleaned = durationStr.replace(/^P(?:\d+D)?T/, 'PT');
    const re = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/;
    const m = re.exec(cleaned);
    if(!m) return null;
    const h = parseInt(m[1]||0,10); const mm = parseInt(m[2]||0,10); const ss = parseFloat(m[3]||0);
    return Math.round(((h*3600) + (mm*60) + ss) * 1000);
  }catch(e){ return null; }
}

async function computeFinishTimeMsFromEntrant(e){
  if(typeof e.finishTimeMs !== 'undefined' && e.finishTimeMs !== null) return e.finishTimeMs;
  if(e.finishTime){
    const ms = await toMs(e.finishTime);
    if(ms) return ms;
  }
  if(e.finish_time){
    const ms = await toMs(e.finish_time);
    if(ms) return ms;
  }
  return null;
}

function parseRacePath(input){
  if(!input) return null;
  // remove protocol and domain
  input = input.replace(/^https?:\/\/(www\.)?racetime.gg/, '');
  input = input.replace(/^\/+/, '');
  const parts = input.split('/').filter(Boolean);
  if(parts.length >= 2) return { category: parts[0], raceId: parts[1] };
  return null;
}

async function main(){
  const args = process.argv.slice(2);
  if(!args[0]){ console.error('Race path required'); process.exit(1); }
  const parsed = parseRacePath(args[0]);
  if(!parsed){ console.error('Unable to parse race path'); process.exit(1); }
  const tournamentIdArg = args[1] || '693e97490f2f2b79e46b3c09';

  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  const { Race, Match, Tournament } = require('../models');
  const racetime = require('../services/racetime');

  console.log('Fetching race from racetime:', parsed.category, parsed.raceId);
  const raceData = await racetime.getRace(parsed.category, parsed.raceId);
  if(!raceData){ console.error('No data returned from racetime'); process.exit(1); }

  // Map entrants (use async callbacks so we can await conversions)
  const entrants = await Promise.all((raceData.entrants || []).map(async e => ({
    userId: e.user && e.user.id ? String(e.user.id) : null,
    userName: e.user && e.user.name ? e.user.name : (e.name || e.displayName || null),
    userDiscriminator: e.user && e.user.discriminator ? e.user.discriminator : null,
    userUrl: e.user && e.user.url ? e.user.url : null,
    status: e.status || null,
    finishTime: e.finishTime || e.finish_time || null,
    finishTimeMs: (typeof e.finishTimeMs !== 'undefined') ? e.finishTimeMs : await computeFinishTimeMsFromEntrant(e),
    finishedAt: e.finishedAt || e.finished_at || null,
    place: e.place || null,
    placeOrdinal: e.placeOrdinal || e.place_ordinal || null,
    comment: e.comment || null
  })));

  // Try to parse finishTime to ms if provided as PT...S
  for(const en of entrants){
    if((en.finishTime || en.finish_time) && !en.finishTimeMs){
      const ms = await toMs(en.finishTime || en.finish_time);
      if(ms) en.finishTimeMs = ms;
    }
  }

  // Attach tournamentId if exists
  let tournamentId = null;
  try{
    const t = await Tournament.findOne({ _id: tournamentIdArg }).lean();
    if(t) tournamentId = t._id;
  }catch(e){ tournamentId = null; }

  const raceDoc = {
    name: raceData.name || parsed.raceId,
    category: parsed.category,
    url: raceData.url || ('/' + parsed.category + '/' + parsed.raceId),
    status: raceData.status || null,
    goal: raceData.goal || null,
    info: raceData.info || null,
    startedAt: raceData.startedAt || raceData.started_at || null,
    endedAt: raceData.endedAt || raceData.ended_at || null,
    recordable: raceData.recordable || false,
    entrants,
    tournamentId: tournamentId || undefined,
    source: { type: 'racetime', externalId: parsed.raceId, url: raceData.url || null, importedAt: new Date() }
  };

  // Upsert race by url
  const existing = await Race.findOne({ url: raceDoc.url });
  let race;
  if(existing){
    race = await Race.findByIdAndUpdate(existing._id, { $set: raceDoc, $currentDate: { updatedAt: true } }, { new: true });
    console.log('Updated existing Race:', race.url);
  } else {
    race = await Race.create(raceDoc);
    console.log('Inserted Race:', race.url);
  }

  // Call auto-link script for this race
  try{
    console.log('Running auto-link for', race.url);
    execFileSync('node', ['scripts/auto-link-races.js', race.url], { stdio: 'inherit' });
  }catch(e){ console.error('auto-link script failed', e.message); }

  // Fetch match linked
  const match = await Match.findOne({ raceUrl: race.url }).lean();
  if(match){
    console.log('Linked Match:', match._id.toString());
    console.log('raceUrl:', match.raceUrl);
    console.log('completedAt:', match.completedAt);
    console.log('player1Name:', match.player1Name, 'player2Name:', match.player2Name);
  } else {
    console.log('No match linked for race', race.url);
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
