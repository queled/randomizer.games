// Usage: node scripts/auto-link-races-global.js <raceUrl>
// Tries to match the given race against ALL matches in DB (not restricted to tournamentId)

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer';

function normalize(s){ return (s||'').toString().normalize('NFKD').replace(/\p{Diacritic}/gu,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim(); }
function levenshtein(a,b){ if(a===b) return 0; const m=a.length,n=b.length; if(m===0) return n; if(n===0) return m; const dp=Array.from({length:m+1},()=>new Array(n+1)); for(let i=0;i<=m;i++)dp[i][0]=i; for(let j=0;j<=n;j++)dp[0][j]=j; for(let i=1;i<=m;i++){ for(let j=1;j<=n;j++){ const cost = a[i-1]===b[j-1]?0:1; dp[i][j]=Math.min(dp[i-1][j]+1,dp[i][j-1]+1,dp[i-1][j-1]+cost); } } return dp[m][n]; }

async function scoreForRaceAndMatch(race, m){
  let entrants = (race.entrants||[]).map(e=>({ name: normalize((e.userName||e.userId||e.user && (e.user.name||e.user.id))||e.name||e.displayName||''), finishedAt: e.finishedAt||e.finished_at||null }));
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
    // Time proximity bonuses
    const matchFinished = m.completedAt || m.startedAt || null;
    if (matchFinished){ const mtime = new Date(matchFinished).getTime(); if(!isNaN(mtime)){ const f1 = best1.entrant.finishedAt ? new Date(best1.entrant.finishedAt).getTime() : null; const f2 = best2.entrant.finishedAt ? new Date(best2.entrant.finishedAt).getTime() : null; if (f1){ const d = Math.abs(mtime - f1)/1000; if(d<=10) total+=120; else if(d<=60) total+=80; else if(d<=600) total+=40; else if(d<=86400) total+=200; } if (f2){ const d = Math.abs(mtime - f2)/1000; if(d<=10) total+=120; else if(d<=60) total+=80; else if(d<=600) total+=40; else if(d<=86400) total+=200; } } }

    // Prefer completed matches
    if (m.state === 'complete') total += 60;

    // Prefer matches that already have scores
    if (m.scoresCsv) total += 40;

    // Boost for later rounds (finals/semis)
    try{ const r = Math.abs(Number(m.round) || 0); if(r>0) total += Math.min(80, r*6); }catch(e){}

    // Penalize matches already linked to other races
    if (m.raceUrl && race.url && m.raceUrl !== race.url) total -= 200;
  }catch(e){}
  return total;
}

async function main(){
  await mongoose.connect(MONGODB_URI);
  console.log('Connected');
  const { Race, Match } = require('../models');
  const args = process.argv.slice(2);
  if(!args[0]){ console.error('raceUrl required'); process.exit(1); }
  const races = await Race.find({ url: args[0] }).lean();
  if(!races.length){ console.error('No race found with url', args[0]); process.exit(0); }
  for(const race of races){
    console.log('Processing', race.url);
    const matches = await Match.find({}).lean();
    const scored = [];
    for(const m of matches){ const sc = await scoreForRaceAndMatch(race,m); if(sc>0) scored.push({m,score:sc}); }
    scored.sort((a,b)=> b.score - a.score);
    if(!scored.length){ console.log('No candidates found for', race.url); continue; }
    const THRESHOLD = 300;
    const top = scored[0];
    console.log('Top candidate:', top.m._id.toString(), 'score', top.score, 'players', top.m.player1Name, 'vs', top.m.player2Name);
    if(top.score >= THRESHOLD){
      console.log('Linking race to match', top.m._id.toString());
      await require('mongoose').model('Match').updateOne(
        { _id: top.m._id },
        { $set: { raceUrl: race.url, completedAt: race.endedAt || top.m.completedAt }, $currentDate: { updatedAt: true } }
      );
      await require('mongoose').model('Race').updateOne(
        { _id: race._id },
        { $set: { matchId: top.m._id }, $currentDate: { updatedAt: true } }
      );
      // unlink other matches pointing to same race
      await require('mongoose').model('Match').updateMany(
        { raceUrl: race.url, _id: { $ne: top.m._id } },
        { $unset: { raceUrl: 1, completedAt: 1 }, $currentDate: { updatedAt: true } }
      );
    } else {
      console.log('Top score too low, not linking');
    }
  }
  await mongoose.disconnect();
  console.log('Done');
}

main().catch(err=>{ console.error(err); process.exit(1); });
