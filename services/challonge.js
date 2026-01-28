const axios = require('axios');

class ChallongeAPI {
  constructor() {
    this.apiKey = process.env.CHALLONGE_API_KEY;
    this.username = process.env.CHALLONGE_USERNAME;
    this.baseURL = 'https://api.challonge.com/v1';
  }

  /**
   * Get tournament details
   * @param {string} tournamentId - The tournament ID or URL
   */
  async getTournament(tournamentId) {
    try {
      const response = await axios.get(
        `${this.baseURL}/tournaments/${tournamentId}.json`,
        {
          params: {
            api_key: this.apiKey,
            include_participants: 1,
            include_matches: 1
          }
        }
      );
      return this.formatTournament(response.data.tournament);
    } catch (error) {
      console.error(`Error fetching tournament ${tournamentId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get all participants of a tournament
   */
  async getParticipants(tournamentId) {
    try {
      const response = await axios.get(
        `${this.baseURL}/tournaments/${tournamentId}/participants.json`,
        {
          params: { api_key: this.apiKey }
        }
      );
      return response.data.map(p => this.formatParticipant(p.participant));
    } catch (error) {
      console.error(`Error fetching participants for ${tournamentId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get all matches of a tournament
   */
  async getMatches(tournamentId) {
    try {
      const response = await axios.get(
        `${this.baseURL}/tournaments/${tournamentId}/matches.json`,
        {
          params: { api_key: this.apiKey }
        }
      );
      return response.data.map(m => this.formatMatch(m.match));
    } catch (error) {
      console.error(`Error fetching matches for ${tournamentId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get participants of a specific group
   */
  async getGroupParticipants(tournamentId, groupId) {
    try {
      const response = await axios.get(
        `${this.baseURL}/tournaments/${tournamentId}/participants.json`,
        {
          params: { 
            api_key: this.apiKey
          }
        }
      );
      // Filter participants by group_player_ids that match the group
      const allParticipants = response.data.map(p => ({
        ...this.formatParticipant(p.participant),
        groupPlayerIds: p.participant.group_player_ids || []
      }));
      
      // For each group participant ID in matches, we need to map to actual participant
      return allParticipants;
    } catch (error) {
      console.error(`Error fetching group participants for ${tournamentId}:`, error.message);
      throw error;
    }
  }

  /**
   * Format tournament data
   */
  formatTournament(tournament) {
    return {
      id: tournament.id,
      name: tournament.name,
      url: tournament.url,
      fullUrl: tournament.full_challonge_url,
      tournamentType: tournament.tournament_type,
      hasGroupStages: tournament.has_group_stages,
      groupStagesEnabled: tournament.group_stages_enabled,
      startedAt: tournament.started_at,
      completedAt: tournament.completed_at,
      state: tournament.state,
      participantsCount: tournament.participants_count,
      gameId: tournament.game_id,
      gameName: tournament.game_name,
      description: tournament.description
    };
  }

  /**
   * Format participant data
   */
  formatParticipant(participant) {
    return {
      challongeId: participant.id,
      tournamentId: participant.tournament_id,
      name: participant.name,
      seed: participant.seed,
      finalRank: participant.final_rank,
      displayName: participant.display_name,
      groupPlayerIds: participant.group_player_ids || []
    };
  }

  /**
   * Format match data
   */
  formatMatch(match) {
    return {
      id: match.id,
      tournamentId: match.tournament_id,
      state: match.state,
      groupId: match.group_id,
      identifier: match.identifier,
      player1Id: match.player1_id,
      player2Id: match.player2_id,
      winnerId: match.winner_id,
      loserId: match.loser_id,
      scoresCsv: match.scores_csv,
      round: match.round,
      startedAt: match.started_at,
      completedAt: match.completed_at
    };
  }
}

module.exports = new ChallongeAPI();
