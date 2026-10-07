const axios = require('axios');

// 50 keeps team entrants and nested set slots well under start.gg's 1000-object request limit.
const EVENT_PAGE_SIZE = 50;

const PARTICIPANT_FIELDS = 'gamerTag prefix user { id name slug }';
const ENTRANT_FIELDS = `id name initialSeedNum participants { ${PARTICIPANT_FIELDS} }`;
const STANDING_FIELDS = `placement entrant { id name participants { ${PARTICIPANT_FIELDS} } }`;
const SET_FIELDS = `
  id round displayScore winnerId completedAt state
  phaseGroup { id displayIdentifier phase { id name } }
  slots { entrant { id name } }
`;

/**
 * start.gg ranks whoever reached a later phase first. With parallel final brackets
 * (e.g. Swiss → Gold + Silver), the Silver players are therefore placed above the Gold ones
 * when Silver comes later in phaseOrder. Re-rank such brackets by strength: the bracket whose
 * players won more in the stage feeding it comes first. Ties inside a bracket are kept.
 */
function rankParallelBrackets(standings, phases, sets) {
  if (!standings.length || phases.length < 3 || !sets.length) return standings;

  const orderOf = new Map(phases.map(p => [String(p.id), p.phaseOrder || 0]));
  const playersOf = new Map(phases.map(p => [String(p.id), new Set()]));
  const winsIn = new Map(); // `${phaseId}|${entrantId}` → wins
  for (const set of sets) {
    const phaseId = set.phaseGroup?.phase?.id != null ? String(set.phaseGroup.phase.id) : null;
    if (!playersOf.has(phaseId)) continue;
    for (const slot of set.slots || []) {
      const entrantId = slot.entrant?.id != null ? String(slot.entrant.id) : null;
      if (!entrantId) continue;
      playersOf.get(phaseId).add(entrantId);
      if (String(set.winnerId) === entrantId) {
        const key = `${phaseId}|${entrantId}`;
        winsIn.set(key, (winsIn.get(key) || 0) + 1);
      }
    }
  }

  // Each later phase is fed by the earlier phase sharing the most players with it
  const overlap = (a, b) => [...playersOf.get(a)].filter(id => playersOf.get(b).has(id)).length;
  const children = new Map();
  for (const phaseId of playersOf.keys()) {
    let parent = null;
    let best = 0;
    for (const earlier of playersOf.keys()) {
      if (orderOf.get(earlier) >= orderOf.get(phaseId)) continue;
      const shared = overlap(phaseId, earlier);
      if (shared > best) { best = shared; parent = earlier; }
    }
    if (parent) children.set(parent, [...(children.get(parent) || []), phaseId]);
  }

  // phaseId → { level, tier } for brackets played side by side by disjoint players
  const placeOf = new Map();
  for (const [parent, siblings] of children) {
    if (siblings.length < 2) continue;
    const disjoint = siblings.every(a => siblings.every(b => a === b || !overlap(a, b)));
    if (!disjoint) continue;
    const strength = phaseId => {
      const players = [...playersOf.get(phaseId)];
      return players.reduce((sum, id) => sum + (winsIn.get(`${parent}|${id}`) || 0), 0) / (players.length || 1);
    };
    const level = Math.min(...siblings.map(id => orderOf.get(id)));
    [...siblings]
      .sort((a, b) => strength(b) - strength(a) || orderOf.get(a) - orderOf.get(b))
      .forEach((phaseId, tier) => placeOf.set(phaseId, { level, tier }));
  }
  if (!placeOf.size) return standings;

  // Bucket = the last stage an entrant played; buckets keep start.gg's order inside them
  const bucketOf = standing => {
    const entrantId = String(standing.entrant?.id);
    let last = null;
    for (const phaseId of playersOf.keys()) {
      if (playersOf.get(phaseId).has(entrantId) && (!last || orderOf.get(phaseId) > orderOf.get(last))) last = phaseId;
    }
    if (!last) return { level: -1, tier: 0 };
    return placeOf.get(last) || { level: orderOf.get(last), tier: 0 };
  };
  const ranked = standings
    .map(standing => ({ standing, bucket: bucketOf(standing) }))
    .sort((a, b) => b.bucket.level - a.bucket.level || a.bucket.tier - b.bucket.tier
      || (a.standing.placement || 0) - (b.standing.placement || 0));

  let offset = 0;
  return ranked.map(({ standing, bucket }, index) => {
    const prev = ranked[index - 1];
    const sameBucket = prev && prev.bucket.level === bucket.level && prev.bucket.tier === bucket.tier;
    if (!sameBucket) offset = index;
    const firstTied = ranked.findIndex((entry, i) => i >= offset && entry.bucket.level === bucket.level
      && entry.bucket.tier === bucket.tier && entry.standing.placement === standing.placement);
    return { ...standing, placement: firstTied + 1 };
  });
}

class StartGGAPI {
  constructor() {
    this.apiToken = process.env.STARTGG_API_TOKEN;
    this.baseURL = 'https://api.start.gg/gql/alpha';
  }

  /**
   * Execute a GraphQL query
   */
  async query(query, variables = {}) {
    try {
      const response = await axios.post(
        this.baseURL,
        {
          query,
          variables
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiToken}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      if (response.data.errors) {
        console.error('GraphQL errors:', response.data.errors);
        throw new Error(response.data.errors[0].message);
      }

      return response.data.data;
    } catch (error) {
      console.error('Start.gg API error:', error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get tournament by slug
   * Example slug: "tournament/ocarina-of-time-randomizer-standard-tournament-season-9"
   */
  async getTournament(slug, { details = true } = {}) {
    const query = `
      query TournamentQuery($slug: String!) {
        tournament(slug: $slug) {
          id
          name
          slug
          startAt
          endAt
          numAttendees
          venueAddress
          events {
            id
            name
            slug
            startAt
            numEntrants
            state
            type
            videogame {
              id
              name
              displayName
            }
            phases {
              id
              name
              numSeeds
              bracketType
              phaseOrder
              state
              groupCount
            }
          }
        }
      }
    `;

    const data = await this.query(query, { slug });
    if (!data.tournament) return null;

    // Heavy connections are fetched per event in small pages: one big query exceeds the 1000-object limit.
    for (const event of details ? data.tournament.events || [] : []) {
      event.entrants = { nodes: await this.fetchEventPages(event.id, 'entrants', ENTRANT_FIELDS) };
      event.standings = { nodes: await this.fetchEventPages(event.id, 'standings', STANDING_FIELDS) };
      const sets = await this.fetchEventPages(event.id, 'sets', SET_FIELDS, 'sortType: STANDARD');
      event.sets = { nodes: sets, pageInfo: { total: sets.length, totalPages: Math.ceil(sets.length / EVENT_PAGE_SIZE) } };
    }

    return this.formatTournament(data.tournament);
  }

  /**
   * Fetch every page of an event connection (entrants, standings or sets).
   */
  async fetchEventPages(eventId, connection, nodeFields, extraArgs = '') {
    const query = `
      query EventPage($eventId: ID!, $page: Int!, $perPage: Int!) {
        event(id: $eventId) {
          ${connection}(${connection === 'sets' ? 'page: $page, perPage: $perPage' : 'query: { page: $page, perPage: $perPage }'}${extraArgs ? `, ${extraArgs}` : ''}) {
            pageInfo { totalPages }
            nodes { ${nodeFields} }
          }
        }
      }
    `;

    const nodes = [];
    let totalPages = 1;
    for (let page = 1; page <= totalPages; page++) {
      const data = await this.query(query, { eventId, page, perPage: EVENT_PAGE_SIZE });
      const result = data.event?.[connection];
      totalPages = result?.pageInfo?.totalPages || 1;
      nodes.push(...(result?.nodes || []));
    }
    return nodes;
  }

  /**
   * Get event with bracket details
   */
  async getEvent(eventId) {
    const query = `
      query EventQuery($eventId: ID!) {
        event(id: $eventId) {
          id
          name
          slug
          startAt
          numEntrants
          state
          videogame {
            id
            name
            displayName
          }
          standings(query: {
            perPage: 100
          }) {
            nodes {
              placement
              entrant {
                id
                name
                participants {
                  gamerTag
                  prefix
                  user {
                    id
                    name
                    slug
                  }
                }
              }
            }
          }
          sets(
            page: 1
            perPage: 100
            sortType: STANDARD
          ) {
            nodes {
              id
              completedAt
              round
              displayScore
              winnerId
              slots {
                entrant {
                  id
                  name
                  participants {
                    gamerTag
                  }
                }
              }
            }
          }
        }
      }
    `;

    const data = await this.query(query, { eventId });
    return this.formatEvent(data.event);
  }

  /**
   * Format tournament data to match our schema
   */
  formatTournament(tournament) {
    if (!tournament) return null;

    return {
      id: tournament.id,
      name: tournament.name,
      slug: tournament.slug,
      startDate: tournament.startAt ? new Date(tournament.startAt * 1000) : null,
      endDate: tournament.endAt ? new Date(tournament.endAt * 1000) : null,
      numAttendees: tournament.numAttendees,
      venueAddress: tournament.venueAddress,
      events: tournament.events?.map(e => this.formatEvent(e)) || [],
      source: 'startgg',
      sourceUrl: `https://start.gg/${tournament.slug}`
    };
  }

  /**
   * Format event data
   */
  formatEvent(event) {
    if (!event) return null;

    return {
      id: event.id,
      name: event.name,
      slug: event.slug,
      startDate: event.startAt ? new Date(event.startAt * 1000) : null,
      numEntrants: event.numEntrants,
      state: event.state,
      game: event.videogame ? {
        id: event.videogame.id,
        name: event.videogame.displayName || event.videogame.name
      } : null,
      // Entrants list (for active tournaments without standings yet)
      entrants: event.entrants?.nodes?.map(e => ({
        id: e.id,
        name: e.name,
        seed: e.initialSeedNum,
        participants: e.participants?.map(p => ({
          gamerTag: p.gamerTag,
          prefix: p.prefix,
          userId: p.user?.id,
          userName: p.user?.name,
          userSlug: p.user?.slug
        })) || []
      })) || [],
      standings: rankParallelBrackets(event.standings?.nodes || [], event.phases || [], event.sets?.nodes || []).map(s => ({
        placement: s.placement,
        entrantId: s.entrant.id,
        entrantName: s.entrant.name,
        participants: s.entrant.participants?.map(p => ({
          gamerTag: p.gamerTag,
          prefix: p.prefix,
          userId: p.user?.id,
          userName: p.user?.name,
          userSlug: p.user?.slug
        })) || []
      })) || [],
      // Phases/brackets info
      phases: event.phases?.map(p => ({
        id: p.id,
        name: p.name,
        bracketType: p.bracketType,
        phaseOrder: p.phaseOrder,
        numSeeds: p.numSeeds,
        groupCount: p.groupCount,
        state: p.state
      })) || [],
      // Sets/matches with phase info
      sets: event.sets?.nodes?.map(s => ({
        id: s.id,
        completedAt: s.completedAt ? new Date(s.completedAt * 1000) : null,
        round: s.round,
        displayScore: s.displayScore,
        winnerId: s.winnerId,
        state: s.state,
        phase: s.phaseGroup?.phase ? {
          id: s.phaseGroup.phase.id,
          name: s.phaseGroup.phase.name
        } : null,
        phaseGroup: s.phaseGroup ? {
          id: s.phaseGroup.id,
          displayIdentifier: s.phaseGroup.displayIdentifier
        } : null,
        entrants: s.slots?.map(slot => ({
          id: slot.entrant?.id,
          name: slot.entrant?.name,
          gamerTag: slot.entrant?.participants?.[0]?.gamerTag
        })) || []
      })) || [],
      setsTotal: event.sets?.pageInfo?.total || 0,
      setsTotalPages: event.sets?.pageInfo?.totalPages || 0
    };
  }

  /**
   * Search tournaments by name/keyword.
   * @param {string} name - search term
   * @param {number} perPage - results per page (max 100)
   * @param {number} page - page number (1-based)
   * @param {Object} extraFilter - additional filter fields (afterDate, beforeDate, videogameIds…)
   * @returns {Object} { tournaments, totalPages, total }
   */
  async searchTournaments(name, { perPage = 25, page = 1, afterDate = null, beforeDate = null, videogameIds = null } = {}) {
    const filter = {};
    if (name) filter.name = name;
    if (afterDate) filter.afterDate = Math.floor(new Date(afterDate).getTime() / 1000);
    if (beforeDate) filter.beforeDate = Math.floor(new Date(beforeDate).getTime() / 1000);
    if (videogameIds && videogameIds.length) filter.videogameIds = videogameIds;

    const q = `
      query SearchTournaments($perPage: Int!, $page: Int!, $filter: TournamentPageFilter) {
        tournaments(query: {
          perPage: $perPage,
          page: $page,
          filter: $filter
        }) {
          pageInfo {
            total
            totalPages
            page
            perPage
          }
          nodes {
            id
            name
            slug
            startAt
            endAt
            numAttendees
            state
            events {
              id
              name
              slug
              numEntrants
              state
              videogame {
                id
                name
                displayName
              }
            }
          }
        }
      }
    `;

    const data = await this.query(q, { perPage, page, filter });
    const result = data.tournaments || {};
    return {
      tournaments: (result.nodes || []).map(t => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        startDate: t.startAt ? new Date(t.startAt * 1000) : null,
        endDate: t.endAt ? new Date(t.endAt * 1000) : null,
        numAttendees: t.numAttendees,
        state: t.state,
        events: (t.events || []).map(e => ({
          id: e.id,
          name: e.name,
          slug: e.slug,
          numEntrants: e.numEntrants,
          state: e.state,
          game: e.videogame ? {
            id: e.videogame.id,
            name: e.videogame.displayName || e.videogame.name
          } : null
        }))
      })),
      totalPages: result.pageInfo?.totalPages || 0,
      total: result.pageInfo?.total || 0
    };
  }

  /**
   * Search tournaments by videogame ID(s) on start.gg.
   * @param {Array<number>} videogameIds
   * @param {Object} options
   * @returns {Object} { tournaments, totalPages, total }
   */
  async searchTournamentsByGame(videogameIds, options = {}) {
    return this.searchTournaments(null, { ...options, videogameIds });
  }

  /**
   * Extract tournament slug from start.gg URL
   */
  static extractSlugFromUrl(url) {
    // https://www.start.gg/tournament/ocarina-of-time-randomizer-standard-tournament-season-9/events
    // => tournament/ocarina-of-time-randomizer-standard-tournament-season-9
    const match = url.match(/start\.gg\/(tournament\/[^\/]+)/);
    return match ? match[1] : null;
  }
}

module.exports = StartGGAPI;
