(function(){
  const listEl = document.getElementById('races-list');
  const pagination = document.getElementById('pagination');
  const gameSelect = document.getElementById('filter-game');
  const filterBtns = document.querySelectorAll('.filter-btn');
  
  let page = 1;
  const limit = 24;
  let currentFilter = 'all';
  let currentGame = '';
  let gamesById = {};
  let gamesBySlug = {};  // Index par slug racetime

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
    if (ms == null) return 'N/A';
    const totalSeconds = Math.round(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
  }

  function getGameDisplayName(slug) {
    if (!slug) return 'Race';
    const lowerSlug = String(slug).toLowerCase().trim();
    
    // Chercher d'abord par slug racetime
    if (gamesBySlug[lowerSlug]) {
      return resolveGameLabel(gamesBySlug[lowerSlug]) || slug;
    }
    // Sinon par ID
    if (gamesById[lowerSlug]) {
      return resolveGameLabel(gamesById[lowerSlug]) || slug;
    }
    if (lowerSlug.endsWith('r') && gamesById[lowerSlug.slice(0, -1)]) {
      return resolveGameLabel(gamesById[lowerSlug.slice(0, -1)]) || slug;
    }
    // Fallback sur les noms statiques
    return gameDisplayNames[lowerSlug] || slug;
  }

  function cardFor(r){
    const statusColors = {
      'open': '#3b82f6',
      'invitational': '#8b5cf6',
      'in_progress': '#10b981',
      'finished': '#6b7280',
      'cancelled': '#ef4444'
    };
    const statusColor = statusColors[r.status] || '#6b7280';
    const statusText = r.status === 'in_progress' ? (typeof i18n !== 'undefined' ? i18n.t('status.race.ongoing') : 'Ongoing') : 
                       r.status === 'open' ? (typeof i18n !== 'undefined' ? i18n.t('status.race.open') : 'Open') :
                       r.status === 'finished' ? (typeof i18n !== 'undefined' ? i18n.t('status.race.finished') : 'Finished') : 
                       r.status === 'cancelled' ? (typeof i18n !== 'undefined' ? i18n.t('status.race.cancelled') : 'Cancelled') :
                       r.status === 'invitational' ? (typeof i18n !== 'undefined' ? i18n.t('status.race.invitational') : 'Invitational') : r.status || '-';

    const locale = (typeof window.i18n !== 'undefined' && window.i18n.getLanguage) ? window.i18n.getLanguage() : 'en';
    const startTime = r.startedAt ? new Date(r.startedAt).toLocaleString(locale, {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    }) : '-';

    const winner = (r.entrants || []).find(e => e.place === 1);
    const totalEntrants = (r.entrants || []).length;
    
    const gameName = getGameDisplayName(r.category);

    let winnerHtml = '';
    if (winner) {
      let winnerName = winner.userName || null;
      if (!winnerName && winner.userUrl) {
        try {
          const parts = winner.userUrl.split('/').filter(Boolean);
          const last = parts[parts.length-1];
          if (last && !/^\w{20,}$/.test(last)) {
            winnerName = decodeURIComponent(last.replace(/[-_]/g,' '));
          }
        } catch(e){}
      }
      const ms = winner.finishTimeMs || parseTimeToMs(winner.finishTime);
      const timeStr = ms != null ? formatMs(ms) : (winner.finishTime || 'N/A');
      winnerHtml = `
        <div class="spoiler-block" style="color:#fbbf24;font-size:0.8rem;margin-top:0.5rem;display:flex;align-items:center;gap:0.5rem;">
          <span>🏆</span>
          <span style="color:#d1d5db;">${escHtml(winnerName || (i18n.t('common.unknown') || 'Unknown'))}</span>
          <span style="color:#10b981;font-weight:600;">${escHtml(timeStr)}</span>
        </div>
      `;
    }

    const url = r._id ? `/race-detail.html?id=${encodeURIComponent(r._id)}` : '#';

    return `
      <a href="${url}" style="text-decoration:none;color:inherit;display:block;">
        <div style="background:#1f2937;padding:1.25rem;border-radius:0.5rem;cursor:pointer;transition:all 0.2s;height:100%;display:flex;flex-direction:column;" data-hover-style="background:#374151;transform:translateY(-2px)" data-rest-style="background:#1f2937;transform:translateY(0)">
          <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:0.5rem;">
            <div style="flex:1;min-width:0;">
              <div style="color:#fbbf24;font-weight:600;font-size:0.95rem;margin-bottom:0.25rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(gameName)}</div>
              <div style="color:#d1d5db;font-size:0.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(r.goal || r.name || 'Standard')}</div>
            </div>
            <span style="background:${statusColor};color:white;padding:0.25rem 0.5rem;border-radius:0.25rem;font-size:0.7rem;white-space:nowrap;margin-left:0.5rem;flex-shrink:0;">${escHtml(statusText)}</span>
          </div>
          ${winnerHtml}
          <div style="flex:1;"></div>
          <div style="display:flex;justify-content:space-between;font-size:0.75rem;color:#6b7280;margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid #374151;">
            <span>📅 ${startTime}</span>
            <span>👥 ${totalEntrants} ${typeof i18n !== 'undefined' ? i18n.t('home.participants') : 'participants'}</span>
          </div>
        </div>
      </a>
    `;
  }

  async function loadGames() {
    try {
      const res = await fetch('/api/games/with-stats');
      if (!res.ok) return;
      const data = await res.json();
      const games = data.games || [];
      
      games.forEach(g => {
        const gameId = String(g.id || '').toLowerCase().trim();
        if (gameId) {
          gamesById[gameId] = g;
          gamesById[`${gameId}r`] = g;
        }
        
        // Indexer aussi par slug racetime (principal et additionnels)
        if (g.integrations?.racetime?.gameSlug) {
          gamesBySlug[g.integrations.racetime.gameSlug.toLowerCase()] = g;
        }
        // Indexer aussi les slugs additionnels (comme alttpr-ladder)
        if (g.integrations?.racetime?.gameSlugs) {
          g.integrations.racetime.gameSlugs.forEach(slug => {
            gamesBySlug[slug.toLowerCase()] = g;
          });
        }
      });

      // Add options to select, sorted alphabetically by label; only games that have races
      games
        .filter(g => g.totalRaces > 0)
        .map(g => ({ id: g.id, label: resolveGameLabel(g) || g.id }))
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base', numeric: true }))
        .forEach(({ id, label }) => {
          const opt = document.createElement('option');
          opt.value = id;
          opt.textContent = label;
          gameSelect.appendChild(opt);
        });
    } catch (e) {
      console.error('Failed to load games:', e);
    }
  }

  async function load(){
    listEl.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:3rem;color:#9ca3af;">Loading...</div>';
    
    const q = new URLSearchParams({ limit, page });
    if (currentGame) q.set('category', currentGame);
    
    try{
      const res = await fetch('/api/runs?' + q.toString());
      if(!res.ok) throw new Error('Fetch failed');
      const data = await res.json();
      let races = data.races || [];
      
      // Apply status filter client-side
      if (currentFilter !== 'all') {
        races = races.filter(r => r.status === currentFilter);
      }
      
      if(races.length === 0) {
        listEl.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:3rem;color:#9ca3af;">No races found.</div>';
      } else {
        listEl.innerHTML = races.map(cardFor).join('');
      }

      // Pagination
      const { total, pages } = data.pagination || { total: 0, pages: 1 };
      renderPagination(pages, total);
    }catch(e){
      const errText = (typeof i18n !== 'undefined' && typeof i18n.t === 'function') ? i18n.t('common.error') : 'Loading error';
      listEl.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:3rem;color:#ef4444;">${escHtml(errText)}</div>`;
      console.error(e);
    }
  }

  function renderPagination(totalPages, total) {
    const raceWord = total > 1 
      ? (typeof i18n !== 'undefined' ? i18n.t('races.racePlural') : 'races')
      : (typeof i18n !== 'undefined' ? i18n.t('races.race') : 'race');
    if (totalPages <= 1) {
      pagination.innerHTML = `<span style="color:#6b7280;font-size:0.875rem;">${total} ${raceWord}</span>`;
      return;
    }

    let html = '';
    
    // Previous button
    if (page > 1) {
      html += `<button data-page="${page - 1}" style="padding:0.5rem 1rem;border-radius:0.375rem;border:none;background:#374151;color:white;cursor:pointer;font-size:0.875rem;">← Précédent</button>`;
    }
    
    // Page info
    html += `<span style="color:#9ca3af;font-size:0.875rem;">Page ${page} / ${totalPages} (${total} ${raceWord})</span>`;
    
    // Next button
    if (page < totalPages) {
      html += `<button data-page="${page + 1}" style="padding:0.5rem 1rem;border-radius:0.375rem;border:none;background:#374151;color:white;cursor:pointer;font-size:0.875rem;">Suivant →</button>`;
    }
    
    pagination.innerHTML = html;
  }

  window.goToPage = function(newPage) {
    page = newPage;
    load();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Filter button clicks
  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => {
        b.style.background = '#1f2937';
        b.style.color = '#9ca3af';
        b.classList.remove('active');
      });
      btn.style.background = '#374151';
      btn.style.color = 'white';
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      page = 1;
      load();
    });
  });

  // Game select change
  gameSelect.addEventListener('change', () => {
    currentGame = gameSelect.value;
    page = 1;
    load();
  });

  // Check for game parameter in URL
  function getUrlParam(name) {
    const m = location.search.match(new RegExp('[?&]' + name + '=([^&]+)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  // Initialize
  document.addEventListener('DOMContentLoaded', async () => {
    await loadGames();
    
    // Pre-select game from URL parameter
    const gameParam = getUrlParam('game');
    if (gameParam) {
      currentGame = gameParam;
      gameSelect.value = gameParam;
    }
    
    load();
  });
})();
