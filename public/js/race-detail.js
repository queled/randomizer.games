(function(){
  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[m]));
  }

  function sanitizeExternalUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';

    try {
      const parsed = new URL(raw, window.location.origin);
      if (!/^https?:$/i.test(parsed.protocol)) return '';
      return parsed.href;
    } catch {
      return '';
    }
  }

  function formatInfoHtml(text) {
    return String(text || '')
      .split('\n')
      .map((line) => {
        const escapedLine = escapeHtml(line);
        return escapedLine.replace(/(https?:\/\/[^\s<]+)/g, (match) => {
          const safeUrl = sanitizeExternalUrl(match);
          const label = escapeHtml(match);
          return safeUrl
            ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" style="color:#60a5fa;word-break:break-word;">${label}</a>`
            : label;
        });
      })
      .join('<br>');
  }

  function qs(name){
    const m = location.search.match(new RegExp('[?&]'+name+'=([^&]+)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  const raceId = qs('id');
  const raceUrl = qs('url');
  
  const gameEl = document.getElementById('race-game');
  const goalEl = document.getElementById('race-goal');
  const statusEl = document.getElementById('race-status');
  const infoEl = document.getElementById('race-info');
  const startEl = document.getElementById('race-start');
  const endEl = document.getElementById('race-end');
  const durationEl = document.getElementById('race-duration');
  const entrantsCountEl = document.getElementById('race-entrants-count');
  const linksEl = document.getElementById('race-links');
  const tournamentLinkDiv = document.getElementById('tournament-link');
  const tournamentNameEl = document.getElementById('tournament-name');
  const participantsEl = document.getElementById('participants-list');

  // Title element for participants/standings toggling
  const participantsTitleEl = document.getElementById('participants-title');

  // Global variables for re-rendering on spoiler mode change
  let currentEntrants = [];
  let currentRace = null;
  let gamesById = {};
  let gamesBySlug = {};

  // Event listener for spoiler mode changes
  window.addEventListener('spoilerModeChanged', function(e) {
    updateParticipantsTitle();
    renderParticipants(currentEntrants);
    refreshDateTimeFields();
  });

  function isSpoilerModeEnabled() {
    if (typeof window.isSpoilerModeEnabled === 'function') {
      return window.isSpoilerModeEnabled();
    }
    return sessionStorage.getItem('spoilerModeEnabled') === 'true';
  }

  function updateParticipantsTitle() {
    if (!participantsTitleEl) return;
    const spoilerMode = sessionStorage.getItem('spoilerModeEnabled') === 'true';
    participantsTitleEl.textContent = spoilerMode ? '👥 Participants' : '🏅 Classement';
  }

  // Game slug to display name mapping
  const gameDisplayNames = {
    'oot': 'Ocarina of Time Randomizer',
    'ootr': 'Ocarina of Time Randomizer',
    'alttp': 'A Link to the Past Randomizer',
    'alttpr': 'A Link to the Past Randomizer',
    'alttpr-ladder': 'A Link to the Past Randomizer',
    'mm': 'Majora\'s Mask Randomizer',
    'mmr': 'Majora\'s Mask Randomizer',
    'sm': 'Super Metroid Randomizer',
    'smr': 'Super Metroid Randomizer',
    'sm64': 'Super Mario 64 Randomizer',
    'dk64': 'Donkey Kong 64 Randomizer',
    'dk64r': 'Donkey Kong 64 Randomizer',
    'tww': 'The Wind Waker Randomizer',
    'tp': 'Twilight Princess Randomizer',
    'kh2fm': 'Kingdom Hearts 2 FM Randomizer',
    'kh2r': 'Kingdom Hearts 2 FM Randomizer',
    'kh2fmr': 'Kingdom Hearts 2 FM Randomizer',
    'sotn': 'Symphony of the Night Randomizer',
    'smz3': 'SMZ3 Combo Randomizer',
    'ootmm': 'OoT+MM Combo Randomizer'
  };

  function resolveGameLabel(game) {
    return game?.official?.name
      || game?.name
      || game?.randomizer?.displayName
      || game?.randomizer?.shortName
      || game?.id
      || null;
  }

  function getGameDisplayName(slug) {
    if (!slug) return 'Race';
    const lowerSlug = String(slug).toLowerCase().trim();

    if (gamesBySlug[lowerSlug]) {
      return resolveGameLabel(gamesBySlug[lowerSlug]) || slug;
    }

    if (gamesById[lowerSlug]) {
      return resolveGameLabel(gamesById[lowerSlug]) || slug;
    }

    if (lowerSlug.endsWith('r')) {
      const alt = lowerSlug.slice(0, -1);
      if (gamesById[alt]) {
        return resolveGameLabel(gamesById[alt]) || slug;
      }
    }

    return gameDisplayNames[lowerSlug] || slug;
  }

  async function loadGames() {
    try {
      const gamesData = await fetchJson('/api/games');
      const games = gamesData.games || [];

      gamesById = {};
      gamesBySlug = {};

      games.forEach(game => {
        const gameId = String(game.id || '').toLowerCase().trim();
        if (gameId) {
          gamesById[gameId] = game;
          gamesById[`${gameId}r`] = game;
        }

        const primarySlug = String(game?.integrations?.racetime?.gameSlug || '').toLowerCase().trim();
        if (primarySlug) {
          gamesBySlug[primarySlug] = game;
        }

        const extraSlugs = Array.isArray(game?.integrations?.racetime?.gameSlugs)
          ? game.integrations.racetime.gameSlugs
          : [];

        extraSlugs.forEach(slug => {
          const normalizedSlug = String(slug || '').toLowerCase().trim();
          if (normalizedSlug) gamesBySlug[normalizedSlug] = game;
        });
      });
    } catch (e) {
      gamesById = {};
      gamesBySlug = {};
    }
  }

  // Parse ISO 8601 duration to milliseconds
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

  function parseTimeToMs(value) {
    if (value == null) return null;
    if (typeof value === 'number') return value;
    const s = String(value).trim();
    if (!s) return null;
    if (s.startsWith('PT') || s.startsWith('P')) return parseISODuration(s);
    if (s.includes(':')) {
      const parts = s.split(':').map(p => parseFloat(p));
      if (parts.length === 3) return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
      if (parts.length === 2) return Math.round((parts[0] * 60 + parts[1]) * 1000);
    }
    const num = Number(s);
    if (!Number.isNaN(num)) {
      if (num > 10000) return Math.round(num);
      return Math.round(num * 1000);
    }
    return null;
  }

  function formatMs(ms) {
    if (ms == null) return '-';
    const totalSeconds = Math.round(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
  }

  function formatDateTime(d) {
    if (!d) return '-';
    let locale = 'en';
    if (typeof i18n !== 'undefined' && typeof i18n.getLanguage === 'function') {
      locale = i18n.getLanguage() || 'en';
    }
    return new Date(d).toLocaleString(locale, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function refreshDateTimeFields() {
    if (!currentRace) return;

    const spoilerMode = isSpoilerModeEnabled();

    startEl.textContent = formatDateTime(currentRace.startedAt);
    endEl.textContent = spoilerMode ? '-' : formatDateTime(currentRace.endedAt);
    durationEl.textContent = spoilerMode ? '-' : formatDuration(currentRace.startedAt, currentRace.endedAt);
  }

  window.addEventListener('languageChanged', function() {
    refreshDateTimeFields();
  });

  function formatDuration(startedAt, endedAt) {
    if (!startedAt || !endedAt) return '-';
    const start = new Date(startedAt).getTime();
    const end = new Date(endedAt).getTime();
    if (isNaN(start) || isNaN(end)) return '-';
    return formatMs(end - start);
  }

  const statusColors = {
    'open': '#3b82f6',
    'invitational': '#8b5cf6',
    'in_progress': '#10b981',
    'finished': '#6b7280',
    'cancelled': '#ef4444'
  };

  function getStatusText(status) {
    if (typeof i18n !== 'undefined') {
      switch(status) {
        case 'open': return i18n.t('status.race.open');
        case 'invitational': return i18n.t('status.race.invitational');
        case 'in_progress': return i18n.t('status.race.ongoing');
        case 'finished': return i18n.t('status.race.finished');
        case 'cancelled': return i18n.t('status.race.cancelled');
        default: return status;
      }
    }
    // Fallback si i18n non disponible
    const statusTexts = {
      'open': 'Open',
      'invitational': 'Invitational',
      'in_progress': 'In Progress',
      'finished': 'Finished',
      'cancelled': 'Cancelled'
    };
    return statusTexts[status] || status;
  }

  function normalizeRacetimeRaceUrl(rawUrl, categoryHint) {
    let raw = String(rawUrl || '').trim();
    if (!raw) return null;

    if (/^https?:\/\//i.test(raw)) {
      try {
        const parsed = new URL(raw);
        raw = parsed.pathname || '';
      } catch (e) {
        raw = raw.replace(/^https?:\/\/(www\.)?racetime\.gg/i, '');
      }
    }

    raw = '/' + raw.replace(/^\/+/, '');
    const parts = raw.split('/').filter(Boolean);

    if (parts.length >= 3 && parts[0] === parts[1]) {
      parts.splice(1, 1);
    }

    const hint = String(categoryHint || '').toLowerCase().trim();
    if (hint && parts.length >= 3 && parts[0] === hint && parts[1] === hint) {
      parts.splice(1, 1);
    }

    return 'https://racetime.gg/' + parts.join('/');
  }

  function formatRank(n) {
    if (n === null || typeof n === 'undefined' || n === '') return '-';
    const num = Number(n);
    if (Number.isNaN(num)) return String(n);
    if (num === 1) return '🥇';
    if (num === 2) return '🥈';
    if (num === 3) return '🥉';
    return `${num}ème`;
  }

  async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Fetch failed: ' + res.status);
    return res.json();
  }

  function renderParticipants(entrants) {
    if (!entrants || entrants.length === 0) {
      participantsEl.innerHTML = '<p style="color:#9ca3af;">No participants</p>';
      return;
    }

    // Store entrants for re-rendering
    currentEntrants = entrants;

    // Check spoiler mode
    const spoilerMode = sessionStorage.getItem('spoilerModeEnabled') === 'true';

    let sorted;
    if (spoilerMode) {
      // In spoiler mode: alphabetical order by name
      sorted = [...entrants].sort((a, b) => {
        const nameA = (a.userName || 'Unknown').toLowerCase();
        const nameB = (b.userName || 'Unknown').toLowerCase();
        return nameA.localeCompare(nameB);
      });
    } else {
      // Normal mode: finished first (by place), then DNF, then DQ
      sorted = [...entrants].sort((a, b) => {
        // Finished entrants first
        if (a.status === 'done' && b.status !== 'done') return -1;
        if (a.status !== 'done' && b.status === 'done') return 1;
        
        // Both finished - sort by place
        if (a.status === 'done' && b.status === 'done') {
          return (a.place || 999) - (b.place || 999);
        }
        
        // DNF before DQ
        if (a.status === 'dnf' && b.status === 'dq') return -1;
        if (a.status === 'dq' && b.status === 'dnf') return 1;
        
        return 0;
      });
    }

    const html = sorted.map((e, idx) => {
      const name = e.userName || 'Unknown';
      const playerLink = e.userName ? `/player-detail.html?name=${encodeURIComponent(e.userName)}` : '#';
      
      if (spoilerMode) {
        // Spoiler mode: simple list, no rank, no time, alphabetical
        return `
          <div style="display:flex;align-items:center;padding:1rem;background:#2d3748;margin-bottom:0.5rem;border-radius:0.375rem;transition:background 0.2s;" onmouseover="this.style.background='#4a5568'" onmouseout="this.style.background='#2d3748'">
            <a href="${playerLink}" style="flex:1;color:#fff;text-decoration:none;">
              ${name}
            </a>
          </div>
        `;
      } else {
        // Normal mode: full details with rank and time
        const ms = e.finishTimeMs || parseTimeToMs(e.finishTime);
        const timeStr = ms ? formatMs(ms) : (e.status === 'dnf' ? 'DNF' : e.status === 'dq' ? 'DQ' : '-');
        const rank = e.place ? formatRank(e.place) : (e.status === 'dnf' ? 'DNF' : e.status === 'dq' ? 'DQ' : '-');
        
        const isWinner = e.place === 1;
        const isDnf = e.status === 'dnf';
        const isDq = e.status === 'dq';
        
        const bgColor = isWinner ? '#374151' : '#2d3748';
        const borderColor = isWinner ? '#fbbf24' : 'transparent';
        const nameColor = isWinner ? '#fbbf24' : isDnf || isDq ? '#9ca3af' : '#fff';
        const timeColor = isWinner ? '#10b981' : isDnf ? '#ef4444' : isDq ? '#f59e0b' : '#10b981';
        
        return `
          <div class="spoiler-block" style="display:flex;align-items:center;gap:0.375rem;padding:1rem;background:${bgColor};border-left:3px solid ${borderColor};margin-bottom:0.5rem;border-radius:0.375rem;transition:background 0.2s;" onmouseover="this.style.background='#4a5568'" onmouseout="this.style.background='${bgColor}'">
            <div style="width:60px;min-width:60px;text-align:center;font-size:1.25rem;color:#fbbf24;">${rank}</div>
            <a href="${playerLink}" style="flex:1;padding-left:0.2rem;color:${nameColor};font-weight:${isWinner ? '600' : '400'};text-decoration:none;">
              ${name}
            </a>
            <div style="color:${timeColor};font-weight:600;font-family:monospace;font-size:1rem;">${timeStr}</div>
          </div>
        `;
      }
    }).join('');

    participantsEl.innerHTML = html;
  }

  async function load() {
    try {
      await loadGames();

      let race;
      
      if (raceId) {
        race = await fetchJson('/api/runs/' + encodeURIComponent(raceId));
      } else if (raceUrl) {
        // Try to find race by URL
        const allRaces = await fetchJson('/api/runs?limit=1000');
        race = (allRaces.races || []).find(r => r.url === raceUrl || r.url === '/' + raceUrl);
        if (!race) throw new Error('Race not found');
      } else {
        gameEl.textContent = 'No race specified';
        return;
      }

      let gameDisplayName = getGameDisplayName(race.category);

      // Update title with full name
      document.title = `${gameDisplayName} - Race - Randomizer`;

      // Game name
      gameEl.textContent = gameDisplayName;
      
      // Goal
      goalEl.textContent = race.goal || race.name || '';
      
      // Status
      const status = race.status || 'unknown';
      statusEl.textContent = getStatusText(status);
      statusEl.style.background = statusColors[status] || '#6b7280';
      statusEl.style.color = 'white';
      
      // Info (seed info, etc.)
      if (race.info) {
        infoEl.innerHTML = formatInfoHtml(race.info);
      }
      
      // Times
      currentRace = race;
      refreshDateTimeFields();
      
      // Entrants count
      const entrantsCount = (race.entrants || []).length;
      entrantsCountEl.textContent = entrantsCount;
      
      // Links
      const links = [];
      if (race.url) {
        const racetimeUrl = normalizeRacetimeRaceUrl(race.url, race.category);
        const safeRacetimeUrl = sanitizeExternalUrl(racetimeUrl);
        if (safeRacetimeUrl) {
          links.push(`<a href="${escapeHtml(safeRacetimeUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:0.5rem;background-color:#1F2937;color:#E3E6E6;font-weight:600;padding:0.75rem 1.5rem;border-radius:0.5rem;border:2px solid #E3E6E6;text-decoration:none;transition:all 0.2s;font-size:1rem;" onmouseover="this.style.background='#374151'" onmouseout="this.style.background='#1F2937'"><img src="/assets/racetime.svg" alt="Racetime" style="width:24px;height:24px;">Voir sur Racetime</a>`);
        }
      }
      linksEl.innerHTML = links.join('');
      
      // Tournament link
      if (race.tournamentId) {
        try {
          const tournament = await fetchJson('/api/tournaments/' + encodeURIComponent(race.tournamentId));
          if (tournament && tournament.name) {
            tournamentNameEl.textContent = tournament.name;
            tournamentNameEl.href = '/tournament-detail.html?id=' + encodeURIComponent(race.tournamentId);
            tournamentLinkDiv.style.display = 'block';
          }
        } catch (e) {
          // Tournament not found, ignore
        }
      }
      
      // Update title then participants
      updateParticipantsTitle();
      renderParticipants(race.entrants);
      
    } catch (e) {
      const errText = (typeof i18n !== 'undefined' && typeof i18n.t === 'function') ? i18n.t('common.error') : 'Loading error';
      gameEl.textContent = errText;
      console.error(e);
    }
  }

  if (raceId || raceUrl) {
    load();
  } else {
    gameEl.textContent = 'No race specified';
  }
})();
