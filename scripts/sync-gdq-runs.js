#!/usr/bin/env node
/**
 * Sync the randomizer runs of Games Done Quick marathons
 *
 * GDQ marathons regularly feature
 * randomizer runs and races. The GDQ tracker (services/gdq.js) lists each run
 * with its game, category, runners and YouTube VOD, added after the marathon.
 * A run counts when its category or name speaks of a randomizer ("Random
 * Seed" of roguelikes does not); it goes to the `marathonruns` collection,
 * with the game of the site it is a randomizer of:
 *   - the Twitch category of the run, when given, among the games' Twitch
 *     categories (when several games share it, the one the run names, else
 *     the game whose official name is that category: the base game rather than its hacks);
 *   - else its name, "Randomizer" and "BONUS GAME n -" aside, against the
 *     games' names;
 *   - GAME_HINTS for names neither finds (combo randomizers).
 * Runs of a game the site does not have are left out (listed in the output).
 *
 * Usage:
 *   node scripts/sync-gdq-runs.js                 # marathons of the last 400 days
 *   node scripts/sync-gdq-runs.js --all           # every marathon (one-off backfill)
 *   node scripts/sync-gdq-runs.js --dry-run
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const connectDB = require('../config/database');
const { Game, MarathonRun } = require('../models');
const gdq = require('../services/gdq');

const SOURCE = 'gdq';
// VODs are added weeks after a marathon: recent ones are read again
const RECENT_DAYS = 400;
const RANDOMIZER_RE = /\brando\b|randomi[sz]er|archipelago|multiworld/i;
// Run name → game id, for names the Twitch category and game names do not find
const GAME_HINTS = [
  [/link to the past.*super metroid|super metroid.*link to the past/i, 'smz3']
];

function parseArgs() {
  const args = process.argv.slice(2);
  return { dryRun: args.includes('--dry-run'), all: args.includes('--all') };
}

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');

// "BONUS GAME 2 - Game Name Randomizer" → "Game Name"
function cleanName(name) {
  return String(name || '').replace(/\s+/g, ' ').replace(/^bonus game\s*\d*\s*-\s*/i, '').replace(/\s*\brandomi[sz]er\b\s*/ig, ' ').trim();
}

function gameMatcher(games) {
  const byId = new Map(games.map(g => [g.id, g]));
  const byTwitch = new Map();
  const byName = new Map();
  for (const g of games) {
    const category = norm(g.integrations?.twitch?.categoryName);
    if (category) byTwitch.set(category, [...(byTwitch.get(category) || []), g]);
    for (const n of [g.name, g.official?.name, g.randomizer?.displayName].map(norm).filter(Boolean)) {
      if (!byName.has(n)) byName.set(n, g);
    }
  }
  return run => {
    const hint = GAME_HINTS.find(([re]) => re.test(run.name));
    if (hint) return byId.get(hint[1]) || null;
    const category = norm(run.twitch_name);
    const sameCategory = category ? byTwitch.get(category) || [] : [];
    const named = byName.get(norm(cleanName(run.name)));
    if (sameCategory.length) {
      // Several games share the category (a game and its remaster, its hacks): the run's name, else the category's own game
      return (named && sameCategory.includes(named) ? named : null)
        || sameCategory.find(g => norm(g.official?.name) === category || norm(g.name) === category) || sameCategory[0];
    }
    return named || null;
  };
}

async function main() {
  const opts = parseArgs();
  if (opts.dryRun) console.log('📋 Mode DRY-RUN : rien n’est écrit en base');
  await connectDB();
  const stats = { events: 0, runs: 0, saved: 0, videos: 0, unknownGame: 0, errors: 0 };

  try {
    const games = await Game.find({}).select('_id id name official.name randomizer.displayName integrations.twitch.categoryName').lean();
    const findGame = gameMatcher(games);
    const since = Date.now() - RECENT_DAYS * 24 * 3600 * 1000;
    const events = (await gdq.listEvents()).filter(e => opts.all || new Date(e.datetime).getTime() >= since);
    console.log(`\n🎮 ${events.length} marathon(s) GDQ à lire`);

    for (const event of events) {
      let runs;
      try {
        runs = await gdq.listRuns(event.id);
      } catch (error) {
        console.log(`   ❌ ${event.short} : ${error.message}`);
        stats.errors++;
        continue;
      }
      stats.events++;
      for (const run of runs) {
        if (!RANDOMIZER_RE.test(`${run.category} ${run.name} ${run.display_name}`)) continue;
        stats.runs++;
        const game = findGame(run);
        if (!game) {
          stats.unknownGame++;
          console.log(`   ⚠️  ${event.short} : « ${run.name} — ${run.category} » sans jeu sur le site`);
          continue;
        }
        const videos = (run.video_links || []).filter(v => v.url).map(v => ({ type: v.link_type, url: v.url }));
        const doc = {
          source: SOURCE,
          externalId: String(run.id),
          event: { short: event.short, name: event.name },
          game: game._id,
          gameSlug: game.id,
          // Some names hold a literal "\n" where the marathon's layout breaks the line
          name: String(run.display_name || run.name).replace(/\\n|\s+/g, ' ').trim(),
          category: run.category,
          runners: (run.runners || []).map(r => r.name).filter(Boolean),
          startedAt: run.starttime ? new Date(run.starttime) : null,
          runTime: gdq.parseDuration(run.run_time),
          videos
        };
        stats.saved++;
        stats.videos += videos.length;
        console.log(`   📺 ${event.short} : ${doc.name} — ${doc.category} → ${game.id}${videos.length ? '' : ' (sans VOD)'}`);
        if (!opts.dryRun) {
          await MarathonRun.updateOne({ source: SOURCE, externalId: doc.externalId }, { $set: doc }, { upsert: true });
        }
      }
    }
  } catch (error) {
    console.log(`   ❌ ${error.message}`);
    stats.errors++;
  }

  console.log('\n📊 Résumé GDQ');
  console.log(`Marathons lus : ${stats.events}`);
  console.log(`Runs randomizer : ${stats.runs}`);
  console.log(`Runs enregistrés : ${stats.saved}`);
  console.log(`VOD : ${stats.videos}`);
  console.log(`Sans jeu sur le site : ${stats.unknownGame}`);
  console.log(`Erreurs : ${stats.errors}`);

  await mongoose.disconnect();
  if (stats.errors) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
