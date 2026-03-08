#!/usr/bin/env node
/**
 * Export dry-run autolink candidates for a start.gg tournament.
 *
 * Generates JSON + CSV reports with scored race candidates for each embedded set.
 * No database writes are performed.
 *
 * Usage:
 *   node scripts/export-startgg-autolink-candidates.js <tournamentId>
 *   node scripts/export-startgg-autolink-candidates.js <tournamentId> --top 5
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer';
const { Tournament, Race } = require('../models');
const {
  scoreRaceAgainstMatch,
  getMatchPlayers,
  getRaceLabel,
  parseRaceStageInfo,
  parseStartggDisplayScore,
  extractRaceEntrants
} = require('../helpers/race-match-linking');

function parseArgs() {
  const args = process.argv.slice(2);
  const tournamentId = args.find((arg) => !arg.startsWith('--'));
  const topIndex = args.indexOf('--top');
  const top = topIndex >= 0 ? Math.max(1, parseInt(args[topIndex + 1], 10) || 5) : 5;
  return { tournamentId, top };
}

function toIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toCsvValue(value) {
  if (value == null) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
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

function buildRaceCandidateSummary(race, scoreDetails) {
  const stageInfo = parseRaceStageInfo(race);
  const extracted = extractRaceEntrants(race, { requireDirect: false });
  return {
    raceId: String(race._id),
    raceUrl: race.url,
    raceLabel: getRaceLabel(race),
    raceInfoType: stageInfo.type,
    entrantCount: Array.isArray(race.entrants) ? race.entrants.length : 0,
    direct: extracted.direct,
    score: scoreDetails.score,
    reason: scoreDetails.reason,
    startedAt: toIso(race.startedAt),
    endedAt: toIso(race.endedAt),
    tournamentId: race.tournamentId ? String(race.tournamentId) : null,
    currentSetId: race.startggSetId || null,
    currentMatchPlayers: race.matchPlayers || null,
    currentPhase: race.tournamentPhase || null,
    currentPool: race.tournamentPool || null,
    currentRound: race.tournamentRound ?? null,
    currentConfidence: race.matchConfidence ?? null,
    bestPlayer1Matched: scoreDetails.best1?.entrant?.name || null,
    bestPlayer2Matched: scoreDetails.best2?.entrant?.name || null
  };
}

function buildAutoLinkDecision(candidates, gamesExpected) {
  const numGames = gamesExpected || 1;

  if (!candidates.length) {
    return {
      autoLinkable: false,
      threshold: null,
      gap: null,
      reason: 'no-candidate',
      gamesExpected: numGames,
      gamesFound: 0
    };
  }

  if (numGames === 1) {
    // Single-game set: same logic as before
    const top = candidates[0];
    const second = candidates[1] || null;
    const gap = second ? top.score - second.score : top.score;
    const threshold = top.direct ? 900 : 1200;
    const autoLinkable = top.score >= threshold && gap >= 120;

    return {
      autoLinkable,
      threshold,
      gap,
      reason: autoLinkable ? 'high-confidence' : 'manual-review',
      gamesExpected: 1,
      gamesFound: 1
    };
  }

  // Multi-game set (BO3, BO5): need top N candidates above threshold.
  // Lower threshold since early games may get time-proximity penalties
  // (set completedAt is end of last game, earlier games are further away).
  const threshold = candidates[0].direct ? 600 : 800;
  const qualifying = candidates.filter((c) => c.score >= threshold);
  const gamesFound = Math.min(numGames, qualifying.length);

  if (gamesFound === 0) {
    return {
      autoLinkable: false,
      threshold,
      gap: null,
      reason: 'manual-review',
      gamesExpected: numGames,
      gamesFound: 0
    };
  }

  // Check gap between last qualifying and first non-qualifying
  const lastQIdx = gamesFound - 1;
  const nextIdx = lastQIdx + 1;
  const gap = nextIdx < candidates.length ? candidates[lastQIdx].score - candidates[nextIdx].score : candidates[lastQIdx].score;
  const autoLinkable = gamesFound >= numGames && gap >= 80;

  return {
    autoLinkable,
    threshold,
    gap,
    reason: autoLinkable ? 'high-confidence' : (gamesFound > 0 ? 'manual-review' : 'no-candidate'),
    gamesExpected: numGames,
    gamesFound
  };
}

async function loadCandidateRaces(tournament) {
  const embeddedMatches = Array.isArray(tournament.matches) ? tournament.matches : [];
  const completedDates = embeddedMatches
    .map((m) => m.completedAt || null)
    .filter(Boolean)
    .map((d) => new Date(d).getTime())
    .filter((v) => !Number.isNaN(v));

  const minDate = completedDates.length ? new Date(Math.min(...completedDates) - (14 * 24 * 60 * 60 * 1000)) : null;
  const maxDate = completedDates.length ? new Date(Math.max(...completedDates) + (14 * 24 * 60 * 60 * 1000)) : null;

  const attachedRaces = await Race.find({ tournamentId: tournament._id }).lean();
  const categorySet = new Set(attachedRaces.map((race) => race.category).filter(Boolean));
  const categories = [...categorySet];

  const extraQuery = categories.length ? {
    category: { $in: categories },
    ...(minDate && maxDate ? { startedAt: { $gte: minDate, $lte: maxDate } } : {}),
    $or: [
      { info: /^(Group|Preliminary Bracket|Main Bracket)/i },
      { matchPlayers: { $exists: true, $ne: null } },
      { startggSetId: { $exists: true, $ne: null } },
      { $expr: { $eq: [{ $size: { $ifNull: ['$entrants', []] } }, 2] } }
    ]
  } : null;

  const nearbyRaces = extraQuery ? await Race.find(extraQuery).lean() : [];
  return uniqueByUrl([...attachedRaces, ...nearbyRaces]);
}

async function main() {
  const { tournamentId, top } = parseArgs();
  if (!tournamentId) {
    console.error('tournamentId required');
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);

  const tournament = await Tournament.findById(tournamentId).lean();
  if (!tournament || !tournament.startggId) {
    console.error('Start.gg tournament not found');
    await mongoose.disconnect();
    process.exit(1);
  }

  const matches = Array.isArray(tournament.matches) ? tournament.matches : [];
  const candidateRaces = await loadCandidateRaces(tournament);

  const report = {
    generatedAt: new Date().toISOString(),
    tournamentId: String(tournament._id),
    tournamentName: tournament.name,
    startggTournamentId: tournament.startggTournamentId || null,
    racesConsidered: candidateRaces.length,
    matchesCount: matches.length,
    matches: []
  };

  for (const match of matches) {
    const players = getMatchPlayers(match);
    const dsInfo = parseStartggDisplayScore(match.displayScore);
    const gamesExpected = dsInfo ? dsInfo.gamesPlayed : 1;

    // For BO3+, increase top candidates to show enough games
    const topForMatch = Math.max(top, gamesExpected + 2);
    const candidates = candidateRaces
      .map((race) => {
        const details = scoreRaceAgainstMatch(race, match, {
          requireDirect: false,
          allowOccupiedMatchReassign: false
        });
        return { race, details };
      })
      .filter((entry) => entry.details.score > 0)
      .sort((a, b) => b.details.score - a.details.score)
      .slice(0, topForMatch)
      .map((entry) => buildRaceCandidateSummary(entry.race, entry.details));

    const decision = buildAutoLinkDecision(candidates, gamesExpected);

    report.matches.push({
      startggSetId: match.startggSetId,
      phase: match.phase || null,
      pool: match.phaseGroup || null,
      round: match.round ?? null,
      completedAt: toIso(match.completedAt),
      displayScore: match.displayScore || null,
      player1: players.player1,
      player2: players.player2,
      existingRaceUrl: match.raceUrl || null,
      existingRaceUrls: Array.isArray(match.raceUrls) ? match.raceUrls : [],
      existingLinkScore: match.linkScore ?? null,
      gamesExpected,
      bestOf: dsInfo?.bestOf || null,
      autoLinkable: decision.autoLinkable,
      decisionReason: decision.reason,
      gamesFound: decision.gamesFound,
      threshold: decision.threshold,
      scoreGap: decision.gap,
      topCandidates: candidates
    });
  }

  const reportsDir = path.join(__dirname, '..', 'reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  const baseName = `startgg-autolink-${tournamentId}`;
  const jsonPath = path.join(reportsDir, `${baseName}.json`);
  const csvPath = path.join(reportsDir, `${baseName}.csv`);

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

  const csvRows = [
    [
      'startggSetId',
      'phase',
      'pool',
      'round',
      'player1',
      'player2',
      'completedAt',
      'displayScore',
      'bestOf',
      'gamesExpected',
      'gamesFound',
      'autoLinkable',
      'decisionReason',
      'game1_raceUrl',
      'game1_raceLabel',
      'game1_score',
      'game1_raceType',
      'game2_raceUrl',
      'game2_raceLabel',
      'game2_score',
      'game3_raceUrl',
      'game3_raceLabel',
      'game3_score',
      'scoreGap'
    ].join(';')
  ];

  for (const match of report.matches) {
    const c1 = match.topCandidates[0] || {};
    const c2 = match.topCandidates[1] || {};
    const c3 = match.topCandidates[2] || {};
    csvRows.push([
      match.startggSetId,
      match.phase,
      match.pool,
      match.round,
      match.player1,
      match.player2,
      match.completedAt,
      match.displayScore,
      match.bestOf,
      match.gamesExpected,
      match.gamesFound,
      match.autoLinkable,
      match.decisionReason,
      c1.raceUrl,
      c1.raceLabel,
      c1.score,
      c1.raceInfoType,
      c2.raceUrl,
      c2.raceLabel,
      c2.score,
      c3.raceUrl,
      c3.raceLabel,
      c3.score,
      match.scoreGap
    ].map(toCsvValue).join(';'));
  }

  fs.writeFileSync(csvPath, `${csvRows.join('\n')}\n`);

  const autoLinkableCount = report.matches.filter((m) => m.autoLinkable).length;
  const boMultiCount = report.matches.filter((m) => m.gamesExpected > 1).length;
  console.log(`Report JSON: ${jsonPath}`);
  console.log(`Report CSV: ${csvPath}`);
  console.log(`Matches: ${report.matches.length} (${boMultiCount} multi-game sets)`);
  console.log(`Candidate races considered: ${candidateRaces.length}`);
  console.log(`Auto-linkable matches: ${autoLinkableCount}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
