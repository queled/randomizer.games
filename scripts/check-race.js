// Usage: node scripts/check-race.js <raceUrl>
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer';

async function main(){
  const args = process.argv.slice(2);
  if(!args[0]){ console.error('raceUrl required'); process.exit(1); }
  await mongoose.connect(MONGODB_URI);
  const { Race } = require('../models');
  const race = await Race.findOne({ url: args[0] }).lean();
  if(!race){ console.log('Race not found'); await mongoose.disconnect(); return; }
  console.log(JSON.stringify(race, null, 2));
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
