// Races of a player, shared by the player page API (routes/players.js) and the
// server-rendered social preview of the player page (services/seo-pages.js).

const escapeRegex = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactNameRegex = name => new RegExp('^' + escapeRegex(name) + '$', 'i');

/**
 * Race filter for a player (helpers/player-identity.js): their racetime userId (stable
 * across renames), and the entrants without account (SpeedRunsLive history, manual
 * imports) under one of their own names. An entrant with an account is that account's
 * only: a name never captures another racetime account of the same name.
 */
function buildPlayerRacesFilter({ userId, names = [] }) {
  const or = [];
  const nameRegexes = [...new Set(names.filter(Boolean))].map(exactNameRegex);
  if (userId) or.push({ 'entrants.userId': userId });
  if (nameRegexes.length) {
    or.push({ entrants: { $elemMatch: { userName: { $in: nameRegexes }, userId: { $in: [null, ''] } } } });
  }

  const isPlayerEntrant = e => (userId && e.userId === userId)
    || (!e.userId && nameRegexes.some(re => re.test(e.userName || '')));

  return { filter: or.length ? { $or: or } : { _id: null }, isPlayerEntrant };
}

module.exports = { escapeRegex, exactNameRegex, buildPlayerRacesFilter };
