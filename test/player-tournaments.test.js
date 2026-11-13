const test = require('node:test');
const assert = require('node:assert/strict');
const { computeRankFromMatches, participantLabel } = require('../helpers/player-tournaments');

const player = (challongeId, extra = {}) => ({ challongeId, name: `P${challongeId}`, ...extra });
const groupMatch = (p1, p2, winnerId) => ({ groupId: 1, round: 1, player1Id: p1, player2Id: p2, winnerId });
const bracketMatch = (round, p1, p2, winnerId = null) => ({ groupId: null, round, player1Id: p1, player2Id: p2, winnerId });

const rankOf = (participants, matches) => (id) => computeRankFromMatches(
  participants,
  participants.find((part) => part.challongeId === id),
  matches
);

test('participant label: racetime name first, then display name, then bracket name', () => {
  assert.equal(participantLabel({ racetimeName: 'Aaa', displayName: 'Bbb', name: 'Ccc' }), 'Aaa');
  assert.equal(participantLabel({ displayName: 'Bbb', name: 'Ccc' }), 'Bbb');
  assert.equal(participantLabel({ name: 'Ccc' }), 'Ccc');
  assert.equal(participantLabel({}), null);
});

test('computed rank: players knocked out in groups tie behind those who reached the bracket', () => {
  const participants = [1, 2, 3, 4, 5].map((id) => player(id));
  const rank = rankOf(participants, [
    groupMatch(1, 3, 1), groupMatch(2, 4, 2), groupMatch(3, 5, 3),
    bracketMatch(1, 1, 2, 1)
  ]);
  assert.equal(rank(1), 1);
  assert.equal(rank(2), 2);
  assert.equal(rank(3), 3);
  assert.equal(rank(4), 3);
  assert.equal(rank(5), 3);
});

test('computed rank: in the bracket, the round reached, then wins, then group wins, then seed', () => {
  const participants = [player(1, { seed: 1 }), player(2, { seed: 2 }), player(3, { seed: 3 }), player(4, { seed: 4 })];
  const rank = rankOf(participants, [
    groupMatch(4, 9, 4),
    bracketMatch(1, 1, 2, 1), bracketMatch(1, 3, 4, 3),
    bracketMatch(2, 1, 3, 3)
  ]);
  assert.equal(rank(3), 1);
  assert.equal(rank(1), 2);
  // Both lost in the semi-finals: the group win puts 4 ahead of the better seed
  assert.equal(rank(4), 3);
  assert.equal(rank(2), 4);

  const bySeed = rankOf(participants, [bracketMatch(1, 1, 2, 1), bracketMatch(1, 3, 4, 3), bracketMatch(2, 1, 3, 3)]);
  assert.equal(bySeed(2), 3);
  assert.equal(bySeed(4), 4);
});

test('computed rank: ranks given by the bracket site stay ahead of the computed ones', () => {
  const participants = [player(1, { finalRank: 2 }), player(2, { finalRank: 1 }), player(3), player(4)];
  const rank = rankOf(participants, [bracketMatch(1, 3, 4, 3)]);
  assert.equal(rank(3), 3);
  assert.equal(rank(4), 4);
});

test('computed rank: matches naming players instead of ids are counted too', () => {
  const participants = [player(1), player(2, { displayName: 'Shown' }), player(3)];
  const rank = rankOf(participants, [
    { groupId: null, round: 1, player1Name: 'P1', player2Name: 'Shown', winnerId: null }
  ]);
  assert.equal(rank(1), 1);
  assert.equal(rank(3), 3);
});

test('computed rank: ids compare as text, whatever their type in the matches', () => {
  const participants = [player(1), player(2), player(3)];
  const rank = rankOf(participants, [bracketMatch(1, '1', '2', '2')]);
  assert.equal(rank(2), 1);
  assert.equal(rank(1), 2);
  assert.equal(rank(3), 3);
});

test('computed rank: none for a participant without a bracket id', () => {
  const participants = [player(1), { name: 'Guest' }];
  assert.equal(computeRankFromMatches(participants, participants[1], [bracketMatch(1, 1, 2, 1)]), null);
});

test('computed rank: without any match, the seeds give the order', () => {
  const participants = [player(1, { seed: 3 }), player(2, { seed: 1 }), player(3)];
  const rank = rankOf(participants, []);
  assert.equal(rank(2), 1);
  assert.equal(rank(1), 2);
  assert.equal(rank(3), 3);
});
