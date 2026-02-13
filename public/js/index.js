// Homepage logic
let gamesById = {};
const playersCache = {};

// Parse ISO 8601 duration (PT1H23M45S) to milliseconds
function parseISODuration(str) {
  if (!str) return null;
  const cleaned = String(str).replace(/^P(?:\d+D)?T/, 'PT');
  const re = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/;
  const m = re.exec(cleaned);
  if (!m) return null;
  const h = parseInt(m[1] || 0, 10);
  const min = parseInt(m[2] || 0, 10);
  const s = parseFloat(m[3] || 0);
  return Math.round(((h * 3600) + (min * 60) + s) * 1000);
}

// Parse various time formats to milliseconds
function parseTimeToMs(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  const s = String(value).trim();
  if (!s) return null;
  // ISO duration
  if (s.startsWith('PT') || s.startsWith('P')) return parseISODuration(s);
  // HH:MM:SS or MM:SS
  if (s.includes(':')) {
    const parts = s.split(':').map(p => parseFloat(p));
    if (parts.length === 3) return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
    if (parts.length === 2) return Math.round((parts[0] * 60 + parts[1]) * 1000);
  }
  // Plain number (assume seconds if < 10000, otherwise ms)
  const num = Number(s);
  if (!Number.isNaN(num)) {
    if (num > 10000) return Math.round(num);
    return Math.round(num * 1000);
  }
  return null;
}

// Format milliseconds to H:MM:SS or M:SS
function formatMs(ms) {
  if (ms == null) return 'N/A';
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

// Get last match completion date from tournament (prefer race end times)
async function getLastMatchDate(tournamentId) {
  try {
    const matchesResponse = await fetch(`/api/tournaments/${tournamentId}/matches`);
    if (!matchesResponse.ok) return null;
    const matchesData = await matchesResponse.json();
    const matches = matchesData.matches || [];
    if (matches.length === 0) return null;
    
    // Load races for this tournament
    let races = [];
    try {
      const racesRes = await fetch(`/api/tournaments/${tournamentId}/races`);
      if (racesRes.ok) {
        const racesJson = await racesRes.json();
        races = racesJson.races || [];
      }
    } catch (e) {
      // ignore
    }
    
    // Build quick lookup for races
    const byMatchId = new Map();
    const byUrl = new Map();
    const normalizeUrl = (u) => (u || '').toString().replace(/^\/+/, '').toLowerCase();
    races.forEach(r => {
      if (r.matchId) byMatchId.set(String(r.matchId), r);
      const ru = normalizeUrl(r.url);
      if (ru) byUrl.set(ru, r);
    });
    
    let lastTimestamp = 0;
    let lastDate = null;
    
    matches.forEach(match => {
      let candidate = null;
      
      // Prefer race endedAt if race exists
      let race = null;
      const mid = match._id || match.id || null;
      if (mid && byMatchId.has(String(mid))) race = byMatchId.get(String(mid));
      if (!race && match.raceUrl) {
        const mu = normalizeUrl(match.raceUrl);
        race = byUrl.get(mu);
        if (!race) {
          const slug = mu.split('/').filter(Boolean).pop();
          for (const [ru, r] of byUrl.entries()) {
            if (ru.endsWith(slug)) { race = r; break; }
          }
        }
      }
      
      if (race) {
        candidate = race.endedAt || null;
        if (!candidate && race.entrants) {
          let maxFin = 0;
          race.entrants.forEach(e => {
            if (e && e.finishedAt) {
              const t = new Date(e.finishedAt).getTime();
              if (t > maxFin) maxFin = t;
            }
          });
          if (maxFin) candidate = new Date(maxFin).toISOString();
        }
      }
      
      if (!candidate) candidate = match.completedAt || match.startedAt || null;
      
      if (candidate) {
        const ts = new Date(candidate).getTime();
        if (ts > lastTimestamp) {
          lastTimestamp = ts;
          lastDate = candidate;
        }
      }
    });
    
    return lastDate;
  } catch (e) {
    console.error('Error fetching last match date:', e);
    return null;
  }
}

// Resolve a friendly game/category name
function resolveGameForCategory(cat) {
  if (!cat) return null;
  if (gamesById[cat]) return gamesById[cat];
  for (const id in gamesById) {
    if (cat === id) return gamesById[id];
  }
  for (const id in gamesById) {
    if (cat.startsWith(id) || cat.indexOf(id) !== -1) return gamesById[id];
  }
  if (cat.endsWith('r')) {
    const alt = cat.slice(0, -1);
    if (gamesById[alt]) return gamesById[alt];
  }
  return null;
}

function resolveGameForTournament(tournament) {
  const candidates = [
    tournament?.gameId,
    (tournament?.game && typeof tournament.game === 'string') ? tournament.game : null,
    (tournament?.game && typeof tournament.game === 'object') ? tournament.game.id : null
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = resolveGameForCategory(String(candidate).toLowerCase());
    if (resolved) return resolved;
  }

  const gameName = (tournament?.gameName || '').toLowerCase();
  if (!gameName) return null;

  for (const id in gamesById) {
    const g = gamesById[id];
    const names = [
      g?.name,
      g?.officialName,
      g?.official?.name,
      g?.randomizer?.displayName,
      g?.randomizer?.shortName
    ].filter(Boolean).map(n => String(n).toLowerCase());

    if (names.some(n => gameName.includes(n) || n.includes(gameName))) {
      return g;
    }
  }

  return null;
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const gamesResp = await API.getGames();
    const games = gamesResp.games || [];
    gamesById = games.reduce((acc, g) => { acc[g.id] = g; return acc; }, {});
  } catch (e) {
    console.warn('Could not load games list for name mapping', e);
    gamesById = {};
  }

  await Promise.all([
    loadRecentRaces(),
    loadRecentTournaments()
  ]);
});

async function loadRecentRaces() {
  try {
    const data = await API.getRaces({ limit: 10 });
    const container = document.getElementById('recent-races');
    container.innerHTML = '';

    if (!data.races || data.races.length === 0) {
      container.innerHTML = '<p style="color:#9ca3af;text-align:center;">No races found</p>';
      return;
    }

    data.races.forEach(race => {
      const card = createRaceCard(race);
      container.appendChild(card);
    });
  } catch (error) {
    console.error('Error loading races:', error);
    const errText = (typeof i18n !== 'undefined' && typeof i18n.t === 'function') ? i18n.t('common.error') : 'Loading error';
    document.getElementById('recent-races').innerHTML = `<p style="color:#ef4444;text-align:center;">${errText}</p>`;
  }
}

async function loadRecentTournaments() {
  try {
    const data = await API.getTournaments({ limit: 10 });
    const container = document.getElementById('recent-tournaments');
    container.innerHTML = '';

    if (!data.tournaments || data.tournaments.length === 0) {
      container.innerHTML = '<p style="color:#9ca3af;text-align:center;">No tournaments found</p>';
      return;
    }

    // Enrich tournaments with winners and last match date
    const enrichedTournaments = await Promise.all(data.tournaments.map(async (t) => {
      if ((!t.participants || t.participants.every(p => p.finalRank == null)) && !t.winner) {
        t._computedWinner = await findTournamentWinner(t._id || t.id, t);
      }
      // Fetch last match date for finished tournaments
      const status = getTournamentStatusFromState(t);
      if (status === 'terminé') {
        const lastMatchDate = await getLastMatchDate(t._id || t.id);
        if (lastMatchDate) t._lastMatchDate = lastMatchDate;
      }
      return t;
    }));

    function getTournamentStatusFromState(t) {
      if (!t.startDate) return 'à venir';
      const now = Date.now();
      const start = new Date(t.startDate).getTime();
      const end = t.endDate ? new Date(t.endDate).getTime() : null;
      const oneYear = 365 * 24 * 60 * 60 * 1000;
      if (t.state === 'complete' || t.state === 'awaiting_review') return 'terminé';
      if (end && now > end) return 'terminé';
      if (!end && now - start > oneYear) return 'terminé';
      if (now >= start && (!end || now <= end)) return 'en cours';
      return 'à venir';
    }

    enrichedTournaments.forEach(tournament => {
      const card = createTournamentCard(tournament);
      container.appendChild(card);
    });
  } catch (error) {
    console.error('Error loading tournaments:', error);
    const errText = (typeof i18n !== 'undefined' && typeof i18n.t === 'function') ? i18n.t('common.error') : 'Loading error';
    document.getElementById('recent-tournaments').innerHTML = `<p style="color:#ef4444;text-align:center;">${errText}</p>`;
  }
}

function createRaceCard(race) {
  const card = document.createElement('div');
  card.style.cssText = 'background:#1f2937;padding:1rem;border-radius:0.5rem;cursor:pointer;transition:background 0.2s;min-height:140px;display:flex;flex-direction:column;';
  card.onmouseenter = () => card.style.background = '#374151';
  card.onmouseleave = () => card.style.background = '#1f2937';

  const statusColors = {
    'open': '#3b82f6',
    'invitational': '#8b5cf6',
    'in_progress': '#10b981',
    'finished': '#6b7280',
    'cancelled': '#ef4444'
  };
  const statusColor = statusColors[race.status] || '#6b7280';
  const statusText = race.status === 'in_progress' ? (typeof i18n !== 'undefined' ? i18n.t('status.race.inProgress') : 'In Progress') : 
                     race.status === 'open' ? (typeof i18n !== 'undefined' ? i18n.t('status.race.open') : 'Open') :
                     race.status === 'finished' ? (typeof i18n !== 'undefined' ? i18n.t('status.race.finished') : 'Finished') : race.status;

  const locale = (typeof window.i18n !== 'undefined' && window.i18n.getLanguage) ? window.i18n.getLanguage() : 'en';
  const startTime = race.startedAt ? new Date(race.startedAt).toLocaleString(locale, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  }) : '';

  const endTime = (race.status === 'finished' && race.endedAt) ? new Date(race.endedAt).toLocaleString(locale, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  }) : '';

  const totalEntrants = race.entrants?.length || 0;
  
  const resolved = resolveGameForCategory(race.category);
  const friendlyGameName = (resolved && (resolved.officialName || resolved.name)) || race.category || 'N/A';

  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:0.5rem;">
      <div style="flex:1;">
        <div style="color:#fbbf24;font-weight:600;font-size:0.95rem;margin-bottom:0.25rem;">${friendlyGameName}</div>
        <div style="color:#d1d5db;font-size:0.85rem;">${race.goal || race.name || 'Sans objectif'}</div>
      </div>
      <span style="background:${statusColor};color:white;padding:0.25rem 0.5rem;border-radius:0.25rem;font-size:0.75rem;white-space:nowrap;">${statusText}</span>
    </div>
    <div style="flex:1;"></div>
    <div style="display:flex;justify-content:space-between;align-items:flex-end;font-size:0.75rem;color:#6b7280;margin-top:0.5rem;">
      <div>
        <div>📅 ${typeof i18n !== 'undefined' ? i18n.t('home.startDate') : 'Start'}: ${startTime}</div>
        ${endTime ? `<div>🏁 ${typeof i18n !== 'undefined' ? i18n.t('home.endDate') : 'Fin'}: ${endTime}</div>` : ''}
      </div>
      <span style="align-self:flex-end;">👥 ${totalEntrants} ${typeof i18n !== 'undefined' ? i18n.t('home.participants') : 'participants'}</span>
    </div>
  `;

  card.addEventListener('click', () => {
    if (race._id) {
      window.location.href = `/race-detail.html?id=${encodeURIComponent(race._id)}`;
    } else if (race.url) {
      window.open('https://racetime.gg' + race.url, '_blank');
    }
  });

  return card;
}

function createTournamentCard(tournament) {
  const card = document.createElement('div');
  card.style.cssText = 'background:#1f2937;padding:1rem;border-radius:0.5rem;cursor:pointer;transition:background 0.2s;min-height:140px;display:flex;flex-direction:column;';
  card.onmouseenter = () => card.style.background = '#374151';
  card.onmouseleave = () => card.style.background = '#1f2937';
  
  // Calculate status using the same logic as other pages
  function getTournamentStatusFromState(t) {
    if (!t.startDate) return 'à venir';
    const now = Date.now();
    const start = new Date(t.startDate).getTime();
    const end = t.endDate ? new Date(t.endDate).getTime() : null;
    const oneYear = 365 * 24 * 60 * 60 * 1000;
    
    // If status is explicitly complete or awaiting_review, it's finished
    if (t.state === 'complete' || t.state === 'awaiting_review') return 'terminé';
    
    // If explicit end date and we're past it
    if (end && now > end) return 'terminé';
    
    // If no end date but started more than 1 year ago, consider it finished
    if (!end && now - start > oneYear) return 'terminé';
    
    if (now >= start && (!end || now <= end)) return 'en cours';
    return 'à venir';
  }
  
  const status = getTournamentStatusFromState(tournament);
  const statusColors = {
    'à venir': '#3b82f6',
    'en cours': '#10b981',
    'terminé': '#6b7280'
  };
  const statusTexts = {
    'à venir': typeof i18n !== 'undefined' ? i18n.t('status.tournament.upcoming') : 'Upcoming',
    'en cours': typeof i18n !== 'undefined' ? i18n.t('status.tournament.inProgress') : 'In Progress',
    'terminé': typeof i18n !== 'undefined' ? i18n.t('status.tournament.finished') : 'Finished'
  };
  const statusColor = statusColors[status] || '#6b7280';
  const statusText = statusTexts[status] || status;

  const locale = (typeof window.i18n !== 'undefined' && window.i18n.getLanguage) ? window.i18n.getLanguage() : 'en';
  const startDate = tournament.startDate ? new Date(tournament.startDate).toLocaleDateString(locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }) : 'Unknown date';

  // Use last match date instead of Challonge end date
  let endDate = '';
  if (status === 'terminé') {
    // Check if we already have lastMatchDate from enrichment
    const dateToUse = tournament._lastMatchDate || tournament.completedAt || tournament.updatedAt;
    if (dateToUse) {
      endDate = new Date(dateToUse).toLocaleDateString(locale, {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
      });
    }
  }

  // Resolve game name
  const resolved = resolveGameForTournament(tournament);
  const friendlyGameName = (resolved && (resolved.officialName || resolved.name)) || tournament.gameName || 'Unknown game';

  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:0.5rem;">
      <h3 style="color:#fbbf24;font-weight:600;font-size:0.95rem;flex:1;">${tournament.name}</h3>
      <span style="background:${statusColor};color:white;padding:0.25rem 0.5rem;border-radius:0.25rem;font-size:0.75rem;margin-left:0.5rem;white-space:nowrap;">${statusText}</span>
    </div>
    <p style="color:#9ca3af;font-size:0.85rem;margin-bottom:0.5rem;">${friendlyGameName}</p>
    <div style="flex:1;"></div>
    <div style="display:flex;justify-content:space-between;align-items:flex-end;font-size:0.75rem;color:#6b7280;">
      <div>
        <div>📅 ${typeof i18n !== 'undefined' ? i18n.t('home.startDate') : 'Start'}: ${startDate}</div>
        ${endDate ? `<div>🏁 ${typeof i18n !== 'undefined' ? i18n.t('home.endDate') : 'Fin'}: ${endDate}</div>` : ''}
      </div>
      <span style="align-self:flex-end;">👥 ${tournament.participantsCount || 0} ${typeof i18n !== 'undefined' ? i18n.t('home.participants') : 'participants'}</span>
    </div>
  `;

  card.addEventListener('click', () => {
    window.location.href = `/tournament-detail.html?id=${tournament._id}`;
  });

  return card;
}
