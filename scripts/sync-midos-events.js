#!/usr/bin/env node
/**
 * Sync the tournaments run on Mido's House alone
 *
 * Some events of Mido's House have no start.gg or Challonge bracket: the site pairs
 * the players itself. Each one listed in EVENTS becomes a tournament, rebuilt from:
 *   - the event's races on the Mido's House API, with their phase, round and players;
 *   - their racetime.gg rooms, for the results: a race is won by the side whose player
 *     finished first, a match (several races of a pair in a round) by the side that
 *     won more of them.
 * Races labelled as tie-breaks, or with more than two sides, are attached as tie-breaks
 * of their group instead of matches. Async races, played outside racetime.gg, have no
 * known result.
 * An event whose page links a start.gg or Challonge bracket is left out: that bracket is
 * imported instead.
 *
 * Phases come from EVENTS, by their Mido's House name:
 *   - bracketType as on start.gg (ROUND_ROBIN, SWISS, SINGLE_ELIMINATION, DOUBLE_ELIMINATION);
 *   - rounds of an elimination phase, and its third place match (see
 *     helpers/midos-event-matches.js `roundOf`);
 *   - perRace: one match per race (team events scoring a point per race won).
 * `teams`: the sides are Mido's House teams, each race played by one player of each.
 *
 * Usage:
 *   node scripts/sync-midos-events.js                  # every event of EVENTS
 *   node scripts/sync-midos-events.js --event br/1     # one event (repeatable)
 *   node scripts/sync-midos-events.js --active         # events not over yet
 *   node scripts/sync-midos-events.js --dry-run --verbose   # brackets and top 8 as rebuilt
 */

const path = require('path');
const axios = require('axios');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const connectDB = require('../config/database');
const { Game, Tournament, Race, Player } = require('../models');
const scheduleSites = require('../services/schedule-sites');
const racetime = require('../services/racetime');
const { computeProvisionalRanks } = require('../helpers/provisional-ranks');
const {
  TIEBREAK_RE, kindOf, isElimination, tiebreakGroup, roundOf, seriesWinner, inferWalkovers, orderBracket, pendingRounds
} = require('../helpers/midos-event-matches');

const GAME_ID = 'oot';
// A race played again after its room was cancelled: within a day of it
const REPLAY_WINDOW_MS = 24 * 3600 * 1000;
const BRACKET_LINK_RE = /href="https?:\/\/(?:www\.)?(?:start\.gg\/tournament|smash\.gg\/tournament|(?:[a-z0-9-]+\.)?challonge\.com\/)/i;

const EVENTS = {
  'rsl/6': {
    name: 'Random Settings League Season 6',
    phases: {
      Group: { name: 'Groups', bracketType: 'ROUND_ROBIN' },
      'Top 8': { name: 'Top 8', bracketType: 'SINGLE_ELIMINATION', rounds: ['Quarter Finals', 'Semi Finals', 'Grand Final'] }
    }
  },
  'mq/1': {
    name: '12 MQ Tournament',
    phases: {
      Group: { name: 'Groups', bracketType: 'ROUND_ROBIN' },
      Bracket: {
        name: 'Bracket',
        bracketType: 'DOUBLE_ELIMINATION',
        rounds: {
          'Winners Quarterfinal': 1, 'Winners Semifinal': 2, 'Winners Final': 3, 'Grand Final': 4,
          'Losers Round 1': -1, 'Losers Quarterfinal': -2, 'Losers Semifinal': -3, 'Losers Final': -4
        }
      }
    }
  },
  'sco/2026': {
    name: 'SlugCentral Open 2026',
    teams: true,
    phases: {
      Swiss: { name: 'Swiss', bracketType: 'SWISS', perRace: true },
      'Top 8': { name: 'Top 8', bracketType: 'SINGLE_ELIMINATION', rounds: ['Quarterfinal', 'Semifinal', 'Final'] }
    }
  },
  'br/1': {
    name: 'Copa do Brasil',
    phases: {
      Swiss: { name: 'Swiss', bracketType: 'SWISS' },
      Bracket: {
        name: 'Bracket', bracketType: 'SINGLE_ELIMINATION',
        rounds: ['Quarterfinals', 'Semifinals', 'Finals'], thirdPlace: 'Bronze Match'
      }
    }
  },
  'latam/2025': {
    name: 'Copa Latinoamerica 2025',
    phases: {
      'Group Stage': { name: 'Group Stage', bracketType: 'ROUND_ROBIN' },
      Playoffs: { name: 'Playoffs', bracketType: 'SINGLE_ELIMINATION', rounds: ['Quarter-finals', 'Semifinals', 'Finals'] }
    }
  }
};

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { dryRun: false, active: false, verbose: false, events: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') opts.dryRun = true;
    if (args[i] === '--active') opts.active = true;
    if (args[i] === '--verbose') opts.verbose = true;
    if (args[i] === '--event') opts.events.push(String(args[++i] || '').trim());
  }
  opts.events = opts.events.filter(Boolean);
  return opts;
}

const roomPath = url => String(url || '').replace(/^https?:\/\/(www\.)?racetime\.gg/i, '').replace(/\/+$/, '');
const time = d => (d ? new Date(d).getTime() : NaN);

async function getEventRaces(series, event) {
  const data = await scheduleSites.graphql(
    `query($series: String!, $event: String!) { series(name: $series) { event(name: $event) { races {
      start room phase round
      teams { id name members { user { displayName racetimeId } } }
      asyncParts { start }
    } } } }`,
    { series, event }
  );
  return data?.series?.event?.races || null;
}

// The event page links its bracket when it has one on start.gg or Challonge
async function linksBracket(url) {
  const { data } = await axios.get(url, { timeout: 20000, headers: { 'User-Agent': 'RandomizerHub-sync/1.0 (+tournament index)' } });
  return BRACKET_LINK_RE.test(String(data));
}

// Entrant who won the race: the first one to finish
function raceWinner(race) {
  const finished = (race.entrants || [])
    .filter(e => e.status === 'done' && e.userId)
    .sort((a, b) => (a.place || Infinity) - (b.place || Infinity));
  return finished[0] || null;
}

/**
 * Sides of a Mido's House race, keyed so that a side is the same across races: the team
 * (team events), else the player's racetime account. Races Mido's House lists without
 * players take them from their room.
 */
function raceSides(mh, race, config) {
  const teams = mh.teams || [];
  if (teams.length) {
    return teams.map(team => {
      const members = (team.members || []).map(m => ({ userId: m.user?.racetimeId || null, name: m.user?.displayName }));
      if (config.teams) return { key: `team:${team.id}`, name: team.name || members.map(m => m.name).join(' / '), members };
      const [player] = members;
      return { key: player?.userId || `mh:${team.id}`, name: player?.name, members: [], userId: player?.userId };
    });
  }
  return (race?.entrants || []).filter(e => e.userId)
    .map(e => ({ key: e.userId, name: e.userName, members: [], userId: e.userId }));
}

/**
 * Rooms cancelled on racetime.gg whose race was played again in another room, which
 * Mido's House does not list: the race its players (the same ones, no one else) finished
 * within REPLAY_WINDOW_MS of it, in a room of no tournament. Rooms missing from the base
 * are read on racetime.gg to know their players.
 * @returns Map cancelled room → race played instead
 */
async function findReplacements(mhRaces, racesByUrl, missing, rooms, tournamentId) {
  const cancelled = [...racesByUrl.values()].filter(r => r.status === 'cancelled');
  for (const room of missing) {
    const [category, slug] = room.split('/').filter(Boolean);
    try {
      const race = await racetime.getRace(category, slug);
      if (race?.status === 'cancelled') {
        cancelled.push({ url: room, status: race.status, startedAt: race.openedAt, entrants: racetime.toStoredEntrants(race.entrants) });
      }
    } catch (err) {
      // A room gone from racetime.gg stays without a race
    }
  }

  const startOf = new Map(mhRaces.map(r => [roomPath(r.room), time(r.start)]));
  const replaced = new Map();
  for (const race of cancelled) {
    const userIds = (race.entrants || []).map(e => e.userId).filter(Boolean);
    const at = startOf.get(race.url) || time(race.startedAt);
    if (userIds.length < 2 || !Number.isFinite(at)) continue;
    const candidates = await Race.find({
      url: { $nin: rooms },
      status: 'finished',
      tournamentId: { $in: [null, tournamentId].filter(v => v !== undefined) },
      startedAt: { $gte: new Date(at - REPLAY_WINDOW_MS), $lte: new Date(at + REPLAY_WINDOW_MS) },
      'entrants.userId': { $all: userIds },
      entrants: { $size: userIds.length }
    }).select('url status startedAt endedAt tournamentId entrants.userId entrants.userName entrants.status entrants.place').lean();
    const unused = candidates.filter(c => ![...replaced.values()].some(r => r.url === c.url));
    if (unused.length === 1) replaced.set(race.url, unused[0]);
  }
  return replaced;
}

/**
 * One game per Mido's House race: its sides, its racetime.gg race and who won it.
 * Cancelled races are left out, unless played again in another room.
 */
function buildGames(mhRaces, racesByUrl, config, replaced) {
  const games = [];
  const tiebreaks = [];
  const unknownPhases = new Set();
  const now = Date.now();
  for (const mh of mhRaces) {
    const room = roomPath(mh.room);
    const race = replaced.get(room) || (mh.room ? racesByUrl.get(room) : null);
    if (race?.status === 'cancelled') continue;
    const phase = config.phases[mh.phase];
    const sides = raceSides(mh, race, config);
    if (phase && (TIEBREAK_RE.test(mh.round || '') || sides.length > 2)) {
      if (race) tiebreaks.push({ race, phase, group: tiebreakGroup(mh.round) });
      continue;
    }
    if (!phase) {
      unknownPhases.add(`${mh.phase} / ${mh.round}`);
      continue;
    }
    // No players listed and no room in the base (cancelled on racetime.gg): nothing to show
    if (!sides.length && !race) continue;
    const at = roundOf(phase, mh.round);
    if (!at || sides.length !== 2) {
      unknownPhases.add(`${mh.phase} / ${mh.round}`);
      continue;
    }

    const entrants = (race?.entrants || []).filter(e => e.userId);
    const playing = userId => entrants.some(e => e.userId === userId);
    // Team events: the player each team sent to this race
    const racers = sides.map(side => (config.teams ? side.members.find(m => m.userId && playing(m.userId)) || null : null));
    const winnerEntrant = race?.status === 'finished' ? raceWinner(race) : null;
    const winner = winnerEntrant
      ? sides.find((side, i) => (config.teams ? racers[i]?.userId : side.userId) === winnerEntrant.userId)?.key || null
      : null;
    const asyncStarts = (mh.asyncParts || []).map(p => time(p.start));
    const startAt = time(race?.startedAt) || time(mh.start) || Math.min(...asyncStarts.filter(Number.isFinite)) || null;
    // Over: a finished race, or every part of an async (whose result Mido's House keeps to itself)
    const doneAt = race?.status === 'finished' ? time(race.endedAt) || time(race.startedAt)
      : asyncStarts.length && asyncStarts.every(t => t < now) ? Math.max(...asyncStarts) : null;

    games.push({ phase, ...at, sides, racers, race, winner, startAt: Number.isFinite(startAt) ? startAt : null, doneAt, async: !!asyncStarts.length });
  }
  return { games, tiebreaks, unknownPhases };
}

// The races of a pair in a round make one match, except in the phases scoring each race
function buildMatches(games) {
  const byKey = new Map();
  games.forEach((g, i) => {
    const pair = g.sides.map(s => s.key).sort().join('|');
    const key = g.phase.perRace ? `race:${i}` : `${g.phase.name}|${g.round}|${g.group || ''}|${pair}`;
    if (!byKey.has(key)) byKey.set(key, { phase: g.phase.name, round: g.round, group: g.group, thirdPlace: g.thirdPlace, sideInfo: g.sides, sides: g.sides.map(s => s.key), games: [] });
    byKey.get(key).games.push(g);
  });
  const matches = [...byKey.values()];
  for (const m of matches) {
    m.games.sort((a, b) => (a.startAt || Infinity) - (b.startAt || Infinity));
    m.winner = seriesWinner(m.games);
    m.startAt = m.games[0].startAt;
    const done = m.games.map(g => g.doneAt);
    m.doneAt = m.winner || done.every(Boolean) ? Math.max(0, ...done.filter(Boolean)) || null : null;
  }
  return matches;
}

async function syncEvent(key, config, { game, dryRun, verbose }) {
  const [series, event] = key.split('/');
  const url = scheduleSites.eventUrl('midos', series, event);
  const label = `${config.name} (${key})`;

  if (await linksBracket(url)) {
    console.log(`  ⏭️  ${label} : la page lie un bracket start.gg ou Challonge, à importer depuis celui-ci`);
    return null;
  }
  const other = await Tournament.findOne({
    'midosHouse.series': series, 'midosHouse.event': event, 'source.type': { $ne: 'midos-house' }
  }).select('name').lean();
  if (other) {
    console.log(`  ⏭️  ${label} : déjà en base depuis un bracket (${other.name})`);
    return null;
  }

  const mhRaces = await getEventRaces(series, event);
  if (!mhRaces?.length) {
    console.log(`  ⏭️  ${label} : aucune race sur Mido's House`);
    return null;
  }

  const filter = { 'source.type': 'midos-house', 'source.externalId': key };
  const existing = await Tournament.findOne(filter).select('_id').lean();
  const rooms = mhRaces.map(r => roomPath(r.room)).filter(Boolean);
  const races = await Race.find({ url: { $in: rooms } })
    .select('url status startedAt endedAt tournamentId entrants.userId entrants.userName entrants.status entrants.place').lean();
  const racesByUrl = new Map(races
    // Races linked to another tournament stay there
    .filter(r => !r.tournamentId || String(r.tournamentId) === String(existing?._id))
    .map(r => [r.url, r]));
  const stored = new Set(races.map(r => r.url));
  const missing = rooms.filter(room => !stored.has(room));
  const replaced = await findReplacements(mhRaces, racesByUrl, missing, rooms, existing?._id);

  const { games, tiebreaks, unknownPhases } = buildGames(mhRaces, racesByUrl, config, replaced);
  const phaseList = Object.values(config.phases);
  const phases = phaseList.map((p, i) => ({ name: p.name, bracketType: p.bracketType, phaseOrder: i + 1 }));
  const matches = inferWalkovers(buildMatches(games), phases);
  // A walkover is over by the winner's next match
  for (const m of matches.filter(x => x.walkover && !x.doneAt)) {
    const next = matches.filter(o => o !== m && o.phase === m.phase && o.sides.includes(m.winner) && o.startAt).map(o => o.startAt);
    m.doneAt = next.length ? Math.min(...next) : null;
  }

  // Entrants numbered in order of appearance, named as on racetime today
  const userIds = [...new Set(games.flatMap(g => g.sides.flatMap(s => [s.userId, ...s.members.map(m => m.userId)])).filter(Boolean))];
  const names = new Map((await Player.find({ userId: { $in: userIds } }).select('userId name').lean()).map(p => [p.userId, p.name]));
  const nameOf = (userId, fallback) => (userId && names.get(userId)) || fallback || 'Unknown';
  const entrants = new Map();
  for (const m of matches) {
    for (const side of m.sideInfo) {
      if (!entrants.has(side.key)) entrants.set(side.key, { id: String(entrants.size + 1), side });
    }
  }
  const sideName = side => (config.teams ? side.name : nameOf(side.userId, side.name));

  const embedded = [];
  const thirdPlaceMatches = new Set();
  for (const phase of phaseList) {
    let list = matches.filter(m => m.phase === phase.name);
    list = isElimination(kindOf(phase.bracketType))
      ? orderBracket(list)
      : list.sort((a, b) => a.round - b.round || (a.startAt || Infinity) - (b.startAt || Infinity));
    for (const m of list) {
      const [s1, s2] = m.sideInfo;
      const side = s => {
        // Team events: the players who raced for the team in this match
        const members = config.teams
          ? [...new Set(m.games.map(g => g.racers[g.sides.findIndex(x => x.key === s.key)]).filter(Boolean).map(r => nameOf(r.userId, r.name)))]
          : null;
        return { startggEntrantId: entrants.get(s.key).id, name: sideName(s), ...(members?.length ? { members } : {}) };
      };
      const urls = m.games.map(g => g.race?.url).filter(Boolean);
      if (m.thirdPlace) thirdPlaceMatches.add(embedded.length);
      embedded.push({
        round: m.round,
        completedAt: m.doneAt ? new Date(m.doneAt) : null,
        state: m.doneAt ? 3 : m.games.some(g => g.race) ? 2 : 1,
        phase: m.phase,
        phaseGroup: m.group || null,
        raceUrl: urls[0] || null,
        raceUrls: urls,
        player1: side(s1),
        player2: side(s2),
        winnerId: m.winner ? Number(entrants.get(m.winner).id) : null
      });
    }
    if (kindOf(phase.bracketType) === 'singleelimination' && Array.isArray(phase.rounds)) {
      embedded.push(...pendingRounds(embedded.filter(m => m.phase === phase.name), phase.rounds.length));
    }
  }

  // Over once the last phase's final has a winner and no race is scheduled (matches never
  // played, such as forfeits, do not hold it open)
  const lastPhase = phaseList[phaseList.length - 1];
  const finalRound = Math.max(...embedded.filter(m => m.phase === lastPhase.name).map(m => m.round));
  const finals = embedded.filter((m, i) => m.phase === lastPhase.name && m.round === finalRound && !thirdPlaceMatches.has(i));
  const scheduled = games.some(g => !g.doneAt && g.startAt > Date.now());
  const over = finals.length === 1 && finals[0].winnerId != null && !scheduled;
  const ended = embedded.map(m => m.completedAt).filter(Boolean).sort((a, b) => b - a)[0] || null;
  const starts = games.map(g => g.startAt).filter(Boolean).sort((a, b) => a - b);

  // The third place match, in the final's round, splits the semi-final losers
  const ranks = computeProvisionalRanks(embedded.filter((m, i) => !thirdPlaceMatches.has(i)), phases);
  for (const i of thirdPlaceMatches) {
    const m = embedded[i];
    if (m.winnerId == null) continue;
    const loser = [m.player1, m.player2].find(p => p.startggEntrantId !== String(m.winnerId));
    ranks.set(String(m.winnerId), 3);
    if (loser) ranks.set(loser.startggEntrantId, 4);
  }
  const participants = [];
  for (const [, { id, side }] of entrants) {
    const finalRank = ranks.get(id) || null;
    if (config.teams) {
      for (const member of side.members) {
        const name = nameOf(member.userId, member.name);
        participants.push({ name, displayName: name, team: side.name, finalRank, startggEntrantId: id, racetimeUserId: member.userId || undefined, racetimeName: member.userId ? name : undefined });
      }
    } else {
      const name = sideName(side);
      participants.push({ name, displayName: name, finalRank, startggEntrantId: id, racetimeUserId: side.userId || undefined, racetimeName: side.userId ? name : undefined });
    }
  }

  const doc = {
    name: config.name,
    game: game._id,
    gameSlug: game.id,
    gameId: game.id,
    gameName: game.randomizer?.displayName || game.name,
    url: key,
    fullUrl: url,
    tournamentType: kindOf(lastPhase.bracketType) === 'doubleelimination' ? 'double elimination' : 'single elimination',
    state: over ? 'complete' : 'underway',
    startDate: starts.length ? new Date(starts[0]) : null,
    endDate: over ? ended : null,
    participantsCount: config.teams ? entrants.size : participants.length,
    participants,
    phases: phases.map(p => ({ ...p, groupCount: new Set(embedded.filter(m => m.phase === p.name && m.phaseGroup).map(m => m.phaseGroup)).size || 1, state: over ? 'COMPLETED' : 'ACTIVE' })),
    matches: embedded,
    setsTotal: embedded.length,
    'midosHouse.series': series,
    'midosHouse.event': event,
    'midosHouse.url': url,
    'midosHouse.lastSync': new Date(),
    'source.type': 'midos-house',
    'source.externalId': key,
    'source.url': url,
    'source.importedAt': new Date()
  };

  const unknown = embedded.filter(m => m.completedAt && m.winnerId == null).length;
  const walkovers = matches.filter(m => m.walkover).length;
  console.log(`  ${label} : ${embedded.length} matchs (${games.length} races), ${tiebreaks.length} tie-break(s), ${entrants.size} ${config.teams ? 'équipes' : 'joueurs'}, ${doc.state}`);
  if (walkovers) console.log(`     ${walkovers} vainqueur(s) déduit(s) du tour suivant (match sans résultat)`);
  if (unknown) console.log(`     ${unknown} match(s) joué(s) sans résultat connu (async, personne à l'arrivée)`);
  if (replaced.size) console.log(`     ${replaced.size} room(s) annulée(s) remplacée(s) par la course rejouée : ${[...replaced.values()].map(r => r.url).join(', ')}`);
  const elsewhere = races.filter(r => !racesByUrl.has(r.url)).length;
  if (elsewhere) console.log(`     ${elsewhere} room(s) liée(s) à un autre tournoi, laissée(s) à celui-ci`);
  if (missing.length) console.log(`     ${missing.length} room(s) absente(s) de la base : ${missing.slice(0, 5).join(', ')}`);
  if (unknownPhases.size) console.log(`     ⚠️  phase/round hors config, ignorés : ${[...unknownPhases].join(' ; ')}`);
  if (verbose) {
    for (const phase of phaseList.filter(p => isElimination(kindOf(p.bracketType)))) {
      console.log(`     ${phase.name} :`);
      for (const m of embedded.filter(x => x.phase === phase.name)) {
        const mark = side => (String(m.winnerId) === side.startggEntrantId ? '*' : '');
        console.log(`       R${m.round}  ${m.player1.name}${mark(m.player1)} vs ${m.player2.name}${mark(m.player2)}  (${m.raceUrls.length} race(s))`);
      }
    }
    const top = [...new Map(participants.map(p => [p.startggEntrantId, p])).values()]
      .filter(p => p.finalRank && p.finalRank <= 8).sort((a, b) => a.finalRank - b.finalRank);
    console.log(`     Classement : ${top.map(p => `${p.finalRank}. ${p.team || p.name}`).join(', ')}`);
  }
  if (dryRun) return null;

  await Tournament.updateOne(filter, { $set: doc }, { upsert: true });
  const tournament = await Tournament.findOne(filter).select('_id').lean();
  await Race.updateMany({ url: { $in: games.map(g => g.race?.url).filter(Boolean) } }, { $set: { tournamentId: tournament._id } });
  for (const { race, phase, group } of tiebreaks) {
    await Race.updateOne({ _id: race._id }, {
      $set: {
        tournamentId: tournament._id,
        tournamentPhase: phase.name,
        tournamentPool: group || undefined,
        matchPlayers: (race.entrants || []).map(e => nameOf(e.userId, e.userName)).join(' vs '),
        tiebreak: true
      }
    });
  }
  return tournament;
}

async function main() {
  const opts = parseArgs();
  await connectDB();

  try {
    console.log(`\n🏆 Sync tournois Mido's House sans bracket${opts.dryRun ? ' (dry-run)' : ''}`);
    const game = await Game.findOne({ id: GAME_ID }).select('_id id name randomizer').lean();
    if (!game) throw new Error(`jeu ${GAME_ID} introuvable`);

    let keys = opts.events.length ? opts.events : Object.keys(EVENTS);
    const unknown = keys.filter(k => !EVENTS[k]);
    if (unknown.length) throw new Error(`événement(s) hors config : ${unknown.join(', ')}`);
    if (opts.active) {
      const over = new Set((await Tournament.find({ 'source.type': 'midos-house', 'source.externalId': { $in: keys }, state: 'complete' })
        .select('source.externalId').lean()).map(t => t.source.externalId));
      keys = keys.filter(k => !over.has(k));
    }
    let synced = 0;
    for (const key of keys) {
      try {
        if (await syncEvent(key, EVENTS[key], { game, dryRun: opts.dryRun, verbose: opts.verbose })) synced++;
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
  console.error('❌ Erreur sync tournois Mido\'s House:', err.message);
  process.exitCode = 1;
});
