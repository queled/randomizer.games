(function() {
  // Get search query from URL
  function getSearchQuery() {
    const params = new URLSearchParams(window.location.search);
    return params.get('q') || '';
  }

  // i18n.js loads async: fall back to English until it is ready
  function tr(key, fallback, params = {}) {
    if (window.i18n && typeof window.i18n.t === 'function') return window.i18n.t(key, params, fallback);
    return fallback.replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m));
  }

  // Highlight search term in text
  // Returns HTML: every piece of the text is escaped, only the highlight
  // markup itself is trusted.
  function highlightText(text, query) {
    if (!text) return '';
    const raw = String(text);
    if (!query) return escHtml(raw);
    const regex = new RegExp(`(${escapeRegex(String(query))})`, 'gi');
    return raw
      .split(regex)
      .map((part, index) => (index % 2 === 1
        ? `<span class="highlight">${escHtml(part)}</span>`
        : escHtml(part)))
      .join('');
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Format date
  function formatDate(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const locale = (typeof window.i18n !== 'undefined' && window.i18n.getLanguage) ? window.i18n.getLanguage() : 'en';
    return date.toLocaleDateString(locale, {
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    });
  }

  // Current filter state
  let currentFilter = 'all';
  let searchResults = null;
  let searchQuery = '';

  // Render tabs
  function renderTabs(counts) {
    const tabsContainer = document.getElementById('search-tabs');
    const tabs = [
      { id: 'all', label: tr('search.tabAll', 'All'), count: counts.total },
      { id: 'games', label: tr('search.tabGames', 'Games'), count: counts.games },
      { id: 'races', label: tr('search.tabRaces', 'Races'), count: counts.races },
      { id: 'tournaments', label: tr('search.tabTournaments', 'Tournaments'), count: counts.tournaments },
      { id: 'players', label: tr('search.tabPlayers', 'Players'), count: counts.players },
      { id: 'streams', label: tr('search.tabLive', 'Live'), count: counts.streams || 0 }
    ];

    tabsContainer.innerHTML = tabs.map(tab => `
      <button class="search-tab ${currentFilter === tab.id ? 'active' : ''}" data-filter="${tab.id}">
        ${escHtml(tab.label)}<span class="count">${tab.count}</span>
      </button>
    `).join('');

    // Add click handlers
    tabsContainer.querySelectorAll('.search-tab').forEach(btn => {
      btn.addEventListener('click', () => selectFilter(btn.dataset.filter));
    });
  }

  // Square placeholder with a letter or an emoji, for a missing cover or avatar
  function placeholderImage(text, fontSize) {
    return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#374151"/><text x="50%" y="50%" dy=".35em" font-size="' + fontSize + '" fill="#fbbf24" text-anchor="middle">' + escHtml(text) + '</text></svg>');
  }

  // Render game card: its cover, the placeholder when the game has none
  function renderGameCard(game) {
    const cover = `/assets/covers/${encodeURIComponent(String(game.id || '').toLowerCase())}.png`;
    return `
      <a href="/games/${encodeURIComponent(game.id)}" class="result-card with-media">
        <img class="result-media cover" src="${escHtml(cover)}" alt="" loading="lazy" width="64" height="90"
             data-fallback-src="${escHtml(placeholderImage('🎮', 48))}">
        <div class="result-body">
          <div class="title">${highlightText(game.label || game.officialName || game.name, searchQuery)}</div>
          <div class="subtitle">${highlightText(game.officialName || game.id, searchQuery)}</div>
        </div>
      </a>
    `;
  }

  // Render tournament card
  function renderTournamentCard(tournament) {
    return `
      <a href="/tournaments/${encodeURIComponent(tournament._id)}" class="result-card">
        <div class="title">${highlightText(tournament.name, searchQuery)}</div>
        <div class="subtitle">${highlightText(tournament.gameName || '', searchQuery)}</div>
        <div class="meta">
          <span>📅 ${formatDate(tournament.startDate)}</span>
          <span>👥 ${tournament.participantCount || 0} ${escHtml(tr('home.participants', 'participants'))}</span>
        </div>
      </a>
    `;
  }

  // Render race card
  function renderRaceCard(race) {
    const statusClass = race.status === 'finished' ? 'status-finished' : 
                        race.status === 'open' ? 'status-open' : '';
    const statusText = race.status === 'finished' ? tr('status.race.finished', 'Finished') :
                       race.status === 'open' ? tr('status.race.open', 'Open') :
                       race.status === 'in_progress' ? tr('status.race.ongoing', 'Ongoing') :
                       race.status === 'cancelled' ? tr('status.race.cancelled', 'Cancelled') : race.status;
    
    return `
      <a href="/races/${encodeURIComponent(race._id)}" class="result-card">
        <div class="title">${highlightText(race.goal || race.name, searchQuery)}</div>
        <div class="subtitle">
          <span class="badge game">${escHtml(race.gameName || race.category || '')}</span>
          <span class="badge ${statusClass}">${escHtml(statusText)}</span>
        </div>
        <div class="meta">
          <span>📅 ${formatDate(race.startedAt)}</span>
          <span>👥 ${race.entrantCount || 0} ${escHtml(tr('home.participants', 'participants'))}</span>
        </div>
      </a>
    `;
  }

  // Render player card
  function renderPlayerCard(player) {
    // Most raced games with their race count, as on the players page; else the games seen in the results
    const gamesHtml = player.racesByGame && player.racesByGame.length > 0
      ? `<div class="player-games">${player.racesByGame.map(g =>
          `<span class="game-tag">${escHtml(g.gameName)} <span class="race-count">(${Number(g.count).toLocaleString()})</span></span>`
        ).join('')}</div>`
      : player.games && player.games.length > 0 
      ? `<div class="player-games">${player.games.slice(0, 4).map(g => 
          `<span class="game-tag">${escHtml(g)}</span>`
        ).join('')}${player.games.length > 4 ? `<span class="game-tag">+${player.games.length - 4}</span>` : ''}</div>`
      : '';
    
    // racetime avatar, else Twitch avatar (as on the players page); the initial on failure
    const initialMatch = String(player.name || '').match(/[\p{L}\p{N}]/u);
    const placeholder = placeholderImage(initialMatch ? initialMatch[0].toUpperCase() : '?', 56);
    const racetimeAccount = player.racetimeId || player.racetimeUrl || '';
    const avatar = (racetimeAccount || player.twitch)
      ? '/api/avatar?racetime=' + encodeURIComponent(racetimeAccount) + '&twitch=' + encodeURIComponent(player.twitch || '')
      : placeholder;
    const href = player.userId
      ? `/players/${encodeURIComponent(player.userId)}`
      : `/players/name/${encodeURIComponent(player.name)}`;

    return `
      <a href="${escHtml(href)}" class="result-card with-media">
        <img class="result-media avatar" src="${escHtml(avatar)}" alt="" loading="lazy" width="56" height="56"
             data-fallback-src="${escHtml(placeholder)}">
        <div class="result-body">
          <div class="title">${highlightText(player.name, searchQuery)}</div>
          ${gamesHtml}
        </div>
      </a>
    `;
  }

  // Render live stream card (same card as the live page)
  function renderStreamCard(stream) {
    const login = String(stream.userLogin || '').replace(/[^a-zA-Z0-9_]/g, '');
    if (!login) return '';
    const fallback = placeholderImage('📺', 40);
    const thumb = stream.thumbnailUrl ? `/api/proxy-image?url=${encodeURIComponent(stream.thumbnailUrl)}` : fallback;
    const gameId = stream.gameId && stream.gameId !== 'unknown' ? stream.gameId : '';
    const locale = (window.i18n && window.i18n.getLanguage) ? window.i18n.getLanguage() : undefined;
    return `
      <a class="stream-card" href="https://twitch.tv/${login}" target="_blank" rel="noopener noreferrer">
        <div class="stream-thumbnail">
          <img src="${escHtml(thumb)}" alt="" loading="lazy" data-fallback-src="${escHtml(fallback)}">
          <span class="stream-live-badge">${escHtml(tr('streams.live', 'LIVE'))}</span>
          ${stream.viewerCount ? `<span class="stream-viewers">👁 ${escHtml(new Intl.NumberFormat(locale, { notation: 'compact' }).format(stream.viewerCount))}</span>` : ''}
        </div>
        <div class="stream-info">
          <div class="stream-title">${highlightText(stream.title || '', searchQuery)}</div>
          <div class="stream-channel">${highlightText(stream.userName || login, searchQuery)}</div>
          ${stream.gameName ? `<div class="stream-game">🎮 ${gameId
            ? `<span class="game-link" data-game-id="${escHtml(gameId)}">${highlightText(stream.gameName, searchQuery)}</span>`
            : highlightText(stream.gameName, searchQuery)}</div>` : ''}
        </div>
      </a>
    `;
  }

  // A tab shows its whole section, a page at a time
  const PAGE_SIZE = 48;
  let loadingMore = false;

  function selectFilter(filter) {
    currentFilter = filter;
    renderTabs(searchResults.counts);
    renderResults();
    window.scrollTo({ top: 0 });
    // The first view holds a few results: the tab fills its first page
    const loaded = (searchResults.results[filter] || []).length;
    if (filter !== 'all' && loaded < PAGE_SIZE && loaded < (searchResults.counts[filter] || 0)) loadMore(filter);
  }

  async function loadMore(section) {
    if (loadingMore) return;
    loadingMore = true;
    renderResults();
    const items = searchResults.results[section] || [];
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(searchQuery)}&type=${section}&offset=${items.length}&limit=${PAGE_SIZE}`);
      if (!response.ok) throw new Error('Search failed');
      const data = await response.json();
      const next = data.results[section] || [];
      searchResults.results[section] = items.concat(next);
      // Nothing more came back: the count was larger than what the section can list
      if (!next.length) searchResults.counts[section] = searchResults.results[section].length;
    } catch (error) {
      console.error('Search error:', error);
    } finally {
      loadingMore = false;
      renderResults();
    }
  }

  // Render a section of results: in the "all" view a link to its tab, in its tab a button for the next page
  function renderSection(section, title, icon, items, renderFn, count) {
    if (!items || items.length === 0) return '';
    const more = items.length < count;
    const footer = !more ? ''
      : currentFilter === 'all'
        ? ''
        : `<div class="load-more"><button type="button" class="load-more-btn" data-load-more="${section}" ${loadingMore ? 'disabled' : ''}>${escHtml(loadingMore ? tr('common.loading', 'Loading...') : tr('common.viewMore', 'View more'))}</button></div>`;

    return `
      <div class="results-section">
        <div class="section-header">
          <span class="section-count">${count.toLocaleString((window.i18n && window.i18n.getLanguage) ? window.i18n.getLanguage() : undefined)}</span>
          <span class="section-title">${icon} ${escHtml(title)}</span>
          ${more && currentFilter === 'all' ? `<button type="button" class="section-see-all" data-see-all="${section}">${escHtml(tr('common.viewAll', 'View all'))} →</button>` : ''}
        </div>
        <div class="results-grid">
          ${items.map(renderFn).join('')}
        </div>
        ${footer}
      </div>
    `;
  }

  // Render all results
  function renderResults() {
    const container = document.getElementById('results-container');
    
    if (!searchResults) {
      container.innerHTML = `<div class="loading">${escHtml(tr('common.loading', 'Loading...'))}</div>`;
      return;
    }

    const { results, counts } = searchResults;
    
    if (counts.total === 0) {
      container.innerHTML = `
        <div class="no-results">
          <div class="no-results-icon">🔍</div>
          <div>${escHtml(tr('search.noResultsFor', 'No results found for'))} "<strong>${escHtml(searchQuery)}</strong>"</div>
          <div style="margin-top: 0.5rem; font-size: 0.9rem;">${escHtml(tr('search.tryOtherTerms', 'Try other search terms'))}</div>
        </div>
      `;
      return;
    }

    let html = '';

    // Show sections based on filter
    if (currentFilter === 'all' || currentFilter === 'games') {
      html += renderSection('games', tr('search.tabGames', 'Games'), '🎮', results.games, renderGameCard, counts.games || 0);
    }
    
    if (currentFilter === 'all' || currentFilter === 'races') {
      html += renderSection('races', tr('search.tabRaces', 'Races'), '🥇', results.races, renderRaceCard, counts.races || 0);
    }
    
    if (currentFilter === 'all' || currentFilter === 'tournaments') {
      html += renderSection('tournaments', tr('search.tabTournaments', 'Tournaments'), '🏆', results.tournaments, renderTournamentCard, counts.tournaments || 0);
    }
    
    if (currentFilter === 'all' || currentFilter === 'players') {
      html += renderSection('players', tr('search.tabPlayers', 'Players'), '👤', results.players, renderPlayerCard, counts.players || 0);
    }

    if (currentFilter === 'all' || currentFilter === 'streams') {
      html += renderSection('streams', tr('search.tabLive', 'Live'), '📺', results.streams, renderStreamCard, counts.streams || 0);
    }

    if (!html) {
      html = `
        <div class="no-results">
          <div class="no-results-icon">📭</div>
          <div>${escHtml(tr('search.noResultsInCategory', 'No results in this category'))}</div>
        </div>
      `;
    }

    container.innerHTML = html;
  }

  function renderHeader() {
    document.getElementById('search-query').textContent = searchQuery || tr('search.title', 'Search');
    const locale = (window.i18n && window.i18n.getLanguage) ? window.i18n.getLanguage() : undefined;
    document.getElementById('search-subtitle').textContent = searchResults
      ? tr('search.resultsCount', '{count} SEARCH RESULTS', { count: searchResults.counts.total.toLocaleString(locale) })
      : tr('search.searchResults', 'SEARCH RESULTS');
  }

  // Perform search
  async function performSearch(query) {
    searchQuery = query;
    
    renderHeader();
    
    // Update search input
    const searchInput = document.getElementById('search');
    if (searchInput) searchInput.value = query;

    if (!query || query.trim().length < 2) {
      document.getElementById('results-container').innerHTML = `
        <div class="no-results">
          <div class="no-results-icon">🔍</div>
          <div>${escHtml(tr('search.minChars', 'Enter at least 2 characters to search'))}</div>
        </div>
      `;
      document.getElementById('search-tabs').innerHTML = '';
      return;
    }

    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=12`);
      if (!response.ok) throw new Error('Search failed');
      
      searchResults = await response.json();
      
      renderHeader();
      renderTabs(searchResults.counts);
      renderResults();
      
    } catch (error) {
      console.error('Search error:', error);
      document.getElementById('results-container').innerHTML = `
        <div class="no-results">
          <div class="no-results-icon">❌</div>
          <div>${escHtml(tr('search.error', 'Search error'))}</div>
          <div style="margin-top: 0.5rem; font-size: 0.9rem;">${escHtml(tr('search.errorRetry', 'Please try again later'))}</div>
        </div>
      `;
    }
  }

  // Handle search input
  function setupSearchInput() {
    const searchInput = document.getElementById('search');
    if (!searchInput) return;

    searchInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        const query = searchInput.value.trim();
        if (query) {
          window.location.href = `/search?q=${encodeURIComponent(query)}`;
        }
      }
    });
  }

  // Translations arrive after the first render when i18n.js loads late
  window.addEventListener('languageChanged', () => {
    if (!searchResults) {
      // A too-short query shows a message without fetching: render it again translated
      if (searchQuery.trim().length < 2) performSearch(searchQuery);
      return;
    }
    renderHeader();
    renderTabs(searchResults.counts);
    renderResults();
  });

  // The game name of a live card leads to its page instead of the stream;
  // "View all" opens the section's tab, "View more" loads its next page
  function setupGameLinks() {
    document.getElementById('results-container').addEventListener('click', e => {
      const seeAll = e.target.closest('[data-see-all]');
      if (seeAll) return selectFilter(seeAll.dataset.seeAll);
      const loadMoreBtn = e.target.closest('[data-load-more]');
      if (loadMoreBtn) return loadMore(loadMoreBtn.dataset.loadMore);
      const link = e.target.closest('.game-link');
      if (!link) return;
      e.preventDefault();
      e.stopPropagation();
      window.location.href = '/games/' + encodeURIComponent(link.dataset.gameId);
    });
  }

  // Initialize
  document.addEventListener('DOMContentLoaded', () => {
    setupSearchInput();
    setupGameLinks();
    const query = getSearchQuery();
    performSearch(query);
  });
})();
