const test = require('node:test');
const assert = require('node:assert');
const {
  isMultiworldCategory,
  gamesOfGoal,
  roomLinks,
  buildWorldIndex,
  gamesOfWorlds,
  fetchRoom,
  resolveRaceGames,
  multiworldRaceName
} = require('../helpers/multiworld-races');
const { buildGameRacesQuery } = require('../helpers/game-matching');

const GAMES = [
  { id: 'alpha', integrations: { archipelago: { gameName: 'Alpha Quest' }, apworld: { gameNames: ['Alpha Quest', 'Alpha Quest Deluxe'] } } },
  { id: 'beta', integrations: { multiworld: { gameName: 'Beta World' } } },
  // Two games with the same world name: neither can be picked
  { id: 'gamma', integrations: { apworld: { gameNames: ['Shared Name'] } } },
  { id: 'delta', integrations: { apworld: { gameNames: ['Shared Name'] } } }
];

test('only the multi-game categories are multiworld', () => {
  assert.strictEqual(isMultiworldCategory('archipelago'), true);
  assert.strictEqual(isMultiworldCategory('Archipelago '), true);
  assert.strictEqual(isMultiworldCategory('alttpr'), false);
});

test('a racetime goal names its games, whatever its case and trailing spaces', () => {
  assert.deepStrictEqual(gamesOfGoal('archipelago', 'Kill Ganon (A Link to the Past)\r'), ['alttp']);
  assert.deepStrictEqual(gamesOfGoal('archipelago', 'Tournament (Timespinner X Final Fantasy 1)'), ['timespinner', 'ff']);
  assert.deepStrictEqual(gamesOfGoal('archipelago', 'Clear all Goals'), []);
  assert.deepStrictEqual(gamesOfGoal('alttpr', 'Kill Ganon (A Link to the Past)'), []);
});

test('room links are read from the info, once each, and nothing else is', () => {
  const info = 'Seed: https://archipelago.gg/room/AbCdEfGh123_-x and again https://archipelago.gg/room/AbCdEfGh123_-x\n'
    + 'https://archipelago.gg/new_room/ZyXwVuTs987 · tracker https://archipelago.gg/tracker/QwErTyUi456 · A Link to the Past';
  assert.deepStrictEqual(roomLinks(info), [
    { kind: 'room', id: 'AbCdEfGh123_-x' },
    { kind: 'new_room', id: 'ZyXwVuTs987' }
  ]);
  assert.deepStrictEqual(roomLinks(''), []);
  assert.deepStrictEqual(roomLinks(null), []);
});

test('a world name leads to a game only when one game has it', () => {
  const index = buildWorldIndex(GAMES);
  assert.deepStrictEqual(gamesOfWorlds(['Alpha Quest', 'alpha quest deluxe', 'Beta World'], index), ['alpha', 'alpha', 'beta']);
  assert.deepStrictEqual(gamesOfWorlds(['Shared Name', 'Unknown Game', 'Archipelago'], index), []);
});

test('a new_room link leads to the room it opened', async () => {
  const calls = [];
  const http = {
    async get(url) {
      calls.push(url);
      if (url.includes('/new_room/')) return { status: 302, headers: { location: 'https://archipelago.gg/room/RealRoom123' } };
      return { status: 200, data: { players: [['P1', 'Alpha Quest'], ['P2', 'Alpha Quest'], ['P3', 'Beta World']] } };
    }
  };
  const room = await fetchRoom({ kind: 'new_room', id: 'Seed12345' }, http);
  assert.deepStrictEqual(room, { id: 'Seed12345', games: ['Alpha Quest', 'Beta World'], missing: false });
  assert.ok(calls[1].endsWith('/api/room_status/RealRoom123'));
});

test('a room gone from the site is flagged missing', async () => {
  const http = { async get() { return { status: 404, data: 'Not found' }; } };
  assert.deepStrictEqual(await fetchRoom({ kind: 'room', id: 'GoneRoom123' }, http), { id: 'GoneRoom123', games: [], missing: true });
});

test('a race gets the games of its goal and of its rooms, rooms fetched once', async () => {
  const worldIndex = buildWorldIndex([...GAMES, { id: 'alttp' }]);
  const knownGameIds = new Set(['alpha', 'beta', 'gamma', 'delta', 'alttp']);
  let fetches = 0;
  const fetchRoomFn = async ({ id }) => { fetches++; return { id, games: ['Beta World', 'Shared Name'], missing: false }; };

  const race = { category: 'archipelago', goal: 'Kill Ganon (A Link to the Past)', info: 'https://archipelago.gg/room/RoomOne1234' };
  const first = await resolveRaceGames(race, { worldIndex, knownGameIds, fetchRoomFn });
  assert.deepStrictEqual(first.games.sort(), ['alttp', 'beta']);
  assert.strictEqual(fetches, 1);

  // The fetched room is kept on the race: not fetched again
  const again = await resolveRaceGames({ ...race, archipelagoRooms: first.rooms }, { worldIndex, knownGameIds, fetchRoomFn });
  assert.deepStrictEqual(again.games.sort(), ['alttp', 'beta']);
  assert.strictEqual(fetches, 1);
});

test('a race with no clue is tied to no game, and a game missing from the site is left out', async () => {
  const worldIndex = buildWorldIndex(GAMES);
  const none = await resolveRaceGames({ category: 'archipelago', goal: 'Clear all Goals', info: 'Factorio + 2 LTTP Race' }, { worldIndex, knownGameIds: new Set(['alpha']) });
  assert.deepStrictEqual(none.games, []);
  // alttp is not a game of this (test) site
  const unknown = await resolveRaceGames({ category: 'archipelago', goal: 'Kill Ganon (A Link to the Past)', info: '' }, { worldIndex, knownGameIds: new Set(['alpha']) });
  assert.deepStrictEqual(unknown.games, []);
});

test('a room that cannot be fetched is tried again later', async () => {
  const worldIndex = buildWorldIndex(GAMES);
  const fetchRoomFn = async () => { throw new Error('timeout'); };
  const result = await resolveRaceGames({ category: 'archipelago', goal: '', info: 'https://archipelago.gg/room/RoomOne1234' }, { worldIndex, knownGameIds: null, fetchRoomFn });
  assert.deepStrictEqual(result, { games: [], rooms: [] });
});

test('a multiworld race is named after its games, else its category', () => {
  assert.strictEqual(multiworldRaceName(['Alpha', 'Beta'], 'archipelago'), 'Alpha + Beta (Multiworld)');
  assert.strictEqual(multiworldRaceName([null], 'archipelago'), 'Archipelago (Multiworld)');
});

test('the races of a game include the multiworld races played with it', () => {
  const query = buildGameRacesQuery({ id: 'alttp', integrations: { racetime: { gameSlug: 'alttpr' } } }, 'alttp');
  assert.deepStrictEqual(query.$or[1], { games: 'alttp' });
  assert.ok(query.$or[0].category.$in.includes('alttpr'));
});
