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

  function sanitizeExternalUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';

    try {
      const parsed = new URL(raw, window.location.origin);
      if (!/^https?:$/i.test(parsed.protocol)) return '';
      return parsed.href;
    } catch (e) {
      return '';
    }
  }

  function applyPlayerSeo(player, tournaments = [], races = []) {
    if (!window.RandomizerSEO || typeof window.RandomizerSEO.updatePage !== 'function') {
      return;
    }

    const playerName = player?.name || player?.userId || headerName.textContent || 'Player';
    if (!playerName) return;

    const totalRaces = Array.isArray(races) && races.length
      ? races.length
      : Number(player?.stats?.totalRaces) || 0;
    const totalTournaments = Array.isArray(tournaments) ? tournaments.length : 0;
    const gamesCount = Array.isArray(races) && races.length
      ? countGamesFromRaces(races)
      : countGamesFromTournaments(tournaments || []);
    const description = [
      `${playerName} on Randomizer.`,
      `${totalRaces} races, ${totalTournaments} tournaments and ${gamesCount} games tracked.`,
      'View profile, recent results and linked activity.'
    ].join(' ');

    const sameAs = [
      normalizeRacetimeProfileUrl(player?.racetimeUrl, player?.racetimeId),
      player?.challongeUrl,
      player?.twitch ? `https://twitch.tv/${encodeURIComponent(player.twitch)}` : ''
    ].map((value) => sanitizeExternalUrl(value)).filter(Boolean);

    const breadcrumbUrl = id
      ? `/player-detail.html?id=${encodeURIComponent(id)}`
      : `/player-detail.html?name=${encodeURIComponent(nameParam || playerName)}`;
    const breadcrumb = window.RandomizerSEO.buildBreadcrumbList([
      { name: 'Home', url: '/' },
      { name: 'Players', url: '/players.html' },
      { name: playerName, url: breadcrumbUrl }
    ]);
    const schema = {
      '@context': 'https://schema.org',
      '@type': 'Person',
      name: playerName,
      url: window.RandomizerSEO.buildAbsoluteUrl(breadcrumbUrl),
      sameAs: sameAs.length ? sameAs : undefined,
      description
    };

    window.RandomizerSEO.updatePage({
      title: `${playerName} - Randomizer Player Profile`,
      description,
      canonicalParams: id ? { id } : { name: nameParam || playerName },
      jsonLd: [breadcrumb, schema]
    });
  }

  const id = qs('id');
  const nameParam = qs('name');
  const headerName = document.getElementById('player-name');
  const avatarEl = document.getElementById('player-avatar');
  const playerLinks = document.getElementById('player-links');
  const playerCompareAction = document.getElementById('player-compare-action');
  const playerGamesSummary = document.getElementById('player-games-summary');
  const statsEl = document.getElementById('player-stats');
  const toursEl = document.getElementById('player-tournaments-list');
  const racesEl = document.getElementById('player-races-list');
  let gameDisplayMap = null;
  let gameDisplayMapPromise = null;
  let latestRenderedRaces = null;
  let avatarLoadedFor = null;

  if (id || nameParam) {
    headerName.textContent = 'Loading...';
  }
  if(!id && !nameParam){ headerName.textContent = 'No player specified'; }

  function updateGamesSummaryVisibility() {
    if (!playerGamesSummary) return;
    const hasGamesRows = !!playerGamesSummary.querySelector('.player-games-summary-row');
    playerGamesSummary.classList.toggle('is-visible', hasGamesRows);
  }

  async function fetchJson(url){
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if(!res.ok) throw new Error('Fetch failed: '+res.status);
    return res.json();
  }

  // Fetch Twitch URL from Racetime profile (one request per profile per page view)
  const twitchLookups = new Map();
  function fetchTwitchFromRacetime(racetimeUrl) {
    const profileUrl = normalizeRacetimeProfileUrl(racetimeUrl);
    if (!profileUrl) return Promise.resolve(null);
    if (!twitchLookups.has(profileUrl)) {
      twitchLookups.set(profileUrl, fetch('/api/racetime/twitch?url=' + encodeURIComponent(profileUrl))
        .then(res => (res.ok ? res.json() : null))
        .then(data => (data && data.twitch) || null)
        .catch(() => null));
    }
    return twitchLookups.get(profileUrl);
  }

  // Live streams list, fetched once per page view
  let liveStreamsPromise = null;
  function getLiveStreams() {
    if (!liveStreamsPromise) {
      liveStreamsPromise = fetch('/api/streams')
        .then(res => (res.ok ? res.json() : {}))
        .then(data => data.streams || [])
        .catch(() => []);
    }
    return liveStreamsPromise;
  }

  // Check if a Twitch user is currently live
  async function checkIfLive(twitchUsername, twitchBtn) {
    if (!twitchUsername || !twitchBtn) return;
    
    try {
      const streams = await getLiveStreams();
      
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
      racetimeUrl = normalizeRacetimeProfileUrl(p.racetimeUrl, p.racetimeId);

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
            racetimeUrl = normalizeRacetimeProfileUrl(j.url);
            
            // Try avatar from found profile
            const proxy = '/api/racetime/avatar?url=' + encodeURIComponent(racetimeUrl || j.url) + '&name=' + encodeURIComponent(p.name);
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
              const fetchedTwitch = await fetchTwitchFromRacetime(racetimeUrl || j.url);
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

  function renderProfile(p, tournaments, races, options = {}){
    headerName.textContent = p.name || p.userId || 'Joueur inconnu';

    // Kick off avatar loading asynchronously so the rest of the profile renders fast
    // (once per player: the profile is rendered again when the races arrive)
    const avatarKey = p.name || p.userId || 'unknown';
    if (avatarLoadedFor !== avatarKey) {
      avatarLoadedFor = avatarKey;
      loadAvatar(p).catch(() => {});
    }

    const links = [];
    
    // Racetime: prefer explicit URL, fallback to racetimeId
    let racetimeUrl = normalizeRacetimeProfileUrl(p.racetimeUrl, p.racetimeId);
    const safeRacetimeUrl = sanitizeExternalUrl(racetimeUrl);
    if (safeRacetimeUrl) {
      links.push(`<a class="btn-racetime" href="${safeRacetimeUrl}" target="_blank" rel="noopener noreferrer"><img src="/assets/racetime.svg" alt="Racetime">Racetime</a>`);
    }
    
    const safeChallongeUrl = sanitizeExternalUrl(p.challongeUrl);
    if (safeChallongeUrl) {
      links.push(`<a href="${safeChallongeUrl}" target="_blank" rel="noopener noreferrer">Challonge</a>`);
    }
    
    // Only set links if this player object provides any; otherwise preserve existing links
    if (links.length) {
      playerLinks.innerHTML = links.join('');
    }

    // Add Compare button below stats
    const playerName = p.name || p.userId || '';
    if (playerCompareAction && playerName) {
      const compareLabel = typeof i18n !== 'undefined' ? (i18n.t('comparePlayers.compareWith') || 'Compare with another player') : 'Compare with another player';
      playerCompareAction.innerHTML = `<a class="btn-compare btn-compare--stats" href="/compare-players.html?player1=${encodeURIComponent(playerName)}">⚔️ ${compareLabel}</a>`;
    }

    updateGamesSummaryVisibility();
    
    // If we have a racetime URL, try to fetch Twitch from racetime (only if not already in DB)
    if (safeRacetimeUrl && !p.twitch) {
      fetchTwitchFromRacetime(safeRacetimeUrl).then(twitchUrl => {
        const safeTwitchUrl = sanitizeExternalUrl(twitchUrl);
        if (safeTwitchUrl) {
          // Only add if not already present
          if (!playerLinks.querySelector('.btn-twitch')) {
            const twitchUsername = safeTwitchUrl.split('/').pop();
            // Later renders of this profile reuse it instead of looking it up again
            p.twitch = p.twitch || twitchUsername;
            const twitchBtn = document.createElement('a');
            twitchBtn.className = 'btn-twitch';
            twitchBtn.href = safeTwitchUrl;
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
    } else if (p.twitch && !playerLinks.querySelector('.btn-twitch')) {
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
    const gamesCount = (Array.isArray(races) && races.length > 0)
      ? countGamesFromRaces(races)
      : (options.deferCounts ? null : countGamesFromTournaments(tournaments || []));
    const hasTotalRaces = !options.deferCounts && p.stats && Number.isFinite(p.stats.totalRaces);
    const totalRaces = hasTotalRaces ? p.stats.totalRaces : (options.deferCounts ? null : 0);
    const totalTournaments = (tournaments || []).length;
    
    const labelGamesPlayed = typeof i18n !== 'undefined' ? i18n.t('playerDetail.gamesPlayed') : 'Games Played';
    const labelRaces = typeof i18n !== 'undefined' ? i18n.t('playerDetail.races') : 'Races';
    const labelTournaments = typeof i18n !== 'undefined' ? i18n.t('playerDetail.tournaments') : 'Tournaments';
    
    statsEl.innerHTML = `
      <div style="background:#374151;padding:1rem;border-radius:0.5rem;"><div style="color:#9ca3af;font-size:0.875rem;">${labelGamesPlayed}</div><div style="color:#fff;font-size:1.5rem;font-weight:bold;">${gamesCount == null ? '…' : gamesCount}</div></div>
      <div style="background:#374151;padding:1rem;border-radius:0.5rem;"><div style="color:#9ca3af;font-size:0.875rem;">${labelRaces}</div><div style="color:#fff;font-size:1.5rem;font-weight:bold;">${totalRaces == null ? '…' : totalRaces}</div></div>
      <div style="background:#374151;padding:1rem;border-radius:0.5rem;"><div style="color:#9ca3af;font-size:0.875rem;">${labelTournaments}</div><div style="color:#fff;font-size:1.5rem;font-weight:bold;">${totalTournaments}</div></div>
    `;

    applyPlayerSeo(p, tournaments, races);
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
    const slugMap = {
      oot: 'Ocarina of Time Randomizer',
      ootr: 'Ocarina of Time Randomizer',
      alttp: 'A Link to the Past Randomizer',
      alttpr: 'A Link to the Past Randomizer',
      'alttpr-ladder': 'A Link to the Past Randomizer',
      mm: "Majora's Mask Randomizer",
      mmr: "Majora's Mask Randomizer",
      sm: 'Super Metroid Randomizer',
      smr: 'Super Metroid Randomizer',
      sm64: 'Super Mario 64 Randomizer',
      dk64: 'Donkey Kong 64 Randomizer',
      dk64r: 'Donkey Kong 64 Randomizer',
      tww: 'The Wind Waker Randomizer',
      tp: 'Twilight Princess Randomizer',
      kh2fm: 'Kingdom Hearts 2 FM Randomizer',
      kh2r: 'Kingdom Hearts 2 FM Randomizer',
      kh2fmr: 'Kingdom Hearts 2 FM Randomizer',
      sotn: 'Symphony of the Night Randomizer',
      smz3: 'SMZ3 Combo Randomizer',
      ootmm: 'OoT+MM Combo Randomizer',
      ootmmr: 'OoT+MM Combo Randomizer',
      z1: 'The Legend of Zelda Randomizer',
      z1r: 'The Legend of Zelda Randomizer',
      z2: 'Zelda II Randomizer',
      z2r: 'Zelda II Randomizer'
    };
    if (slugMap[lower]) return slugMap[lower];
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
    // Avoid displaying raw slug/id when unknown
    if (/^[a-z0-9][a-z0-9-]{1,20}$/i.test(lower)) return null;
    return name;
  }

  function ensureGameDisplayMap() {
    if (gameDisplayMap) return Promise.resolve(gameDisplayMap);
    if (!gameDisplayMapPromise) gameDisplayMapPromise = loadGameDisplayMap();
    return gameDisplayMapPromise;
  }

  async function loadGameDisplayMap() {

    const map = new Map();
    const put = (slug, id, label) => {
      const s = String(slug || '').toLowerCase().trim();
      if (!s || !label) return;
      if (!map.has(s)) map.set(s, { id, label });
    };

    try {
      const data = await fetchJson('/api/games');
      const games = data.games || [];
      games.forEach(g => {
        const label = g?.randomizer?.displayName || g?.randomizer?.shortName || g?.official?.name || g?.name;
        const id = String(g?.id || '').toLowerCase();
        const rt = g?.integrations?.racetime || {};
        put(id, id, label);
        put(`${id}r`, id, label);
        put(rt.gameSlug, id, label);
        (rt.gameSlugs || []).forEach(slug => put(slug, id, label));
      });
    } catch (e) {
      // Silent fallback to static mapping only
    }

    gameDisplayMap = map;
    return map;
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

  function countGamesFromRaces(races){
    const uniqueGames = new Set();
    for (const race of races || []) {
      const meta = getGameMetaFromCategory(race?.category || race?.game || race?.gameSlug);
      if (meta.slug) {
        uniqueGames.add(meta.gameId);
      }
    }
    return uniqueGames.size;
  }

  function getGameMetaFromCategory(category) {
    const raw = String(category || '').toLowerCase().trim();
    const slug = raw.split('/')[0];
    const slugAliases = {
      ootr: 'oot',
      'ocarina-of-time-randomizer': 'oot',
      alttpr: 'alttp',
      'alttpr-ladder': 'alttp',
      'alttp-r': 'alttp',
      smr: 'sm',
      smz3r: 'smz3',
      mmr: 'mm',
      twwr: 'tww',
      dk64r: 'dk64',
      kh2r: 'kh2fm',
      kh2fmr: 'kh2fm',
      ootmmr: 'ootmm',
      z1r: 'z1',
      z2r: 'z2'
    };
    const canonicalSlug = slugAliases[slug] || slug;
    const mapped = gameDisplayMap && (gameDisplayMap.get(slug) || gameDisplayMap.get(canonicalSlug));
    const gameId = mapped?.id || canonicalSlug;
    const gameName = mapped?.label || normalizeGameName(slug) || normalizeGameName(canonicalSlug) || null;
    return { slug, gameId, name: gameName };
  }

  function buildGamesSummaryFromRaces(races) {
    const map = new Map();

    for (const race of races || []) {
      const category = race?.category;
      if (!category) continue;

      const meta = getGameMetaFromCategory(category);
      if (!meta.slug) continue;

      // Group by canonical game so racetime categories of the same game (e.g. alttpr + alttpr-ladder) merge
      if (!map.has(meta.gameId)) {
        map.set(meta.gameId, { slug: meta.slug, gameId: meta.gameId, name: meta.name || 'Jeu inconnu', count: 0 });
      }
      map.get(meta.gameId).count += 1;
    }

    return Array.from(map.values())
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 9);
  }

  async function renderGamesSummary(races) {
    if (!playerGamesSummary) return;
    await ensureGameDisplayMap();

    const gamesSummary = buildGamesSummaryFromRaces(races || []);
    playerGamesSummary.classList.remove('cols-1', 'cols-2', 'cols-3');

    if (!gamesSummary.length) {
      playerGamesSummary.classList.add('cols-1');
      playerGamesSummary.style.removeProperty('--game-summary-rows');
      playerGamesSummary.innerHTML = '';
      updateGamesSummaryVisibility();
      return;
    }

    playerGamesSummary.innerHTML = `
      ${gamesSummary.map(g => `
        <div class="player-games-summary-row">
          <a href="/game-detail.html?id=${encodeURIComponent(g.gameId)}">${escHtml(g.name)}</a>
          <span class="count">(${g.count})</span>
        </div>
      `).join('')}
    `;

    const n = gamesSummary.length;
    const columns = n <= 3 ? 1 : (n <= 6 ? 2 : 3);
    playerGamesSummary.classList.add(`cols-${columns}`);
    const rows = Math.ceil(n / columns);
    playerGamesSummary.style.setProperty('--game-summary-rows', String(rows));
    updateGamesSummaryVisibility();
  }

  // States of a tournament whose results are final
  const FINISHED_TOURNAMENT_STATES = ['complete', 'completed', 'ended', 'awaiting_review'];

  function isTournamentFinished(tr) {
    return FINISHED_TOURNAMENT_STATES.includes(String(tr?.state || '').toLowerCase())
      || String(tr?.status || '').toLowerCase() === 'terminé';
  }

  function normalizePlayerName(s) {
    if (!s && s !== 0) return '';
    try {
      return String(s).normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
    } catch (e) {
      return String(s).replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    }
  }

  // Best-effort rank from the matches when Challonge gives none (group stage → single elimination).
  // Players knocked out before the final bracket tie behind the players who reached it.
  async function computeRankFromMatches(tr, tid, participant) {
    const pidWanted = participant.challongeId != null ? String(participant.challongeId) : null;
    if (!pidWanted) return null;

    let matches = [];
    try {
      matches = await fetchJson('/api/tournaments/' + encodeURIComponent(tid) + '/matches');
    } catch (err) {
      matches = [];
    }
    // Normalise la forme de la réponse: certains endpoints renvoient { matches: [...] }
    if (!Array.isArray(matches) && matches && Array.isArray(matches.matches)) matches = matches.matches;
    if (!Array.isArray(matches)) matches = [];

    const participants = tr.participants || [];
    const map = new Map();
    participants.forEach(part => {
      const pid = part && (part.challongeId != null ? String(part.challongeId) : null);
      if (!pid) return;
      map.set(pid, { qualified: false, maxFinalRound: 0, finalWins: 0, groupWins: 0, seed: (part.seed != null ? Number(part.seed) : null) });
    });

    // Group matches may carry names only
    const getByName = (name) => {
      if (!name) return null;
      const participant = participants.find(part => part.challongeId != null && (part.name === name || part.displayName === name));
      return participant ? map.get(String(participant.challongeId)) : null;
    };

    matches.forEach(m => {
      if (!m) return;
      const p1 = m.player1Id != null ? String(m.player1Id) : null;
      const p2 = m.player2Id != null ? String(m.player2Id) : null;
      if (!p1 && !p2) return;
      const winner = m.winnerId != null ? String(m.winnerId) : null;
      const s1 = (p1 && map.get(p1)) || getByName(m.player1Name);
      const s2 = (p2 && map.get(p2)) || getByName(m.player2Name);

      if (m.groupId === null || m.groupId === undefined) {
        const round = Number(m.round || 0);
        if (s1) { s1.qualified = true; s1.maxFinalRound = Math.max(s1.maxFinalRound, round); }
        if (s2) { s2.qualified = true; s2.maxFinalRound = Math.max(s2.maxFinalRound, round); }
        if (winner && s1 && winner === p1) s1.finalWins += 1;
        if (winner && s2 && winner === p2) s2.finalWins += 1;
      } else if (winner) {
        if (s1 && winner === p1) s1.groupWins += 1;
        if (s2 && winner === p2) s2.groupWins += 1;
      }
    });

    const hasRank = (part) => {
      const r = part && part.finalRank != null ? Number(part.finalRank) : null;
      return Number.isFinite(r) && r > 0;
    };
    const statsOf = (part) => (part && part.challongeId != null ? map.get(String(part.challongeId)) : null) || null;

    const wantedStats = map.get(pidWanted);
    if (!wantedStats || !wantedStats.qualified) {
      const ahead = participants.filter(part => hasRank(part) || statsOf(part)?.qualified).length;
      if (ahead) return ahead + 1;
    }

    // Same order as tournament-detail.js
    const sortedParticipants = [...participants].sort((a, b) => {
      const aHas = hasRank(a);
      const bHas = hasRank(b);
      if (aHas && bHas) return Number(a.finalRank) - Number(b.finalRank);
      if (aHas !== bHas) return aHas ? -1 : 1;
      const sa = statsOf(a);
      const sb = statsOf(b);
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
    const index = sortedParticipants.findIndex(part => part.challongeId != null && String(part.challongeId) === pidWanted);
    return index >= 0 ? index + 1 : null;
  }

  function renderTournaments(tournaments, playerName){
    if(!tournaments || !tournaments.length){ toursEl.innerHTML = '<p style="color:#9ca3af;">No tournament participation.</p>'; return; }
    const getTid = (t) => t._id || t.tournamentId || t.id || '';
    // Sort by date descending (most recent first). Use multiple fallbacks for start date.
    const getStartTime = (t) => {
      if (!t) return 0;
      if (t._resolvedStartTime) return t._resolvedStartTime;
      const candidates = [t.startDate, t.start, (t.tournament && t.tournament.startDate), (t.tournament && t.tournament.start), t.createdAt, t.updatedAt];
      for (const c of candidates) {
        if (c) {
          const n = new Date(c).getTime();
          if (Number.isFinite(n) && n > 0) return n;
        }
      }
      return 0;
    };
    const t_ = (key, fallback) => (typeof i18n !== 'undefined' ? i18n.t(key) : fallback);
    const draw = (list) => {
      const labelRanking = t_('playerDetail.ranking', 'Ranking');
      const sorted = [...list].sort((a, b) => getStartTime(b) - getStartTime(a));
      toursEl.innerHTML = sorted.map(t => {
        const rankText = t._rankText || (t.finalRank ? formatRank(t.finalRank) : '-');
        return `
      <a href="/tournament-detail.html?id=${encodeURIComponent(getTid(t))}" style="text-decoration:none;color:inherit;display:block;">
        <div class="tournament-card tournament-hover-card" data-tid="${encodeURIComponent(getTid(t))}" style="background:#1f2937;padding:1rem;border-radius:0.5rem;margin-bottom:1rem;">
          <h3 style="color:#fbbf24;font-size:1rem;margin-bottom:0.5rem;">${escHtml(t.tournamentName || t.name || 'Tournoi')}</h3>
          <div class="tournament-game" style="color:#d1d5db;font-size:0.875rem;margin-bottom:0.25rem;">${escHtml(getTournamentGameName(t))}</div>
          <div class="spoiler-block" style="color:#9ca3af;font-size:0.875rem;">${labelRanking}: <strong style="color:#fbbf24;">${escHtml(rankText)}</strong></div>
        </div>
      </a>
    `;
      }).join('\n');
    };
    // Render immediately using available data
    draw(tournaments);

    // Then complete missing dates, games and ranks from the tournament documents and render once more
    const wanted = normalizePlayerName(playerName);
    const hasRank = (t) => !!(t.finalRank || t.finalRank === 0);
    const needsLookup = (t) => getTid(t) && (!getStartTime(t) || ['-', 'Unknown', ''].includes(getTournamentGameName(t)) || !hasRank(t));
    if (!tournaments.some(needsLookup)) return;

    const docs = new Map();
    const getDoc = (tid) => {
      if (!docs.has(tid)) docs.set(tid, fetchJson('/api/tournaments/' + encodeURIComponent(tid)).catch(() => null));
      return docs.get(tid);
    };

    const resolveRank = async (tr, tid) => {
      if (!wanted || !tr || !Array.isArray(tr.participants)) return null;
      // Match participants by their racetime account, else by normalized bracket name
      // (exact match only to avoid substring confusion between similar names)
      const p = tr.participants.find(part => part.racetimeName && normalizePlayerName(part.racetimeName) === wanted)
        || tr.participants.find(part => {
          if (part.racetimeName) return false;
          return normalizePlayerName(part.displayName || part.name) === wanted || normalizePlayerName(part.name || part.displayName) === wanted;
        });
      if (!p) return null;
      if (p.finalRank != null) return formatRank(p.finalRank);
      if (!isTournamentFinished(tr)) return t_('playerDetail.inProgress', 'In progress');
      const computed = await computeRankFromMatches(tr, tid, p);
      return computed ? formatRank(computed) : null;
    };

    Promise.all(tournaments.map(async (t) => {
      if (!needsLookup(t)) return t;
      const tid = getTid(t);
      const tr = await getDoc(tid);
      if (!tr) return t;
      const extra = {};
      if (!getStartTime(t) && tr.startDate) extra._resolvedStartTime = new Date(tr.startDate).getTime();
      if (['-', 'Unknown', ''].includes(getTournamentGameName(t))) {
        const game = tr.gameName || (tr.game && tr.game.name) || tr.gameSlug || null;
        if (game) extra.gameName = game;
      }
      if (!hasRank(t)) {
        try {
          const rankText = await resolveRank(tr, tid);
          if (rankText) extra._rankText = rankText;
        } catch (e) { /* ignore compute errors */ }
      }
      return Object.assign({}, t, extra);
    })).then(draw).catch(() => { /* keep the first render */ });
  }

  function renderRaces(races){
    latestRenderedRaces = races;
    const mapWasLoaded = !!gameDisplayMap;
    renderGamesSummary(races || []).then(() => {
      // Race titles depend on the games map; re-render once it is available
      if (!mapWasLoaded && gameDisplayMap && races === latestRenderedRaces && races && races.length) renderRaces(races);
    });

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
      // Find the entrant data for this player. The compact API only returns this player's
      // entrants (matched by userId, name or alias), so fall back to the first one: it covers
      // races recorded under an alias (SpeedRunsLive history).
      const entrant = (r.entrants && r.entrants.length) ? (r.entrants.find(e =>
        e.userId === id ||
        (nameParam && (e.userName === nameParam || e.userName?.toLowerCase() === nameParam.toLowerCase()))
      ) || r.entrants[0]) : null;
      const place = entrant ? (entrant.place || '-') : '-';
      
      // Get game name from race - racetime.gg stores it in 'name' field usually like "oot/weekly-XXX"
      // The category field contains the game slug (e.g., 'oot', 'alttp')
      const gameName = getGameDisplayName(r.category || r.name?.split('/')[0] || '');
      const goal = r.goal || r.info || '';
      const goalDisplay = truncateText(goal || 'Standard', 80);
const raceDate = r.startedAt ? new Date(r.startedAt).toLocaleDateString((typeof window.i18n !== 'undefined' && window.i18n.getLanguage) ? window.i18n.getLanguage() : 'en', { 
        day: 'numeric', month: 'short', year: 'numeric' 
      }) : '-';
      
      const raceId = r._id || r.id || '';
      const raceUrl = raceId ? `/race-detail.html?id=${encodeURIComponent(raceId)}` : '#';
      
      return `
      <a href="${raceUrl}" style="text-decoration:none;color:inherit;display:block;">
        <div style="background:#1f2937;padding:0.75rem;border-radius:0.5rem;margin-bottom:1rem;transition:background 0.2s;max-height:105px;overflow:hidden;" data-hover-style="background:#374151" data-rest-style="background:#1f2937">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.25rem;">
            <h3 style="color:#fbbf24;font-size:0.95rem;flex:1;margin-right:0.75rem;">${escHtml(gameName)}</h3>
            <span class="spoiler-block" style="color:#10b981;font-weight:bold;font-size:0.875rem;">${place && place !== '-' ? formatRank(place) : '-'}</span>
          </div>
          <div style="color:#d1d5db;font-size:0.8rem;margin-bottom:0.25rem;overflow:hidden;text-overflow:ellipsis;">${escHtml(goalDisplay)}</div>
          <div style="color:#9ca3af;font-size:0.75rem;">${raceDate} • ${escHtml(r.status || '-')}</div>
        </div>
      </a>
      `;
    }).join('\n');
  }

  // Map game slugs to display names
  function getGameDisplayName(slug) {
    const meta = getGameMetaFromCategory(slug);
    return meta.name || meta.slug || 'Race';
  }

  async function loadById(pid){
    const racesRequest = fetchJson('/api/players/'+encodeURIComponent(pid)+'/races?compact=1');
    racesRequest.catch(() => {});
    const player = await fetchJson('/api/players/'+encodeURIComponent(pid));
    let tournaments = player.tournaments || [];
    // Tournament participations are often only in the aggregated list (as on ?name= pages)
    if (!tournaments.length && player.name) {
      try {
        const all = await fetchJson('/api/players?includeTournaments=1&name=' + encodeURIComponent(player.name));
        const aggregated = (all.players || []).find(p => (p.name || '').toLowerCase() === player.name.toLowerCase());
        if (aggregated && aggregated.tournaments) tournaments = aggregated.tournaments;
      } catch (e) { /* keep the player's own (empty) list */ }
    }
    renderProfile(player, tournaments, [], { deferCounts: true });
    renderTournaments(tournaments, player.name || player.userId || headerName.textContent);
    const jr = await racesRequest;
    const races = jr.races || [];
    player.stats = player.stats || {};
    player.stats.totalRaces = races.length;
    renderProfile(player, tournaments, races);
    renderRaces(races);
  }

  async function loadByName(name){
    headerName.textContent = name;

    // Races are the heaviest request: start it now, in parallel with the profile
    const racesByNameRequest = fetch('/api/players/by-name/' + encodeURIComponent(name) + '/races?compact=1');
    racesByNameRequest.catch(() => {});
    let racesByNameResponse = null;
    const fetchRacesByName = () => {
      if (!racesByNameResponse) racesByNameResponse = racesByNameRequest;
      else racesByNameResponse = fetch('/api/players/by-name/' + encodeURIComponent(name) + '/races?compact=1');
      return racesByNameResponse;
    };

    // First try the aggregated players list to get tournament data and basic info
    try {
      const all = await fetchJson('/api/players?includeTournaments=1&name=' + encodeURIComponent(name));
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

        // The Twitch button is added by renderProfile once the lookup answers,
        // so the profile does not wait for racetime.gg before showing up
        
        renderProfile(playerData, tournaments, [], { deferCounts: true });
        renderTournaments(tournaments, aggregated.name || name);
        
        // Try to load races by player name
        try {
          const racesRes = await fetchRacesByName();
          if (racesRes.ok) {
            const racesData = await racesRes.json();
            const races = racesData.races || [];
            if (races.length > 0) {
              // Update stats
              playerData.stats.totalRaces = races.length;
              renderProfile(playerData, tournaments, races);
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
          const racesRes = await fetchRacesByName();
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

        renderProfile(playerData, [], races);
        if (races.length) renderRaces(races);
        else racesEl.innerHTML = '<p style="color:#9ca3af;">No races found for this player.</p>';
        return;
      }
      // The name is an alias (former name, Challonge name...): show the canonical profile
      if (player && player.name && player.name.toLowerCase() !== name.toLowerCase()) {
        window.location.replace('/player-detail.html?name=' + encodeURIComponent(player.name));
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
          const full = await fetchJson('/api/players/' + encodeURIComponent(player.userId));
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

      renderProfile(player, displayTournaments, [], { deferCounts: true });
      renderTournaments(displayTournaments, player.name || name || player.userId);

      // Load races by userId or by name
      if (player.userId) {
        const jr = await fetchJson('/api/players/'+encodeURIComponent(player.userId)+'/races?compact=1');
        const races = jr.races || [];
        player.stats = player.stats || {};
        player.stats.totalRaces = races.length;
        renderProfile(player, displayTournaments, races);
        renderRaces(races);
      } else {
        // Try by name
        try {
          const racesRes = await fetchRacesByName();
          if (racesRes.ok) {
            const racesData = await racesRes.json();
            const races = racesData.races || [];
            player.stats = player.stats || {};
            player.stats.totalRaces = races.length;
            renderProfile(player, displayTournaments, races);
            renderRaces(races);
          } else {
            racesEl.innerHTML = '<p style="color:#9ca3af;">No races found for this player.</p>';
          }
        } catch (e) {
          racesEl.innerHTML = '<p style="color:#9ca3af;">Error loading races.</p>';
        }
      }
    } catch (err) {
      // Fallback to aggregated list if direct player lookup fails
      const all = await fetchJson('/api/players?includeTournaments=1&name=' + encodeURIComponent(name));
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
      
      renderProfile(playerData, tournaments, [], { deferCounts: true });
      renderTournaments(tournaments, found.name || name);
      
      // Try to load races
      try {
        const racesRes = await fetchRacesByName();
        if (racesRes.ok) {
          const racesData = await racesRes.json();
          const races = racesData.races || [];
          playerData.stats.totalRaces = races.length;
          renderProfile(playerData, tournaments, races);
          renderRaces(races);
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
