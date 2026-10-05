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
      standings: event.standings?.nodes?.map(s => ({
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
