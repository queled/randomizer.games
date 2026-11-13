const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getTournamentWindow,
  getPhaseFamily,
  getRaceLabelStage,
  filterMatchesByRaceStage,
  filterMatchesByBracketSide,
  normalizeStartggMatches,
  normalizeChallongeMatches,
  parseChallongeRaceTimes,
  contradictsRecordedTimes,
  playedAfterMatch,
  playedBeforeTournament,
  getRaceGameNumber,
  goalsLookAlike,
  namesOtherEventSeries,
  namesOtherEvent,
  filterProposalsByGoal,
  tooFarFromMatch
} = require('../services/tournament-autolink');

// Rules that keep or drop a candidate match before the races are scored.
// Names, events and times below are made up.

const DAY_MS = 24 * 60 * 60 * 1000;
const START = Date.parse('2026-06-01T00:00:00Z');
const day = (days) => new Date(START + days * DAY_MS).toISOString();
const race = (info, extra = {}) => ({ info, ...extra });
const ids = (matches) => matches.map((match) => match.id);

test('search window: two weeks around the start, the end and every dated match', () => {
  assert.deepEqual(
    getTournamentWindow({ startDate: day(0), endDate: day(10) }, [{ completedAt: day(20) }, { startedAt: 'not a date' }]),
    { minDate: new Date(START - 14 * DAY_MS), maxDate: new Date(START + 34 * DAY_MS) }
  );
  assert.deepEqual(getTournamentWindow({}), { minDate: null, maxDate: null });
});

test('phase family: swiss, groups or bracket, by start.gg type or by name', () => {
  assert.equal(getPhaseFamily({ bracketType: 'SWISS', name: 'Stage 1' }), 'swiss');
  assert.equal(getPhaseFamily({ name: 'Swiss Stage' }), 'swiss');
  assert.equal(getPhaseFamily({ bracketType: 'ROUND_ROBIN', name: 'Stage 1' }), 'groups');
  assert.equal(getPhaseFamily({ name: 'Poules' }), 'groups');
  assert.equal(getPhaseFamily({ name: 'Stage 1', groupCount: 4 }), 'groups');
  assert.equal(getPhaseFamily({ bracketType: 'DOUBLE_ELIMINATION', name: 'Top 8' }), 'bracket');
  assert.equal(getPhaseFamily({}), 'bracket');
});

test('stage named by a race label: read before the colon only', () => {
  assert.deepEqual(getRaceLabelStage(race('Swiss Round 5: Alpha vs Bravo')), { family: 'swiss', round: 5 });
  assert.deepEqual(getRaceLabelStage(race('Swiss: Alpha vs Bravo')), { family: 'swiss', round: null });
  assert.deepEqual(getRaceLabelStage(race('Group E: Alpha vs Bravo')), { family: 'groups' });
  assert.deepEqual(getRaceLabelStage(race('Top 8 Final: Alpha vs Bravo')), { family: 'bracket' });
  assert.equal(getRaceLabelStage(race('Alpha vs Bravo: swiss settings')), null);
  assert.equal(getRaceLabelStage(race('Alpha vs Bravo')), null);
});

const PHASED = {
  phases: [{ name: 'Swiss', bracketType: 'SWISS' }, { name: 'Top 8', bracketType: 'DOUBLE_ELIMINATION' }]
};
const PHASE_MATCHES = [
  { id: 'swiss-1', phase: 'Swiss', round: 1 },
  { id: 'swiss-2', phase: 'Swiss', round: 2 },
  { id: 'top-1', phase: 'Top 8', round: 1 }
];

test('stage filter: only the matches of the phase and the round the label names', () => {
  assert.deepEqual(ids(filterMatchesByRaceStage(race('Swiss Round 2: Alpha vs Bravo'), PHASE_MATCHES, PHASED)), ['swiss-2']);
  assert.deepEqual(ids(filterMatchesByRaceStage(race('Swiss Round 2: Alpha vs Bravo'), PHASE_MATCHES, PHASED, { ignoreRound: true })), ['swiss-1', 'swiss-2']);
  assert.deepEqual(ids(filterMatchesByRaceStage(race('Top 8 Semifinal: Alpha vs Bravo'), PHASE_MATCHES, PHASED)), ['top-1']);
});

test('stage filter: a stage the tournament does not have means another event', () => {
  assert.equal(filterMatchesByRaceStage(race('Group A: Alpha vs Bravo'), PHASE_MATCHES, PHASED), null);
});

test('stage filter: no stage in the label, or no phase known, keeps every match', () => {
  assert.equal(filterMatchesByRaceStage(race('Alpha vs Bravo'), PHASE_MATCHES, PHASED), PHASE_MATCHES);
  assert.equal(filterMatchesByRaceStage(race('Swiss Round 2: Alpha vs Bravo'), PHASE_MATCHES, {}), PHASE_MATCHES);
});

// Double elimination: losers rounds are negative on Challonge and start.gg
const DOUBLE_ELIM = [
  { id: 'winners-final', phase: 'Top 8', round: 3, completedAt: day(0) },
  { id: 'losers-semi', phase: 'Top 8', round: -3, completedAt: day(1) },
  { id: 'losers-final', phase: 'Top 8', round: -4, completedAt: day(2) },
  { id: 'grand-final', phase: 'Top 8', round: 4, completedAt: day(3) }
];

test('bracket side: a losers label only meets losers matches, a winners label winners ones', () => {
  assert.deepEqual(ids(filterMatchesByBracketSide(race('Losers Final: Alpha vs Bravo'), DOUBLE_ELIM)), ['losers-semi', 'losers-final']);
  assert.deepEqual(ids(filterMatchesByBracketSide(race('Winners Final: Alpha vs Bravo'), DOUBLE_ELIM)), ['winners-final', 'grand-final']);
  assert.equal(filterMatchesByBracketSide(race('Alpha vs Bravo'), DOUBLE_ELIM), DOUBLE_ELIM);
});

test('bracket side: a single elimination bracket ignores the side named', () => {
  const single = DOUBLE_ELIM.filter((match) => match.round > 0);
  assert.equal(filterMatchesByBracketSide(race('Lower Bracket Round 2: Alpha vs Bravo'), single), single);
});

test('grand final: only winners side matches completed after the losers final', () => {
  assert.deepEqual(ids(filterMatchesByBracketSide(race('Grand Final: Alpha vs Bravo'), DOUBLE_ELIM)), ['grand-final']);
  assert.deepEqual(ids(filterMatchesByBracketSide(race('Grand Finals Reset: Alpha vs Bravo'), DOUBLE_ELIM)), ['grand-final']);
});

test('grand final: each phase has its own losers final', () => {
  const twoPhases = [
    ...DOUBLE_ELIM,
    { id: 'other-winners', phase: 'Other', round: 2, completedAt: day(1) },
    { id: 'other-losers-final', phase: 'Other', round: -2, completedAt: day(0) }
  ];
  assert.deepEqual(ids(filterMatchesByBracketSide(race('Grand Final: Alpha vs Bravo'), twoPhases)), ['grand-final', 'other-winners']);
  // Without a losers bracket, every match stays a candidate
  const single = DOUBLE_ELIM.filter((match) => match.round > 0);
  assert.equal(filterMatchesByBracketSide(race('Grand Final: Alpha vs Bravo'), single), single);
});

test('start.gg matches: both players known, the set under way or done', () => {
  const set = (startggSetId, state, p2 = 'Bravo') => ({ startggSetId, state, player1: { name: 'Alpha' }, player2: { name: p2 } });
  const matches = normalizeStartggMatches({
    matches: [set('1', 1), set('2', 2), set('3', 3), set('4', undefined), set('5', 3, 'TBD'), set('6', 3, '')]
  });
  assert.deepEqual(matches.map((match) => match.startggSetId), ['2', '3', '4']);
  assert.deepEqual(normalizeStartggMatches({ matches: [{ ...set('7', 3), raceUrl: 'race-a' }] })[0].raceUrls, ['race-a']);
  assert.deepEqual(normalizeStartggMatches({}), []);
});

test('Challonge matches: both players known, under way or done, an open one once started', () => {
  const match = (_id, state, extra = {}) => ({ _id, state, player1Name: 'Alpha', player2Name: 'Bravo', ...extra });
  const matches = normalizeChallongeMatches([
    match('1', 'pending'), match('2', 'open'), match('3', 'open', { startedAt: day(0) }),
    match('4', 'complete'), match('5', 'underway'), match('6', ''), match('7', 'complete', { player2Name: 'TBD' })
  ], new Map([['4', ['race-a', 'race-b']]]));
  assert.deepEqual(matches.map((m) => m._id), ['3', '4', '5', '6']);
  assert.deepEqual(matches.find((m) => m._id === '4').raceUrls, ['race-a', 'race-b']);
  assert.deepEqual(normalizeChallongeMatches([match('8', 'complete', { raceUrl: 'race-c' })])[0].raceUrls, ['race-c']);
});

test('Challonge race times: h:mm:ss digits as the score, a forfeit as 0', () => {
  assert.deepEqual(parseChallongeRaceTimes('31532-31110'), [3 * 3600 + 15 * 60 + 32, 3 * 3600 + 11 * 60 + 10]);
  assert.deepEqual(parseChallongeRaceTimes('14205-0'), [3600 + 42 * 60 + 5]);
  assert.equal(parseChallongeRaceTimes('2-1'), null);
  assert.equal(parseChallongeRaceTimes('17000-1'), null);
  assert.equal(parseChallongeRaceTimes('1-0,0-1'), null);
  assert.equal(parseChallongeRaceTimes(null), null);
});

test('recorded times: a race finishing at none of them is another race of the same players', () => {
  const match = { scoresCsv: '31532-31110' };
  const finishing = (...seconds) => ({ entrants: seconds.map((value) => ({ finishTimeMs: value * 1000 })) });
  assert.equal(contradictsRecordedTimes(finishing(11732, 11470), match), false);
  // Organizers note the time a few seconds off
  assert.equal(contradictsRecordedTimes(finishing(11736), match), false);
  assert.equal(contradictsRecordedTimes(finishing(11800, 12000), match), true);
  assert.equal(contradictsRecordedTimes({ entrants: [{ finishTimeMs: null }] }, match), false);
  assert.equal(contradictsRecordedTimes(finishing(5000), { scoresCsv: '2-1' }), false);
});

test('dates: a room days after the reported result, or before the event, is not a game of it', () => {
  assert.equal(playedAfterMatch({ startedAt: day(4) }, { completedAt: day(0) }), true);
  assert.equal(playedAfterMatch({ startedAt: day(2) }, { completedAt: day(0) }), false);
  assert.equal(playedAfterMatch({ startedAt: day(4) }, {}), false);

  assert.equal(playedBeforeTournament({ startedAt: day(-2) }, { startDate: day(0) }), true);
  assert.equal(playedBeforeTournament({ startedAt: day(-0.5) }, { startDate: day(0) }), false);
  assert.equal(playedBeforeTournament({ startedAt: day(-2) }, {}), false);
});

test('far from the match: weeks away, only a label naming both players keeps the room', () => {
  const match = { player1Name: 'Alpha', player2Name: 'Bravo', completedAt: day(0) };
  assert.equal(tooFarFromMatch(race('Weekly fun race', { startedAt: day(20) }), match), true);
  assert.equal(tooFarFromMatch(race('Main Bracket: Alpha vs Charlie', { startedAt: day(20) }), match), true);
  assert.equal(tooFarFromMatch(race('Main Bracket: Alpha vs Bravo', { startedAt: day(20) }), match), false);
  assert.equal(tooFarFromMatch(race('Weekly fun race', { startedAt: day(6) }), match), false);
  assert.equal(tooFarFromMatch(race('Weekly fun race'), match), false);
});

test('far from the match: a racetime account known for a bracket name counts as that player', () => {
  const match = { player1Name: 'Alpha', player2Name: 'Bravo', completedAt: day(0) };
  const accounts = new Map([['alt1', new Set(['alpha'])]]);
  assert.equal(tooFarFromMatch(race('Main Bracket: alt1 vs Bravo', { startedAt: day(20) }), match, accounts), false);
  assert.equal(tooFarFromMatch(race('Main Bracket: alt1 vs Bravo', { startedAt: day(20) }), match), true);
});

test('game number: read from the first line of the label', () => {
  assert.equal(getRaceGameNumber(race('Alpha vs Bravo, Game 3')), 3);
  assert.equal(getRaceGameNumber(race('(G2) Alpha vs Bravo')), 2);
  assert.equal(getRaceGameNumber(race('Gamer vs G2A')), null);
  assert.equal(getRaceGameNumber(race('Alpha vs Bravo\nGame 2')), null);
});

test('goals alike: one inside the other, or a shared word that names the event', () => {
  assert.equal(goalsLookAlike('Fancy Cup S3', 'fancy cup season 3'), true);
  assert.equal(goalsLookAlike('Fancy', 'Fancy Cup'), true);
  assert.equal(goalsLookAlike('Other League', 'Fancy Cup'), false);
  assert.equal(goalsLookAlike('Standard Ruleset', 'Fancy Tournament Standard'), false);
  assert.equal(goalsLookAlike('', ''), false);
});

test('other event series: a league, ladder or weekly the tournament is not', () => {
  assert.equal(namesOtherEventSeries('League S6 Division 2: Alpha vs Bravo', 'Fancy Cup'), true);
  assert.equal(namesOtherEventSeries('Weekly Race', 'Fancy Cup'), true);
  assert.equal(namesOtherEventSeries('League S6: Alpha vs Bravo', 'Fancy League Season 6'), false);
  assert.equal(namesOtherEventSeries('Top 8: Alpha vs Bravo', 'Fancy Cup'), false);
});

test('other event: words before the players naming nothing of this tournament', () => {
  const players = 'Alpha vs Bravo';
  assert.equal(namesOtherEvent('XY7 - Alpha vs Bravo', players, 'Fancy Cup'), true);
  assert.equal(namesOtherEvent('Fancy Cup Top 8 - Alpha vs Bravo', players, 'Fancy Cup'), false);
  assert.equal(namesOtherEvent('Winners Round 2 - Alpha vs Bravo', players, 'Fancy Cup'), false);
  // A shortened player name is the player, not an event
  assert.equal(namesOtherEvent('Alph vs Bravo', players, 'Fancy Cup'), false);
  assert.equal(namesOtherEvent('XY7 Alpha', players, 'Fancy Cup'), false);
});

test('proposals by goal: a goal shared by most proposals is this event, a stray one is not', () => {
  const races = [
    ...Array.from({ length: 6 }, (_, index) => race('Alpha vs Bravo', { url: `same-${index}`, goal: 'Some Ruleset' })),
    race('Alpha vs Bravo', { url: 'stray', goal: 'Unrelated Thing' }),
    race('Alpha vs Bravo', { url: 'no-goal' }),
    race('League S6 Division 2: Alpha vs Bravo', { url: 'league' })
  ];
  const proposalsOf = (list) => list.map((item) => ({ raceUrl: item.url, raceLabel: item.info }));
  const kept = (list) => filterProposalsByGoal({ name: 'Fancy Cup' }, proposalsOf(list), races).map((p) => p.raceUrl);

  assert.deepEqual(kept(races), ['same-0', 'same-1', 'same-2', 'same-3', 'same-4', 'same-5', 'no-goal']);
  // Two rooms are too few to make their goal the event's
  assert.deepEqual(kept(races.slice(0, 2).concat(races.slice(6))), ['no-goal']);
});

test('proposals by goal: players read from the label or through an alias need this event named', () => {
  const races = [race('XY7 - Alpha vs Bravo', { url: 'other' }), race('Fancy Cup - Alpha vs Bravo', { url: 'ours' })];
  const proposal = (url, extra) => ({ raceUrl: url, raceLabel: races.find((r) => r.url === url).info, matchPlayers: 'alpha vs bravo', ...extra });
  const kept = (proposals) => filterProposalsByGoal({ name: 'Fancy Cup' }, proposals, races).map((p) => p.raceUrl);

  assert.deepEqual(kept([proposal('other', { fromLabel: true }), proposal('ours', { fromLabel: true })]), ['ours']);
  assert.deepEqual(kept([proposal('other', { inferred: true }), proposal('ours', { inferred: true })]), ['ours']);
  assert.deepEqual(kept([proposal('other')]), ['other']);
});
