(function(){
  function qs(name){ return window.SiteUrls.param(name); }

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
      ? `/players/${encodeURIComponent(id)}`
      : `/players/name/${encodeURIComponent(nameParam || playerName)}`;
    const breadcrumb = window.RandomizerSEO.buildBreadcrumbList([
      { name: 'Home', url: '/' },
      { name: 'Players', url: '/players' },
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
      title: `${playerName} - ${((window.i18n && window.i18n.t('playerDetail.pageTitle', {}, 'Player Profile - Randomizer')) || 'Player Profile - Randomizer')}`,
      description,
      canonicalParams: id ? { id } : { name: nameParam || playerName },
      jsonLd: [breadcrumb, schema]
    });
  }

  const id = qs('id');
  const nameParam = qs('name');
  const headerName = document.getElementById('player-name');
  // Filled by this script: the "Loading..." key must not come back when the translations arrive
  headerName?.removeAttribute('data-i18n');
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
  let latestRenderedTournaments = null;
  let avatarLoadedFor = null;

  // The server already wrote the player's name when it knows them
  if ((id || nameParam) && document.documentElement.getAttribute('data-seo-ssr') !== '1') {
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

  // racetime avatar, else Twitch avatar, in one request: the server reads the
  // racetime profile again every few hours, so a new avatar shows up
  function loadAvatar(p){
    const initial = (p.name ? p.name[0].toUpperCase() : '?').replace(/[<>&"']/g, '?');
    const placeholder = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="200" height="200"%3E%3Crect fill="%23374151" width="200" height="200"/%3E%3Ctext x="50%25" y="50%25" font-size="64" fill="%23fbbf24" text-anchor="middle" dy=".3em"%3E' + encodeURIComponent(initial) + '%3C/text%3E%3C/svg%3E';
    const racetimeAccount = p.racetimeId || p.userId || p.racetimeUrl || '';
    const twitch = p.twitch || '';

    avatarEl.onerror = null;
    if (!racetimeAccount && !twitch) {
      avatarEl.src = placeholder;
      avatarEl.alt = 'Avatar';
      return;
    }
    avatarEl.onerror = () => {
      avatarEl.onerror = null;
      avatarEl.src = placeholder;
      avatarEl.alt = 'Avatar';
    };
    avatarEl.alt = (p.name || p.userId || 'Player') + ' avatar';
    avatarEl.src = '/api/avatar?racetime=' + encodeURIComponent(racetimeAccount) + '&twitch=' + encodeURIComponent(twitch);
  }

  function formatDate(d){ if(!d) return '-'; const t = new Date(d); return t.toLocaleString(); }

  function formatRank(n){
    if (n === null || typeof n === 'undefined' || n === '') return '-';
    const num = Number(n);
    if (Number.isNaN(num)) return String(n);
    return (typeof i18n !== 'undefined' && i18n.ordinal) ? i18n.ordinal(num) : String(num);
  }

  function renderProfile(p, tournaments, races, options = {}){
    headerName.textContent = p.name || p.userId || 'Joueur inconnu';

    // Kick off avatar loading asynchronously so the rest of the profile renders fast
    // (once per player: the profile is rendered again when the races arrive)
    const avatarKey = p.name || p.userId || 'unknown';
    if (avatarLoadedFor !== avatarKey) {
      avatarLoadedFor = avatarKey;
      loadAvatar(p);
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
      playerCompareAction.innerHTML = `<a class="btn-compare btn-compare--stats" href="/compare-players?player1=${encodeURIComponent(playerName)}">⚔️ ${compareLabel}</a>`;
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
        const label = gameLabel(g);
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

      // Group by canonical game so racetime categories of the same game merge
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
          <a href="/games/${encodeURIComponent(g.gameId)}">${escHtml(g.name)}</a>
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

  function tr(key, fallback, params) {
    if (typeof i18n === 'undefined') return fallback;
    const value = i18n.t(key, params || {});
    return value === key ? fallback : value;
  }

  function trPlural(key, count, fallback) {
    if (typeof i18n === 'undefined' || typeof i18n.plural !== 'function') return fallback;
    const value = i18n.plural(key, count);
    return value === key ? fallback : value;
  }

  function formatShortDate(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const lang = (typeof i18n !== 'undefined' && i18n.getLanguage) ? i18n.getLanguage() : 'en';
    return d.toLocaleDateString(lang, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // Card shared by races and tournaments: title and result on top, a detail line, then
  // date and status. The whole card links to the page; links inside it stay clickable.
  function renderResultCard({ href, title, result, resultClass, resultTitle, subtitle, extra, meta }) {
    return `
      <div class="result-card">
        <div class="result-card-head">
          <h3><a class="result-card-link" href="${href}">${escHtml(title)}</a></h3>
          <span class="result-card-result spoiler-block ${resultClass || ''}"${resultTitle ? ` title="${escHtml(resultTitle)}"` : ''}>${escHtml(result)}</span>
        </div>
        ${subtitle ? `<div class="result-card-subtitle">${escHtml(subtitle)}</div>` : ''}
        ${extra || ''}
        <div class="result-card-meta">${meta.filter(Boolean).map(escHtml).join(' • ')}</div>
      </div>
    `;
  }

  function resultClassOfRank(rank) {
    const n = Number(rank);
    if (n === 1) return 'is-gold';
    if (n === 2) return 'is-silver';
    if (n === 3) return 'is-bronze';
    return '';
  }

  const TOURNAMENT_STATUS_KEYS = { finished: 'finished', ongoing: 'ongoing', upcoming: 'upcoming' };

  function renderTournaments(tournaments){
    latestRenderedTournaments = tournaments;
    if(!tournaments || !tournaments.length){
      toursEl.innerHTML = `<p style="color:#9ca3af;">${escHtml(tr('playerDetail.noTournaments', 'No tournament participation.'))}</p>`;
      return;
    }
    toursEl.innerHTML = tournaments.map(t => {
      let result = t.rank ? formatRank(t.rank) : '-';
      let resultClass = t.rank ? resultClassOfRank(t.rank) : 'is-muted';
      let resultTitle = t.rankComputed ? tr('playerDetail.rankComputed', 'Rank computed from the bracket') : '';
      if (!t.rank && t.record) {
        result = tr('playerDetail.record', `${t.record.wins} W – ${t.record.losses} L`, t.record);
        resultClass = 'is-record';
      } else if (!t.rank && t.status !== 'finished') {
        result = tr('playerDetail.inProgress', 'In progress');
      }

      const game = getTournamentGameName(t);
      const entrants = t.entrants
        ? (t.team ? trPlural('playerDetail.teams', t.entrants, `${t.entrants} teams`) : trPlural('playerDetail.participants', t.entrants, `${t.entrants} participants`))
        : '';

      let extra = '';
      if (t.team) {
        const members = (t.team.members || []).map(m => m.userId
          ? `<a class="result-card-inner-link" href="/players/${encodeURIComponent(m.userId)}">${escHtml(m.name)}</a>`
          : escHtml(m.name)).join(', ');
        extra = `<div class="result-card-team">${escHtml(tr('playerDetail.team', 'Team'))} <em>${escHtml(t.team.name)}</em>${members ? ` ${escHtml(tr('playerDetail.teamWith', 'with'))} ${members}` : ''}</div>`;
      }

      const statusKey = TOURNAMENT_STATUS_KEYS[t.status] || 'ongoing';
      return renderResultCard({
        href: `/tournaments/${encodeURIComponent(t.tournamentId)}`,
        title: t.name || 'Tournament',
        result,
        resultClass,
        resultTitle,
        subtitle: [game, t.record && t.record.division].filter(v => v && v !== '-').join(' · '),
        extra,
        meta: [formatShortDate(t.startDate), tr('status.tournament.' + statusKey, statusKey), entrants]
      });
    }).join('\n');
  }

  function getTournamentGameName(t) {
    if (!t) return '-';
    // Same names as the race cards when the game is known
    const meta = t.gameSlug ? getGameMetaFromCategory(t.gameSlug) : null;
    return (meta && meta.slug && meta.name) || t.gameName || t.gameSlug || '-';
  }

  const RACE_STATUS_KEYS = { finished: 'finished', cancelled: 'cancelled', in_progress: 'inProgress', open: 'open', invitational: 'invitational', pending: 'pending' };

  function renderRaces(races){
    latestRenderedRaces = races;
    const mapWasLoaded = !!gameDisplayMap;
    renderGamesSummary(races || []).then(() => {
      // Race and tournament titles depend on the games map; re-render once it is available
      if (!mapWasLoaded && gameDisplayMap && races === latestRenderedRaces && races && races.length) renderRaces(races);
      if (!mapWasLoaded && gameDisplayMap && latestRenderedTournaments) renderTournaments(latestRenderedTournaments);
    });

    if(!races || !races.length){
      racesEl.innerHTML = `<p style="color:#9ca3af;">${escHtml(tr('playerDetail.noRaces', 'No races found.'))}</p>`;
      return;
    }
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

    racesEl.innerHTML = sorted.map(r => {
      // Find the entrant data for this player. The compact API only returns this player's
      // entrants (matched by userId, name or alias), so fall back to the first one: it covers
      // races recorded under an alias (SpeedRunsLive history).
      const entrant = (r.entrants && r.entrants.length) ? (r.entrants.find(e =>
        e.userId === id ||
        (nameParam && (e.userName === nameParam || e.userName?.toLowerCase() === nameParam.toLowerCase()))
      ) || r.entrants[0]) : null;

      let result = '-';
      let resultClass = 'is-muted';
      if (entrant && entrant.place) {
        result = formatRank(entrant.place);
        resultClass = resultClassOfRank(entrant.place);
      } else if (entrant && entrant.status === 'dnf') {
        result = tr('playerDetail.dnf', 'Forfeit');
      } else if (entrant && entrant.status === 'dq') {
        result = tr('playerDetail.dq', 'Disqualified');
      }

      // The category field contains the game slug
      const gameName = getGameDisplayName(r.category || r.name?.split('/')[0] || '');
      const statusKey = RACE_STATUS_KEYS[r.status];
      const raceId = r._id || r.id || '';

      return renderResultCard({
        href: raceId ? `/races/${encodeURIComponent(raceId)}` : '#',
        title: gameName,
        result,
        resultClass,
        subtitle: r.goal || r.info || 'Standard',
        meta: [formatShortDate(r.startedAt), statusKey ? tr('status.race.' + statusKey, r.status) : r.status]
      });
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
    const tournamentsRequest = fetchJson('/api/players/'+encodeURIComponent(pid)+'/tournaments')
      .then(r => r.tournaments || []).catch(() => []);
    const player = await fetchJson('/api/players/'+encodeURIComponent(pid));
    const tournaments = await tournamentsRequest;
    renderProfile(player, tournaments, [], { deferCounts: true });
    renderTournaments(tournaments);
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

    // Tournaments by racetime account when the name belongs to a known player
    const tournamentsRequest = fetchJson('/api/players/by-name/' + encodeURIComponent(name) + '/tournaments')
      .then(r => r.tournaments || []).catch(() => []);

    // First try the aggregated players list to get basic info
    try {
      const all = await fetchJson('/api/players?name=' + encodeURIComponent(name));
      const aggregated = (all.players || []).find(p => p.name.toLowerCase() === name.toLowerCase());
      
      if (aggregated) {
        const tournaments = await tournamentsRequest;
        
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
        renderTournaments(tournaments);
        
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
              racesEl.innerHTML = `<p style="color:#9ca3af;">${escHtml(tr('playerDetail.noRaces', 'No races found.'))}</p>`;
            }
          } else {
            racesEl.innerHTML = `<p style="color:#9ca3af;">${escHtml(tr('playerDetail.noRaces', 'No races found.'))}</p>`;
          }
        } catch (e) {
          racesEl.innerHTML = `<p style="color:#9ca3af;">${escHtml(tr('playerDetail.racesError', 'Error loading races.'))}</p>`;
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

        // Nobody behind the name (a bracket entry such as a co-op team): no empty profile
        if (!races.length && !racetimeUrl) {
          window.location.replace('/404.html');
          return;
        }

        const playerData = {
          name: name,
          racetimeUrl: racetimeUrl || null,
          racetimeId: null,
          twitch: null,
          stats: { totalRaces: races.length }
        };

        renderProfile(playerData, [], races);
        if (races.length) renderRaces(races);
        else racesEl.innerHTML = `<p style="color:#9ca3af;">${escHtml(tr('playerDetail.noRaces', 'No races found.'))}</p>`;
        return;
      }
      // The name is an alias (former name, Challonge name...): show the canonical profile
      if (player && player.name && player.name.toLowerCase() !== name.toLowerCase()) {
        window.location.replace('/players/name/' + encodeURIComponent(player.name));
        return;
      }
      const displayTournaments = await tournamentsRequest;

      renderProfile(player, displayTournaments, [], { deferCounts: true });
      renderTournaments(displayTournaments);

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
            racesEl.innerHTML = `<p style="color:#9ca3af;">${escHtml(tr('playerDetail.noRaces', 'No races found.'))}</p>`;
          }
        } catch (e) {
          racesEl.innerHTML = `<p style="color:#9ca3af;">${escHtml(tr('playerDetail.racesError', 'Error loading races.'))}</p>`;
        }
      }
    } catch (err) {
      // Fallback to aggregated list if direct player lookup fails
      const all = await fetchJson('/api/players?name=' + encodeURIComponent(name));
      const found = (all.players || []).find(p => p.name.toLowerCase() === name.toLowerCase());
      if(!found) throw new Error('Player not found by name');
      const tournaments = await tournamentsRequest;
      
      const playerData = {
        name: found.name,
        racetimeUrl: found.racetimeUrl,
        racetimeId: found.racetimeId,
        twitch: found.twitch,
        stats: { totalRaces: 0 }
      };
      
      renderProfile(playerData, tournaments, [], { deferCounts: true });
      renderTournaments(tournaments);
      
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
          racesEl.innerHTML = `<p style="color:#9ca3af;">${escHtml(tr('playerDetail.noRaces', 'No races found.'))}</p>`;
        }
      } catch (e) {
        racesEl.innerHTML = `<p style="color:#9ca3af;">${escHtml(tr('playerDetail.racesError', 'Error loading races.'))}</p>`;
      }
    }
  }

  // Ranks, dates and statuses follow the language
  window.addEventListener('languageChanged', () => {
    if (latestRenderedRaces) renderRaces(latestRenderedRaces);
    if (latestRenderedTournaments) renderTournaments(latestRenderedTournaments);
  });

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
