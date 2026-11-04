const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPlayerIdentity, loadOwnNames, findPlayerByName } = require('../helpers/player-identity');
const { aggregatePlayers } = require('../helpers/players-list');
const { participantOwner } = require('../helpers/compare-tournaments');

// Two racetime accounts of the same name, one player with SRL aliases, one shared alias
const DOCS = [
  { userId: 'acc-big', name: 'Pixel', discriminator: '1111' },
  { userId: 'acc-small', name: 'pixel', discriminator: '2222' },
  { userId: 'acc-old', name: 'Comet', aliases: ['CometSRL', 'Shared'] },
  { userId: 'acc-other', name: 'Nova', aliases: ['shared'] },
  { userId: 'acc-gone', name: 'Ghost', racetimeDeletedAt: new Date('2026-01-01') }
];

test('identity: an account is a player, whatever its name', () => {
  const id = buildPlayerIdentity(DOCS);
  assert.equal(id.keyOfEntrant({ userId: 'acc-big', userName: 'Pixel' }), 'u:acc-big');
  assert.equal(id.keyOfEntrant({ userId: 'acc-small', userName: 'Pixel' }), 'u:acc-small');
  // An account named like another player's alias stays itself
  assert.equal(id.keyOfEntrant({ userId: 'acc-new', userName: 'CometSRL' }), 'u:acc-new');
});

test('identity: an entrant without account goes to the only player of that alias or name', () => {
  const id = buildPlayerIdentity(DOCS);
  assert.equal(id.keyOfEntrant({ userName: 'cometsrl' }), 'u:acc-old');
  assert.equal(id.keyOfEntrant({ userName: 'COMET' }), 'u:acc-old');
  // Two accounts of that name: it cannot tell
  assert.equal(id.keyOfEntrant({ userName: 'Pixel' }), 'n:pixel');
  assert.equal(id.keyOfEntrant({ userName: 'Nobody' }), 'n:nobody');
  // An alias of two players belongs to neither
  assert.equal(id.keyOfEntrant({ userName: 'Shared' }), 'n:shared');
  assert.equal(id.keyOfEntrant({}), null);
});

test('identity: a bracket participant goes to its account, its alias, else the only player of its name', () => {
  const id = buildPlayerIdentity(DOCS);
  assert.equal(id.keyOfParticipant({ racetimeUserId: 'acc-small', name: 'Pixel' }), 'u:acc-small');
  assert.equal(id.keyOfParticipant({ name: 'Comet' }), 'u:acc-old');
  assert.equal(id.keyOfParticipant({ name: 'CometSRL' }), 'u:acc-old');
  // Two accounts of that name: a bracket name alone cannot tell
  assert.equal(id.keyOfParticipant({ name: 'PIXEL' }), 'n:pixel');
  assert.equal(id.keyOfParticipant({ name: 'Shared' }), 'n:shared');
  assert.equal(id.keyOfParticipant({ displayName: 'Nobody' }), 'n:nobody');
});

test('identity: the names that point to one player only', () => {
  const id = buildPlayerIdentity(DOCS);
  assert.deepEqual(id.namesOf(DOCS[0]), []);
  assert.deepEqual(id.namesOf(DOCS[2]), ['Comet', 'CometSRL']);
  assert.deepEqual(id.namesOf(DOCS[3]), ['Nova']);
});

// Minimal stand-ins for the mongoose models: find(filter) then select/populate/lean
function fakePlayerModel(docs) {
  const matches = (doc, filter) => Object.entries(filter).every(([field, cond]) => {
    if (field === '$or') return cond.some(sub => matches(doc, sub));
    const value = doc[field];
    const values = Array.isArray(value) ? value : [value];
    if (cond instanceof RegExp) return values.some(v => cond.test(v || ''));
    if (cond && cond.$in) return values.some(v => cond.$in.some(re => re.test(v || '')));
    if (cond && '$ne' in cond) return value !== cond.$ne;
    return value === cond;
  });
  return {
    find(filter) {
      const result = docs.filter(doc => matches(doc, filter));
      const query = { select: () => query, populate: () => query, lean: async () => result };
      return query;
    }
  };
}

const fakeRaceModel = counts => ({ countDocuments: async filter => counts[filter['entrants.userId']] || 0 });

test('loadOwnNames: reads the players sharing a name before keeping it', async () => {
  const Player = fakePlayerModel(DOCS);
  assert.deepEqual(await loadOwnNames(Player, DOCS[1]), []);
  assert.deepEqual(await loadOwnNames(Player, DOCS[2]), ['Comet', 'CometSRL']);
  // A player without account keeps all their names
  assert.deepEqual(await loadOwnNames(Player, { name: 'Solo', aliases: ['S'] }), ['Solo', 'S']);
});

test('findPlayerByName: the account written exactly so, else the one with the most races', async () => {
  const Player = fakePlayerModel([...DOCS, { userId: 'acc-a', name: 'Twin' }, { userId: 'acc-b', name: 'Twin' }]);
  const Race = fakeRaceModel({ 'acc-a': 3, 'acc-b': 40, 'acc-big': 1, 'acc-small': 9 });
  assert.equal((await findPlayerByName({ Player, Race, name: 'pixel' })).userId, 'acc-small');
  assert.equal((await findPlayerByName({ Player, Race, name: 'Pixel' })).userId, 'acc-big');
  assert.equal((await findPlayerByName({ Player, Race, name: 'PIXEL' })).userId, 'acc-small');
  assert.equal((await findPlayerByName({ Player, Race, name: 'twin' })).userId, 'acc-b');
  assert.equal((await findPlayerByName({ Player, Race, name: 'cometsrl' })).userId, 'acc-old');
  assert.equal(await findPlayerByName({ Player, Race, name: 'Nobody' }), null);
  // Regex characters in a name are literal
  assert.equal(await findPlayerByName({ Player, Race, name: 'Pix.l' }), null);
});

const raceRow = (userId, entrantName, category, count, lastRaceAt) => ({
  _id: { userId, entrantName, category }, count, lastRaceAt: lastRaceAt ? new Date(lastRaceAt) : null
});

test('players list: two accounts of the same name are two players', () => {
  const { players, total } = aggregatePlayers({
    playerDocs: DOCS,
    raceCounts: [
      raceRow('acc-big', 'Pixel', 'game-a', 40, '2026-05-01'),
      raceRow('acc-big', 'Pixel', 'game-a-ladder', 9, '2026-04-01'),
      raceRow('acc-small', 'Pixel', 'game-b', 1, '2025-05-04'),
      // SpeedRunsLive: to the only player of that alias or name, else to nobody
      raceRow(null, 'CometSRL', 'game-a', 5, '2014-01-01'),
      raceRow(null, 'comet', 'game-a', 4, '2015-01-01'),
      raceRow('acc-old', 'Comet', 'game-a', 2, '2026-02-01'),
      raceRow(null, 'Pixel', 'game-a', 7, '2013-01-01'),
      raceRow('acc-gone', 'Ghost', 'game-a', 3, '2026-03-01')
    ],
    tournamentParticipants: [
      { tournamentId: 't1', tournamentGameName: 'Game A', participantName: 'Pixel', racetimeUserId: 'acc-big', racetimeName: 'Pixel' },
      { tournamentId: 't2', tournamentGameName: 'Game A', participantName: 'Pixel' },
      { tournamentId: 't3', tournamentGameName: 'Game A', participantName: 'Comet' },
      { tournamentId: 't4', tournamentGameName: 'Game A', participantName: 'Ghost', racetimeUserId: 'acc-gone' }
    ],
    gameMaps: {
      displayBySlug: new Map([['game-a', 'Game A'], ['game-a-ladder', 'Game A'], ['game-b', 'Game B']]),
      canonicalIdBySlug: new Map([['game-a', 'a'], ['game-a-ladder', 'a'], ['game-b', 'b']])
    },
    labelFor: () => null,
    includeTournaments: false
  });

  const byKey = new Map(players.map(p => [p.userId || `name:${p.name}`, p]));
  assert.equal(total, 4);
  assert.deepEqual(byKey.get('acc-big').racesByGame, [{ gameId: 'a', gameSlug: 'game-a', gameName: 'Game A', count: 49 }]);
  assert.equal(byKey.get('acc-big').tournamentsCount, 1);
  assert.equal(byKey.get('acc-big').discriminator, '1111');
  assert.equal(byKey.get('acc-small').name, 'pixel');
  assert.deepEqual(byKey.get('acc-small').racesByGame.map(g => [g.gameName, g.count]), [['Game B', 1]]);
  assert.equal(byKey.get('acc-small').tournamentsCount, 0);
  assert.equal(byKey.get('acc-old').totalRaces, 11);
  assert.equal(byKey.get('acc-old').name, 'Comet');
  assert.equal(byKey.get('acc-old').tournamentsCount, 1);
  // The bracket name both accounts wear: a player known by name, with the races of that name
  assert.equal(byKey.get('name:Pixel').totalRaces, 7);
  assert.equal(byKey.get('name:Pixel').tournamentsCount, 1);
  assert.equal(byKey.has('acc-gone'), false);
});

test('compare: a participant linked to another account is not the player', () => {
  const players = [
    { key: 'player1', userId: 'acc-big', normalizedNames: new Set(['pixel']) },
    { key: 'player2', userId: null, normalizedNames: new Set(['solo']) }
  ];
  assert.equal(participantOwner({ racetimeUserId: 'acc-big', name: 'Other' }, players), 'player1');
  assert.equal(participantOwner({ racetimeUserId: 'acc-small', racetimeName: 'pixel', name: 'Pixel' }, players), null);
  assert.equal(participantOwner({ racetimeUserId: 'acc-solo', racetimeName: 'Solo' }, players), 'player2');
  assert.equal(participantOwner({ name: 'Pixel' }, players), 'player1');
});

test('names raced without account: only those some accountless entrant has', async () => {
  const { namesRacedWithoutAccount } = require('../helpers/player-identity');
  let calls = 0;
  const Race = { distinct: async () => { calls++; return ['CometSRL', 'Élan', null]; } };
  assert.deepEqual(await namesRacedWithoutAccount(Race, ['Comet', 'cometsrl', 'elan']), ['cometsrl', 'elan']);
  assert.deepEqual(await namesRacedWithoutAccount(Race, []), []);
  // Read once, then from the cache
  await namesRacedWithoutAccount(Race, ['Comet']);
  assert.equal(calls, 1);
});
