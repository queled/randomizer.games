#!/usr/bin/env node
/**
 * Sync async series of alttprasyncs.com onto their tournaments
 *
 * A series goes to the tournament it is about, found by name: the same kind
 * of tournament (main, co-op, spoiler...) and the same year, or
 * season / edition number. Ambiguous or unmatched series are listed; --link
 * ties one by hand. Stored in `tournament.alttprAsyncs`:
 *   - practice series: title, link and seed count;
 *   - qualifier series: each seed with its racetime.gg room and its results
 *     (live and async finishers together), read again while recent.
 *
 * Usage:
 *   node scripts/sync-alttpr-asyncs.js
 *   node scripts/sync-alttpr-asyncs.js --link <seriesId> <tournamentId>     # by hand, kept
 *   node scripts/sync-alttpr-asyncs.js --unlink <seriesId> <tournamentId>
 *   node scripts/sync-alttpr-asyncs.js --dry-run
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const connectDB = require('../config/database');
const { Tournament, Game } = require('../models');
const asyncs = require('../services/alttpr-asyncs');

// Results of a qualifier seed are read again this long: asyncs come in after the live race
const RESULTS_FRESH_MS = 30 * 24 * 3600 * 1000;

// Kinds of tournament, as their names say them
const KINDS = {
  main: /\bmain (?:tournament|tourney|tnmt)\b/,
  coop: /\bco-?op\b/,
  crosskeys: /\bcross ?keys\b/,
  cabookey: /\bcabookey\b/,
  pilot: /\bpilot\b/,
  spoiler: /\bspoiler\b/,
  enemizer: /\benemizer\b/,
  boots: /\bcasual boots\b/,
  nologic: /\bno ?logic\b/,
  hmg: /\bhmg\b|\bhybrid major\b/,
  glitched: /\bglitched\b/,
  mentor: /\bmentor\b|\bmt\b/,
  league: /\bleague\b/,
  doors: /\bdoors\b/,
  xdhunt: /\bxdhunt\b/,
  adkdf: /\badkdf\b/,
  inverted: /\binverted\b/,
  francophone: /\bfrancophone\b/,
  beer: /\bbeer\b/
};

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, link: null, unlink: null };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dry-run': opts.dryRun = true; break;
      case '--link': opts.link = { seriesId: Number(args[++i]), tournamentId: args[++i] }; break;
      case '--unlink': opts.unlink = { seriesId: Number(args[++i]), tournamentId: args[++i] }; break;
    }
  }
  return opts;
}

// "<Kind> Tournament 2025 - Main Event" → { kinds: '<kind>', year: 2025, number: null }
function describe(name, fallbackYear = null) {
  const lower = String(name || '').toLowerCase().replace(/\s*-?\s*main event\b/g, ' ');
  const kinds = Object.keys(KINDS).filter(k => KINDS[k].test(lower)).sort().join('+');
  const year = (lower.match(/\b(20\d\d)\b/) || [])[1];
  const number = (lower.match(/\b(?:season|saison|s)\s?(\d{1,2})\b|\b(\d{1,2})(?:e|ème|th)? (?:édition|edition)\b/) || []).slice(1).find(Boolean);
  return { kinds, year: year ? Number(year) : fallbackYear, number: number ? Number(number) : null };
}

function sameTournament(series, tournament) {
  if (!series.kinds || series.kinds !== tournament.kinds) return false;
  if (series.number && tournament.number) return series.number === tournament.number;
  return !!series.year && series.year === tournament.year;
}

async function main() {
  const opts = parseArgs();
  if (opts.dryRun) console.log('📋 Mode DRY-RUN : rien n’est écrit en base');
  await connectDB();
  const stats = { series: 0, linked: 0, qualifierSeeds: 0, ambiguous: 0, errors: 0 };

  const games = await Game.find({ id: 'alttp' }).select('_id').lean();
  const tournaments = await Tournament.find({ game: { $in: games.map(g => g._id) } })
    .select('_id name startDate alttprAsyncs').lean();
  const described = tournaments.map(t => ({ t, ...describe(t.name, t.startDate ? new Date(t.startDate).getUTCFullYear() : null) }));

  if (opts.link || opts.unlink) {
    const { seriesId, tournamentId } = opts.link || opts.unlink;
    const tournament = tournaments.find(t => String(t._id) === String(tournamentId));
    if (!tournament || !seriesId) throw new Error(`Tournoi ALTTPR ${tournamentId} ou série ${seriesId} introuvable`);
    const kept = (tournament.alttprAsyncs || []).filter(s => s.seriesId !== seriesId);
    tournament.alttprAsyncs = opts.link ? kept.concat({ seriesId, manual: true }) : kept;
    if (!opts.dryRun) await Tournament.updateOne({ _id: tournament._id }, { $set: { alttprAsyncs: tournament.alttprAsyncs } });
    console.log(`${opts.link ? '🔗' : '✂️'} Série ${seriesId} ${opts.link ? '→' : '✗'} ${tournament.name}`);
  }

  const allSeries = await asyncs.listSeries();
  console.log(`\n📚 ${allSeries.length} série(s) sur alttprasyncs.com`);

  // Series of each tournament: by hand, then by name
  const seriesOf = new Map(tournaments.map(t => [String(t._id), (t.alttprAsyncs || []).filter(s => s.manual).map(s => s.seriesId)]));
  const manualIds = new Set(tournaments.flatMap(t => (t.alttprAsyncs || []).filter(s => s.manual).map(s => s.seriesId)));
  for (const series of allSeries) {
    if (manualIds.has(series.id)) continue;
    const info = describe(series.title);
    if (!info.kinds) continue;
    const matches = described.filter(d => sameTournament(info, d));
    if (matches.length === 1) {
      seriesOf.get(String(matches[0].t._id)).push(series.id);
    } else if (matches.length > 1) {
      stats.ambiguous++;
      console.log(`   ❓ « ${series.title} » (${series.id}) : ${matches.map(d => d.t.name).join(' / ')}`);
    }
  }

  const byId = new Map(allSeries.map(s => [s.id, s]));
  for (const tournament of tournaments) {
    const ids = seriesOf.get(String(tournament._id));
    const previous = new Map((tournament.alttprAsyncs || []).map(s => [s.seriesId, s]));
    if (!ids.length && !previous.size) continue;
    const entries = [];
    for (const seriesId of ids) {
      const series = byId.get(seriesId);
      const before = previous.get(seriesId) || {};
      if (!series) {
        // Gone from the site: keep what was read
        if (before.title) entries.push(before);
        continue;
      }
      try {
        const seeds = await asyncs.getSeriesSeeds(seriesId);
        const qualifier = /qualif/i.test(series.title);
        const entry = {
          seriesId,
          title: series.title,
          url: series.url,
          qualifier,
          manual: before.manual || undefined,
          seedCount: seeds.length,
          syncedAt: new Date(),
          seeds: []
        };
        if (qualifier) {
          const known = new Map((before.seeds || []).map(s => [s.asyncId, s]));
          for (const seed of seeds) {
            const old = known.get(seed.asyncId);
            const fresh = !seed.createdAt || Date.now() - seed.createdAt.getTime() < RESULTS_FRESH_MS;
            const results = old && old.results && old.results.length && !fresh ? old : await asyncs.getResults(seed.asyncId);
            entry.seeds.push({
              asyncId: seed.asyncId,
              createdAt: seed.createdAt,
              mode: seed.mode,
              description: seed.description,
              roomUrl: seed.roomUrl,
              participants: results.participants,
              finishers: results.finishers,
              results: results.results
            });
            stats.qualifierSeeds++;
          }
          entry.seeds.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        }
        entries.push(entry);
        stats.series++;
        console.log(`   🔗 ${tournament.name} ← « ${series.title} » (${seeds.length} seed(s)${qualifier ? ', qualifs' : ''})`);
      } catch (error) {
        console.log(`   ❌ Série ${seriesId} : ${error.message}`);
        if (before.title) entries.push(before);
        stats.errors++;
      }
    }
    stats.linked++;
    if (!opts.dryRun) await Tournament.updateOne({ _id: tournament._id }, { $set: { alttprAsyncs: entries } });
  }

  console.log('\n📊 Résumé alttprasyncs');
  console.log(`Séries rattachées : ${stats.series}`);
  console.log(`Tournois mis à jour : ${stats.linked}`);
  console.log(`Seeds de qualif lues : ${stats.qualifierSeeds}`);
  console.log(`Séries ambiguës : ${stats.ambiguous}`);
  console.log(`Erreurs : ${stats.errors}`);

  await mongoose.disconnect();
  if (stats.errors) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
