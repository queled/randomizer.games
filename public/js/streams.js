// Streams page - Display live streams from the randomizer community

const API_BASE = '';
const GAME_MAP_CACHE_KEY = 'randomizer_streams_game_map_v1';
const GAME_MAP_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h
let gameMapMemory = null;
let gameMapInFlight = null;

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

async function loadStreams() {
    const grid = document.getElementById('streams-grid');
    const noStreams = document.getElementById('no-streams');
    const countEl = document.getElementById('stream-count');
    // show loading state
    try {
        grid.style.display = 'none';
        noStreams.style.display = 'block';
        noStreams.innerHTML = `<p style="color:#9ca3af;">${typeof i18n !== 'undefined' ? i18n.t('streams.loadingStreams') : 'Loading streams...'}</p>`;
        countEl.textContent = formatStreamsCount(0);
    } catch (e) {
        // ignore if elements missing
    }
    
    try {
        // Fetch live streams from API
        const res = await fetch(`${API_BASE}/api/streams`);
        
        if (!res.ok) {
            throw new Error('Failed to fetch streams');
        }
        
        const data = await res.json();
        const streams = data.streams || [];

        // Use cached game mapping if available (non-blocking for first render)
        const gameMap = getCachedGameMap();
        
        if (!streams || streams.length === 0) {
            grid.style.display = 'none';
            noStreams.style.display = 'block';
            countEl.textContent = formatStreamsCount(0);
            return;
        }
        
        countEl.textContent = formatStreamsCount(streams.length);
        
        grid.innerHTML = streams.map(stream => {
            const proxyUrl = stream.thumbnailUrl ? `/api/proxy-image?url=${encodeURIComponent(stream.thumbnailUrl)}` : '';
            const safeStreamUrl = sanitizeExternalUrl(stream.url);
            const cardTag = safeStreamUrl ? 'a' : 'div';
            const cardAttrs = safeStreamUrl
                ? `href="${escapeHtml(safeStreamUrl)}" target="_blank" rel="noopener noreferrer"`
                : '';
            // Resolve game id using the gameMap fallbacking to slugified name
            const rawName = (stream.gameName || '').trim();
            const resolved = resolveGameIdFromName(rawName, gameMap);
            const gameSlug = resolved || '';

            return `
            <${cardTag}${cardAttrs ? ' ' + cardAttrs : ''} class="stream-card">
                <div class="stream-thumbnail">
                    <img src="${proxyUrl}" 
                         alt="${escapeHtml(stream.title || '')}" 
                         loading="lazy"
                         data-fallback-src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27320%27 height=%27180%27%3E%3Crect fill=%27%23374151%27 width=%27320%27 height=%27180%27/%3E%3Ctext x=%2750%25%27 y=%2750%25%27 font-size=%2740%27 fill=%27%236b7280%27 text-anchor=%27middle%27 dy=%27.3em%27%3E📺%3C/text%3E%3C/svg%3E">
                    <span class="stream-live-badge">${typeof i18n !== 'undefined' ? i18n.t('streams.live') : 'LIVE'}</span>
                    ${stream.viewerCount ? `<span class="stream-viewers">👁 ${formatViewers(stream.viewerCount)}</span>` : ''}
                </div>
                <div class="stream-info">
                    <div class="stream-title">${escapeHtml(stream.title || 'Sans titre')}</div>
                    <div class="stream-channel">${escapeHtml(stream.userName || stream.userLogin || 'Unknown')}</div>
                    ${stream.gameName ? `<div class="stream-game">🎮 <span class="game-link" data-game-id="${encodeURIComponent(gameSlug)}" style="overflow: hidden; text-overflow: ellipsis; display:inline-block; cursor:pointer; text-decoration:underline; color:#60a5fa; transition: color 0.2s, text-decoration-color 0.2s;">${escapeHtml(stream.gameName)}</span></div>` : ''}
                </div>
            </${cardTag}>
        `;
        }).join('');
        
        grid.style.display = 'grid';
        noStreams.style.display = 'none';
        
        // Populate game filter
        populateGameFilter(streams);

        // Attach click + hover handlers to game links inside stream cards
        document.querySelectorAll('.stream-card .game-link').forEach(gameLink => {
            gameLink.addEventListener('click', (e) => {
                // Prevent following the outer stream link
                e.preventDefault();
                e.stopPropagation();
                const gameId = gameLink.getAttribute('data-game-id');
                if (gameId) {
                    window.location.href = '/game-detail.html?id=' + gameId;
                }
            });
            gameLink.addEventListener('mouseenter', () => {
                gameLink.style.color = '#fbbf24';
                gameLink.style.textDecorationColor = '#fbbf24';
            });
            gameLink.addEventListener('mouseleave', () => {
                gameLink.style.color = '#60a5fa';
                gameLink.style.textDecorationColor = '#60a5fa';
            });
        });

        // Refresh game IDs in background if cache missing/stale
        ensureGameMapLoaded().then(freshMap => {
            hydrateGameLinks(freshMap);
        }).catch(() => {});
        
    } catch (error) {
        console.error('Error loading streams:', error);
        grid.innerHTML = '';
        noStreams.innerHTML = `
            <p style="font-size: 1.5rem; margin-bottom: 0.5rem;">⚠️</p>
            <p style="font-size: 1.1rem; margin-bottom: 0.5rem;">${typeof i18n !== 'undefined' ? i18n.t('streams.loadError') : 'Unable to load streams'}</p>
            <p style="font-size: 0.875rem;">${typeof i18n !== 'undefined' ? i18n.t('streams.comeBackLater') : 'Come back later or check the'} <a href="/races.html" style="color: #fbbf24;">${typeof i18n !== 'undefined' ? i18n.t('streams.currentRaces') : 'ongoing races'}</a></p>
        `;
        noStreams.style.display = 'block';
        grid.style.display = 'none';
        countEl.textContent = (typeof i18n !== 'undefined' && typeof i18n.t === 'function') ? i18n.t('common.error') : 'Error';
    }
}

function formatViewers(count) {
    if (count >= 1000000) {
        return (count / 1000000).toFixed(1) + 'M';
    } else if (count >= 1000) {
        return (count / 1000).toFixed(1) + 'K';
    }
    return count.toString();
}

function formatStreamsCount(n) {
    if (typeof i18n !== 'undefined' && typeof i18n.t === 'function') {
        const txt = i18n.t('streams.streamsLive') || '';
        const parts = txt.split('|').map(s => s.trim());
        const label = (n === 1) ? (parts[0] || parts[1] || txt) : (parts[1] || parts[0] || txt);
        return `${n} ${label}`;
    }
    return `${n} live stream${n > 1 ? 's' : ''}`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function populateGameFilter(streams) {
    const filter = document.getElementById('filter-game');
    if (!filter) return;

    const defaultOption = filter.querySelector('option[value=""]');
    filter.innerHTML = '';
    if (defaultOption) {
        filter.appendChild(defaultOption);
    }
    
    const games = [...new Set(streams.map(s => s.gameName).filter(Boolean))].sort();
    
    games.forEach(game => {
        const option = document.createElement('option');
        option.value = game;
        option.textContent = game;
        filter.appendChild(option);
    });
    
    filter.onchange = () => filterStreams(filter.value);
}

function getCachedGameMap() {
    if (gameMapMemory) return gameMapMemory;
    try {
        const raw = localStorage.getItem(GAME_MAP_CACHE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (!parsed || !parsed.map || !parsed.timestamp) return {};
        if ((Date.now() - parsed.timestamp) > GAME_MAP_CACHE_TTL) return {};
        gameMapMemory = parsed.map;
        return gameMapMemory;
    } catch (e) {
        return {};
    }
}

function setCachedGameMap(map) {
    if (!map || typeof map !== 'object') return;
    gameMapMemory = map;
    try {
        localStorage.setItem(GAME_MAP_CACHE_KEY, JSON.stringify({
            timestamp: Date.now(),
            map
        }));
    } catch (e) {
        // Ignore cache write errors
    }
}

async function ensureGameMapLoaded() {
    const cached = getCachedGameMap();
    if (cached && Object.keys(cached).length > 0) {
        return cached;
    }

    if (gameMapInFlight) {
        return gameMapInFlight;
    }

    gameMapInFlight = buildGameMap()
        .then(map => {
            setCachedGameMap(map);
            return map;
        })
        .finally(() => {
            gameMapInFlight = null;
        });

    return gameMapInFlight;
}

function hydrateGameLinks(gameMap) {
    if (!gameMap || typeof gameMap !== 'object') return;
    document.querySelectorAll('.stream-card .game-link').forEach(gameLink => {
        const currentId = gameLink.getAttribute('data-game-id');
        if (currentId) return;
        const rawName = (gameLink.textContent || '').trim();
        const resolved = resolveGameIdFromName(rawName, gameMap);
        if (resolved) {
            gameLink.setAttribute('data-game-id', encodeURIComponent(resolved));
        }
    });
}

// Fetch games list and build a lookup map from possible display names -> id
async function buildGameMap() {
    try {
        const res = await fetch('/api/games');
        if (!res.ok) return {};
        const j = await res.json();
        const games = j.games || [];
        const map = {};
        const slugify = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        for (const g of games) {
            const id = (g.id || '').toLowerCase();
            const names = new Set();
            if (g.name) names.add(g.name.trim().toLowerCase());
            if (g.officialName) names.add(g.officialName.trim().toLowerCase());
            if (g.randomizer?.shortName) names.add(g.randomizer.shortName.trim().toLowerCase());
            // slugified variants
            names.add(slugify(g.name || ''));
            names.add(slugify(g.officialName || ''));
            names.add(slugify(g.randomizer?.shortName || ''));
            names.add(id);
            // add entries
            for (const n of names) {
                if (!n) continue;
                map[n] = id;
            }
        }
        return map;
    } catch (e) {
        return {};
    }
}

function resolveGameIdFromName(name, map) {
    if (!name) return null;
    const slugify = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const lookupKeys = [
        name.trim().toLowerCase(),
        slugify(name),
    ];
    for (const k of lookupKeys) {
        if (k && map[k]) return map[k];
    }
    // fallback: try partial match (startsWith) on map keys
    const lower = name.trim().toLowerCase();
    for (const key in map) {
        if (!key) continue;
        if (key.indexOf(lower) !== -1 || lower.indexOf(key) !== -1) return map[key];
    }
    return null;
}

function filterStreams(game) {
    const cards = document.querySelectorAll('.stream-card');
    
    cards.forEach(card => {
        const cardGame = card.querySelector('.stream-game')?.textContent.replace('🎮 ', '') || '';
        
        if (!game || cardGame === game) {
            card.style.display = 'block';
        } else {
            card.style.display = 'none';
        }
    });
}

// Auto-refresh streams every 2 minutes
let refreshInterval;

function startAutoRefresh() {
    refreshInterval = setInterval(loadStreams, 120000);
}

function stopAutoRefresh() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    loadStreams();
    startAutoRefresh();
});

// Clean up on page unload
window.addEventListener('beforeunload', stopAutoRefresh);
