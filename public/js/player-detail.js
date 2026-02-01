(function(){
  // Avatar cache with localStorage persistence
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
        // Ignore cache errors
      }
    }
  };

  function qs(name){
    const m = location.search.match(new RegExp('[?&]'+name+'=([^&]+)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  const id = qs('id');
  const nameParam = qs('name');
  const headerName = document.getElementById('player-name');
  const avatarEl = document.getElementById('player-avatar');
  const playerLinks = document.getElementById('player-links');
  const statsEl = document.getElementById('player-stats');
  const toursEl = document.getElementById('player-tournaments-list');
  const racesEl = document.getElementById('player-races-list');

  if(!id && !nameParam){ headerName.textContent = 'No player specified'; }

  async function fetchJson(url){
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if(!res.ok) throw new Error('Fetch failed: '+res.status);
    return res.json();
  }

  // Fetch Twitch URL from Racetime profile
  async function fetchTwitchFromRacetime(racetimeUrl) {
    try {
      const res = await fetch('/api/racetime/twitch?url=' + encodeURIComponent(racetimeUrl));
      if (!res.ok) return null;
      const data = await res.json();
      return data.twitch || null;
    } catch (e) {
      return null;
    }
  }

  // Check if a Twitch user is currently live
  async function checkIfLive(twitchUsername, twitchBtn) {
    if (!twitchUsername || !twitchBtn) return;
    
    try {
      const res = await fetch('/api/streams');
      if (!res.ok) return;
      const data = await res.json();
      const streams = data.streams || [];
      
      // Find if this user is streaming
      const isLive = streams.some(stream => {
        const streamUser = (
          stream.userLogin ||
          stream.user_login || 
          stream.userName ||
          stream.user_name || 
          stream.twitchUsername || 
          stream.twitch || 
          stream.username ||
          stream.login ||
          stream.display_name ||
          stream.displayName ||
          (stream.user && stream.user.login) ||
          (stream.user && stream.user.name) ||
          ''
        ).toLowerCase();
        
        return streamUser === twitchUsername.toLowerCase();
      });
      
      if (isLive) {
        // Add live indicator dot (top-right of button)
        const existingDot = twitchBtn.querySelector('.live-dot');
        if (!existingDot) {
          // Make button position relative for absolute positioning of dot
          twitchBtn.style.position = 'relative';
          
          const liveDot = document.createElement('span');
          liveDot.className = 'live-dot';
          liveDot.style.cssText = 'position:absolute;top:-4px;right:-4px;width:12px;height:12px;background:#dc2626;border:2px solid #1f2937;border-radius:50%;animation:pulse 2s cubic-bezier(0.4,0,0.6,1) infinite;';
          twitchBtn.appendChild(liveDot);
        }
      }
    } catch (e) {
      // Silently fail - live status is not critical
    }
  }

  // Helper to try loading Twitch avatar
  async function tryTwitchAvatar(twitchUsername, playerName) {
    if (!twitchUsername) return false;
    
    try {
      const res = await fetch('/api/streams/twitch-avatar/' + encodeURIComponent(twitchUsername), {
        method: 'GET',
        cache: 'default'
      });
      
      if (res.ok && res.status !== 204) {
        const ct = res.headers.get('Content-Type') || '';
        if (ct.indexOf('image/') === 0) {
          const blob = await res.blob();
          if (blob.size > 0) {
            const objUrl = URL.createObjectURL(blob);
            avatarEl.onload = () => { 
              avatarEl.alt = playerName + ' avatar'; 
              URL.revokeObjectURL(objUrl); 
            };
            avatarEl.onerror = null;
            avatarEl.src = objUrl;
            return true;
          }
        }
      }
    } catch (e) {
      // Continue
    }
    return false;
  }

  // Load avatar with cascade: Racetime → Twitch → Placeholder
  async function loadAvatar(p){
    const playerKey = p.name || p.userId || 'unknown';
    
    function setPlaceholder(){
      avatarEl.src = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="200" height="200"%3E%3Crect fill="%23374151" width="200" height="200"/%3E%3Ctext x="50%25" y="50%25" font-size="64" fill="%23fbbf24" text-anchor="middle" dy=".3em"%3E' + (p.name ? p.name[0].toUpperCase() : '?') + '%3C/text%3E%3C/svg%3E';
      avatarEl.alt = 'Avatar';
    }

    // Check cache first
    const cached = avatarCache.get(playerKey);
    if (cached) {
      avatarEl.src = cached;
      return;
    }

    // clear any previous handlers
    avatarEl.onload = null;
    avatarEl.onerror = null;

    let racetimeUrl = null;
    let twitchUsername = p.twitch || p.twitchUsername || null;

    // Step 1: Try Racetime avatar if available
    if (p.racetimeUrl || p.racetimeId) {
      racetimeUrl = p.racetimeUrl ? p.racetimeUrl.replace(/\/+$/, '') : ('https://racetime.gg/user/' + encodeURIComponent(p.racetimeId));

      // Use proxy which handles parsing
      const proxy = '/api/racetime/avatar?url=' + encodeURIComponent(racetimeUrl) + (p.name ? '&name=' + encodeURIComponent(p.name) : '');
      
      try {
        const res = await fetch(proxy, { method: 'GET' });
        if (res.ok && res.status !== 204) {
          const ct = res.headers.get('Content-Type') || '';
          if (ct.indexOf('image/') === 0) {
            const blob = await res.blob();
            if (blob.size > 0) {
              const objUrl = URL.createObjectURL(blob);
              avatarEl.onload = () => { 
                avatarEl.alt = (p.name || p.userId) + ' avatar'; 
                URL.revokeObjectURL(objUrl); 
              };
              avatarEl.onerror = null;
              avatarEl.src = objUrl;
              return; // Stop here - Racetime avatar found, don't try Twitch
            }
          }
        }
      } catch (e) {
        // Continue to Twitch fallback
      }
    }

    // Step 2: Try to get Twitch username from Racetime profile if not provided (only if Racetime failed)
    if (!twitchUsername && racetimeUrl) {
      const fetchedTwitch = await fetchTwitchFromRacetime(racetimeUrl);
      if (fetchedTwitch) {
        twitchUsername = fetchedTwitch.split('/').pop();
      }
    }

    // Step 3: If no racetime URL, try to find the profile
    if (!racetimeUrl && p.name) {
      try {
        const find = await fetch('/api/racetime/find?q=' + encodeURIComponent(p.name));
        if (find.ok) {
          const j = await find.json();
          if (j && j.url) {
            racetimeUrl = j.url;
            
            // Try avatar from found profile
            const proxy = '/api/racetime/avatar?url=' + encodeURIComponent(j.url) + '&name=' + encodeURIComponent(p.name);
            try {
              const res = await fetch(proxy, { method: 'GET' });
              if (res.ok && res.status !== 204) {
                const ct = res.headers.get('Content-Type') || '';
                if (ct.indexOf('image/') === 0) {
                  const blob = await res.blob();
                  if (blob.size > 0) {
                    const objUrl = URL.createObjectURL(blob);
                    avatarEl.onload = () => { 
                      avatarEl.alt = p.name + ' avatar'; 
                      URL.revokeObjectURL(objUrl); 
                    };
                    avatarEl.onerror = null;
                    avatarEl.src = objUrl;
                    return;
                  }
                }
              }
            } catch (e) {
              // Continue
            }
            
            // Try to get Twitch from found profile
            if (!twitchUsername) {
              const fetchedTwitch = await fetchTwitchFromRacetime(j.url);
              if (fetchedTwitch) {
                twitchUsername = fetchedTwitch.split('/').pop();
              }
            }
          }
        }
      } catch (e) { /* ignore */ }
    }

    // Step 4: Try Twitch avatar
    if (twitchUsername) {
      const success = await tryTwitchAvatar(twitchUsername, p.name || p.userId || 'Player');
      if (success) {
        return;
      }
    }

    // Fallback: Use placeholder (don't cache placeholders)
    setPlaceholder();
  }

  function formatDate(d){ if(!d) return '-'; const t = new Date(d); return t.toLocaleString(); }

  function formatRank(n){
    if (n === null || typeof n === 'undefined' || n === '') return '-';
    const num = Number(n);
    if (Number.isNaN(num)) return String(n);
    if (num === 1) return '1er';
    return `${num}ème`;
  }

  function renderProfile(p, tournaments){
    headerName.textContent = p.name || p.userId || 'Joueur inconnu';

    // Kick off avatar loading asynchronously so the rest of the profile renders fast
    loadAvatar(p).catch(() => {});

    const links = [];
    
    // Racetime: prefer explicit URL, fallback to racetimeId
    let racetimeUrl = null;
    if (p.racetimeUrl) {
      racetimeUrl = p.racetimeUrl;
      links.push(`<a class="btn-racetime" href="${p.racetimeUrl}" target="_blank" rel="noopener noreferrer"><img src="/assets/racetime.svg" alt="Racetime">Racetime</a>`);
    } else if (p.racetimeId) {
      racetimeUrl = 'https://racetime.gg/user/' + encodeURIComponent(p.racetimeId);
      links.push(`<a class="btn-racetime" href="${racetimeUrl}" target="_blank" rel="noopener noreferrer"><img src="/assets/racetime.svg" alt="Racetime">Racetime</a>`);
    }
    
    if (p.challongeUrl) {
      links.push(`<a href="${p.challongeUrl}" target="_blank" rel="noopener noreferrer">Challonge</a>`);
    }
    
    // Only set links if this player object provides any; otherwise preserve existing links
    if (links.length) {
      playerLinks.innerHTML = links.join('');
    }
    
    // If we have a racetime URL, try to fetch Twitch from racetime (only if not already in DB)
    if (racetimeUrl && !p.twitch) {
      fetchTwitchFromRacetime(racetimeUrl).then(twitchUrl => {
        if (twitchUrl) {
          // Only add if not already present
          if (!playerLinks.querySelector('.btn-twitch')) {
            const twitchUsername = twitchUrl.split('/').pop();
            const twitchBtn = document.createElement('a');
            twitchBtn.className = 'btn-twitch';
            twitchBtn.href = twitchUrl;
            twitchBtn.target = '_blank';
            twitchBtn.rel = 'noopener noreferrer';
            twitchBtn.innerHTML = '<img src="/assets/twitch.svg" alt="Twitch">Twitch';
            twitchBtn.setAttribute('data-twitch-username', twitchUsername);
            
            // Insert after Racetime button if it exists, or at the end
            const racetimeBtn = playerLinks.querySelector('.btn-racetime');
            if (racetimeBtn && racetimeBtn.nextSibling) {
              playerLinks.insertBefore(twitchBtn, racetimeBtn.nextSibling);
            } else {
              playerLinks.appendChild(twitchBtn);
            }
            
            // Check if live (pass button directly)
            checkIfLive(twitchUsername, twitchBtn);
          }
        }
      }).catch(() => {});
    } else if (p.twitch) {
      // Add Twitch button if we have it directly in the DB
      const twitchBtn = document.createElement('a');
      twitchBtn.className = 'btn-twitch';
      twitchBtn.href = `https://twitch.tv/${encodeURIComponent(p.twitch)}`;
      twitchBtn.target = '_blank';
      twitchBtn.rel = 'noopener noreferrer';
      twitchBtn.innerHTML = '<img src="/assets/twitch.svg" alt="Twitch">Twitch';
      twitchBtn.setAttribute('data-twitch-username', p.twitch);
      
      const racetimeBtn = playerLinks.querySelector('.btn-racetime');
      if (racetimeBtn && racetimeBtn.nextSibling) {
        playerLinks.insertBefore(twitchBtn, racetimeBtn.nextSibling);
      } else {
        playerLinks.appendChild(twitchBtn);
      }
      
      // Check if live (pass button directly)
      checkIfLive(p.twitch, twitchBtn);
    }

    // Stats cards
    const gamesCount = countGamesFromTournaments(tournaments || []);
    const totalRaces = p.stats ? (p.stats.totalRaces || 0) : 0;
    const totalTournaments = (tournaments || []).length;
    
    const labelGamesPlayed = typeof i18n !== 'undefined' ? i18n.t('playerDetail.gamesPlayed') : 'Games Played';
    const labelRaces = typeof i18n !== 'undefined' ? i18n.t('playerDetail.races') : 'Races';
    const labelTournaments = typeof i18n !== 'undefined' ? i18n.t('playerDetail.tournaments') : 'Tournaments';
    
    statsEl.innerHTML = `
      <div style="background:#374151;padding:1rem;border-radius:0.5rem;"><div style="color:#9ca3af;font-size:0.875rem;">${labelGamesPlayed}</div><div style="color:#fff;font-size:1.5rem;font-weight:bold;">${gamesCount}</div></div>
      <div style="background:#374151;padding:1rem;border-radius:0.5rem;"><div style="color:#9ca3af;font-size:0.875rem;">${labelRaces}</div><div style="color:#fff;font-size:1.5rem;font-weight:bold;">${totalRaces}</div></div>
      <div style="background:#374151;padding:1rem;border-radius:0.5rem;"><div style="color:#9ca3af;font-size:0.875rem;">${labelTournaments}</div><div style="color:#fff;font-size:1.5rem;font-weight:bold;">${totalTournaments}</div></div>
    `;
  }
  function getTournamentGameName(t) {
    if (!t) return '-';
    // Only return explicit game name fields, never the tournament name
    return t.gameName
      || t.tournamentGameName
      || (t.game && typeof t.game === 'object' && t.game.name)
      || (t.game && typeof t.game === 'string' ? t.game : null)
      || (t.tournament && typeof t.tournament === 'object' && t.tournament.gameName)
      || (t.tournament && typeof t.tournament === 'object' && t.tournament.game && t.tournament.game.name)
      || (t.tournamentId && typeof t.tournamentId === 'object' && t.tournamentId.gameName)
      || (t.tournamentId && typeof t.tournamentId === 'object' && t.tournamentId.game && t.tournamentId.game.name)
      || t.gameSlug
      || '-';
  }

  // Normalize game names to count unique games properly
  function normalizeGameName(name) {
    if (!name || name === '-' || name === 'Unknown') return null;
    const lower = name.toLowerCase();
    // Check for known game patterns
    if (/ocarina\s*(of)?\s*time/i.test(lower)) return 'Ocarina of Time Randomizer';
    if (/link\s*(to)?\s*(the)?\s*past/i.test(lower)) return 'A Link to the Past Randomizer';
    if (/majora'?s?\s*mask/i.test(lower)) return "Majora's Mask Randomizer";
    if (/super\s*metroid/i.test(lower) && !/link/i.test(lower)) return 'Super Metroid Randomizer';
    if (/super\s*mario\s*64/i.test(lower)) return 'Super Mario 64 Randomizer';
    if (/wind\s*waker/i.test(lower)) return 'The Wind Waker Randomizer';
    if (/twilight\s*princess/i.test(lower)) return 'Twilight Princess Randomizer';
    if (/kingdom\s*hearts\s*(2|ii)/i.test(lower)) return 'Kingdom Hearts 2 FM Randomizer';
    if (/symphony\s*(of)?\s*(the)?\s*night/i.test(lower)) return 'Symphony of the Night Randomizer';
    if (/smz3|super\s*metroid.*link/i.test(lower)) return 'SMZ3 Combo Randomizer';
    if (/ootmm|ocarina.*majora/i.test(lower)) return 'OoT+MM Combo Randomizer';
    return name; // Return original if no match
  }

  function countGamesFromTournaments(tournaments){
    const uniqueGames = new Set();
    for(const t of tournaments){
      const g = getTournamentGameName(t);
      const normalized = normalizeGameName(g);
      if (normalized) {
        uniqueGames.add(normalized);
      }
    }
    return uniqueGames.size;
  }

  function renderTournaments(tournaments, playerName){
    if(!tournaments || !tournaments.length){ toursEl.innerHTML = '<p style="color:#9ca3af;">No tournament participation.</p>'; return; }
    // Sort by date descending (most recent first). Use multiple fallbacks for start date.
    const getStartTime = (t) => {
      if (!t) return 0;
      const candidates = [t.startDate, t.start, (t.tournament && t.tournament.startDate), (t.tournament && t.tournament.start), t.createdAt, t.updatedAt];
      for (const c of candidates) {
        if (c) {
          const n = new Date(c).getTime();
          if (Number.isFinite(n) && n > 0) return n;
        }
      }
      return 0;
    };
    const sorted = [...tournaments].sort((a,b) => {
      return getStartTime(b) - getStartTime(a);
    });
    // Render immediately using available data
    toursEl.innerHTML = sorted.map(t => {
      const tid = t._id || t.tournamentId || t.id || '';
      const gameDisplay = getTournamentGameName(t);
      const labelRanking = typeof i18n !== 'undefined' ? i18n.t('playerDetail.ranking') : 'Ranking';
      return `
      <a href="/tournament-detail.html?id=${encodeURIComponent(tid)}" style="text-decoration:none;color:inherit;display:block;">
        <div class="tournament-card" data-tid="${encodeURIComponent(tid)}" style="background:#1f2937;padding:1rem;border-radius:0.5rem;margin-bottom:1rem;">
          <h3 style="color:#fbbf24;font-size:1rem;margin-bottom:0.5rem;">${t.tournamentName || t.name || 'Tournoi'}</h3>
          <div class="tournament-game" style="color:#d1d5db;font-size:0.875rem;margin-bottom:0.25rem;">${gameDisplay}</div>
          <div class="spoiler-block" style="color:#9ca3af;font-size:0.875rem;">${labelRanking}: <strong style="color:#fbbf24;">${t.finalRank ? formatRank(t.finalRank) : '-'}</strong></div>
        </div>
      </a>
    `;
    }).join('\n');

    // If some tournaments lack date info, try to fetch full tournament docs and re-sort
    (async () => {
      try {
        const needLookup = [];
        const byTid = new Map();
        for (const t of tournaments) {
          const tid = t._id || t.tournamentId || t.id || null;
          const st = getStartTime(t);
          if ((!st || st === 0) && tid && !byTid.has(tid)) {
            byTid.set(tid, null);
            needLookup.push(tid);
          }
        }
        if (!needLookup.length) return;
        // Fetch tournament docs in parallel
        const promises = needLookup.map(tid => fetchJson('/api/tournaments/' + encodeURIComponent(tid)).catch(() => null));
        const results = await Promise.all(promises);
        // Map fetched start times
        const startMap = new Map();
        results.forEach((res, idx) => {
          const tid = needLookup[idx];
          if (res && res.startDate) startMap.set(tid, new Date(res.startDate).getTime());
        });

        // If we found any start times, attach them to tournament entries and re-render sorted
        let anyResolved = false;
        const augmented = tournaments.map(t => {
          const tid = t._id || t.tournamentId || t.id || null;
          const resolved = tid && startMap.has(tid) ? startMap.get(tid) : null;
          if (resolved) anyResolved = true;
          return Object.assign({}, t, resolved ? { _resolvedStartTime: resolved } : {});
        });
        if (!anyResolved) return;

        const getStartTimeOrResolved = (t) => {
          if (t && t._resolvedStartTime) return t._resolvedStartTime;
          return getStartTime(t);
        };

        const resorted = [...augmented].sort((a,b) => getStartTimeOrResolved(b) - getStartTimeOrResolved(a));
        // Re-render without showing dates (only used for ordering)
        const labelRanking = typeof i18n !== 'undefined' ? i18n.t('playerDetail.ranking') : 'Ranking';
        toursEl.innerHTML = resorted.map(t => {
          const tid = t._id || t.tournamentId || t.id || '';
          const gameDisplay = getTournamentGameName(t);
          return `
          <a href="/tournament-detail.html?id=${encodeURIComponent(tid)}" style="text-decoration:none;color:inherit;display:block;">
            <div class="tournament-card" data-tid="${encodeURIComponent(tid)}" style="background:#1f2937;padding:1rem;border-radius:0.5rem;margin-bottom:1rem;">
              <h3 style="color:#fbbf24;font-size:1rem;margin-bottom:0.25rem;">${t.tournamentName || t.name || 'Tournoi'}</h3>
              <div class="tournament-game" style="color:#d1d5db;font-size:0.875rem;margin-bottom:0.25rem;">${gameDisplay}</div>
              <div class="spoiler-block" style="color:#9ca3af;font-size:0.875rem;">${labelRanking}: <strong style="color:#fbbf24;">${t.finalRank ? formatRank(t.finalRank) : '-'}</strong></div>
            </div>
          </a>
        `;
        }).join('\n');
      } catch (e) { /* ignore lookup errors */ }
    })();

    // After rendering, for any tournament entries with a missing game name, fetch the tournament
    // document to try to resolve the game and update the DOM. Use decoded data-tid for robust matching.
    try {
      sorted.forEach(t => {
        const tid = t._id || t.tournamentId || t.id || '';
        if (!tid) return;
        
        // Find the card by iterating and comparing decoded data-tid
        const cards = toursEl.querySelectorAll('.tournament-card');
        for (const card of cards) {
          const dataTidRaw = card.getAttribute('data-tid') || '';
          let cardTid = dataTidRaw;
          try { cardTid = dataTidRaw ? decodeURIComponent(dataTidRaw) : dataTidRaw; } catch (e) { cardTid = dataTidRaw; }
          
          if (String(cardTid) === String(tid)) {
            const el = card.querySelector('.tournament-game');
            if (!el) break;
            const text = (el.textContent || '').trim();
            if (text === '-' || text === 'Unknown' || text === '') {
              fetchJson('/api/tournaments/' + encodeURIComponent(tid)).then(tr => {
                const resolved = tr.gameName || (tr.game && tr.game.name) || tr.gameSlug || null;
                if (resolved && resolved !== '-') el.textContent = resolved;
              }).catch(() => {});
            }
            break;
          }
        }
      });
    } catch (e) { /* ignore post-render lookup errors */ }

    // Try to fill missing finalRank values by fetching the tournament
    // documents and matching participants by normalized name.
    try {
      if (playerName) {
        const normalize = (s) => {
          if (!s && s !== 0) return '';
          try {
            return String(s).normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
          } catch (e) {
            return String(s).replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
          }
        };
        const wanted = normalize(playerName);

        sorted.forEach(t => {
          const tid = t._id || t.tournamentId || t.id || '';
          if (!tid) return;
          if (t.finalRank || t.finalRank === 0) return;

          (async () => {
            try {
              const tr = await fetchJson('/api/tournaments/' + encodeURIComponent(tid));
              if (!tr || !tr.participants) return;
              // Match participants by normalized name (exact match only to avoid substring confusion like Cola/Icola)
              const p = (tr.participants || []).find(part => {
                const a = normalize(part.displayName || part.name || '');
                const b = normalize(part.name || part.displayName || '');
                return a === wanted || b === wanted;
              });
                if (!p) return;

                // If finalRank is present, update immediately
                if (p.finalRank != null) {
                  const cards = toursEl.querySelectorAll('.tournament-card');
                  for (const card of cards) {
                    const dataTidRaw = card.getAttribute('data-tid') || '';
                    let cardTid = dataTidRaw;
                    try { cardTid = dataTidRaw ? decodeURIComponent(dataTidRaw) : dataTidRaw; } catch (e) { cardTid = dataTidRaw; }
                    if (String(cardTid) === String(tid)) {
                      const strong = card.querySelector('strong');
                      if (strong) strong.textContent = formatRank(p.finalRank);
                    }
                  }
                  return;
                }

                // Otherwise try to compute the ranking from matches (group -> single elimination hybrid)
                try {
                  let matches = [];
                  try {
                    matches = await fetchJson('/api/tournaments/' + encodeURIComponent(tid) + '/matches');
                    if (!matches) matches = [];
                  } catch (err) {
                    matches = [];
                  }
                  // Normalise la forme de la réponse: certains endpoints renvoient { matches: [...] }
                  if (!Array.isArray(matches) && matches && Array.isArray(matches.matches)) {
                    matches = matches.matches;
                  }
                  if (!Array.isArray(matches)) matches = [];
                  const map = new Map();
                  (tr.participants || []).forEach(part => {
                    const pid = part && (part.challongeId != null ? String(part.challongeId) : null);
                    if (!pid) return;
                    map.set(pid, {
                      pid,
                      qualified: false,
                      maxFinalRound: 0,
                      finalWins: 0,
                      groupWins: 0,
                      groupLosses: 0,
                      seed: (part.seed != null ? Number(part.seed) : null)
                    });
                  });

                  (matches || []).forEach(m => {
                    if (!m) return;
                    const p1 = m.player1Id != null ? String(m.player1Id) : null;
                    const p2 = m.player2Id != null ? String(m.player2Id) : null;
                    if (!p1 && !p2) return;

                    const isFinalStage = (m.groupId === null || m.groupId === undefined);
                    const winner = m.winnerId != null ? String(m.winnerId) : null;
                    const round = Number(m.round || 0);

                    // Only return existing participant stats — do not create new entries from match ids
                    const get = (pid) => {
                      if (!pid) return null;
                      return map.has(pid) ? map.get(pid) : null;
                    };

                    // Helper to match by name when IDs missing (group stage)
                    const getByName = (playerName) => {
                      if (!playerName) return null;
                      for (const [pid, stat] of map.entries()) {
                        const participant = (tr.participants || []).find(p => String(p.challongeId) === pid);
                        if (participant && (participant.name === playerName || participant.displayName === playerName)) {
                          return stat;
                        }
                      }
                      return null;
                    };

                    let s1 = get(p1);
                    let s2 = get(p2);
                    if (!s1 && m.player1Name) s1 = getByName(m.player1Name);
                    if (!s2 && m.player2Name) s2 = getByName(m.player2Name);

                    if (isFinalStage) {
                      if (s1) { s1.qualified = true; s1.maxFinalRound = Math.max(s1.maxFinalRound, round); }
                      if (s2) { s2.qualified = true; s2.maxFinalRound = Math.max(s2.maxFinalRound, round); }
                      if (winner) {
                        if (s1 && winner === p1) s1.finalWins += 1;
                        if (s2 && winner === p2) s2.finalWins += 1;
                      }
                    } else {
                      if (winner) {
                        let p1Won = false;
                        let p2Won = false;
                        if (winner === p1) p1Won = true;
                        else if (winner === p2) p2Won = true;
                        else if (m.player1Name && m.player2Name) {
                          const winnerParticipant = (tr.participants || []).find(part =>
                            String(part.challongeId) === winner || part.name === m.player1Name || part.displayName === m.player1Name || part.name === m.player2Name || part.displayName === m.player2Name
                          );
                          if (winnerParticipant) {
                            if (winnerParticipant.name === m.player1Name || winnerParticipant.displayName === m.player1Name) p1Won = true;
                            else if (winnerParticipant.name === m.player2Name || winnerParticipant.displayName === m.player2Name) p2Won = true;
                          }
                        }
                        if (s1) { if (p1Won) s1.groupWins += 1; else if (p2Won) s1.groupLosses += 1; }
                        if (s2) { if (p2Won) s2.groupWins += 1; else if (p1Won) s2.groupLosses += 1; }
                      }
                    }
                  });

                  // Use the exact same sorting logic as tournament-detail.js
                  // Build sorted participants (not statsArr) to match tournament display order
                  const sortedParticipants = [...(tr.participants || [])].sort((a, b) => {
                    const ar = (a && a.finalRank != null) ? Number(a.finalRank) : null;
                    const br = (b && b.finalRank != null) ? Number(b.finalRank) : null;
                    const aHas = Number.isFinite(ar) && ar > 0;
                    const bHas = Number.isFinite(br) && br > 0;
                    if (aHas && bHas) return ar - br;
                    if (aHas && !bHas) return -1;
                    if (!aHas && bHas) return 1;

                    // Groups→SE: use match-based ranking
                    const aid = a && a.challongeId != null ? String(a.challongeId) : null;
                    const bid = b && b.challongeId != null ? String(b.challongeId) : null;
                    const sa = aid ? map.get(aid) : null;
                    const sb = bid ? map.get(bid) : null;

                    const aq = !!(sa && sa.qualified);
                    const bq = !!(sb && sb.qualified);
                    if (aq !== bq) return aq ? -1 : 1;

                    const arnd = sa ? sa.maxFinalRound : 0;
                    const brnd = sb ? sb.maxFinalRound : 0;
                    if (brnd !== arnd) return brnd - arnd;

                    const aw = sa ? sa.finalWins : 0;
                    const bw = sb ? sb.finalWins : 0;
                    if (bw !== aw) return bw - aw;

                    const agw = sa ? sa.groupWins : 0;
                    const bgw = sb ? sb.groupWins : 0;
                    if (bgw !== agw) return bgw - agw;

                    const as = sa && Number.isFinite(sa.seed) ? sa.seed : 9999;
                    const bs = sb && Number.isFinite(sb.seed) ? sb.seed : 9999;
                    return as - bs;
                  });

                  const pidWanted = p.challongeId != null ? String(p.challongeId) : null;
                  let computedRank = null;
                  for (let i = 0; i < sortedParticipants.length; i++) {
                    const pid = sortedParticipants[i] && sortedParticipants[i].challongeId != null ? String(sortedParticipants[i].challongeId) : null;
                    if (pid === pidWanted) { computedRank = i + 1; break; }
                  }
                  
                  if (computedRank == null) return;

                  const cards = toursEl.querySelectorAll('.tournament-card');
                  for (const card of cards) {
                    const dataTidRaw = card.getAttribute('data-tid') || '';
                    let cardTid = dataTidRaw;
                    try { cardTid = dataTidRaw ? decodeURIComponent(dataTidRaw) : dataTidRaw; } catch (e) { cardTid = dataTidRaw; }
                    if (String(cardTid) === String(tid)) {
                      const strong = card.querySelector('strong');
                      if (strong) {
                        strong.textContent = formatRank(computedRank);
                      }
                    }
                  }
                } catch (e) { /* ignore compute errors */ }
            } catch (e) { /* ignore per-tournament errors */ }
          })();
        });
      }
    } catch (e) { /* ignore errors */ }
  }

  function renderRaces(races){
    if(!races || !races.length){ racesEl.innerHTML = '<p style="color:#9ca3af;">No races found.</p>'; return; }
    // Sort by startedAt (or createdAt) descending (most recent first)
    const getRaceTime = (r) => {
      if (!r) return 0;
      const candidates = [r.startedAt, r.endedAt, r.createdAt, r.updatedAt];
      for (const c of candidates) {
        if (c) {
          const n = new Date(c).getTime();
          if (Number.isFinite(n) && n > 0) return n;
        }
      }
      return 0;
    };
    const sorted = [...races].sort((a,b) => getRaceTime(b) - getRaceTime(a));
    
    const truncateText = (text, max) => {
      if (!text) return '';
      return text.length > max ? text.slice(0, max - 1) + '…' : text;
    };

    racesEl.innerHTML = sorted.map(r => {
      // Find the entrant data for this player
      const entrant = (r.entrants && r.entrants.length) ? r.entrants.find(e => 
        e.userId === id || 
        (nameParam && (e.userName === nameParam || e.userName?.toLowerCase() === nameParam.toLowerCase()))
      ) : null;
      const place = entrant ? (entrant.place || '-') : '-';
      
      // Get game name from race - racetime.gg stores it in 'name' field usually like "oot/weekly-XXX"
      // The category field contains the game slug (e.g., 'oot', 'alttp')
      const gameName = getGameDisplayName(r.category || r.name?.split('/')[0] || '');
      const goal = r.goal || r.info || '';
      const goalDisplay = truncateText(goal || 'Standard', 120);
const raceDate = r.startedAt ? new Date(r.startedAt).toLocaleDateString((typeof window.i18n !== 'undefined' && window.i18n.getLanguage) ? window.i18n.getLanguage() : 'en', { 
        day: 'numeric', month: 'short', year: 'numeric' 
      }) : '-';
      
      const raceId = r._id || r.id || '';
      const raceUrl = raceId ? `/race-detail.html?id=${encodeURIComponent(raceId)}` : '#';
      
      return `
      <a href="${raceUrl}" style="text-decoration:none;color:inherit;display:block;">
        <div style="background:#1f2937;padding:0.75rem;border-radius:0.5rem;margin-bottom:1rem;transition:background 0.2s;" onmouseover="this.style.background='#374151'" onmouseout="this.style.background='#1f2937'">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.25rem;">
            <h3 style="color:#fbbf24;font-size:0.95rem;flex:1;margin-right:0.75rem;">${gameName}</h3>
            <span class="spoiler-block" style="color:#10b981;font-weight:bold;font-size:0.875rem;">${place && place !== '-' ? formatRank(place) : '-'}</span>
          </div>
          <div style="color:#d1d5db;font-size:0.8rem;margin-bottom:0.25rem;">${goalDisplay}</div>
          <div style="color:#9ca3af;font-size:0.75rem;">${raceDate} • ${r.status || '-'}</div>
        </div>
      </a>
      `;
    }).join('\n');
  }

  // Map game slugs to display names
  function getGameDisplayName(slug) {
    const gameNames = {
      'oot': 'Ocarina of Time Randomizer',
      'ootr': 'Ocarina of Time Randomizer',
      'alttp': 'A Link to the Past Randomizer',
      'alttpr': 'A Link to the Past Randomizer',
      'mm': 'Majora\'s Mask Randomizer',
      'mmr': 'Majora\'s Mask Randomizer',
      'sm': 'Super Metroid Randomizer',
      'smr': 'Super Metroid Randomizer',
      'sm64': 'Super Mario 64 Randomizer',
      'dk64': 'Donkey Kong 64 Randomizer',
      'dk64r': 'Donkey Kong 64 Randomizer',
      'tww': 'The Wind Waker Randomizer',
      'tp': 'Twilight Princess Randomizer',
      'kh2fm': 'Kingdom Hearts 2 FM Randomizer',
      'kh2r': 'Kingdom Hearts 2 FM Randomizer',
      'kh2fmr': 'Kingdom Hearts 2 FM Randomizer',
      'sotn': 'Symphony of the Night Randomizer',
      'smz3': 'SMZ3 Combo Randomizer',
      'ootmm': 'OoT+MM Combo Randomizer'
    };
    const lowerSlug = (slug || '').toLowerCase().split('/')[0];
    return gameNames[lowerSlug] || slug || 'Race';
  }

  async function loadById(pid){
    const player = await fetchJson('/players/'+encodeURIComponent(pid));
    const tournaments = player.tournaments || [];
    renderProfile(player, tournaments);
    renderTournaments(tournaments, player.name || player.userId || headerName.textContent);
    const jr = await fetchJson('/players/'+encodeURIComponent(pid)+'/races');
    renderRaces(jr.races || []);
  }

  async function loadByName(name){
    // First try the aggregated players list to get tournament data and basic info
    try {
      const all = await fetchJson('/api/players');
      const aggregated = (all.players || []).find(p => p.name.toLowerCase() === name.toLowerCase());
      
      if (aggregated) {
        const tournaments = aggregated.tournaments || [];
        
        // Enrich with racetimeUrl/twitch if available from aggregated data
        const playerData = {
          name: aggregated.name,
          racetimeUrl: aggregated.racetimeUrl,
          racetimeId: aggregated.racetimeId,
          twitch: aggregated.twitch,
          stats: { totalRaces: 0 }
        };
        
        // If we don't have racetime info, try to find it
        if (!playerData.racetimeUrl && !playerData.racetimeId) {
          try {
            const findRes = await fetch('/api/racetime/find?q=' + encodeURIComponent(name));
            if (findRes.ok) {
              const findData = await findRes.json();
              if (findData && findData.url) {
                playerData.racetimeUrl = findData.url;
              }
            }
          } catch (e) { /* ignore */ }
        }
        
        renderProfile(playerData, tournaments);
        renderTournaments(tournaments, aggregated.name || name);
        
        // Try to load races by player name
        try {
          const racesRes = await fetch('/api/players/by-name/' + encodeURIComponent(name) + '/races');
          if (racesRes.ok) {
            const racesData = await racesRes.json();
            const races = racesData.races || [];
            if (races.length > 0) {
              // Update stats
              playerData.stats.totalRaces = races.length;
              renderProfile(playerData, tournaments);
              renderRaces(races);
            } else {
              racesEl.innerHTML = '<p style="color:#9ca3af;">No races found for this player.</p>';
            }
          } else {
            racesEl.innerHTML = '<p style="color:#9ca3af;">No races found.</p>';
          }
        } catch (e) {
          racesEl.innerHTML = '<p style="color:#9ca3af;">Error loading races.</p>';
        }
        return;
      }

      // Try to fetch Player document by name from the Player collection (supports players imported directly)
      let player;
      try {
        player = await fetchJson('/api/players/by-name/'+encodeURIComponent(name));
      } catch (e) {
        // Fallback: Player document not found — try to build a minimal profile from races and racetime lookup
        let races = [];
        try {
          const racesRes = await fetch('/api/players/by-name/' + encodeURIComponent(name) + '/races');
          if (racesRes.ok) {
            const jr = await racesRes.json();
            races = jr.races || [];
          }
        } catch (err) { /* ignore */ }

        // Try to locate a racetime profile
        let racetimeUrl = null;
        try {
          const findRes = await fetch('/api/racetime/find?q=' + encodeURIComponent(name));
          if (findRes.ok) {
            const fd = await findRes.json();
            if (fd && fd.url) racetimeUrl = fd.url;
          }
        } catch (err) { /* ignore */ }

        const playerData = {
          name: name,
          racetimeUrl: racetimeUrl || null,
          racetimeId: null,
          twitch: null,
          stats: { totalRaces: races.length }
        };

        renderProfile(playerData, []);
        if (races.length) renderRaces(races);
        else racesEl.innerHTML = '<p style="color:#9ca3af;">No races found for this player.</p>';
        return;
      }
      // Normalize tournaments to the shape expected by renderTournaments
      const tournaments = (player.tournaments || []).map(t => {
        const tour = t.tournamentId || {};
        const gameName = tour.gameName || (tour.game && tour.game.name) || t.gameName || (t.game && t.game.name) || null;
        return {
          _id: tour._id || t.tournamentId,
          tournamentId: tour._id || t.tournamentId,
          tournamentName: tour.name || t.tournamentName,
          name: tour.name || t.tournamentName,
          gameName: gameName,
          startDate: tour.startDate || t.startDate,
          finalRank: t.finalRank || t.finalRank
        };
      });

      // If the player document returned by `/api/players/by-name` doesn't include
      // populated `tournaments`, try fetching the canonical player by userId
      // which contains tournament participations.
      let displayTournaments = tournaments || [];
      if ((!displayTournaments || displayTournaments.length === 0) && player.userId) {
        try {
          const full = await fetchJson('/players/' + encodeURIComponent(player.userId));
          const fullT = full.tournaments || [];
          displayTournaments = fullT.map(t => {
            const tour = t.tournamentId || {};
            const gameName = tour.gameName || (tour.game && tour.game.name) || t.gameName || (t.game && t.game.name) || null;
            return {
              _id: tour._id || t.tournamentId,
              tournamentId: tour._id || t.tournamentId,
              tournamentName: tour.name || t.tournamentName,
              name: tour.name || t.tournamentName,
              gameName: gameName,
              startDate: tour.startDate || t.startDate,
              finalRank: t.finalRank || t.finalRank
            };
          });
        } catch (e) {
          // ignore and fall back to the (empty) tournaments list
        }
      }

      renderProfile(player, displayTournaments);
      renderTournaments(displayTournaments, player.name || name || player.userId);

      // Load races by userId or by name
      if (player.userId) {
        const jr = await fetchJson('/api/players/'+encodeURIComponent(player.userId)+'/races');
        renderRaces(jr.races || []);
      } else {
        // Try by name
        try {
          const racesRes = await fetch('/api/players/by-name/' + encodeURIComponent(name) + '/races');
          if (racesRes.ok) {
            const racesData = await racesRes.json();
            renderRaces(racesData.races || []);
          } else {
            racesEl.innerHTML = '<p style="color:#9ca3af;">No races found for this player.</p>';
          }
        } catch (e) {
          racesEl.innerHTML = '<p style="color:#9ca3af;">Error loading races.</p>';
        }
      }
    } catch (err) {
      // Fallback to aggregated list if direct player lookup fails
      const all = await fetchJson('/api/players');
      const found = (all.players || []).find(p => p.name.toLowerCase() === name.toLowerCase());
      if(!found) throw new Error('Player not found by name');
      const tournaments = found.tournaments || [];
      
      const playerData = {
        name: found.name,
        racetimeUrl: found.racetimeUrl,
        racetimeId: found.racetimeId,
        twitch: found.twitch,
        stats: { totalRaces: 0 }
      };
      
      renderProfile(playerData, tournaments);
      renderTournaments(tournaments, found.name || name);
      
      // Try to load races
      try {
        const racesRes = await fetch('/api/players/by-name/' + encodeURIComponent(name) + '/races');
        if (racesRes.ok) {
          const racesData = await racesRes.json();
          renderRaces(racesData.races || []);
        } else {
          racesEl.innerHTML = '<p style="color:#9ca3af;">No races found.</p>';
        }
      } catch (e) {
        racesEl.innerHTML = '<p style="color:#9ca3af;">Error loading races.</p>';
      }
    }
  }

  (async function(){
    try{
      if(id) await loadById(id);
      else if(nameParam) await loadByName(nameParam);
      else headerName.textContent = 'No identifier provided';
    }catch(e){
      headerName.textContent = (typeof i18n !== 'undefined' && typeof i18n.t === 'function') ? i18n.t('common.error') : 'Loading error';
      console.error(e);
    }
  })();
})();
