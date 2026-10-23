const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeName,
  parseVsText,
  parseVsAndGame,
  parseRaceStageInfo,
  parseStartggDisplayScore,
  extractRaceEntrants,
  learnPlayerAliases,
  scoreNameMatch,
  scoreRaceAgainstMatch,
  rankMatchesForRace,
  selectBestCandidate,
  isCompletedMatch
} = require('../helpers/race-match-linking');

test('normalizeName drops accents, case and punctuation', () => {
  assert.equal(normalizeName('  Éclair_Bleu!! '), 'eclair bleu');
  assert.equal(normalizeName(null), '');
});

test('parseVsText reads "A vs B" and "A - B"', () => {
  assert.deepEqual(parseVsText('Alpha vs Bravo').map((p) => p.name), ['alpha', 'bravo']);
  assert.deepEqual(parseVsText('Alpha - Bravo').map((p) => p.name), ['alpha', 'bravo']);
  assert.equal(parseVsText('Alpha vs alpha'), null);
  assert.equal(parseVsText('Weekly race'), null);
});

test('parseVsAndGame reads the game number', () => {
  const { players, gameNumber } = parseVsAndGame('Alpha vs Bravo, game 3');
  assert.deepEqual(players.map((p) => p.name), ['alpha', 'bravo']);
  assert.equal(gameNumber, 3);
  assert.equal(parseVsAndGame('Alpha vs Bravo').gameNumber, null);
});

test('parseRaceStageInfo reads qualifiers, groups and brackets', () => {
  assert.deepEqual(parseRaceStageInfo({ info: 'Qualifier 4' }), { type: 'qualifier', label: 'Qualifier 4', index: 4 });

  const group = parseRaceStageInfo({ info: 'Group 3 Winners: Alpha vs Bravo, game 2\nsecond line' });
  assert.equal(group.type, 'group-match');
  assert.equal(group.group, '3');
  assert.equal(group.stage, 'winner');
  assert.equal(group.gameNumber, 2);
  assert.deepEqual(group.players.map((p) => p.name), ['alpha', 'bravo']);

  assert.equal(parseRaceStageInfo({ info: 'Main Bracket Alpha vs Bravo' }).type, 'main-bracket-match');
  assert.equal(parseRaceStageInfo({ name: 'some-room-1234' }).type, 'unknown');
});

test('parseStartggDisplayScore', () => {
  assert.deepEqual(parseStartggDisplayScore('Alpha 2 - Bravo 1'), { score1: 2, score2: 1, gamesPlayed: 3, bestOf: 3 });
  assert.deepEqual(parseStartggDisplayScore('Alpha 3 - Bravo 0'), { score1: 3, score2: 0, gamesPlayed: 3, bestOf: 5 });
  assert.deepEqual(parseStartggDisplayScore('Alpha W - Bravo L'), { score1: 1, score2: 0, gamesPlayed: 1, bestOf: 1 });
  assert.equal(parseStartggDisplayScore('DQ'), null);
  assert.equal(parseStartggDisplayScore('Alpha - Bravo'), null);
  assert.equal(parseStartggDisplayScore(null), null);
});

test('extractRaceEntrants prefers matchPlayers, then the label, then the room', () => {
  const room = [{ userName: 'Charlie' }, { userName: 'Delta' }];

  const fromMatchPlayers = extractRaceEntrants({ matchPlayers: 'Alpha vs Bravo', entrants: room });
  assert.equal(fromMatchPlayers.source, 'matchPlayers');
  assert.deepEqual(fromMatchPlayers.entrants.map((e) => e.name), ['alpha', 'bravo']);

  const fromLabel = extractRaceEntrants({ info: 'Group 1 Openers: Alpha vs Bravo', entrants: room });
  assert.equal(fromLabel.source, 'group-label');

  const fromRoom = extractRaceEntrants({ entrants: room });
  assert.equal(fromRoom.source, 'entrants');
  assert.equal(fromRoom.direct, true);

  const qualifier = extractRaceEntrants({ info: 'Qualifier 1', entrants: [...room, { userName: 'Echo' }] });
  assert.equal(qualifier.source, 'qualifier-room');
  assert.equal(qualifier.direct, false);
  assert.deepEqual(qualifier.entrants, []);
});

test('scoreNameMatch ranks how surely two names are the same player', () => {
  assert.equal(scoreNameMatch('alpha', 'alpha'), 300);
  assert.equal(scoreNameMatch('alpha', ''), 0);
  assert.equal(scoreNameMatch('alpha ttv', 'alpha'), 200);
  assert.equal(scoreNameMatch('alphaz', 'alpha'), 220);
  assert.equal(scoreNameMatch('alphabetical', 'alpha'), 120);
  assert.equal(scoreNameMatch('4lph4', 'alpha'), 200);
  assert.equal(scoreNameMatch('bravissimo', 'bravisimo'), 140);
  assert.equal(scoreNameMatch('alpha', 'zulu'), 0);
});

test('learnPlayerAliases learns the account that played as the other player', () => {
  const aliases = learnPlayerAliases([
    { matchPlayers: 'Alpha vs Bravo', entrants: [{ userName: 'Alpha' }, { userName: 'Zulu' }] },
    { matchPlayers: 'Charlie vs Delta', entrants: [{ userName: 'Charlie' }, { userName: 'Yankee' }] },
    { matchPlayers: 'Echo vs Foxtrot', entrants: [{ userName: 'Echo' }, { userName: 'Yankee' }] }
  ]);
  assert.deepEqual([...aliases.get('zulu')], ['bravo']);
  // Seen under two bracket names: dropped
  assert.equal(aliases.has('yankee'), false);
});

test('isCompletedMatch understands start.gg and Challonge states', () => {
  assert.equal(isCompletedMatch({ state: 3 }), true);
  assert.equal(isCompletedMatch({ state: 'complete' }), true);
  assert.equal(isCompletedMatch({ state: 'open' }), false);
});

test('a race is linked to the match of its players, not to another one', () => {
  const race = {
    url: '/game/room-1',
    endedAt: '2026-03-01T20:00:00Z',
    entrants: [
      { userName: 'Alpha', finishedAt: '2026-03-01T19:50:00Z' },
      { userName: 'Bravo', finishedAt: '2026-03-01T20:00:00Z' }
    ]
  };
  const right = { id: 'right', player1Name: 'Alpha', player2Name: 'Bravo', state: 'complete', completedAt: '2026-03-01T20:05:00Z' };
  const other = { id: 'other', player1Name: 'Alpha', player2Name: 'Charlie', state: 'complete', completedAt: '2026-03-01T20:05:00Z' };
  const late = { id: 'late', player1Name: 'Bravo', player2Name: 'Alpha', state: 'complete', completedAt: '2026-03-20T20:00:00Z' };

  const ranked = rankMatchesForRace(race, [other, late, right]);
  assert.equal(ranked[0].match.id, 'right');
  assert.equal(ranked.some((entry) => entry.match.id === 'other'), false);
  assert.ok(ranked[0].score - ranked[1].score >= 60);
  assert.equal(selectBestCandidate(ranked, { raceUrl: race.url }).match.id, 'right');
});

test('the group stage of a label favours the match of that round', () => {
  const race = {
    url: '/game/room-2',
    info: 'Group 2 Losers: Alpha vs Bravo',
    entrants: [{ userName: 'Alpha' }, { userName: 'Bravo' }]
  };
  const base = { player1Name: 'Alpha', player2Name: 'Bravo', phaseGroup: '2' };
  const losers = scoreRaceAgainstMatch(race, { ...base, round: -1 });
  const winners = scoreRaceAgainstMatch(race, { ...base, round: 2 });
  assert.ok(losers.score - winners.score > 100);

  const openers = { ...race, info: 'Group 2 Openers: Alpha vs Bravo' };
  assert.ok(scoreRaceAgainstMatch(openers, { ...base, round: 1 }).score > scoreRaceAgainstMatch(openers, { ...base, round: 2 }).score);
});

test('a match already linked to another race is penalised', () => {
  const race = { url: '/game/room-3', entrants: [{ userName: 'Alpha' }, { userName: 'Bravo' }] };
  const match = { player1Name: 'Alpha', player2Name: 'Bravo' };
  const free = scoreRaceAgainstMatch(race, match).score;
  assert.equal(scoreRaceAgainstMatch(race, { ...match, raceUrl: race.url }).score, free);
  assert.equal(scoreRaceAgainstMatch(race, { ...match, raceUrl: '/game/other' }).score, free - 600);
  assert.equal(scoreRaceAgainstMatch(race, { ...match, raceUrl: '/game/other' }, { allowOccupiedMatchReassign: true }).score, free - 250);
});

test('co-op rooms are read as team against team', () => {
  const race = {
    url: '/game/room-4',
    entrants: [
      { userName: 'Alpha', finishedAt: '2026-03-01T20:00:00Z' },
      { userName: 'Bravo', finishedAt: '2026-03-01T20:10:00Z' },
      { userName: 'Charlie', finishedAt: '2026-03-01T20:05:00Z' },
      { userName: 'Delta', finishedAt: null }
    ]
  };
  const match = {
    player1Name: 'Team One', player1Members: ['Alpha', 'Bravo'],
    player2Name: 'Team Two', player2Members: ['Charlie', 'Delta']
  };
  const result = scoreRaceAgainstMatch(race, match);
  assert.equal(result.extracted.source, 'team-members');
  assert.ok(result.score > 0);
  const [team1, team2] = result.extracted.entrants;
  assert.equal(team1.finishedAt.toISOString(), '2026-03-01T20:10:00.000Z');
  assert.equal(team2.finishedAt, null);

  const strangers = { ...race, entrants: [{ userName: 'Echo' }, { userName: 'Foxtrot' }, { userName: 'Golf' }] };
  assert.equal(scoreRaceAgainstMatch(strangers, match).reason, 'team-members-missing');
});

test('selectBestCandidate refuses weak or ambiguous candidates', () => {
  assert.equal(selectBestCandidate([]), null);
  assert.equal(selectBestCandidate([{ score: 250, match: {} }]), null);
  assert.equal(selectBestCandidate([{ score: 500, match: {} }, { score: 480, match: {} }], { raceUrl: '/r' }), null);

  // Among close top candidates, a free match wins over one linked elsewhere
  const occupied = { score: 500, match: { raceUrl: '/elsewhere' } };
  const free = { score: 400, match: {} };
  assert.equal(selectBestCandidate([occupied, free], { raceUrl: '/r' }).match, occupied.match);
  assert.equal(selectBestCandidate([occupied, { score: 460, match: {} }], { raceUrl: '/r', minGap: 0 }).score, 460);
});
