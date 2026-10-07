#!/usr/bin/env node
/**
 * Sync Mido's House schedules and restreams
 *
 * Reads the races of the events listed on https://midos.house (OoTR
 * tournaments) and stores them on the start.gg tournament they belong to,
 * linked to matches by start.gg set ID:
 *   - `midosHouse.schedule`: upcoming races, replaced on each sync;
 *   - `midosHouse.pastRestreams`: played races that were restreamed, kept.
 * Then looks up the Twitch VOD of past restreams, while Twitch still has it,
 * and drops the VODs Twitch has deleted since (keeping who restreamed).
 *
 * Events without start.gg sets (Challonge, league, manual brackets) are skipped.
 *
 * Usage:
 *   node scripts/sync-midos-house.js                    # events on the home page
 *   node scripts/sync-midos-house.js --archive          # finished events too (one-off backfill)
 *   node scripts/sync-midos-house.js --event rot/1      # one event (repeatable)
 *   node scripts/sync-midos-house.js --no-vods          # skip the Twitch VOD lookup
 *   node scripts/sync-midos-house.js --dry-run
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Tournament, Race } = require('../models');
const midosHouse = require('../services/midos-house');
const twitchVods = require('../services/twitch-vods');

const REQUEST_DELAY_MS = 1000;
// Twitch keeps past broadcasts at most 60 days
const VOD_MAX_AGE_MS = 60 * 24 * 3600 * 1000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, archive: false, vods: true, events: [] };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dry-run': opts.dryRun = true; break;
      case '--archive': opts.archive = true; break;
      case '--no-vods': opts.vods = false; break;
      case '--event': {
        const [series, event] = String(args[++i] || '').split('/');
        if (series && event) opts.events.push({ series, event, url: `${midosHouse.BASE_URL}/event/${series}/${event}` });
        break;
      }
    }
  }
  return opts;
}

function raceKey(race) {
  return `${race.startggSetId}|${new Date(race.startAt).toISOString()}`;
}

function toEntry(race) {
  return {
    startggSetId: race.startggSetId,
    startAt: race.startAt,
    round: race.round,
    entrants: race.entrants,
    roomUrl: race.roomUrl,
    restreams: race.restreams.map(s => ({ language: s.language, url: s.url, vodUrl: s.vodUrl || undefined, vodGoneAt: s.vodGoneAt || undefined }))
  };
}

// Past restreams from Mido's House, keeping the VODs already found and the races it no longer lists
function mergePastRestreams(existing, fresh) {
  const vodByStream = new Map();
  for (const race of existing) {
    for (const s of race.restreams || []) {
      if (s.vodUrl || s.vodGoneAt) vodByStream.set(`${raceKey(race)}|${s.url}`, { vodUrl: s.vodUrl, vodGoneAt: s.vodGoneAt });
    }
  }
  const byKey = new Map(existing.map(race => [raceKey(race), toEntry(race)]));
  for (const race of fresh) {
    const entry = toEntry(race);
    entry.restreams.forEach(s => {
      const vod = vodByStream.get(`${raceKey(race)}|${s.url}`) || {};
      s.vodUrl = vod.vodUrl || undefined;
      s.vodGoneAt = vod.vodGoneAt || undefined;
    });
    byKey.set(raceKey(race), entry);
  }
  return [...byKey.values()].sort((a, b) => new Date(b.startAt) - new Date(a.startAt));
}

async function syncEvent(ev, { dryRun }, stats, syncedIds) {
  const label = `${ev.series}/${ev.event}`;
  const { upcoming, past } = await midosHouse.getEventRaces(ev.series, ev.event);

  // One Mido's House event can map to several start.gg events (e.g. one per bracket)
  const bySlug = new Map();
  for (const [list, race] of [...upcoming.map(r => ['upcoming', r]), ...past.map(r => ['past', r])]) {
    if (!race.startggSlug) continue;
    if (!bySlug.has(race.startggSlug)) bySlug.set(race.startggSlug, { upcoming: [], past: [] });
    bySlug.get(race.startggSlug)[list].push(race);
  }
  if (!bySlug.size) {
    console.log(`   ⏭️  ${label} : pas de sets start.gg`);
    stats.noStartgg++;
    return;
  }

  for (const [slug, races] of bySlug) {
    const tournament = await Tournament.findOne({
      startggSlug: { $in: [slug, slug.replace(/^tournament\//, '')] }
    }).select('_id name midosHouse.pastRestreams').lean();
    if (!tournament) {
      console.log(`   ⚠️  ${label} : aucun tournoi en base pour ${slug}`);
      stats.notFound++;
      continue;
    }

    const schedule = races.upcoming.filter(r => r.startAt).map(toEntry);
    const pastRestreams = mergePastRestreams(
      tournament.midosHouse?.pastRestreams || [],
      races.past.filter(r => r.startAt && r.restreams.length)
    );
    console.log(`   ✅ ${label} → ${tournament.name} : ${schedule.length} race(s) planifiée(s), ${pastRestreams.length} race(s) passée(s) restreamée(s)`);

    syncedIds.push(tournament._id);
    stats.linked++;
    stats.scheduled += schedule.length;
    stats.pastRestreams += pastRestreams.length;
    if (dryRun) continue;

    await Tournament.updateOne({ _id: tournament._id }, {
      $set: {
        'midosHouse.series': ev.series,
        'midosHouse.event': ev.event,
        'midosHouse.url': ev.url,
        'midosHouse.lastSync': new Date(),
        'midosHouse.schedule': schedule,
        'midosHouse.pastRestreams': pastRestreams
      }
    });
  }
}

// Events gone from the home page are over: their schedule is emptied.
// Events that failed to load this time are left as they were.
async function clearStaleSchedules({ dryRun }, stats, syncedIds, failedEvents) {
  const query = { _id: { $nin: syncedIds }, 'midosHouse.schedule.0': { $exists: true } };
  if (failedEvents.length) {
    query.$nor = failedEvents.map(ev => ({ 'midosHouse.series': ev.series, 'midosHouse.event': ev.event }));
  }
  const stale = await Tournament.find(query).select('_id name').lean();
  for (const tournament of stale) {
    console.log(`   🧹 ${tournament.name} : plus rien de planifié`);
    stats.cleared++;
    if (!dryRun) {
      await Tournament.updateOne({ _id: tournament._id }, {
        $set: { 'midosHouse.schedule': [], 'midosHouse.lastSync': new Date() }
      });
    }
  }
}

// VODs Twitch has deleted since they were found: the link goes, the restreamer stays
async function checkVods({ dryRun }, stats) {
  const tournaments = await Tournament.find({ 'midosHouse.pastRestreams.restreams.vodUrl': { $type: 'string' } })
    .select('_id name midosHouse.pastRestreams').lean();
  const ids = tournaments.flatMap(t => t.midosHouse.pastRestreams.flatMap(r => r.restreams.map(s => twitchVods.videoId(s.vodUrl)).filter(Boolean)));
  if (!ids.length) return;

  const existing = await twitchVods.getExistingVideoIds(ids);
  console.log(`\n🔎 VOD vérifiées : ${new Set(ids).size}, encore en ligne : ${existing.size}`);
  for (const tournament of tournaments) {
    let gone = 0;
    for (const race of tournament.midosHouse.pastRestreams) {
      for (const stream of race.restreams) {
        const id = twitchVods.videoId(stream.vodUrl);
        if (!id || existing.has(id)) continue;
        delete stream.vodUrl;
        stream.vodGoneAt = new Date();
        gone++;
      }
    }
    if (!gone) continue;
    console.log(`   🗑️  ${tournament.name} : ${gone} VOD supprimée(s) par Twitch`);
    stats.vodsGone += gone;
    if (!dryRun) {
      await Tournament.updateOne({ _id: tournament._id }, { $set: { 'midosHouse.pastRestreams': tournament.midosHouse.pastRestreams } });
    }
  }
}

// Twitch VODs of the restreams played in the last 60 days that have none yet
async function findVods({ dryRun }, stats) {
  const now = Date.now();
  const needsVod = race => {
    const start = new Date(race.startAt).getTime();
    return start > now - VOD_MAX_AGE_MS && start < now
      && race.restreams.some(s => !s.vodUrl && !s.vodGoneAt && twitchVods.twitchLogin(s.url));
  };

  const tournaments = (await Tournament.find({
    'midosHouse.pastRestreams.startAt': { $gt: new Date(now - VOD_MAX_AGE_MS) }
  }).select('_id name midosHouse.pastRestreams').lean())
    .filter(t => t.midosHouse.pastRestreams.some(needsVod));
  if (!tournaments.length) return;

  const pending = tournaments.flatMap(t => t.midosHouse.pastRestreams.filter(needsVod));
  const logins = pending.flatMap(r => r.restreams.map(s => twitchVods.twitchLogin(s.url)).filter(Boolean));
  console.log(`\n🎬 Recherche des VOD : ${pending.length} race(s), ${new Set(logins).size} chaîne(s)`);

  const userIds = await twitchVods.getUserIds(logins);
  const archivesByLogin = new Map();
  const getArchives = async login => {
    if (!archivesByLogin.has(login)) {
      const userId = userIds.get(login);
      archivesByLogin.set(login, userId ? await twitchVods.getArchives(userId) : []);
    }
    return archivesByLogin.get(login);
  };

  // The racetime.gg start is more precise than the scheduled time
  const roomPaths = pending.map(r => r.roomUrl && r.roomUrl.replace(/^https:\/\/racetime\.gg/, '')).filter(Boolean);
  const startedAtByPath = new Map((await Race.find({ url: { $in: roomPaths } }).select('url startedAt').lean())
    .filter(r => r.startedAt)
    .map(r => [r.url, r.startedAt]));

  for (const tournament of tournaments) {
    let found = 0;
    for (const race of tournament.midosHouse.pastRestreams) {
      if (!needsVod(race)) continue;
      const start = startedAtByPath.get((race.roomUrl || '').replace(/^https:\/\/racetime\.gg/, '')) || race.startAt;
      for (const stream of race.restreams) {
        const login = twitchVods.twitchLogin(stream.url);
        if (stream.vodUrl || stream.vodGoneAt || !login) continue;
        const vodUrl = twitchVods.findVod(await getArchives(login), start);
        if (vodUrl) {
          stream.vodUrl = vodUrl;
          found++;
        }
      }
    }
    if (!found) continue;
    console.log(`   🎬 ${tournament.name} : ${found} VOD trouvée(s)`);
    stats.vods += found;
    if (!dryRun) {
      await Tournament.updateOne({ _id: tournament._id }, { $set: { 'midosHouse.pastRestreams': tournament.midosHouse.pastRestreams } });
    }
  }
}

async function main() {
  const opts = parseArgs();
  if (opts.dryRun) console.log('📋 Mode DRY-RUN : rien n’est écrit en base');

  await connectDB();

  const homepageMode = !opts.events.length && !opts.archive;
  let events = opts.events;
  if (!opts.events.length) {
    events = await midosHouse.listCurrentEvents();
    if (opts.archive) {
      const current = new Set(events.map(ev => `${ev.series}/${ev.event}`));
      events = events.concat((await midosHouse.listArchivedEvents()).filter(ev => !current.has(`${ev.series}/${ev.event}`)));
    }
  }
  console.log(`\n🏠 ${events.length} événement(s) sur Mido's House`);

  const stats = { linked: 0, scheduled: 0, pastRestreams: 0, vods: 0, vodsGone: 0, cleared: 0, noStartgg: 0, notFound: 0, errors: 0 };
  const syncedIds = [];
  const failedEvents = [];

  for (const ev of events) {
    try {
      await sleep(REQUEST_DELAY_MS);
      await syncEvent(ev, opts, stats, syncedIds);
    } catch (error) {
      console.log(`   ❌ ${ev.series}/${ev.event} : ${error.message}`);
      failedEvents.push(ev);
      stats.errors++;
    }
  }

  if (homepageMode) await clearStaleSchedules(opts, stats, syncedIds, failedEvents);

  if (opts.vods) {
    try {
      await checkVods(opts, stats);
      await findVods(opts, stats);
    } catch (error) {
      console.log(`   ❌ VOD Twitch : ${error.message}`);
      stats.errors++;
    }
  }

  console.log('\n📊 Résumé Mido\'s House');
  console.log(`Tournois reliés : ${stats.linked}`);
  console.log(`Races planifiées : ${stats.scheduled}`);
  console.log(`Races passées restreamées : ${stats.pastRestreams}`);
  console.log(`VOD trouvées : ${stats.vods}`);
  console.log(`VOD supprimées par Twitch : ${stats.vodsGone}`);
  console.log(`Tournois vidés : ${stats.cleared}`);
  console.log(`Événements sans start.gg : ${stats.noStartgg}`);
  console.log(`Tournois absents de la base : ${stats.notFound}`);
  console.log(`Erreurs : ${stats.errors}`);

  await mongoose.disconnect();
  if (stats.errors) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
