// Races of a player, shared by the player page API (routes/players.js) and the
// server-rendered social preview of the player page (services/seo-pages.js).

const escapeRegex = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactNameRegex = name => new RegExp('^' + escapeRegex(name) + '$', 'i');

/**
 * Race filter for a player (helpers/player-identity.js): their racetime userId (stable
 * across renames), and the entrants without account (SpeedRunsLive history, manual
 * imports) under one of `names`, the exact spellings those entrants have
 * (namesRacedWithoutAccount). An entrant with an account is that account's only: a
 * name never captures another racetime account of the same name.
 */
function buildPlayerRacesFilter({ userId, names = [] }) {
  const or = [];
  const spellings = [...new Set(names.filter(Boolean).map(String))];
  if (userId) or.push({ 'entrants.userId': userId });
  if (spellings.length) {
    or.push({ entrants: { $elemMatch: { userName: { $in: spellings }, userId: { $in: [null, ''] } } } });
  }

  const nameSet = new Set(spellings);
  const isPlayerEntrant = e => (userId && e.userId === userId)
    || (!e.userId && nameSet.has(e.userName));

  return { filter: or.length ? { $or: or } : { _id: null }, isPlayerEntrant };
}

module.exports = { escapeRegex, exactNameRegex, buildPlayerRacesFilter };
