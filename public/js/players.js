// Store all players globally for filtering
let allPlayers = [];

// i18n.js loads async: English until it is ready
function tr(key, fallback, params = {}) {
  if (window.i18n && typeof window.i18n.t === 'function') return window.i18n.t(key, params, fallback);
  return fallback.replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m));
}

function pageLocale() {
  return (window.i18n && window.i18n.getLanguage) ? window.i18n.getLanguage() : undefined;
}

const playerSorts = {
  // Players who raced most recently first, the most useful view for a visitor
  recent: (a, b) => (new Date(b.lastRaceAt || 0) - new Date(a.lastRaceAt || 0)) || a.name.localeCompare(b.name),
  races: (a, b) => ((b.totalRaces || 0) - (a.totalRaces || 0)) || a.name.localeCompare(b.name),
  name: (a, b) => a.name.localeCompare(b.name)
};

// Debounce helper to avoid filtering on every keystroke
function debounce(fn, delay) {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

function toWellFormedString(value) {
  const str = String(value == null ? '' : value);
  if (typeof str.toWellFormed === 'function') {
    return str.toWellFormed();
  }

  let out = '';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const isHigh = code >= 0xD800 && code <= 0xDBFF;
    const isLow = code >= 0xDC00 && code <= 0xDFFF;

    if (isHigh) {
      const next = str.charCodeAt(i + 1);
      const nextIsLow = next >= 0xDC00 && next <= 0xDFFF;
      if (nextIsLow) {
        out += str[i] + str[i + 1];
        i += 1;
      } else {
        out += '\uFFFD';
      }
      continue;
    }

    if (isLow) {
      out += '\uFFFD';
      continue;
    }

    out += str[i];
  }

  return out;
}

function safeEncodeURIComponent(value) {
  try {
    return encodeURIComponent(toWellFormedString(value));
  } catch (e) {
    return encodeURIComponent(String(value == null ? '' : value).replace(/[\uD800-\uDFFF]/g, ''));
  }
}

// Render players to the list
function renderPlayers(players) {
  const list = document.getElementById('players-list');
  
  if (!players || players.length === 0) {
    const noResults = (typeof i18n !== 'undefined' && typeof i18n.t === 'function') 
      ? i18n.t('common.noResults') 
      : 'No players found';
    list.innerHTML = `<div class="loading">${noResults}</div>`;
    return;
  }

  list.innerHTML = players.map(player => {
    // Use racesByGame from API (already sorted by count desc, limited to 3)
    const racesByGame = player.racesByGame || [];
    
    // Avatar setup: first letter or digit, so "(AB)Name" shows "A" rather than "("
    const initialMatch = String(player.name || '').match(/[\p{L}\p{N}]/u);
    const initial = initialMatch ? initialMatch[0].toUpperCase() : '?';
    const lastRace = player.lastRaceAt
      ? tr('players.lastRace', 'Last race: {date}', { date: new Date(player.lastRaceAt).toLocaleDateString(pageLocale(), { day: 'numeric', month: 'short', year: 'numeric' }) })
      : '';
    const placeholder = 'data:image/svg+xml,' + safeEncodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#374151"/><text x="50%" y="50%" dy=".35em" font-size="48" fill="#fbbf24" text-anchor="middle">' + initial + '</text></svg>');
    
    // racetime avatar, else Twitch avatar (one request, cached by the browser); the placeholder on failure
    const racetimeAccount = player.racetimeId || player.racetimeUrl || '';
    const twitchUsername = player.twitch || '';
    const avatarSrc = (racetimeAccount || twitchUsername)
      ? '/api/avatar?racetime=' + safeEncodeURIComponent(racetimeAccount) + '&twitch=' + safeEncodeURIComponent(twitchUsername)
      : placeholder;

    return `
      <div class="player-card" data-player-name="${safeEncodeURIComponent(player.name)}" style="background-color: #1f2937; padding: 1.5rem; border-radius: 0.5rem; transition: background-color 0.2s; cursor: pointer; aspect-ratio: 1/1; display: flex; flex-direction: column; align-items: center;">
        <h3 style="font-size: 1.1rem; font-weight: bold; color: white; margin-bottom: 0.75rem; text-align: center;">${escHtml(player.name)}</h3>
        
        <img class="rt-avatar" 
             src="${escHtml(avatarSrc)}" 
             alt="${escHtml(player.name)}" 
             loading="lazy"
             width="120" height="120"
             data-fallback-src="${escHtml(placeholder)}"
             style="width:120px;height:120px;border-radius:50%;margin-bottom:1rem;object-fit:cover;background:#374151;display:block;transition:opacity 0.2s;">
        
        <div style="display: flex; flex-direction: column; gap: 0.25rem; width: 100%; overflow: hidden; flex-shrink: 0;">
          ${racesByGame.length > 0 ? racesByGame.map(game => {
            const rawSlug = (game.gameId || game.slug || game.id || game.gameSlug || '').toLowerCase();
            const slugAliases = {
              'ootr': 'oot',
              'ocarina-of-time-randomizer': 'oot',
              'alttpr': 'alttp',
              'alttp-r': 'alttp',
              'smr': 'sm',
              'smrando': 'sm',
              'mmr': 'mm',
              'mmrando': 'mm',
              'twwr': 'tww',
              'wind-waker-randomizer': 'tww',
              'kh2fm': 'kh2fm',
              'kh2fmr': 'kh2fm',
              'kh2r': 'kh2fm',
              'kh2-rando': 'kh2fm',
              'kh2': 'kh2fm',
              'smz3r': 'smz3',
              'ootmmr': 'ootmm',
              'dk64r': 'dk64'
            };
            const gameSlug = slugAliases[rawSlug] || rawSlug;
            return `
              <div style="font-size: 0.75rem; color: #d1d5db; font-weight: 500; display: flex; align-items: center; white-space: nowrap; overflow: hidden;">
                <span class="game-link" data-game-id="${safeEncodeURIComponent(gameSlug)}" style="overflow: hidden; text-overflow: ellipsis; flex: 1 1 auto; min-width: 0; cursor: pointer; color: #60a5fa; transition: color 0.2s;">${escHtml(game.gameName)}</span>
                <span style="color: #10b981; font-weight: bold; margin-left: 0.5ch; flex-shrink: 0; flex-grow: 0;">(${game.count})</span>
              </div>
            `;
          }).join('') : ``}
        </div>
        ${lastRace ? `<div style="margin-top: auto; padding-top: 0.5rem; font-size: 0.75rem; color: #9ca3af;">${escHtml(lastRace)}</div>` : ''}
      </div>
    `;
  }).join('');
  
  // Attach event listeners for player cards and game links
  attachPlayerCardListeners(list);
  
  // Add hover effect
  setupHoverEffects();
}

function attachPlayerCardListeners(list) {
  list.querySelectorAll('.player-card').forEach(card => {
    const playerName = card.getAttribute('data-player-name');
    
    card.addEventListener('click', (e) => {
      if (!e.target.classList.contains('game-link')) {
        window.location.href = '/player-detail.html?name=' + playerName;
      }
    });
    
    card.querySelectorAll('.game-link').forEach(gameLink => {
      gameLink.addEventListener('click', (e) => {
        e.stopPropagation();
        const gameId = gameLink.getAttribute('data-game-id');
        window.location.href = '/game-detail.html?id=' + gameId;
      });

      gameLink.addEventListener('mouseenter', () => {
        gameLink.style.color = '#fbbf24';
      });
      gameLink.addEventListener('mouseleave', () => {
        gameLink.style.color = '#60a5fa';
      });
    });
  });
}

function setupHoverEffects() {
  document.querySelectorAll('.player-card').forEach(card => {
    card.addEventListener('mouseover', () => {
      card.style.backgroundColor = '#374151';
    });
    card.addEventListener('mouseout', () => {
      card.style.backgroundColor = '#1f2937';
    });
  });
}

// Filter by the search box, sort by the selected order, render and count
function filterPlayers(query) {
  const searchInput = document.getElementById('player-search');
  const normalizedQuery = (query != null ? query : (searchInput ? searchInput.value : '')).trim().toLowerCase();
  const sortSelect = document.getElementById('player-sort');
  const compare = playerSorts[sortSelect ? sortSelect.value : 'recent'] || playerSorts.recent;

  const filtered = normalizedQuery
    ? allPlayers.filter(player => (player.name || '').toLowerCase().includes(normalizedQuery))
    : allPlayers;
  const shown = [...filtered].sort(compare);

  const countEl = document.getElementById('players-count');
  if (countEl) {
    const fmt = (n) => n.toLocaleString(pageLocale());
    countEl.textContent = shown.length === allPlayers.length
      ? tr('players.count', '{count} players', { count: fmt(allPlayers.length) })
      : tr('players.countFiltered', '{count} of {total} players', { count: fmt(shown.length), total: fmt(allPlayers.length) });
  }

  renderPlayers(shown);
}

// Debounced filter function (150ms delay)
const debouncedFilter = debounce(filterPlayers, 150);

async function loadPlayers() {
  try {
    const response = await fetch('/api/players');
    const data = await response.json();
    
    if (!data.players || data.players.length === 0) {
      document.getElementById('players-list').innerHTML = '<div class="loading">No players found</div>';
      return;
    }

    
    
    // Store all players for filtering
    allPlayers = data.players;
    
    // Initial render
    filterPlayers('');

    const sortSelect = document.getElementById('player-sort');
    if (sortSelect) sortSelect.addEventListener('change', () => filterPlayers());
    // Count and dates arrive with the translations
    window.addEventListener('languageChanged', () => filterPlayers());
    
    // Setup search input listener
    const searchInput = document.getElementById('player-search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        debouncedFilter(e.target.value);
      });
      
      // Clear filter on Escape
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          searchInput.value = '';
          filterPlayers('');
        }
      });
    }

    // Clear search input when returning to page (via back button)
    window.addEventListener('pageshow', (e) => {
      if (e.persisted && searchInput) {
        searchInput.value = '';
        filterPlayers('');
      }
    });
    
  } catch (error) {
    console.error('Error:', error);
    const errText = (typeof i18n !== 'undefined' && typeof i18n.t === 'function') ? i18n.t('common.error') : 'Loading error';
    document.getElementById('players-list').innerHTML = `<div class="loading">${escHtml(errText)}</div>`;
  }
}

document.addEventListener('DOMContentLoaded', loadPlayers);
