#!/usr/bin/env node
/**
 * Sync the seasons of the OoTR League as tournaments
 *
 * The League (https://league.ootrandomizer.com, behind a Discord login) pairs
 * players of the same division in 1v1 races. Each season becomes a tournament
 * with one round robin phase, one group per division, from its racetime.gg races:
 *   - the rooms Mido's House lists for the season (series "league"), with their division;
 *   - races of the season's goal ("League Season 10") whose info starts with
 *     "Div 7D: A vs B", as the League opens rooms Mido's House does not list.
 * Practice races with that goal (several entrants, no division) are left out.
 * The winner is the entrant who finished first; a race nobody finished has none.
 * The standings shown are wins and losses, not the League's official points.
 *
 * Usage:
 *   node scripts/sync-midos-league.js                # every season Mido's House knows
 *   node scripts/sync-midos-league.js --current      # latest season stored, and the next one once it exists
 *   node scripts/sync-midos-league.js --season 10    # one season (repeatable)
 *   node scripts/sync-midos-league.js --dry-run
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Game, Tournament, Race, Player } = require('../models');
const midosHouse = require('../services/midos-house');

const SERIES = 'league';
const GAME_ID = 'oot';
const RACETIME = 'https://racetime.gg';
// Seasons are numbered from 1; Mido's House knows them from season 4
const MAX_SEASON = 50;
// A season is over once its last race is that old and nothing is scheduled
const SEASON_OVER_AFTER_MS = 30 * 24 * 3600 * 1000;
const DIVISION_INFO_RE = /^Div(?:ision)?\s*([0-9]+[A-Z]?)\s*:/i;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, current: false, seasons: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') opts.dryRun = true;
    if (args[i] === '--current') opts.current = true;
    if (args[i] === '--season') opts.seasons.push(String(args[++i] || '').trim());
  }
  opts.seasons = opts.seasons.filter(Boolean);
  return opts;
}

async function getSeasonRaces(season) {
  const data = await midosHouse.graphql(
    'query($series: String!, $event: String!) { series(name: $series) { event(name: $event) { races { start room round } } } }',
    { series: SERIES, event: season }
  );
  return data?.series?.event?.races || null;
}

function roomPath(url) {
  return String(url || '').replace(/^https?:\/\/(www\.)?racetime\.gg/i, '').replace(/\/+$/, '');
}

function divisionName(code) {
  return `Division ${String(code).toUpperCase()}`;
}

// Entrant who won the race: the first one to finish
function raceWinner(race) {
  const finished = (race.entrants || [])
    .filter(e => e.status === 'done' && e.userId)
    .sort((a, b) => (a.place || Infinity) - (b.place || Infinity));
  return finished[0] || null;
}

/**
 * Matches of a season: { race, division } for each 1v1 race played in it. Races
 * already linked to another tournament (a goal picked by mistake) stay there.
 */
async function collectSeasonMatches(season, mhRaces, tournamentId) {
  const divisionByRoom = new Map();
  for (const r of mhRaces) {
    const code = String(r.round || '').match(/([0-9]+[A-Z]?)\s*$/i)?.[1];
    if (r.room && code) divisionByRoom.set(roomPath(r.room), code);
  }

  const races = await Race.find({
    $or: [
      { url: { $in: [...divisionByRoom.keys()] } },
      { goal: `League Season ${season}`, info: { $regex: '^Div' } }
    ]
  }).select('url goal info status startedAt endedAt tournamentId entrants.userId entrants.userName entrants.status entrants.place').lean();

  const matches = [];
  for (const race of races) {
    if (race.status === 'cancelled') continue;
    if (race.tournamentId && String(race.tournamentId) !== String(tournamentId)) continue;
    const fromInfo = String(race.info || '').split('\n')[0].match(DIVISION_INFO_RE)?.[1];
    const division = divisionByRoom.get(race.url) || fromInfo;
    const players = (race.entrants || []).filter(e => e.userId);
    if (!division || players.length !== 2) continue;
    matches.push({ race, division, players });
  }
  return matches.sort((a, b) => new Date(a.race.startedAt || 0) - new Date(b.race.startedAt || 0));
}

async function syncSeason(season, mhRaces, { game, dryRun }) {
  const filter = { 'source.type': 'midos-house', 'source.externalId': `${SERIES}/${season}` };
  const existing = await Tournament.findOne(filter).select('_id').lean();
  const matches = await collectSeasonMatches(season, mhRaces, existing?._id);
  if (!matches.length) {
    console.log(`  Season ${season}: aucun match trouvé, ignorée`);
    return null;
  }

  // Players by racetime account, named as on racetime today
  const userIds = [...new Set(matches.flatMap(m => m.players.map(p => p.userId)))];
  const known = new Map((await Player.find({ userId: { $in: userIds } }).select('userId name').lean())
    .map(p => [p.userId, p.name]));
  const participants = new Map();
  for (const { players } of matches) {
    for (const p of players) {
      if (participants.has(p.userId)) continue;
      const name = known.get(p.userId) || p.userName;
      participants.set(p.userId, { entrantId: String(participants.size + 1), name, racetimeUserId: p.userId, racetimeName: name });
    }
  }

  const phase = `Season ${season}`;
  const embedded = matches.map(({ race, division, players }) => {
    const [p1, p2] = players.map(p => participants.get(p.userId));
    const winner = raceWinner(race);
    const winnerEntrant = winner ? participants.get(winner.userId) : null;
    const played = race.status === 'finished';
    return {
      round: 1,
      completedAt: played ? (race.endedAt || race.startedAt) : null,
      state: played ? 3 : 2,
      phase,
      phaseGroup: divisionName(division),
      raceUrl: race.url,
      raceUrls: [race.url],
      player1: { startggEntrantId: p1.entrantId, name: p1.name },
      player2: { startggEntrantId: p2.entrantId, name: p2.name },
      winnerId: played && winnerEntrant ? Number(winnerEntrant.entrantId) : null
    };
  });

  const starts = mhRaces.map(r => r.start).filter(Boolean).map(d => new Date(d))
    .concat(matches.map(m => new Date(m.race.startedAt)).filter(d => !isNaN(d)))
    .sort((a, b) => a - b);
  const lastPlayed = matches.map(m => new Date(m.race.startedAt)).filter(d => !isNaN(d)).sort((a, b) => b - a)[0];
  const upcoming = mhRaces.some(r => r.start && !r.room && new Date(r.start) > new Date());
  const over = !upcoming && lastPlayed && Date.now() - lastPlayed > SEASON_OVER_AFTER_MS;
  const divisions = new Set(matches.map(m => m.division));

  const url = `${midosHouse.BASE_URL}/event/${SERIES}/${season}`;
  const doc = {
    name: `OoTR League Season ${season}`,
    game: game._id,
    gameSlug: game.id,
    gameId: game.id,
    gameName: game.randomizer?.displayName || game.name,
    url: `${SERIES}/${season}`,
    fullUrl: url,
    tournamentType: 'round robin',
    state: over ? 'complete' : 'underway',
    startDate: starts[0] || null,
    endDate: over ? lastPlayed : null,
    participantsCount: participants.size,
    participants: [...participants.values()].map(p => ({
      name: p.name,
      displayName: p.name,
      startggEntrantId: p.entrantId,
      racetimeUserId: p.racetimeUserId,
      racetimeName: p.racetimeName
    })),
    phases: [{ name: phase, bracketType: 'ROUND_ROBIN', phaseOrder: 1, groupCount: divisions.size, state: over ? 'COMPLETED' : 'ACTIVE' }],
    matches: embedded,
    setsTotal: embedded.length,
    'midosHouse.series': SERIES,
    'midosHouse.event': String(season),
    'midosHouse.url': url,
    'midosHouse.lastSync': new Date(),
    'source.type': 'midos-house',
    'source.externalId': `${SERIES}/${season}`,
    'source.url': url,
    'source.importedAt': new Date()
  };

  console.log(`  Season ${season}: ${embedded.length} matchs (${mhRaces.filter(r => r.room).length} salons Mido's House), ${divisions.size} divisions, ${participants.size} joueurs, ${doc.state}`);
  if (dryRun) return null;

  await Tournament.updateOne(filter, { $set: doc }, { upsert: true });
  const tournament = await Tournament.findOne(filter).select('_id').lean();
  await Race.updateMany({ url: { $in: matches.map(m => m.race.url) } }, { $set: { tournamentId: tournament._id } });
  return tournament;
}

async function main() {
  const opts = parseArgs();
  await connectDB();

  try {
    console.log(`\n🏆 Sync OoTR League${opts.dryRun ? ' (dry-run)' : ''}`);
    const game = await Game.findOne({ id: GAME_ID }).select('_id id name randomizer').lean();
    if (!game) throw new Error(`jeu ${GAME_ID} introuvable`);

    let seasons = opts.seasons.length ? opts.seasons : Array.from({ length: MAX_SEASON }, (_, i) => String(i + 1));
    if (opts.current) {
      const stored = await Tournament.find({ 'source.type': 'midos-house', 'midosHouse.series': SERIES })
        .select('midosHouse.event').lean();
      const latest = Math.max(0, ...stored.map(t => Number(t.midosHouse?.event)).filter(Number.isFinite));
      if (latest) seasons = [String(latest), String(latest + 1)];
    }
    let synced = 0;
    for (const season of seasons) {
      const mhRaces = await getSeasonRaces(season);
      if (!mhRaces) continue;
      if (await syncSeason(season, mhRaces, { game, dryRun: opts.dryRun })) synced++;
    }
    console.log(`✅ Saisons ${opts.dryRun ? 'à synchroniser' : 'synchronisées'}: ${opts.dryRun ? '—' : synced}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(err => {
  console.error('❌ Erreur sync League:', err.message);
  process.exitCode = 1;
});
