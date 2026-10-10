/**
 * Speedrace (https://speedrace.deeplydevs.com) — restream planning of a few
 * OoTR tournaments, mostly French-speaking ones.
 *
 * Organizers create the matches, restreamers are assigned to them and enter
 * the link of their VOD themselves. Its public API gives each season's
 * matches with their restreams; races are still scheduled on Mido's House.
 */

const axios = require('axios');

const BASE_URL = 'https://speedrace.deeplydevs.com';
const API_URL = 'https://speedrace-api.deeplydevs.com';

const http = axios.create({
  baseURL: API_URL,
  timeout: 30000,
  headers: { 'User-Agent': 'RandomizerWebsite/1.0' }
});

/**
 * Games with a public planning: [{ name, slug }]
 */
async function listGames() {
  const { data } = await http.get('/api/Games');
  return (data.games || []).map(g => ({ name: g.name, slug: g.shortName }));
}

/**
 * Tournaments of a game: [{ name, slug }]
 */
async function listTournaments(gameSlug) {
  const { data } = await http.get(`/api/Planning/${encodeURIComponent(gameSlug)}`);
  return (data.tournaments || []).map(t => ({ name: t.name, slug: t.slug }));
}

/**
 * One match → { startAt, round, isAsync, players, restreams: [{ url, vodUrl }] }
 */
function parseMatch(match) {
  return {
    startAt: match.scheduledDateTime ? new Date(match.scheduledDateTime) : null,
    round: match.round || match.title || null,
    isAsync: !!match.isAsync,
    players: (match.players || []).map(p => p.externalDisplayName || (p.player && p.player.pseudo)).filter(Boolean),
    restreams: (match.restreams || [])
      .filter(r => r.restreamUrl)
      .map(r => ({ url: r.restreamUrl, vodUrl: r.vodUrl || null }))
  };
}

/**
 * Matches of a tournament's season (its active one when `seasonSlug` is left out):
 * { tournament, season, seasons, url, matches }
 */
async function getPlanning(gameSlug, tournamentSlug, seasonSlug) {
  const parts = [gameSlug, tournamentSlug, seasonSlug].filter(Boolean).map(encodeURIComponent).join('/');
  const { data } = await http.get(`/api/Planning/${parts}`, { params: { scope: 'All' } });
  return {
    tournament: data.subCategoryName,
    season: data.seasonSlug,
    seasons: (data.seasons || []).map(s => s.slug),
    url: `${BASE_URL}/${gameSlug}/${tournamentSlug}/planning`,
    matches: (data.matches || []).map(parseMatch)
  };
}

module.exports = { BASE_URL, listGames, listTournaments, getPlanning, parseMatch };
