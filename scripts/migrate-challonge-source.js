#!/usr/bin/env node

/**
 * Migration: populate `source` field for tournaments imported from Challonge
 * - For tournaments that have `challongeId` and missing or non-challonge `source`,
 *   set `source.type = 'challonge'`, `source.externalId = String(challongeId)`,
 *   `source.url = fullUrl || url` and `source.importedAt = new Date()`.
 *
 * Usage: node scripts/migrate-challonge-source.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer';

(async function main(){
  try {
    await mongoose.connect(MONGODB_URI);
    const { Tournament } = require('../models');

    console.log('Searching for tournaments with challongeId but missing source/challonge source...');

    const cursor = Tournament.find({ challongeId: { $exists: true, $ne: null } }).cursor();
    let total = 0;
    let updated = 0;

    for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
      total++;
      const needsUpdate = !doc.source || (doc.source && doc.source.type !== 'challonge');
      if (!needsUpdate) continue;

      const payload = {
        type: 'challonge',
        externalId: String(doc.challongeId),
        url: doc.fullUrl || doc.url || null,
        importedAt: new Date()
      };

      await Tournament.updateOne({ _id: doc._id }, { $set: { source: payload }, $currentDate: { updatedAt: true } });
      updated++;
      if (updated % 20 === 0) console.log(`  Updated ${updated} so far...`);
    }

    console.log(`Done. Processed ${total} tournaments, updated ${updated}.`);
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    // allowed to hang until exit
  }
})();
