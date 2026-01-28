(function(){
  const listEl = document.getElementById('tournaments-list');
  const pagination = document.getElementById('pagination');
  const gameSelect = document.getElementById('filter-game');
  const filterBtns = document.querySelectorAll('.filter-btn');
  
  let page = 1;
  const limit = 24;
  let currentFilter = 'all';
  let currentGame = '';
  let gamesById = {};
  // Map frontend filter keys to server status strings (server returns French status strings)
  const statusFilterMap = {
    'upcoming': 'à venir',
    'ongoing': 'en cours',
    'inprogress': 'en cours',
    'in-progress': 'en cours',
    'finished': 'terminé',
    'completed': 'terminé'
  };

  function formatDate(d) {
    if (!d) return '-';
    const locale = (typeof window.i18n !== 'undefined' && window.i18n.getLanguage) ? window.i18n.getLanguage() : 'en';
    return new Date(d).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
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

  function getTournamentStatus(t) {
    if (!t.startDate) return 'à venir';
    const now = Date.now();
    const start = new Date(t.startDate).getTime();
    const end = t.endDate ? new Date(t.endDate).getTime() : null;
    const oneYear = 365 * 24 * 60 * 60 * 1000;
    
    // If explicit end date and we're past it, or if status is explicitly complete
    if (end && now > end) return 'terminé';
    if (t.status === 'complete' || t.status === 'awaiting_review') return 'terminé';
    
    // If no end date but started more than 1 year ago, consider it finished
    if (!end && now - start > oneYear) return 'terminé';
    
    if (now >= start && (!end || now <= end)) return 'en cours';
    return 'à venir';
  }

  function cardFor(t){
    const statusColors = {
      'à venir': '#3b82f6',
      'en cours': '#10b981',
      'terminé': '#6b7280'
    };
    const status = getTournamentStatus(t);
    const statusColor = statusColors[status] || '#6b7280';
    const statusText = status === 'à venir' ? (typeof i18n !== 'undefined' ? i18n.t('status.tournament.upcoming') : 'Upcoming') : 
                       status === 'en cours' ? (typeof i18n !== 'undefined' ? i18n.t('status.tournament.inProgress') : 'In Progress') : 
                       (typeof i18n !== 'undefined' ? i18n.t('status.tournament.finished') : 'Finished');

    const date = formatDate(t.startDate);
    const participantsCount = t.participantsCount || (t.participants && t.participants.length) || 0;
    
    let gameName = t.gameName || '';
    if (!gameName && gamesById[t.gameId]) {
      gameName = gamesById[t.gameId].officialName || gamesById[t.gameId].name;
    }

    // Find winner if participants exist and have finalRank set, or from _computedWinner
    let winnerText = '';
    let winner = null;
    
    if (t.participants && t.participants.length > 0) {
      winner = t.participants.find(p => p.finalRank != null && p.finalRank === 1);
    }
    
    if (!winner && t._computedWinner) {
      winnerText = `<div class="spoiler-block" style="color:#9ca3af;font-size:0.8rem;margin-top:0.5rem;">🏆 ${t._computedWinner}</div>`;
    } else if (winner) {
      winnerText = `<div class="spoiler-block" style="color:#9ca3af;font-size:0.8rem;margin-top:0.5rem;">🏆 ${winner.displayName || winner.name || 'Gagnant'}</div>`;
    }

    const url = `/tournament-detail.html?id=${encodeURIComponent(t._id || t.id)}`;

    return `
      <a href="${url}" style="text-decoration:none;color:inherit;display:block;">
        <div style="background:#1f2937;padding:1.25rem;border-radius:0.5rem;cursor:pointer;transition:all 0.2s;height:100%;display:flex;flex-direction:column;" onmouseover="this.style.background='#374151';this.style.transform='translateY(-2px)'" onmouseout="this.style.background='#1f2937';this.style.transform='translateY(0)'">
          <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:0.5rem;">
            <div style="flex:1;min-width:0;">
              <div style="color:#fbbf24;font-weight:600;font-size:0.95rem;margin-bottom:0.25rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${t.name || 'Tournoi'}</div>
              <div style="color:#d1d5db;font-size:0.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${gameName || 'Unknown game'}</div>
            </div>
            <span style="background:${statusColor};color:white;padding:0.25rem 0.5rem;border-radius:0.25rem;font-size:0.7rem;white-space:nowrap;margin-left:0.5rem;flex-shrink:0;">${statusText}</span>
          </div>
          ${winnerText}
          <div style="flex:1;"></div>
          <div style="display:flex;justify-content:space-between;font-size:0.75rem;color:#6b7280;margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid #374151;">
            <span>📅 ${date}</span>
            <span>👥 ${participantsCount} ${typeof i18n !== 'undefined' ? i18n.t('home.participants') : 'participants'}</span>
          </div>
        </div>
      </a>
    `;
  }

  async function loadGames() {
    try {
      const res = await fetch('/api/games');
      if (!res.ok) return;
      const data = await res.json();
      const games = data.games || [];
      
      games.forEach(g => {
        gamesById[g.id] = g;
        const opt = document.createElement('option');
        opt.value = g.id;
        opt.textContent = g.officialName || g.name;
        gameSelect.appendChild(opt);
      });
    } catch (e) {
      console.error('Failed to load games:', e);
    }
  }

  async function load(){
    listEl.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:3rem;color:#9ca3af;">${i18n.t('common.loading') || 'Loading...'}</div>`;
    
    const q = new URLSearchParams({ limit, page });
    if (currentGame) q.set('gameId', currentGame);
    if (currentFilter !== 'all') {
      const statusParam = statusFilterMap[currentFilter] || currentFilter;
      q.set('status', statusParam);
    }
    
    try{
      const res = await fetch('/api/tournaments?' + q.toString());
      if(!res.ok) throw new Error('Fetch failed');
      const data = await res.json();
      let tournaments = data.tournaments || [];
      
      if(tournaments.length === 0) {
        listEl.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:3rem;color:#9ca3af;">${i18n.t('tournaments.noTournaments') || 'No tournaments found'}</div>`;
      } else {
        // Enrich tournaments with winners and last match date
        Promise.all(tournaments.map(async (t) => {
          if ((!t.participants || t.participants.every(p => p.finalRank == null)) && !t.winner) {
            t._computedWinner = await findTournamentWinner(t._id || t.id, t);
          }
          // Fetch last match date for finished tournaments
          const status = getTournamentStatus(t);
          if (status === 'terminé') {
            const lastMatchDate = await getLastMatchDate(t._id || t.id);
            if (lastMatchDate) t._lastMatchDate = lastMatchDate;
          }
          return t;
        })).then(enriched => {
          listEl.innerHTML = enriched.map(cardFor).join('');
        }).catch(() => {
          listEl.innerHTML = tournaments.map(cardFor).join('');
        });
      }

      const { total, pages } = data.pagination || { total: 0, pages: 1 };
      renderPagination(pages, total);
    }catch(e){
      const errText = (typeof i18n !== 'undefined' && typeof i18n.t === 'function') ? i18n.t('common.error') : 'Loading error';
      listEl.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:3rem;color:#ef4444;">${errText}</div>`;
      console.error(e);
    }
  }

  function renderPagination(totalPages, total) {
    const tournamentWord = total > 1 
      ? (typeof i18n !== 'undefined' ? i18n.t('tournaments.tournamentPlural') : 'tournois')
      : (typeof i18n !== 'undefined' ? i18n.t('tournaments.tournament') : 'tournoi');
    if (totalPages <= 1) {
      pagination.innerHTML = `<span style="color:#6b7280;font-size:0.875rem;">${total} ${tournamentWord}</span>`;
      return;
    }

    let html = '';
    
    if (page > 1) {
      html += `<button onclick="goToPage(${page - 1})" style="padding:0.5rem 1rem;border-radius:0.375rem;border:none;background:#374151;color:white;cursor:pointer;font-size:0.875rem;">← Previous</button>`;
    }
    
    html += `<span style="color:#9ca3af;font-size:0.875rem;">Page ${page} / ${totalPages} (${total} ${tournamentWord})</span>`;
    
    if (page < totalPages) {
      html += `<button onclick="goToPage(${page + 1})" style="padding:0.5rem 1rem;border-radius:0.375rem;border:none;background:#374151;color:white;cursor:pointer;font-size:0.875rem;">Suivant →</button>`;
    }
    
    pagination.innerHTML = html;
  }

  window.goToPage = function(newPage) {
    page = newPage;
    load();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

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


function setupFilters() {
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => {
        b.classList.remove('active', 'bg-yellow-500', 'text-black');
        b.classList.add('bg-gray-700', 'text-white');
      });
      
      btn.classList.add('active', 'bg-yellow-500', 'text-black');
      btn.classList.remove('bg-gray-700', 'text-white');
      
      currentFilter = btn.dataset.filter;
      currentPage = 1;
      loadTournaments();
    });
  });
}

async function fetchJson(url){
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if(!res.ok) throw new Error('Fetch failed: '+res.status);
  return res.json();
}

async function loadTournaments() {
  try {
    const params = {
      limit: TOURNAMENTS_PER_PAGE,
      page: currentPage
    };

    if (currentFilter !== 'all') {
      params.status = statusFilterMap[currentFilter] || currentFilter;
    }

    const data = await API.getTournaments(params);
    displayTournaments(data.tournaments || []);
    displayPagination(data.pagination);
  }catch (error) {
    console.error('Error loading tournaments:', error);
    const errText = (typeof i18n !== 'undefined' && typeof i18n.t === 'function') ? i18n.t('common.error') : 'Loading error';
    document.getElementById('tournaments-grid').innerHTML = `<p class="col-span-full text-center text-red-400">${errText}</p>`;
  }
}

function displayTournaments(tournaments) {
  const grid = document.getElementById('tournaments-grid');
  grid.innerHTML = '';
  // Increase spacing between tournament cards for better readability
  try { grid.style.gap = '3rem'; grid.style.rowGap = '3rem'; grid.style.columnGap = '3rem'; } catch (e) {}

  if (tournaments.length === 0) {
    grid.innerHTML = '<p class="col-span-full text-center text-gray-400">No tournaments found</p>';
    return;
  }

  tournaments.forEach(tournament => {
    const card = document.createElement('div');
    card.className = 'rounded-lg overflow-hidden hover:bg-gray-700 transition cursor-pointer shadow-lg';
    card.style.background = '#374151';
    card.style.border = 'none';
    
    const status = getTournamentStatus(tournament);
    const statusColor = status === 'en cours' ? '#10b981' : status === 'à venir' ? '#3b82f6' : '#6b7280';

    const statusLabel = status === 'en cours' ? 'Ongoing' : status === 'à venir' ? 'Upcoming' : 'Finished';
    card.innerHTML = `
      <div class="p-6">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 0.75rem; margin-bottom: 0.5rem;">
          <h3 class="text-xl font-bold text-yellow-400" style="margin: 0; flex: 1;">${tournament.name}</h3>
          <span class="inline-status-badge" style="background-color: ${statusColor}; color: white; padding: 0.4rem 0.75rem; border-radius: 0.5rem; font-size: 0.9rem; font-weight: 600; white-space: nowrap; margin-left: 1rem;">${statusLabel}</span>
        </div>
        <p class="tournament-game text-gray-400 mb-4">${tournament.gameName || 'Unknown game'}</p>
        <div class="grid grid-cols-2 gap-2 text-sm text-gray-400">
          <div>📅 ${formatDate(tournament.startDate)}</div>
          <div>👥 ${tournament.participantsCount || 0} participant${(tournament.participantsCount||0) > 1 ? 's' : ''}</div>
        </div>
      </div>
    `;

    card.addEventListener('click', () => {
      window.location.href = `/tournament-detail.html?id=${tournament._id}`;
    });
    // Ensure pointer cursor and basic keyboard accessibility (Enter / Space)
    try { card.style.cursor = 'pointer'; } catch (e) {}
    try { card.setAttribute('role', 'button'); } catch (e) {}
    try { card.tabIndex = 0; } catch (e) {}
    try {
      card.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          card.click();
        }
      });
    } catch (e) {}
    card.style.background = '#1f2937';
    card.style.transition = 'transform 0.2s, background-color 0.2s';
    card.addEventListener('mouseenter', () => {
      card.style.background = '#374151';
      card.style.transform = 'translateY(-4px)';
    });
    card.addEventListener('mouseleave', () => {
      card.style.background = '#1f2937';
      card.style.transform = 'none';
    });

    // ensure extra vertical spacing per card in addition to grid gap
    try { card.style.marginBottom = '1.5rem'; } catch (e) {}
    grid.appendChild(card);

    // Post-render: if game name is missing, try to resolve from /api/tournaments/:id
    try {
      const tid = tournament._id || tournament.tournamentId || tournament.id || '';
      const gameEl = card.querySelector('.tournament-game');
      const txt = (gameEl && (gameEl.textContent || '').trim()) || '';
      if (gameEl && (txt === '' || txt === 'Unknown game' || txt === 'Unknown')) {
        if (tid) {
          fetchJson('/api/tournaments/' + encodeURIComponent(tid)).then(tr => {
            const resolved = tr.gameName || (tr.game && tr.game.name) || tr.gameSlug || null;
            if (resolved) gameEl.textContent = resolved;
          }).catch(() => {});
        }
      }
    } catch (e) { /* ignore */ }
  });
}

function displayPagination(pagination) {
  const container = document.getElementById('pagination');
  container.innerHTML = '';

  if (!pagination || pagination.pages <= 1) return;

  for (let i = 1; i <= pagination.pages; i++) {
    const btn = document.createElement('button');
    btn.textContent = i;
    btn.className = i === currentPage 
      ? 'px-4 py-2 bg-yellow-500 text-black rounded font-bold'
      : 'px-4 py-2 bg-gray-700 text-white rounded hover:bg-gray-600';
    
    btn.addEventListener('click', () => {
      currentPage = i;
      loadTournaments();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    container.appendChild(btn);
  }
}

// CSS for filter buttons and status badges is now defined in public/style.css
// to avoid flash of unstyled content (FOUC)
