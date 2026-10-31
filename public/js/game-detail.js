(function(){
  function qs(name){ const m = location.search.match(new RegExp('[?&]'+name+'=([^&]+)')); return m ? decodeURIComponent(m[1]) : null; }
  const id = qs('id');
  const idLower = id ? id.toLowerCase() : '';
  // Canonical short names to display on the second line when needed
  const CANONICAL_GAME_NAMES = {
    'kh2fm': 'Kingdom Hearts II Final Mix',
    'kh2r': 'Kingdom Hearts II Final Mix',
    'kh2fmr': 'Kingdom Hearts II Final Mix'
  };
  const titleEl = document.getElementById('game-title');
  const posterEl = document.getElementById('game-poster');
  const metaEl = document.getElementById('game-meta');
  const siteEl = document.getElementById('game-official-site');
  const statsEl = document.getElementById('game-stats');
  const toursEl = document.getElementById('game-tournaments');
  const racesEl = document.getElementById('game-races');
  const streamsListEl = document.getElementById('streams-list');
  const categoriesContentEl = document.getElementById('categories-content');
  let resourcesDataCache = null;

  if(!id){ titleEl.textContent = 'Game not specified'; }

  async function fetchJson(url){ const res = await fetch(url); if(!res.ok) throw new Error('Fetch failed'); return res.json(); }

  function formatDate(d) {
    if (!d) return '-';
    let locale = 'en-US';
    const lang = getCurrentLanguage();
    if (lang) {
      const localeMap = { 'en': 'en-US', 'fr': 'fr-FR', 'de': 'de-DE', 'es': 'es-ES', 'it': 'it-IT' };
      locale = localeMap[lang] || 'en-US';
    }
    return new Date(d).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function formatDateTime(d) {
    if (!d) return '-';
    let locale = 'en-US';
    const lang = getCurrentLanguage();
    if (lang) {
      const localeMap = { 'en': 'en-US', 'fr': 'fr-FR', 'de': 'de-DE', 'es': 'es-ES', 'it': 'it-IT' };
      locale = localeMap[lang] || 'en-US';
    }
    return new Date(d).toLocaleString(locale, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
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

  function getStatusText(status, isTournament = false) {
    if (typeof i18n !== 'undefined') {
      if (isTournament) {
        switch(status) {
          case 'à venir': return i18n.t('status.tournament.upcoming');
          case 'en cours': return i18n.t('status.tournament.ongoing');
          case 'terminé': return i18n.t('status.tournament.finished');
          default: return status;
        }
      } else {
        switch(status) {
          case 'open': return i18n.t('status.race.open');
          case 'invitational': return i18n.t('status.race.invitational');
          case 'in_progress': return i18n.t('status.race.ongoing');
          case 'finished': return i18n.t('status.race.finished');
          case 'cancelled': return i18n.t('status.race.cancelled');
          default: return status;
        }
      }
    }
    // Fallback
    if (isTournament) {
      const statusTexts = { 'à venir': 'Upcoming', 'en cours': 'Ongoing', 'terminé': 'Finished' };
      return statusTexts[status] || status;
    } else {
      const statusTexts = { 'open': 'Open', 'in_progress': 'In Progress', 'finished': 'Finished', 'cancelled': 'Cancelled' };
      return statusTexts[status] || status || '-';
    }
  }

  function cardTournament(t){
    const tid = t._id || t.id;
    const date = formatDate(t.startDate);
    const statusColors = { 'à venir': '#3b82f6', 'en cours': '#10b981', 'terminé': '#6b7280' };
    const status = getTournamentStatus(t);
    const statusColor = statusColors[status] || '#6b7280';
    const statusText = getStatusText(status, true);
    const participantsCount = t.participantsCount || (t.participants && t.participants.length) || 0;
    const participantsLabel = typeof i18n !== 'undefined' ? i18n.t('home.participants') : 'participants';
    
    const winnerName = getTournamentWinnerName(t);
    const winnerHtml = winnerName
      ? `<div class="spoiler-block" style="color:#fbbf24;font-size:0.8rem;margin-top:0.5rem;"><span>🏆</span> <span style="color:#d1d5db;">${escHtml(winnerName)}</span></div>`
      : '';
    
    return `
      <a href="/tournament-detail.html?id=${encodeURIComponent(tid)}" style="text-decoration:none;color:inherit;display:block;">
        <div style="background:#374151;padding:1rem;border-radius:0.5rem;margin-bottom:0.75rem;transition:background 0.2s;cursor:pointer;" data-hover-style="background:#4b5563" data-rest-style="background:#374151">
          <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:0.25rem;">
            <h4 style="color:#fbbf24;font-size:0.95rem;flex:1;">${t.name || 'Tournoi'}</h4>
            <span style="background:${statusColor};color:white;padding:0.125rem 0.5rem;border-radius:0.25rem;font-size:0.7rem;margin-left:0.5rem;">${statusText}</span>
          </div>
          ${winnerHtml}
          <div style="color:#9ca3af;font-size:0.75rem;margin-top:0.5rem;">📅 ${date} • 👥 ${participantsCount} ${participantsLabel}</div>
        </div>
      </a>
    `;
  }

  // Parse ISO 8601 duration to milliseconds
  function parseISODuration(str) {
    if (!str) return null;
    const cleaned = String(str).replace(/^P(?:\d+D)?T/, 'PT');
    const re = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/;
    const m = re.exec(cleaned);
    if (!m) return null;
    const h = parseInt(m[1] || 0, 10);
    const min = parseInt(m[2] || 0, 10);
    const s = parseFloat(m[3] || 0);
    return Math.round(((h * 3600) + (min * 60) + s) * 1000);
  }

  function parseTimeToMs(value) {
    if (value == null) return null;
    if (typeof value === 'number') return value;
    const s = String(value).trim();
    if (!s) return null;
    if (s.startsWith('PT') || s.startsWith('P')) return parseISODuration(s);
    return null;
  }

  function formatMs(ms) {
    if (ms == null) return 'N/A';
    const totalSeconds = Math.round(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const ss = totalSeconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
    return `${m}:${String(ss).padStart(2,'0')}`;
  }

  function cardRace(r){
    const date = formatDate(r.startedAt);
    const entrantsCount = (r.entrants && r.entrants.length) || 0;
    const winner = (r.entrants || []).find(e => e.place === 1);
    const statusColors = { 'open': '#3b82f6', 'invitational': '#8b5cf6', 'in_progress': '#10b981', 'finished': '#6b7280', 'cancelled': '#ef4444' };
    const statusColor = statusColors[r.status] || '#6b7280';
    const statusText = getStatusText(r.status, false);
    const participantsLabel = typeof i18n !== 'undefined' ? i18n.t('home.participants') : 'participants';
    
    let winnerHtml = '';
    if (winner) {
      const winnerName = winner.userName || 'Unknown';
      const ms = winner.finishTimeMs || parseTimeToMs(winner.finishTime);
      const timeStr = ms ? formatMs(ms) : (winner.finishTime || 'N/A');
      winnerHtml = `<div class="spoiler-block" style="color:#fbbf24;font-size:0.8rem;margin-top:0.5rem;"><span>🏆</span> <span style="color:#d1d5db;">${winnerName}</span> <span style="color:#10b981;font-weight:600;">${timeStr}</span></div>`;
    }
    
    const raceUrl = r._id ? `/race-detail.html?id=${encodeURIComponent(r._id)}` : '#';
    
    return `
      <a href="${raceUrl}" style="text-decoration:none;color:inherit;display:block;">
        <div style="background:#374151;padding:1rem;border-radius:0.5rem;margin-bottom:0.75rem;transition:background 0.2s;cursor:pointer;" data-hover-style="background:#4b5563" data-rest-style="background:#374151">
          <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:0.25rem;">
            <h4 style="color:#60a5fa;font-size:0.95rem;flex:1;">${r.goal || 'Standard'}</h4>
            <span style="background:${statusColor};color:white;padding:0.125rem 0.5rem;border-radius:0.25rem;font-size:0.7rem;margin-left:0.5rem;">${statusText}</span>
          </div>
          ${winnerHtml}
          <div style="color:#9ca3af;font-size:0.75rem;margin-top:0.5rem;">📅 ${date} • 👥 ${entrantsCount} ${participantsLabel}</div>
        </div>
      </a>
    `;
  }

  function cardStream(s) {
    // Use proxy for thumbnail URL
    const thumbUrl = s.thumbnailUrl ? `/api/proxy-image?url=${encodeURIComponent(s.thumbnailUrl)}` : '';
    const streamLinkAttrs = buildExternalLinkAttrs(s.url);
    const wrapperTag = streamLinkAttrs ? 'a' : 'div';
    const wrapperAttrs = streamLinkAttrs ? `${streamLinkAttrs} class="stream-card"` : 'class="stream-card"';
    const escapeHtml = (str) => String(str).replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
    const formatViewers = (count) => {
      if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
      if (count >= 1000) return (count / 1000).toFixed(1) + 'K';
      return count;
    };
    
    return `
      <${wrapperTag} ${wrapperAttrs}>
        <div class="stream-thumbnail">
          <img src="${thumbUrl}" 
               alt="${escapeHtml(s.title || '')}" 
               loading="lazy"
               data-fallback-src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27320%27 height=%27180%27%3E%3Crect fill=%27%23374151%27 width=%27320%27 height=%27180%27/%3E%3Ctext x=%2750%25%27 y=%2750%25%27 font-size=%2740%27 fill=%27%236b7280%27 text-anchor=%27middle%27 dy=%27.3em%27%3E📺%3C/text%3E%3C/svg%3E">
          <span class="stream-live-badge">${typeof i18n !== 'undefined' ? i18n.t('streams.live') : 'EN DIRECT'}</span>
          ${s.viewerCount ? `<span class="stream-viewers">👁 ${formatViewers(s.viewerCount)}</span>` : ''}
        </div>
        <div class="stream-info">
          <div class="stream-title">${escapeHtml(s.title || 'Sans titre')}</div>
          <div class="stream-channel">${escapeHtml(s.userName || s.userLogin || 'Unknown')}</div>
          ${s.gameName ? `<div class="stream-game">🎮 ${escapeHtml(s.gameName)}</div>` : ''}
        </div>
      </${wrapperTag}>
    `;
  }

  // Tab switching
  function switchTab(tabName) {
    document.querySelectorAll('.tab-content').forEach(tc => tc.style.display = 'none');
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.style.color = '#9ca3af';
      btn.style.borderBottomColor = 'transparent';
      btn.classList.remove('active');
    });
    const target = document.getElementById('tab-content-' + tabName);
    if (target) target.style.display = 'block';
    const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
    if (btn) {
      btn.style.color = '#fbbf24';
      btn.style.borderBottomColor = '#fbbf24';
      btn.classList.add('active');
    }

    // Load streams when switching to streams tab
    if (tabName === 'streams' && !streamsLoaded) {
      loadStreams();
    }
    // Load categories when switching to categories tab
    if (tabName === 'categories' && !categoriesLoaded) {
      loadCategories();
    }
  }

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => selectTab(btn.getAttribute('data-tab')));
  });

  // The tab clicked is kept by a reload
  let tabs = null;
  function selectTab(tabName) {
    if (tabs) tabs.select(tabName);
    else switchTab(tabName);
  }

  let streamsLoaded = false;
  let categoriesLoaded = false;

  function formatStreamsCount(n) {
    if (typeof i18n !== 'undefined' && typeof i18n.t === 'function') {
      const txt = i18n.t('streams.streamsLive') || '';
      const parts = txt.split('|').map(s => s.trim());
      const label = (n === 1) ? (parts[0] || parts[1] || txt) : (parts[1] || parts[0] || txt);
      return `${n} ${label}`;
    }
    return `${n} live stream${n > 1 ? 's' : ''}`;
  }

  // ==================== LEADERBOARDS SECTION ====================
  const leaderboardsContentEl = document.getElementById('leaderboards-content');
  const LEADERBOARD_PAGE_SIZE = 50;
  let leaderboardData = null;
  let leaderboardShown = LEADERBOARD_PAGE_SIZE;
  let leaderboardRequest = 0;

  function plural(key, count, fallback) {
    if (typeof i18n !== 'undefined' && typeof i18n.plural === 'function') {
      const value = i18n.plural(key, count);
      if (value && value !== key) return value;
    }
    return fallback;
  }

  // Ranking of one racetime goal (the busiest current goal when none is given)
  async function loadLeaderboard(slug, goal) {
    const request = ++leaderboardRequest;
    const params = slug && goal ? `?slug=${encodeURIComponent(slug)}&goal=${encodeURIComponent(goal)}` : '';
    try {
      const data = await fetchJson(`/api/games/${encodeURIComponent(id)}/leaderboards${params}`);
      if (request !== leaderboardRequest) return;
      leaderboardData = data;
      leaderboardShown = LEADERBOARD_PAGE_SIZE;
      renderLeaderboard();
    } catch (e) {
      if (request !== leaderboardRequest) return;
      leaderboardsContentEl.innerHTML = `<p class="text-muted">${escapeHtml(t('gameDetail.leaderboardsUnavailable', 'racetime.gg is not answering right now. Try again later.'))}</p>`;
    }
  }

  function leaderboardPlayerCell(r) {
    const name = escapeHtml(r.name || '—');
    if (r.hasProfile) return `<a class="player-link" href="/player-detail.html?id=${encodeURIComponent(r.userId)}">${name}</a>`;
    if (r.userId) return `<a class="player-link" ${buildExternalLinkAttrs(`https://racetime.gg/user/${encodeURIComponent(r.userId)}`)}>${name}</a>`;
    return name;
  }

  function renderLeaderboard() {
    const data = leaderboardData;
    if (!data) return;
    if (!data.goals.length) {
      const message = data.unavailable.length
        ? t('gameDetail.leaderboardsUnavailable', 'racetime.gg is not answering right now. Try again later.')
        : t('gameDetail.leaderboardsNone', 'No racetime.gg leaderboard for this game.');
      leaderboardsContentEl.innerHTML = `<p class="text-muted">${escapeHtml(message)}</p>`;
      return;
    }

    const ranking = data.ranking;
    // Current goals grouped by racetime category when the game has several, archived ones last
    const categoryNames = [...new Set(data.goals.map(g => g.categoryName))];
    const groups = categoryNames.length > 1
      ? categoryNames.map(name => [g => g.active && g.categoryName === name, name])
      : [[g => g.active, t('gameDetail.leaderboardCurrentGoals', 'Current goals')]];
    groups.push([g => !g.active, t('gameDetail.leaderboardArchivedGoals', 'Archived goals')]);
    const optionGroups = groups.map(([inGroup, label]) => {
      const options = data.goals.map((g, i) => {
        if (!inGroup(g)) return '';
        const selected = g.slug === ranking.slug && g.goal === ranking.goal;
        return `<option value="${i}"${selected ? ' selected' : ''}>${escapeHtml(g.goal)} (${g.numRanked})</option>`;
      }).join('');
      return options ? `<optgroup label="${escapeHtml(label)}">${options}</optgroup>` : '';
    }).join('');

    const rows = ranking.rankings.slice(0, leaderboardShown).map(r => `
      <tr${r.place <= 3 ? ' class="podium"' : ''}>
        <td class="num">${r.place}</td>
        <td>${leaderboardPlayerCell(r)}</td>
        <td class="num">${r.score}</td>
        <td class="num col-optional">${r.bestTimeMs ? formatMs(r.bestTimeMs) : '—'}</td>
        <td class="num col-optional">${r.timesRaced}</td>
      </tr>`).join('');

    const updated = data.fetchedAt
      ? ` · ${escapeHtml(t('gameDetail.leaderboardUpdated', 'Updated'))} ${escapeHtml(formatDateTime(data.fetchedAt))}`
      : '';
    const archivedNote = ranking.active
      ? ''
      : `<p class="text-muted leaderboard-note">${escapeHtml(t('gameDetail.leaderboardArchivedNote', 'Archived goal: this leaderboard no longer changes.'))}</p>`;
    const showMore = ranking.rankings.length > leaderboardShown
      ? `<button type="button" class="filter-select leaderboard-more">${escapeHtml(t('gameDetail.leaderboardShowMore', 'Show more'))}</button>`
      : '';

    leaderboardsContentEl.innerHTML = `
      <div class="leaderboard-toolbar">
        <label for="leaderboard-goal">${escapeHtml(t('gameDetail.leaderboardGoal', 'Goal'))}</label>
        <select id="leaderboard-goal" class="filter-select">${optionGroups}</select>
        <span class="text-muted">${escapeHtml(plural('gameDetail.leaderboardPlayers', ranking.numRanked, `${ranking.numRanked} ranked players`))}</span>
      </div>
      ${archivedNote}
      <div class="data-table-wrap">
        <table class="data-table">
          <thead><tr>
            <th class="num">#</th>
            <th>${escapeHtml(t('gameDetail.leaderboardPlayer', 'Player'))}</th>
            <th class="num">${escapeHtml(t('gameDetail.leaderboardScore', 'Score'))}</th>
            <th class="num col-optional">${escapeHtml(t('gameDetail.leaderboardBestTime', 'Best time'))}</th>
            <th class="num col-optional">${escapeHtml(t('gameDetail.leaderboardRaces', 'Races'))}</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${showMore}
      <p class="text-muted leaderboard-source">
        <a ${buildExternalLinkAttrs(ranking.url)}>${escapeHtml(t('gameDetail.leaderboardFullRanking', 'Full leaderboard on racetime.gg'))}</a>${updated}
      </p>
    `;

    leaderboardsContentEl.querySelector('#leaderboard-goal').addEventListener('change', (event) => {
      const goal = data.goals[Number(event.target.value)];
      if (goal) loadLeaderboard(goal.slug, goal.goal);
    });
    const moreBtn = leaderboardsContentEl.querySelector('.leaderboard-more');
    if (moreBtn) {
      moreBtn.addEventListener('click', () => {
        leaderboardShown += LEADERBOARD_PAGE_SIZE;
        renderLeaderboard();
      });
    }
  }

  function showLeaderboard(slug, goal) {
    selectTab('leaderboards');
    loadLeaderboard(slug, goal);
  }

  // ==================== CATEGORIES SECTION ====================
  let categoriesData = null;

  // Name and description in the current language
  function localized(item) {
    const tr = item?.translations?.[getCurrentLanguage()] || {};
    return { name: tr.name || item.name || '', description: tr.description || item.description || '' };
  }

  // Card title: the translated name followed by the English one, the name the community uses
  function localizedTitle(item, name) {
    const english = item?.name || '';
    if (!english || english.toLowerCase() === name.toLowerCase()) return escapeHtml(name);
    return `${escapeHtml(name)} <span class="english-name">(${escapeHtml(english)})</span>`;
  }

  // Racetime goal opening its leaderboard when it has ranked players
  function goalLink(goal, label) {
    if (!goal.numRanked) return escapeHtml(label);
    return `<button type="button" class="link-button" data-leaderboard-slug="${escapeHtml(goal.slug)}" data-leaderboard-goal="${escapeHtml(goal.goal)}">${escapeHtml(label)}</button>`;
  }

  function renderCategories() {
    const data = categoriesData;
    if (!data) return;
    const days = data.recentRacesDays;
    let html = '';

    if (data.categories.length) {
      html += `<section class="categories-section">
        <h3>${escapeHtml(t('gameDetail.categoriesMain', 'Main categories'))}</h3>
        <div class="category-grid">`;
      data.categories.forEach(category => {
        const { name, description } = localized(category);
        const stats = [plural('gameDetail.categoriesRaces', category.races, `${category.races} races`)];
        if (category.recentRaces) {
          stats.push(t('gameDetail.categoriesRecentRaces', `${category.recentRaces} in the last ${days} days`)
            .replace('{n}', category.recentRaces).replace('{days}', days));
        }
        if (category.lastRaceAt) {
          stats.push(t('gameDetail.categoriesLastRace', `last on ${formatDate(category.lastRaceAt)}`)
            .replace('{date}', formatDate(category.lastRaceAt)));
        }
        const ranked = category.goals.filter(g => g.numRanked);
        const leaderboards = ranked.length
          ? `<div class="category-goals">🏆 ${ranked.map(g => goalLink(g, g.goal)).join(' · ')}</div>`
          : '';
        html += `
          <div class="category-card">
            <h4>${localizedTitle(category, name)}</h4>
            ${description ? `<p>${escapeHtml(description)}</p>` : ''}
            <div class="category-stats">${escapeHtml(stats.join(' · '))}</div>
            ${leaderboards}
          </div>`;
      });
      html += `</div></section>`;
    }

    if (data.settings.length) {
      html += `<section class="categories-section">
        <h3>${escapeHtml(t('gameDetail.categoriesSettings', 'Main settings'))}</h3>`;
      data.settings.forEach(setting => {
        const { name, description } = localized(setting);
        const values = (setting.values || []).map(v => `<span class="setting-value">${escapeHtml(v)}</span>`).join(' ');
        html += `
          <div class="setting-card">
            <h4>${localizedTitle(setting, name)}</h4>
            ${description ? `<p>${escapeHtml(description)}</p>` : ''}
            <div class="setting-values">${values}</div>
          </div>`;
      });
      html += `</section>`;
    }

    if (data.goals.length) {
      const multipleCategories = new Set(data.goals.map(g => g.slug)).size > 1;
      const rows = data.goals.map(goal => {
        const status = goal.active === null
          ? '—'
          : `<span class="goal-status ${goal.active ? 'is-active' : ''}">${escapeHtml(goal.active ? t('gameDetail.goalActive', 'Current') : t('gameDetail.goalArchived', 'Archived'))}</span>`;
        return `
          <tr>
            <td>${escapeHtml(goal.goal)}${multipleCategories ? ` <span class="text-muted">(${escapeHtml(goal.slug)})</span>` : ''}</td>
            <td>${status}</td>
            <td class="num">${goal.races}</td>
            <td class="num col-optional">${goal.recentRaces}</td>
            <td class="col-optional">${goal.lastRaceAt ? escapeHtml(formatDate(goal.lastRaceAt)) : '—'}</td>
            <td class="num">${goal.numRanked ? goalLink(goal, String(goal.numRanked)) : '—'}</td>
          </tr>`;
      }).join('');
      const custom = data.customGoalRaces
        ? `<p class="text-muted">${escapeHtml(t('gameDetail.categoriesCustomGoals', `Plus ${data.customGoalRaces} races with a custom goal (tournaments, special races).`).replace('{n}', data.customGoalRaces))}</p>`
        : '';
      html += `<section class="categories-section">
        <h3>${escapeHtml(t('gameDetail.categoriesGoals', 'racetime.gg goals'))}</h3>
        <p class="text-muted">${escapeHtml(t('gameDetail.categoriesGoalsDescription', 'Every goal racetime.gg offers for this game, current and archived, with the races recorded on this site.'))}</p>
        <div class="data-table-wrap">
          <table class="data-table">
            <thead><tr>
              <th>${escapeHtml(t('gameDetail.leaderboardGoal', 'Goal'))}</th>
              <th>${escapeHtml(t('gameDetail.goalStatus', 'Status'))}</th>
              <th class="num">${escapeHtml(t('gameDetail.leaderboardRaces', 'Races'))}</th>
              <th class="num col-optional">${escapeHtml(t('gameDetail.goalRecentRaces', `Last ${days} days`).replace('{days}', days))}</th>
              <th class="col-optional">${escapeHtml(t('gameDetail.goalLastRace', 'Last race'))}</th>
              <th class="num">${escapeHtml(t('gameDetail.goalRankedPlayers', 'Ranked players'))}</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${custom}
      </section>`;
    }

    if (!html) {
      const message = data.unavailable.length
        ? t('gameDetail.leaderboardsUnavailable', 'racetime.gg is not answering right now. Try again later.')
        : t('gameDetail.categoriesNone', 'No category documented for this game yet.');
      html = `<p class="text-muted">${escapeHtml(message)}</p>`;
    }

    categoriesContentEl.innerHTML = html;
    categoriesContentEl.querySelectorAll('[data-leaderboard-goal]').forEach(btn => {
      btn.addEventListener('click', () => showLeaderboard(btn.dataset.leaderboardSlug, btn.dataset.leaderboardGoal));
    });
  }

  async function loadCategories() {
    if (categoriesLoaded) return;
    categoriesLoaded = true;
    try {
      categoriesData = await fetchJson(`/api/games/${encodeURIComponent(id)}/categories`);
      renderCategories();
    } catch (e) {
      categoriesLoaded = false;
      categoriesContentEl.innerHTML = `<p class="text-muted">${escapeHtml(t('common.error', 'Loading error'))}</p>`;
    }
  }

  // ==================== HISTORY SECTION ====================
  // Written by hand in public/data/history/<id>.json; the tab stays hidden for games without one
  let historyData = null;

  async function loadHistory(gameId) {
    try {
      historyData = await fetchJson(`/data/history/${encodeURIComponent(gameId.toLowerCase())}.json`);
    } catch {
      return;
    }
    const btn = document.querySelector('.tab-btn[data-tab="history"]');
    if (btn) btn.style.display = '';
    renderHistory();
  }

  // English is the fallback for languages the history is not written in
  function historyText(value) {
    if (!value || typeof value === 'string') return value || '';
    return value[getCurrentLanguage()] || value.en || value.fr || '';
  }

  function renderHistory() {
    const el = document.getElementById('history-content');
    if (!el || !historyData) return;
    const events = (historyData.events || []).map(ev => `
      <li class="history-event">
        <span class="history-date">${escapeHtml(historyText(ev.date))}</span>
        <h3 class="history-title">${escapeHtml(historyText(ev.title))}</h3>
        <p class="history-text">${escapeHtml(historyText(ev.text))}</p>
      </li>
    `).join('');
    const sources = (historyData.sources || [])
      .map(s => {
        const attrs = buildExternalLinkAttrs(s.url);
        return attrs ? `<li><a ${attrs}>${escapeHtml(s.label)}</a></li>` : '';
      })
      .join('');
    el.innerHTML = `
      <p class="history-intro">${escapeHtml(historyText(historyData.intro))}</p>
      <ol class="history-timeline">${events}</ol>
      ${sources ? `<h3 class="history-sources-title">${escapeHtml(t('gameDetail.historySources', 'Sources'))}</h3><ul class="history-sources">${sources}</ul>` : ''}
    `;
  }

  // ==================== RESOURCES SECTION ====================
  let resourcesLoaded = false;

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[m]));
  }

  function sanitizeExternalUrl(url, { allowRelative = false } = {}) {
    const raw = String(url || '').trim();
    if (!raw) return '';

    if (allowRelative && raw.startsWith('/')) {
      return raw;
    }

    try {
      const parsed = new URL(raw, window.location.origin);
      if (!/^https?:$/i.test(parsed.protocol)) return '';
      return parsed.href;
    } catch {
      return '';
    }
  }

  function buildExternalLinkAttrs(url, { allowRelative = false } = {}) {
    const safeUrl = sanitizeExternalUrl(url, { allowRelative });
    if (!safeUrl) return '';

    if (allowRelative && safeUrl.startsWith('/')) {
      return `href="${escapeHtml(safeUrl)}"`;
    }

    return `href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer"`;
  }

  function applyGameSeo(game, stats) {
    if (!window.RandomizerSEO || typeof window.RandomizerSEO.updatePage !== 'function') {
      return;
    }

    const displayTitle = game.randomizer?.displayName || game.randomizer?.shortName || game.official?.name || game.name || 'Game';
    const gameName = game.official?.name || game.name || displayTitle;
    const totalRaces = Number(stats?.totalRaces) || 0;
    const totalTournaments = Number(stats?.totalTournaments) || 0;
    const description = [
      `${displayTitle} on Randomizer.`,
      `${totalRaces} races and ${totalTournaments} tournaments tracked.`,
      'Explore recent activity, tournaments and community resources.'
    ].join(' ');

    // Same site as the page header; a Discord thread says nothing about the game's identity
    const resources = game.resources || {};
    const website = resources.officialSite?.url || (resources.sites?.length === 1 ? resources.sites[0].url : '') || game.randomizer?.website;
    const sameAs = [website]
      .map((value) => sanitizeExternalUrl(value))
      .filter((url) => url && !/^https?:\/\/(www\.)?discord\.(com|gg)\//i.test(url));

    const canonicalUrl = `/game-detail.html?id=${encodeURIComponent(id)}`;
    const image = game.cover || '/assets/icon-512.png';
    const breadcrumb = window.RandomizerSEO.buildBreadcrumbList([
      { name: 'Home', url: '/' },
      { name: 'Games', url: '/games.html' },
      { name: displayTitle, url: canonicalUrl }
    ]);
    const schema = {
      '@context': 'https://schema.org',
      '@type': 'VideoGame',
      name: gameName,
      alternateName: displayTitle !== gameName ? displayTitle : undefined,
      url: window.RandomizerSEO.buildAbsoluteUrl(canonicalUrl),
      image: window.RandomizerSEO.buildAbsoluteUrl(image) || window.RandomizerSEO.defaultImage,
      description,
      sameAs: sameAs.length ? sameAs : undefined
    };

    window.RandomizerSEO.updatePage({
      title: `${displayTitle} - Randomizer`,
      description,
      canonicalParams: { id },
      image,
      jsonLd: [breadcrumb, schema]
    });
  }

  function getHostFromUrl(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }

  function isMultiworldSite(site) {
    const url = (site?.url || '').toLowerCase();
    const name = (site?.name || '').toLowerCase();
    return (
      url.includes('archipelago.gg') ||
      url.includes('multiworld.gg') ||
      name.includes('archipelago') ||
      name.includes('multiworld') ||
      !!site?.isMultiworld ||
      !!site?.isArchipelago
    );
  }

  function renderLinkChip(link, icon = '🔗', badge = '') {
    const lang = getCurrentLanguage() || 'en';
    const tr = link?.translations?.[lang] || null;
    const displayName = tr?.name || link.name || getHostFromUrl(link.url) || link.url;
    const displayDescription = tr?.description || link.description || '';
    const linkAttrs = buildExternalLinkAttrs(link.url);
    const tagName = linkAttrs ? 'a' : 'div';

    const name = escapeHtml(displayName);
    const desc = displayDescription ? `<div style="color:#9ca3af;font-size:0.8rem;margin-top:0.25rem;">${escapeHtml(displayDescription)}</div>` : '';
    const iconMarkup = (typeof icon === 'string' && icon.trim().startsWith('<'))
      ? icon
      : `<span>${icon}</span>`;

    return `
      <${tagName}${linkAttrs ? ' ' + linkAttrs : ''}
         style="display:block;position:relative;background:#1f2937;padding:0.875rem 1rem;border-radius:0.5rem;text-decoration:none;transition:background 0.2s;border:1px solid #374151;"
         data-hover-style="background:#374151"
         data-rest-style="background:#1f2937">
        ${badge}
        <div style="display:flex;align-items:center;gap:0.5rem;color:#60a5fa;font-weight:500;">
          ${iconMarkup}
          <span>${name}</span>
        </div>
        ${desc}
      </${tagName}>
    `;
  }

  function renderAssetIcon(src, alt) {
    return `<img src="${src}" alt="${escapeHtml(alt || '')}" style="width:1rem;height:1rem;object-fit:contain;display:block;">`;
  }

  function getCommunityIcon(link) {
    const type = String(link?.type || '').toLowerCase();
    if (type === 'discord') {
      return renderAssetIcon('/assets/discord.svg', 'Discord');
    }
    return '👥';
  }

  // Archipelago link hosted elsewhere than archipelago.gg / multiworld.gg (GitHub…)
  function isCommunityApworld(site) {
    const url = (site?.url || '').toLowerCase();
    return isMultiworldSite(site) && !url.includes('archipelago.gg') && !url.includes('multiworld.gg');
  }

  // Warning in the corner of a community APWorld broken on Archipelago's current version
  function getApworldBadge(site) {
    if (site?.apworldStatus !== 'broken') return '';
    const label = escapeHtml(t('gameDetail.apworldBroken', 'Broken on Main: does not work with the current Archipelago version'));
    return `<span title="${label}" aria-label="${label}" style="position:absolute;top:-0.5rem;right:-0.5rem;background:#b45309;color:#fff;border-radius:999px;width:1.5rem;height:1.5rem;display:flex;align-items:center;justify-content:center;font-size:0.8rem;border:2px solid #111827;">⚠️</span>`;
  }

  function getMultiworldIcon(site) {
    const url = (site?.url || '').toLowerCase();
    const name = (site?.name || '').toLowerCase();
    if (isCommunityApworld(site)) {
      return /discord(app)?\.com\//.test(url) ? renderAssetIcon('/assets/discord.svg', 'Discord') : '🧩';
    }
    if (url.includes('archipelago.gg') || name.includes('archipelago') || !!site?.isArchipelago) {
      return renderAssetIcon('/assets/archipelago.png', 'Archipelago');
    }
    if (url.includes('multiworld.gg') || name.includes('multiworld')) {
      return renderAssetIcon('/assets/multiworld.png', 'Multiworld');
    }
    return '🏝️';
  }

  function t(key, fallback) {
    if (typeof i18n !== 'undefined' && typeof i18n.t === 'function') {
      const value = i18n.t(key);
      if (value && value !== key) return value;
    }
    return fallback;
  }

  function getCurrentLanguage() {
    if (typeof i18n === 'undefined') return 'en';
    if (typeof i18n.getCurrentLanguage === 'function') return i18n.getCurrentLanguage() || 'en';
    if (typeof i18n.getLanguage === 'function') return i18n.getLanguage() || 'en';
    return 'en';
  }

  function renderCommunity(data, container) {
    if (!container) return;

    const other = data?.other || [];
    const communityLinks = other.filter(link => {
      const type = String(link.type || '').toLowerCase();
      return type === 'discord' || type === 'community';
    });

    if (communityLinks.length === 0) {
      const txt = t('gameDetail.communityComingSoon', 'Community links coming soon.');
      container.innerHTML = `<p style="color:#9ca3af;">${txt}</p>`;
      return;
    }

    container.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(260px, 1fr));gap:0.75rem;">
        ${communityLinks.map(link => renderLinkChip(link, getCommunityIcon(link))).join('')}
      </div>
    `;
  }
  
  async function loadResources(gameId) {
    if (resourcesLoaded) return;
    resourcesLoaded = true;
    
    const resourcesEl = document.getElementById('resources-content');
    const communityEl = document.getElementById('community-list');
    if (!resourcesEl) return;
    
    try {
      const data = await fetchJson(`/api/games/${encodeURIComponent(gameId)}/resources`);
      resourcesDataCache = data;
      renderCommunity(data, communityEl);
      renderResources(data, resourcesEl);
    } catch (e) {
      console.error('Error loading resources:', e);
      resourcesEl.innerHTML = '';
      if (communityEl) communityEl.innerHTML = '';
    }
  }

  function rerenderLocalizedResources() {
    const resourcesEl = document.getElementById('resources-content');
    const communityEl = document.getElementById('community-list');
    if (!resourcesDataCache || !resourcesEl) return;
    renderCommunity(resourcesDataCache, communityEl);
    renderResources(resourcesDataCache, resourcesEl);
  }
  
  function renderResources(data, container) {
    if (!data) {
      container.innerHTML = '';
      return;
    }
    
    const officialSite = data.officialSite || null;
    const sites = (data.sites || []).filter(s => !!s.url);
    const trackers = (data.trackers || []).filter(t => !!t.url);
    const guides = (data.guides || []).filter(g => !!g.url);
    const other = (data.other || []).filter(o => !!o.url);

    const seedLinks = other.filter(link => String(link.type || '').toLowerCase() === 'seed');
    const nonCommunityOther = other.filter(link => {
      const type = String(link.type || '').toLowerCase();
      return type !== 'discord' && type !== 'community' && type !== 'seed';
    });

    const officialUrl = officialSite?.url || '';
    const standardSites = sites.filter(site => site.url !== officialUrl && !isMultiworldSite(site));
    const multiworldSites = [];
    const multiworldSeenUrls = new Set();
    const pushMultiworldSite = (site) => {
      if (!site?.url || !isMultiworldSite(site) || multiworldSeenUrls.has(site.url)) return;
      multiworldSeenUrls.add(site.url);
      multiworldSites.push(site);
    };

    sites.forEach(pushMultiworldSite);
    if (!(data.hasMultiworldPage && isCommunityApworld(officialSite))) pushMultiworldSite(officialSite);
    // Pages archipelago.gg / multiworld.gg first, community APWorlds after
    multiworldSites.sort((a, b) => isCommunityApworld(a) - isCommunityApworld(b));

    let html = '';

    if (officialSite?.url) {
      const siteName = escapeHtml(officialSite.name || t('common.officialSite', 'Official site'));
      const officialLinkAttrs = buildExternalLinkAttrs(officialSite.url);
      const officialTagName = officialLinkAttrs ? 'a' : 'div';
      html += `
        <div style="margin-bottom:1.5rem;">
          <h3 style="color:#fbbf24;margin-bottom:0.75rem;font-size:1.1rem;display:flex;align-items:center;gap:0.5rem;">
            <span>🌐</span> ${t('gameDetail.resourceOfficialSite', 'Official site')}
          </h3>
          <${officialTagName}${officialLinkAttrs ? ' ' + officialLinkAttrs : ''}
             style="display:inline-flex;align-items:center;gap:0.75rem;background:#374151;color:#f3f4f6;padding:0.875rem 1.25rem;border-radius:0.75rem;text-decoration:none;font-weight:600;transition:background 0.2s, transform 0.2s;border:1px solid #4b5563;"
             data-hover-style="background:#4b5563;transform:translateY(-1px)"
             data-rest-style="background:#374151;transform:translateY(0)">
            <span style="font-size:1.125rem;">↗</span>
            <span>${siteName}</span>
          </${officialTagName}>
        </div>
      `;
    }

    if (standardSites.length > 0) {
      html += `
        <div style="margin-bottom:1.5rem;">
          <h3 style="color:#fbbf24;margin-bottom:0.75rem;font-size:1.1rem;display:flex;align-items:center;gap:0.5rem;">
            <span>🔗</span> ${t('gameDetail.resourceSites', 'Sites')}
          </h3>
          <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(260px, 1fr));gap:0.75rem;">
            ${standardSites.map(site => renderLinkChip({
              url: site.url,
              name: site.name || getHostFromUrl(site.url),
              description: ''
            }, '🌐')).join('')}
          </div>
        </div>
      `;
    }

    if (multiworldSites.length > 0) {
      html += `
        <div style="margin-bottom:1.5rem;">
          <h3 style="color:#fbbf24;margin-bottom:0.75rem;font-size:1.1rem;display:flex;align-items:center;gap:0.5rem;">
            <span>🧩</span> ${t('gameDetail.resourceMultiworld', 'Archipelago & Multiworld')}
          </h3>
          <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(260px, 1fr));gap:0.75rem;">
            ${multiworldSites.map(site => renderLinkChip({
              url: site.url,
              name: site.name || getHostFromUrl(site.url),
              description: [
                isCommunityApworld(site) ? t('gameDetail.communityApworld', 'Community APWorld (unofficial)') : '',
                site.apworldStatus === 'broken' ? t('gameDetail.apworldBroken', 'Broken on Main: does not work with the current Archipelago version') : ''
              ].filter(Boolean).join(' · ')
            }, getMultiworldIcon(site), getApworldBadge(site))).join('')}
          </div>
        </div>
      `;
    }

    if (seedLinks.length > 0) {
      html += `
        <div style="margin-bottom:1.5rem;">
          <h3 style="color:#fbbf24;margin-bottom:0.75rem;font-size:1.1rem;display:flex;align-items:center;gap:0.5rem;">
            <span>🎲</span> ${t('gameDetail.resourceGenerateSeed', 'Generate a seed')}
          </h3>
          <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(260px, 1fr));gap:0.75rem;">
            ${seedLinks.map(link => renderLinkChip(link, '🎲')).join('')}
          </div>
        </div>
      `;
    }

    if (trackers.length > 0) {
      html += `
        <div style="margin-bottom:1.5rem;">
          <h3 style="color:#fbbf24;margin-bottom:0.75rem;font-size:1.1rem;display:flex;align-items:center;gap:0.5rem;">
            <span>📍</span> ${t('gameDetail.resourceTrackers', 'Trackers')}
          </h3>
          <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(260px, 1fr));gap:0.75rem;">
            ${trackers.map(tracker => renderLinkChip(tracker, '📍')).join('')}
          </div>
        </div>
      `;
    }

    if (guides.length > 0) {
      html += `
        <div style="margin-bottom:1.5rem;">
          <h3 style="color:#fbbf24;margin-bottom:0.75rem;font-size:1.1rem;display:flex;align-items:center;gap:0.5rem;">
            <span>📚</span> ${t('gameDetail.resourceGuides', 'Guides')}
          </h3>
          <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(260px, 1fr));gap:0.75rem;">
            ${guides.map(guide => {
              const typeIcons = { guide: '📖', tutorial: '🎓', wiki: '📝', video: '🎬' };
              const icon = typeIcons[guide.type] || '📖';
              return renderLinkChip(guide, icon);
            }).join('')}
          </div>
        </div>
      `;
    }

    if (nonCommunityOther.length > 0) {
      html += `
        <div style="margin-bottom:1.5rem;">
          <h3 style="color:#fbbf24;margin-bottom:0.75rem;font-size:1.1rem;display:flex;align-items:center;gap:0.5rem;">
            <span>🛠️</span> ${t('gameDetail.resourceOther', 'Other resources')}
          </h3>
          <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(260px, 1fr));gap:0.75rem;">
            ${nonCommunityOther.map(link => renderLinkChip(link, '🔗')).join('')}
          </div>
        </div>
      `;
    }

    if (!html) {
      const txt = t('gameDetail.resourcesComingSoon', 'Resources coming soon.');
      container.innerHTML = `<p style="color:#9ca3af;">${txt}</p>`;
      return;
    }

    container.innerHTML = html;
  }
  // ==================== END RESOURCES SECTION ====================

  async function loadStreams() {
    if (streamsLoaded) return;
    streamsLoaded = true;
    loadMarathonRuns();

    streamsListEl.innerHTML = `<p style="color:#9ca3af;">${typeof i18n !== 'undefined' ? i18n.t('streams.loadingStreams') : 'Chargement des streams...'}</p>`;

    try {
      const data = await fetchJson('/api/streams/' + encodeURIComponent(id));
      const streams = data.streams || [];

      if (streams.length === 0) {
        const noStreamsText = typeof i18n !== 'undefined' ? i18n.t('streams.noStreams') : 'Aucun stream en direct pour ce jeu actuellement.';
        streamsListEl.innerHTML = `<div class="no-streams"><p style="font-size:1.5rem;margin-bottom:0.5rem;">😴</p><p style="color:#9ca3af;">${noStreamsText}</p></div>`;
      } else {
        // Sort streams by viewer count (highest first)
        streams.sort((a, b) => (b.viewerCount || 0) - (a.viewerCount || 0));
        const countText = formatStreamsCount(streams.length);
        streamsListEl.innerHTML = `
          <p style="color:#9ca3af;margin-bottom:1.5rem;font-size:0.875rem;">${countText}</p>
          <div class="streams-grid">
            ${streams.map(cardStream).join('')}
          </div>
        `;
      }
    } catch (e) {
      console.error('Error loading streams:', e);
      const errText = typeof i18n !== 'undefined' ? i18n.t('streams.loadError') : 'Impossible de charger les streams.';
      streamsListEl.innerHTML = `<div class="no-streams"><p style="font-size:1.5rem;margin-bottom:0.5rem;">⚠️</p><p style="color:#9ca3af;">${errText}</p></div>`;
    }
  }

  // ==================== MARATHON RUNS (GDQ) ====================
  let marathonRuns = null;

  function marathonRunnerCell(runner) {
    const name = escapeHtml(runner.name || '');
    if (runner.userId) return `<a class="player-link" href="/player-detail.html?id=${encodeURIComponent(runner.userId)}">${name}</a>`;
    return name;
  }

  function renderMarathonRuns() {
    const section = document.getElementById('marathon-runs');
    const list = document.getElementById('marathon-runs-list');
    if (!section || !list || !marathonRuns || !marathonRuns.length) return;
    const locale = overviewLocale();
    const rows = marathonRuns.map(run => {
      const date = run.startedAt ? new Date(run.startedAt).toLocaleDateString(locale, { year: 'numeric', month: 'short' }) : '';
      const video = (run.videos || []).find(v => sanitizeExternalUrl(v.url));
      const vod = video
        ? `<a class="vod-link" ${buildExternalLinkAttrs(video.url)}>▶ ${escapeHtml(t('gameDetail.marathonWatchVod', 'Watch the VOD'))}</a>`
        : `<span class="text-muted">${escapeHtml(t('gameDetail.marathonNoVod', 'No VOD'))}</span>`;
      return `<tr>
        <td>${escapeHtml(run.event?.name || run.event?.short || '')}<div class="text-muted">${escapeHtml(date)}</div></td>
        <td>${escapeHtml(run.category || '')}</td>
        <td class="col-optional">${(run.runners || []).map(marathonRunnerCell).join(', ')}</td>
        <td>${vod}</td>
      </tr>`;
    }).join('');
    list.innerHTML = `
      <div class="data-table-wrap">
        <table class="data-table">
          <thead><tr>
            <th>${escapeHtml(t('gameDetail.marathonEvent', 'Marathon'))}</th>
            <th>${escapeHtml(t('gameDetail.marathonCategory', 'Category'))}</th>
            <th class="col-optional">${escapeHtml(t('gameDetail.marathonRunners', 'Runners'))}</th>
            <th>${escapeHtml(t('gameDetail.marathonVod', 'VOD'))}</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
    section.style.display = 'block';
  }

  // Runs of the game at speedrun marathons, below the live streams; the section stays hidden without any
  async function loadMarathonRuns() {
    try {
      const data = await fetchJson(`/api/games/${encodeURIComponent(id)}/marathon-runs`);
      marathonRuns = data.runs || [];
      renderMarathonRuns();
      window.addEventListener('languageChanged', renderMarathonRuns);
    } catch (e) {
      console.error('Error loading marathon runs:', e);
    }
  }

  // ==================== OVERVIEW (header) ====================
  function overviewT(key, fallback, params = {}) {
    if (window.i18n && typeof window.i18n.t === 'function') return window.i18n.t(key, params, fallback);
    return fallback.replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m));
  }

  function overviewLocale() {
    return (window.i18n && window.i18n.getLanguage) ? window.i18n.getLanguage() : undefined;
  }

  // Key figures and what is happening now, built from the game's data. Platforms stay in
  // the database but are not shown: most randomizers are played on PC (emulator, decompilation)
  function renderOverview(game, stats, liveCount) {
    const el = document.getElementById('game-overview');
    if (!el) return;
    const fmt = (n) => Number(n || 0).toLocaleString(overviewLocale());

    const facts = [];
    if (game.official?.releaseYear) facts.push(escHtml(overviewT('gameDetail.released', 'Released in {year}', { year: game.official.releaseYear })));

    // Many catalog games have no race on racetime yet: only the figures that exist
    const hasRaces = stats.totalRaces > 0;
    const hasTournaments = stats.totalTournaments > 0;
    const figures = [];
    if (hasRaces) {
      figures.push(`<a href="/races.html?game=${encodeURIComponent(game.id)}"><strong>${fmt(stats.totalRaces)}</strong> ${escHtml(overviewT('gameDetail.overviewRaces', 'races'))}</a>`);
    }
    if (hasTournaments) {
      figures.push(`<a href="/tournaments.html?game=${encodeURIComponent(game.id)}"><strong>${fmt(stats.totalTournaments)}</strong> ${escHtml(overviewT('gameDetail.overviewTournaments', 'tournaments'))}</a>`);
    }
    if (liveCount > 0) {
      figures.push(`<a href="#" data-overview-tab="streams"><strong>${fmt(liveCount)}</strong> ${escHtml(overviewT('gameDetail.overviewLive', 'live now'))}</a>`);
    }

    // The tournaments in progress (a few, the others behind "+N") and the next one
    const MAX_ONGOING = 3;
    const tournaments = stats.activeTournaments || stats.recentTournaments || [];
    const ongoing = tournaments
      .filter(t => getTournamentStatus(t) === 'en cours')
      .sort((a, b) => new Date(b.startDate) - new Date(a.startDate));
    const upcoming = tournaments
      .filter(t => getTournamentStatus(t) === 'à venir')
      .sort((a, b) => new Date(a.startDate) - new Date(b.startDate))[0];
    const tournamentLink = (t) => `<a href="/tournament-detail.html?id=${encodeURIComponent(t._id || t.id)}">${escHtml(t.name)}</a>`;
    let tournamentHtml = '';
    if (ongoing.length) {
      const label = ongoing.length > 1
        ? overviewT('gameDetail.ongoingTournaments', 'Tournaments in progress:')
        : overviewT('gameDetail.ongoingTournament', 'Tournament in progress:');
      const more = ongoing.length > MAX_ONGOING
        ? ` <a href="/tournaments.html?game=${encodeURIComponent(game.id)}">+${ongoing.length - MAX_ONGOING}</a>`
        : '';
      tournamentHtml += `<p class="game-overview-tournament">🏆 ${escHtml(label)} ${ongoing.slice(0, MAX_ONGOING).map(tournamentLink).join(' · ')}${more}</p>`;
    }
    if (upcoming) {
      const date = upcoming.startDate
        ? ` (${new Date(upcoming.startDate).toLocaleDateString(overviewLocale(), { day: 'numeric', month: 'short' })})`
        : '';
      tournamentHtml += `<p class="game-overview-tournament">📅 ${escHtml(overviewT('gameDetail.upcomingTournament', 'Next tournament:'))} ${tournamentLink(upcoming)}${escHtml(date)}</p>`;
    }

    el.innerHTML = `
      ${facts.length ? `<p class="game-overview-facts">${facts.join(' · ')}</p>` : ''}
      ${figures.length ? `<div class="game-overview-figures">${figures.join('')}</div>` : ''}
      ${tournamentHtml}
      <div class="game-overview-actions">
        <button type="button" class="home-hero-btn home-hero-btn-primary" data-overview-tab="resources">${escHtml(overviewT('gameDetail.ctaStart', '🚀 Get started'))}</button>
        ${hasRaces ? `<a class="home-hero-btn" href="/races.html?game=${encodeURIComponent(game.id)}">${escHtml(overviewT('gameDetail.ctaRaces', 'See the races'))}</a>` : ''}
        ${hasTournaments ? `<a class="home-hero-btn" href="/tournaments.html?game=${encodeURIComponent(game.id)}">${escHtml(overviewT('gameDetail.ctaTournaments', 'See the tournaments'))}</a>` : ''}
      </div>
    `;

    // "Get started" and the live count open their tab and bring it into view
    el.querySelectorAll('[data-overview-tab]').forEach(link => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        selectTab(link.getAttribute('data-overview-tab'));
        document.querySelector('.tabs-container')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  async function load(){
    try{
      const game = await fetchJson('/api/games/'+encodeURIComponent(id));
      titleEl.textContent = game.name || id;
      
      // Without a cover the poster shows the id, like on the games list
      const missingPosterEl = document.getElementById('game-poster-missing');
      const missingNameEl = document.createElement('span');
      missingNameEl.className = 'poster-missing-name';
      missingNameEl.textContent = (game.id || id).toLowerCase();
      missingPosterEl.replaceChildren(missingNameEl);
      posterEl.alt = game.name;
      if (game.cover) {
        posterEl.src = game.cover;
      } else {
        posterEl.style.display = 'none';
        missingPosterEl.style.display = 'flex';
      }

      // Afficher randomizer.displayName en titre principal (h1)
      // et official.name en sous-titre (h2)
      const displayTitle = game.randomizer?.displayName || game.randomizer?.shortName || game.officialName || `${game.name} Randomizer`;
      const gameName = game.official?.name || game.name;
      
      // The "Loading..." key would put the placeholder back when the translations arrive
      metaEl.removeAttribute('data-i18n');
      metaEl.textContent = displayTitle || '';
      titleEl.textContent = gameName || '';
      
      if (siteEl) {
        // Same rule as the resources block: chosen official site, else the only known site, else the legacy field
        const resources = game.resources || {};
        const website = resources.officialSite?.url || (resources.sites?.length === 1 ? resources.sites[0].url : '') || game.randomizer?.website;
        const websiteLinkAttrs = buildExternalLinkAttrs(website);
        const renderSite = () => {
          siteEl.innerHTML = websiteLinkAttrs ? `<div><a ${websiteLinkAttrs} style="color:#60a5fa;">${escHtml(overviewT('common.officialSite', 'Official site'))}</a></div>` : '';
        };
        renderSite();
        window.addEventListener('languageChanged', renderSite);
      }

      // Load and render resources (sites, trackers, guides)
      loadResources(id);

      // Load stats with recent data
      const stats = await fetchJson('/api/games/'+encodeURIComponent(id)+'/stats');
      applyGameSeo(game, stats);

      let liveCount = 0;
      renderOverview(game, stats, liveCount);
      window.addEventListener('languageChanged', () => renderOverview(game, stats, liveCount));
      // Live count arrives later (the streams stats can take a while to build)
      fetchJson('/api/streams/stats/by-game')
        .then(data => {
          liveCount = data?.stats?.[game.id]?.streamers || 0;
          if (liveCount > 0) renderOverview(game, stats, liveCount);
        })
        .catch(() => {});
      
      const racesUrl = `/races.html?game=${encodeURIComponent(id)}`;
      const tournamentsUrl = `/tournaments.html?game=${encodeURIComponent(id)}`;
      const racesLabel = typeof i18n !== 'undefined' ? i18n.t('gameDetail.races') : 'Races';
      const tournamentsLabel = typeof i18n !== 'undefined' ? i18n.t('gameDetail.tournaments') : 'Tournois';
      statsEl.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-bottom:2rem;">
          <a href="${racesUrl}" style="text-decoration:none;">
            <div style="background:#374151;padding:1.25rem;border-radius:0.5rem;text-align:center;cursor:pointer;transition:background 0.2s;" data-hover-style="background:#4b5563" data-rest-style="background:#374151">
              <div style="color:#60a5fa;font-size:2rem;font-weight:bold;">${stats.totalRaces}</div>
              <div style="color:#9ca3af;font-size:0.875rem;">${racesLabel}</div>
            </div>
          </a>
          <a href="${tournamentsUrl}" style="text-decoration:none;">
            <div style="background:#374151;padding:1.25rem;border-radius:0.5rem;text-align:center;cursor:pointer;transition:background 0.2s;" data-hover-style="background:#4b5563" data-rest-style="background:#374151">
              <div style="color:#fbbf24;font-size:2rem;font-weight:bold;">${stats.totalTournaments}</div>
              <div style="color:#9ca3af;font-size:0.875rem;">${tournamentsLabel}</div>
            </div>
          </a>
        </div>
      `;

      // Render recent races
      const recentRaces = stats.recentRaces || [];
      if (recentRaces.length > 0) {
        racesEl.innerHTML = recentRaces.map(cardRace).join('');
      } else {
        const noRacesMsg = typeof i18n !== 'undefined' ? i18n.t('gameDetail.noRecentRaces') : 'No recent races';
        racesEl.innerHTML = `<p style="color:#9ca3af;">${noRacesMsg}</p>`;
      }

      // Render recent tournaments
      const recentTournaments = stats.recentTournaments || [];
      if (recentTournaments.length > 0) {
        // Enrich tournaments with winners from matches if needed
        Promise.all(recentTournaments.map(async (t) => {
          if ((!t.participants || t.participants.every(p => p.finalRank == null)) && !t.winner) {
            t._computedWinner = await findTournamentWinner(t._id || t.id, t);
          }
          return t;
        })).then(enriched => {
          toursEl.innerHTML = enriched.map(cardTournament).join('');
        }).catch(() => {
          toursEl.innerHTML = recentTournaments.map(cardTournament).join('');
        });
      } else {
        const noTournamentsMsg = typeof i18n !== 'undefined' ? i18n.t('gameDetail.noRecentTournaments') : 'No recent tournaments';
        toursEl.innerHTML = `<p style="color:#9ca3af;">${noTournamentsMsg}</p>`;
      }

    }catch(e){
      titleEl.textContent = (typeof i18n !== 'undefined' && typeof i18n.t === 'function') ? i18n.t('common.error') : 'Loading error';
      console.error(e);
    }
  }

  if(id) {
    load();
    loadLeaderboard();
    loadHistory(id);
    tabs = tabHistory({
      current: () => document.querySelector('.tab-btn.active')?.getAttribute('data-tab'),
      show: switchTab,
      isTab: (tab) => !!document.getElementById('tab-content-' + tab)
    });
    if (tabs.initial !== 'leaderboards') switchTab(tabs.initial);
  }

  window.addEventListener('languageChanged', () => {
    rerenderLocalizedResources();
    renderLeaderboard();
    renderCategories();
    renderHistory();
  });
})();
