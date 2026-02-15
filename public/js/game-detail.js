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

  if(!id){ titleEl.textContent = 'Game not specified'; }

  async function fetchJson(url){ const res = await fetch(url); if(!res.ok) throw new Error('Fetch failed'); return res.json(); }

  function formatDate(d) {
    if (!d) return '-';
    let locale = 'en-US';
    if (typeof i18n !== 'undefined' && typeof i18n.getCurrentLanguage === 'function') {
      const lang = i18n.getCurrentLanguage();
      const localeMap = { 'en': 'en-US', 'fr': 'fr-FR', 'de': 'de-DE', 'es': 'es-ES', 'it': 'it-IT' };
      locale = localeMap[lang] || 'en-US';
    }
    return new Date(d).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function formatDateTime(d) {
    if (!d) return '-';
    let locale = 'en-US';
    if (typeof i18n !== 'undefined' && typeof i18n.getCurrentLanguage === 'function') {
      const lang = i18n.getCurrentLanguage();
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
    
    // Find winner: first check finalRank, then check _computedWinner
    let winnerHtml = '';
    let winner = null;
    
    if (t.participants && t.participants.length > 0) {
      winner = t.participants.find(p => p.finalRank != null && p.finalRank === 1);
    }
    
    if (!winner && t._computedWinner) {
      winnerHtml = `<div class="spoiler-block" style="color:#fbbf24;font-size:0.8rem;margin-top:0.5rem;"><span>🏆</span> <span style="color:#d1d5db;">${t._computedWinner}</span></div>`;
    } else if (winner) {
      winnerHtml = `<div class="spoiler-block" style="color:#fbbf24;font-size:0.8rem;margin-top:0.5rem;"><span>🏆</span> <span style="color:#d1d5db;">${winner.displayName || winner.name || 'Gagnant'}</span></div>`;
    }
    
    return `
      <a href="/tournament-detail.html?id=${encodeURIComponent(tid)}" style="text-decoration:none;color:inherit;display:block;">
        <div style="background:#374151;padding:1rem;border-radius:0.5rem;margin-bottom:0.75rem;transition:background 0.2s;cursor:pointer;" onmouseover="this.style.background='#4b5563'" onmouseout="this.style.background='#374151'">
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
        <div style="background:#374151;padding:1rem;border-radius:0.5rem;margin-bottom:0.75rem;transition:background 0.2s;cursor:pointer;" onmouseover="this.style.background='#4b5563'" onmouseout="this.style.background='#374151'">
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
    const escapeHtml = (str) => String(str).replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
    const formatViewers = (count) => {
      if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
      if (count >= 1000) return (count / 1000).toFixed(1) + 'K';
      return count;
    };
    
    return `
      <a href="${s.url}" target="_blank" rel="noopener" class="stream-card">
        <div class="stream-thumbnail">
          <img src="${thumbUrl}" 
               alt="${escapeHtml(s.title || '')}" 
               loading="lazy"
               onerror="this.onerror=null; this.src='data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27320%27 height=%27180%27%3E%3Crect fill=%27%23374151%27 width=%27320%27 height=%27180%27/%3E%3Ctext x=%2750%25%27 y=%2750%25%27 font-size=%2740%27 fill=%27%236b7280%27 text-anchor=%27middle%27 dy=%27.3em%27%3E📺%3C/text%3E%3C/svg%3E';">
          <span class="stream-live-badge">${typeof i18n !== 'undefined' ? i18n.t('streams.live') : 'EN DIRECT'}</span>
          ${s.viewerCount ? `<span class="stream-viewers">👁 ${formatViewers(s.viewerCount)}</span>` : ''}
        </div>
        <div class="stream-info">
          <div class="stream-title">${escapeHtml(s.title || 'Sans titre')}</div>
          <div class="stream-channel">${escapeHtml(s.userName || s.userLogin || 'Unknown')}</div>
          ${s.gameName ? `<div class="stream-game">🎮 ${escapeHtml(s.gameName)}</div>` : ''}
        </div>
      </a>
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
    btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab')));
  });

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

  // Category data structure for games
  // This can be extended or moved to an API later
  const GAME_CATEGORIES = {
    'sm64': {
      name: 'Super Mario 64 Randomizer',
      description: 'Le randomizer SM64 est un système modulaire avec plusieurs axes de randomisation combinables.',
      mainCategories: [
        {
          name: '70 Star',
          description: 'Collecter 70 étoiles et battre Bowser. La catégorie standard.',
          tags: ['Standard', 'Compétitif']
        },
        {
          name: '70 Star Non Stop',
          description: 'Collecter 70 étoiles sans quitter les niveaux (pas de reset au château).',
          tags: ['Challenge']
        },
        {
          name: '120 Star',
          description: 'Collecter toutes les 120 étoiles du jeu.',
          tags: ['Complet']
        },
        {
          name: '120 Star Non Stop',
          description: 'Toutes les 120 étoiles sans quitter les niveaux.',
          tags: ['Challenge', 'Complet']
        }
      ],
      randomizationAxes: [
        {
          name: 'Entrées de niveaux (Level Entrance)',
          description: 'Chaque entrée du château mène à un niveau différent.',
          options: ['Castle-only', 'Including Grounds', 'Including Bowser Stages']
        },
        {
          name: 'Étoiles (Star Shuffle)',
          description: 'Les étoiles sont redistribuées entre les niveaux.',
          options: ['Same-level shuffle', 'Cross-level shuffle', '100 Coins included/excluded']
        },
        {
          name: 'Progression (Keys/Caps)',
          description: 'Clés et casquettes peuvent être randomisées.',
          options: ['Keys: Fixes/Randomisées', 'Caps: Normales/Randomisées', 'MIPS: Normal/Randomisé']
        }
      ],
      logicModes: [
        { name: 'No Logic', description: 'Tout est possible, softlocks possibles' },
        { name: 'Basic Logic', description: 'Progression minimale assurée' },
        { name: 'Advanced Logic', description: 'Suppose des techniques avancées' },
        { name: 'Glitch Logic', description: 'BLJ et exploits autorisés' }
      ]
    },
    'alttp': {
      name: 'A Link to the Past Randomizer',
      description: 'ALTTPR offre une grande variété d\'options de randomisation. Consultez alttpr.com/options pour les détails complets.',
      mainCategories: [
        {
          name: 'Standard',
          description: 'Mode standard avec progression logique normale.',
          tags: ['Standard', 'Compétitif']
        },
        {
          name: 'Open',
          description: 'Début avec équipement initial, accès immédiat à la majorité du monde.',
          tags: ['Standard', 'Compétitif']
        },
        {
          name: 'Inverted',
          description: 'Commence dans le Dark World, logique inversée.',
          tags: ['Challenge']
        },
        {
          name: 'Keysanity',
          description: 'Clés de donjon mélangées dans le pool global.',
          tags: ['Challenge', 'Long']
        },
        {
          name: 'Entrance Randomizer',
          description: 'Les entrées des donjons et grottes sont mélangées.',
          tags: ['Challenge', 'Exploration']
        }
      ],
      randomizationAxes: [
        {
          name: 'Item Placement',
          description: 'Comment les objets sont placés dans le monde.',
          options: ['Standard', 'Keysanity', 'Retro', 'Full Keysanity']
        },
        {
          name: 'Entrance Shuffle',
          description: 'Mélange des entrées de donjons et grottes.',
          options: ['None', 'Simple', 'Restricted', 'Full', 'Crossed', 'Insanity']
        },
        {
          name: 'Boss Shuffle',
          description: 'Les boss peuvent être mélangés entre donjons.',
          options: ['None', 'Simple', 'Full', 'Random']
        },
        {
          name: 'Enemy Shuffle',
          description: 'Les ennemis sont randomisés.',
          options: ['None', 'Shuffled', 'Random']
        }
      ],
      externalLinks: [
        { name: 'Options complètes', url: 'https://alttpr.com/en/options' },
        { name: 'Générateur de seed', url: 'https://alttpr.com/en/randomizer' }
      ]
    }
  };

  function renderCategories(gameId) {
    const data = GAME_CATEGORIES[gameId.toLowerCase()];
    
    if (!data) {
      const comingSoonText = typeof i18n !== 'undefined' ? i18n.t('gameDetail.categoriesComingSoon') : 'Category documentation coming soon...';
      categoriesContentEl.innerHTML = `<p style="color:#9ca3af;">${comingSoonText}</p>`;
      return;
    }

    let html = '';

    // Main categories section
    if (data.mainCategories && data.mainCategories.length > 0) {
      const mainCatTitle = typeof i18n !== 'undefined' ? 'Catégories principales' : 'Main Categories';
      html += `<div style="margin-bottom:2rem;">
        <h3 style="color:#fbbf24;margin-bottom:1rem;font-size:1.25rem;">${mainCatTitle}</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(280px, 1fr));gap:1rem;">`;
      
      data.mainCategories.forEach(cat => {
        const tagsHtml = (cat.tags || []).map(tag => 
          `<span style="background:#374151;color:#9ca3af;padding:0.125rem 0.5rem;border-radius:0.25rem;font-size:0.7rem;">${tag}</span>`
        ).join(' ');
        
        html += `
          <div style="background:#1f2937;padding:1rem;border-radius:0.5rem;border-left:3px solid #fbbf24;">
            <h4 style="color:#60a5fa;margin-bottom:0.5rem;">${cat.name}</h4>
            <p style="color:#d1d5db;font-size:0.875rem;margin-bottom:0.5rem;">${cat.description}</p>
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">${tagsHtml}</div>
          </div>
        `;
      });
      html += `</div></div>`;
    }

    // Randomization axes section
    if (data.randomizationAxes && data.randomizationAxes.length > 0) {
      const axesTitle = typeof i18n !== 'undefined' ? 'Axes de randomisation' : 'Randomization Options';
      html += `<div style="margin-bottom:2rem;">
        <h3 style="color:#fbbf24;margin-bottom:1rem;font-size:1.25rem;">${axesTitle}</h3>`;
      
      data.randomizationAxes.forEach(axis => {
        const optionsHtml = (axis.options || []).map(opt => 
          `<span style="background:#374151;color:#10b981;padding:0.25rem 0.75rem;border-radius:0.25rem;font-size:0.8rem;">${opt}</span>`
        ).join(' ');
        
        html += `
          <div style="background:#1f2937;padding:1rem;border-radius:0.5rem;margin-bottom:0.75rem;">
            <h4 style="color:#60a5fa;margin-bottom:0.25rem;">${axis.name}</h4>
            <p style="color:#9ca3af;font-size:0.875rem;margin-bottom:0.75rem;">${axis.description}</p>
            <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">${optionsHtml}</div>
          </div>
        `;
      });
      html += `</div>`;
    }

    // Logic modes section (if present)
    if (data.logicModes && data.logicModes.length > 0) {
      const logicTitle = typeof i18n !== 'undefined' ? 'Modes de logique' : 'Logic Modes';
      html += `<div style="margin-bottom:2rem;">
        <h3 style="color:#fbbf24;margin-bottom:1rem;font-size:1.25rem;">${logicTitle}</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(200px, 1fr));gap:0.75rem;">`;
      
      data.logicModes.forEach(mode => {
        html += `
          <div style="background:#1f2937;padding:0.75rem;border-radius:0.5rem;">
            <h4 style="color:#8b5cf6;font-size:0.9rem;margin-bottom:0.25rem;">${mode.name}</h4>
            <p style="color:#9ca3af;font-size:0.8rem;">${mode.description}</p>
          </div>
        `;
      });
      html += `</div></div>`;
    }

    // External links section (if present)
    if (data.externalLinks && data.externalLinks.length > 0) {
      const linksTitle = typeof i18n !== 'undefined' ? 'Liens utiles' : 'Useful Links';
      html += `<div style="margin-bottom:2rem;">
        <h3 style="color:#fbbf24;margin-bottom:1rem;font-size:1.25rem;">${linksTitle}</h3>
        <div style="display:flex;gap:1rem;flex-wrap:wrap;">`;
      
      data.externalLinks.forEach(link => {
        html += `
          <a href="${link.url}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:0.5rem;background:#374151;color:#60a5fa;padding:0.5rem 1rem;border-radius:0.5rem;text-decoration:none;transition:background 0.2s;" onmouseover="this.style.background='#4b5563'" onmouseout="this.style.background='#374151'">
            🔗 ${link.name}
          </a>
        `;
      });
      html += `</div></div>`;
    }

    categoriesContentEl.innerHTML = html;
  }

  function loadCategories() {
    if (categoriesLoaded) return;
    categoriesLoaded = true;
    renderCategories(id);
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
      !!site?.isArchipelago
    );
  }

  function renderLinkChip(link, icon = '🔗') {
    let lang = 'en';
    if (typeof i18n !== 'undefined' && typeof i18n.getCurrentLanguage === 'function') {
      lang = i18n.getCurrentLanguage() || 'en';
    }
    const tr = link?.translations?.[lang] || null;
    const displayName = tr?.name || link.name || getHostFromUrl(link.url) || link.url;
    const displayDescription = tr?.description || link.description || '';

    const name = escapeHtml(displayName);
    const desc = displayDescription ? `<div style="color:#9ca3af;font-size:0.8rem;margin-top:0.25rem;">${escapeHtml(displayDescription)}</div>` : '';
    return `
      <a href="${link.url}" target="_blank" rel="noopener"
         style="display:block;background:#1f2937;padding:0.875rem 1rem;border-radius:0.5rem;text-decoration:none;transition:background 0.2s;border:1px solid #374151;"
         onmouseover="this.style.background='#374151'"
         onmouseout="this.style.background='#1f2937'">
        <div style="display:flex;align-items:center;gap:0.5rem;color:#60a5fa;font-weight:500;">
          <span>${icon}</span>
          <span>${name}</span>
        </div>
        ${desc}
      </a>
    `;
  }

  function t(key, fallback) {
    if (typeof i18n !== 'undefined' && typeof i18n.t === 'function') {
      const value = i18n.t(key);
      if (value && value !== key) return value;
    }
    return fallback;
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
        ${communityLinks.map(link => renderLinkChip(link, '💬')).join('')}
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
      renderCommunity(data, communityEl);
      renderResources(data, resourcesEl);
    } catch (e) {
      console.error('Error loading resources:', e);
      resourcesEl.innerHTML = '';
      if (communityEl) communityEl.innerHTML = '';
    }
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
    const multiworldSites = sites.filter(site => site.url !== officialUrl && isMultiworldSite(site));

    let html = '';

    if (officialSite?.url) {
      const siteName = escapeHtml(officialSite.name || t('common.officialSite', 'Official site'));
      html += `
        <div style="margin-bottom:1.5rem;">
          <h3 style="color:#fbbf24;margin-bottom:0.75rem;font-size:1.1rem;display:flex;align-items:center;gap:0.5rem;">
            <span>🌐</span> ${t('gameDetail.resourceOfficialSite', 'Official site')}
          </h3>
          <a href="${officialSite.url}" target="_blank" rel="noopener"
             style="display:inline-flex;align-items:center;gap:0.75rem;background:linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);color:white;padding:0.875rem 1.25rem;border-radius:0.75rem;text-decoration:none;font-weight:600;transition:transform 0.2s, box-shadow 0.2s;box-shadow:0 4px 15px rgba(59, 130, 246, 0.4);"
             onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 6px 20px rgba(59, 130, 246, 0.5)'"
             onmouseout="this.style.transform='translateY(0)';this.style.boxShadow='0 4px 15px rgba(59, 130, 246, 0.4)'">
            <span style="font-size:1.125rem;">↗</span>
            <span>${siteName}</span>
          </a>
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
              description: ''
            }, '🏝️')).join('')}
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

  async function load(){
    try{
      const game = await fetchJson('/api/games/'+encodeURIComponent(id));
      titleEl.textContent = game.name || id;
      
      // Set poster image (utiliser game.image/logo ou construire depuis l'ID)
      let image = game.image || game.logo;
      if (!image || !image.startsWith('assets/')) {
        // Fallback: construire depuis l'ID du jeu
        const gameId = (game.id || '').toLowerCase();
        image = `/assets/${gameId}.png`;
      } else if (!image.startsWith('/')) {
        // Ajouter le / si nécessaire
        image = `/${image}`;
      }
      posterEl.src = image;
      posterEl.alt = game.name;

      // Afficher randomizer.displayName (ex: "A Link to the Past Randomizer") en titre principal (h1)
      // et official.name (ex: "The Legend of Zelda: A Link to the Past") en sous-titre (h2)
      const displayTitle = game.randomizer?.displayName || game.randomizer?.shortName || game.officialName || `${game.name} Randomizer`;
      const gameName = game.official?.name || game.name;
      
      metaEl.textContent = displayTitle || '';
      titleEl.textContent = gameName || '';
      
      if (siteEl) {
        const website = game.randomizer?.website || game.officialWebsite;
        siteEl.innerHTML = website ? `<div><a href="${website}" target="_blank" style="color:#60a5fa;">${typeof i18n !== 'undefined' ? i18n.t('common.officialSite') : 'Official site'}</a></div>` : '';
      }

      // Load and render resources (sites, trackers, guides)
      loadResources(id);

      // Load stats with recent data
      const stats = await fetchJson('/api/games/'+encodeURIComponent(id)+'/stats');
      
      const racesUrl = `/races.html?game=${encodeURIComponent(id)}`;
      const tournamentsUrl = `/tournaments.html?game=${encodeURIComponent(id)}`;
      const racesLabel = typeof i18n !== 'undefined' ? i18n.t('gameDetail.races') : 'Races';
      const tournamentsLabel = typeof i18n !== 'undefined' ? i18n.t('gameDetail.tournaments') : 'Tournois';
      statsEl.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-bottom:2rem;">
          <a href="${racesUrl}" style="text-decoration:none;">
            <div style="background:#374151;padding:1.25rem;border-radius:0.5rem;text-align:center;cursor:pointer;transition:background 0.2s;" onmouseover="this.style.background='#4b5563'" onmouseout="this.style.background='#374151'">
              <div style="color:#60a5fa;font-size:2rem;font-weight:bold;">${stats.totalRaces}</div>
              <div style="color:#9ca3af;font-size:0.875rem;">${racesLabel}</div>
            </div>
          </a>
          <a href="${tournamentsUrl}" style="text-decoration:none;">
            <div style="background:#374151;padding:1.25rem;border-radius:0.5rem;text-align:center;cursor:pointer;transition:background 0.2s;" onmouseover="this.style.background='#4b5563'" onmouseout="this.style.background='#374151'">
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

  if(id) load();
})();
