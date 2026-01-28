/**
 * Script to enrich existing races with missing entrant data from racetime.gg
 * 
 * Usage: node scripts/enrich-races.js
 * 
 * This script fetches the full race data from racetime.gg and updates the
 * entrants to include userName, userId, userUrl, userDiscriminator
 */

require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');
const { Race } = require('../models');

const RACETIME_BASE = 'https://racetime.gg';

function toMs(durationStr) {
  if (!durationStr) return null;
  try {
    const cleaned = durationStr.replace(/^P(?:\d+D)?T/, 'PT');
    const re = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/;
    const m = re.exec(cleaned);
    if (!m) return null;
    const h = parseInt(m[1] || 0, 10);
    const mm = parseInt(m[2] || 0, 10);
    const ss = parseFloat(m[3] || 0);
    return Math.round(((h * 3600) + (mm * 60) + ss) * 1000);
  } catch (e) {
    return null;
  }
}

async function fetchRaceFromRacetime(category, raceSlug) {
  try {
    const url = `${RACETIME_BASE}/${category}/${raceSlug}/data`;
    console.log(`  Fetching: ${url}`);
    const response = await axios.get(url, {
      headers: {
        'Accept': 'application/json'
      },
      timeout: 10000
    });
    return response.data;
  } catch (error) {
    console.error(`  Error fetching ${category}/${raceSlug}: ${error.message}`);
    return null;
  }
}

function extractRaceSlugFromUrl(url) {
  // URL like /ootr/proud-kakariko-8125 or https://racetime.gg/ootr/proud-kakariko-8125
  if (!url) return null;
  const cleaned = url.replace(/^https?:\/\/(www\.)?racetime\.gg/, '');
  const parts = cleaned.replace(/^\/+/, '').split('/').filter(Boolean);
  if (parts.length >= 2) {
    return parts[1]; // Return the race slug (e.g., proud-kakariko-8125)
  }
  return null;
}

function formatEntrant(e) {
  const finishTime = e.finish_time || null;
  const finishTimeMs = finishTime ? toMs(finishTime) : null;

  return {
    userId: e.user && e.user.id ? String(e.user.id) : null,
    userName: e.user && e.user.name ? e.user.name : null,
    userDiscriminator: e.user && e.user.discriminator ? e.user.discriminator : null,
    userUrl: e.user && e.user.url ? e.user.url : null,
    status: e.status && e.status.value ? e.status.value : (e.status || null),
    finishTime: finishTime,
    finishTimeMs: finishTimeMs,
    finishedAt: e.finished_at || null,
    place: e.place || null,
    placeOrdinal: e.place_ordinal || null,
    comment: e.comment || null
  };
}

async function enrichRace(race) {
  const raceSlug = extractRaceSlugFromUrl(race.url || race.name);
  if (!raceSlug) {
    console.log(`  Cannot extract race slug from: ${race.url || race.name}`);
    return false;
  }

  const raceData = await fetchRaceFromRacetime(race.category, raceSlug);
  if (!raceData || !raceData.entrants) {
    console.log(`  No data or entrants returned`);
    return false;
  }

  // Format entrants
  const entrants = raceData.entrants.map(formatEntrant);

  // Update the race
  await Race.updateOne(
    { _id: race._id },
    {
      $set: {
        entrants: entrants,
        goal: raceData.goal ? raceData.goal.name : race.goal,
        info: raceData.info || race.info,
        status: raceData.status && raceData.status.value ? raceData.status.value : race.status,
        startedAt: raceData.started_at || race.startedAt,
        endedAt: raceData.ended_at || race.endedAt
      }
    }
  );

  console.log(`  Updated with ${entrants.length} entrants`);
  return true;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  // Find races that are missing userName in their entrants
  const races = await Race.find({
    $or: [
      { 'entrants.userName': { $exists: false } },
      { 'entrants.userName': null }
    ]
  });

  console.log(`Found ${races.length} races to enrich`);

  let enriched = 0;
  let failed = 0;

  for (const race of races) {
    console.log(`\nProcessing race: ${race.category}/${race.url || race.name}`);
    
    try {
      const success = await enrichRace(race);
      if (success) {
        enriched++;
      } else {
        failed++;
      }
    } catch (error) {
      console.error(`  Error: ${error.message}`);
      failed++;
    }

    // Rate limiting - wait 500ms between requests
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log(`\n=== Summary ===`);
  console.log(`Enriched: ${enriched}`);
  console.log(`Failed: ${failed}`);

  await mongoose.disconnect();
  console.log('Done');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
