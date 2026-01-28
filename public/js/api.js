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

function getTournamentStatus(tournament) {
  const today = new Date();

  const parseDate = (value) => {
    if (!value) return null;
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  };

  const startDate = parseDate(tournament && tournament.startDate);
  const endDate = parseDate(tournament && tournament.endDate);

  // If status is explicitly complete or awaiting_review, it's finished
  if (tournament && (tournament.status === 'complete' || tournament.status === 'awaiting_review')) return 'terminé';

  // Règle métier: on considère un tournoi terminé au bout d'1 an.
  const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
  if (startDate && (today.getTime() - startDate.getTime()) >= YEAR_MS) return 'terminé';
  
  // If explicit end date and we're past it
  if (endDate && today > endDate) return 'terminé';

  if (startDate && today < startDate) return 'à venir';
  if (startDate && endDate && today >= startDate && today <= endDate) return 'en cours';
  if (startDate && !endDate && today >= startDate) return 'en cours';
  return 'terminé';
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
