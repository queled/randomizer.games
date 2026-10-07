function normalizeName(value) {
  return (value || '')
    .toString()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[m][n];
}

function parseVsText(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const vsRe = /([^\n\r:|\t\-]{1,40})\s+(?:vs|v|vs\.|:)\s+([^\n\r]{1,40})/i;
  const dashRe = /([^\n\r:|\t]{1,40})\s+-\s+([^\n\r]{1,40})/i;
  const match = vsRe.exec(raw) || dashRe.exec(raw);
  if (!match) return null;

  const player1 = normalizeName(match[1]);
  const player2 = normalizeName(match[2]);
  if (!player1 || !player2 || player1 === player2) return null;

  return [
    { name: player1, finishedAt: null },
    { name: player2, finishedAt: null }
  ];
}

function getRaceLabel(race) {
  return String(race?.info || '').split('\n')[0].trim() || String(race?.name || '').trim() || String(race?.url || '').trim();
}

/**
 * Parse "A vs B, game 3" → { players, gameNumber }
 * Also handles "A vs B" without game number.
 */
function parseVsAndGame(text) {
  const raw = String(text || '').trim();
  const gameMatch = /,\s*game\s+(\d+)\s*$/i.exec(raw);
  const gameNumber = gameMatch ? Number(gameMatch[1]) : null;
  const cleanText = gameMatch ? raw.slice(0, gameMatch.index).trim() : raw;
  return {
    players: parseVsText(cleanText),
    gameNumber
  };
}

/**
 * Parse start.gg displayScore like "PlayerA 2 - PlayerB 1" or "PlayerA W - PlayerB L"
 * Returns { score1, score2, gamesPlayed, bestOf } or null.
 */
function parseStartggDisplayScore(displayScore) {
  if (!displayScore || typeof displayScore !== 'string') return null;
  const ds = displayScore.trim();
  if (ds === 'DQ') return null;

  const parts = ds.split(' - ');
  if (parts.length !== 2) return null;

  const p1Part = parts[0].trim();
  const p2Part = parts[1].trim();

  const p1ScoreMatch = p1Part.match(/\s+(\d+)$/);
  const p2ScoreMatch = p2Part.match(/\s+(\d+)$/);
  const p1W = p1Part.endsWith(' W');
  const p2W = p2Part.endsWith(' W');

  let score1 = null;
  let score2 = null;

  if (p1ScoreMatch && p2ScoreMatch) {
    score1 = parseInt(p1ScoreMatch[1], 10);
    score2 = parseInt(p2ScoreMatch[1], 10);
  } else if (p1W || p2W) {
    score1 = p1W ? 1 : 0;
    score2 = p2W ? 1 : 0;
  }

  if (score1 === null || score2 === null) return null;

  const gamesPlayed = score1 + score2;
  const maxWins = Math.max(score1, score2);
  let bestOf = null;
  if (maxWins === 1 && gamesPlayed === 1) bestOf = 1;
  else if (maxWins === 2) bestOf = 3;
  else if (maxWins === 3) bestOf = 5;

  return { score1, score2, gamesPlayed, bestOf };
}

function parseRaceStageInfo(race) {
  const label = getRaceLabel(race);
  const lower = label.toLowerCase();

  const qualifierMatch = /^qualifier\s+(\d+)$/i.exec(label);
  if (qualifierMatch) {
    return {
      type: 'qualifier',
      label,
      index: Number(qualifierMatch[1])
    };
  }

  const groupMatch = /^group\s+(\d+)\s+(openers|winners|losers|decider|finals?|tiebreakers?)\s*:\s*(.+)$/i.exec(label);
  if (groupMatch) {
    const vsAndGame = parseVsAndGame(groupMatch[3]);
    return {
      type: 'group-match',
      label,
      group: groupMatch[1],
      stage: groupMatch[2].toLowerCase().replace(/s$/, ''),
      players: vsAndGame.players,
      gameNumber: vsAndGame.gameNumber
    };
  }

  if (lower.startsWith('preliminary bracket')) {
    const vsAndGame = parseVsAndGame(label);
    return {
      type: 'preliminary-match',
      label,
      players: vsAndGame.players,
      gameNumber: vsAndGame.gameNumber
    };
  }

  if (lower.startsWith('main bracket')) {
    const vsAndGame = parseVsAndGame(label);
    return {
      type: 'main-bracket-match',
      label,
      players: vsAndGame.players,
      gameNumber: vsAndGame.gameNumber
    };
  }

  // Generic fallback: try to detect "game N" and "A vs B" in any label
  const vsAndGame = parseVsAndGame(label);
  return {
    type: 'unknown',
    label,
    players: vsAndGame.players,
    gameNumber: vsAndGame.gameNumber
  };
}

function extractRaceEntrants(race, options = {}) {
  const requireDirect = options.requireDirect !== false;
  const rawEntrants = Array.isArray(race?.entrants) ? race.entrants : [];
  const stageInfo = parseRaceStageInfo(race);

  let entrants = rawEntrants
    .map((e) => ({
      name: normalizeName(
        e?.userName ||
        e?.userId ||
        (e?.user && (e.user.name || e.user.id)) ||
        e?.name ||
        e?.displayName ||
        ''
      ),
      finishedAt: e?.finishedAt || e?.finished_at || null
    }))
    .filter((e) => e.name);

  const fromMatchPlayers = parseVsText(race?.matchPlayers || '');
  if (fromMatchPlayers) {
    return {
      entrants: fromMatchPlayers,
      source: 'matchPlayers',
      entrantCount: rawEntrants.length,
      direct: true
    };
  }

  if (stageInfo.type === 'group-match' && stageInfo.players) {
    return {
      entrants: stageInfo.players,
      source: 'group-label',
      entrantCount: rawEntrants.length,
      direct: true,
      stageInfo
    };
  }

  if (stageInfo.type === 'preliminary-match' && stageInfo.players) {
    return {
      entrants: stageInfo.players,
      source: 'stage-label',
      entrantCount: rawEntrants.length,
      direct: true,
      stageInfo
    };
  }

  if (stageInfo.type === 'main-bracket-match' && stageInfo.players) {
    return {
      entrants: stageInfo.players,
      source: 'stage-label',
      entrantCount: rawEntrants.length,
      direct: true,
      stageInfo
    };
  }

  if (entrants.length === 2) {
    return {
      entrants,
      source: 'entrants',
      entrantCount: rawEntrants.length,
      direct: stageInfo.type !== 'qualifier',
      stageInfo
    };
  }

  const parsed = parseVsText(`${race?.name || ''}\n${race?.info || ''}`);
  if (parsed) {
    return {
      entrants: parsed,
      source: 'name-info',
      entrantCount: rawEntrants.length,
      direct: stageInfo.type !== 'qualifier',
      stageInfo
    };
  }

  if (requireDirect) {
    return {
      entrants: [],
      source: stageInfo.type === 'qualifier' ? 'qualifier-room' : 'multi-entrant',
      entrantCount: rawEntrants.length,
      direct: false,
      stageInfo
    };
  }

  return {
    entrants,
    source: 'entrants',
    entrantCount: rawEntrants.length,
    direct: entrants.length === 2 && stageInfo.type !== 'qualifier',
    stageInfo
  };
}

function scoreNameMatch(entrantName, target) {
  if (!entrantName || !target) return 0;
  if (entrantName === target) return 300;

  const entrantTokens = entrantName.split(' ').filter(Boolean);
  const targetTokens = target.split(' ').filter(Boolean);

  if (entrantTokens.includes(target)) return 200;
  if (targetTokens.length && targetTokens.every((t) => entrantTokens.includes(t))) return 180;

  // "Flow" for Flowleyd: a nickname prefix, weaker than a near-identical token
  let nickname = false;
  for (const et of entrantTokens) {
    for (const tt of targetTokens) {
      if (et.startsWith(tt) || tt.startsWith(et)) {
        const diff = Math.abs(et.length - tt.length);
        if (diff <= 3) return 220;
        if (Math.min(et.length, tt.length) >= 4) nickname = true;
      }
    }
  }

  try {
    if ((new RegExp(`\\b${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)).test(entrantName)) {
      return 160;
    }
  } catch (error) {
    // ignore invalid regex constructions
  }

  if (nickname) return 120;

  const lev = levenshtein(entrantName, target);
  const maxLen = Math.max(entrantName.length, target.length) || 1;
  const similarity = 1 - (lev / maxLen);
  if (similarity > 0.85) return 140;
  if (similarity > 0.7) return 80;
  return 0;
}

// Racetime account → bracket names it played under, learned from linked races
function scorePlayerName(entrantName, target, aliases = null) {
  if (aliases?.get(entrantName)?.has(target)) return 300;
  return scoreNameMatch(entrantName, target);
}

/**
 * Learn racetime account aliases from confident links: when one entrant clearly is one
 * bracket player and the other entrant matches nobody ("Scarlet Blackflame" in a room
 * linked to "josh5146 vs iba allday"), the other entrant played as the other player.
 * Accounts seen under several bracket names are dropped.
 */
function learnPlayerAliases(linkedRaces) {
  const seen = new Map();

  for (const race of linkedRaces) {
    const players = String(race?.matchPlayers || '').split(/\s+vs\s+/i).map(normalizeName);
    const entrants = (race?.entrants || []).map((e) => normalizeName(e?.userName || e?.name || ''));
    if (players.length !== 2 || entrants.length !== 2 || players.some((p) => !p) || entrants.some((e) => !e)) continue;

    for (const [known, other] of [[0, 1], [1, 0]]) {
      for (const [player, otherPlayer] of [[0, 1], [1, 0]]) {
        const isClear = scoreNameMatch(entrants[known], players[player]) >= 200 &&
          scoreNameMatch(entrants[known], players[otherPlayer]) === 0 &&
          scoreNameMatch(entrants[other], players[player]) === 0 &&
          scoreNameMatch(entrants[other], players[otherPlayer]) === 0;
        if (!isClear) continue;
        if (!seen.has(entrants[other])) seen.set(entrants[other], new Set());
        seen.get(entrants[other]).add(players[otherPlayer]);
      }
    }
  }

  return new Map([...seen].filter(([, targets]) => targets.size === 1));
}

function getMatchPlayers(match) {
  return {
    player1: normalizeName(match?.player1Name || match?.player1?.name || ''),
    player2: normalizeName(match?.player2Name || match?.player2?.name || '')
  };
}

function getMatchMembers(match) {
  const members = (side) => (match?.[`${side}Members`] || match?.[side]?.members || []).map(normalizeName).filter(Boolean);
  return { player1: members('player1'), player2: members('player2') };
}

// How surely a racetime account is a team player: 2 same name, 1 one inside the other
// ("Painapple" = "ThePainapple"), 0 not them
function teamMemberMatch(entrantName, member) {
  const a = entrantName.replace(/ /g, '');
  const b = member.replace(/ /g, '');
  if (a === b) return 2;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 3 && longer.includes(shorter) ? 1 : 0;
}

/**
 * Co-op matches: the racetime room holds the players of both teams. When each team has
 * a player in the room, read the room as "team A vs team B" (finishing when its last
 * member finishes).
 */
function extractTeamEntrants(race, match) {
  const teams = getMatchMembers(match);
  if (!teams.player1.length || !teams.player2.length) return null;
  const { player1, player2 } = getMatchPlayers(match);
  const roomPlayers = (race?.entrants || []).map((e) => ({
    name: normalizeName(e?.userName || e?.name || ''),
    finishedAt: e?.finishedAt || null
  })).filter((e) => e.name);
  if (roomPlayers.length < 3) return null;

  // Each room player joins the team it matches best ("Alpha" over "ALPHAMARIOX")
  const best = (e, members) => Math.max(0, ...members.map((m) => teamMemberMatch(e.name, m)));
  const team1Players = [];
  const team2Players = [];
  for (const e of roomPlayers) {
    const s1 = best(e, teams.player1);
    const s2 = best(e, teams.player2);
    if (s1 > s2) team1Players.push(e);
    else if (s2 > s1) team2Players.push(e);
  }
  // The room holds these two teams (one renamed account at most), not a practice
  // room or a solo race where players of both teams happen to meet
  if (!team1Players.length || !team2Players.length) return null;
  if (team1Players.length + team2Players.length < roomPlayers.length - 1) return null;

  const side = (present, teamName) => {
    const finishes = present.map((e) => e.finishedAt && new Date(e.finishedAt).getTime()).filter(Boolean);
    return {
      name: teamName,
      finishedAt: finishes.length === present.length ? new Date(Math.max(...finishes)) : null
    };
  };
  return {
    entrants: [side(team1Players, player1), side(team2Players, player2)],
    source: 'team-members',
    entrantCount: roomPlayers.length,
    direct: true,
    stageInfo: parseRaceStageInfo(race)
  };
}

function getMatchCompletedAt(match) {
  return match?.completedAt || match?.startedAt || null;
}

function isCompletedMatch(match) {
  if (match?.state === 3) return true; // start.gg completed set
  const state = String(match?.state || '').toLowerCase();
  return ['complete', 'completed', 'done', 'closed'].includes(state);
}

function getRoundWeight(match) {
  return Math.abs(Number(match?.round || match?.tournamentRound || 0)) || 0;
}

function getMatchRaceUrl(match) {
  return match?.raceUrl || null;
}

function scoreRaceAgainstMatch(race, match, options = {}) {
  const teamEntrants = extractTeamEntrants(race, match);
  if (teamEntrants) {
    const fromTeams = scoreExtractedAgainstMatch(race, match, teamEntrants, options);
    if (fromTeams.score > 0) return fromTeams;
  } else if (getMatchMembers(match).player1.length && (race?.entrants || []).length > 2) {
    // A team room without both teams' players is another match, whatever its label says
    return {
      score: 0,
      extracted: { entrants: [], source: 'team-members', entrantCount: race.entrants.length, direct: false },
      best1: null,
      best2: null,
      reason: 'team-members-missing'
    };
  }

  const extracted = extractRaceEntrants(race, { requireDirect: options.requireDirect });
  const fromEntrants = scoreExtractedAgainstMatch(race, match, extracted, options);
  const labelPlayers = extracted.source === 'entrants' ? extracted.stageInfo?.players : null;
  if (!labelPlayers) return fromEntrants;

  // Racetime accounts often differ from bracket names (Slimba = MegaSlim): the room
  // label's "A vs B" names the bracket players, keep whichever reading matches best
  const fromLabel = scoreExtractedAgainstMatch(race, match, { ...extracted, entrants: labelPlayers, source: 'label' }, options);
  return fromLabel.score > fromEntrants.score ? fromLabel : fromEntrants;
}

function scoreExtractedAgainstMatch(race, match, extracted, options = {}) {
  if (!extracted.entrants.length) {
    return {
      score: 0,
      extracted,
      best1: null,
      best2: null,
      reason: extracted.source
    };
  }

  const { player1, player2 } = getMatchPlayers(match);
  if (!player1 || !player2) {
    return {
      score: 0,
      extracted,
      best1: null,
      best2: null,
      reason: 'missing-match-players'
    };
  }

  let best1 = { score: 0, entrant: null };
  let best2 = { score: 0, entrant: null };

  for (const entrant of extracted.entrants) {
    const s1 = scorePlayerName(entrant.name, player1, options.aliases);
    if (s1 > best1.score) best1 = { score: s1, entrant };

    const s2 = scorePlayerName(entrant.name, player2, options.aliases);
    if (s2 > best2.score) best2 = { score: s2, entrant };
  }

  if (best1.entrant && best2.entrant && best1.entrant === best2.entrant) {
    // Try both resolution directions and pick the best total

    // Option A: keep best1 for player1, find secondBest for player2
    let secondBest2 = { score: 0, entrant: null };
    for (const entrant of extracted.entrants) {
      if (entrant === best1.entrant) continue;
      const s = scorePlayerName(entrant.name, player2, options.aliases);
      if (s > secondBest2.score) secondBest2 = { score: s, entrant };
    }

    // Option B: keep best2 for player2, find secondBest for player1
    let secondBest1 = { score: 0, entrant: null };
    for (const entrant of extracted.entrants) {
      if (entrant === best2.entrant) continue;
      const s = scorePlayerName(entrant.name, player1, options.aliases);
      if (s > secondBest1.score) secondBest1 = { score: s, entrant };
    }

    const totalA = best1.score + secondBest2.score;
    const totalB = secondBest1.score + best2.score;

    if (totalA >= totalB && secondBest2.score > 0) {
      best2 = secondBest2;
    } else if (totalB > totalA && secondBest1.score > 0) {
      best1 = secondBest1;
    } else if (secondBest2.score > 0) {
      best2 = secondBest2;
    } else if (secondBest1.score > 0) {
      best1 = secondBest1;
    }
  }

  if (!best1.entrant || !best2.entrant || best1.entrant === best2.entrant) {
    return {
      score: 0,
      extracted,
      best1,
      best2,
      reason: 'no-distinct-pair'
    };
  }

  let total = best1.score + best2.score;

  if (extracted.direct) total += 80;
  if (extracted.source === 'matchPlayers') total += 120;
  if (extracted.source === 'group-label') total += 180;
  if (extracted.source === 'stage-label') total += 120;
  if (race?.matchPlayers) total += 40;
  if ((race?.entrants || []).length > 2 && !extracted.direct) total -= 250;

  if (extracted.stageInfo?.type === 'group-match') {
    if (String(match?.phase || '').toLowerCase() === 'preliminary bracket') total += 40;
    if (String(match?.phaseGroup || '') === String(extracted.stageInfo.group || '')) total += 220;
    else total -= 160;

    const stage = extracted.stageInfo.stage;
    const round = Number(match?.round || 0);
    if (stage === 'openers' && round === 1) total += 160;
    if (stage === 'winners' && round === 2) total += 160;
    if (stage === 'losers' && round < 0) total += 160;
    if (stage === 'decider' && round < 0) total += 140;
    if (stage === 'tiebreaker' && round < 0) total += 140;
  }

  if (extracted.stageInfo?.type === 'main-bracket-match') {
    if (String(match?.phase || '').toLowerCase() === 'main bracket') total += 120;
    else total -= 80;
  }

  if (extracted.stageInfo?.type === 'qualifier') {
    total -= 500;
  }

  // Check raceUrl AND raceUrls array for occupied match detection
  const matchRaceUrl = getMatchRaceUrl(match);
  const matchRaceUrls = Array.isArray(match?.raceUrls) ? match.raceUrls : [];
  const raceAlreadyLinked = matchRaceUrl === race?.url || matchRaceUrls.includes(race?.url);
  if (matchRaceUrl && race?.url && !raceAlreadyLinked) {
    if (options.skipOccupiedPenalty) {
      // In suggestion/BO mode: no penalty for occupied matches
    } else {
      total -= options.allowOccupiedMatchReassign ? 250 : 600;
    }
  }

  const matchFinished = getMatchCompletedAt(match);
  const raceFinished = race?.endedAt || best1.entrant.finishedAt || best2.entrant.finishedAt || race?.startedAt || null;

  try {
    if (matchFinished && raceFinished) {
      const matchMs = new Date(matchFinished).getTime();
      const raceMs = new Date(raceFinished).getTime();
      if (!Number.isNaN(matchMs) && !Number.isNaN(raceMs)) {
        const delta = Math.abs(matchMs - raceMs) / 1000;
        if (delta <= 10) total += 120;
        else if (delta <= 60) total += 80;
        else if (delta <= 600) total += 40;
        else if (delta <= 86400) total += 200;
        else if (delta > 86400 && delta <= 3 * 86400) total -= 120;
        else if (delta > 3 * 86400 && delta <= 7 * 86400) total -= 260;
        else if (delta > 7 * 86400) total -= 420;
      }
    }
  } catch (error) {
    // ignore time parsing issues
  }

  if (isCompletedMatch(match)) total += 60;
  if (match?.scoresCsv || match?.displayScore) total += 40;

  const roundWeight = getRoundWeight(match);
  if (roundWeight > 0) total += Math.min(80, roundWeight * 6);

  // Players recognised through an alias or a nickname rather than their own name
  const inferred = [[best1, player1], [best2, player2]].some(([best, player]) => (
    !!options.aliases?.get(best.entrant.name)?.has(player) || best.score < 140
  ));

  return {
    score: total,
    extracted,
    best1,
    best2,
    inferred,
    reason: 'ok'
  };
}

function rankMatchesForRace(race, matches, options = {}) {
  return matches
    .map((match) => {
      const details = scoreRaceAgainstMatch(race, match, options);
      return { match, ...details };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
}

function selectBestCandidate(scored, options = {}) {
  const threshold = options.threshold ?? 300;
  const minGap = options.minGap ?? 60;
  const raceUrl = options.raceUrl || null;

  if (!scored.length || scored[0].score < threshold) return null;

  const top = scored[0];
  const runnerUp = scored[1] || null;
  if (runnerUp && (top.score - runnerUp.score) < minGap) {
    const differentTop = getMatchRaceUrl(top.match);
    const differentRunner = getMatchRaceUrl(runnerUp.match);
    if (differentTop !== raceUrl || differentRunner !== raceUrl) {
      return null;
    }
  }

  const topCandidates = scored.filter((entry) => entry.score >= Math.max(threshold, top.score - 50));
  return topCandidates.find((entry) => {
    const linkedRaceUrl = getMatchRaceUrl(entry.match);
    return !linkedRaceUrl || linkedRaceUrl === raceUrl;
  }) || topCandidates[0];
}

module.exports = {
  normalizeName,
  parseVsText,
  parseVsAndGame,
  getRaceLabel,
  parseRaceStageInfo,
  parseStartggDisplayScore,
  extractRaceEntrants,
  learnPlayerAliases,
  scoreNameMatch,
  scoreRaceAgainstMatch,
  rankMatchesForRace,
  selectBestCandidate,
  getMatchPlayers,
  getMatchMembers,
  getMatchCompletedAt,
  getMatchRaceUrl,
  isCompletedMatch
};
