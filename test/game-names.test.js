const test = require('node:test');
const assert = require('node:assert/strict');
const { randomizerShortNames } = require('../services/game-names');

test('randomizerShortNames uses the initials of several words', () => {
  assert.deepEqual(randomizerShortNames('Lantern Valley', 'lanternvalley'), { shortName: 'LV Randomizer', tinyName: 'LVR' });
  assert.deepEqual(randomizerShortNames('Tower of Echoes', 'towerofechoes'), { shortName: 'ToE Randomizer', tinyName: 'ToER' });
  assert.deepEqual(randomizerShortNames("Boxes 'n' Bells", 'boxesnbells'), { shortName: 'BnB Randomizer', tinyName: 'BnBR' });
  assert.deepEqual(randomizerShortNames('Pokémon Glimmer', 'pokemonglimmer'), { shortName: 'PKMNG Randomizer', tinyName: 'PKMNGR' });
  assert.deepEqual(randomizerShortNames('Rocket Racers DS', 'rocketracersds'), { shortName: 'RRDS Randomizer', tinyName: 'RRDSR' });
  assert.deepEqual(randomizerShortNames('Rocket Quest 3: Moon Base (PC)', 'rq3mb'), { shortName: 'RQ3MB Randomizer', tinyName: 'RQ3MBR' });
});

test('randomizerShortNames keeps the id for a single word, numbered or not', () => {
  assert.deepEqual(randomizerShortNames('Lanterns', 'lanterns'), { shortName: 'LANTERNS Randomizer', tinyName: 'LANTERNS' });
  assert.deepEqual(randomizerShortNames('Lanterns 2', 'lanterns2'), { shortName: 'LANTERNS2 Randomizer', tinyName: 'LANTERNS2' });
});
