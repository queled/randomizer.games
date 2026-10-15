#!/usr/bin/env node
/**
 * Sync Speedrace VODs
 *
 * Reads the restream planning of the tournaments on
 * https://speedrace.deeplydevs.com and adds the VOD links restreamers entered
 * there to the restreams already found on Mido's House
 * (`midosHouse.pastRestreams`, see sync-schedule-sites.js), when none was found yet.
 *
 * A Speedrace restream is the Mido's House race restreamed on the same Twitch
 * channel at the same time, whichever tournament it is stored on: that is how
 * a Speedrace season finds its tournament. A Twitch VOD is only kept while
 * Twitch still has it.
 *
 * Usage:
 *   node scripts/sync-speedrace.js
 *   node scripts/sync-speedrace.js --all-seasons      # past seasons too
 *   node scripts/sync-speedrace.js --dry-run
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const connectDB = require('../config/database');
const { Tournament } = require('../models');
const speedrace = require('../services/speedrace');
const twitchVods = require('../services/twitch-vods');
const { normalizeName } = require('../helpers/restream-titles');

const REQUEST_DELAY_MS = 1000;
// Mido's House and Speedrace both give the scheduled time: they agree, give or take a reschedule
const SAME_RACE_MS = 3600 * 1000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry-run'),
    allSeasons: args.includes('--all-seasons')
  };
}

// Matches of the seasons to read, with the season they come from
async function loadMatches({ allSeasons }) {
  const seasons = [];
  for (const game of await speedrace.listGames()) {
    for (const tournament of await speedrace.listTournaments(game.slug)) {
      await sleep(REQUEST_DELAY_MS);
      const active = await speedrace.getPlanning(game.slug, tournament.slug);
      seasons.push({ label: `${game.slug}/${tournament.slug}/${active.season}`, ...active });
      if (!allSeasons) continue;
      for (const slug of active.seasons.filter(s => s !== active.season)) {
        await sleep(REQUEST_DELAY_MS);
        const planning = await speedrace.getPlanning(game.slug, tournament.slug, slug);
        seasons.push({ label: `${game.slug}/${tournament.slug}/${slug}`, ...planning });
      }
    }
  }
  return seasons;
}

// Whether a Mido's House race and a Speedrace match share a player
function samePlayers(race, match) {
  const entrants = (race.entrants || []).map(normalizeName).filter(n => n.length >= 3);
  return match.players.map(normalizeName).filter(n => n.length >= 3)
    .some(p => entrants.some(e => e === p || e.includes(p) || p.includes(e)));
}

// The Mido's House race and restream a Speedrace restream is about
function findStream(races, match, login) {
  const start = match.startAt.getTime();
  const candidates = races
    .filter(({ race }) => Math.abs(new Date(race.startAt).getTime() - start) <= SAME_RACE_MS)
    .map(entry => ({ ...entry, stream: entry.race.restreams.find(s => twitchVods.twitchLogin(s.url) === login) }))
    .filter(entry => entry.stream)
    .sort((a, b) => samePlayers(b.race, match) - samePlayers(a.race, match)
      || Math.abs(new Date(a.race.startAt) - start) - Math.abs(new Date(b.race.startAt) - start));
  return candidates[0] || null;
}

async function main() {
  const opts = parseArgs();
  if (opts.dryRun) console.log('📋 Mode DRY-RUN : rien n’est écrit en base');

  await connectDB();

  const seasons = await loadMatches(opts);
  console.log(`\n🏁 ${seasons.length} saison(s) sur Speedrace`);

  const restreamed = seasons.flatMap(s => s.matches.filter(m => m.startAt && m.restreams.length).map(m => ({ season: s, match: m })));
  const stats = { restreams: 0, linked: 0, vods: 0, added: 0, same: 0, differ: 0, gone: 0, notFound: 0 };
  if (!restreamed.length) {
    await mongoose.disconnect();
    return;
  }

  // Tournaments with restreamed races over the period the seasons cover
  const times = restreamed.map(({ match }) => match.startAt.getTime());
  const tournaments = await Tournament.find({
    'midosHouse.pastRestreams': {
      $elemMatch: { startAt: { $gte: new Date(Math.min(...times) - SAME_RACE_MS), $lte: new Date(Math.max(...times) + SAME_RACE_MS) } }
    }
  }).select('_id name midosHouse.pastRestreams').lean();
  const races = tournaments.flatMap(tournament => tournament.midosHouse.pastRestreams.map(race => ({ tournament, race })));

  // Pairs (Speedrace restream with a VOD, Mido's House restream without one), by season
  const toAdd = [];
  const linkedBySeason = new Map();
  for (const { season, match } of restreamed) {
    for (const restream of match.restreams) {
      const login = twitchVods.twitchLogin(restream.url);
      if (!login) continue;
      stats.restreams++;
      const found = findStream(races, match, login);
      if (!found) {
        if (restream.vodUrl) stats.notFound++;
        continue;
      }
      stats.linked++;
      if (!linkedBySeason.has(season.label)) linkedBySeason.set(season.label, new Map());
      const counts = linkedBySeason.get(season.label);
      counts.set(found.tournament.name, (counts.get(found.tournament.name) || 0) + 1);

      if (!restream.vodUrl) continue;
      stats.vods++;
      if (found.stream.vodUrl) {
        const ours = twitchVods.videoId(found.stream.vodUrl) || found.stream.vodUrl;
        const theirs = twitchVods.videoId(restream.vodUrl) || restream.vodUrl;
        if (ours === theirs) {
          stats.same++;
        } else {
          // The past broadcast found at the race start is kept
          stats.differ++;
          console.log(`   ↔️  ${found.tournament.name} ${match.startAt.toISOString().slice(0, 16)} ${login} : ${found.stream.vodUrl} gardée, Speedrace donne ${restream.vodUrl}`);
        }
        continue;
      }
      toAdd.push({ ...found, match, vodUrl: restream.vodUrl });
    }
  }

  for (const [label, counts] of linkedBySeason) {
    console.log(`   🔗 ${label} → ${[...counts].map(([name, n]) => `${name} (${n} restream(s))`).join(', ')}`);
  }

  // Twitch VODs deleted since they were entered on Speedrace are left out
  const existing = await twitchVods.getExistingVideoIds(toAdd.map(a => twitchVods.videoId(a.vodUrl)).filter(Boolean));
  const changed = new Map();
  for (const { tournament, race, stream, match, vodUrl } of toAdd) {
    const id = twitchVods.videoId(vodUrl);
    if (id && !existing.has(id)) {
      stats.gone++;
      continue;
    }
    stream.vodUrl = vodUrl;
    delete stream.vodGoneAt;
    stats.added++;
    changed.set(String(tournament._id), tournament);
    console.log(`   🎬 ${tournament.name} ${new Date(race.startAt).toISOString().slice(0, 16)} ${(race.entrants || []).join(' vs ') || match.players.join(' vs ')} → ${vodUrl}`);
  }

  if (!opts.dryRun) {
    for (const tournament of changed.values()) {
      await Tournament.updateOne({ _id: tournament._id }, { $set: { 'midosHouse.pastRestreams': tournament.midosHouse.pastRestreams } });
    }
  }

  console.log('\n📊 Résumé Speedrace');
  console.log(`Restreams Twitch : ${stats.restreams}`);
  console.log(`Retrouvés sur Mido's House : ${stats.linked}`);
  console.log(`Avec une VOD sur Speedrace : ${stats.vods}`);
  console.log(`VOD ajoutées : ${stats.added}`);
  console.log(`VOD déjà connues : ${stats.same}`);
  console.log(`VOD différentes (la nôtre gardée) : ${stats.differ}`);
  console.log(`VOD supprimées par Twitch : ${stats.gone}`);
  console.log(`VOD sans race Mido's House en base : ${stats.notFound}`);

  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
