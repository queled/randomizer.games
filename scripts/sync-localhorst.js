#!/usr/bin/env node
/**
 * Sync restreams scheduled on alttp.localhorst.tv
 *
 * The site schedules ALTTPR, Super Metroid Rando and SMZ3 races with the
 * channels restreaming them (German ones especially). Each race gives its
 * racetime.gg room: its channels go to `race.restreams` of that race, with the
 * Twitch past broadcast covering its start while Twitch keeps it.
 *
 * Events copied from Hyrule Town Hall are skipped: sync-schedule-sites.js reads
 * them at the source.
 *
 * Usage:
 *   node scripts/sync-localhorst.js                   # running events, races of the last 3 days
 *   node scripts/sync-localhorst.js --days 60         # further back (Twitch keeps past broadcasts 60 days at most)
 *   node scripts/sync-localhorst.js --archive         # every event, all its races (one-off backfill)
 *   node scripts/sync-localhorst.js --event beer-s4   # one event (repeatable), all its races
 *   node scripts/sync-localhorst.js --dry-run
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const connectDB = require('../config/database');
const { Race } = require('../models');
const localhorst = require('../services/localhorst');
const twitchVods = require('../services/twitch-vods');
const { LANGUAGE_NAMES } = require('../helpers/restream-titles');

const DAY_MS = 24 * 3600 * 1000;
// Twitch keeps past broadcasts 60 days at most
const VOD_MAX_AGE_MS = 60 * DAY_MS;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, archive: false, days: 3, events: [] };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dry-run': opts.dryRun = true; break;
      case '--archive': opts.archive = true; break;
      case '--days': opts.days = Math.max(1, parseInt(args[++i], 10) || 3); break;
      case '--event': opts.events.push(String(args[++i] || '')); break;
    }
  }
  return opts;
}

const isHth = value => /^hth:/i.test(value || '');

function roomPath(url) {
  const m = String(url || '').match(/^https?:\/\/(?:www\.)?racetime\.gg(\/[^/?#]+\/[^/?#]+)/i);
  return m ? m[1] : null;
}

function selectEvents(events, opts) {
  if (opts.events.length) return events.filter(e => opts.events.includes(e.name));
  const candidates = events.filter(e => !isHth(e.externalSchedule));
  if (opts.archive) return candidates;
  // Running events, and those that ended within the window
  const now = Date.now();
  return candidates.filter(e => (!e.start || e.start.getTime() < now + DAY_MS)
    && (!e.end || e.end.getTime() > now - opts.days * DAY_MS));
}

// "https://twitch.tv/x" channels only, with the Mido's House language name ("German")
function restreamsOf(episode) {
  if (episode.doNotRestream) return [];
  return episode.channels
    .map(c => ({ login: twitchVods.twitchLogin(c.url), language: LANGUAGE_NAMES[c.languages[0]] || undefined }))
    .filter(c => c.login);
}

async function main() {
  const opts = parseArgs();
  if (opts.dryRun) console.log('📋 Mode DRY-RUN : rien n’est écrit en base');
  await connectDB();
  const stats = { events: 0, episodes: 0, races: 0, restreams: 0, vods: 0, errors: 0 };

  // Channels of each racetime.gg room
  const channelsByRoom = new Map();
  try {
    const events = selectEvents(await localhorst.listEvents(), opts);
    console.log(`\n🏠 ${events.length} événement(s) localhorst à lire`);
    const after = opts.archive || opts.events.length ? null : new Date(Date.now() - opts.days * DAY_MS);
    for (const event of events) {
      try {
        const episodes = (await localhorst.getEpisodes(event.id, { after }))
          .filter(e => !isHth(e.extId) && roomPath(e.roomUrl));
        stats.events++;
        for (const episode of episodes) {
          const channels = restreamsOf(episode);
          if (!channels.length) continue;
          stats.episodes++;
          const room = roomPath(episode.roomUrl);
          channelsByRoom.set(room, (channelsByRoom.get(room) || []).concat(channels));
        }
        if (episodes.length) console.log(`   📅 ${event.title} : ${episodes.length} race(s)`);
      } catch (error) {
        console.log(`   ❌ ${event.name} : ${error.message}`);
        stats.errors++;
      }
    }
  } catch (error) {
    console.log(`   ❌ localhorst : ${error.message}`);
    stats.errors++;
  }

  const races = channelsByRoom.size
    ? await Race.find({ url: { $in: [...channelsByRoom.keys()] } }).select('_id url status startedAt restreams').lean()
    : [];
  console.log(`\n📺 ${channelsByRoom.size} room(s) restreamée(s), dont ${races.length} en base`);

  // Past broadcasts, one call per channel
  const now = Date.now();
  const needsVod = race => race.status === 'finished' && race.startedAt && now - new Date(race.startedAt).getTime() < VOD_MAX_AGE_MS;
  const logins = [...new Set(races.filter(needsVod).flatMap(r => channelsByRoom.get(r.url).map(c => c.login)))];
  const userIds = logins.length ? await twitchVods.getUserIds(logins) : new Map();
  const archivesByLogin = new Map();
  const getArchives = async login => {
    if (!archivesByLogin.has(login)) {
      archivesByLogin.set(login, userIds.has(login) ? await twitchVods.getArchives(userIds.get(login)) : []);
    }
    return archivesByLogin.get(login);
  };

  for (const race of races) {
    race.restreams = race.restreams || [];
    let changed = false;
    for (const { login, language } of channelsByRoom.get(race.url)) {
      let entry = race.restreams.find(s => twitchVods.twitchLogin(s.url) === login);
      if (!entry) {
        entry = { url: `https://twitch.tv/${login}` };
        race.restreams.push(entry);
        stats.restreams++;
        changed = true;
      }
      if (language && !entry.language) {
        entry.language = language;
        changed = true;
      }
      if (!entry.vodUrl && !entry.vodGoneAt && needsVod(race)) {
        try {
          const vodUrl = twitchVods.findVod(await getArchives(login), race.startedAt);
          if (vodUrl) {
            entry.vodUrl = vodUrl;
            stats.vods++;
            changed = true;
          }
        } catch (error) {
          console.log(`   ❌ VOD ${login} : ${error.message}`);
          stats.errors++;
        }
      }
    }
    if (!changed) continue;
    stats.races++;
    console.log(`   📺 ${race.url} : ${race.restreams.map(s => `${twitchVods.twitchLogin(s.url)}${s.vodUrl ? ' (VOD)' : ''}`).join(', ')}`);
    if (!opts.dryRun) await Race.updateOne({ _id: race._id }, { $set: { restreams: race.restreams } });
  }

  console.log('\n📊 Résumé localhorst');
  console.log(`Événements lus : ${stats.events}`);
  console.log(`Races restreamées : ${stats.episodes}`);
  console.log(`Courses mises à jour : ${stats.races}`);
  console.log(`Restreams ajoutés : ${stats.restreams}`);
  console.log(`VOD trouvées : ${stats.vods}`);
  console.log(`Erreurs : ${stats.errors}`);

  await mongoose.disconnect();
  if (stats.errors) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
