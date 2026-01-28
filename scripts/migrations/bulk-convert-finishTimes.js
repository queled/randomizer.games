#!/usr/bin/env node
const connectDB = require('../../config/database');
const { Race } = require('../../models');

function parseISODuration(str) {
  const cleaned = String(str).replace(/^P(?:\d+D)?T/, 'PT');
  const re = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/;
  const m = re.exec(cleaned);
  if (!m) return null;
  const h = parseInt(m[1] || 0, 10);
  const min = parseInt(m[2] || 0, 10);
  const s = parseFloat(m[3] || 0);
  return Math.round(((h * 3600) + (min * 60) + s) * 1000);
}

function parseTimeToMs(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  const s = String(value).trim();
  if (!s) return null;
  if (s.startsWith('PT') || s.startsWith('P')) return parseISODuration(s);
  if (s.includes(':')) {
    const parts = s.split(':').map(p => parseFloat(p));
    if (parts.length === 3) return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
    if (parts.length === 2) return Math.round((parts[0] * 60 + parts[1]) * 1000);
  }
  const num = Number(s);
  if (!Number.isNaN(num)) {
    if (num > 10000) return Math.round(num);
    return Math.round(num * 1000);
  }
  return null;
}

(async function(){
  try{
    await connectDB();
    console.log('Connected');

    const query = { entrants: { $elemMatch: { finishTime: { $exists: true, $ne: null }, finishTimeMs: { $exists: false } } } };
    const cursor = Race.find(query).cursor();
    let processed = 0;
    let updated = 0;
    for (let race = await cursor.next(); race != null; race = await cursor.next()){
      processed++;
      let modified = false;
      if(Array.isArray(race.entrants)){
        for(const ent of race.entrants){
          if((ent.finishTime || ent.finishTime === 0) && !ent.finishTimeMs){
            const ms = parseTimeToMs(ent.finishTime);
            if(ms != null){ ent.finishTimeMs = ms; modified = true; }
          }
        }
      }
      if(modified){ await race.save(); updated++; console.log('Updated race', race._id.toString()); }
      if(processed % 50 === 0) console.log('Processed', processed, 'races...');
    }

    console.log(`Done. Processed: ${processed}, Updated: ${updated}`);
    process.exit(0);
  }catch(err){ console.error('Bulk convert error:', err); process.exit(1); }
})();
