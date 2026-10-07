(function() {
  // Get search query from URL
  function getSearchQuery() {
    const params = new URLSearchParams(window.location.search);
    return params.get('q') || '';
  }

  // Game slug to display name mapping
  const gameDisplayNames = {
    'oot': 'Ocarina of Time',
    'ootr': 'Ocarina of Time',
    'alttp': 'A Link to the Past',
    'alttpr': 'A Link to the Past',
    'mm': 'Majora\'s Mask',
    'mmr': 'Majora\'s Mask',
    'sm': 'Super Metroid',
    'smr': 'Super Metroid',
    'sm64': 'Super Mario 64',
    'dk64': 'Donkey Kong 64',
    'dk64r': 'Donkey Kong 64',
    'tww': 'Wind Waker',
    'tp': 'Twilight Princess',
    'kh2fm': 'Kingdom Hearts 2 FM',
    'kh2r': 'Kingdom Hearts 2 FM',
    'kh2fmr': 'Kingdom Hearts 2 FM',
    'sotn': 'Symphony of the Night',
    'smz3': 'SMZ3 Combo',
    'ootmm': 'OoT+MM Combo'
  };

  function getGameDisplayName(slug) {
    if (!slug) return 'Inconnu';
    return gameDisplayNames[slug.toLowerCase()] || slug;
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
      { id: 'all', label: 'Tous', count: counts.total },
      { id: 'games', label: 'Jeux', count: counts.games },
      { id: 'races', label: 'Races', count: counts.races },
      { id: 'tournaments', label: 'Tournois', count: counts.tournaments },
      { id: 'players', label: 'Joueurs', count: counts.players }
    ];

    tabsContainer.innerHTML = tabs.map(tab => `
      <button class="search-tab ${currentFilter === tab.id ? 'active' : ''}" data-filter="${tab.id}">
        ${tab.label}<span class="count">${tab.count}</span>
      </button>
    `).join('');

    // Add click handlers
    tabsContainer.querySelectorAll('.search-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        currentFilter = btn.dataset.filter;
        renderTabs(counts);
        renderResults();
      });
    });
  }

  // Render game card
  function renderGameCard(game) {
    return `
      <a href="/game-detail.html?id=${encodeURIComponent(game.id)}" class="result-card">
        <div class="title">${highlightText(game.officialName || game.name, searchQuery)}</div>
        <div class="subtitle">${escHtml(game.id)}</div>
      </a>
    `;
  }

  // Render tournament card
  function renderTournamentCard(tournament) {
    return `
      <a href="/tournament-detail.html?id=${encodeURIComponent(tournament._id)}" class="result-card">
        <div class="title">${highlightText(tournament.name, searchQuery)}</div>
        <div class="subtitle">${highlightText(tournament.gameName || '', searchQuery)}</div>
        <div class="meta">
          <span>📅 ${formatDate(tournament.startDate)}</span>
          <span>👥 ${tournament.participantCount || 0} participants</span>
        </div>
      </a>
    `;
  }

  // Render race card
  function renderRaceCard(race) {
    const statusClass = race.status === 'finished' ? 'status-finished' : 
                        race.status === 'open' ? 'status-open' : '';
    const statusText = race.status === 'finished' ? 'Terminée' : 
                       race.status === 'open' ? 'Ouverte' : 
                       race.status === 'in_progress' ? 'En cours' : race.status;
    
    return `
      <a href="/race-detail.html?id=${encodeURIComponent(race._id)}" class="result-card">
        <div class="title">${highlightText(race.goal || race.name, searchQuery)}</div>
        <div class="subtitle">
          <span class="badge game">${escHtml(getGameDisplayName(race.category))}</span>
          <span class="badge ${statusClass}">${escHtml(statusText)}</span>
        </div>
        <div class="meta">
          <span>📅 ${formatDate(race.startedAt)}</span>
          <span>👥 ${race.entrantCount || 0} participants</span>
        </div>
      </a>
    `;
  }

  // Render player card
  function renderPlayerCard(player) {
    const gamesHtml = player.games && player.games.length > 0 
      ? `<div class="player-games">${player.games.slice(0, 4).map(g => 
          `<span class="game-tag">${escHtml(getGameDisplayName(g))}</span>`
        ).join('')}${player.games.length > 4 ? `<span class="game-tag">+${player.games.length - 4}</span>` : ''}</div>`
      : '';
    
    return `
      <a href="/player-detail.html?name=${encodeURIComponent(player.name)}" class="result-card">
        <div class="title">${highlightText(player.name, searchQuery)}</div>
        ${player.racetimeId ? `<div class="subtitle">Racetime: ${escHtml(player.racetimeId)}</div>` : ''}
        ${gamesHtml}
      </a>
    `;
  }

  // Render a section of results
  function renderSection(title, icon, items, renderFn, count) {
    if (!items || items.length === 0) return '';
    
    return `
      <div class="results-section">
        <div class="section-header">
          <span class="section-count">${count}</span>
          <span class="section-title">${icon} ${title}</span>
        </div>
        <div class="results-grid">
          ${items.map(renderFn).join('')}
        </div>
      </div>
    `;
  }

  // Render all results
  function renderResults() {
    const container = document.getElementById('results-container');
    
    if (!searchResults) {
      container.innerHTML = '<div class="loading">Loading results...</div>';
      return;
    }

    const { results, counts } = searchResults;
    
    if (counts.total === 0) {
      container.innerHTML = `
        <div class="no-results">
          <div class="no-results-icon">🔍</div>
          <div>No results found for "<strong>${escHtml(searchQuery)}</strong>"</div>
          <div style="margin-top: 0.5rem; font-size: 0.9rem;">Essayez avec d'autres termes de recherche</div>
        </div>
      `;
      return;
    }

    let html = '';

    // Show sections based on filter
    if (currentFilter === 'all' || currentFilter === 'games') {
      html += renderSection('Jeux', '🎮', results.games, renderGameCard, counts.games);
    }
    
    if (currentFilter === 'all' || currentFilter === 'races') {
      html += renderSection('Races', '🥇', results.races, renderRaceCard, counts.races);
    }
    
    if (currentFilter === 'all' || currentFilter === 'tournaments') {
      html += renderSection('Tournois', '🏆', results.tournaments, renderTournamentCard, counts.tournaments);
    }
    
    if (currentFilter === 'all' || currentFilter === 'players') {
      html += renderSection('Joueurs', '👤', results.players, renderPlayerCard, counts.players);
    }

    if (!html) {
      html = `
        <div class="no-results">
          <div class="no-results-icon">📭</div>
          <div>No results in this category</div>
        </div>
      `;
    }

    container.innerHTML = html;
  }

  // Perform search
  async function performSearch(query) {
    searchQuery = query;
    
    // Update header
    document.getElementById('search-query').textContent = query || 'Recherche';
    document.getElementById('search-subtitle').textContent = 'SEARCH RESULTS';
    
    // Update search input
    const searchInput = document.getElementById('search');
    if (searchInput) searchInput.value = query;

    if (!query || query.trim().length < 2) {
      document.getElementById('results-container').innerHTML = `
        <div class="no-results">
          <div class="no-results-icon">🔍</div>
          <div>Enter at least 2 characters to search</div>
        </div>
      `;
      document.getElementById('search-tabs').innerHTML = '';
      return;
    }

    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=20`);
      if (!response.ok) throw new Error('Search failed');
      
      searchResults = await response.json();
      
      // Update subtitle with count
      document.getElementById('search-subtitle').textContent = 
        `${searchResults.counts.total} SEARCH RESULTS`;
      
      renderTabs(searchResults.counts);
      renderResults();
      
    } catch (error) {
      console.error('Search error:', error);
      document.getElementById('results-container').innerHTML = `
        <div class="no-results">
          <div class="no-results-icon">❌</div>
          <div>Search error</div>
          <div style="margin-top: 0.5rem; font-size: 0.9rem;">Please try again later</div>
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
          window.location.href = `/search.html?q=${encodeURIComponent(query)}`;
        }
      }
    });
  }

  // Initialize
  document.addEventListener('DOMContentLoaded', () => {
    setupSearchInput();
    const query = getSearchQuery();
    performSearch(query);
  });
})();
