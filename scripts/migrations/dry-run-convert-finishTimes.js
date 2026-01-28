#!/usr/bin/env node
const connectDB = require('../../config/database');
const { Race, Player } = require('../../models');

(async function(){
  try{
    await connectDB();
    console.log('Connected');

    const raceQuery = {
      entrants: { $elemMatch: { finishTime: { $exists: true, $ne: null }, finishTimeMs: { $exists: false } } }
    };
    const raceCount = await Race.countDocuments(raceQuery);
    const raceSamples = await Race.find(raceQuery).limit(10).select('_id url').lean();

    const playerQuery = {
      $or: [
        { 'stats.bestTime': { $exists: true, $ne: null }, 'stats.bestTimeMs': { $exists: false } },
        { 'stats.averageTime': { $exists: true, $ne: null }, 'stats.averageTimeMs': { $exists: false } }
      ]
    };
    const playerCount = await Player.countDocuments(playerQuery);
    const playerSamples = await Player.find(playerQuery).limit(10).select('_id username').lean();

    console.log('Dry-run results:');
    console.log('Races needing conversion:', raceCount);
    if(raceSamples && raceSamples.length){
      console.log('Sample race ids:');
      raceSamples.forEach(r => console.log('-', r._id.toString(), r.url || ''));
    }
    console.log('Players needing conversion:', playerCount);
    if(playerSamples && playerSamples.length){
      console.log('Sample player ids:');
      playerSamples.forEach(p => console.log('-', p._id.toString(), p.username || ''));
    }

    process.exit(0);
  }catch(err){
    console.error('Error during dry-run:', err);
    process.exit(1);
  }
})();
