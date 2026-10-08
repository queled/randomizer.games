const {
  rankMatchesForRace,
  selectBestCandidate,
  learnPlayerAliases,
  normalizeName,
  getMatchPlayers,
  getRaceLabel,
  scoreNameMatch,
  parseRaceStageInfo,
  parseStartggDisplayScore
} = require('../helpers/race-match-linking');
const { syncParticipantAccounts } = require('../helpers/participant-accounts');

// tournamentPhase of the races attached to a tournament as qualifiers
const QUALIFIER_PHASE = 'Qualifications';

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
function filterMatchesByRaceStage(race, matches, tournament, { ignoreRound = false } = {}) {
  const phases = Array.isArray(tournament?.phases) ? tournament.phases : [];
  const stage = getRaceLabelStage(race);
  if (!stage || !phases.length) return matches;

  const phaseNames = new Set(phases.filter((phase) => getPhaseFamily(phase) === stage.family).map((phase) => phase.name));
  if (!phaseNames.size) return null;

  return matches.filter((match) => (
    phaseNames.has(match.phase) &&
    (ignoreRound || stage.round == null || Number(match.round) === stage.round)
  ));
}

// Double elimination side named by a race label: losers rounds are negative on both
// Challonge and start.gg ("Lower Bracket Round 4" must not land on the winners match
// of the same two players)
function getRaceLabelBracketSide(race) {
  const label = getRaceLabel(race).toLowerCase();
  if (/\b(lower|losers?)\s*(brackets?|round|finals?|semi)/.test(label)) return 'losers';
  if (/\b(upper|winners?)\s*(brackets?|round|finals?|semi)/.test(label)) return 'winners';
  return null;
}

function getMatchTimestamp(match) {
  const timestamp = new Date(match?.completedAt || match?.startedAt || 0).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

// A grand final often opposes the winners finalists again: only the winners side
// rounds completed after the losers final (deepest negative round) of their phase
function filterGrandFinalMatches(matches) {
  const losersFinals = new Map();
  for (const match of matches) {
    const round = Number(match.round);
    if (!(round < 0)) continue;
    const current = losersFinals.get(match.phase);
    if (!current || round < current.round) losersFinals.set(match.phase, { round, at: getMatchTimestamp(match) });
    else if (round === current.round) current.at = Math.max(current.at, getMatchTimestamp(match));
  }
  if (!losersFinals.size) return matches;

  return matches.filter((match) => {
    if (!(Number(match.round) > 0)) return false;
    const losersFinal = losersFinals.get(match.phase);
    return !losersFinal?.at || getMatchTimestamp(match) >= losersFinal.at;
  });
}

function filterMatchesByBracketSide(race, matches) {
  if (/\bgrand\s*finals?\b/i.test(getRaceLabel(race))) return filterGrandFinalMatches(matches);

  const side = getRaceLabelBracketSide(race);
  if (!side || !matches.some((match) => Number(match.round) < 0)) return matches;
  return matches.filter((match) => (side === 'losers' ? Number(match.round) < 0 : Number(match.round) > 0));
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
      player1Members: match.player1?.members || [],
      player2Members: match.player2?.members || [],
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

function normalizeChallongeMatches(matches, raceUrlsByMatch = new Map()) {
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
      raceUrls: raceUrlsByMatch.get(String(match._id)) || (match.raceUrl ? [match.raceUrl] : []),
      linkScore: null,
      isEmbedded: false
    }));
}

async function loadNormalizedMatches({ tournament, Match, Race = null }) {
  if (isTournamentStartgg(tournament)) {
    return normalizeStartggMatches(tournament);
  }

  const challongeMatches = await Match.find({ tournamentId: tournament._id }).lean();

  // A Challonge match stores one raceUrl; the other games of a series only carry matchId
  const raceUrlsByMatch = new Map();
  if (Race) {
    const linkedRaces = await Race.find({ tournamentId: tournament._id, matchId: { $ne: null } })
      .select('url matchId startedAt endedAt')
      .lean();
    linkedRaces.sort((a, b) => getRaceSortTimestamp(a) - getRaceSortTimestamp(b));
    for (const race of linkedRaces) {
      const key = String(race.matchId);
      if (!raceUrlsByMatch.has(key)) raceUrlsByMatch.set(key, []);
      raceUrlsByMatch.get(key).push(race.url);
    }
  }

  return normalizeChallongeMatches(challongeMatches, raceUrlsByMatch);
}

// Race tournaments often record each player's finish time as the Challonge score,
// as h:mm:ss digits ("31532-31110" = 3:15:32 and 3:11:10, 0 for a forfeit)
function parseChallongeRaceTimes(scoresCsv) {
  const score = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(String(scoresCsv || ''));
  if (!score) return null;
  const values = [Number(score[1]), Number(score[2])];
  if (!values.some((value) => value >= 1000)) return null;

  const seconds = values.filter((value) => value > 0).map((value) => {
    const minutes = Math.floor(value / 100) % 100;
    const secs = value % 100;
    return minutes < 60 && secs < 60 ? Math.floor(value / 10000) * 3600 + minutes * 60 + secs : null;
  });
  return seconds.every((value) => value !== null) ? seconds : null;
}

// A race whose finish times match none of the times recorded on the match is
// another race between the same players (practice, earlier meeting)
function contradictsRecordedTimes(race, match) {
  const recorded = parseChallongeRaceTimes(match?.scoresCsv);
  if (!recorded) return false;
  const finishes = (race?.entrants || [])
    .map((entrant) => Number(entrant?.finishTimeMs) / 1000)
    .filter((value) => value > 0);
  if (!finishes.length) return false;
  // Organizers sometimes note the time a few seconds off the room's
  return !recorded.some((time) => finishes.some((finish) => Math.abs(finish - time) <= 5));
}

// Games played in a Challonge series: one set per game ("1-0,0-1,0-0" = 2 games, the
// unplayed 0-0 set excluded), or a single series score ("2-1" = 3 games)
function getChallongeGamesPlayed(scoresCsv) {
  if (parseChallongeRaceTimes(scoresCsv)) return 1;
  const sets = String(scoresCsv || '')
    .split(',')
    .map((set) => /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(set))
    .filter(Boolean)
    .map((set) => [Number(set[1]), Number(set[2])]);
  if (!sets.length) return 0;

  const isPerGame = sets.every(([a, b]) => a + b <= 1);
  if (isPerGame) return sets.filter(([a, b]) => a + b === 1).length;
  if (sets.length === 1) return sets[0][0] + sets[0][1];
  return sets.length;
}

function getExpectedStartggRaceCount(match) {
  const gamesPlayed = match?.displayScore
    ? parseStartggDisplayScore(match.displayScore)?.gamesPlayed
    : getChallongeGamesPlayed(match?.scoresCsv);
  return Math.max(gamesPlayed || 1, 1);
}

// "Game 3", "(G2)", "game 1": the game of the series a race label announces
function getRaceGameNumber(race) {
  const game = /\b(?:game|g)\s*(\d{1,2})\b/i.exec(String(race?.info || '').split('\n')[0]);
  return game ? Number(game[1]) : null;
}

function getMaxGameNumber(races) {
  return Math.max(0, ...races.map((race) => getRaceGameNumber(race) || 0));
}

// Some organizers only record the series winner ("1-0" for a BO3), so a race
// labelled "Game 3" (the candidate, or one already linked: maxGameNumber) proves
// at least three games were played
function hasAvailableStartggSlot(match, raceUrl = null, gameNumber = null) {
  const raceUrls = Array.isArray(match?.raceUrls) ? match.raceUrls : [];
  if (raceUrl && (raceUrls.includes(raceUrl) || match?.raceUrl === raceUrl)) return true;
  const currentCount = raceUrls.length || (match?.raceUrl ? 1 : 0);
  const expected = Math.max(getExpectedStartggRaceCount(match), gameNumber || 0, match?.maxGameNumber || 0);
  return currentCount < expected;
}

async function loadCandidateRaces({ tournament, Race, matches = [], extraRaceUrls = [] }) {
  const attachedRaces = await Race.find({ tournamentId: tournament._id }).lean();
  const categories = collectCandidateCategories(tournament, attachedRaces);
  const { minDate, maxDate } = getTournamentWindow(tournament, matches);
  // Team rooms (co-op) hold the players of both teams
  const teamSize = Math.max(0, ...matches.flatMap((match) => [match.player1Members?.length || 0, match.player2Members?.length || 0]));
  const roomSize = { $size: { $ifNull: ['$entrants', []] } };

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
        { $expr: { $eq: [roomSize, 2] } },
        ...(teamSize > 1 ? [{ $expr: { $and: [{ $gte: [roomSize, 3] }, { $lte: [roomSize, teamSize * 2] }] } }] : [])
      ]
    };

    nearbyRaces = await Race.find(nearbyQuery).lean();
  }

  const extraRaces = extraRaceUrls.length
    ? await Race.find({ url: { $in: extraRaceUrls } }).lean()
    : [];

  return uniqueByUrl([...attachedRaces, ...nearbyRaces, ...extraRaces]).filter((race) => {
    if (!race?.url || race.tiebreak) return false;
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
    // "Season 3" and "S3" name the same edition
    .replace(/\b(?:season|saison)\s*(\d+)\b/g, 's$1')
    .split(/[^a-z0-9]+/)
    // "Event2026" and "Event26" name the same edition
    .map((token) => token.replace(/^([a-z]+)20(\d{2})$/, '$1$2'))
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

// "League S6 Division 2 ...", "Step Ladder Series ...", "Weekly ...": a recurring series
// the tournament is not part of, even when the same two players meet
const EVENT_SERIES_RE = /\b(league|ladder|weekly)\b/i;

function namesOtherEventSeries(label, tournamentName) {
  const series = EVENT_SERIES_RE.exec(String(label || ''));
  return !!series && !new RegExp(`\\b${series[1]}\\b`, 'i').test(String(tournamentName || ''));
}

const STAGE_WORDS = new Set([
  'swiss', 'stage', 'week', 'top', 'winners', 'winner', 'losers', 'loser', 'upper', 'lower', 'grand',
  'final', 'finals', 'semi', 'semis', 'semifinal', 'semifinals', 'quarter', 'quarters', 'quarterfinal',
  'quarterfinals', 'elimination', 'playoff', 'playoffs', 'match', 'set', 'async', 'live'
]);

// "CT7 - Ragnoth vs Megaslim": words before the players that are neither a stage, a
// round number nor a player, and share nothing with the tournament name
function namesOtherEvent(label, matchPlayers, tournamentName) {
  const parts = String(label || '').split(/\s+(?:vs\.?|v\.?)\s+/i);
  if (parts.length < 2) return false;

  const playerTokens = goalTokens(matchPlayers);
  const eventTokens = goalTokens(parts[0]).filter((token) => (
    !STAGE_WORDS.has(token) &&
    !/^[a-z]?\d+$/.test(token) &&
    !playerTokens.some((player) => player.startsWith(token) || token.startsWith(player))
  ));
  if (!eventTokens.length) return false;

  const tournamentTokens = new Set(goalTokens(tournamentName));
  return !eventTokens.some((token) => tournamentTokens.has(token));
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
    if (namesOtherEventSeries(stageByUrl.get(proposal.raceUrl), tournament?.name)) return false;
    // A room goal like "League Season 8" names another event even when the season matches
    if (namesOtherEventSeries(goalByUrl.get(proposal.raceUrl), tournament?.name)) return false;
    // Players read from the label rather than the room entrants: only trust labels that
    // name this event ("League 2025 - ..."), not another one the same players met in ("CT7 - ...")
    if (proposal.fromLabel && !goalsLookAlike(proposal.raceLabel, tournament?.name)) return false;
    // Players recognised through an alias or a nickname: reject rooms naming another event
    if (proposal.inferred && namesOtherEvent(proposal.raceLabel, proposal.matchPlayers, tournament?.name)) return false;
    const goal = goalByUrl.get(proposal.raceUrl);
    if (!goal) return true;
    return (dominant && goalsLookAlike(goal, dominant)) ||
      goalsLookAlike(goal, tournament?.name) ||
      goalsLookAlike(stageByUrl.get(proposal.raceUrl), tournament?.name);
  });
}

// Manual links are stored with this confidence and never replaced
const MANUAL_LINK_CONFIDENCE = 999;
const REPLACE_MIN_SCORE = 700;
const REPLACE_MIN_GAP = 300;
const DAY_MS = 24 * 60 * 60 * 1000;

// A room whose label names both players of the match is a real game of it, even far in time
function labelNamesMatchPlayers(race, match) {
  const labelPlayers = parseRaceStageInfo(race).players;
  if (!labelPlayers) return false;
  const { player1, player2 } = getMatchPlayers(match);
  return [player1, player2].every((player) => labelPlayers.some((labelPlayer) => scoreNameMatch(labelPlayer.name, player) > 0));
}

function getRaceDistanceToMatch(race, match) {
  const raceAt = new Date(race?.endedAt || race?.startedAt || 0).getTime();
  const matchAt = getMatchTimestamp(match);
  if (!raceAt || !matchAt || Number.isNaN(raceAt)) return null;
  return Math.abs(raceAt - matchAt);
}
const ALIAS_MIN_CONFIDENCE = 500;

// Racetime accounts seen under another bracket name in confident links of the same games
async function loadPlayerAliases({ Race, races }) {
  const categories = [...new Set(races.map((race) => race.category).filter(Boolean))];
  if (!categories.length) return new Map();

  const linkedRaces = await Race.find({
    category: { $in: categories },
    matchPlayers: { $nin: [null, ''] },
    matchConfidence: { $gte: ALIAS_MIN_CONFIDENCE }
  }).select('entrants.userName matchPlayers').lean();
  const aliases = learnPlayerAliases(linkedRaces);

  // Aliases set on player profiles (SRL account "anatomyz" = bracket name "atz")
  const Player = Race.db.models.Player;
  if (!Player) return aliases;
  const players = await Player.find({ 'aliases.0': { $exists: true } }).select('name aliases').lean();
  for (const player of players) {
    const names = [...new Set([player.name, ...player.aliases].map(normalizeName).filter(Boolean))];
    for (const name of names) {
      if (!aliases.has(name)) aliases.set(name, new Set());
      for (const other of names) {
        if (other !== name) aliases.get(name).add(other);
      }
    }
  }
  return aliases;
}

async function buildAutoLinkPreview({
  tournament,
  Match,
  Race,
  threshold = 300,
  minGap = 50,
  extraRaceUrls = []
}) {
  const matches = await loadNormalizedMatches({ tournament, Match, Race });
  const races = await loadCandidateRaces({ tournament, Race, matches, extraRaceUrls });
  const raceByUrl = new Map(races.map((race) => [race.url, race]));
  const aliases = await loadPlayerAliases({ Race, races });
  const scoreOptions = {
    requireDirect: true,
    allowOccupiedMatchReassign: false,
    skipOccupiedPenalty: true,
    aliases
  };
  const liveMatches = matches.map((match) => {
    const raceUrls = Array.isArray(match.raceUrls) ? [...match.raceUrls] : [];
    return {
      ...match,
      raceUrls,
      maxGameNumber: getMaxGameNumber(raceUrls.map((url) => raceByUrl.get(url)).filter(Boolean))
    };
  });

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
    if (stageInfo.type === 'qualifier' || race.tournamentPhase === QUALIFIER_PHASE) {
      skipped++;
      continue;
    }

    // Series (BO3, BO5...) take one race per game played
    const gameNumber = getRaceGameNumber(race);
    const getStageMatches = (stageOptions) => {
      const phaseMatches = isTournamentStartgg(tournament)
        ? filterMatchesByRaceStage(race, liveMatches, tournament, stageOptions)
        : liveMatches;
      return ((phaseMatches && filterMatchesByBracketSide(race, phaseMatches)) || [])
        .filter((match) => !contradictsRecordedTimes(race, match));
    };
    const selectMatch = (matchesToRank) => (matchesToRank.length
      ? selectBestCandidate(rankMatchesForRace(race, matchesToRank, scoreOptions), { threshold, minGap, raceUrl: race.url })
      : null);
    const pickMatch = (stageOptions) => selectMatch(
      getStageMatches(stageOptions).filter((match) => hasAvailableStartggSlot(match, race.url, gameNumber))
    );

    // A full start.gg match may hold a weak automatic link (a practice room days away
    // from the set) that this race, played the same day, clearly beats: take its place
    const pickReplacement = (stageOptions) => {
      if (!isTournamentStartgg(tournament)) return null;
      const candidate = selectMatch(
        getStageMatches(stageOptions).filter((match) => !hasAvailableStartggSlot(match, race.url, gameNumber))
      );
      if (!candidate || candidate.score < REPLACE_MIN_SCORE) return null;
      const candidateDistance = getRaceDistanceToMatch(race, candidate.match);
      if (candidateDistance == null || candidateDistance > DAY_MS) return null;

      const weakest = candidate.match.raceUrls
        .map((url) => raceByUrl.get(url))
        .filter((linkedRace) => (
          linkedRace &&
          Number(linkedRace.matchConfidence) < MANUAL_LINK_CONFIDENCE &&
          !labelNamesMatchPlayers(linkedRace, candidate.match) &&
          getRaceDistanceToMatch(linkedRace, candidate.match) > 3 * DAY_MS
        ))
        .map((linkedRace) => ({
          url: linkedRace.url,
          score: rankMatchesForRace(linkedRace, [candidate.match], scoreOptions)[0]?.score || 0
        }))
        .sort((a, b) => a.score - b.score)[0];
      if (!weakest || candidate.score - weakest.score < REPLACE_MIN_GAP) return null;

      return { ...candidate, replacesRaceUrl: weakest.url };
    };

    // Organizers sometimes number Swiss rounds off by one ("Swiss Round 2" played in
    // start.gg round 3): fall back to the whole stage when the named round has no match
    const hasLabelRound = getRaceLabelStage(race)?.round != null;
    const chosen = pickMatch() ||
      (hasLabelRound ? pickMatch({ ignoreRound: true }) : null) ||
      pickReplacement() ||
      (hasLabelRound ? pickReplacement({ ignoreRound: true }) : null);

    if (!chosen) {
      skipped++;
      continue;
    }

    const players = getMatchPlayers(chosen.match);
    proposals.push({
      raceUrl: race.url,
      raceLabel: getRaceLabel(race),
      raceEntrants: (race.entrants || []).length,
      gameNumber,
      matchId: String(chosen.match.startggSetId || chosen.match._id),
      matchPlayers: `${players.player1} vs ${players.player2}`,
      matchPhase: chosen.match.phase || null,
      matchRound: chosen.match.round || null,
      score: chosen.score,
      fromLabel: chosen.extracted?.source === 'label',
      inferred: !!chosen.inferred,
      replacesRaceUrl: chosen.replacesRaceUrl || null,
      isStartgg: isTournamentStartgg(tournament)
    });

    const liveIndex = liveMatches.findIndex((match) => String(match.startggSetId || match._id) === String(chosen.match.startggSetId || chosen.match._id));
    if (liveIndex >= 0) {
      const liveMatch = liveMatches[liveIndex];
      if (chosen.replacesRaceUrl) {
        liveMatch.raceUrls = liveMatch.raceUrls.filter((url) => url !== chosen.replacesRaceUrl);
        if (liveMatch.raceUrl === chosen.replacesRaceUrl) liveMatch.raceUrl = liveMatch.raceUrls[0] || null;
      }
      if (!liveMatch.raceUrl) liveMatch.raceUrl = race.url;
      if (!liveMatch.raceUrls.includes(race.url)) liveMatch.raceUrls.push(race.url);
      liveMatch.maxGameNumber = Math.max(liveMatch.maxGameNumber || 0, gameNumber || 0);
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

        if (proposal.replacesRaceUrl) {
          const replaced = await Race.findOne({ url: proposal.replacesRaceUrl });
          if (!replaced || String(replaced.startggSetId || '') !== String(embeddedMatch.startggSetId) || !(Number(replaced.matchConfidence) < MANUAL_LINK_CONFIDENCE)) {
            errors.push(`Race ${proposal.replacesRaceUrl} can no longer be replaced on match ${proposal.matchId}`);
            continue;
          }

          embeddedMatch.raceUrls = (embeddedMatch.raceUrls || []).filter((url) => url !== replaced.url);
          if (embeddedMatch.raceUrl === replaced.url) embeddedMatch.raceUrl = embeddedMatch.raceUrls[0] || null;
          replaced.startggSetId = undefined;
          replaced.matchConfidence = undefined;
          replaced.matchPlayers = undefined;
          replaced.tournamentPhase = undefined;
          replaced.tournamentPool = undefined;
          replaced.tournamentRound = undefined;
          await replaced.save();
          tournamentDirty = true;
        }

        const linkedRaces = await Race.find({ url: { $in: embeddedMatch.raceUrls || [] } }).select('info').lean();
        if (!hasAvailableStartggSlot({
          raceUrl: embeddedMatch.raceUrl,
          raceUrls: embeddedMatch.raceUrls,
          displayScore: embeddedMatch.displayScore,
          maxGameNumber: getMaxGameNumber(linkedRaces)
        }, proposal.raceUrl, proposal.gameNumber)) {
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

        const linkedRaces = await Race.find({ tournamentId: tournament._id, matchId: matchDoc._id }).select('url info').lean();
        if (!hasAvailableStartggSlot({
          raceUrl: matchDoc.raceUrl,
          raceUrls: linkedRaces.map((linkedRace) => linkedRace.url),
          scoresCsv: matchDoc.scoresCsv,
          maxGameNumber: getMaxGameNumber(linkedRaces)
        }, proposal.raceUrl, proposal.gameNumber)) {
          errors.push(`Match ${proposal.matchId} is already full`);
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

        if (!matchDoc.raceUrl) {
          matchDoc.raceUrl = proposal.raceUrl;
          matchDoc.completedAt = matchDoc.completedAt || race.endedAt;
          await matchDoc.save();
        }
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
  if (linked) await syncParticipantAccounts({ tournament, Race });

  return { linked, total: proposals.length, errors };
}

module.exports = {
  QUALIFIER_PHASE,
  goalTokens,
  collectCandidateCategories,
  loadNormalizedMatches,
  loadCandidateRaces,
  buildAutoLinkPreview,
  applyAutoLinkProposals,
  getExpectedStartggRaceCount,
  hasAvailableStartggSlot,
  getRaceLabelBracketSide
};
