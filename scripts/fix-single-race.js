#!/usr/bin/env node
/**
 * Fix single race info by ID
 * Usage: node scripts/fix-single-race.js <raceId>
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const connectDB = require('../config/database');
const { Race } = require('../models');
const racetimeAPI = require('../services/racetime');

async function run() {
  const id = process.argv[2];
  if (!id) {
    console.error('Usage: node scripts/fix-single-race.js <raceId>');
    process.exit(2);
  }

  try {
    await connectDB();

    const race = await Race.findById(id).lean();
    if (!race) {
      console.error('Race not found for id:', id);
      process.exit(1);
    }

    console.log('Found race:', race.url);
    console.log('Current info length:', (race.info || '').length);
    console.log('Current info lines:', (race.info || '').split('\n').length);
    console.log('Current info preview:\n', (race.info || '').substring(0, 400));

    const parts = (race.url || '').split('/').filter(p => p);
    if (parts.length < 2) {
      console.error('Cannot parse race url:', race.url);
      process.exit(1);
    }

    const category = parts[0];
    const slug = parts[1];

    console.log('\nFetching detailed race from racetime:', category + '/' + slug);
    const detailed = await racetimeAPI.getRace(category, slug);

    if (!detailed || !detailed.info) {
      console.log('No info found in racetime response');
      process.exit(0);
    }

    console.log('API info length:', detailed.info.length);
    console.log('API info lines:', detailed.info.split('\n').length);
    console.log('API info preview:\n', detailed.info.substring(0, 400));

    if ((detailed.info || '').length > (race.info || '').length) {
      console.log('\nUpdating race.info in DB...');
      await Race.findByIdAndUpdate(id, { info: detailed.info });
      const updated = await Race.findById(id).lean();
      console.log('Updated info length:', (updated.info || '').length);
      console.log('Updated info lines:', (updated.info || '').split('\n').length);
      console.log('Updated info preview:\n', (updated.info || '').substring(0, 400));
    } else {
      console.log('\nNo update required (DB info is same or longer).');
    }

    process.exit(0);
  } catch (err) {
    console.error('Error:', err.message || err);
    process.exit(1);
  }
}

run();
