#!/usr/bin/env node
/**
 * Sync race VODs
 *
 * Racers stream their races: for each finished racetime.gg race, reads each
 * entrant's Twitch channel on racetime.gg and finds the past broadcast
 * covering the race start, linked at that moment (`race.vods`).
 * Then drops the VODs Twitch has deleted since, keeping the channel.
 *
 * A race is looked up until 12 h after its end (the VOD can show up late),
 * then left alone. Twitch keeps past broadcasts 7 to 60 days: a tournament race
 * imported later (qualifiers attached afterwards) is looked up once if under 60 days.
 *
 * Usage:
 *   node scripts/sync-race-vods.js               # races of the last 2 days
 *   node scripts/sync-race-vods.js --days 60     # backfill, as far as Twitch keeps VODs
 *   node scripts/sync-race-vods.js --dry-run
 *   node scripts/sync-race-vods.js --tournament <id>   # all the races of a tournament
 */

const path = require('path');
const axios = require('axios');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const connectDB = require('../config/database');
const { Race } = require('../models');
const twitchVods = require('../services/twitch-vods');

const RACETIME_DELAY_MS = 500;
const RETRY_AFTER_END_MS = 12 * 3600 * 1000;
const BATCH_SIZE = 50;
const MAX_VOD_AGE_MS = 60 * 24 * 3600 * 1000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, days: 2, tournament: null };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dry-run': opts.dryRun = true; break;
      case '--days': opts.days = Math.min(60, Math.max(1, parseInt(args[++i], 10) || 2)); break;
      case '--tournament': opts.tournament = args[++i]; break;
    }
  }
  return opts;
}

// Twitch channel of each entrant, from the racetime.gg race data
async function getEntrantChannels(raceUrl) {
  const { data } = await axios.get(`https://racetime.gg${raceUrl}/data`, {
    timeout: 20000,
    headers: { 'User-Agent': 'RandomizerWebsite/1.0' }
  });
  return (data.entrants || [])
    .map(e => ({ userId: e.user && e.user.id, userName: e.user && e.user.name, twitchName: e.user && e.user.twitch_name }))
    .filter(e => e.userId && e.twitchName && /^[A-Za-z0-9_]{1,25}$/.test(e.twitchName))
    .map(e => ({ ...e, twitchName: e.twitchName.toLowerCase() }));
}

async function findRaceVods({ dryRun, days, tournament }, stats) {
  const now = Date.now();
  const races = (await Race.find({
    status: 'finished',
    ...(tournament ? { tournamentId: tournament } : {
      $or: [
        { startedAt: { $gte: new Date(now - days * 24 * 3600 * 1000) } },
        // Tournament races imported late (qualifiers attached afterwards), as far as Twitch keeps VODs
        { tournamentId: { $ne: null }, vodSearchedAt: { $exists: false }, startedAt: { $gte: new Date(now - MAX_VOD_AGE_MS) } }
      ]
    }),
    url: /^\/[^/]+\/[^/]+$/
  }).select('_id url name startedAt endedAt vods vodSearchedAt').lean())
    // Looked up until 12 h after the race end, then left alone
    .filter(r => !r.vodSearchedAt || new Date(r.vodSearchedAt).getTime() < new Date(r.endedAt || r.startedAt).getTime() + RETRY_AFTER_END_MS);
  if (!races.length) return;
  console.log(`\n🏁 ${races.length} race(s) à chercher`);

  // A channel's past broadcasts serve all its races of the run
  const userIds = new Map();
  const archivesByLogin = new Map();
  const getArchives = async login => {
    if (!archivesByLogin.has(login)) {
      archivesByLogin.set(login, userIds.get(login) ? await twitchVods.getArchives(userIds.get(login)) : []);
    }
    return archivesByLogin.get(login);
  };

  // By batches, each one saved before the next: an interrupted backfill resumes where it stopped
  for (let i = 0; i < races.length; i += BATCH_SIZE) {
    // Each race's entrants with a Twitch channel and no VOD yet
    const pending = [];
    for (const race of races.slice(i, i + BATCH_SIZE)) {
      await sleep(RACETIME_DELAY_MS);
      try {
        const done = new Set((race.vods || []).filter(v => v.vodUrl).map(v => v.userId));
        const channels = (await getEntrantChannels(race.url)).filter(c => !done.has(c.userId));
        pending.push({ race, channels });
      } catch (error) {
        console.log(`   ❌ ${race.url} : ${error.message}`);
        stats.errors++;
      }
    }

    const unknown = [...new Set(pending.flatMap(p => p.channels.map(c => c.twitchName)))].filter(l => !userIds.has(l));
    if (unknown.length) {
      const found = await twitchVods.getUserIds(unknown);
      unknown.forEach(login => userIds.set(login, found.get(login) || null));
    }

    for (const { race, channels } of pending) {
      const vods = (race.vods || []).slice();
      let found = 0;
      for (const channel of channels) {
        const vodUrl = twitchVods.findVod(await getArchives(channel.twitchName), race.startedAt);
        const existing = vods.find(v => v.userId === channel.userId);
        const entry = existing || { userId: channel.userId };
        entry.userName = channel.userName;
        entry.twitchName = channel.twitchName;
        if (vodUrl) {
          entry.vodUrl = vodUrl;
          delete entry.vodGoneAt;
          found++;
        }
        if (!existing) vods.push(entry);
      }
      stats.races++;
      stats.vods += found;
      if (!dryRun) {
        await Race.updateOne({ _id: race._id }, { $set: { vods, vodSearchedAt: new Date() } });
      }
    }
    console.log(`   ${Math.min(i + BATCH_SIZE, races.length)}/${races.length} races, ${stats.vods} VOD`);
  }
}

// VODs Twitch has deleted since they were found: the link goes, the channel stays
async function checkVods({ dryRun }, stats) {
  const races = await Race.find({ 'vods.vodUrl': { $type: 'string' } }).select('_id vods').lean();
  const ids = races.flatMap(r => r.vods.map(v => twitchVods.videoId(v.vodUrl)).filter(Boolean));
  if (!ids.length) return;

  const existing = await twitchVods.getExistingVideoIds(ids);
  console.log(`\n🔎 VOD de joueurs vérifiées : ${new Set(ids).size}, encore en ligne : ${existing.size}`);
  for (const race of races) {
    let gone = 0;
    for (const vod of race.vods) {
      const id = twitchVods.videoId(vod.vodUrl);
      if (!id || existing.has(id)) continue;
      delete vod.vodUrl;
      vod.vodGoneAt = new Date();
      gone++;
    }
    if (!gone) continue;
    stats.vodsGone += gone;
    if (!dryRun) await Race.updateOne({ _id: race._id }, { $set: { vods: race.vods } });
  }
}

async function main() {
  const opts = parseArgs();
  if (opts.dryRun) console.log('📋 Mode DRY-RUN : rien n’est écrit en base');

  await connectDB();
  const stats = { races: 0, vods: 0, vodsGone: 0, errors: 0 };

  try {
    await checkVods(opts, stats);
    await findRaceVods(opts, stats);
  } catch (error) {
    console.log(`   ❌ ${error.message}`);
    stats.errors++;
  }

  console.log('\n📊 Résumé VOD des joueurs');
  console.log(`Races cherchées : ${stats.races}`);
  console.log(`VOD trouvées : ${stats.vods}`);
  console.log(`VOD supprimées par Twitch : ${stats.vodsGone}`);
  console.log(`Erreurs : ${stats.errors}`);

  await mongoose.disconnect();
  if (stats.errors) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
