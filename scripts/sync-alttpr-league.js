#!/usr/bin/env node
/**
 * Sync the seasons of the ALTTPR League as tournaments
 *
 * The League (services/alttpr-league.js: Invitational and Open leagues) pits
 * teams of three against each other, once a week within a division, then in
 * playoffs; each team match is two races (1v1 or co-op). Each season of each
 * league becomes a tournament: a regular season phase, one group per
 * division, and a playoffs phase, one match per team match, scored in races won.
 *
 * The site gives no racetime.gg room. Each race is found among the rooms
 * whose goal or info speaks of a league:
 *   - by its finish times (to the second, as the League shows them), which
 *     single a room out when two are known, or one with the players' names;
 *   - then by the players' names among the rooms of the same week (dated by
 *     the races found by their times): a room whose info names the League
 *     ("ALTTPR League S8 Invitational - A vs. B"), forfeits included, or any
 *     room whose finish times are within a minute of the League's (SRL rooms
 *     of 2020 have the mode as goal, and times seconds off).
 * Rooms already linked to another tournament stay there.
 *
 * Usage:
 *   node scripts/sync-alttpr-league.js                       # every season of both leagues
 *   node scripts/sync-alttpr-league.js --current             # latest season of each league
 *   node scripts/sync-alttpr-league.js --site open --season 7
 *   node scripts/sync-alttpr-league.js --dry-run
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const connectDB = require('../config/database');
const { Game, Tournament, Race } = require('../models');
const league = require('../services/alttpr-league');
const { sideNamesPlayer, normalizeName } = require('../helpers/restream-titles');

const GAME_ID = 'alttp';
const DAY_MS = 24 * 3600 * 1000;
// The League shows finish times to the second; racetime.gg keeps the milliseconds
const TIME_TOLERANCE_MS = 1000;
// SRL times sometimes differ by seconds from the League's official ones
const CLOSE_TIME_MS = 60 * 1000;
// A race found by names only must be within that delay of its week
const WEEK_WINDOW_MS = 5 * DAY_MS;
const REGULAR_PHASE = 'Saison régulière';
const PLAYOFFS_PHASE = 'Playoffs';
const LEAGUE_ROOM_RE = /alttpr (?:open )?league|league s\d+ (?:invitational|open)/i;
// Some 2020 SRL rooms only have the mode as goal ("vt8 randomizer - mystery league")
const ANY_LEAGUE_RE = /league/i;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, current: false, sites: [], seasons: [] };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dry-run': opts.dryRun = true; break;
      case '--current': opts.current = true; break;
      case '--site': opts.sites.push(String(args[++i] || '')); break;
      case '--season': opts.seasons.push(Number(args[++i])); break;
    }
  }
  return opts;
}

// Finish time in ms: `finishTimeMs`, or the ISO duration racetime.gg gives ("P0DT01H38M52.413912S"), which some races only have
function finishMs(entrant) {
  if (entrant.finishTimeMs > 0) return entrant.finishTimeMs;
  const m = String(entrant.finishTime || '').match(/^P(\d+)DT(\d+)H(\d+)M([\d.]+)S$/);
  return m ? Math.round((((Number(m[1]) * 24 + Number(m[2])) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000) : null;
}

const weekNumber = label => Number((String(label).match(/^Week\s*(\d+)$/i) || [])[1]) || null;

// The League player's names: shown name and page slug ("nobly" for "Nobly")
const namesOf = player => [player.name, player.slug.replace(/_/g, ' ')];

/**
 * How a room fits a race: the entrant of each player (by name), how many of the
 * known finish times it holds, and whether it has as many entrants as players,
 * or one per side (pilot weeks: one player of each team plays, the other guides).
 */
function fit(room, race) {
  const players = [...race.team.players, ...race.opponent.players];
  const entrants = room.entrants || [];
  const byPlayer = new Map();
  for (const player of players) {
    const entrant = entrants.find(e => ![...byPlayer.values()].includes(e)
      && namesOf(player).some(n => sideNamesPlayer(n, [e.userName])));
    if (entrant) byPlayer.set(player.slug, entrant);
  }
  const times = [...race.team.times, ...race.opponent.times].filter(Boolean);
  const hits = tolerance => {
    const used = new Set();
    let count = 0;
    for (const t of times) {
      const e = entrants.find(x => !used.has(x) && Math.abs((finishMs(x) || 0) - t) < tolerance);
      if (e) { used.add(e); count++; }
    }
    return count;
  };
  const timeHits = hits(TIME_TOLERANCE_MS);
  // The room info lists the players by their League name ("ALTTPR League S8 Invitational - sean9541 vs. flipheal")
  const info = normalizeName(room.info);
  const inInfo = players.every(p => [p.slug, p.name].map(normalizeName).some(n => n.length >= 3 && info.includes(n)));
  const pilots = entrants.length === 2 && players.length > 2;
  const sideNamed = side => side.players.some(p => byPlayer.has(p.slug));
  return {
    byPlayer,
    allNames: inInfo || (pilots ? sideNamed(race.team) && sideNamed(race.opponent) : byPlayer.size === players.length),
    allTimes: times.length > 0 && timeHits === times.length,
    closeTimes: hits(CLOSE_TIME_MS) === times.length,
    times: times.length,
    size: entrants.length === players.length || pilots
  };
}

const ROOM_FIELDS = 'url startedAt endedAt tournamentId goal info entrants.userId entrants.userName entrants.finishTimeMs entrants.finishTime';
const SMALL_ROOM = { 'entrants.1': { $exists: true }, 'entrants.4': { $exists: false } };

// ALTTPR rooms of 2 to 4 entrants between two dates, whatever their goal
async function roomsBetween(from, to) {
  return Race.find({ category: 'alttpr', ...SMALL_ROOM, startedAt: { $gte: from, $lte: to }, status: { $ne: 'cancelled' } })
    .select(ROOM_FIELDS).lean();
}

/**
 * Room of each race: { race, room, byPlayer } for the races found. `nearby(from, to)`
 * gives the other rooms of the season's dates, for the second pass.
 */
async function findRooms(races, rooms, nearby = async () => []) {
  const used = new Set();
  const found = new Map();
  const pick = (race, candidates) => {
    if (candidates.length !== 1) return;
    const { room, f } = candidates[0];
    used.add(room.url);
    found.set(race, { room, byPlayer: f.byPlayer });
  };

  // Rooms by the second of each finish time, to compare a race with the rooms holding one of its times only
  const roomsBySecond = new Map();
  for (const room of rooms) {
    for (const e of room.entrants || []) {
      const ms = finishMs(e);
      if (!ms) continue;
      const second = Math.floor(ms / 1000);
      if (!roomsBySecond.has(second)) roomsBySecond.set(second, new Set());
      roomsBySecond.get(second).add(room);
    }
  }

  // By finish times: two of them, or one with the names
  for (const race of races) {
    const time = [...race.team.times, ...race.opponent.times].find(Boolean);
    if (!time) continue;
    const second = Math.floor(time / 1000);
    const near = new Set([second - 1, second, second + 1].flatMap(sec => [...(roomsBySecond.get(sec) || [])]));
    const candidates = [...near].filter(r => !used.has(r.url)).map(room => ({ room, f: fit(room, race) }))
      .filter(({ f }) => f.size && f.allTimes && (f.times >= 2 || f.allNames));
    const named = candidates.filter(c => c.f.allNames);
    pick(race, candidates.length > 1 && named.length === 1 ? named : candidates);
  }

  // Each week's date, from the races found
  const datesByWeek = new Map();
  for (const [race, { room }] of found) {
    if (!datesByWeek.has(race.label)) datesByWeek.set(race.label, []);
    datesByWeek.get(race.label).push(new Date(room.startedAt).getTime());
  }
  const weekDate = new Map([...datesByWeek].map(([label, dates]) => [label, dates.sort((a, b) => a - b)[Math.floor(dates.length / 2)]]));
  // A week without a race found by its times (co-op: one time per team): between its neighbours
  const dated = [...weekDate].filter(([label]) => weekNumber(label)).map(([label, date]) => [weekNumber(label), date]);
  for (const label of new Set(races.map(r => r.label))) {
    const week = weekNumber(label);
    if (!week || weekDate.has(label) || dated.length < 2) continue;
    const before = dated.filter(([w]) => w < week).sort((a, b) => b[0] - a[0])[0];
    const after = dated.filter(([w]) => w > week).sort((a, b) => a[0] - b[0])[0];
    const [w1, d1] = before || after;
    const [w2, d2] = after && before ? after : dated.find(([w]) => w !== w1);
    weekDate.set(label, d1 + (d2 - d1) * (week - w1) / (w2 - w1));
  }

  // By names, within the week, the nearest room: one naming the League, or any whose times are close
  const weekDates = [...weekDate.values()];
  if (weekDates.length) {
    const known = new Set(rooms.map(r => r.url));
    const extra = (await nearby(new Date(Math.min(...weekDates) - WEEK_WINDOW_MS), new Date(Math.max(...weekDates) + WEEK_WINDOW_MS)))
      .filter(r => !known.has(r.url));
    rooms = rooms.concat(extra);
  }
  for (const race of races) {
    if (found.has(race) || !weekDate.has(race.label)) continue;
    const date = weekDate.get(race.label);
    const candidates = rooms.filter(r => !used.has(r.url) && Math.abs(new Date(r.startedAt).getTime() - date) < WEEK_WINDOW_MS)
      .map(room => ({ room, f: fit(room, race) }))
      .filter(({ room, f }) => f.size && f.allNames && f.closeTimes && (room.named || f.times > 0))
      .sort((a, b) => Math.abs(new Date(a.room.startedAt) - date) - Math.abs(new Date(b.room.startedAt) - date));
    pick(race, candidates.slice(0, 1));
  }
  return { found, weekDate };
}

async function syncSeason(site, season, { game, rooms, current, dryRun }) {
  const externalId = `${site}/${season}`;
  const filter = { 'source.type': 'alttpr-league', 'source.externalId': externalId };
  const existing = await Tournament.findOne(filter).select('_id').lean();
  const name = `${league.SITES[site].name} Season ${season}`;

  const teams = await league.getSeason(site, season);
  if (!teams.length) {
    console.log(`  ${name} : aucune équipe, ignorée`);
    return null;
  }

  // Each team match once (both teams list it), its races with the first team's results
  const teamMatches = new Map();
  for (const team of teams) {
    for (const match of team.matches) {
      const key = `${match.label}|${[team.slug, match.opponent.slug].sort().join('|')}`;
      if (!teamMatches.has(key)) teamMatches.set(key, { ...match, team: { slug: team.slug, name: team.name } });
    }
  }
  const races = [...teamMatches.values()].flatMap(m => m.races.map(r => Object.assign(r, { label: m.label })));
  const available = rooms.filter(r => !r.tournamentId || String(r.tournamentId) === String(existing?._id));
  const { found, weekDate } = await findRooms(races, available, async (from, to) => (await roomsBetween(from, to))
    .filter(r => !r.tournamentId || String(r.tournamentId) === String(existing?._id)));

  // Participants: one entrant per team, its players with their racetime.gg account when a room shows it
  const accounts = new Map();
  for (const { byPlayer } of found.values()) {
    for (const [slug, entrant] of byPlayer) if (entrant.userId && !accounts.has(slug)) accounts.set(slug, entrant);
  }
  const entrantIds = new Map(teams.map((t, i) => [t.slug, String(i + 1)]));
  const teamBySlug = new Map(teams.map(t => [t.slug, t]));

  // Playoff rounds in the order the team pages list them
  const playoffLabels = [];
  for (const team of teams) {
    for (const m of team.matches) if (!weekNumber(m.label) && !playoffLabels.includes(m.label)) playoffLabels.push(m.label);
  }

  const embedded = [...teamMatches.values()].map(m => {
    const wins = [0, 0];
    m.races.forEach(r => { if (/^win/i.test(r.result)) wins[0]++; else if (/^loss/i.test(r.result)) wins[1]++; });
    const played = m.races.every(r => /^(win|loss|tie)/i.test(r.result || ''));
    const roomsOf = m.races.map(r => found.get(r)?.room).filter(Boolean);
    const dates = roomsOf.map(r => new Date(r.endedAt || r.startedAt)).sort((a, b) => a - b);
    const members = side => [...new Set(m.races.flatMap(r => r[side].players.map(p => p.name)))];
    const opponent = teamBySlug.get(m.opponent.slug) || m.opponent;
    const week = weekNumber(m.label);
    const regular = Boolean(week);
    return {
      round: regular ? week : playoffLabels.indexOf(m.label) + 1,
      completedAt: played ? (dates[dates.length - 1] || (weekDate.has(m.label) ? new Date(weekDate.get(m.label)) : null)) : null,
      state: played ? 3 : 2,
      phase: regular ? REGULAR_PHASE : PLAYOFFS_PHASE,
      phaseGroup: regular ? (teamBySlug.get(m.team.slug)?.division || undefined) : undefined,
      raceUrl: roomsOf[0]?.url,
      raceUrls: roomsOf.map(r => r.url),
      displayScore: played ? `${m.team.name} ${wins[0]} - ${opponent.name} ${wins[1]}` : undefined,
      player1: { startggEntrantId: entrantIds.get(m.team.slug), name: m.team.name, members: members('team') },
      player2: { startggEntrantId: entrantIds.get(m.opponent.slug), name: opponent.name, members: members('opponent') },
      winnerId: played && wins[0] !== wins[1] ? Number(entrantIds.get(wins[0] > wins[1] ? m.team.slug : m.opponent.slug)) : null,
      _week: m.label
    };
  }).sort((a, b) => (a.phase === b.phase ? a.round - b.round : a.phase === REGULAR_PHASE ? -1 : 1));

  const roomDates = [...found.values()].map(f => new Date(f.room.startedAt)).sort((a, b) => a - b);
  const finals = embedded.filter(m => m.phase === PLAYOFFS_PHASE && m.round === playoffLabels.length);
  const over = !current || (finals.length > 0 && finals.every(m => m.winnerId));
  const divisions = new Set(teams.map(t => t.division).filter(Boolean));
  const url = `${league.SITES[site].baseUrl}/season_${season}/`;

  const doc = {
    name,
    game: game._id,
    gameSlug: game.id,
    gameId: game.id,
    gameName: game.randomizer?.displayName || game.name,
    url: externalId,
    tournamentType: 'round robin',
    state: over ? 'complete' : 'underway',
    startDate: roomDates[0] || null,
    endDate: over ? (roomDates[roomDates.length - 1] || null) : null,
    participantsCount: teams.length,
    participants: teams.flatMap(t => t.roster.map(p => ({
      name: p.name,
      displayName: p.name,
      team: t.name,
      startggEntrantId: entrantIds.get(t.slug),
      ...(accounts.has(p.slug) ? { racetimeUserId: accounts.get(p.slug).userId, racetimeName: accounts.get(p.slug).userName } : {})
    }))),
    phases: [
      { name: REGULAR_PHASE, bracketType: 'ROUND_ROBIN', phaseOrder: 1, groupCount: divisions.size, state: over || playoffLabels.length ? 'COMPLETED' : 'ACTIVE' },
      ...(playoffLabels.length ? [{ name: PLAYOFFS_PHASE, bracketType: 'SINGLE_ELIMINATION', phaseOrder: 2, groupCount: 1, state: over ? 'COMPLETED' : 'ACTIVE' }] : [])
    ],
    matches: embedded.map(({ _week, ...m }) => m),
    setsTotal: embedded.length,
    'source.type': 'alttpr-league',
    'source.externalId': externalId,
    'source.url': url,
    'source.importedAt': new Date()
  };

  console.log(`  ${name} : ${teams.length} équipes, ${divisions.size} divisions, ${embedded.length} matchs, ${found.size}/${races.length} races retrouvées sur racetime.gg, ${doc.state}`);
  if (dryRun) {
    const missing = races.filter(r => !found.has(r));
    missing.slice(0, 10).forEach(r => console.log(`     ✗ ${r.label} : ${r.team.players.map(p => p.name).join(', ')} vs ${r.opponent.players.map(p => p.name).join(', ')}`));
    if (missing.length > 10) console.log(`     … ${missing.length - 10} autre(s)`);
    return null;
  }

  await Tournament.updateOne(filter, { $set: doc }, { upsert: true });
  const tournament = await Tournament.findOne(filter).select('_id').lean();
  await Race.updateMany({ url: { $in: [...found.values()].map(f => f.room.url) } }, { $set: { tournamentId: tournament._id } });
  return tournament;
}

async function main() {
  const opts = parseArgs();
  await connectDB();

  try {
    console.log(`\n🏆 Sync ALTTPR League${opts.dryRun ? ' (dry-run)' : ''}`);
    const game = await Game.findOne({ id: GAME_ID }).select('_id id name randomizer').lean();
    if (!game) throw new Error(`jeu ${GAME_ID} introuvable`);
    const rooms = (await Race.find({ category: 'alttpr', $or: [{ info: ANY_LEAGUE_RE }, { goal: ANY_LEAGUE_RE }], ...SMALL_ROOM, startedAt: { $ne: null }, status: { $ne: 'cancelled' } })
      .select(ROOM_FIELDS)
      .lean())
      .map(r => ({ ...r, named: LEAGUE_ROOM_RE.test(`${r.goal || ''}\n${r.info || ''}`) }));
    console.log(`  ${rooms.length} rooms racetime.gg / SRL de la League`);

    let synced = 0;
    for (const site of opts.sites.length ? opts.sites : Object.keys(league.SITES)) {
      const seasons = await league.listSeasons(site);
      const latest = Math.max(...seasons);
      const selected = opts.seasons.length ? seasons.filter(s => opts.seasons.includes(s)) : opts.current ? [latest] : seasons;
      for (const season of selected) {
        try {
          if (await syncSeason(site, season, { game, rooms, current: season === latest, dryRun: opts.dryRun })) synced++;
        } catch (error) {
          console.log(`  ❌ ${site} saison ${season} : ${error.message}`);
          process.exitCode = 1;
        }
      }
    }
    console.log(`✅ Saisons ${opts.dryRun ? 'à synchroniser' : 'synchronisées'} : ${opts.dryRun ? '—' : synced}`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('❌ Erreur sync ALTTPR League:', err.message);
    process.exitCode = 1;
  });
}

module.exports = { fit, findRooms };
