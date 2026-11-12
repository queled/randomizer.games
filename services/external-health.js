const axios = require('axios');
const youtube = require('./youtube');
const searchConsole = require('./search-console');
const { getAppToken } = require('./twitch-vods');

/**
 * The external APIs the syncs use, for the admin health page: each one is checked
 * as the site uses it, with its own credentials, so a refused key or an exhausted
 * quota shows, not only whether the site answers.
 *
 * Every check gives { status: 'ok' | 'warning' | 'error', detail?, note }: detail
 * says what is wrong, note how it was checked. Results are kept 10 minutes, the page
 * refreshing every minute.
 */

const TTL = 10 * 60 * 1000;
const TIMEOUT = 5000;
const cache = new Map();

// An HTTP failure in words: a refusal of our credentials or no answer at all
function failure(error, refused = 'refusé') {
  if (error.response?.status === 429) return { status: 'warning', detail: 'limite de requêtes atteinte' };
  if (error.response) return { status: 'error', detail: `${refused} (${error.response.status})` };
  return { status: 'error', detail: 'injoignable' };
}

const CHECKS = {
  // Public API, without a key
  async racetime() {
    const note = 'API publique';
    try {
      await axios.get('https://racetime.gg/races/data', { timeout: TIMEOUT });
      return { status: 'ok', note };
    } catch (error) {
      return { ...failure(error), note };
    }
  },

  async startgg() {
    const note = 'jeton vérifié';
    if (!process.env.STARTGG_API_TOKEN) return { status: 'warning', detail: 'jeton absent', note };
    try {
      const { data } = await axios.post('https://api.start.gg/gql/alpha', { query: '{ currentUser { id } }' }, {
        headers: { Authorization: `Bearer ${process.env.STARTGG_API_TOKEN}` },
        timeout: TIMEOUT
      });
      return data?.data?.currentUser ? { status: 'ok', note } : { status: 'error', detail: 'jeton refusé', note };
    } catch (error) {
      return { ...failure(error, 'jeton refusé'), note };
    }
  },

  // The app token of the syncs, checked by Twitch's validation endpoint (no rate limit cost)
  async twitch() {
    const note = 'jeton d’application vérifié';
    try {
      const token = await getAppToken();
      if (!token) return { status: 'warning', detail: 'identifiants absents', note };
      await axios.get('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${token}` }, timeout: TIMEOUT });
      return { status: 'ok', note };
    } catch (error) {
      return { ...failure(error, 'identifiants refusés'), note };
    }
  },

  // 1 unit of the 10,000 a day: at most 144 a day with the cache
  async youtube() {
    const note = 'clé et quota vérifiés';
    if (!youtube.hasKey()) return { status: 'warning', detail: 'clé absente', note };
    try {
      await youtube.ping();
      return { status: 'ok', note };
    } catch (error) {
      if (youtube.isQuotaError(error)) return { status: 'warning', detail: 'quota du jour épuisé', note };
      return { ...failure(error, 'clé refusée'), note };
    }
  },

  // The service account must still be a user of the property
  async searchConsole() {
    const note = 'accès à la propriété vérifié';
    if (!searchConsole.hasKey()) return { status: 'warning', detail: 'clé absente', note };
    try {
      await searchConsole.ping();
      return { status: 'ok', note };
    } catch (error) {
      return { ...failure(error, 'accès refusé'), note };
    }
  }
};

async function cached(name) {
  const hit = cache.get(name);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await CHECKS[name]().catch(() => ({ status: 'error', detail: 'vérification impossible' }));
  cache.set(name, { value, expiresAt: Date.now() + TTL });
  return value;
}

/**
 * Challonge allows 500 requests per 30 days: no call from this page, the daily
 * `challonge-check` task tells whether the quota lets requests through.
 */
function challongeFromJob(job) {
  const note = 'quota vérifié chaque jour';
  if (!process.env.CHALLONGE_API_KEY) return { status: 'warning', detail: 'clé absente', note };
  if (!job || !job.startedAt) return { status: 'warning', detail: 'jamais vérifié', note };
  if (job.state === 'ok' || job.state === 'running') return { status: 'ok', note, checkedAt: job.startedAt };
  if (job.exitCode === 1) return { status: 'warning', detail: 'quota épuisé', note, checkedAt: job.startedAt };
  return { status: 'error', detail: job.state === 'late' ? 'contrôle en retard' : 'contrôle en échec', note, checkedAt: job.startedAt };
}

// In the order of the monitoring page
async function getExternalHealth(jobs = []) {
  const [racetime, startgg, twitch, youtubeState, searchConsoleState] = await Promise.all(['racetime', 'startgg', 'twitch', 'youtube', 'searchConsole'].map(cached));
  return [
    { name: 'racetime.gg API', ...racetime },
    { name: 'Challonge API', ...challongeFromJob(jobs.find(job => job.name === 'challonge-check')) },
    { name: 'start.gg API', ...startgg },
    { name: 'Twitch API', ...twitch },
    { name: 'YouTube API', ...youtubeState },
    { name: 'Search Console API', ...searchConsoleState }
  ];
}

module.exports = { getExternalHealth, challongeFromJob };
