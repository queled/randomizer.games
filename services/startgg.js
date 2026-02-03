const axios = require('axios');

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
          }
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
  async getTournament(slug) {
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
            videogame {
              id
              name
              displayName
            }
            entrants(query: { perPage: 100 }) {
              nodes {
                id
                name
                initialSeedNum
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
          }
        }
      }
    `;

    const data = await this.query(query, { slug });
    return this.formatTournament(data.tournament);
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
      sets: event.sets?.nodes?.map(s => ({
        id: s.id,
        completedAt: s.completedAt ? new Date(s.completedAt * 1000) : null,
        round: s.round,
        displayScore: s.displayScore,
        winnerId: s.winnerId,
        entrants: s.slots?.map(slot => ({
          id: slot.entrant?.id,
          name: slot.entrant?.name,
          gamerTag: slot.entrant?.participants?.[0]?.gamerTag
        })) || []
      })) || []
    };
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
