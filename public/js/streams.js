// Streams page - Display live streams from the randomizer community

const API_BASE = '';

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

let streamsShown = false; // a list is on screen: refreshes update it in place
let lastStreamsLoad = 0;

async function loadStreams() {
    const grid = document.getElementById('streams-grid');
    const noStreams = document.getElementById('no-streams');
    const countEl = document.getElementById('stream-count');
    lastStreamsLoad = Date.now();
    // show loading state (first load only, so auto-refresh does not blank the page)
    if (!streamsShown) try {
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

        
        if (!streams || streams.length === 0) {
            grid.innerHTML = '';
            grid.style.display = 'none';
            noStreams.style.display = 'block';
            const tr = (key, fallback) => (typeof i18n !== 'undefined' && i18n.t(key)) || fallback;
            noStreams.innerHTML = `
                <p class="no-streams-emoji">😴</p>
                <p class="no-streams-title">${escapeHtml(tr('streams.noStreams', 'No live streams at the moment'))}</p>
                <p class="no-streams-subtitle">${escapeHtml(tr('streams.checkRaces', 'Come back later or check the'))} <a href="/races.html">${escapeHtml(tr('streams.currentRaces', 'ongoing races'))}</a></p>
            `;
            countEl.textContent = formatStreamsCount(0);
            streamsShown = false;
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
            // The server gives the site's game id of each stream
            const gameSlug = stream.gameId && stream.gameId !== 'unknown' ? stream.gameId : '';

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
                    ${stream.gameName && !gameSlug ? `<div class="stream-game">🎮 ${escapeHtml(stream.gameName)}</div>` : ''}
                    ${stream.gameName && gameSlug ? `<div class="stream-game">🎮 <span class="game-link" data-game-id="${encodeURIComponent(gameSlug)}" style="overflow: hidden; text-overflow: ellipsis; display:inline-block; cursor:pointer; color:#60a5fa; transition: color 0.2s;">${escapeHtml(stream.gameName)}</span></div>` : ''}
                </div>
            </${cardTag}>
        `;
        }).join('');
        
        grid.style.display = 'grid';
        noStreams.style.display = 'none';
        streamsShown = true;
        
        // Populate game filter (keeps the selected game across refreshes)
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
            });
            gameLink.addEventListener('mouseleave', () => {
                gameLink.style.color = '#60a5fa';
            });
        });
        
    } catch (error) {
        console.error('Error loading streams:', error);
        // A failed auto-refresh keeps the streams already on screen
        if (streamsShown) return;
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

    const selected = filter.value;
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

    if (selected && games.includes(selected)) {
        filter.value = selected;
        filterStreams(selected);
    }
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

// Auto-refresh streams every 2 minutes, only while the tab is visible
const REFRESH_INTERVAL = 120000;
let refreshInterval;

function startAutoRefresh() {
    stopAutoRefresh();
    refreshInterval = setInterval(loadStreams, REFRESH_INTERVAL);
}

function stopAutoRefresh() {
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
    }
}

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        stopAutoRefresh();
        return;
    }
    // Back on the tab: refresh now if the list is out of date
    if (Date.now() - lastStreamsLoad >= REFRESH_INTERVAL) loadStreams();
    startAutoRefresh();
});

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    loadStreams();
    if (!document.hidden) startAutoRefresh();
});

// Clean up on page unload
window.addEventListener('beforeunload', stopAutoRefresh);
