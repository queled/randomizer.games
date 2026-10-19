const axios = require('axios');

// Milliseconds of an ISO8601-like duration PT#H#M#S or P0DT#H#M#S, or null
function durationToMs(duration) {
  if (!duration) return null;
  const cleaned = String(duration).replace(/^P(?:\d+D)?T/, 'PT');
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/.exec(cleaned);
  if (!m) return null;
  const h = parseInt(m[1] || 0, 10);
  const mm = parseInt(m[2] || 0, 10);
  const ss = parseFloat(m[3] || 0);
  return Math.round(((h * 3600) + (mm * 60) + ss) * 1000);
}

class RacetimeAPI {
  constructor() {
    this.baseURL = 'https://racetime.gg';
  }

  /**
   * Get race details
   * @param {string} category - Game category 
   * @param {string} raceId - The race ID
   */
  async getRace(category, raceId) {
    try {
      const response = await axios.get(
        `${this.baseURL}/${category}/${raceId}/data`
      );
      return this.formatRace(response.data);
    } catch (error) {
      console.error(`Error fetching race ${category}/${raceId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get the entrants of a race currently streaming on Twitch
   * @param {string} raceUrl - Race path ('/category/slug') or full racetime URL
   * @returns {Promise<Array<{userId: string, userName: string, twitchChannel: string}>>}
   */
  async getLiveStreams(raceUrl) {
    const path = String(raceUrl || '').replace(/^https?:\/\/(www\.)?racetime\.gg/i, '').replace(/\/+$/, '');
    // Only a '/category/slug' path, so the request can't leave the race data endpoint
    if (!/^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(path)) return [];
    const response = await axios.get(`${this.baseURL}${path}/data`, { timeout: 5000 });
    return (response.data?.entrants || [])
      .filter(e => e.stream_live && e.user?.twitch_name && /^[A-Za-z0-9_]{1,25}$/.test(e.user.twitch_name))
      .map(e => ({
        userId: e.user.id,
        userName: e.user.name,
        twitchChannel: e.user.twitch_name
      }));
  }

  /**
   * Get past races for a category
   * @param {string} category - Game category
   * @param {number} page - Page number
   * @param {object} [options]
   * @param {boolean} [options.showEntrants=true] - false for a lighter listing
   */
  async getPastRaces(category, page = 1, { showEntrants = true } = {}) {
    try {
      const response = await axios.get(
        `${this.baseURL}/${category}/races/data`,
        {
          params: {
            show_entrants: showEntrants,
            page: page
          }
        }
      );
      // Defensive: racetime may return different shapes or an HTML page on rate-limit / not-found.
      const data = response.data || {};
      if (!Array.isArray(data.races)) {
        // Debug: log what we actually got
        console.warn(`⚠️  [${category}] API response structure issue on page ${page}:`);
        console.warn(`   Type of response.data: ${typeof data}`);
        console.warn(`   Has 'races' property: ${!!data.races}`);
        console.warn(`   Keys in response: ${Object.keys(data).slice(0, 10).join(', ')}`);
        if (data.status === 'error') {
          console.warn(`   Error message: ${data.message}`);
        }
        // no races array available — return empty page instead of throwing
        return { races: [], hasNext: false };
      }
      return {
        races: data.races.map(r => this.formatRace(r)).filter(r => r !== null),
        hasNext: data.races.length > 0,
        numPages: data.num_pages || null
      };
    } catch (error) {
      console.error(`❌ Error fetching races for ${category} page ${page}:`, error.message);
      if (error.response) {
        console.error(`   Status: ${error.response.status}`);
        console.error(`   Content-Type: ${error.response.headers['content-type']}`);
        console.error(`   Data preview: ${JSON.stringify(error.response.data || '').substring(0, 200)}`);
      }
      throw error;
    }
  }

  /**
   * Search races by tournament name in info field
   */
  async searchTournamentRaces(category, tournamentName) {
    const races = [];
    let page = 1;
    let hasNext = true;

    while (hasNext && page <= 10) { // Limit to 10 pages
      const result = await this.getPastRaces(category, page);
      
      const tournamentRaces = result.races.filter(race => 
        race.info && race.info.toLowerCase().includes(tournamentName.toLowerCase())
      );
      
      races.push(...tournamentRaces);
      hasNext = result.hasNext;
      page++;
    }

    return races;
  }

  /**
   * Format race data
   */
  formatRace(race) {
    // Defensive: handle missing or undefined fields
    if (!race) {
      console.warn('⚠️  formatRace called with undefined race');
      return null;
    }
    
    try {
      return {
        name: race.name || 'Unknown',
        status: race.status?.value || race.status || 'unknown',
        url: race.url || '',
        websiteUrl: race.websocket_url || '',
        category: race.category?.slug || race.slug || 'unknown',
        goal: race.goal?.name || null,
        info: race.info || '',
        openedAt: race.opened_at,
        startedAt: race.started_at,
        endedAt: race.ended_at,
        recordable: race.recordable || false,
        entrants: race.entrants ? race.entrants.map(e => this.formatEntrant(e)).filter(e => e) : [],
        version: race.version
      };
    } catch (error) {
      console.error(`⚠️  Error formatting race: ${error.message}`);
      console.error(`   Race data keys: ${Object.keys(race || {}).join(', ')}`);
      return null;
    }
  }

  /**
   * Format entrant data
   */
  formatEntrant(entrant) {
    const finishTime = entrant.finish_time || null;
    const finishTimeMs = durationToMs(finishTime);

    return {
      // Deleted racetime accounts come back without a user
      user: entrant.user ? {
        id: entrant.user.id,
        name: entrant.user.name,
        discriminator: entrant.user.discriminator,
        url: entrant.user.url
      } : null,
      status: entrant.status?.value,
      finishTime: finishTime,
      finishTimeMs: finishTimeMs,
      finishedAt: entrant.finished_at,
      place: entrant.place,
      placeOrdinal: entrant.place_ordinal,
      score: entrant.score,
      scoreChange: entrant.score_change,
      comment: entrant.comment
    };
  }

  /**
   * Entrants of formatRace() as stored on a Race document
   */
  toStoredEntrants(entrants = []) {
    return entrants.map(entrant => ({
      userId: entrant.user?.id,
      userName: entrant.user?.name,
      userDiscriminator: entrant.user?.discriminator,
      userUrl: entrant.user?.url,
      status: entrant.status,
      finishTime: entrant.finishTime,
      finishTimeMs: entrant.finishTimeMs,
      finishedAt: entrant.finishedAt,
      place: entrant.place,
      placeOrdinal: entrant.placeOrdinal,
      comment: entrant.comment
    }));
  }

  /**
   * Get leaderboard for a category: one ranking per goal, current and archived
   */
  async getLeaderboard(category) {
    try {
      const response = await axios.get(
        `${this.baseURL}/${encodeURIComponent(category)}/leaderboards/data`,
        { timeout: 15000 }
      );
      return response.data;
    } catch (error) {
      console.error(`Error fetching leaderboard for ${category}:`, error.message);
      throw error;
    }
  }

  /**
   * Get all available game categories on racetime.gg
   * @returns {Promise<Array>} List of game categories
   */
  async getAllCategories() {
    try {
      const response = await axios.get(`${this.baseURL}/races/data`);
      const categories = new Map();
      
      // Extract unique categories from races
      if (response.data?.races) {
        for (const race of response.data.races) {
          if (race.category && !categories.has(race.category.slug)) {
            categories.set(race.category.slug, {
              slug: race.category.slug,
              name: race.category.name,
              shortName: race.category.short_name,
              url: race.category.url,
              image: race.category.image
            });
          }
        }
      }
      
      return Array.from(categories.values());
    } catch (error) {
      console.error('Error fetching racetime categories:', error.message);
      throw error;
    }
  }

  /**
   * Check if a game category exists on racetime.gg
   * @param {string} slug - Category slug 
   * @returns {Promise<Object|null>} Category info or null
   */
  async getCategoryInfo(slug) {
    try {
      const response = await axios.get(`${this.baseURL}/${encodeURIComponent(slug)}/data`, { timeout: 15000 });
      if (response.data?.name) {
        return {
          slug: slug,
          name: response.data.name,
          shortName: response.data.short_name,
          url: `${this.baseURL}/${slug}`,
          image: response.data.image,
          // Goals races can currently be opened with
          goals: response.data.goals || []
        };
      }
      return null;
    } catch (error) {
      if (error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }
}

module.exports = new RacetimeAPI();
module.exports.durationToMs = durationToMs;
