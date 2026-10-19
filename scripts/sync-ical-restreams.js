#!/usr/bin/env node
/**
 * Sync restreams from public calendars (iCal)
 *
 * Restream teams publish
 * their schedule as a calendar, one event per match: "Event: Round 2 - A vs. B",
 * the channel in its description. The past broadcasts of the feed's channel
 * carry the same titles, and cover the matches the calendar misses.
 *
 * Neither gives the racetime.gg room: a match is the race of the game the
 * title names (racetime.gg categories of the game), started soon after the
 * scheduled time, whose entrants are its two sides. Every such race is taken,
 * a stream may hold several games of a series. Team matches (team names) and
 * races without a "vs" (weeklies) are left out. The channel goes to
 * `race.restreams`, with the past broadcast covering the race start while
 * Twitch keeps it.
 *
 * Usage:
 *   node scripts/sync-ical-restreams.js                 # matches of the last 3 days
 *   node scripts/sync-ical-restreams.js --days 60       # further back
 *   node scripts/sync-ical-restreams.js --archive       # every event of the calendars (one-off backfill)
 *   node scripts/sync-ical-restreams.js --feed <id>   # one feed (repeatable)
 *   node scripts/sync-ical-restreams.js --dry-run
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const connectDB = require('../config/database');
const { Race, Game } = require('../models');
const ical = require('../services/ical');
const twitchVods = require('../services/twitch-vods');
const findGameForTournament = require('../helpers/find-game-for-tournament');
const { getExplicitRacetimeSlugs } = require('../helpers/game-matching');
const { parseMatchup, sideNamesPlayer } = require('../helpers/restream-titles');

const DAY_MS = 24 * 3600 * 1000;
// Twitch keeps past broadcasts 60 days at most
const VOD_MAX_AGE_MS = 60 * DAY_MS;
// A race opens a little before its scheduled time and often starts late
const EARLY_START_MS = 30 * 60 * 1000;
const LATE_START_MS = 3 * 3600 * 1000;

// Public calendars of restream channels; `channel` restreams what the event description does not say otherwise
const FEEDS = [
  {
    name: 'zsr-fr',
    url: 'https://calendar.google.com/calendar/ical/f64c8461729c32330f97a89882b909837f9a451e302f57beb81d9c36a6799d99%40group.calendar.google.com/public/basic.ics',
    channel: 'zeldaspeedrunsfr',
    language: 'French'
  },
  {
    name: 'zsr-de',
    url: 'https://calendar.google.com/calendar/ical/3cde51fce3cb8ed1ba2bd8e8c627f72cc3ee3f5586d1a1d1bba1e6f098cf03db%40group.calendar.google.com/public/basic.ics',
    channel: 'zeldaspeedrunsde',
    language: 'German'
  }
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, archive: false, days: 3, feeds: [] };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dry-run': opts.dryRun = true; break;
      case '--archive': opts.archive = true; break;
      case '--days': opts.days = Math.max(1, parseInt(args[++i], 10) || 3); break;
      case '--feed': opts.feeds.push(String(args[++i] || '')); break;
    }
  }
  return opts;
}

// The channel an event names ("Restream: https://twitch.tv/<channel>"), else the feed's
function eventChannel(event, feed) {
  const m = `${event.location || ''} ${event.description || ''}`.match(/https?:\/\/(?:www\.)?twitch\.tv\/[A-Za-z0-9_]+/);
  return (m && twitchVods.twitchLogin(m[0])) || feed.channel;
}

// racetime.gg categories of the game an event title names ("<Game> Tournament" → its categories), cached by title
const slugsByText = new Map();
async function categoriesOf(text) {
  const key = text.toLowerCase();
  if (!slugsByText.has(key)) {
    const found = text ? await findGameForTournament({ tournamentName: text }) : null;
    const game = found ? await Game.findById(found.gameId).select('id integrations.racetime').lean() : null;
    slugsByText.set(key, game ? getExplicitRacetimeSlugs(game) : []);
  }
  return slugsByText.get(key);
}

// Races of these categories started within the window whose entrants are both sides of the match
async function findRaces(slugs, sides, from, to) {
  const races = await Race.find({
    category: { $in: slugs },
    url: /^\/[^/]+\/[^/]+$/,
    startedAt: { $gte: from, $lte: to }
  }).select('_id url status startedAt entrants.userName restreams').lean();
  return races.filter(race => {
    const names = (race.entrants || []).map(e => e.userName).filter(Boolean);
    if (names.length < 2) return false;
    const a = names.filter(n => sideNamesPlayer(sides[0], [n]));
    const b = names.filter(n => sideNamesPlayer(sides[1], [n]));
    // Two different entrants: "Name vs. Name2" must not be one player twice
    return a.length && b.length && new Set([...a, ...b]).size >= 2;
  });
}

async function main() {
  const opts = parseArgs();
  if (opts.dryRun) console.log('📋 Mode DRY-RUN : rien n’est écrit en base');
  await connectDB();
  const stats = { events: 0, matched: 0, races: 0, restreams: 0, vods: 0, errors: 0 };

  const now = Date.now();
  const since = opts.archive ? 0 : now - opts.days * DAY_MS;
  const feeds = opts.feeds.length ? FEEDS.filter(f => opts.feeds.includes(f.name)) : FEEDS;

  // Past broadcasts, one call per channel
  const archivesByLogin = new Map();
  const getArchives = async login => {
    if (!archivesByLogin.has(login)) {
      const userId = (await twitchVods.getUserIds([login])).get(login);
      archivesByLogin.set(login, userId ? await twitchVods.getArchives(userId) : []);
    }
    return archivesByLogin.get(login);
  };

  // Race id → { race, channels: login → { language, title, vodUrl } }
  const found = new Map();
  const addMatch = (race, login, fields) => {
    if (!found.has(String(race._id))) found.set(String(race._id), { race, channels: new Map() });
    const channels = found.get(String(race._id)).channels;
    channels.set(login, { ...channels.get(login), ...fields });
  };

  for (const feed of feeds) {
    // Scheduled matches, then the channel's past broadcasts (their own time window: the whole broadcast)
    const matches = [];
    try {
      const events = (await ical.fetchCalendar(feed.url))
        .filter(e => e.start.getTime() >= since && e.start.getTime() <= now);
      for (const event of events) {
        matches.push({
          title: event.summary,
          login: eventChannel(event, feed),
          from: new Date(event.start.getTime() - EARLY_START_MS),
          to: new Date(event.start.getTime() + LATE_START_MS)
        });
      }
      console.log(`\n📅 ${feed.name} : ${events.length} événement(s)`);
    } catch (error) {
      console.log(`   ❌ ${feed.name} : ${error.message}`);
      stats.errors++;
    }
    try {
      for (const video of await getArchives(feed.channel)) {
        const start = new Date(video.created_at).getTime();
        if (start < since) continue;
        matches.push({
          title: video.title,
          login: feed.channel,
          from: new Date(start),
          to: new Date(start + twitchVods.parseDuration(video.duration))
        });
      }
    } catch (error) {
      console.log(`   ❌ Twitch ${feed.channel} : ${error.message}`);
      stats.errors++;
    }

    for (const match of matches) {
      const matchup = parseMatchup(match.title);
      // No event before the players ("A vs B"): no game to look in
      if (!matchup || !matchup.event) continue;
      stats.events++;
      try {
        const slugs = await categoriesOf(matchup.event);
        if (!slugs.length) continue;
        const races = await findRaces(slugs, matchup.sides, match.from, match.to);
        if (!races.length) continue;
        stats.matched++;
        for (const race of races) {
          addMatch(race, match.login, { language: feed.language, title: match.title });
          if (opts.dryRun) console.log(`   🔗 « ${match.title} » → ${race.url} (${race.entrants.map(e => e.userName).join(', ')})`);
        }
      } catch (error) {
        console.log(`   ❌ « ${match.title} » : ${error.message}`);
        stats.errors++;
      }
    }
  }

  for (const { race, channels } of found.values()) {
    race.restreams = race.restreams || [];
    let changed = false;
    for (const [login, { language, title }] of channels) {
      let entry = race.restreams.find(s => twitchVods.twitchLogin(s.url) === login);
      if (!entry) {
        entry = { url: `https://twitch.tv/${login}`, title };
        race.restreams.push(entry);
        stats.restreams++;
        changed = true;
      }
      if (language && !entry.language) {
        entry.language = language;
        changed = true;
      }
      const needsVod = race.status === 'finished' && now - new Date(race.startedAt).getTime() < VOD_MAX_AGE_MS;
      if (!entry.vodUrl && !entry.vodGoneAt && needsVod) {
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

  console.log('\n📊 Résumé calendriers iCal');
  console.log(`Matchs lus : ${stats.events}`);
  console.log(`Matchs retrouvés sur racetime.gg : ${stats.matched}`);
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
