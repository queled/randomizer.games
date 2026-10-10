// games.js
// Affiche la liste des jeux avec tri
document.addEventListener('DOMContentLoaded', async () => {
  const grid = document.getElementById('games-grid');
  const sortSelect = document.getElementById('sort-select');
  
  const loadingText = (typeof i18n !== 'undefined' && typeof i18n.t === 'function') 
    ? i18n.t('common.loading', {}, 'Loading...')
    : 'Loading...';
  grid.innerHTML = `<div class="loading">${loadingText}</div>`;
  
  // Store games data and stream stats globally for sorting
  let gamesData = [];
  let streamStats = {}; // { gameId: { streamers: number, viewers: number } }
  
  // Canonical display names for certain games
  const CANONICAL_GAME_NAMES = {
    'kh2fm': 'Kingdom Hearts II Final Mix',
    'kh2r': 'Kingdom Hearts II Final Mix',
    'kh2fmr': 'Kingdom Hearts II Final Mix'
  };
  
  function getGameImage(game) {
    // Utiliser game.image ou game.logo, ou construire depuis l'ID
    let image = game.image || game.logo;
    if (!image || !image.startsWith('assets/')) {
      // Fallback: construire depuis l'ID du jeu
      const id = (game.id || '').toLowerCase();
      image = `/assets/${id}.png`;
    } else if (!image.startsWith('/')) {
      // Ajouter le / si nécessaire
      image = `/${image}`;
    }
    return image;
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
  
  function sortGames(games, sortBy) {
    const sorted = [...games];
    switch (sortBy) {
      case 'name-asc':
        sorted.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        break;
      case 'streamers-desc':
        sorted.sort((a, b) => (streamStats[b.id]?.streamers || 0) - (streamStats[a.id]?.streamers || 0));
        break;
      case 'streamers-asc':
        sorted.sort((a, b) => (streamStats[a.id]?.streamers || 0) - (streamStats[b.id]?.streamers || 0));
        break;
      case 'viewers-desc':
        sorted.sort((a, b) => (streamStats[b.id]?.viewers || 0) - (streamStats[a.id]?.viewers || 0));
        break;
      case 'viewers-asc':
        sorted.sort((a, b) => (streamStats[a.id]?.viewers || 0) - (streamStats[b.id]?.viewers || 0));
        break;
      case 'races-desc':
        sorted.sort((a, b) => (b.totalRaces || 0) - (a.totalRaces || 0));
        break;
      case 'races-asc':
        sorted.sort((a, b) => (a.totalRaces || 0) - (b.totalRaces || 0));
        break;
      case 'tournaments-desc':
        sorted.sort((a, b) => (b.totalTournaments || 0) - (a.totalTournaments || 0));
        break;
      case 'tournaments-asc':
        sorted.sort((a, b) => (a.totalTournaments || 0) - (b.totalTournaments || 0));
        break;
      case 'release-desc':
        sorted.sort((a, b) => {
          const dateA = a.releaseDate ? new Date(a.releaseDate) : new Date(0);
          const dateB = b.releaseDate ? new Date(b.releaseDate) : new Date(0);
          return dateB - dateA;
        });
        break;
      case 'release-asc':
        sorted.sort((a, b) => {
          const dateA = a.releaseDate ? new Date(a.releaseDate) : new Date('9999-12-31');
          const dateB = b.releaseDate ? new Date(b.releaseDate) : new Date('9999-12-31');
          return dateA - dateB;
        });
        break;
      default:
        sorted.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    }
    return sorted;
  }
  
  function renderGames(games) {
    if (!games.length) {
      const noGamesText = (typeof i18n !== 'undefined' && typeof i18n.t === 'function')
        ? i18n.t('common.noGamesFound', {}, 'No games found')
        : 'No games found';
      grid.innerHTML = `<div class="loading">${noGamesText}</div>`;
      return;
    }
    
    grid.innerHTML = games.map(game => {
      const id = (game.id || '').toLowerCase();
      const image = getGameImage(game);
      // Afficher randomizer.shortName (ex: "ALttP Randomizer") sur la page liste
      const displayTitle = game.randomizer?.shortName || game.randomizer?.displayName || `${game.name} Randomizer`;
      // Afficher le nom complet du jeu en sous-titre
      const gameName = game.official?.name || game.name;
      const stats = streamStats[game.id] || { streamers: 0, viewers: 0 };
      const website = sanitizeExternalUrl(game.randomizer?.website || game.officialWebsite);
      
      return `
        <div class="game-card" data-game-id="${encodeURIComponent(id)}" role="link" tabindex="0" style="display:flex;flex-direction:column;align-items:center;cursor:pointer;overflow:hidden;">
          <img src="${escHtml(image)}" alt="${escHtml(game.name)}" width="256" height="360" loading="lazy" decoding="async" style="width:256px;max-width:100%;height:auto;aspect-ratio:256/360;object-fit:cover;border-radius:12px;box-shadow:0 2px 12px #0003;display:block;" 
               data-fallback="hide-show-next">
          <div style="display:none;width:256px;max-width:100%;height:auto;aspect-ratio:256/360;background:#1f2937;border-radius:12px;box-shadow:0 2px 12px #0003;align-items:center;justify-content:center;font-size:2.5rem;font-weight:bold;color:#6b7280;text-transform:uppercase;">${escHtml(id)}</div>
          <h2 style="color:#fbbf24;font-size:1.3rem;font-weight:bold;margin:1rem 0 0.5rem 0;text-align:center;">${escHtml(displayTitle)}</h2>
          <p style="color:#d1d5db;font-size:1rem;text-align:center;margin:0 0 0.5rem 0;">${escHtml(gameName)}</p>
          <div style="display:flex;gap:1rem;color:#9ca3af;font-size:0.85rem;margin-bottom:0.5rem;">
            <span title="${typeof i18n !== 'undefined' ? i18n.t('games.races') : 'races'}">🏁 ${game.totalRaces || 0}</span>
            <span title="${typeof i18n !== 'undefined' ? i18n.t('games.tournaments') : 'tournaments'}">🏆 ${game.totalTournaments || 0}</span>
            ${stats.streamers > 0 ? `<span title="${typeof i18n !== 'undefined' ? i18n.t('games.liveNow') : 'live now'}">📺 ${stats.streamers}</span>` : ''}
          </div>
          ${website ? `<a class="official-link" href="${website}" target="_blank" rel="noopener noreferrer" style="color:#60a5fa;text-decoration:underline;transition:color 0.2s,text-decoration-color 0.2s;">${typeof i18n !== 'undefined' ? i18n.t('common.officialSite') : 'Official site'} →</a>` : ''}
        </div>
      `;
    }).join('');
    
    // Attach event listeners
    document.querySelectorAll('#games-grid .game-card').forEach(card => {
      const gid = card.getAttribute('data-game-id');
      if (!gid) return;
      card.addEventListener('click', () => {
        window.location.href = '/game-detail.html?id=' + encodeURIComponent(gid);
      });
      card.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          window.location.href = '/game-detail.html?id=' + encodeURIComponent(gid);
        }
      });
      const official = card.querySelector('.official-link');
      if (official) {
        official.addEventListener('click', (ev) => { ev.stopPropagation(); });
        official.addEventListener('mouseenter', () => {
          official.style.color = '#fbbf24';
          official.style.textDecorationColor = '#fbbf24';
        });
        official.addEventListener('mouseleave', () => {
          official.style.color = '#60a5fa';
          official.style.textDecorationColor = '#60a5fa';
        });
      }
    });
  }
  
  try {
    // Fetch games with stats immediately (higher priority)
    const gamesRes = await fetch('/api/games/with-stats');
    const gamesJson = await gamesRes.json();
    gamesData = gamesJson.games || [];
    
    // Render games immediately without waiting for streams
    renderGames(sortGames(gamesData, sortSelect.value));
    
    // Handle sort change
    sortSelect.addEventListener('change', () => {
      const sorted = sortGames(gamesData, sortSelect.value);
      renderGames(sorted);
    });
    
    // Fetch stream stats in background (lower priority)
    (async () => {
      try {
        const statsRes = await fetch('/api/streams/stats/by-game');
        if (!statsRes.ok) {
          throw new Error('Failed to fetch aggregated stream stats');
        }

        const statsJson = await statsRes.json();
        streamStats = statsJson.stats || {};
      } catch (e) {
        console.warn('Aggregated stream stats unavailable, using per-game fallback:', e);

        // Fallback: keep previous behavior for resilience
        const results = await Promise.all(gamesData.map(game =>
          fetch(`/api/streams/${encodeURIComponent(game.id)}`)
            .then(res => res.ok ? res.json() : { streams: [] })
            .catch(() => ({ streams: [] }))
        ));

        const fallbackStats = {};
        gamesData.forEach((game, index) => {
          const gameStreams = results[index]?.streams || [];
          fallbackStats[game.id] = {
            streamers: gameStreams.length,
            viewers: gameStreams.reduce((sum, s) => sum + (s.viewerCount || 0), 0)
          };
        });

        streamStats = fallbackStats;
      }

      // Re-render with current sort to update stream counts
      const currentSort = sortSelect.value || 'streamers-desc';
      renderGames(sortGames(gamesData, currentSort));
    })();
    
  } catch (e) {
    const errText = (typeof i18n !== 'undefined' && typeof i18n.t === 'function') ? i18n.t('common.error') : 'Loading error';
    grid.innerHTML = `<div class="loading">${escHtml(errText)}</div>`;
  }
});
