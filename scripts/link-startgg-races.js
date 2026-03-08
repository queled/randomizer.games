#!/usr/bin/env node
/**
 * Link start.gg tournament races to embedded tournament matches.
 *
 * This script only attempts a direct match-level link when a race clearly looks
 * like a 1v1 set (exactly 2 entrants or an explicit "A vs B" pattern).
 * Large multi-entrant rooms are intentionally left at tournament-level only.
 *
 * Usage:
 *   node scripts/link-startgg-races.js <tournamentId>
 *   node scripts/link-startgg-races.js <tournamentId> --dry-run
 *   node scripts/link-startgg-races.js --all --dry-run
 */

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer';
const {
  rankMatchesForRace,
  selectBestCandidate,
  getMatchPlayers,
  extractRaceEntrants,
  getRaceLabel,
  parseRaceStageInfo
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
  if (label.startsWith('qualifier')) {
    return matches.filter((match) => String(match.phase || '').toLowerCase() === 'preliminary bracket');
  }
  if (race.tournamentPhase) {
    return matches.filter((match) => String(match.phase || '').toLowerCase() === String(race.tournamentPhase || '').toLowerCase());
  }
  return matches;
}

async function processTournament(tournament, { Race }, options) {
  const { dryRun, explore } = options;
  const raceQuery = { $or: [{ tournamentId: tournament._id }] };
  if (options.raceUrls?.length) {
    raceQuery.$or.push({ url: { $in: options.raceUrls } });
  }
  const races = await Race.find(raceQuery).lean();
  const matches = Array.isArray(tournament.matches) ? tournament.matches : [];
  const stats = { linked: 0, skipped: 0, ambiguous: 0, explored: 0 };

  console.log(`\n🏁 ${tournament.name}`);
  console.log(`   races=${races.length} embeddedMatches=${matches.length}`);

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

      const explorationMatches = getExplorationMatches(race, matches);
      const exploratoryScores = rankMatchesForRace(race, explorationMatches.length ? explorationMatches : matches, {
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

    const candidateMatches = getExplorationMatches(race, matches);
    const scored = rankMatchesForRace(race, candidateMatches.length ? candidateMatches : matches, {
      requireDirect: true,
      allowOccupiedMatchReassign: false
    });

    if (!scored.length) {
      console.log(`   ⚠️  no candidate for ${race.url}`);
      stats.ambiguous++;
      continue;
    }

    const chosen = selectBestCandidate(scored, {
      threshold: 320,
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
    console.log(`   ✅ ${race.url} -> set ${chosen.match.startggSetId} score=${chosen.score} (${chosenPlayers.player1} vs ${chosenPlayers.player2})${dryRun ? ' [DRY-RUN]' : ''}`);

    if (!dryRun) {
      await Race.updateOne(
        { _id: race._id },
        {
          $set: {
            tournamentId: tournament._id,
            startggSetId: chosen.match.startggSetId,
            tournamentPhase: chosen.match.phase || race.tournamentPhase || null,
            tournamentPool: chosen.match.phaseGroup || race.tournamentPool || null,
            tournamentRound: chosen.match.round ?? race.tournamentRound ?? null,
            matchPlayers: `${chosen.match.player1?.name || ''} vs ${chosen.match.player2?.name || ''}`.trim(),
            matchConfidence: chosen.score
          },
          $currentDate: { updatedAt: true }
        }
      );

      await require('mongoose').model('Tournament').updateOne(
        { _id: tournament._id },
        {
          $set: {
            'matches.$[m].raceUrl': race.url,
            'matches.$[m].linkScore': chosen.score
          },
          $currentDate: { updatedAt: true }
        },
        {
          arrayFilters: [{ 'm.startggSetId': chosen.match.startggSetId }]
        }
      );
    }

    stats.linked++;
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
