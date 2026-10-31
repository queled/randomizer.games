// Pages with too little on them to be worth a search result: they stay
// reachable and their links followed (noindex,follow), and leave the sitemap.
// A large share of empty pages lowers how search engines rate the whole site.

// A game with no race, no tournament and no history: a title and some links
function isThinGame({ totalRaces, totalTournaments, hasHistory }) {
  return !totalRaces && !totalTournaments && !hasHistory;
}

// A player seen in one or two races and no tournament
const MIN_PLAYER_RACES = 3;
function isThinPlayer({ races, tournaments }) {
  return (Number(races) || 0) < MIN_PLAYER_RACES && !(Number(tournaments) || 0);
}

module.exports = { isThinGame, isThinPlayer, MIN_PLAYER_RACES };
