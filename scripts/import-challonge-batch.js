#!/usr/bin/env node
/**
 * Import a list of Challonge brackets while spending as little quota as possible
 * (500 requests per 30 days): each bracket costs one request, made once, its answer
 * kept on disk so it can be reviewed, then imported, without asking again.
 *
 * Plan file: JSON array, in priority order, of
 *   { "url": "https://alttpr.challonge.com/main2023", "game": "alttp",
 *     "group": "Event name", "label": "Phase" }   // group/label: several brackets of one event
 *
 * Usage:
 *   node scripts/import-challonge-batch.js <plan.json> --fetch [--limit N]  # API requests, into the cache
 *   node scripts/import-challonge-batch.js <plan.json> --summary            # what the cache holds, no request
 *   node scripts/import-challonge-batch.js <plan.json> --import             # cache → database, no request
 *
 * Cache: CHALLONGE_CACHE_DIR, or ~/challonge-cache.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

process.env.CHALLONGE_CACHE_DIR = process.env.CHALLONGE_CACHE_DIR || path.join(os.homedir(), 'challonge-cache');

const connectDB = require('../config/database');
const challongeAPI = require('../services/challonge');
const { importChallongeTournament, parseChallongeRef, getKnownChallongeUrls } = require('./discover-tournaments');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const [planFile, ...args] = process.argv.slice(2);
  const mode = ['--fetch', '--summary', '--import'].find(flag => args.includes(flag));
  if (!planFile || !mode) {
    console.error('Usage: node scripts/import-challonge-batch.js <plan.json> --fetch|--summary|--import [--limit N]');
    process.exit(1);
  }
  const limitIndex = args.indexOf('--limit');
  const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : Infinity;

  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8')).map(entry => ({ ...entry, ref: parseChallongeRef(entry.url) }));
  const unresolved = plan.filter(entry => !entry.ref);
  unresolved.forEach(entry => console.log(`⚠️  Not a Challonge bracket URL: ${entry.url}`));

  await connectDB();
  const knownUrls = await getKnownChallongeUrls();
  let requests = 0;

  for (const entry of plan.filter(e => e.ref)) {
    const { ref } = entry;
    const cached = challongeAPI.readCache(ref.apiId);

    if (mode === '--fetch') {
      if (cached) continue;
      if (knownUrls.has(ref.url.toLowerCase())) { console.log(`↪ Already in the database: ${ref.url}`); continue; }
      if (requests >= limit) break;
      requests++;
      try {
        const { tournamentData: t, matches } = await challongeAPI.getTournamentDetails(ref.apiId);
        console.log(`✅ ${ref.apiId}: ${t.name} [${t.gameName || 'no game'}] ${t.participantsCount} players, ${matches.length} matches, ${t.state}`);
      } catch (err) {
        if (err.code === 'CHALLONGE_QUOTA') { console.log(`⛔ Quota exhausted after ${requests} requests (${ref.apiId} not fetched)`); break; }
        console.log(`❌ ${ref.apiId}: ${err.response?.status || err.message}`);
        // A final answer (404, private bracket): remembered so it is not asked again
        if (err.response) challongeAPI.writeCache(ref.apiId, { error: err.response.status });
      }
      await sleep(1000);
      continue;
    }

    if (!cached) { console.log(`… not fetched yet: ${ref.apiId}`); continue; }
    if (cached.error) { console.log(`❌ ${ref.apiId}: HTTP ${cached.error}`); continue; }
    const details = await challongeAPI.getTournamentDetails(ref.apiId);
    const t = details.tournamentData;

    if (mode === '--summary') {
      const dates = [t.startedAt, t.completedAt].map(d => (d ? String(d).slice(0, 10) : '?')).join(' → ');
      const known = knownUrls.has(ref.url.toLowerCase()) ? ' (in database)' : '';
      console.log(`${ref.apiId}${known}\n   ${t.name} [${t.gameName || 'no game'}] ${t.tournamentType}, ${t.participantsCount} players, ${details.matches.length} matches, ${t.state}, ${dates}${t.hasGroupStages ? ', group stage' : ''}`);
      continue;
    }

    await importChallongeTournament({ name: t.name, url: ref.apiId }, entry.game || null, {
      group: entry.group || null,
      label: entry.label || null,
      discoveredVia: entry.discoveredVia || null,
      details
    });
  }

  if (mode === '--fetch') console.log(`\n${requests} API request(s) spent`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('❌', err);
  process.exit(1);
});
