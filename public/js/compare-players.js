(function() {
  // ─── Helpers ───
  function qs(name) {
    const m = location.search.match(new RegExp('[?&]' + name + '=([^&]+)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function normalizeRacetimeProfileUrl(input, racetimeId) {
    const raw = String(input || '').trim();
    if (raw) {
      if (/^https?:\/\//i.test(raw)) {
        return raw.replace(/^http:\/\//i, 'https://').replace(/\/+$/, '');
      }
      if (raw.startsWith('/')) {
        return ('https://racetime.gg' + raw).replace(/\/+$/, '');
      }
      if (raw.startsWith('user/')) {
        return ('https://racetime.gg/' + raw).replace(/\/+$/, '');
      }
      if (/^[A-Za-z0-9_-]{6,}$/.test(raw)) {
        return 'https://racetime.gg/user/' + encodeURIComponent(raw);
      }
      return ('https://racetime.gg/' + raw.replace(/^\/+/, '')).replace(/\/+$/, '');
    }

    const id = String(racetimeId || '').trim();
    if (!id) return null;
    return 'https://racetime.gg/user/' + encodeURIComponent(id);
  }

  function t(key, fallback) {
    if (typeof window.i18n === 'function') return window.i18n(key) || fallback || key;
    if (typeof window.i18n === 'object' && window.i18n?.t) return window.i18n.t(key) || fallback || key;
    return fallback || key;
  }

  function formatMs(ms) {
    if (!ms) return '—';
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function formatTime(ft, ftMs) {
    if (ftMs) return formatMs(ftMs);
    if (ft) {
      // ISO duration → readable
      if (ft.startsWith('P')) {
        const re = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/;
        const m = re.exec(ft);
        if (m) {
          const h = parseInt(m[1] || 0, 10);
          const min = parseInt(m[2] || 0, 10);
          const s = Math.floor(parseFloat(m[3] || 0));
          return `${h}:${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        }
      }
      return ft;
    }
    return '—';
  }

  function formatDate(d) {
    if (!d) return '';
    const dt = new Date(d);
    return dt.toLocaleDateString(document.documentElement.lang || 'en', {
      year: 'numeric', month: 'short', day: 'numeric'
    });
  }

  function placeBadge(place, status) {
    const finished = status === 'done' || status === 'finished';
    if (!finished) return '<span class="compare-place-badge dnf">DNF</span>';
    if (place === 1) return '<span class="compare-place-badge gold">🥇 1st</span>';
    if (place === 2) return '<span class="compare-place-badge silver">🥈 2nd</span>';
    if (place === 3) return '<span class="compare-place-badge bronze">🥉 3rd</span>';
    return `<span class="compare-place-badge other">${place ? place + 'th' : '—'}</span>`;
  }

  // ─── Avatar resolution (same cascade as player-detail.js) ───

  async function resolveAvatar(name) {
    try {
      // Try to get racetime info from the players API
      const resp = await fetch(`/api/players?name=${encodeURIComponent(name)}`);
      if (!resp.ok) return null;
      const data = await resp.json();
      const player = data.players?.[0];
      if (!player) return null;

      // Try racetime avatar via dedicated endpoint
      if (player.racetimeUrl || player.racetimeId) {
        const racetimeUrl = normalizeRacetimeProfileUrl(player.racetimeUrl, player.racetimeId);
        if (racetimeUrl) {
          try {
            const proxy = '/api/racetime/avatar?url=' + encodeURIComponent(racetimeUrl) + '&name=' + encodeURIComponent(name);
            const profileResp = await fetch(proxy, { method: 'GET' });
            if (profileResp.ok && profileResp.status !== 204) {
              const ct = profileResp.headers.get('Content-Type') || '';
              if (ct.indexOf('image/') === 0) {
                const blob = await profileResp.blob();
                if (blob.size > 0) {
                  return URL.createObjectURL(blob);
                }
              }
            }
          } catch (e) { /* ignore */ }
        }
      }

      // Try twitch avatar via dedicated endpoint
      if (player.twitch) {
        try {
          const tResp = await fetch('/api/streams/twitch-avatar/' + encodeURIComponent(player.twitch), {
            method: 'GET',
            cache: 'default'
          });
          if (tResp.ok && tResp.status !== 204) {
            const ct = tResp.headers.get('Content-Type') || '';
            if (ct.indexOf('image/') === 0) {
              const blob = await tResp.blob();
              if (blob.size > 0) {
                return URL.createObjectURL(blob);
              }
            }
          }
        } catch (e) { /* ignore */ }
      }

      return null;
    } catch (e) {
      return null;
    }
  }

  function makeInitialAvatar(name) {
    const initial = (name || '?')[0].toUpperCase();
    return `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect fill="%23374151" width="120" height="120" rx="60"/><text x="60" y="68" fill="%23fbbf24" font-size="48" font-family="system-ui,sans-serif" text-anchor="middle" dominant-baseline="middle">${initial}</text></svg>`
    )}`;
  }

  // ─── Player list cache & autocomplete ───
  let allPlayers = null;
  let playersLoadPromise = null;

  async function loadPlayersList() {
    if (allPlayers) return allPlayers;
    if (playersLoadPromise) return playersLoadPromise;
    playersLoadPromise = fetch('/api/players')
      .then(r => r.json())
      .then(data => {
        allPlayers = (data.players || []).map(p => p.name).sort((a, b) => a.localeCompare(b));
        return allPlayers;
      })
      .catch(() => { allPlayers = []; return allPlayers; });
    return playersLoadPromise;
  }

  function setupAutocomplete(inputId, suggestionsId) {
    const input = document.getElementById(inputId);
    const list = document.getElementById(suggestionsId);
    if (!input || !list) return;

    let debounceTimer = null;

    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        const val = input.value.trim().toLowerCase();
        if (val.length < 2) { list.style.display = 'none'; list.innerHTML = ''; return; }
        const players = await loadPlayersList();
        const matches = players.filter(n => n.toLowerCase().includes(val)).slice(0, 8);
        if (!matches.length) { list.style.display = 'none'; list.innerHTML = ''; return; }
        list.innerHTML = matches.map(n => `<li data-name="${escHtml(n)}">${escHtml(n)}</li>`).join('');
        list.style.display = 'block';
      }, 150);
    });

    list.addEventListener('click', (e) => {
      const li = e.target.closest('li');
      if (li) {
        input.value = li.dataset.name;
        list.style.display = 'none';
        list.innerHTML = '';
      }
    });

    // Close suggestions when clicking elsewhere
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.compare-autocomplete-wrap')) {
        list.style.display = 'none';
      }
    });

    // Close on Escape, submit on Enter
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { list.style.display = 'none'; }
      if (e.key === 'Enter') {
        // If dropdown has highlighted, pick it; otherwise trigger compare
        const active = list.querySelector('li:hover');
        if (active) {
          input.value = active.dataset.name;
          list.style.display = 'none';
        } else {
          list.style.display = 'none';
          document.getElementById('compare-btn')?.click();
        }
      }
    });
  }

  // ─── Rendering ───
  function renderResults(data) {
    const results = document.getElementById('compare-results');
    results.style.display = 'block';

    const p1 = data.player1.name;
    const p2 = data.player2.name;

    // Player names
    document.getElementById('cp-name1').textContent = p1;
    document.getElementById('cp-name1').href = `/player-detail.html?name=${encodeURIComponent(p1)}`;
    document.getElementById('cp-name2').textContent = p2;
    document.getElementById('cp-name2').href = `/player-detail.html?name=${encodeURIComponent(p2)}`;

    // Avatars (async, set placeholder first)
    document.getElementById('cp-avatar1').src = makeInitialAvatar(p1);
    document.getElementById('cp-avatar2').src = makeInitialAvatar(p2);
    resolveAvatar(p1).then(url => {
      if (url) {
        const img = document.getElementById('cp-avatar1');
        img.onload = () => {
          if (url.startsWith('blob:')) URL.revokeObjectURL(url);
        };
        img.src = url;
      }
    });
    resolveAvatar(p2).then(url => {
      if (url) {
        const img = document.getElementById('cp-avatar2');
        img.onload = () => {
          if (url.startsWith('blob:')) URL.revokeObjectURL(url);
        };
        img.src = url;
      }
    });

    // Head to head
    const total = data.totalCommonRaces;
    const h2h = data.headToHead;
    document.getElementById('h2h-p1-wins').textContent = h2h.player1Wins;
    document.getElementById('h2h-p2-wins').textContent = h2h.player2Wins;

    const drawText = h2h.draws > 0 ? `${h2h.draws} ${t('comparePlayers.draws', 'draws')}` : '';
    document.getElementById('h2h-draws').textContent = drawText;

    const pct1 = total ? Math.round((h2h.player1Wins / total) * 100) : 0;
    const pct2 = total ? Math.round((h2h.player2Wins / total) * 100) : 0;
    const pctDraw = total ? 100 - pct1 - pct2 : 0;
    document.getElementById('h2h-bar-p1').style.width = pct1 + '%';
    document.getElementById('h2h-bar-draw').style.width = pctDraw + '%';
    document.getElementById('h2h-bar-p2').style.width = pct2 + '%';
    document.getElementById('h2h-pct1').textContent = pct1 + '%';
    document.getElementById('h2h-pct2').textContent = pct2 + '%';

    document.getElementById('h2h-total').textContent = `${total} ${t('comparePlayers.commonRacesCount', 'common races')}`;

    // Stat comparison
    document.getElementById('stat-avg1').textContent = formatMs(data.averageFinishTimeMs.player1);
    document.getElementById('stat-avg2').textContent = formatMs(data.averageFinishTimeMs.player2);

    const pl = data.placements;
    document.getElementById('stat-1st-1').textContent = pl.player1.first;
    document.getElementById('stat-1st-2').textContent = pl.player2.first;
    document.getElementById('stat-2nd-1').textContent = pl.player1.second;
    document.getElementById('stat-2nd-2').textContent = pl.player2.second;
    document.getElementById('stat-3rd-1').textContent = pl.player1.third;
    document.getElementById('stat-3rd-2').textContent = pl.player2.third;
    document.getElementById('stat-dnf-1').textContent = pl.player1.dnf;
    document.getElementById('stat-dnf-2').textContent = pl.player2.dnf;

    // Highlight better values
    highlightBetter('stat-avg1', 'stat-avg2', data.averageFinishTimeMs.player1, data.averageFinishTimeMs.player2, true);
    highlightBetter('stat-1st-1', 'stat-1st-2', pl.player1.first, pl.player2.first, false);
    highlightBetter('stat-2nd-1', 'stat-2nd-2', pl.player1.second, pl.player2.second, false);
    highlightBetter('stat-3rd-1', 'stat-3rd-2', pl.player1.third, pl.player2.third, false);
    highlightBetter('stat-dnf-1', 'stat-dnf-2', pl.player1.dnf, pl.player2.dnf, true);

    // Game breakdown
    renderGameBreakdown(data.gameBreakdown, p1, p2);

    // Race list
    renderRaceList(data.races, p1, p2);
  }

  function highlightBetter(id1, id2, val1, val2, lowerIsBetter) {
    const el1 = document.getElementById(id1);
    const el2 = document.getElementById(id2);
    el1.classList.remove('better', 'worse');
    el2.classList.remove('better', 'worse');
    if (val1 == null || val2 == null) return;
    if (val1 === val2) return;
    if (lowerIsBetter) {
      if (val1 < val2) { el1.classList.add('better'); el2.classList.add('worse'); }
      else { el2.classList.add('better'); el1.classList.add('worse'); }
    } else {
      if (val1 > val2) { el1.classList.add('better'); el2.classList.add('worse'); }
      else { el2.classList.add('better'); el1.classList.add('worse'); }
    }
  }

  function renderGameBreakdown(games, p1Name, p2Name) {
    const container = document.getElementById('game-breakdown');
    if (!games.length) {
      container.innerHTML = `<p style="color:#9ca3af">${t('common.noResults', 'No results')}</p>`;
      return;
    }
    container.innerHTML = games.map(g => {
      const gTotal = g.count;
      const pct1 = gTotal ? Math.round((g.p1Wins / gTotal) * 100) : 0;
      const pct2 = gTotal ? Math.round((g.p2Wins / gTotal) * 100) : 0;
      return `
        <div class="compare-game-card">
          <div class="compare-game-name">${escHtml(g.gameName)}</div>
          <div class="compare-game-stats">
            <span class="p1-color">${g.p1Wins}</span>
            <span class="compare-game-count">${gTotal} ${t('comparePlayers.races', 'races')}</span>
            <span class="p2-color">${g.p2Wins}</span>
          </div>
          <div class="h2h-bar mini">
            <div class="h2h-bar-p1" style="width:${pct1}%"></div>
            <div class="h2h-bar-draw" style="width:${100 - pct1 - pct2}%"></div>
            <div class="h2h-bar-p2" style="width:${pct2}%"></div>
          </div>
        </div>`;
    }).join('');
  }

  function renderRaceList(races, p1Name, p2Name) {
    const container = document.getElementById('common-races-list');
    if (!races.length) {
      container.innerHTML = `<p style="color:#9ca3af">${t('common.noResults', 'No results')}</p>`;
      return;
    }
    container.innerHTML = races.map(r => {
      const winnerClass = r.h2hWinner === 1 ? 'p1-won' : r.h2hWinner === 2 ? 'p2-won' : 'draw';
      const raceId = r.raceId || r._id || '';
      const raceLink = raceId
        ? `/race-detail.html?id=${encodeURIComponent(raceId)}`
        : '#';

      return `
        <a href="${raceLink}" class="compare-race-card ${winnerClass}">
          <div class="compare-race-header">
            <span class="compare-race-game">${escHtml(r.gameName || r.category || '')}</span>
            <span class="compare-race-date">${formatDate(r.startedAt)}</span>
          </div>
          <div class="compare-race-goal">${escHtml(r.goal || r.raceName || '')}</div>
          <div class="compare-race-results">
            <div class="compare-race-player left ${r.h2hWinner === 1 ? 'winner' : ''}">
              ${placeBadge(r.player1.place, r.player1.status)}
              <span class="compare-race-time">${formatTime(r.player1.finishTime, r.player1.finishTimeMs)}</span>
            </div>
            <div class="compare-race-player right ${r.h2hWinner === 2 ? 'winner' : ''}">
              <span class="compare-race-time">${formatTime(r.player2.finishTime, r.player2.finishTimeMs)}</span>
              ${placeBadge(r.player2.place, r.player2.status)}
            </div>
          </div>
        </a>`;
    }).join('');
  }

  // ─── Main flow ───
  async function doCompare(name1, name2) {
    const loading = document.getElementById('compare-loading');
    const results = document.getElementById('compare-results');
    results.style.display = 'none';
    loading.style.display = 'block';

    try {
      const resp = await fetch(`/api/players/compare?player1=${encodeURIComponent(name1)}&player2=${encodeURIComponent(name2)}`);
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to compare players');
      }
      const data = await resp.json();
      loading.style.display = 'none';
      renderResults(data);

      // Update URL without reload
      const url = new URL(window.location);
      url.searchParams.set('player1', name1);
      url.searchParams.set('player2', name2);
      history.replaceState(null, '', url);
    } catch (err) {
      loading.style.display = 'none';
      results.style.display = 'block';
      results.innerHTML = `<div class="loading" style="color:#f87171">${escHtml(err.message)}</div>`;
    }
  }

  function init() {
    setupAutocomplete('player1-input', 'player1-suggestions');
    setupAutocomplete('player2-input', 'player2-suggestions');

    // Pre-load players list
    loadPlayersList();

    // Compare button
    document.getElementById('compare-btn').addEventListener('click', () => {
      const name1 = document.getElementById('player1-input').value.trim();
      const name2 = document.getElementById('player2-input').value.trim();
      if (name1 && name2) doCompare(name1, name2);
    });

    // Pre-fill from URL params if available
    const p1 = qs('player1');
    const p2 = qs('player2');
    if (p1) document.getElementById('player1-input').value = p1;
    if (p2) document.getElementById('player2-input').value = p2;
    if (p1 && p2) doCompare(p1, p2);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
