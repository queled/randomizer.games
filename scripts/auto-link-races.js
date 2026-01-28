// Usage: node scripts/auto-link-races.js <raceUrl1> [raceUrl2 ...]
// If no args provided, will attempt to link all races without matchId in DB (use with caution).

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer';

function normalize(s){ return (s||'').toString().normalize('NFKD').replace(/\p{Diacritic}/gu,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }

function levenshtein(a,b){ if(a===b) return 0; const m=a.length,n=b.length; if(m===0) return n; if(n===0) return m; const dp=Array.from({length:m+1},()=>new Array(n+1)); for(let i=0;i<=m;i++)dp[i][0]=i; for(let j=0;j<=n;j++)dp[0][j]=j; for(let i=1;i<=m;i++){ for(let j=1;j<=n;j++){ const cost = a[i-1]===b[j-1]?0:1; dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+cost); } } return dp[m][n]; }

async function scoreForRaceAndMatch(race, m){
  let entrants = (race.entrants||[]).map(e=>({ name: normalize((e.user && (e.user.name||e.user.id))||e.name||e.displayName||''), finishedAt: e.finishedAt||e.finished_at||null }));
  // If entrants exist but names are blank, try to extract names from race.name or race.info
  const hasAnyName = entrants.some(en => en.name && en.name.length>0);
  if (!hasAnyName) {
    const text = (race.name||'') + '\n' + (race.info||'');
    const vsRe = /([^\n\r:|\t\-]{1,40})\s+(?:vs|v|vs\.|:|-)\s+([^\n\r]{1,40})/i;
    const mm = vsRe.exec(text);
    if (mm){ entrants = [{ name: normalize(mm[1]), finishedAt: null }, { name: normalize(mm[2]), finishedAt: null }]; }
  }

  const scoreNameMatch = (entrantName, target) =>{
    if(!entrantName||!target) return 0;
    if(entrantName===target) return 300;
    const etoks = entrantName.split(' ').filter(Boolean); const ttoks = target.split(' ').filter(Boolean);
    if (etoks.includes(target)) return 200;
    if (ttoks.length && ttoks.every(t=>etoks.includes(t))) return 180;
    // prefix handling
    for(const et of etoks){ for(const tt of ttoks){ if (et.startsWith(tt) || tt.startsWith(et)){ const d=Math.abs(et.length-tt.length); if (d<=3) return 220; } } }
    try{ if ((new RegExp('\\b'+target.replace(/[.*+?^${}()|[\\]\\]/g,'\\$&')+'\\b')).test(entrantName)) return 160;}catch(e){}
    const lev = levenshtein(entrantName,target); const maxLen = Math.max(entrantName.length,target.length)||1; const sim = 1 - (lev/maxLen);
    if (sim>0.85) return 140; if (sim>0.7) return 80; return 0;
  };

  const p1 = normalize(m.player1Name||''); const p2 = normalize(m.player2Name||'');
  if(!p1||!p2) return 0;
  let best1={score:0,entrant:null}, best2={score:0,entrant:null};
  for(const ent of entrants){ const s1=scoreNameMatch(ent.name,p1); if(s1>best1.score) best1={score:s1,entrant:ent}; const s2=scoreNameMatch(ent.name,p2); if(s2>best2.score) best2={score:s2,entrant:ent}; }
  if (best1.entrant && best2.entrant && best1.entrant===best2.entrant){ let sec2={score:0,entrant:null}; for(const ent of entrants){ if(ent===best1.entrant) continue; const s=scoreNameMatch(ent.name,p2); if(s>sec2.score) sec2={score:s,entrant:ent}; } if (sec2.score>0) best2=sec2; }
  if (!best1.entrant || !best2.entrant || best1.entrant===best2.entrant) return 0;
  let total = best1.score + best2.score;
  try{
    // Time proximity bonuses (as before)
    const matchFinished = m.completedAt || m.startedAt || null;
    if (matchFinished){ const mtime = new Date(matchFinished).getTime(); if(!isNaN(mtime)){ const f1 = best1.entrant.finishedAt ? new Date(best1.entrant.finishedAt).getTime() : null; const f2 = best2.entrant.finishedAt ? new Date(best2.entrant.finishedAt).getTime() : null; if (f1){ const d = Math.abs(mtime - f1)/1000; if(d<=10) total+=120; else if(d<=60) total+=80; else if(d<=600) total+=40; else if(d<=86400) total+=200; } if (f2){ const d = Math.abs(mtime - f2)/1000; if(d<=10) total+=120; else if(d<=60) total+=80; else if(d<=600) total+=40; else if(d<=86400) total+=200; } } }

    // Prefer completed matches
    if (m.state === 'complete') total += 60;

    // Prefer matches that already have scores (higher confidence)
    if (m.scoresCsv) total += 40;

    // Boost for later rounds (finals/semis). Use absolute round magnitude.
    try{ const r = Math.abs(Number(m.round) || 0); if(r>0) total += Math.min(80, r*6); }catch(e){}

    // Penalize if match is already linked to a different race (avoid overwriting)
    if (m.raceUrl && race.url && m.raceUrl !== race.url) total -= 200;
  }catch(e){}
  return total;
}

async function main(){
  await mongoose.connect(MONGODB_URI);
  console.log('Connected');
  const { Race, Match } = require('../models');
  const args = process.argv.slice(2);
  let races;
  if (args.length) {
    races = await Race.find({ url: { $in: args } }).lean();
  } else {
    races = await Race.find({}).lean();
  }

  for(const race of races){
    console.log('Processing race', race.url);
    const matches = await Match.find({ tournamentId: race.tournamentId }).lean();
    // Compute scores (scoreForRaceAndMatch is async-capable) and await all
    const scored = await Promise.all(matches.map(async m => ({ m, score: await scoreForRaceAndMatch(race, m) })));
    scored.sort((a,b)=> b.score - a.score);
    if (!scored.length || scored[0].score<=0){ console.log('No candidate matches for', race.url); continue; }
    const THRESHOLD = 300;
    const topScore = scored[0].score;
    const topCandidates = scored.filter(s => s.score >= Math.max(THRESHOLD, topScore - 50));
    // prefer candidate without raceUrl
    let chosen = topCandidates.find(c => !c.m.raceUrl) || topCandidates[0];
    if (chosen && chosen.score >= THRESHOLD){
      console.log('Chosen match', chosen.m._id.toString(), 'score', chosen.score, 'for race', race.url);
      await Race.updateOne(
        { _id: race._id },
        { $set: { matchId: chosen.m._id }, $unset: { previousMatchCompletedAt: 0 }, $currentDate: { updatedAt: true } }
      );
      await Match.updateOne(
        { _id: chosen.m._id },
        { $set: { raceUrl: race.url, completedAt: race.endedAt || chosen.m.completedAt }, $currentDate: { updatedAt: true } }
      );
      // unlink others
      await Match.updateMany(
        { raceUrl: race.url, _id: { $ne: chosen.m._id } },
        { $unset: { raceUrl: 1, completedAt: 1 }, $currentDate: { updatedAt: true } }
      );
    }
  }

  console.log('Done');
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
