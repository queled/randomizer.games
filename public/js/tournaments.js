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
  let gamesReady = Promise.resolve(); // cards need the games list to resolve names
  let loadId = 0; // ignores responses from a request a newer filter replaced
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
      winnerText = `<div class="spoiler-block" style="color:#9ca3af;font-size:0.8rem;margin-top:0.5rem;">🏆 ${escHtml(t._computedWinner)}</div>`;
    } else if (winner) {
      winnerText = `<div class="spoiler-block" style="color:#9ca3af;font-size:0.8rem;margin-top:0.5rem;">🏆 ${escHtml(winner.displayName || winner.name || 'Gagnant')}</div>`;
    }

    const url = `/tournament-detail.html?id=${encodeURIComponent(t._id || t.id)}`;

    return `
      <a href="${url}" style="text-decoration:none;color:inherit;display:block;">
        <div style="background:#1f2937;padding:1.25rem;border-radius:0.5rem;cursor:pointer;transition:all 0.2s;height:100%;display:flex;flex-direction:column;" data-hover-style="background:#374151;transform:translateY(-2px)" data-rest-style="background:#1f2937;transform:translateY(0)">
          <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:0.5rem;">
            <div style="flex:1;min-width:0;">
              <div style="color:#fbbf24;font-weight:600;font-size:0.95rem;margin-bottom:0.25rem;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${escHtml(t.name || 'Tournoi')}</div>
              <div style="color:#d1d5db;font-size:0.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(gameName || 'Unknown game')}</div>
            </div>
            <span style="background:${statusColor};color:white;padding:0.25rem 0.5rem;border-radius:0.25rem;font-size:0.7rem;white-space:nowrap;margin-left:0.5rem;flex-shrink:0;">${escHtml(statusText)}</span>
          </div>
          ${winnerText}
          <div style="flex:1;"></div>
          <div style="display:flex;justify-content:space-between;font-size:0.75rem;color:#6b7280;margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid #374151;">
            <span>📅 ${escHtml(date)}</span>
            <span>👥 ${participantsCount} ${typeof i18n !== 'undefined' ? i18n.t('home.participants') : 'participants'}</span>
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
        gamesById[g.id] = g;
        // Only list games that have tournaments
        if (!(g.totalTournaments > 0)) return;
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
    listEl.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:3rem;color:#9ca3af;">${(typeof i18n !== 'undefined' && i18n.t('common.loading')) || 'Loading...'}</div>`;
    
    const q = new URLSearchParams({ limit, page });
    if (currentGame) q.set('gameId', currentGame);
    if (currentFilter !== 'all') {
      const statusParam = statusFilterMap[currentFilter] || currentFilter;
      q.set('status', statusParam);
    }
    
    const thisLoad = ++loadId;
    try{
      const res = await fetch('/api/tournaments?' + q.toString());
      if(!res.ok) throw new Error('Fetch failed');
      const data = await res.json();
      const tournaments = data.tournaments || [];
      await gamesReady;
      if (thisLoad !== loadId) return;
      
      if(tournaments.length === 0) {
        listEl.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:3rem;color:#9ca3af;">${(typeof i18n !== 'undefined' && i18n.t('tournaments.noTournaments')) || 'No tournaments found'}</div>`;
      } else {
        // Show the cards right away, then add the winners computed from matches
        listEl.innerHTML = tournaments.map(cardFor).join('');
        const needWinner = tournaments.filter(t =>
          (!t.participants || t.participants.every(p => p.finalRank == null)) && !t.winner
        );
        if (needWinner.length > 0) {
          Promise.all(needWinner.map(async (t) => {
            t._computedWinner = await findTournamentWinner(t._id || t.id, t);
          })).then(() => {
            if (thisLoad === loadId && needWinner.some(t => t._computedWinner)) {
              listEl.innerHTML = tournaments.map(cardFor).join('');
            }
          }).catch(() => {});
        }
      }

      const { total, pages } = data.pagination || { total: 0, pages: 1 };
      renderPagination(pages, total);
    }catch(e){
      if (thisLoad !== loadId) return;
      const errText = (typeof i18n !== 'undefined' && typeof i18n.t === 'function') ? i18n.t('common.error') : 'Loading error';
      listEl.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:3rem;color:#ef4444;">${escHtml(errText)}</div>`;
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
      html += `<button data-page="${page - 1}" style="padding:0.5rem 1rem;border-radius:0.375rem;border:none;background:#374151;color:white;cursor:pointer;font-size:0.875rem;">← Previous</button>`;
    }
    
    html += `<span style="color:#9ca3af;font-size:0.875rem;">Page ${page} / ${totalPages} (${total} ${tournamentWord})</span>`;
    
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

  document.addEventListener('DOMContentLoaded', () => {
    // Load the games list and the tournaments at the same time
    gamesReady = loadGames();
    
    // Pre-select game from URL parameter
    const gameParam = getUrlParam('game');
    if (gameParam) {
      currentGame = gameParam;
      gamesReady.then(() => { gameSelect.value = gameParam; });
    }
    
    load();
  });
})();
