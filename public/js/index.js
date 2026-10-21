// Homepage logic
let gamesById = {};
let gamesBySlug = {};
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
    // Load matches and races together rather than one after the other
    const racesPromise = fetch(`/api/tournaments/${tournamentId}/races`)
      .then(res => (res.ok ? res.json() : {}))
      .then(json => json.races || [])
      .catch(() => []);

    const matchesResponse = await fetch(`/api/tournaments/${tournamentId}/matches`);
    if (!matchesResponse.ok) return null;
    const matchesData = await matchesResponse.json();
    const matches = matchesData.matches || [];
    if (matches.length === 0) return null;

    const races = await racesPromise;
    
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
function getGameDisplayName(game) {
  return gameLabel(game);
}

function resolveGameForCategory(cat) {
  if (!cat) return null;
  const normalized = String(cat).toLowerCase().trim();

  if (gamesBySlug[normalized]) return gamesBySlug[normalized];
  if (gamesById[normalized]) return gamesById[normalized];

  if (normalized.endsWith('r')) {
    const alt = normalized.slice(0, -1);
    if (gamesById[alt]) return gamesById[alt];
  }

  for (const id in gamesById) {
    if (normalized.startsWith(id) || normalized.includes(id)) return gamesById[id];
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
  // Start every request now; cards are rendered once the games list is in
  const racesRequest = API.getRaces({ limit: 10 });
  const tournamentsRequest = API.getTournaments({ limit: 10 });
  const gamesRequest = API.getGames();
  racesRequest.catch(() => {});
  tournamentsRequest.catch(() => {});
  gamesRequest.catch(() => {});

  // Introduction banner counters reuse the requests above (their pagination holds the totals)
  if (setupHero()) {
    loadHeroStats(racesRequest, tournamentsRequest, gamesRequest).catch(() => {});
  }
  loadHomeLive();

  try {
    const gamesResp = await gamesRequest;
    const games = gamesResp.games || [];
    gamesById = {};
    gamesBySlug = {};

    games.forEach(g => {
      const gameId = String(g.id || '').toLowerCase().trim();
      if (gameId) {
        gamesById[gameId] = g;
        gamesById[`${gameId}r`] = g;
      }

      const primarySlug = String(g?.integrations?.racetime?.gameSlug || '').toLowerCase().trim();
      if (primarySlug) {
        gamesBySlug[primarySlug] = g;
      }

      const extraSlugs = Array.isArray(g?.integrations?.racetime?.gameSlugs)
        ? g.integrations.racetime.gameSlugs
        : [];
      extraSlugs.forEach(slug => {
        const normalizedSlug = String(slug || '').toLowerCase().trim();
        if (normalizedSlug) gamesBySlug[normalizedSlug] = g;
      });
    });
  } catch (e) {
    console.warn('Could not load games list for name mapping', e);
    gamesById = {};
    gamesBySlug = {};
  }

  await Promise.all([
    loadRecentRaces(racesRequest),
    loadRecentTournaments(tournamentsRequest)
  ]);
});

// ---------------------------------------------------------------------------
// Introduction banner and live streams, for visitors discovering the site
// ---------------------------------------------------------------------------

const HERO_HIDDEN_KEY = 'homeHeroHidden';

function homeT(key, fallback) {
  return (window.i18n && typeof window.i18n.t === 'function') ? window.i18n.t(key, {}, fallback) : fallback;
}

function formatHomeCount(n) {
  const locale = (window.i18n && window.i18n.getLanguage) ? window.i18n.getLanguage() : undefined;
  return Number(n).toLocaleString(locale);
}

// The banner stays closed for a visitor who hid it (storage may be unavailable: then it just shows)
function setupHero() {
  const hero = document.getElementById('home-hero');
  const close = document.getElementById('home-hero-close');
  if (!hero) return false;
  let hidden = false;
  try { hidden = localStorage.getItem(HERO_HIDDEN_KEY) === '1'; } catch (e) { /* ignore */ }
  if (hidden) {
    hero.remove();
    return false;
  }
  close?.addEventListener('click', () => {
    hero.remove();
    try { localStorage.setItem(HERO_HIDDEN_KEY, '1'); } catch (e) { /* ignore */ }
  });
  const label = () => close?.setAttribute('aria-label', homeT('home.heroClose', 'Hide this introduction'));
  label();
  window.addEventListener('languageChanged', label);
  return true;
}

async function loadHeroStats(racesRequest, tournamentsRequest, gamesRequest) {
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el && Number.isFinite(value)) el.textContent = formatHomeCount(value);
  };
  const total = (data) => data?.pagination?.total ?? data?.total;
  const [games, races, tournaments, players] = await Promise.allSettled([
    gamesRequest,
    racesRequest,
    tournamentsRequest,
    fetch('/api/players/count').then(r => (r.ok ? r.json() : null))
  ]);
  if (games.status === 'fulfilled') set('hero-stat-games', (games.value?.games || []).length);
  if (races.status === 'fulfilled') set('hero-stat-races', total(races.value));
  if (tournaments.status === 'fulfilled') set('hero-stat-tournaments', total(tournaments.value));
  if (players.status === 'fulfilled') set('hero-stat-players', total(players.value));
}

// The four most watched randomizer streams; the section stays hidden without any
async function loadHomeLive() {
  const section = document.getElementById('home-live');
  const grid = document.getElementById('home-live-grid');
  if (!section || !grid) return;
  try {
    const res = await fetch('/api/streams?limit=4');
    if (!res.ok) return;
    const data = await res.json();
    const streams = (data.streams || []).slice(0, 4);
    if (!streams.length) return;
    renderHomeLive(streams);
    section.hidden = false;
    // Badge and viewer counts follow the translations when they arrive later
    window.addEventListener('languageChanged', () => renderHomeLive(streams));
  } catch (e) {
    console.warn('Live streams unavailable on the home page:', e);
  }
}

function renderHomeLive(streams) {
  const grid = document.getElementById('home-live-grid');
  if (!grid) return;

  const fallback = "data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27320%27 height=%27180%27%3E%3Crect fill=%27%23374151%27 width=%27320%27 height=%27180%27/%3E%3Ctext x=%2750%25%27 y=%2750%25%27 font-size=%2740%27 fill=%27%236b7280%27 text-anchor=%27middle%27 dy=%27.3em%27%3E📺%3C/text%3E%3C/svg%3E";
  grid.innerHTML = streams.map(stream => {
    const login = String(stream.userLogin || '').replace(/[^a-zA-Z0-9_]/g, '');
    if (!login) return '';
    const thumb = stream.thumbnailUrl ? `/api/proxy-image?url=${encodeURIComponent(stream.thumbnailUrl)}` : fallback;
    // The server gives the site's game id of each stream
    const gameId = stream.gameId && stream.gameId !== 'unknown' ? stream.gameId : '';
    return `
      <a class="stream-card" href="https://twitch.tv/${login}" target="_blank" rel="noopener noreferrer">
        <div class="stream-thumbnail">
          <img src="${escHtml(thumb)}" alt="${escHtml(stream.title || '')}" loading="lazy" data-fallback-src="${fallback}">
          <span class="stream-live-badge">${escHtml(homeT('streams.live', 'LIVE'))}</span>
          ${stream.viewerCount ? `<span class="stream-viewers">👁 ${escHtml(new Intl.NumberFormat((window.i18n && window.i18n.getLanguage) ? window.i18n.getLanguage() : undefined, { notation: 'compact' }).format(stream.viewerCount))}</span>` : ''}
        </div>
        <div class="stream-info">
          <div class="stream-title">${escHtml(stream.title || '')}</div>
          <div class="stream-channel">${escHtml(stream.userName || login)}</div>
          ${stream.gameName ? `<div class="stream-game">🎮 ${gameId
            ? `<span class="game-link" data-game-id="${escHtml(gameId)}">${escHtml(stream.gameName)}</span>`
            : escHtml(stream.gameName)}</div>` : ''}
        </div>
      </a>`;
  }).join('');

  // The game name leads to its page instead of the stream (like on the live page)
  if (!grid.dataset.gameLinks) {
    grid.dataset.gameLinks = '1';
    grid.addEventListener('click', e => {
      const link = e.target.closest('.game-link');
      if (!link) return;
      e.preventDefault();
      e.stopPropagation();
      window.location.href = '/game-detail.html?id=' + encodeURIComponent(link.dataset.gameId);
    });
  }
}

async function loadRecentRaces(request) {
  try {
    const data = await request;
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
    document.getElementById('recent-races').innerHTML = `<p style="color:#ef4444;text-align:center;">${escHtml(errText)}</p>`;
  }
}

async function loadRecentTournaments(request) {
  try {
    const data = await request;
    const container = document.getElementById('recent-tournaments');
    container.innerHTML = '';

    if (!data.tournaments || data.tournaments.length === 0) {
      container.innerHTML = '<p style="color:#9ca3af;text-align:center;">No tournaments found</p>';
      return;
    }

    // Enrich finished tournaments with their last match date
    const enrichedTournaments = await Promise.all(data.tournaments.map(async (t) => {
      const isFinished = getTournamentStatusFromState(t) === 'terminé';
      const lastMatchDate = isFinished ? await getLastMatchDate(t._id || t.id) : null;
      if (lastMatchDate) t._lastMatchDate = lastMatchDate;
      return t;
    }));

    function getTournamentStatusFromState(t) {
      return getTournamentStatus(t);
    }

    enrichedTournaments.forEach(tournament => {
      const card = createTournamentCard(tournament);
      container.appendChild(card);
    });
  } catch (error) {
    console.error('Error loading tournaments:', error);
    const errText = (typeof i18n !== 'undefined' && typeof i18n.t === 'function') ? i18n.t('common.error') : 'Loading error';
    document.getElementById('recent-tournaments').innerHTML = `<p style="color:#ef4444;text-align:center;">${escHtml(errText)}</p>`;
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
  const friendlyGameName = getGameDisplayName(resolved) || race.category || 'N/A';

  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:0.5rem;">
      <div style="flex:1;">
        <div style="color:#fbbf24;font-weight:600;font-size:0.95rem;margin-bottom:0.25rem;">${escHtml(friendlyGameName)}</div>
        <div style="color:#d1d5db;font-size:0.85rem;">${escHtml(race.goal || race.name || 'Sans objectif')}</div>
      </div>
      <span style="background:${statusColor};color:white;padding:0.25rem 0.5rem;border-radius:0.25rem;font-size:0.75rem;white-space:nowrap;">${escHtml(statusText)}</span>
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
    } else if (/^\/?srl\/\d+$/i.test(String(race.url || '').trim())) {
      // Races imported from SpeedRunsLive are stored as /srl/<raceId>
      const raceId = String(race.url).trim().split('/').pop();
      window.open('https://www.speedrunslive.com/races/result/' + raceId, '_blank');
    } else if (race.url) {
      let path = String(race.url || '').trim();
      if (/^https?:\/\//i.test(path)) {
        try {
          path = new URL(path).pathname || '';
        } catch (e) {
          path = path.replace(/^https?:\/\/(www\.)?racetime\.gg/i, '');
        }
      }
      path = '/' + path.replace(/^\/+/, '');
      const parts = path.split('/').filter(Boolean);
      if (parts.length >= 3 && parts[0] === parts[1]) parts.splice(1, 1);
      window.open('https://racetime.gg/' + parts.join('/'), '_blank');
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
    return getTournamentStatus(t);
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
  const friendlyGameName = getGameDisplayName(resolved) || tournament.gameName || 'Unknown game';

  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:0.5rem;">
      <h3 style="color:#fbbf24;font-weight:600;font-size:0.95rem;flex:1;">${escHtml(tournament.name)}</h3>
      <span style="background:${statusColor};color:white;padding:0.25rem 0.5rem;border-radius:0.25rem;font-size:0.75rem;margin-left:0.5rem;white-space:nowrap;">${escHtml(statusText)}</span>
    </div>
    <p style="color:#9ca3af;font-size:0.85rem;margin-bottom:0.5rem;">${escHtml(friendlyGameName)}</p>
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
