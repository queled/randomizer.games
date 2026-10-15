#!/usr/bin/env node
/**
 * Check Challonge quota
 *
 * Sends one Challonge API request to tell whether the plan's quota (500 requests per
 * 30 days, sliding window) lets requests through again. Run daily by the crontab
 * (task `challonge-check`): the admin health page shows it in error while the quota
 * is exhausted.
 *
 * Usage:
 *   node scripts/check-challonge-quota.js
 *
 * Exit code: 0 the API answers, 1 quota exhausted (429), 2 other error.
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const connectDB = require('../config/database');
const { Tournament } = require('../models');
const challongeAPI = require('../services/challonge');

async function main() {
  await connectDB();
  const tournament = await Tournament.findOne({ challongeId: { $ne: null } })
    .sort({ challongeSyncedAt: -1 })
    .select('challongeId')
    .lean();
  await mongoose.disconnect();
  if (!tournament) {
    console.error('❌ Aucun tournoi Challonge en base pour tester l\'API');
    return 2;
  }

  // A tournament read, as the syncs do: the tournament list answers even when the
  // quota is exhausted. Without participants and matches, the lightest one.
  try {
    await challongeAPI.get(`/tournaments/${tournament.challongeId}.json`);
    console.log('✅ API Challonge disponible');
    return 0;
  } catch (error) {
    if (error.code === 'CHALLONGE_QUOTA') {
      const detail = error.response?.data?.errors?.detail || error.message;
      console.log(`⛔ Quota API Challonge épuisé : ${detail}`);
      return 1;
    }
    console.error(`❌ Erreur API Challonge : ${error.response?.status || ''} ${error.message}`);
    return 2;
  }
}

main().then(code => process.exit(code));
