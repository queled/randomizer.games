#!/usr/bin/env node
/**
 * Sync the restreams SpeedGaming schedules
 *
 * SpeedGaming restreams tournaments on its own Twitch channels, listed nowhere else:
 * its events page gives each event's bracket and schedule (services/speedgaming.js).
 * An event whose bracket is a tournament in the base has its played matches read
 * from the schedule; each goes to `midosHouse.pastRestreams` of the tournament with
 * the start.gg set it is (same players, played within hours of its scheduled start),
 * and its channels (else the racetime.gg race of its players, for a bracket without
 * stored matches). sync-schedule-sites.js then finds the Twitch past broadcast of
 * each, as for Mido's House, and sync-race-restreams.js the YouTube upload. A match
 * Mido's House already lists with the same channel is left as it is.
 *
 * Usage:
 *   node scripts/sync-speedgaming.js              # events of tournaments running or over for less than 60 days
 *   node scripts/sync-speedgaming.js --all        # every event of the events page
 *   node scripts/sync-speedgaming.js --event <slug>   # one event (repeatable)
 *   node scripts/sync-speedgaming.js --dry-run
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const connectDB = require('../config/database');
const { Tournament, Race } = require('../models');
const speedgaming = require('../services/speedgaming');
const twitchVods = require('../services/twitch-vods');
const { normalizeName, LANGUAGE_NAMES } = require('../helpers/restream-titles');

const DAY_MS = 24 * 3600 * 1000;
// Twitch keeps past broadcasts 60 days at most
const RECENT_MS = 60 * DAY_MS;
// A match is reported done within hours of its scheduled start
const PLAYED_WITHIN_MS = 8 * 3600 * 1000;
const EARLY_MS = 3600 * 1000;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, all: false, events: [] };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dry-run': opts.dryRun = true; break;
      case '--all': opts.all = true; break;
      case '--event': opts.events.push(String(args[++i] || '').toLowerCase()); break;
    }
  }
  return opts;
}

// A bracket link as tournaments store it: "start.gg/tournament/<t>/event/<e>", "<sub.>challonge.com/<slug>"
function bracketKey(url) {
  const text = String(url || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
  const startgg = text.match(/^start\.gg\/tournament\/([^/?#]+)\/event\/([^/?#]+)/);
  if (startgg) return `start.gg/tournament/${startgg[1]}/event/${startgg[2]}`;
  const challonge = text.match(/^((?:[a-z0-9-]+\.)?challonge\.com)\/(?:[a-z]{2}\/)?([^/?#]+)/);
  if (challonge) return `${challonge[1]}/${challonge[2]}`;
  return null;
}

// A SpeedGaming display name is the player's name, sometimes shortened or with a suffix
function sameName(a, b) {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return false;
  return x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)));
}

/** The start.gg set of a scheduled match: same two players, done within hours of the start */
function findSet(entry, matches) {
  if (entry.players.length !== 2) return null;
  const when = new Date(entry.when).getTime();
  const candidates = matches.filter(m => {
    const names = [m.player1 && m.player1.name, m.player2 && m.player2.name];
    return entry.players.every(p => names.some(n => sameName(p, n)));
  });
  const timed = candidates
    .map(m => ({ m, done: new Date(m.completedAt || 0).getTime() }))
    .filter(x => x.done >= when - EARLY_MS && x.done <= when + PLAYED_WITHIN_MS)
    .sort((a, b) => Math.abs(a.done - when) - Math.abs(b.done - when));
  if (timed.length) return timed[0].m;
  return candidates.length === 1 && !candidates[0].completedAt ? candidates[0] : null;
}

/** The racetime.gg race of a scheduled match: its two players, started around the scheduled time */
function findRace(entry, races) {
  if (entry.players.length !== 2) return null;
  const when = new Date(entry.when).getTime();
  const found = races.filter(r => {
    const start = new Date(r.startedAt).getTime();
    return start >= when - EARLY_MS && start <= when + 3 * 3600 * 1000
      && entry.players.every(p => (r.entrants || []).some(e => sameName(p, e.userName)));
  });
  return found.length === 1 ? found[0] : null;
}

async function syncEvent(event, tournament, { dryRun }, stats) {
  const start = new Date(tournament.startDate || Date.now() - RECENT_MS).getTime() - 30 * DAY_MS;
  const end = Math.min(Date.now(), tournament.endDate ? new Date(tournament.endDate).getTime() + 7 * DAY_MS : Date.now());
  const schedule = (await speedgaming.getSchedule(event.slug, start, end))
    .filter(e => e.channels.length && new Date(e.when).getTime() < Date.now());
  const matches = tournament.matches || [];
  const races = matches.length ? [] : await Race.find({
    startedAt: { $gte: new Date(start), $lte: new Date(end) },
    'entrants.1': { $exists: true },
    'entrants.2': { $exists: false }
  }).select('url startedAt entrants.userName').lean();
  const past = (tournament.midosHouse && tournament.midosHouse.pastRestreams) || [];
  const loginsOf = entry => new Set((entry.restreams || []).map(s => twitchVods.twitchLogin(s.url)).filter(Boolean));

  let added = 0;
  let unmatched = 0;
  for (const entry of schedule) {
    const set = findSet(entry, matches);
    const race = set ? null : findRace(entry, races);
    if (!set && !race) unmatched++;
    const when = new Date(entry.when);
    const restreams = entry.channels.map(c => ({
      language: LANGUAGE_NAMES[String(c.language || '').split('-')[0]] || undefined,
      url: `https://twitch.tv/${c.slug}`,
      sourceUrl: `https://twitch.tv/${c.slug}`
    }));
    // Listed already (by Mido's House, or a previous run): the same set or players, around the same time
    const existing = past.find(r => (set && r.startggSetId === String(set.startggSetId)
      || entry.players.every(p => (r.entrants || []).some(n => sameName(p, n))))
      && Math.abs(new Date(r.startAt).getTime() - when.getTime()) < PLAYED_WITHIN_MS);
    if (existing) {
      const known = loginsOf(existing);
      const fresh = restreams.filter(s => !known.has(twitchVods.twitchLogin(s.url)));
      if (!fresh.length) continue;
      existing.restreams.push(...fresh);
    } else {
      const raceUrls = set ? (set.raceUrls && set.raceUrls.length ? set.raceUrls : [set.raceUrl]).filter(Boolean) : race ? [race.url] : [];
      past.push({
        startggSetId: set ? String(set.startggSetId) : undefined,
        startAt: when,
        round: entry.title || undefined,
        entrants: entry.players,
        // One race: its start dates the VOD better than the schedule
        roomUrl: raceUrls.length === 1 ? `https://racetime.gg${raceUrls[0]}` : undefined,
        restreams
      });
    }
    added++;
    console.log(`   📺 ${when.toISOString().slice(0, 16)} ${entry.players.join(' vs ')} : ${restreams.map(s => twitchVods.twitchLogin(s.url)).join(', ')}${set ? '' : race ? ` (${race.url})` : ' (ni set ni race)'}`);
  }

  console.log(`   ✅ ${event.slug} → ${tournament.name} : ${schedule.length} match(s) restreamé(s), ${added} ajouté(s), ${unmatched} sans set ni race`);
  stats.matches += schedule.length;
  stats.added += added;
  if (added && !dryRun) {
    past.sort((a, b) => new Date(b.startAt) - new Date(a.startAt));
    await Tournament.updateOne({ _id: tournament._id }, { $set: { 'midosHouse.pastRestreams': past } });
  }
}

async function main() {
  const opts = parseArgs();
  if (opts.dryRun) console.log('📋 Mode DRY-RUN : rien n’est écrit en base');
  await connectDB();
  const stats = { events: 0, matches: 0, added: 0, errors: 0 };

  const events = (await speedgaming.getEvents()).filter(e => !opts.events.length || opts.events.includes(e.slug));
  const tournaments = await Tournament.find({ $or: [{ 'source.type': 'startgg' }, { 'source.type': 'challonge' }] })
    .select('_id name fullUrl url source.url startDate endDate matches.startggSetId matches.player1.name matches.player2.name matches.completedAt matches.raceUrl matches.raceUrls midosHouse.pastRestreams').lean();
  const byBracket = new Map();
  for (const t of tournaments) {
    for (const url of [t.fullUrl, t.url, t.source && t.source.url]) {
      const key = bracketKey(url);
      if (key && !byBracket.has(key)) byBracket.set(key, t);
    }
  }

  for (const event of events) {
    const tournament = event.brackets.map(bracketKey).filter(Boolean).map(key => byBracket.get(key)).find(Boolean);
    if (!tournament) continue;
    const recent = !tournament.endDate || new Date(tournament.endDate).getTime() > Date.now() - RECENT_MS;
    if (!opts.all && !opts.events.length && !recent) continue;
    stats.events++;
    try {
      await syncEvent(event, tournament, opts, stats);
    } catch (error) {
      console.log(`   ❌ ${event.slug} : ${error.message}`);
      stats.errors++;
    }
  }

  console.log('\n📊 Résumé SpeedGaming');
  console.log(`Événements lus : ${stats.events}`);
  console.log(`Matchs restreamés : ${stats.matches}`);
  console.log(`Ajoutés : ${stats.added}`);
  console.log(`Erreurs : ${stats.errors}`);
  await mongoose.disconnect();
  if (stats.errors) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect();
  process.exit(1);
});
