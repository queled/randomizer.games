#!/usr/bin/env node
/**
 * Link start.gg tournament races to embedded tournament matches.
 *
 * This script only attempts a direct match-level link when a race clearly looks
 * like a 1v1 set (exactly 2 entrants or an explicit "A vs B" pattern).
 * Large multi-entrant rooms are intentionally left at tournament-level only.
 *
 * Supports BO3/BO5: multiple races can be linked to the same set.
 * Each race gets startggSetId; the embedded match accumulates raceUrls[].
 *
 * Usage:
 *   node scripts/link-startgg-races.js <tournamentId>
 *   node scripts/link-startgg-races.js <tournamentId> --dry-run
 *   node scripts/link-startgg-races.js --all --dry-run
 */

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env'), quiet: true });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer';
const {
  rankMatchesForRace,
  selectBestCandidate,
  getMatchPlayers,
  extractRaceEntrants,
  getRaceLabel,
  parseRaceStageInfo,
  parseStartggDisplayScore
} = require('../helpers/race-match-linking');

function parseArgs() {
  const args = process.argv.slice(2);
  const raceUrls = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--race-url' && args[i + 1]) {
      raceUrls.push(args[i + 1]);
      i++;
    }
  }
  return {
    dryRun: args.includes('--dry-run'),
    explore: args.includes('--explore'),
    all: args.includes('--all'),
    raceUrls,
    tournamentId: args.find((arg) => !arg.startsWith('--')) || null
  };
}

function getExplorationMatches(race, matches) {
  const stageInfo = parseRaceStageInfo(race);
  const label = getRaceLabel(race).toLowerCase();
  if (stageInfo.type === 'qualifier' || label.startsWith('qualifier')) {
    return [];
  }
  if (stageInfo.type === 'group-match' && stageInfo.group) {
    return matches.filter((match) => (
      String(match.phase || '').toLowerCase() === 'preliminary bracket' &&
      String(match.phaseGroup || '') === String(stageInfo.group)
    ));
  }
  if (stageInfo.type === 'main-bracket-match') {
    return matches.filter((match) => String(match.phase || '').toLowerCase() === 'main bracket');
  }
  if (race.tournamentPhase) {
    return matches.filter((match) => String(match.phase || '').toLowerCase() === String(race.tournamentPhase || '').toLowerCase());
  }
  return matches;
}

/**
 * Determine how many games are expected for a set based on displayScore.
 * Returns { gamesPlayed, bestOf } or null if can't determine.
 */
function getSetGameCount(match) {
  const parsed = parseStartggDisplayScore(match.displayScore);
  if (!parsed) return null;
  return { gamesPlayed: parsed.gamesPlayed, bestOf: parsed.bestOf };
}

function uniqueByUrl(races) {
  const seen = new Set();
  const result = [];
  for (const race of races) {
    if (!race?.url || seen.has(race.url)) continue;
    seen.add(race.url);
    result.push(race);
  }
  return result;
}

/**
 * Load all candidate races: those attached to the tournament AND nearby
 * 1v1 / group / bracket races that may not have tournamentId yet.
 */
async function loadCandidateRaces(Race, tournament, extraRaceUrls = []) {
  const attachedRaces = await Race.find({ tournamentId: tournament._id }).lean();

  const embeddedMatches = Array.isArray(tournament.matches) ? tournament.matches : [];
  const completedDates = embeddedMatches
    .map((m) => m.completedAt || null)
    .filter(Boolean)
    .map((d) => new Date(d).getTime())
    .filter((v) => !Number.isNaN(v));

  const minDate = completedDates.length ? new Date(Math.min(...completedDates) - (14 * 24 * 60 * 60 * 1000)) : null;
  const maxDate = completedDates.length ? new Date(Math.max(...completedDates) + (14 * 24 * 60 * 60 * 1000)) : null;

  const categorySet = new Set(attachedRaces.map((race) => race.category).filter(Boolean));
  const categories = [...categorySet];

  const nearbyQuery = categories.length ? {
    category: { $in: categories },
    ...(minDate && maxDate ? { startedAt: { $gte: minDate, $lte: maxDate } } : {}),
    $or: [
      { info: /^(Group|Preliminary Bracket|Main Bracket)/i },
      { matchPlayers: { $exists: true, $ne: null } },
      { startggSetId: { $exists: true, $ne: null } },
      { $expr: { $eq: [{ $size: { $ifNull: ['$entrants', []] } }, 2] } }
    ]
  } : null;

  const nearbyRaces = nearbyQuery ? await Race.find(nearbyQuery).lean() : [];

  // Extra races provided via --race-url
  const extraRaces = extraRaceUrls.length ? await Race.find({ url: { $in: extraRaceUrls } }).lean() : [];

  // Tie-break rooms of a group belong to no set
  return uniqueByUrl([...attachedRaces, ...nearbyRaces, ...extraRaces]).filter((race) => !race.tiebreak);
}

async function processTournament(tournament, { Race }, options) {
  const { dryRun, explore } = options;

  const races = await loadCandidateRaces(Race, tournament, options.raceUrls || []);
  const matches = Array.isArray(tournament.matches) ? tournament.matches : [];
  // In-memory copy to track links during the run (prevents false positives)
  const liveMatches = matches.map((m) => ({ ...m }));
  const stats = { linked: 0, skipped: 0, ambiguous: 0, explored: 0 };

  // Track which races are linked to each set (for BO3 logging)
  const setLinks = new Map(); // startggSetId -> [{ raceUrl, score }]

  console.log(`\n🏁 ${tournament.name}`);
  console.log(`   races=${races.length} embeddedMatches=${liveMatches.length}`);

  for (const race of races) {
    const extracted = extractRaceEntrants(race, { requireDirect: true });
    const stageInfo = parseRaceStageInfo(race);

    if (stageInfo.type === 'qualifier') {
      console.log(`   ⏭️  qualifier room ${race.url} [${getRaceLabel(race)}] -> pas de link set-level`);
      stats.skipped++;
      continue;
    }

    if (!extracted.direct) {
      if (!explore) {
        console.log(`   ⏭️  skip ${race.url} (${extracted.entrantCount || 0} entrants, no direct pair)`);
        stats.skipped++;
        continue;
      }

      const explorationMatches = getExplorationMatches(race, liveMatches);
      const exploratoryScores = rankMatchesForRace(race, explorationMatches.length ? explorationMatches : liveMatches, {
        requireDirect: false,
        allowOccupiedMatchReassign: false
      });

      console.log(`   🔎 explore ${race.url} [${getRaceLabel(race)}] (${extracted.entrantCount || 0} entrants)`);
      exploratoryScores.slice(0, 3).forEach((entry, index) => {
        const players = getMatchPlayers(entry.match);
        console.log(`      ${index + 1}. set=${entry.match.startggSetId} score=${entry.score} phase=${entry.match.phase}/${entry.match.phaseGroup} round=${entry.match.round} players=${players.player1} vs ${players.player2}`);
      });
      stats.explored++;
      continue;
    }

    const candidateLiveMatches = getExplorationMatches(race, liveMatches);
    const scored = rankMatchesForRace(race, candidateLiveMatches.length ? candidateLiveMatches : liveMatches, {
      requireDirect: true,
      allowOccupiedMatchReassign: false
    });

    if (!scored.length) {
      console.log(`   ⚠️  no candidate for ${race.url}`);
      stats.ambiguous++;
      continue;
    }

    const chosen = selectBestCandidate(scored, {
      threshold: 500,
      minGap: 80,
      raceUrl: race.url
    });

    const top = scored[0];
    const topPlayers = getMatchPlayers(top.match);

    if (!chosen) {
      console.log(`   ⚠️  ambiguous ${race.url} top=${top.score} (${topPlayers.player1} vs ${topPlayers.player2})`);
      stats.ambiguous++;
      continue;
    }

    const chosenPlayers = getMatchPlayers(chosen.match);
    const setId = chosen.match.startggSetId;
    const gameInfo = getSetGameCount(chosen.match);
    const gameLabel = gameInfo && gameInfo.gamesPlayed > 1 ? ` [BO${gameInfo.bestOf || '?'} game ${(setLinks.get(setId)?.length || 0) + 1}/${gameInfo.gamesPlayed}]` : '';

    console.log(`   ✅ ${race.url} -> set ${setId} score=${chosen.score} (${chosenPlayers.player1} vs ${chosenPlayers.player2})${gameLabel}${dryRun ? ' [DRY-RUN]' : ''}`);

    // Track this link and update liveMatches to prevent false positives on subsequent races
    if (!setLinks.has(setId)) setLinks.set(setId, []);
    setLinks.get(setId).push({ raceUrl: race.url, score: chosen.score });

    // Update in-memory match to reflect the new link (prevents double-linking single-game sets)
    const liveMatchIdx = liveMatches.findIndex((m) => m.startggSetId === setId);
    if (liveMatchIdx >= 0) {
      const prev = liveMatches[liveMatchIdx];
      if (!prev.raceUrl) {
        // First link: set raceUrl
        liveMatches[liveMatchIdx] = { ...prev, raceUrl: race.url };
      }
      // Track all linked races in raceUrls array (for BO3/BO5 occupation detection)
      if (!Array.isArray(liveMatches[liveMatchIdx].raceUrls)) {
        liveMatches[liveMatchIdx].raceUrls = [];
      }
      if (!liveMatches[liveMatchIdx].raceUrls.includes(race.url)) {
        liveMatches[liveMatchIdx].raceUrls.push(race.url);
      }
    }

    if (!dryRun) {
      // Update Race
      await Race.updateOne(
        { _id: race._id },
        {
          $set: {
            tournamentId: tournament._id,
            startggSetId: setId,
            tournamentPhase: chosen.match.phase || race.tournamentPhase || null,
            tournamentPool: chosen.match.phaseGroup || race.tournamentPool || null,
            tournamentRound: chosen.match.round ?? race.tournamentRound ?? null,
            matchPlayers: `${chosen.match.player1?.name || ''} vs ${chosen.match.player2?.name || ''}`.trim(),
            matchConfidence: chosen.score
          },
          $currentDate: { updatedAt: true }
        }
      );

      // Update embedded match: add to raceUrls array, keep raceUrl as primary
      const isFirstLink = setLinks.get(setId).length <= 1;
      const updateOps = {
        $addToSet: { 'matches.$[m].raceUrls': race.url },
        $currentDate: { updatedAt: true }
      };
      if (isFirstLink) {
        updateOps.$set = {
          'matches.$[m].raceUrl': race.url,
          'matches.$[m].linkScore': chosen.score
        };
      }

      await require('mongoose').model('Tournament').updateOne(
        { _id: tournament._id },
        updateOps,
        { arrayFilters: [{ 'm.startggSetId': setId }] }
      );
    }

    stats.linked++;
  }

  // Summary per set (BO3 stats)
  const multiGameSets = [...setLinks.entries()].filter(([, links]) => links.length > 1);
  if (multiGameSets.length) {
    console.log(`\n   📐 Multi-game sets:`);
    for (const [setId, links] of multiGameSets) {
      console.log(`      set ${setId}: ${links.length} races linked`);
    }
  }

  // Sort raceUrls by chronological order (oldest to newest)
  if (!dryRun && setLinks.size > 0) {
    for (const [setId] of setLinks) {
      const linkedRaces = await Race.find({ startggSetId: setId }).lean();
      if (!linkedRaces.length) continue;

      // Sort by date (startedAt > endedAt > createdAt)
      linkedRaces.sort((a, b) => {
        const dateA = new Date(a.startedAt || a.endedAt || a.createdAt || 0).getTime();
        const dateB = new Date(b.startedAt || b.endedAt || b.createdAt || 0).getTime();
        return dateA - dateB;
      });

      const sortedUrls = linkedRaces.map((r) => r.url);

      // Update match raceUrls with chronological order
      await require('mongoose').model('Tournament').updateOne(
        { _id: tournament._id },
        {
          $set: { 'matches.$[m].raceUrls': sortedUrls },
          $currentDate: { updatedAt: true }
        },
        { arrayFilters: [{ 'm.startggSetId': setId }] }
      );
    }
  }

  return stats;
}

async function main() {
  const opts = parseArgs();
  if (!opts.all && !opts.tournamentId) {
    console.error('tournamentId required, or use --all');
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  const { Tournament, Race } = require('../models');

  const query = opts.all
    ? { startggId: { $exists: true, $ne: null } }
    : { _id: opts.tournamentId, startggId: { $exists: true, $ne: null } };

  const tournaments = await Tournament.find(query).lean();
  if (!tournaments.length) {
    console.log('No matching start.gg tournament found');
    await mongoose.disconnect();
    return;
  }

  const total = { linked: 0, skipped: 0, ambiguous: 0 };
  for (const tournament of tournaments) {
    const stats = await processTournament(tournament, { Race }, opts);
    total.linked += stats.linked;
    total.skipped += stats.skipped;
    total.ambiguous += stats.ambiguous;
    total.explored = (total.explored || 0) + stats.explored;
  }

  console.log(`\n📊 Summary: linked=${total.linked} skipped=${total.skipped} ambiguous=${total.ambiguous} explored=${total.explored || 0}${opts.dryRun ? ' [DRY-RUN]' : ''}`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
