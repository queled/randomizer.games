/**
 * The players list (/api/players): one entry per player as helpers/player-identity.js
 * tells them apart, so it counts what each player page shows. A player is listed when
 * they have races; deleted racetime accounts are left out (their races stay).
 */
const { tournamentGameLabel } = require('./game-label');
const { buildPlayerIdentity } = require('./player-identity');

/**
 * @param playerDocs Player documents (userId, name, aliases, discriminator, racetimeUrl, racetimeId, twitch, racetimeDeletedAt)
 * @param raceCounts rows { _id: { userId, entrantName, category }, count, lastRaceAt }
 * @param tournamentParticipants rows of one participant of one tournament (routes/players.js)
 * @param gameMaps { displayBySlug, canonicalIdBySlug } of the racetime categories
 * @param labelFor game label of a tournament's game reference
 */
function aggregatePlayers({ playerDocs, raceCounts, tournamentParticipants, gameMaps, labelFor, includeTournaments }) {
  const identity = buildPlayerIdentity(playerDocs);
  const docsByKey = new Map();
  for (const doc of playerDocs || []) {
    if (doc?.userId) docsByKey.set(`u:${doc.userId}`, doc);
  }
  const isDeleted = key => !!docsByKey.get(key)?.racetimeDeletedAt;

  // Races per racetime category, latest race, and the name raced under most recently
  const racesByKey = new Map();
  for (const row of raceCounts || []) {
    const category = String(row?._id?.category || '').toLowerCase();
    const key = identity.keyOfEntrant({ userId: row?._id?.userId, userName: row?._id?.entrantName });
    if (!key || !category || isDeleted(key)) continue;

    if (!racesByKey.has(key)) racesByKey.set(key, { perCategory: new Map(), lastRaceAt: null, lastName: null });
    const entry = racesByKey.get(key);
    entry.perCategory.set(category, (entry.perCategory.get(category) || 0) + (row.count || 0));
    const last = row.lastRaceAt ? new Date(row.lastRaceAt) : null;
    if (last && !(entry.lastRaceAt >= last)) {
      entry.lastRaceAt = last;
      entry.lastName = row._id.entrantName;
    } else if (!entry.lastName) {
      entry.lastName = row._id.entrantName;
    }
  }

  const players = new Map();
  const ensurePlayer = (key, fallbackName) => {
    if (!players.has(key)) {
      const doc = docsByKey.get(key);
      players.set(key, {
        name: doc?.name || racesByKey.get(key)?.lastName || fallbackName,
        discriminator: doc?.discriminator || null,
        games: new Set(),
        tournamentsCount: 0,
        tournaments: [],
        racetimeUrl: doc?.racetimeUrl || null,
        racetimeId: doc?.racetimeId || doc?.userId || null,
        userId: doc?.userId || (key.startsWith('u:') ? key.slice(2) : null),
        twitch: doc?.twitch || null
      });
    }
    return players.get(key);
  };

  for (const row of tournamentParticipants || []) {
    const key = identity.keyOfParticipant({
      racetimeUserId: row.racetimeUserId,
      racetimeName: row.racetimeName,
      name: row.participantName
    });
    if (!key || isDeleted(key) || !racesByKey.has(key)) continue;

    const player = ensurePlayer(key, row.racetimeName || row.participantName);
    const gameName = tournamentGameLabel({
      game: row.tournamentGame,
      gameId: row.tournamentGameId,
      gameSlug: row.tournamentGameSlug,
      gameName: row.tournamentGameName
    }, labelFor);
    if (gameName) player.games.add(gameName);
    player.tournamentsCount += 1;
    if (includeTournaments) {
      player.tournaments.push({
        tournamentId: row.tournamentId,
        tournamentName: row.tournamentName,
        gameName: gameName || null,
        finalRank: row.finalRank,
        seed: row.seed
      });
    }
  }

  // Racetime accounts with races and no tournament
  for (const key of racesByKey.keys()) {
    if (key.startsWith('u:')) ensurePlayer(key, key.slice(2));
  }

  const { displayBySlug, canonicalIdBySlug } = gameMaps || {};
  const list = Array.from(players.entries()).map(([key, player]) => {
    const races = racesByKey.get(key);

    // Racetime categories of one game count together, under the most raced one
    const racesByGameId = new Map();
    const categories = [...races.perCategory.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    for (const [slug, count] of categories) {
      const gameId = canonicalIdBySlug?.get(slug) || slug;
      const existing = racesByGameId.get(gameId);
      if (existing) {
        existing.count += count;
        continue;
      }
      racesByGameId.set(gameId, { gameId, gameSlug: slug, gameName: displayBySlug?.get(slug) || slug, count });
    }

    const totalRaces = Array.from(racesByGameId.values()).reduce((sum, g) => sum + g.count, 0);
    const racesByGame = Array.from(racesByGameId.values())
      .sort((a, b) => b.count - a.count || String(a.gameSlug).localeCompare(String(b.gameSlug)))
      .slice(0, 3);

    return {
      name: player.name,
      discriminator: player.discriminator,
      games: Array.from(player.games).sort(),
      tournamentsCount: player.tournamentsCount,
      tournaments: includeTournaments ? player.tournaments : [],
      racesByGame,
      totalRaces,
      lastRaceAt: races.lastRaceAt || null,
      racetimeUrl: player.racetimeUrl,
      racetimeId: player.racetimeId,
      userId: player.userId,
      twitch: player.twitch
    };
  }).sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.userId).localeCompare(String(b.userId)));

  return { players: list, total: list.length };
}

module.exports = { aggregatePlayers };
