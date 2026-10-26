#!/usr/bin/env node
/**
 * Sync the community tournaments run from a Google Sheet: a Swiss stage, then a single elimination
 *
 * Some tournaments have no start.gg or Challonge bracket: the organizers pair the Swiss rounds
 * themselves and publish the standings in a public Google Sheet (one row per player: rank,
 * then the result and opponent of each round), then seed a single elimination bracket from
 * those standings. Each one listed in EVENTS becomes a tournament, rebuilt from:
 *   - the sheet, read as CSV: the Swiss pairings and their official results, and the seeds of
 *     the bracket (its top players, in rank order, placed as in a standard bracket: 1 v 16,
 *     8 v 9...);
 *   - the racetime.gg rooms of the game, for the races: a Swiss match is the 1v1 room of its
 *     two players during its week, a bracket match the rooms of its two players after the
 *     Swiss stage, until one of them won the set. Rooms whose info names another race (weekly,
 *     pilot spoiler, casual...) are left out; rooms linked to another tournament stay there.
 * The sheet's results win over the rooms (async races, played outside racetime.gg, have none);
 * the bracket's come from the rooms only. Byes and drops are left out of the matches.
 * Swiss players outside the bracket keep the sheet's rank.
 * `asyncs` ties the event's seeds on an async site (services/alttpr-asyncs.js): its practice
 * series, and its qualifier seeds with their results, in `alttprAsyncs` as for ALTTPR.
 *
 * Usage:
 *   node scripts/sync-sheet-swiss.js                     # every event of EVENTS
 *   node scripts/sync-sheet-swiss.js --event smz3-2025   # one event (repeatable)
 *   node scripts/sync-sheet-swiss.js --dry-run --verbose # brackets, unmatched races and top 8
 */

const path = require('path');
const axios = require('axios');
const mongoose = require('mongoose');
const { parse } = require('csv-parse/sync');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const connectDB = require('../config/database');
const { Game, Tournament, Race, Player } = require('../models');
const { computeProvisionalRanks } = require('../helpers/provisional-ranks');
const { sideNamesPlayer } = require('../helpers/restream-titles');
const asyncs = require('../services/alttpr-asyncs');

const DAY_MS = 24 * 3600 * 1000;
// A Swiss race may be played just before its week (the evening before, in the Americas) or
// just after it (granted a few days)
const EARLY_MS = DAY_MS;
const LATE_MS = 2 * DAY_MS;
// Rooms of other races between the same players
const OTHER_RACE_RE = /weekly|pilot|spoiler|casual|shindig|4 ?fun|for fun|cas'|fork|practice|torneo|best of \d{2,}/i;

const EVENTS = {
  'smz3-2025': {
    name: 'SMZ3 Winter 2025 Community Tournament',
    game: 'smz3',
    url: 'https://www.inertia.run/tournaments/smz3-2025',
    sheet: { id: '1L4poHnKEmgFQ68lQ1-UgYxtIym94uZayJQdGbYc_kKs', gid: 0 },
    swiss: { name: 'Swiss', rounds: 6, start: '2025-02-19T05:00:00Z', weekDays: 7 },
    bracket: { name: 'Playoffs', size: 16, bestOf: 3, start: '2025-04-02T05:00:00Z' },
    // Sheet name → racetime.gg name, when neither contains the other
    aliases: { AkumaGath17: 'Akuma17', Seb: 'Sebk', Tso: 'tso15' },
    // Its restreams' schedule on SpeedGaming (sync-speedgaming.js)
    speedgaming: 'smz3_2025',
    asyncs: { site: asyncs.SMZ3_URL, practice: [10], qualifiers: [836] }
  }
};

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, verbose: false, events: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') opts.dryRun = true;
    if (args[i] === '--verbose') opts.verbose = true;
    if (args[i] === '--event') opts.events.push(String(args[++i] || '').trim());
  }
  opts.events = opts.events.filter(Boolean);
  return opts;
}

/**
 * Players of the sheet, in rank order: name, rank, and each round's result ('W', 'L', 'T')
 * and opponent ('BYE' and 'DROP' are no opponent).
 */
async function readStandings(sheet, rounds) {
  const url = `https://docs.google.com/spreadsheets/d/${sheet.id}/export?format=csv&gid=${sheet.gid}`;
  const { data } = await axios.get(url, { timeout: 20000, responseType: 'text' });
  const rows = parse(String(data), { relax_column_count: true });
  const header = rows[0].map(h => String(h).trim());
  const col = name => header.indexOf(name);
  const players = [];
  for (const row of rows.slice(1)) {
    const rank = Number(row[col('Rank')]);
    const name = String(row[col('Player')] || '').trim();
    if (!rank || !name) continue;
    const results = [];
    for (let r = 1; r <= rounds; r++) {
      results.push({ result: String(row[col(`R${r}`)] || '').trim().toUpperCase(), opponent: String(row[col(`Round ${r}`)] || '').trim() });
    }
    players.push({ name, rank, results });
  }
  return players.sort((a, b) => a.rank - b.rank);
}

// Swiss matches of the sheet, once per pair and round, with the sheet's winner
function swissPairings(players, rounds) {
  const byName = new Map(players.map(p => [p.name, p]));
  const matches = [];
  const unknown = new Set();
  for (let r = 1; r <= rounds; r++) {
    const seen = new Set();
    for (const p of players) {
      const { result, opponent } = p.results[r - 1];
      if (!opponent || /^(BYE|DROP)$/i.test(opponent) || seen.has(p.name)) continue;
      const other = byName.get(opponent);
      if (!other) {
        unknown.add(opponent);
        continue;
      }
      seen.add(p.name).add(other.name);
      const winner = result === 'W' ? p.name : result === 'L' ? other.name : null;
      matches.push({ round: r, names: [p.name, other.name], winner });
    }
  }
  return { matches, unknown };
}

// Seeds of a standard bracket of `size`, in bracket order (1, 16, 8, 9, 4, 13...)
function bracketOrder(size) {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2 + 1;
    order = order.flatMap(seed => [seed, n - seed]);
  }
  return order;
}

const racetimeName = (config, name) => config.aliases?.[name] || name;
const isPlayer = (config, name, entrant) => sideNamesPlayer(racetimeName(config, name), [entrant.userName]);

// 1v1 races of the two players, finished, oldest first
function racesOf(races, config, names) {
  return races.filter(r => {
    const [a, b] = r.entrants;
    return (isPlayer(config, names[0], a) && isPlayer(config, names[1], b))
      || (isPlayer(config, names[0], b) && isPlayer(config, names[1], a));
  });
}

// Name of the player who won the race (the first to finish)
function raceWinner(race, config, names) {
  const first = race.entrants.filter(e => e.status === 'done').sort((a, b) => (a.place || Infinity) - (b.place || Infinity))[0];
  return first ? names.find(n => isPlayer(config, n, first)) || null : null;
}

/**
 * The event's async seeds, as `tournament.alttprAsyncs`: each practice series (a button on the
 * page), then its qualifier seeds, outside any series, with their results
 */
async function readAsyncs({ site, practice = [], qualifiers = [] }) {
  const entries = [];
  const series = practice.length ? await asyncs.listSeries(site) : [];
  for (const seriesId of practice) {
    const found = series.find(s => s.id === seriesId);
    if (!found) throw new Error(`série ${seriesId} absente de ${site}`);
    const seeds = await asyncs.getSeriesSeeds(seriesId, site);
    entries.push({ seriesId, title: found.title, url: found.url, qualifier: false, seedCount: seeds.length, syncedAt: new Date(), seeds: [] });
  }
  for (const asyncId of qualifiers) {
    const [info, results] = [await asyncs.getAsync(asyncId, site), await asyncs.getResults(asyncId, site)];
    entries.push({
      title: 'Qualifier',
      url: asyncs.resultsUrl(asyncId, site),
      qualifier: true,
      seedCount: 1,
      syncedAt: new Date(),
      seeds: [{ asyncId, mode: info.mode, description: info.description, participants: results.participants, finishers: results.finishers, results: results.results }]
    });
  }
  return entries;
}

async function syncEvent(key, config, { dryRun, verbose }) {
  const label = `${config.name} (${key})`;
  const game = await Game.findOne({ id: config.game }).select('_id id name randomizer integrations.racetime').lean();
  if (!game) throw new Error(`jeu ${config.game} introuvable`);

  const players = await readStandings(config.sheet, config.swiss.rounds);
  const { matches: swiss, unknown } = swissPairings(players, config.swiss.rounds);

  const filter = { 'source.type': 'sheet', 'source.externalId': key };
  const existing = await Tournament.findOne(filter).select('_id').lean();
  const swissStart = new Date(config.swiss.start).getTime();
  const weekMs = config.swiss.weekDays * DAY_MS;
  const category = game.integrations?.racetime?.gameSlug || game.id;
  const races = (await Race.find({
    url: new RegExp(`^/${category}/`),
    status: 'finished',
    startedAt: { $gte: new Date(swissStart - EARLY_MS),$lte: new Date(swissStart + 365 * DAY_MS) },
    entrants: { $size: 2 }
  }).select('url startedAt endedAt info tournamentId entrants.userId entrants.userName entrants.status entrants.place').sort({ startedAt: 1 }).lean())
    .filter(r => (!r.tournamentId || String(r.tournamentId) === String(existing?._id)) && !OTHER_RACE_RE.test(r.info || ''));
  const used = new Set();
  const take = race => used.add(race.url) && race;

  // Swiss: the room of the pair during its week
  for (const m of swiss) {
    const from = swissStart + (m.round - 1) * weekMs;
    const candidates = racesOf(races, config, m.names)
      .filter(r => !used.has(r.url) && r.startedAt >= from - EARLY_MS && r.startedAt < from + weekMs + LATE_MS);
    m.race = candidates.length ? take(candidates[0]) : null;
    m.doneAt = m.race ? m.race.endedAt || m.race.startedAt : new Date(from + weekMs);
    const raceWon = m.race && raceWinner(m.race, config, m.names);
    m.conflict = !!(raceWon && m.winner && raceWon !== m.winner);
    // Ties are replayed in the bracket only: a Swiss tie stays without a winner
    if (!m.winner && raceWon && players.find(p => p.name === m.names[0]).results[m.round - 1].result !== 'T') m.winner = raceWon;
  }

  // Bracket: seeds from the sheet's ranks, then each round from the winners of the one before
  const order = bracketOrder(config.bracket.size);
  const bracketStart = new Date(config.bracket.start).getTime();
  const lastRaceOf = new Map();
  const bracket = [];
  let slots = order.map(seed => players[seed - 1]?.name || null);
  const roundCount = Math.log2(config.bracket.size);
  const winsNeeded = Math.ceil(config.bracket.bestOf / 2);
  for (let round = 1; round <= roundCount; round++) {
    const next = [];
    for (let i = 0; i < slots.length; i += 2) {
      const names = [slots[i], slots[i + 1]];
      const m = { round, names, games: [], winner: null };
      bracket.push(m);
      if (names.every(Boolean)) {
        const after = Math.max(bracketStart, ...names.map(n => lastRaceOf.get(n) || 0));
        const wins = new Map();
        for (const race of racesOf(races, config, names).filter(r => !used.has(r.url) && r.startedAt.getTime() >= after)) {
          const winner = raceWinner(race, config, names);
          m.games.push(take(race));
          if (winner) wins.set(winner, (wins.get(winner) || 0) + 1);
          if (winner && wins.get(winner) >= winsNeeded) {
            m.winner = winner;
            break;
          }
        }
        m.doneAt = m.winner ? m.games[m.games.length - 1].endedAt : null;
        for (const n of names) if (m.games.length) lastRaceOf.set(n, m.games[m.games.length - 1].startedAt.getTime());
      }
      next.push(m.winner);
    }
    slots = next;
  }

  // Entrants numbered by rank, named as on racetime today
  const userIdOf = new Map();
  for (const m of [...swiss.filter(x => x.race).map(x => ({ names: x.names, games: [x.race] })), ...bracket]) {
    for (const race of m.games) {
      for (const n of m.names) {
        const entrant = race.entrants.find(e => isPlayer(config, n, e));
        if (entrant?.userId && !userIdOf.has(n)) userIdOf.set(n, entrant.userId);
      }
    }
  }
  const names = new Map((await Player.find({ userId: { $in: [...userIdOf.values()] } }).select('userId name').lean()).map(p => [p.userId, p.name]));
  const displayName = n => names.get(userIdOf.get(n)) || n;
  const idOf = new Map(players.map((p, i) => [p.name, String(i + 1)]));
  const side = n => (n ? { startggEntrantId: idOf.get(n), name: displayName(n) } : { name: 'TBD' });

  const embedded = [
    ...swiss.map(m => ({
      round: m.round,
      completedAt: m.doneAt,
      state: 3,
      phase: config.swiss.name,
      phaseGroup: null,
      raceUrl: m.race?.url || null,
      raceUrls: m.race ? [m.race.url] : [],
      player1: side(m.names[0]),
      player2: side(m.names[1]),
      winnerId: m.winner ? Number(idOf.get(m.winner)) : null
    })),
    ...bracket.map(m => ({
      round: m.round,
      completedAt: m.doneAt || null,
      state: m.doneAt ? 3 : m.games.length ? 2 : 1,
      phase: config.bracket.name,
      phaseGroup: null,
      raceUrl: m.games[0]?.url || null,
      raceUrls: m.games.map(g => g.url),
      player1: side(m.names[0]),
      player2: side(m.names[1]),
      winnerId: m.winner ? Number(idOf.get(m.winner)) : null
    }))
  ];

  const over = bracket[bracket.length - 1].winner != null;
  const phases = [
    { name: config.swiss.name, bracketType: 'SWISS', phaseOrder: 1 },
    { name: config.bracket.name, bracketType: 'SINGLE_ELIMINATION', phaseOrder: 2 }
  ];
  const ranks = computeProvisionalRanks(embedded, phases);
  const inBracket = new Set(order.slice(0, config.bracket.size).map(seed => players[seed - 1]?.name).filter(Boolean));
  const participants = players.map(p => {
    const userId = userIdOf.get(p.name);
    const name = displayName(p.name);
    return {
      name,
      displayName: name,
      seed: p.rank,
      finalRank: inBracket.has(p.name) ? ranks.get(idOf.get(p.name)) || null : p.rank,
      startggEntrantId: idOf.get(p.name),
      racetimeUserId: userId || undefined,
      racetimeName: userId ? name : undefined
    };
  });

  const dates = embedded.map(m => m.completedAt).filter(Boolean).sort((a, b) => a - b);
  const doc = {
    name: config.name,
    game: game._id,
    gameSlug: game.id,
    gameId: game.id,
    gameName: game.randomizer?.displayName || game.name,
    url: key,
    fullUrl: config.url,
    tournamentType: 'single elimination',
    state: over ? 'complete' : 'underway',
    startDate: new Date(swissStart),
    endDate: over ? dates[dates.length - 1] : null,
    participantsCount: participants.length,
    participants,
    phases: phases.map(p => ({ ...p, groupCount: 1, state: over || p.bracketType === 'SWISS' ? 'COMPLETED' : 'ACTIVE' })),
    matches: embedded,
    setsTotal: embedded.length,
    speedgamingEvent: config.speedgaming || undefined,
    ...(config.asyncs ? { alttprAsyncs: await readAsyncs(config.asyncs) } : {}),
    'source.type': 'sheet',
    'source.externalId': key,
    'source.url': `https://docs.google.com/spreadsheets/d/${config.sheet.id}/edit#gid=${config.sheet.gid}`,
    'source.importedAt': new Date()
  };

  const missing = swiss.filter(m => !m.race);
  const conflicts = swiss.filter(m => m.conflict);
  console.log(`  ${label} : ${players.length} joueurs, ${swiss.length} matchs suisses (${swiss.length - missing.length} rooms), ${bracket.length} matchs de bracket, ${doc.state}`);
  for (const s of doc.alttprAsyncs || []) {
    console.log(`     Asyncs : ${s.title} (${s.qualifier ? `${s.seeds[0].finishers}/${s.seeds[0].participants} à l'arrivée` : `${s.seedCount} seed(s)`})`);
  }
  if (missing.length) console.log(`     ${missing.length} match(s) suisse(s) sans room (async ou room absente)`);
  if (conflicts.length) console.log(`     ⚠️  ${conflicts.length} room(s) dont le vainqueur diffère du tableau (le tableau l'emporte) : ${conflicts.map(m => m.race.url).join(', ')}`);
  if (unknown.size) console.log(`     ⚠️  adversaire(s) absent(s) du classement : ${[...unknown].join(', ')}`);
  const unnamed = players.filter(p => !userIdOf.has(p.name)).map(p => p.name);
  if (unnamed.length) console.log(`     ${unnamed.length} joueur(s) sans compte racetime trouvé : ${unnamed.join(', ')}`);
  if (verbose) {
    for (const m of missing) console.log(`       sans room : R${m.round} ${m.names.join(' vs ')}`);
    console.log(`     ${config.bracket.name} :`);
    for (const m of bracket) {
      const mark = n => (n && n === m.winner ? '*' : '');
      console.log(`       R${m.round}  ${m.names.map(n => `${n ? displayName(n) : 'TBD'}${mark(n)}`).join(' vs ')}  ${m.games.map(g => g.url).join(' ')}`);
    }
    const top = participants.filter(p => p.finalRank && p.finalRank <= 8).sort((a, b) => a.finalRank - b.finalRank);
    console.log(`     Classement : ${top.map(p => `${p.finalRank}. ${p.name}`).join(', ')}`);
  }
  if (dryRun) return null;

  await Tournament.updateOne(filter, { $set: doc }, { upsert: true });
  const tournament = await Tournament.findOne(filter).select('_id').lean();
  await Race.updateMany({ url: { $in: [...used] } }, { $set: { tournamentId: tournament._id } });
  return tournament;
}

async function main() {
  const opts = parseArgs();
  await connectDB();

  try {
    console.log(`\n🏆 Sync tournois suisses d'un tableau Google${opts.dryRun ? ' (dry-run)' : ''}`);
    const keys = opts.events.length ? opts.events : Object.keys(EVENTS);
    const unknown = keys.filter(k => !EVENTS[k]);
    if (unknown.length) throw new Error(`événement(s) hors config : ${unknown.join(', ')}`);
    let synced = 0;
    for (const key of keys) {
      try {
        if (await syncEvent(key, EVENTS[key], opts)) synced++;
      } catch (err) {
        console.error(`  ❌ ${key} : ${err.message}`);
        process.exitCode = 1;
      }
    }
    console.log(`✅ Tournois ${opts.dryRun ? 'à synchroniser' : 'synchronisés'}: ${opts.dryRun ? '—' : synced}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(err => {
  console.error('❌ Erreur sync tournois suisses:', err.message);
  process.exitCode = 1;
});
