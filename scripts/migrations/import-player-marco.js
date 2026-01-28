#!/usr/bin/env node
require('dotenv').config();
const connectDB = require('../../config/database');
const { Player } = require('../../models');

(async function(){
  try{
    await connectDB();
    const userId = 'dMqzQPW4jv31L2R5';
    const racetimeUrl = 'https://racetime.gg/user/dMqzQPW4jv31L2R5/marco';
    const twitch = 'marco';

    const doc = {
      userId,
      name: 'Marco',
      racetimeUrl,
      racetimeId: userId,
      twitch,
      // no challonge URL known for this player
      challongeUrl: null,
      stats: {}
    };

    const updated = await Player.findOneAndUpdate(
      { userId },
      { $set: doc },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    console.log('Upserted player:', updated);
    process.exit(0);
  }catch(err){
    console.error('Import failed:', err);
    process.exit(1);
  }
})();
