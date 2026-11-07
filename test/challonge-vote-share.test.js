const test = require('node:test');
const assert = require('node:assert');
const { isVoteShareScore } = require('../services/challonge');

test('a score equal to the share of community votes is no score', () => {
  assert.strictEqual(isVoteShareScore({ scores_csv: '67-33', player1_votes: 4, player2_votes: 2, winner_id: 2 }), true);
  assert.strictEqual(isVoteShareScore({ scores_csv: '86-14', player1_votes: 6, player2_votes: 1, winner_id: 1 }), true);
  assert.strictEqual(isVoteShareScore({ scores_csv: '0-100', player1_votes: null, player2_votes: 3, winner_id: 2 }), true);
});

test('"0-0" beside a winner is no score, a draw without winner is one', () => {
  assert.strictEqual(isVoteShareScore({ scores_csv: '0-0', winner_id: 1 }), true);
  assert.strictEqual(isVoteShareScore({ scores_csv: '0-0', winner_id: null }), false);
});

test('series scores and race times are kept, votes or not', () => {
  assert.strictEqual(isVoteShareScore({ scores_csv: '2-1', player1_votes: 2, player2_votes: 1, winner_id: 1 }), false);
  assert.strictEqual(isVoteShareScore({ scores_csv: '1-0,0-1,1-0', player1_votes: 5, player2_votes: 0, winner_id: 1 }), false);
  assert.strictEqual(isVoteShareScore({ scores_csv: '0-15030', player1_votes: 1, player2_votes: 1, winner_id: 1 }), false);
  assert.strictEqual(isVoteShareScore({ scores_csv: '100-0', winner_id: 1 }), false);
});
