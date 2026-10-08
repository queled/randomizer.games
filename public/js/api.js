// API Client for Randomizer — use relative path so the frontend works when served
// through a tunnel (ngrok) or a different origin without changing this file.
const API_BASE_URL = '/api';

const API = {
  // Games
  async getGames() {
    const response = await fetch(`${API_BASE_URL}/games`);
    return response.json();
  },

  async getGame(id) {
    const response = await fetch(`${API_BASE_URL}/games/${id}`);
    return response.json();
  },

  async getGameTournaments(id) {
    const response = await fetch(`${API_BASE_URL}/games/${id}/tournaments`);
    return response.json();
  },

  // Tournaments
  async getTournaments(params = {}) {
    const queryString = new URLSearchParams(params).toString();
    const response = await fetch(`${API_BASE_URL}/tournaments?${queryString}`);
    return response.json();
  },

  async getTournament(id) {
    const response = await fetch(`${API_BASE_URL}/tournaments/${id}`);
    return response.json();
  },

  async getTournamentMatches(id) {
    const response = await fetch(`${API_BASE_URL}/tournaments/${id}/matches`);
    return response.json();
  },

  async getTournamentRaces(id) {
    const response = await fetch(`${API_BASE_URL}/tournaments/${id}/races`);
    return response.json();
  },

  // Runs/Races
  async getRaces(params = {}) {
    const queryString = new URLSearchParams(params).toString();
    const response = await fetch(`${API_BASE_URL}/runs?${queryString}`);
    return response.json();
  },

  async getRace(id) {
    const response = await fetch(`${API_BASE_URL}/runs/${id}`);
    return response.json();
  },

  // Players
  async getPlayers(params = {}) {
    const queryString = new URLSearchParams(params).toString();
    const response = await fetch(`${API_BASE_URL}/players?${queryString}`);
    return response.json();
  },

  async getPlayer(id) {
    const response = await fetch(`${API_BASE_URL}/players/${id}`);
    return response.json();
  },

  async getPlayerRaces(id) {
    const response = await fetch(`${API_BASE_URL}/players/${id}/races`);
    return response.json();
  },

  // Sync
  async syncTournament(challongeId, gameId) {
    const response = await fetch(`${API_BASE_URL}/sync/tournament/${challongeId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId })
    });
    return response.json();
  }
};

// Utility functions
function formatDate(dateString) {
  if (!dateString) return 'N/A';
  const date = new Date(dateString);
  const locale = (typeof window.i18n !== 'undefined' && window.i18n.getLanguage) ? window.i18n.getLanguage() : 'en';
  const options = { year: 'numeric', month: 'long', day: 'numeric' };
  return date.toLocaleDateString(locale, options);
}

function formatTime(seconds) {
  if (!seconds) return 'N/A';
  
  // Parse time string like "PT1H23M45S" or seconds
  if (typeof seconds === 'string') {
    return seconds.replace('PT', '').toLowerCase();
  }
  
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Mirrors calculateTournamentStatus() in helpers/tournament-status.js: keep both in sync.
function getTournamentStatus(tournament) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  // Finished one year after its start, whatever its state.
  const MAX_DURATION_MS = 365 * DAY_MS;
  // How long an 'active' tournament stays 'en cours' after its planned end date.
  const OVERTIME_GRACE_MS = 60 * DAY_MS;
  const FINISHED_STATES = ['complete', 'completed', 'awaiting_review'];
  const RUNNING_STATES = ['active', 'underway', 'in_progress'];

  const parseDate = (value) => {
    if (!value) return null;
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d.getTime();
  };

  const now = Date.now();
  const start = parseDate(tournament && tournament.startDate);
  const end = parseDate(tournament && tournament.endDate);
  const state = String((tournament && tournament.state) || '').toLowerCase();

  if (FINISHED_STATES.includes(state) || FINISHED_STATES.includes(tournament && tournament.status)) return 'terminé';
  if (start && now - start >= MAX_DURATION_MS) return 'terminé';
  if (start && now < start) return 'à venir';

  if (end && now > end) {
    // Running late: still in progress while matches are scheduled, or for a while if the platform says so.
    const schedule = tournament && tournament.midosHouse && tournament.midosHouse.schedule;
    if (Array.isArray(schedule) && schedule.some((s) => (parseDate(s && s.startAt) || 0) > now)) return 'en cours';
    if (RUNNING_STATES.includes(state) && now - end < OVERTIME_GRACE_MS) return 'en cours';
    return 'terminé';
  }

  return start ? 'en cours' : 'à venir';
}

// Find tournament winner from matches if finalRank is not set
async function findTournamentWinner(tournamentId, tournamentData) {
  // First check if we have a winner with finalRank set
  if (tournamentData && tournamentData.participants && tournamentData.participants.length > 0) {
    const winner = tournamentData.participants.find(p => p.finalRank != null && p.finalRank === 1);
    if (winner) {
      return winner.displayName || winner.name || null;
    }
  }

  // If no finalRank winner, fetch matches and find the winner of the final match
  try {
    const matchesResponse = await fetch(`${API_BASE_URL}/tournaments/${tournamentId}/matches`);
    if (!matchesResponse.ok) return null;
    const matchesData = await matchesResponse.json();
    const matches = matchesData.matches || [];
    
    if (!matches.length) return null;
    
    // Find the match with the highest round number (the final)
    let maxRound = -Infinity;
    let finalMatch = null;
    
    for (const match of matches) {
      if (match.round != null && match.round > maxRound) {
        maxRound = match.round;
        finalMatch = match;
      }
    }
    
    if (!finalMatch || !finalMatch.winnerId) return null;
    
    // Find the winner player name in the tournament participants or match data
    if (finalMatch.player1Id === finalMatch.winnerId && finalMatch.player1Name) {
      return finalMatch.player1Name;
    } else if (finalMatch.player2Id === finalMatch.winnerId && finalMatch.player2Name) {
      return finalMatch.player2Name;
    }
    
    // Try to find in participants by challongeId
    if (tournamentData && tournamentData.participants) {
      const winner = tournamentData.participants.find(p => p.challongeId === finalMatch.winnerId);
      if (winner) {
        return winner.displayName || winner.name || null;
      }
    }
    
    return null;
  } catch (e) {
    console.warn('Could not determine tournament winner from matches:', e);
    return null;
  }
}
