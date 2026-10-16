// Races of a player, shared by the player page API (routes/players.js) and the
// server-rendered social preview of the player page (services/seo-pages.js).

const escapeRegex = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exactNameRegex = name => new RegExp('^' + escapeRegex(name) + '$', 'i');

/**
 * Race filter for a player: their racetime userId (stable across renames), their
 * current name, and their aliases. Aliases only match entrants without a userId
 * (SpeedRunsLive history, manual imports), so they never capture someone else's
 * racetime account.
 */
function buildPlayerRacesFilter({ userId, names = [], aliases = [] }) {
  const or = [];
  const nameRegexes = names.filter(Boolean).map(exactNameRegex);
  const aliasRegexes = aliases.filter(Boolean).map(exactNameRegex);
  if (userId) or.push({ 'entrants.userId': userId });
  if (nameRegexes.length) or.push({ 'entrants.userName': { $in: nameRegexes } });
  if (aliasRegexes.length) {
    or.push({ entrants: { $elemMatch: { userName: { $in: aliasRegexes }, userId: { $in: [null, ''] } } } });
  }

  const isPlayerEntrant = e => (userId && e.userId === userId)
    || nameRegexes.some(re => re.test(e.userName || ''))
    || (!e.userId && aliasRegexes.some(re => re.test(e.userName || '')));

  return { filter: or.length ? { $or: or } : { _id: null }, isPlayerEntrant };
}

module.exports = { escapeRegex, exactNameRegex, buildPlayerRacesFilter };
