/**
 * Races of multi-game racetime.gg categories (racetime.gg/archipelago)
 *
 * Such a category is no game of the site: each race is tied to the games it was
 * played with, found without guessing from free text:
 *   1. the race goal, when it names its games (racetime goals of the category);
 *   2. the Archipelago rooms linked in the race info, whose slots list their games
 *      by world name, tied to a game by that exact name (only when one game has it);
 *   3. by hand in the admin (gamesSource 'manual'), never overwritten.
 * A race with no such clue stays tied to no game.
 *
 * These races are played in teams: they show on their games' pages and in the
 * players' race history, flagged multiworld, but stay out of the stats.
 */

const axios = require('axios');

const MULTIWORLD_CATEGORIES = ['archipelago'];

const CATEGORY_LABELS = { archipelago: 'Archipelago' };

// Racetime goals of a multi-game category → ids of the games they are played with
const GOAL_GAMES = {
  archipelago: {
    'kill ganon (a link to the past)': ['alttp'],
    'kill ender dragon (minecraft)': ['minecraft'],
    'launch rocket (factorio)': ['factorio'],
    'tournament (timespinner x final fantasy 1)': ['timespinner', 'ff']
  }
};

// World names of an Archipelago room that are no game
const IGNORED_WORLDS = new Set(['archipelago']);

const ROOM_RE = /https?:\/\/(?:www\.)?archipelago\.gg\/(new_room|room)\/([A-Za-z0-9_-]{8,})/g;
const ROOM_API = 'https://archipelago.gg';
const HTTP_HEADERS = { 'User-Agent': 'RandomizerWebsite/1.0' };

function isMultiworldCategory(category) {
  return MULTIWORLD_CATEGORIES.includes(String(category || '').toLowerCase().trim());
}

function categoryLabel(category) {
  return CATEGORY_LABELS[String(category || '').toLowerCase().trim()] || null;
}

// Name of a multiworld race: its games' labels, else its category's, flagged multiworld
function multiworldRaceName(labels, category) {
  const names = (labels || []).filter(Boolean);
  return `${names.length ? names.join(' + ') : (categoryLabel(category) || category)} (Multiworld)`;
}

const goalKey = goal => String(goal || '').replace(/\s+/g, ' ').trim().toLowerCase();

function gamesOfGoal(category, goal) {
  const table = GOAL_GAMES[String(category || '').toLowerCase().trim()] || {};
  return table[goalKey(goal)] || [];
}

// Archipelago room links of a race info: [{ kind, id }], kind 'room' or 'new_room'
function roomLinks(info) {
  const links = [];
  const seen = new Set();
  for (const [, kind, id] of String(info || '').matchAll(ROOM_RE)) {
    if (seen.has(id)) continue;
    seen.add(id);
    links.push({ kind, id });
  }
  return links;
}

// World name (lowercased) → game ids, from the names the Archipelago syncs keep on each game
function buildWorldIndex(games) {
  const index = new Map();
  for (const game of games || []) {
    const integrations = game.integrations || {};
    const names = [
      integrations.archipelago?.gameName,
      integrations.multiworld?.gameName,
      ...(integrations.apworld?.gameNames || [])
    ];
    for (const name of names) {
      const key = String(name || '').trim().toLowerCase();
      if (!key) continue;
      if (!index.has(key)) index.set(key, new Set());
      index.get(key).add(game.id);
    }
  }
  return index;
}

// Game ids of the worlds of a room: only names that lead to one game
function gamesOfWorlds(worlds, worldIndex) {
  const ids = [];
  for (const world of worlds || []) {
    const key = String(world || '').trim().toLowerCase();
    if (!key || IGNORED_WORLDS.has(key)) continue;
    const owners = worldIndex.get(key);
    if (owners && owners.size === 1) ids.push([...owners][0]);
  }
  return ids;
}

/**
 * Worlds played in an Archipelago room, by its API. A new_room link leads to the
 * room it opened. { id, games, missing } (missing: the room is gone).
 */
async function fetchRoom({ kind, id }, http = axios) {
  let roomId = id;
  if (kind === 'new_room') {
    const response = await http.get(`${ROOM_API}/${kind}/${encodeURIComponent(id)}`, {
      headers: HTTP_HEADERS, timeout: 20000, maxRedirects: 0, validateStatus: s => s < 500
    });
    const location = response.headers?.location || '';
    const match = location.match(/\/room\/([A-Za-z0-9_-]+)/);
    if (!match) return { id, games: [], missing: true };
    roomId = match[1];
  }

  const response = await http.get(`${ROOM_API}/api/room_status/${encodeURIComponent(roomId)}`, {
    headers: HTTP_HEADERS, timeout: 20000, validateStatus: s => s < 500
  });
  if (response.status !== 200 || !Array.isArray(response.data?.players)) return { id, games: [], missing: true };
  const games = [...new Set(response.data.players.map(p => (Array.isArray(p) ? p[1] : p?.game)).filter(Boolean))];
  return { id, games, missing: false };
}

/**
 * Games of a race of a multi-game category, from its goal and its Archipelago
 * rooms (already fetched ones are reused). { games, rooms }
 */
async function resolveRaceGames(race, { worldIndex, knownGameIds, fetchRoomFn = fetchRoom }) {
  const games = new Set(gamesOfGoal(race.category, race.goal));

  const fetched = new Map((race.archipelagoRooms || []).map(room => [room.id, room]));
  const rooms = [];
  for (const link of roomLinks(race.info)) {
    let room = fetched.get(link.id);
    if (!room) {
      try {
        room = { ...(await fetchRoomFn(link)), fetchedAt: new Date() };
      } catch (error) {
        // Network failure: tried again on the next run
        continue;
      }
    }
    rooms.push(room);
    gamesOfWorlds(room.games, worldIndex).forEach(id => games.add(id));
  }

  return {
    games: [...games].filter(id => !knownGameIds || knownGameIds.has(id)),
    rooms
  };
}

/**
 * Ties the races of the multi-game categories to their games: the races never
 * checked, or changed since (an info edited before the start). Manual ties stay.
 */
async function resolveMultiworldRaces({ Race, Game, all = false, log = () => {}, fetchRoomFn } = {}) {
  const gameDocs = await Game.find({})
    .select('id integrations.archipelago.gameName integrations.multiworld.gameName integrations.apworld.gameNames')
    .lean();
  const worldIndex = buildWorldIndex(gameDocs);
  const knownGameIds = new Set(gameDocs.map(g => g.id));

  const query = {
    category: { $in: MULTIWORLD_CATEGORIES },
    gamesSource: { $ne: 'manual' }
  };
  if (!all) {
    query.$or = [
      { gamesCheckedAt: null },
      { multiworld: { $ne: true } },
      { $expr: { $gt: ['$updatedAt', '$gamesCheckedAt'] } }
    ];
  }
  const races = await Race.find(query).select('category goal info games archipelagoRooms updatedAt').lean();

  const stats = { checked: 0, tied: 0, untied: 0 };
  for (const race of races) {
    const { games, rooms } = await resolveRaceGames(race, { worldIndex, knownGameIds, fetchRoomFn });
    // Keeps updatedAt: it tells a race changed since its last check
    await Race.updateOne({ _id: race._id }, {
      $set: {
        multiworld: true,
        games,
        gamesSource: 'auto',
        archipelagoRooms: rooms,
        gamesCheckedAt: new Date(Date.now() + 1000)
      }
    }, { timestamps: false });
    stats.checked++;
    if (games.length) stats.tied++;
    else stats.untied++;
  }
  log(`  ✓ ${stats.checked} course(s) multiworld vérifiée(s) : ${stats.tied} rattachée(s), ${stats.untied} sans jeu`);
  return stats;
}

module.exports = {
  MULTIWORLD_CATEGORIES,
  GOAL_GAMES,
  isMultiworldCategory,
  categoryLabel,
  multiworldRaceName,
  gamesOfGoal,
  roomLinks,
  buildWorldIndex,
  gamesOfWorlds,
  fetchRoom,
  resolveRaceGames,
  resolveMultiworldRaces
};
