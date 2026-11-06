const test = require('node:test');
const assert = require('node:assert/strict');
const { matchRestream, titleEvent, titleRunTime } = require('../helpers/marathon-restreams');

const RUNS = [
  { id: 1, event: { short: 'XGDQ2030' }, name: 'Quest of Lumen', runTime: 5400 },
  { id: 2, event: { short: 'XGDQ2030' }, name: 'Star Hopper 2', runTime: 3000 },
  { id: 3, event: { short: 'XGDQ2030' }, name: 'Star Hopper 2', runTime: 7200 },
  { id: 4, event: { short: 'YGDQ2031' }, name: 'Quest of Lumen', runTime: 5000 }
];

test('event tag and run time of a restream title', () => {
  assert.equal(titleEvent('Quest of Lumen en 1:30:00 (Randomizer) [XGDQ2030]'), 'xgdq2030');
  assert.equal(titleEvent('Quest of Lumen (Randomizer)'), null);
  assert.equal(titleRunTime('Quest of Lumen en 1:30:12.4 (Randomizer) [XGDQ2030]'), 5412);
});

test('a restream goes to the run of its event and game', () => {
  assert.equal(matchRestream('Quest of Lumen en 1:31:00 (Randomizer Race) [XGDQ2030]', RUNS).id, 1);
  assert.equal(matchRestream('Quest of Lumen Randomizer en 1:20:00 (Co-op) [ygdq2031]', RUNS).id, 4);
  // Not a randomizer, another marathon, another game
  assert.equal(matchRestream('Quest of Lumen en 1:31:00 (Any%) [XGDQ2030]', RUNS), null);
  assert.equal(matchRestream('Quest of Lumen en 1:31:00 (Randomizer) [ZFM2030]', RUNS), null);
  assert.equal(matchRestream('Other Game en 1:31:00 (Randomizer) [XGDQ2030]', RUNS), null);
});

test('runs of the same game: the closest time, none without a time', () => {
  assert.equal(matchRestream('Star Hopper 2 en 0:51:00 (Randomizer) [XGDQ2030]', RUNS).id, 2);
  assert.equal(matchRestream('Star Hopper 2 en 1:58:00 (Randomizer) [XGDQ2030]', RUNS).id, 3);
  assert.equal(matchRestream('Star Hopper 2 (Randomizer) [XGDQ2030]', RUNS), null);
  assert.equal(matchRestream('Star Hopper 2 en 1:25:00 (Randomizer) [XGDQ2030]', RUNS), null);
});
