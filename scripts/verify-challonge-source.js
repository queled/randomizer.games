#!/usr/bin/env node

/**
 * Verify migration results: list first 5 tournaments with challongeId and their source
 */
require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer';

(async function(){
  try {
    await mongoose.connect(MONGODB_URI);
    const { Tournament } = require('../models');
    const docs = await Tournament.find({ challongeId: { $exists: true } }).limit(5).lean();
    console.log('Sample tournaments with challongeId:');
    for (const d of docs) {
      console.log('- id:', d._id.toString());
      console.log('  challongeId:', d.challongeId);
      console.log('  source:', d.source);
    }
    process.exit(0);
  } catch (err) {
    console.error('Verify failed:', err);
    process.exit(1);
  }
})();
