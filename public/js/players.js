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

// Global IntersectionObserver instance (will be recreated on filter)
let avatarObserver = null;

// Cache for avatar URLs - using localStorage for persistence
const AVATAR_CACHE_KEY = 'randomizer_avatar_cache';
const AVATAR_CACHE_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

const avatarCache = {
  get(key) {
    try {
      const cache = JSON.parse(localStorage.getItem(AVATAR_CACHE_KEY) || '{}');
      const entry = cache[key];
      if (entry && entry.timestamp && (Date.now() - entry.timestamp < AVATAR_CACHE_EXPIRY)) {
        // Only return if it's a valid data URL (not a placeholder SVG with just initials)
        if (entry.data && entry.data.startsWith('data:image/') && entry.data.length > 500) {
          return entry.data;
        }
      }
      return null;
    } catch (e) {
      return null;
    }
  },
  set(key, data) {
    try {
      // Only cache real avatars (not placeholder SVGs)
      if (!data || data.length < 500) return;
      
      const cache = JSON.parse(localStorage.getItem(AVATAR_CACHE_KEY) || '{}');
      cache[key] = { data, timestamp: Date.now() };
      localStorage.setItem(AVATAR_CACHE_KEY, JSON.stringify(cache));
    } catch (e) {
      // Ignore cache errors (quota exceeded, etc.)
    }
  },
  has(key) {
    return this.get(key) !== null;
  }
};

// Cache for Twitch usernames extracted from Racetime profiles
const twitchUsernameCache = new Map();

// Queue system to limit concurrent avatar loads
let activeAvatarLoads = 0;
const MAX_CONCURRENT_LOADS = 6; // Limit to 6 concurrent avatar loads
const avatarLoadQueue = [];

async function queueAvatarLoad(img) {
  // If already at max capacity, queue it
  if (activeAvatarLoads >= MAX_CONCURRENT_LOADS) {
    return new Promise((resolve) => {
      avatarLoadQueue.push({ img, resolve });
    });
  }
  
  // Otherwise load immediately
  activeAvatarLoads++;
  try {
    await loadAvatarWithFallback(img);
  } finally {
    activeAvatarLoads--;
    
    // Process next in queue
    if (avatarLoadQueue.length > 0) {
      const next = avatarLoadQueue.shift();
      queueAvatarLoad(next.img).then(next.resolve);
    }
  }
}

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

// Helper to convert blob to data URL
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

// Try to fetch an image and return data URL or null
async function tryFetchImage(url, timeout = 8000) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    const res = await fetch(url, { 
      method: 'GET', 
      cache: 'default',
      signal: controller.signal 
    });
    
    clearTimeout(timeoutId);
    
    if (res.ok && res.status !== 204) {
      const ct = res.headers.get('Content-Type') || '';
      if (ct.indexOf('image/') === 0) {
        const blob = await res.blob();
        if (blob.size > 0) {
          return await blobToDataUrl(blob);
        }
      }
    }
  } catch (e) {
    // Timeout or network error
  }
  return null;
}

// Get Twitch username from Racetime profile (with cache)
async function getTwitchUsername(racetimeUrl, playerName) {
  const cacheKey = racetimeUrl || playerName;
  
  if (twitchUsernameCache.has(cacheKey)) {
    return twitchUsernameCache.get(cacheKey);
  }
  
  let profileUrl = racetimeUrl;
  
  // If no racetime URL, try to find the profile
  if (!profileUrl && playerName) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      
      const findRes = await fetch('/api/racetime/find?q=' + safeEncodeURIComponent(playerName), {
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      
      const findData = await findRes.json();
      if (findData.url) {
        profileUrl = findData.url;
      }
    } catch (e) {
      twitchUsernameCache.set(cacheKey, null);
      return null;
    }
  }
  
  if (!profileUrl) {
    twitchUsernameCache.set(cacheKey, null);
    return null;
  }
  
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    
    const twitchRes = await fetch('/api/racetime/twitch?url=' + safeEncodeURIComponent(profileUrl), {
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    
    const twitchData = await twitchRes.json();
    
    if (twitchData.twitch) {
      const twitchUser = twitchData.twitch.split('/').pop();
      twitchUsernameCache.set(cacheKey, twitchUser);
      return twitchUser;
    }
  } catch (e) {
    // Timeout or error
  }
  
  twitchUsernameCache.set(cacheKey, null);
  return null;
}

// Load avatar with cascade: Racetime → Twitch → Placeholder (optimized)
async function loadAvatarWithFallback(img) {
  const playerName = img.alt || '';
  const placeholder = img.getAttribute('data-placeholder') || img.src;
  let racetimeUrl = img.getAttribute('data-racetime-url');
  let twitchUsername = img.getAttribute('data-twitch') || '';
  
  // Check cache first
  const cached = avatarCache.get(playerName);
  if (cached) {
    img.src = cached;
    img.classList.add('avatar-loaded');
    return;
  }
  
  // Step 1: Try Racetime avatar
  if (racetimeUrl) {
    const racetimeAvatarUrl = '/api/racetime/avatar?url=' + safeEncodeURIComponent(racetimeUrl) + '&name=' + safeEncodeURIComponent(playerName);
    const avatarData = await tryFetchImage(racetimeAvatarUrl, 8000);
    
    if (avatarData) {
      img.src = avatarData;
      img.classList.add('avatar-loaded');
      avatarCache.set(playerName, avatarData);
      return;
    }
  }
  
  // Step 2: Get Twitch username if not provided (only if Racetime failed)
  if (!twitchUsername && racetimeUrl) {
    twitchUsername = await getTwitchUsername(racetimeUrl, playerName);
  }
  
  // Step 3: If no racetime URL, try to find profile and get avatar
  if (!racetimeUrl && playerName) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      
      const findRes = await fetch('/api/racetime/find?q=' + safeEncodeURIComponent(playerName), {
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      
      if (findRes.ok) {
        const findData = await findRes.json();
        
        if (findData.url) {
          racetimeUrl = findData.url;
          
          const racetimeAvatarUrl = '/api/racetime/avatar?url=' + safeEncodeURIComponent(findData.url) + '&name=' + safeEncodeURIComponent(playerName);
          const avatarData = await tryFetchImage(racetimeAvatarUrl, 8000);
          
          if (avatarData) {
            img.src = avatarData;
            img.classList.add('avatar-loaded');
            avatarCache.set(playerName, avatarData);
            return;
          }
          
          // Try to get Twitch username from found profile
          if (!twitchUsername) {
            twitchUsername = await getTwitchUsername(findData.url, playerName);
          }
        }
      }
    } catch (e) {
      // Continue to next step
    }
  }
  
  // Step 4: Try Twitch avatar
  if (twitchUsername) {
    const twitchAvatarUrl = '/api/streams/twitch-avatar/' + safeEncodeURIComponent(twitchUsername);
    const avatarData = await tryFetchImage(twitchAvatarUrl, 8000);
    
    if (avatarData) {
      img.src = avatarData;
      img.classList.add('avatar-loaded');
      avatarCache.set(playerName, avatarData);
      return;
    }
  }
  
  // Fallback: Use placeholder (don't cache placeholders)
  img.src = placeholder;
  img.classList.add('avatar-loaded');
}

// Render players to the list
function renderPlayers(players, prioritizeAvatars = false) {
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
    
    // Avatar setup: first letter or digit, so "(DX)Oblast" shows "D" rather than "("
    const initialMatch = String(player.name || '').match(/[\p{L}\p{N}]/u);
    const initial = initialMatch ? initialMatch[0].toUpperCase() : '?';
    const lastRace = player.lastRaceAt
      ? tr('players.lastRace', 'Last race: {date}', { date: new Date(player.lastRaceAt).toLocaleDateString(pageLocale(), { day: 'numeric', month: 'short', year: 'numeric' }) })
      : '';
    const placeholder = 'data:image/svg+xml,' + safeEncodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#374151"/><text x="50%" y="50%" dy=".35em" font-size="48" fill="#fbbf24" text-anchor="middle">' + initial + '</text></svg>');
    
    // Get Racetime URL if available
    const racetimeUrl = player.racetimeUrl ? player.racetimeUrl.replace(/\/+$/, '') : (player.racetimeId ? 'https://racetime.gg/user/' + safeEncodeURIComponent(player.racetimeId) : '');
    
    // Get Twitch username if available (from player data)
    const twitchUsername = player.twitchUsername || player.twitch || '';

    return `
      <div class="player-card" data-player-name="${safeEncodeURIComponent(player.name)}" style="background-color: #1f2937; padding: 1.5rem; border-radius: 0.5rem; transition: background-color 0.2s; cursor: pointer; aspect-ratio: 1/1; display: flex; flex-direction: column; align-items: center;">
        <h3 style="font-size: 1.1rem; font-weight: bold; color: white; margin-bottom: 0.75rem; text-align: center;">${escHtml(player.name)}</h3>
        
        <img class="rt-avatar" 
             src="${placeholder}" 
             alt="${escHtml(player.name)}" 
             data-placeholder="${placeholder}"
             data-racetime-url="${escHtml(racetimeUrl)}"
             data-twitch="${escHtml(twitchUsername)}"
             style="width:120px;height:120px;border-radius:50%;margin-bottom:1rem;object-fit:cover;background:#374151;display:block;transition:opacity 0.2s;">
        
        <div style="display: flex; flex-direction: column; gap: 0.25rem; width: 100%; overflow: hidden;">
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
  
  // Setup lazy loading for avatars (prioritize if filtering)
  setupAvatarLazyLoading(list, prioritizeAvatars);
  
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

function setupAvatarLazyLoading(list, prioritize = false) {
  // Disconnect previous observer
  if (avatarObserver) {
    avatarObserver.disconnect();
    avatarObserver = null;
  }
  
  const avatarImgs = list.querySelectorAll('img.rt-avatar:not(.avatar-loaded)');
  
  if (prioritize) {
    // When filtering, load all visible avatars with queue (small number)
    avatarImgs.forEach(img => {
      queueAvatarLoad(img);
    });
  } else if ('IntersectionObserver' in window) {
    // Normal mode: lazy load with IntersectionObserver + queue
    avatarObserver = new IntersectionObserver((entries, obs) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          queueAvatarLoad(entry.target);
          obs.unobserve(entry.target);
        }
      });
    }, { rootMargin: '300px' });
    
    avatarImgs.forEach(img => avatarObserver.observe(img));
  } else {
    // Fallback: load all with queue
    avatarImgs.forEach(img => queueAvatarLoad(img));
  }
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

  // Prioritize avatar loading for filtered results (smaller set)
  renderPlayers(shown, Boolean(normalizedQuery));
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
