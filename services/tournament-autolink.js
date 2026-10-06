const {
  rankMatchesForRace,
  selectBestCandidate,
  getMatchPlayers,
  getRaceLabel,
  parseRaceStageInfo,
  parseStartggDisplayScore
} = require('../helpers/race-match-linking');

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

function isTournamentStartgg(tournament) {
  return !!tournament?.startggId;
}

function getTournamentGameDoc(tournament) {
  return tournament?.game && typeof tournament.game === 'object' && !Array.isArray(tournament.game)
    ? tournament.game
    : null;
}

function collectCandidateCategories(tournament, attachedRaces = []) {
  const categories = new Set(
    attachedRaces
      .map((race) => race?.category)
      .filter(Boolean)
  );

  const game = getTournamentGameDoc(tournament);
  const primarySlug = game?.integrations?.racetime?.gameSlug;
  const extraSlugs = Array.isArray(game?.integrations?.racetime?.gameSlugs)
    ? game.integrations.racetime.gameSlugs
    : [];

  if (primarySlug) categories.add(primarySlug);
  for (const slug of extraSlugs) {
    if (slug) categories.add(slug);
  }

  return [...categories];
}

function getTournamentWindow(tournament, matches = []) {
  const timestamps = matches
    .map((match) => match?.completedAt || match?.startedAt || null)
    .filter(Boolean)
    .map((value) => new Date(value).getTime())
    .filter((value) => !Number.isNaN(value));

  if (tournament?.startDate) {
    const startTs = new Date(tournament.startDate).getTime();
    if (!Number.isNaN(startTs)) timestamps.push(startTs);
  }

  if (tournament?.endDate) {
    const endTs = new Date(tournament.endDate).getTime();
    if (!Number.isNaN(endTs)) timestamps.push(endTs);
  }

  if (!timestamps.length) {
    return { minDate: null, maxDate: null };
  }

  const paddingMs = 14 * 24 * 60 * 60 * 1000;
  return {
    minDate: new Date(Math.min(...timestamps) - paddingMs),
    maxDate: new Date(Math.max(...timestamps) + paddingMs)
  };
}

// Stage family of a start.gg phase: 'swiss', 'groups' (pools / round robin) or 'bracket'
function getPhaseFamily(phase) {
  const type = String(phase?.bracketType || '').toUpperCase();
  const name = String(phase?.name || '').toLowerCase();
  if (type === 'SWISS' || /\bswiss\b/.test(name)) return 'swiss';
  if (type === 'ROUND_ROBIN' || Number(phase?.groupCount) > 1 || /\b(groups?|groupe|pools?|poules?|div|preliminary)\b/.test(name)) return 'groups';
  return 'bracket';
}

// Stage family announced by a race label ("Swiss Round 5: A vs B", "Group E: ...", "Top 8 Final: ...")
function getRaceLabelStage(race) {
  const label = getRaceLabel(race).split(':')[0].toLowerCase();
  if (/\b(groups?|groupe|pools?|poules?|div|preliminary)\b/.test(label)) return { family: 'groups' };
  const swiss = /\bswiss\b(?:.*?\bround\s+(\d+))?/.exec(label);
  if (swiss) return { family: 'swiss', round: swiss[1] ? Number(swiss[1]) : null };
  if (/\b(brackets?|top\s+\d+|finals?|semi-?finals?|quarter-?finals?|playoffs?)\b/.test(label)) return { family: 'bracket' };
  return null;
}

// Restrict start.gg candidates to the phase the race label names; null when the
// label names a stage this tournament does not have (the race belongs to another event)
function filterMatchesByRaceStage(race, matches, tournament) {
  const phases = Array.isArray(tournament?.phases) ? tournament.phases : [];
  const stage = getRaceLabelStage(race);
  if (!stage || !phases.length) return matches;

  const phaseNames = new Set(phases.filter((phase) => getPhaseFamily(phase) === stage.family).map((phase) => phase.name));
  if (!phaseNames.size) return null;

  return matches.filter((match) => (
    phaseNames.has(match.phase) &&
    (stage.round == null || Number(match.round) === stage.round)
  ));
}

function isLinkableStartggState(state) {
  if (state === undefined || state === null || state === '') return true;
  const numericState = Number(state);
  return numericState === 2 || numericState === 3;
}

function isLinkableChallongeMatch(match) {
  const state = String(match?.state || '').toLowerCase();
  if (!state) return true;
  if (['complete', 'completed', 'done', 'closed'].includes(state)) return true;
  if (['underway', 'in_progress', 'in-progress', 'active'].includes(state)) return true;
  if (state === 'open' && match?.startedAt) return true;
  return false;
}

function normalizeStartggMatches(tournament) {
  return (Array.isArray(tournament?.matches) ? tournament.matches : [])
    .filter((match) => {
      const p1 = match?.player1?.name || '';
      const p2 = match?.player2?.name || '';
      if (!p1 || !p2 || p1 === 'TBD' || p2 === 'TBD') return false;
      if (!isLinkableStartggState(match.state)) return false;
      return true;
    })
    .map((match) => ({
      _id: match.startggSetId || String(match._id || ''),
      startggSetId: match.startggSetId,
      round: match.round,
      phase: match.phase || null,
      phaseGroup: match.phaseGroup || null,
      player1Name: match.player1?.name || 'TBD',
      player2Name: match.player2?.name || 'TBD',
      displayScore: match.displayScore || null,
      state: match.state,
      startedAt: match.startedAt || null,
      completedAt: match.completedAt,
      raceUrl: match.raceUrl || null,
      raceUrls: Array.isArray(match.raceUrls) ? [...match.raceUrls] : (match.raceUrl ? [match.raceUrl] : []),
      linkScore: match.linkScore || null,
      isEmbedded: true
    }));
}

function normalizeChallongeMatches(matches) {
  return (Array.isArray(matches) ? matches : [])
    .filter((match) => {
      const p1 = match?.player1Name || '';
      const p2 = match?.player2Name || '';
      if (!p1 || !p2 || p1 === 'TBD' || p2 === 'TBD') return false;
      if (!isLinkableChallongeMatch(match)) return false;
      return true;
    })
    .map((match) => ({
      _id: match._id.toString(),
      round: match.round,
      phase: null,
      phaseGroup: match.groupId || null,
      player1Name: match.player1Name || 'TBD',
      player2Name: match.player2Name || 'TBD',
      displayScore: null,
      scoresCsv: match.scoresCsv || null,
      state: match.state,
      startedAt: match.startedAt || null,
      completedAt: match.completedAt,
      raceUrl: match.raceUrl || null,
      raceUrls: match.raceUrl ? [match.raceUrl] : [],
      linkScore: null,
      isEmbedded: false
    }));
}

async function loadNormalizedMatches({ tournament, Match }) {
  if (isTournamentStartgg(tournament)) {
    return normalizeStartggMatches(tournament);
  }

  const challongeMatches = await Match.find({ tournamentId: tournament._id }).lean();
  return normalizeChallongeMatches(challongeMatches);
}

function getExpectedStartggRaceCount(match) {
  const parsed = parseStartggDisplayScore(match?.displayScore);
  return Math.max(parsed?.gamesPlayed || 1, 1);
}

function hasAvailableStartggSlot(match, raceUrl = null) {
  const raceUrls = Array.isArray(match?.raceUrls) ? match.raceUrls : [];
  if (raceUrl && raceUrls.includes(raceUrl)) return true;
  const currentCount = raceUrls.length || (match?.raceUrl ? 1 : 0);
  return currentCount < getExpectedStartggRaceCount(match);
}

async function loadCandidateRaces({ tournament, Race, matches = [], extraRaceUrls = [] }) {
  const attachedRaces = await Race.find({ tournamentId: tournament._id }).lean();
  const categories = collectCandidateCategories(tournament, attachedRaces);
  const { minDate, maxDate } = getTournamentWindow(tournament, matches);

  let nearbyRaces = [];
  if (categories.length) {
    const nearbyQuery = {
      category: { $in: categories },
      ...(minDate && maxDate ? { startedAt: { $gte: minDate, $lte: maxDate } } : {}),
      $or: [
        { info: /^(Group|Preliminary Bracket|Main Bracket|Qualifier)/i },
        { matchPlayers: { $exists: true, $ne: null } },
        { startggSetId: { $exists: true, $ne: null } },
        { matchId: { $exists: true, $ne: null } },
        { $expr: { $eq: [{ $size: { $ifNull: ['$entrants', []] } }, 2] } }
      ]
    };

    nearbyRaces = await Race.find(nearbyQuery).lean();
  }

  const extraRaces = extraRaceUrls.length
    ? await Race.find({ url: { $in: extraRaceUrls } }).lean()
    : [];

  return uniqueByUrl([...attachedRaces, ...nearbyRaces, ...extraRaces]).filter((race) => {
    if (!race?.url) return false;
    if (!race.tournamentId) return true;
    return String(race.tournamentId) === String(tournament._id) || !(race.matchId || race.startggSetId);
  });
}

const GOAL_STOPWORDS = new Set([
  'tournament', 'tourney', 'season', 'saison', 'standard', 'ruleset', 'the', 'of', 'and', 'vs',
  'game', 'beat', 'randomizer', 'rando', 'oot', 'ootr', 'race', 'round', 'any', 'normal', 'top',
  'bracket', 'brackets', 'group', 'groups', 'pool', 'pools', 'main'
]);

function goalTokens(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !GOAL_STOPWORDS.has(token));
}

function goalsLookAlike(a, b) {
  const left = String(a || '').toLowerCase().trim();
  const right = String(b || '').toLowerCase().trim();
  if (!left || !right) return false;
  if (left.includes(right) || right.includes(left)) return true;
  const rightTokens = new Set(goalTokens(right));
  return goalTokens(left).some((token) => rightTokens.has(token));
}

/**
 * Racetime goals are usually per event ("Random settings league", "SGL 2025"...): drop
 * proposals whose goal neither matches the tournament's dominant goal nor its name,
 * they come from another event the same players met in.
 */
function filterProposalsByGoal(tournament, proposals, races) {
  const goalByUrl = new Map(races.map((race) => [race.url, race.goal || '']));
  const stageByUrl = new Map(races.map((race) => [race.url, getRaceLabel(race).split(':')[0]]));
  const counts = new Map();
  for (const proposal of proposals) {
    const goal = goalByUrl.get(proposal.raceUrl);
    if (goal) counts.set(goal, (counts.get(goal) || 0) + 1);
  }

  const [dominantGoal, dominantCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0];
  const dominant = dominantCount >= 5 && dominantCount / proposals.length >= 0.6 ? dominantGoal : null;

  return proposals.filter((proposal) => {
    const goal = goalByUrl.get(proposal.raceUrl);
    if (!goal) return true;
    return (dominant && goalsLookAlike(goal, dominant)) ||
      goalsLookAlike(goal, tournament?.name) ||
      goalsLookAlike(stageByUrl.get(proposal.raceUrl), tournament?.name);
  });
}

async function buildAutoLinkPreview({
  tournament,
  Match,
  Race,
  threshold = 300,
  minGap = 50,
  extraRaceUrls = []
}) {
  const matches = await loadNormalizedMatches({ tournament, Match });
  const races = await loadCandidateRaces({ tournament, Race, matches, extraRaceUrls });
  const liveMatches = matches.map((match) => ({
    ...match,
    raceUrls: Array.isArray(match.raceUrls) ? [...match.raceUrls] : []
  }));

  const proposals = [];
  let skipped = 0;

  for (const race of races) {
    const isAlreadyLinked = isTournamentStartgg(tournament) ? !!race.startggSetId : !!race.matchId;
    if (isAlreadyLinked) {
      skipped++;
      continue;
    }

    if (race.tournamentId && String(race.tournamentId) !== String(tournament._id) && (race.matchId || race.startggSetId)) {
      skipped++;
      continue;
    }

    if (['pending', 'cancelled'].includes(race.status)) {
      skipped++;
      continue;
    }

    const stageInfo = parseRaceStageInfo(race);
    if (stageInfo.type === 'qualifier') {
      skipped++;
      continue;
    }

    const stageMatches = isTournamentStartgg(tournament)
      ? filterMatchesByRaceStage(race, liveMatches, tournament)
      : liveMatches;
    if (!stageMatches || !stageMatches.length) {
      skipped++;
      continue;
    }

    const candidateMatches = isTournamentStartgg(tournament)
      ? stageMatches.filter((match) => hasAvailableStartggSlot(match, race.url))
      : stageMatches.filter((match) => !match.raceUrl || match.raceUrl === race.url);

    const scored = rankMatchesForRace(
      race,
      candidateMatches.length ? candidateMatches : stageMatches,
      {
        requireDirect: true,
        allowOccupiedMatchReassign: false,
        skipOccupiedPenalty: isTournamentStartgg(tournament)
      }
    );

    const chosen = selectBestCandidate(scored, {
      threshold,
      minGap,
      raceUrl: race.url
    });

    if (!chosen) {
      skipped++;
      continue;
    }

    const players = getMatchPlayers(chosen.match);
    proposals.push({
      raceUrl: race.url,
      raceLabel: getRaceLabel(race),
      raceEntrants: (race.entrants || []).length,
      matchId: String(chosen.match.startggSetId || chosen.match._id),
      matchPlayers: `${players.player1} vs ${players.player2}`,
      matchPhase: chosen.match.phase || null,
      matchRound: chosen.match.round || null,
      score: chosen.score,
      isStartgg: isTournamentStartgg(tournament)
    });

    const liveIndex = liveMatches.findIndex((match) => String(match.startggSetId || match._id) === String(chosen.match.startggSetId || chosen.match._id));
    if (liveIndex >= 0) {
      if (isTournamentStartgg(tournament)) {
        if (!liveMatches[liveIndex].raceUrl) {
          liveMatches[liveIndex].raceUrl = race.url;
        }
        if (!Array.isArray(liveMatches[liveIndex].raceUrls)) {
          liveMatches[liveIndex].raceUrls = [];
        }
        if (!liveMatches[liveIndex].raceUrls.includes(race.url)) {
          liveMatches[liveIndex].raceUrls.push(race.url);
        }
      } else {
        liveMatches[liveIndex].raceUrl = race.url;
        liveMatches[liveIndex].raceUrls = [race.url];
      }
    }
  }

  const coherent = filterProposalsByGoal(tournament, proposals, races);
  skipped += proposals.length - coherent.length;

  coherent.sort((a, b) => b.score - a.score);
  return { proposals: coherent, skipped, total: races.length, matches, races };
}

function getRaceSortTimestamp(race) {
  const value = race?.startedAt || race?.endedAt || race?.createdAt || race?.updatedAt || null;
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

async function sortStartggLinkedRaces({ tournament, Race, touchedSetIds }) {
  if (!touchedSetIds?.size || !Array.isArray(tournament?.matches)) return;

  const setIds = [...touchedSetIds].filter(Boolean);
  if (!setIds.length) return;

  const linkedRaces = await Race.find({
    tournamentId: tournament._id,
    startggSetId: { $in: setIds }
  }).lean();

  const racesBySet = new Map();
  for (const race of linkedRaces) {
    const setId = String(race?.startggSetId || '');
    if (!setId) continue;
    if (!racesBySet.has(setId)) racesBySet.set(setId, []);
    racesBySet.get(setId).push(race);
  }

  for (const setId of setIds) {
    const embeddedMatch = tournament.matches.find((match) => String(match?.startggSetId || '') === String(setId));
    if (!embeddedMatch) continue;

    const sortedUrls = (racesBySet.get(String(setId)) || [])
      .sort((a, b) => getRaceSortTimestamp(a) - getRaceSortTimestamp(b))
      .map((race) => race.url)
      .filter(Boolean);

    if (!sortedUrls.length) continue;
    embeddedMatch.raceUrls = sortedUrls;
    embeddedMatch.raceUrl = sortedUrls[0] || null;
  }
}

async function applyAutoLinkProposals({ tournament, proposals, Race, Match }) {
  let linked = 0;
  let tournamentDirty = false;
  const errors = [];
  const touchedStartggSetIds = new Set();

  for (const proposal of proposals) {
    try {
      const race = await Race.findOne({ url: proposal.raceUrl });
      if (!race) {
        errors.push(`Race ${proposal.raceUrl} not found`);
        continue;
      }

      if (race.tournamentId && String(race.tournamentId) !== String(tournament._id) && (race.matchId || race.startggSetId)) {
        errors.push(`Race ${proposal.raceUrl} is already linked to another tournament`);
        continue;
      }

      if (isTournamentStartgg(tournament)) {
        const embeddedMatch = tournament.matches?.find((match) => (
          String(match.startggSetId || '') === String(proposal.matchId) ||
          String(match._id || '') === String(proposal.matchId)
        ));

        if (!embeddedMatch) {
          errors.push(`Match ${proposal.matchId} not found`);
          continue;
        }

        if (!hasAvailableStartggSlot({
          raceUrl: embeddedMatch.raceUrl,
          raceUrls: embeddedMatch.raceUrls,
          displayScore: embeddedMatch.displayScore
        }, proposal.raceUrl)) {
          errors.push(`Match ${proposal.matchId} is already full`);
          continue;
        }

        race.tournamentId = tournament._id;
        race.startggSetId = embeddedMatch.startggSetId;
        race.matchId = undefined;
        race.matchPlayers = proposal.matchPlayers;
        race.matchConfidence = proposal.score;
        race.tournamentPhase = embeddedMatch.phase || null;
        race.tournamentPool = embeddedMatch.phaseGroup || null;
        race.tournamentRound = embeddedMatch.round ?? null;
        await race.save();

        if (!embeddedMatch.raceUrl) {
          embeddedMatch.raceUrl = proposal.raceUrl;
        }
        embeddedMatch.linkScore = proposal.score;
        if (!Array.isArray(embeddedMatch.raceUrls)) embeddedMatch.raceUrls = [];
        if (!embeddedMatch.raceUrls.includes(proposal.raceUrl)) {
          embeddedMatch.raceUrls.push(proposal.raceUrl);
        }
        tournamentDirty = true;
        touchedStartggSetIds.add(String(embeddedMatch.startggSetId || proposal.matchId || ''));
      } else {
        const matchDoc = await Match.findById(proposal.matchId);
        if (!matchDoc) {
          errors.push(`Match ${proposal.matchId} not found`);
          continue;
        }

        if (matchDoc.raceUrl && matchDoc.raceUrl !== proposal.raceUrl) {
          errors.push(`Match ${proposal.matchId} is already linked`);
          continue;
        }

        race.tournamentId = tournament._id;
        race.matchId = matchDoc._id;
        race.startggSetId = undefined;
        race.matchConfidence = proposal.score;
        race.matchPlayers = proposal.matchPlayers;
        race.tournamentPhase = undefined;
        race.tournamentPool = undefined;
        race.tournamentRound = undefined;
        await race.save();

        matchDoc.raceUrl = proposal.raceUrl;
        matchDoc.completedAt = race.endedAt || matchDoc.completedAt;
        await matchDoc.save();
      }

      linked++;
    } catch (error) {
      errors.push(`Error linking ${proposal.raceUrl}: ${error.message}`);
    }
  }

  if (tournamentDirty) {
    await sortStartggLinkedRaces({ tournament, Race, touchedSetIds: touchedStartggSetIds });
    tournament.markModified('matches');
    tournament.updatedAt = new Date();
    await tournament.save();
  }

  return { linked, total: proposals.length, errors };
}

module.exports = {
  loadNormalizedMatches,
  loadCandidateRaces,
  buildAutoLinkPreview,
  applyAutoLinkProposals,
  getExpectedStartggRaceCount,
  hasAvailableStartggSlot
};
