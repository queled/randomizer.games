(function(){
  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (m) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[m]));
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

  // Links its URLs and, once the manifest is loaded, shows the seed hash as icons
  function formatInfoHtml(text, category, hashIcons) {
    return String(text || '')
      .split('\n')
      .map((line) => line.split(/(https?:\/\/[^\s<>"']+)/).map((part, i) => {
        if (i % 2 === 0) return window.HashIcons ? window.HashIcons.toHtml(part, category, hashIcons) : escapeHtml(part);
        const safeUrl = sanitizeExternalUrl(part);
        const label = escapeHtml(part);
        return safeUrl
          ? `<a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" style="color:#60a5fa;word-break:break-word;">${label}</a>`
          : label;
      }).join(''))
      .join('<br>');
  }

  // Text of the page in the visitor's language, the English fallback while translations load
  function tr(key, fallback) {
    return (typeof i18n !== 'undefined' && i18n.t(key, {}, fallback)) || fallback;
  }

  function qs(name){ return window.SiteUrls.param(name); }

  const raceId = qs('id');
  const raceUrl = qs('url');
  
  const gameEl = document.getElementById('race-game');
  // Filled by this script: the "Loading..." key must not come back when the translations arrive
  gameEl?.removeAttribute('data-i18n');
  const goalEl = document.getElementById('race-goal');
  const statusEl = document.getElementById('race-status');
  const infoEl = document.getElementById('race-info');
  const startEl = document.getElementById('race-start');
  const endEl = document.getElementById('race-end');
  const durationEl = document.getElementById('race-duration');
  const entrantsCountEl = document.getElementById('race-entrants-count');
  const linksEl = document.getElementById('race-links');
  const tournamentLinkDiv = document.getElementById('tournament-link');
  const tournamentNameEl = document.getElementById('tournament-name');
  const participantsEl = document.getElementById('participants-list');

  // Title element for participants/standings toggling
  const participantsTitleEl = document.getElementById('participants-title');

  // Global variables for re-rendering on spoiler mode change
  let currentEntrants = [];
  let currentRace = null;
  // Twitch channel of entrants streaming right now, keyed by racetime user id and lowercased name
  let liveStreams = new Map();
  let gamesById = {};
  let gamesBySlug = {};
  let currentTournament = null;

  // Event listener for spoiler mode changes
  window.addEventListener('spoilerModeChanged', function(e) {
    updateParticipantsTitle();
    renderParticipants(currentEntrants);
    refreshDateTimeFields();
  });

  // Texts written by this script follow a language change
  window.addEventListener('languageChanged', function() {
    if (!currentRace) return;
    refreshDateTimeFields();
    renderStatus();
    renderLinks();
    updateParticipantsTitle();
    renderParticipants(currentEntrants);
  });

  function isSpoilerModeEnabled() {
    if (typeof window.isSpoilerModeEnabled === 'function') {
      return window.isSpoilerModeEnabled();
    }
    return sessionStorage.getItem('spoilerModeEnabled') === 'true';
  }

  function updateParticipantsTitle() {
    if (!participantsTitleEl) return;
    // Written here from now on: the translation pass must not put "Ranking" back in spoiler-free mode
    participantsTitleEl.removeAttribute('data-i18n');
    participantsTitleEl.textContent = isSpoilerModeEnabled()
      ? tr('raceDetail.participants', '👥 Participants')
      : tr('raceDetail.ranking', '🏅 Ranking');
  }


  function getGameDisplayName(slug) {
    if (!slug) return 'Race';
    const lowerSlug = String(slug).toLowerCase().trim();

    if (gamesBySlug[lowerSlug]) {
      return gameLabel(gamesBySlug[lowerSlug]) || slug;
    }

    if (gamesById[lowerSlug]) {
      return gameLabel(gamesById[lowerSlug]) || slug;
    }

    if (lowerSlug.endsWith('r')) {
      const alt = lowerSlug.slice(0, -1);
      if (gamesById[alt]) {
        return gameLabel(gamesById[alt]) || slug;
      }
    }

    return slug;
  }

  function getGameDocForCategory(category) {
    const lowerSlug = String(category || '').toLowerCase().trim();
    if (!lowerSlug) return null;

    if (gamesBySlug[lowerSlug]) return gamesBySlug[lowerSlug];
    if (gamesById[lowerSlug]) return gamesById[lowerSlug];

    if (lowerSlug.endsWith('r')) {
      const alias = lowerSlug.slice(0, -1);
      if (gamesById[alias]) return gamesById[alias];
    }

    return gamesBySlug[lowerSlug.split('/')[0]] || gamesById[lowerSlug.split('/')[0]] || null;
  }

  function mapRaceStatusToEventStatus(status) {
    switch (status) {
      case 'open':
      case 'invitational':
        return 'https://schema.org/EventScheduled';
      case 'in_progress':
        return 'https://schema.org/EventInProgress';
      case 'cancelled':
        return 'https://schema.org/EventCancelled';
      default:
        return 'https://schema.org/EventCompleted';
    }
  }

  function applyRaceSeo(race, gameDisplayName, tournament) {
    if (!window.RandomizerSEO || typeof window.RandomizerSEO.updatePage !== 'function') {
      return;
    }

    const entrantsCount = Array.isArray(race?.entrants) ? race.entrants.length : 0;
    const status = ENGLISH_STATUS[race?.status || 'finished'] || race?.status;
    const goal = race?.goal || race?.name || 'Race';
    const detailUrl = raceId
      ? `/races/${encodeURIComponent(raceId)}`
      : `/race-detail.html?url=${encodeURIComponent(raceUrl)}`;
    const descriptionParts = [
      `${gameDisplayName} race on Randomizer.`,
      `${goal}. ${entrantsCount} entrants.`,
      `Status: ${status}.`
    ];
    if (tournament?.name) {
      descriptionParts.push(`Linked tournament: ${tournament.name}.`);
    }
    const description = descriptionParts.join(' ');
    const gameDoc = getGameDocForCategory(race?.category);
    const image = gameDoc?.cover || '/assets/icon-512.png';
    const breadcrumb = window.RandomizerSEO.buildBreadcrumbList([
      { name: 'Home', url: '/' },
      { name: 'Races', url: '/races' },
      { name: gameDisplayName, url: detailUrl }
    ]);
    const schema = {
      '@context': 'https://schema.org',
      '@type': 'Event',
      name: `${gameDisplayName} - ${goal}`,
      url: window.RandomizerSEO.buildAbsoluteUrl(detailUrl),
      startDate: race?.startedAt || undefined,
      endDate: race?.endedAt || undefined,
      eventStatus: mapRaceStatusToEventStatus(race?.status),
      description,
      image: window.RandomizerSEO.buildAbsoluteUrl(image) || window.RandomizerSEO.defaultImage
    };

    window.RandomizerSEO.updatePage({
      title: `${goal} - ${gameDisplayName} - ${((window.i18n && window.i18n.t('raceDetail.pageTitle', {}, 'Race - Randomizer')) || 'Race - Randomizer')}`,
      description,
      canonicalParams: raceId ? { id: raceId } : { url: raceUrl },
      image,
      jsonLd: [breadcrumb, schema]
    });
  }

  async function loadGames() {
    try {
      const gamesData = await fetchJson('/api/games');
      const games = gamesData.games || [];

      gamesById = {};
      gamesBySlug = {};

      games.forEach(game => {
        const gameId = String(game.id || '').toLowerCase().trim();
        if (gameId) {
          gamesById[gameId] = game;
          gamesById[`${gameId}r`] = game;
        }

        const primarySlug = String(game?.integrations?.racetime?.gameSlug || '').toLowerCase().trim();
        if (primarySlug) {
          gamesBySlug[primarySlug] = game;
        }

        const extraSlugs = Array.isArray(game?.integrations?.racetime?.gameSlugs)
          ? game.integrations.racetime.gameSlugs
          : [];

        extraSlugs.forEach(slug => {
          const normalizedSlug = String(slug || '').toLowerCase().trim();
          if (normalizedSlug) gamesBySlug[normalizedSlug] = game;
        });
      });
    } catch (e) {
      gamesById = {};
      gamesBySlug = {};
    }
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
    if (s.includes(':')) {
      const parts = s.split(':').map(p => parseFloat(p));
      if (parts.length === 3) return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
      if (parts.length === 2) return Math.round((parts[0] * 60 + parts[1]) * 1000);
    }
    const num = Number(s);
    if (!Number.isNaN(num)) {
      if (num > 10000) return Math.round(num);
      return Math.round(num * 1000);
    }
    return null;
  }

  function formatMs(ms) {
    if (ms == null) return '-';
    const totalSeconds = Math.round(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    return `${m}:${String(s).padStart(2,'0')}`;
  }

  function formatDateTime(d) {
    if (!d) return '-';
    let locale = 'en';
    if (typeof i18n !== 'undefined' && typeof i18n.getLanguage === 'function') {
      locale = i18n.getLanguage() || 'en';
    }
    return new Date(d).toLocaleString(locale, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function refreshDateTimeFields() {
    if (!currentRace) return;

    const spoilerMode = isSpoilerModeEnabled();

    startEl.textContent = formatDateTime(currentRace.startedAt);
    endEl.textContent = spoilerMode ? '-' : formatDateTime(currentRace.endedAt);
    durationEl.textContent = spoilerMode ? '-' : formatDuration(currentRace.startedAt, currentRace.endedAt);
  }

  function formatDuration(startedAt, endedAt) {
    if (!startedAt || !endedAt) return '-';
    const start = new Date(startedAt).getTime();
    const end = new Date(endedAt).getTime();
    if (isNaN(start) || isNaN(end)) return '-';
    return formatMs(end - start);
  }

  const ENGLISH_STATUS = {
    'open': 'Open',
    'invitational': 'Invitational',
    'in_progress': 'In Progress',
    'finished': 'Finished',
    'cancelled': 'Cancelled'
  };

  const statusColors = {
    'open': '#3b82f6',
    'invitational': '#8b5cf6',
    'in_progress': '#10b981',
    'finished': '#6b7280',
    'cancelled': '#ef4444'
  };

  function getStatusText(status) {
    if (typeof i18n !== 'undefined') {
      switch(status) {
        case 'open': return i18n.t('status.race.open');
        case 'invitational': return i18n.t('status.race.invitational');
        case 'in_progress': return i18n.t('status.race.ongoing');
        case 'finished': return i18n.t('status.race.finished');
        case 'cancelled': return i18n.t('status.race.cancelled');
        default: return status === 'unknown' ? tr('common.unknown', 'Unknown') : status;
      }
    }
    // Translations not loaded
    return ENGLISH_STATUS[status] || status;
  }

  // Races imported from SpeedRunsLive are stored as /srl/<raceId>
  function getSpeedRunsLiveRaceUrl(rawUrl) {
    const match = /^\/?srl\/(\d+)$/i.exec(String(rawUrl || '').trim());
    return match ? 'https://www.speedrunslive.com/races/result/' + match[1] : null;
  }

  function normalizeRacetimeRaceUrl(rawUrl, categoryHint) {
    let raw = String(rawUrl || '').trim();
    if (!raw) return null;

    if (/^https?:\/\//i.test(raw)) {
      try {
        const parsed = new URL(raw);
        raw = parsed.pathname || '';
      } catch (e) {
        raw = raw.replace(/^https?:\/\/(www\.)?racetime\.gg/i, '');
      }
    }

    raw = '/' + raw.replace(/^\/+/, '');
    const parts = raw.split('/').filter(Boolean);

    if (parts.length >= 3 && parts[0] === parts[1]) {
      parts.splice(1, 1);
    }

    const hint = String(categoryHint || '').toLowerCase().trim();
    if (hint && parts.length >= 3 && parts[0] === hint && parts[1] === hint) {
      parts.splice(1, 1);
    }

    return 'https://racetime.gg/' + parts.join('/');
  }

  function formatRank(n) {
    if (n === null || typeof n === 'undefined' || n === '') return '-';
    const num = Number(n);
    if (Number.isNaN(num)) return String(n);
    if (num === 1) return '🥇';
    if (num === 2) return '🥈';
    if (num === 3) return '🥉';
    return (window.i18n && window.i18n.ordinal) ? window.i18n.ordinal(num) : `${num}`;
  }

  async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Fetch failed: ' + res.status);
    return res.json();
  }

  const LIVE_RACE_STATUSES = ['open', 'invitational', 'in_progress'];
  const STREAMS_REFRESH_MS = 2 * 60 * 1000;

  function getLiveChannel(entrant) {
    return (entrant.userId && liveStreams.get('id:' + entrant.userId))
      || (entrant.userName && liveStreams.get('name:' + entrant.userName.toLowerCase()))
      || null;
  }

  function renderTwitchLink(entrant) {
    const channel = getLiveChannel(entrant);
    if (!channel) return '';
    const label = escapeHtml(channel);
    return `<a href="https://www.twitch.tv/${encodeURIComponent(channel)}" target="_blank" rel="noopener noreferrer" class="btn-twitch" title="twitch.tv/${label}" style="margin:0 0 0 0.6rem;flex-shrink:0;"><img src="/assets/twitch.svg" alt="Twitch"><span style="width:8px;height:8px;background:#dc2626;border-radius:50%;animation:pulse 2s cubic-bezier(0.4,0,0.6,1) infinite;"></span>LIVE</a>`;
  }

  // The entrant's own stream of the race, kept by Twitch (sync-race-vods.js)
  function renderVodLink(entrant) {
    if (getLiveChannel(entrant)) return '';
    const vod = (currentRace?.vods || []).find(v => v.vodUrl && (v.userId === entrant.userId || (v.userName || '').toLowerCase() === (entrant.userName || '').toLowerCase()));
    if (!vod || !/^https:\/\/www\.twitch\.tv\/videos\/\d+/.test(vod.vodUrl)) return '';
    const label = (typeof i18n !== 'undefined' && i18n.t('tournamentDetail.watchVod')) || 'VOD';
    return `<a href="${escapeHtml(vod.vodUrl)}" target="_blank" rel="noopener noreferrer" class="btn-twitch" title="twitch.tv/${escapeHtml(vod.twitchName || '')}" style="margin:0 0 0 0.6rem;flex-shrink:0;"><img src="/assets/twitch.svg" alt="Twitch">▶ ${escapeHtml(label)}</a>`;
  }

  // Mido's House names restream languages in English
  const RESTREAM_LANGUAGE_CODES = { English: 'en', French: 'fr', German: 'de', Spanish: 'es', Italian: 'it', Portuguese: 'pt', Japanese: 'ja' };

  function restreamLanguageLabel(language) {
    const code = RESTREAM_LANGUAGE_CODES[language];
    if (!code) return language || '';
    try {
      const uiLang = (typeof i18n !== 'undefined' && typeof i18n.getLanguage === 'function') ? i18n.getLanguage() : 'en';
      const name = new Intl.DisplayNames([uiLang], { type: 'language' }).of(code);
      return name ? name.charAt(0).toUpperCase() + name.slice(1) : language;
    } catch (e) {
      return language;
    }
  }

  const isYoutubeUrl = url => /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com|youtu\.be)\//.test(String(url || ''));
  const isYoutubeStream = stream => isYoutubeUrl(stream.vodUrl || stream.url);

  // `channel`: the YouTube channel's name, its link only giving its id
  function restreamChannelName(url, channel) {
    try {
      const u = new URL(url);
      if (isYoutubeUrl(url)) return channel || u.hostname.replace(/^www\./, '');
      const channelName = u.pathname.split('/').filter(Boolean)[0];
      if (!channelName || channelName === 'videos') return u.hostname.replace(/^www\./, '');
      return channelName;
    } catch (e) {
      return url;
    }
  }

  function racetimeRoomPath(url) {
    return String(url || '').replace(/^https?:\/\/(?:www\.)?racetime\.gg/i, '').replace(/\/+$/, '').toLowerCase();
  }

  // Restreams of this race: Mido's House's, then those found on Twitch and YouTube (sync-race-restreams.js), one per channel, Twitch first
  function findRestreams(race, tournament) {
    const seen = new Set();
    const merged = findMidosHouseRestreams(race, tournament).concat(race.restreams || []).filter(stream => {
      // A YouTube video linked without its channel: the video itself
      const key = (isYoutubeStream(stream) && !stream.channel ? stream.vodUrl || stream.url : restreamChannelName(stream.url || stream.vodUrl || '', stream.channel)).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    // A YouTube video only when no Twitch VOD in its language is left, then in place of the Twitch channel
    const language = st => st.language || '';
    const twitchVodLanguages = new Set(merged.filter(st => !isYoutubeStream(st) && st.vodUrl).map(language));
    const youtube = merged.filter(st => isYoutubeStream(st) && !twitchVodLanguages.has(language(st)));
    const youtubeVodLanguages = new Set(youtube.filter(st => st.vodUrl).map(language));
    return merged.filter(st => !isYoutubeStream(st) && (st.vodUrl || !youtubeVodLanguages.has(language(st)))).concat(youtube);
  }

  // Restreams of this race on Mido's House: by its racetime.gg room, else the race of its start.gg set starting at the same time
  function findMidosHouseRestreams(race, tournament) {
    const mh = tournament?.midosHouse;
    if (!mh) return [];
    const entries = (mh.pastRestreams || []).concat(mh.schedule || []).filter(r => Array.isArray(r.restreams) && r.restreams.length);
    const room = racetimeRoomPath(race.url);
    const byRoom = entries.find(r => r.roomUrl && racetimeRoomPath(r.roomUrl) === room);
    if (byRoom) return byRoom.restreams;

    const match = (tournament.matches || []).find(m => (Array.isArray(m.raceUrls) && m.raceUrls.length ? m.raceUrls : [m.raceUrl])
      .some(url => url && racetimeRoomPath(url) === room));
    const start = new Date(race.startedAt || race.openedAt || 0).getTime();
    if (!match?.startggSetId || !start) return [];
    const bySet = entries
      .filter(r => !r.roomUrl && String(r.startggSetId) === String(match.startggSetId) && r.startAt)
      .map(r => ({ r, gap: Math.abs(new Date(r.startAt).getTime() - start) }))
      .filter(x => x.gap < 60 * 60 * 1000)
      .sort((a, b) => a.gap - b.gap)[0];
    return bySet ? bySet.r.restreams : [];
  }

  // Restream button, one per language: the VOD at the race start (Twitch, else YouTube), or the channel while the race is not over yet
  function renderRestreamLink(stream, live) {
    const youtube = isYoutubeStream(stream);
    const isVod = youtube ? isYoutubeUrl(stream.vodUrl) : /^https:\/\/www\.twitch\.tv\/videos\/\d+/.test(stream.vodUrl || '');
    const vod = isVod ? sanitizeExternalUrl(stream.vodUrl) : '';
    const href = vod || (live && !youtube ? sanitizeExternalUrl(stream.url) : '');
    if (!href) return '';
    const t = (key, fallback) => (typeof i18n !== 'undefined' && i18n.t(key)) || fallback;
    const channel = restreamChannelName(stream.url || href, stream.channel);
    const language = restreamLanguageLabel(stream.language);
    const label = vod ? '▶ ' + t('raceDetail.watchRestream', 'Watch the restream') : t('raceDetail.restream', 'Restream');
    // Race running: the restream is live, same blinking dot as the players' LIVE buttons
    const liveBadge = '<span style="display:inline-flex;align-items:center;gap:0.35rem;color:#fca5a5;font-size:0.8rem;font-weight:700;letter-spacing:0.03em;"><span style="width:8px;height:8px;background:#dc2626;border-radius:50%;animation:pulse 2s cubic-bezier(0.4,0,0.6,1) infinite;"></span>LIVE</span>';
    const colors = youtube
      ? { text: '#FEE2E2', border: '#FF0033', hover: '#450a0a', meta: '#fca5a5', icon: 'youtube', alt: 'YouTube' }
      : { text: '#E9D5FF', border: '#9146FF', hover: '#3b0764', meta: '#c4b5fd', icon: 'twitch', alt: 'Twitch' };
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(channel)}" style="display:inline-flex;align-items:center;gap:0.6rem;background-color:#1F2937;color:${colors.text};font-weight:600;padding:0.75rem 1.5rem;border-radius:0.5rem;border:2px solid ${colors.border};text-decoration:none;transition:all 0.2s;font-size:1rem;" data-hover-style="background:${colors.hover}" data-rest-style="background:#1F2937"><img src="/assets/${colors.icon}.svg" alt="${colors.alt}" style="width:22px;height:22px;"><span>${escapeHtml(label)}</span>${vod ? '' : liveBadge}<span style="color:${colors.meta};font-weight:400;font-size:0.875rem;">${escapeHtml([language, channel].filter(Boolean).join(' · '))}</span></a>`;
  }

  async function loadLiveStreams(race) {
    if (!race?._id || !LIVE_RACE_STATUSES.includes(race.status)) return;
    try {
      const data = await fetchJson('/api/runs/' + encodeURIComponent(race._id) + '/streams');
      const next = new Map();
      (data.streams || []).forEach(s => {
        if (s.userId) next.set('id:' + s.userId, s.twitchChannel);
        if (s.userName) next.set('name:' + s.userName.toLowerCase(), s.twitchChannel);
      });
      liveStreams = next;
      renderParticipants(currentEntrants);
    } catch (e) {
      // Live streams are optional, keep the list as it is
    }
  }

  function renderParticipants(entrants) {
    if (!entrants || entrants.length === 0) {
      participantsEl.innerHTML = `<p style="color:#9ca3af;">${escapeHtml(tr('raceDetail.noParticipants', 'No participants'))}</p>`;
      return;
    }

    // Store entrants for re-rendering
    currentEntrants = entrants;

    // Check spoiler mode
    const spoilerMode = isSpoilerModeEnabled();
    const unknown = tr('common.unknown', 'Unknown');

    let sorted;
    if (spoilerMode) {
      // In spoiler mode: alphabetical order by name
      sorted = [...entrants].sort((a, b) => {
        const nameA = (a.userName || unknown).toLowerCase();
        const nameB = (b.userName || unknown).toLowerCase();
        return nameA.localeCompare(nameB);
      });
    } else {
      // Normal mode: finished first (by place), then DNF, then DQ
      sorted = [...entrants].sort((a, b) => {
        // Finished entrants first
        if (a.status === 'done' && b.status !== 'done') return -1;
        if (a.status !== 'done' && b.status === 'done') return 1;
        
        // Both finished - sort by place
        if (a.status === 'done' && b.status === 'done') {
          return (a.place || 999) - (b.place || 999);
        }
        
        // DNF before DQ
        if (a.status === 'dnf' && b.status === 'dq') return -1;
        if (a.status === 'dq' && b.status === 'dnf') return 1;
        
        return 0;
      });
    }

    const html = sorted.map((e, idx) => {
      const name = escapeHtml(e.userName || unknown);
      const playerLink = e.userName ? `/players/name/${encodeURIComponent(e.userName)}` : '#';
      
      if (spoilerMode) {
        // Spoiler mode: simple list, no rank, no time, alphabetical
        return `
          <div style="display:flex;align-items:center;padding:1rem;background:#2d3748;margin-bottom:0.5rem;border-radius:0.375rem;transition:background 0.2s;" data-hover-style="background:#4a5568" data-rest-style="background:#2d3748">
            <div style="flex:1;display:flex;align-items:center;min-width:0;">
              <a href="${playerLink}" style="color:#fff;text-decoration:none;">${name}</a>
              ${renderTwitchLink(e)}${renderVodLink(e)}
            </div>
          </div>
        `;
      } else {
        // Normal mode: full details with rank and time
        const ms = e.finishTimeMs || parseTimeToMs(e.finishTime);
        const timeStr = ms ? formatMs(ms) : (e.status === 'dnf' ? 'DNF' : e.status === 'dq' ? 'DQ' : '-');
        const rank = e.place ? formatRank(e.place) : (e.status === 'dnf' ? 'DNF' : e.status === 'dq' ? 'DQ' : '-');
        
        const isWinner = e.place === 1;
        const isDnf = e.status === 'dnf';
        const isDq = e.status === 'dq';
        
        const bgColor = isWinner ? '#374151' : '#2d3748';
        const borderColor = isWinner ? '#fbbf24' : 'transparent';
        const nameColor = isWinner ? '#fbbf24' : isDnf || isDq ? '#9ca3af' : '#fff';
        const timeColor = isWinner ? '#10b981' : isDnf ? '#ef4444' : isDq ? '#f59e0b' : '#10b981';
        
        return `
          <div class="spoiler-block" style="display:flex;align-items:center;gap:0.375rem;padding:1rem;background:${bgColor};border-left:3px solid ${borderColor};margin-bottom:0.5rem;border-radius:0.375rem;transition:background 0.2s;" data-hover-style="background:#4a5568" data-rest-style="background:${bgColor}">
            <div style="width:60px;min-width:60px;text-align:center;font-size:1.25rem;color:#fbbf24;">${rank}</div>
            <div style="flex:1;display:flex;align-items:center;min-width:0;padding-left:0.2rem;">
              <a href="${playerLink}" style="color:${nameColor};font-weight:${isWinner ? '600' : '400'};text-decoration:none;">${name}</a>
              ${renderTwitchLink(e)}${renderVodLink(e)}
            </div>
            <div style="color:${timeColor};font-weight:600;font-family:monospace;font-size:1rem;">${timeStr}</div>
          </div>
        `;
      }
    }).join('');

    participantsEl.innerHTML = html;
  }

  function renderStatus() {
    const status = currentRace.status || 'unknown';
    statusEl.textContent = getStatusText(status);
    statusEl.style.background = statusColors[status] || '#6b7280';
    statusEl.style.color = 'white';
  }

  // The race room on racetime.gg or SpeedRunsLive, then the restreams found for it
  function renderLinks() {
    const race = currentRace;
    const links = [];
    const srlUrl = getSpeedRunsLiveRaceUrl(race.url);
    if (srlUrl) {
      links.push(`<a href="${escapeHtml(srlUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:0.6rem;background-color:#1F2937;color:#F0C850;font-weight:600;padding:0.75rem 1.5rem;border-radius:0.5rem;border:2px solid #F0C850;text-decoration:none;transition:all 0.2s;font-size:1rem;" data-hover-style="background:#374151" data-rest-style="background:#1F2937">${escapeHtml(tr('raceDetail.viewOn', 'View on'))}<span class="srl-logo" role="img" aria-label="SpeedRunsLive" style="--srl-logo-height:22px;"></span></a>`);
    } else if (race.url) {
      const safeRacetimeUrl = sanitizeExternalUrl(normalizeRacetimeRaceUrl(race.url, race.category));
      if (safeRacetimeUrl) {
        links.push(`<a href="${escapeHtml(safeRacetimeUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-flex;align-items:center;gap:0.5rem;background-color:#1F2937;color:#E3E6E6;font-weight:600;padding:0.75rem 1.5rem;border-radius:0.5rem;border:2px solid #E3E6E6;text-decoration:none;transition:all 0.2s;font-size:1rem;" data-hover-style="background:#374151" data-rest-style="background:#1F2937"><img src="/assets/racetime.svg" alt="Racetime" style="width:24px;height:24px;">${escapeHtml(tr('raceDetail.viewOnRacetime', 'View on Racetime'))}</a>`);
      }
    }
    if (currentTournament) {
      findRestreams(race, currentTournament)
        .map(stream => renderRestreamLink(stream, LIVE_RACE_STATUSES.includes(race.status)))
        .filter(Boolean)
        .forEach(link => links.push(link));
    }
    linksEl.innerHTML = links.join('');
  }

  async function load() {
    try {
      await loadGames();

      let race;
      
      if (raceId) {
        race = await fetchJson('/api/runs/' + encodeURIComponent(raceId));
      } else if (raceUrl) {
        // Try to find race by URL
        const found = await fetchJson('/api/runs?limit=1&url=' + encodeURIComponent(raceUrl));
        race = (found.races || [])[0];
        if (!race) throw new Error('Race not found');
      } else {
        gameEl.textContent = tr('raceDetail.noRace', 'No race specified');
        return;
      }

      let gameDisplayName = getGameDisplayName(race.category);
      const gameDoc = getGameDocForCategory(race.category);

      // Game name
      if (gameDoc?.id) {
        gameEl.innerHTML = `<a href="/games/${encodeURIComponent(gameDoc.id)}" style="color:inherit;text-decoration:none;">${escapeHtml(gameDisplayName)}</a>`;
      } else {
        gameEl.textContent = gameDisplayName;
      }
      
      // Goal
      goalEl.textContent = race.goal || race.name || '';
      
      // Status
      currentRace = race;
      renderStatus();
      
      // Info (seed info, etc.)
      if (race.info) {
        infoEl.innerHTML = formatInfoHtml(race.info, race.category);
        window.HashIcons?.load().then((hashIcons) => {
          infoEl.innerHTML = formatInfoHtml(race.info, race.category, hashIcons);
        });
      }
      
      // Times
      refreshDateTimeFields();
      
      // Entrants count
      const entrantsCount = (race.entrants || []).length;
      entrantsCountEl.textContent = entrantsCount;
      
      // Links
      currentRace = race;
      renderLinks();
      
      // Tournament link
      if (race.tournamentId) {
        try {
          currentTournament = await fetchJson('/api/tournaments/' + encodeURIComponent(race.tournamentId));
          if (currentTournament && currentTournament.name) {
            tournamentNameEl.textContent = currentTournament.name;
            tournamentNameEl.href = '/tournaments/' + encodeURIComponent(race.tournamentId);
            tournamentLinkDiv.style.display = 'block';
          }
          renderLinks();
        } catch (e) {
          // Tournament not found, ignore
        }
      }
      applyRaceSeo(race, gameDisplayName, currentTournament && currentTournament.name ? currentTournament : null);
      
      // Update title then participants
      updateParticipantsTitle();
      renderParticipants(race.entrants);

      // Twitch links of entrants streaming the race, refreshed while the page stays open
      if (LIVE_RACE_STATUSES.includes(race.status)) {
        loadLiveStreams(race);
        setInterval(() => {
          if (!document.hidden) loadLiveStreams(race);
        }, STREAMS_REFRESH_MS);
      }
      
    } catch (e) {
      const errText = (typeof i18n !== 'undefined' && typeof i18n.t === 'function') ? i18n.t('common.error') : 'Loading error';
      gameEl.textContent = errText;
      console.error(e);
    }
  }

  if (raceId || raceUrl) {
    load();
  } else {
    gameEl.textContent = tr('raceDetail.noRace', 'No race specified');
  }
})();
