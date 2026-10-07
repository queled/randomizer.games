// Tournament detail page logic
let currentTournament = null;
let currentMatches = [];
let currentRaces = [];
let currentOptions = {};

// Listen for spoiler mode changes to re-render content dynamically
window.addEventListener('spoilerModeChanged', () => {
  if (currentTournament) {
    // Re-render participants with current data
    displayParticipants(currentTournament.participants || [], currentMatches, currentOptions);
    
    // Re-render bracket
    const groupStageMatches = currentMatches.filter(m => m && m.groupId !== null && m.groupId !== undefined);
    const finalStageMatches = currentMatches.filter(m => m && (m.groupId === null || m.groupId === undefined));
    const hasGroupsThenFinal = groupStageMatches.length > 0 && finalStageMatches.length > 0;
    
    displayBracket(hasGroupsThenFinal ? finalStageMatches : currentMatches, currentTournament, currentRaces);
    
    // Re-render group stages if present
    if (hasGroupsThenFinal) {
      displayGroupStages(groupStageMatches, currentTournament.participants || [], currentRaces);
    }
  }
});

document.addEventListener('DOMContentLoaded', async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const tournamentId = urlParams.get('id');

  if (!tournamentId) {
    alert('ID de tournoi manquant');
    window.location.href = '/tournaments.html';
    return;
  }

  // Initialize tab switching (pass tournamentId for per-tournament persistence)
  initializeTabs(tournamentId);

  await loadTournamentDetails(tournamentId);
});

function initializeTabs(tournamentId) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabName = btn.getAttribute('data-tab');
      switchTab(tabName);
      try {
        if (tournamentId) localStorage.setItem(`tournament_active_tab_${tournamentId}`, tabName);
        else localStorage.setItem('tournament_active_tab', tabName);
      } catch (e) { /* ignore storage errors */ }
    });
  });

  // Restore saved tab for this tournament if available
  try {
    // Only restore saved tab when the navigation is a reload or a back/forward navigation.
    // For a fresh navigation (clicking a tournament link), keep the default (bracket).
    let navType = 'navigate';
    try {
      const ent = performance.getEntriesByType && performance.getEntriesByType('navigation') && performance.getEntriesByType('navigation')[0];
      if (ent && ent.type) navType = ent.type;
      else if (performance && performance.navigation && typeof performance.navigation.type !== 'undefined') {
        // legacy API: 1 = reload, 2 = back_forward
        navType = performance.navigation.type === 1 ? 'reload' : (performance.navigation.type === 2 ? 'back_forward' : 'navigate');
      }
    } catch (e) { /* ignore performance errors */ }

    if (navType === 'reload' || navType === 'back_forward') {
      const key = tournamentId ? `tournament_active_tab_${tournamentId}` : 'tournament_active_tab';
      const saved = localStorage.getItem(key);
      if (saved) {
        const btn = document.querySelector(`.tab-btn[data-tab="${saved}"]`);
        if (btn) switchTab(saved);
      }
    }
  } catch (e) { /* ignore restore errors */ }
}

function sanitizeExternalUrl(url, { allowRelative = false, allowMailto = false } = {}) {
  const raw = String(url || '').trim();
  if (!raw) return '';

  if (allowRelative && raw.startsWith('/')) {
    return raw;
  }

  try {
    const parsed = new URL(raw, window.location.origin);
    if (/^https?:$/i.test(parsed.protocol)) return parsed.href;
    if (allowMailto && /^mailto:$/i.test(parsed.protocol)) return parsed.href;
    return '';
  } catch {
    return '';
  }
}

function hardenExternalAnchors(container) {
  if (!container) return;

  container.querySelectorAll('a[href]').forEach((anchor) => {
    const safeHref = sanitizeExternalUrl(anchor.getAttribute('href'), { allowRelative: true, allowMailto: true });
    if (!safeHref) {
      anchor.removeAttribute('href');
      anchor.removeAttribute('target');
      anchor.removeAttribute('rel');
      return;
    }

    anchor.setAttribute('href', safeHref);
    if (/^https?:\/\//i.test(safeHref)) {
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

function mapTournamentStatusToEventStatus(status) {
  switch (status) {
    case 'à venir':
      return 'https://schema.org/EventScheduled';
    case 'en cours':
      return 'https://schema.org/EventInProgress';
    default:
      return 'https://schema.org/EventCompleted';
  }
}

function applyTournamentSeo(tournament) {
  if (!window.RandomizerSEO || typeof window.RandomizerSEO.updatePage !== 'function' || !tournament) {
    return;
  }

  const gameLabel = tournament.gameName
    || tournament.game?.official?.name
    || tournament.game?.name
    || tournament.game?.randomizer?.shortName
    || 'Randomizer game';
  const status = getTournamentStatus(tournament);
  const participantsCount = Number(tournament.participantsCount) || (Array.isArray(tournament.participants) ? tournament.participants.length : 0);
  const description = [
    `${tournament.name} on Randomizer.`,
    `${status} ${gameLabel} tournament with ${participantsCount} participants.`,
    'Explore bracket, participants and linked races.'
  ].join(' ');
  const detailUrl = `/tournament-detail.html?id=${encodeURIComponent(tournament._id || tournament.id)}`;
  const breadcrumb = window.RandomizerSEO.buildBreadcrumbList([
    { name: 'Home', url: '/' },
    { name: 'Tournaments', url: '/tournaments.html' },
    { name: tournament.name, url: detailUrl }
  ]);
  const image = tournament.game?.image || tournament.game?.logo || '/assets/favicon.png';
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: tournament.name,
    url: window.RandomizerSEO.buildAbsoluteUrl(detailUrl),
    startDate: tournament.startDate || undefined,
    endDate: tournament.endDate || undefined,
    eventStatus: mapTournamentStatusToEventStatus(status),
    description,
    image: window.RandomizerSEO.buildAbsoluteUrl(image) || window.RandomizerSEO.defaultImage
  };

  window.RandomizerSEO.updatePage({
    title: `${tournament.name} - Tournament - Randomizer`,
    description,
    canonicalParams: { id: tournament._id || tournament.id },
    image,
    jsonLd: [breadcrumb, schema]
  });
}

async function loadTournamentDetails(tournamentId) {
  try {
    const response = await fetch(`/api/tournaments/${tournamentId}`);
    if (!response.ok) {
      throw new Error('Tournament not found');
    }

    currentTournament = await response.json();
    displayTournamentInfo(currentTournament);
    displayParticipants(currentTournament.participants || []); // Display without match history first
    
    // Load matches if available
    loadMatches(tournamentId);
  } catch (error) {
    console.error('Error loading tournament:', error);
    alert('Error loading tournament');
    window.location.href = '/tournaments.html';
  }
}

function updateEndDateFromMatches(matches, races = []) {
  if (!matches || matches.length === 0) return;

  // Build quick lookup for races by matchId and by normalized URL
  const byMatchId = new Map();
  const byUrl = new Map();
  const normalizeUrl = (u) => (u || '').toString().replace(/^\/+/, '').toLowerCase();
  (races || []).forEach(r => {
    try {
      if (r.matchId) byMatchId.set(String(r.matchId), r);
    } catch (e) {}
    try {
      const ru = normalizeUrl(r.url);
      if (ru) byUrl.set(ru, r);
    } catch (e) {}
  });

  let lastTimestamp = 0;
  let lastDate = null;

  matches.forEach(match => {
    let candidate = null;

    // Prefer race endedAt if race exists for this match
    let race = null;
    try {
      const mid = match._id || match.id || null;
      if (mid && byMatchId.has(String(mid))) race = byMatchId.get(String(mid));
    } catch (e) {}
    if (!race && match.raceUrl) {
      const mu = normalizeUrl(match.raceUrl);
      const direct = byUrl.get(mu);
      if (direct) race = direct;
      // Fallback: match by ending segment
      if (!race) {
        const slug = mu.split('/').filter(Boolean).pop();
        for (const [ru, r] of byUrl.entries()) {
          if (ru.endsWith(slug)) { race = r; break; }
        }
      }
    }

    if (race) {
      candidate = race.endedAt || null;
      if (!candidate && Array.isArray(race.entrants) && race.entrants.length) {
        // Use max finishedAt among entrants if race.endedAt missing
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

    // Otherwise fall back to match.completedAt, then startedAt
    if (!candidate) candidate = match.completedAt || null;
    if (!candidate) candidate = match.startedAt || null;

    if (candidate) {
      const ts = new Date(candidate).getTime();
      if (ts > lastTimestamp) {
        lastTimestamp = ts;
        lastDate = candidate;
      }
    }
  });

  if (lastDate) {
    document.getElementById('end-date').textContent = formatDate(lastDate);
  }
}

function displayTournamentInfo(tournament) {
  // Title and game
  document.getElementById('tournament-title').textContent = tournament.name;
  document.getElementById('page-title').textContent = `${tournament.name} - Randomizer`;
  const tournamentGameEl = document.getElementById('tournament-game');
  const tournamentGameLabel = tournament.gameName || 'Unknown game';
  if (tournament.game?.id) {
    tournamentGameEl.innerHTML = `<a href="/game-detail.html?id=${encodeURIComponent(tournament.game.id)}" style="color:inherit;text-decoration:none;">${escHtml(tournamentGameLabel)}</a>`;
  } else {
    tournamentGameEl.textContent = tournamentGameLabel;
  }
  applyTournamentSeo(tournament);

  // Status badge
  const status = getTournamentStatus(tournament);
  const statusEl = document.getElementById('tournament-status');
  const statusClass = status === 'en cours' ? 'status-ongoing' 
                    : status === 'à venir' ? 'status-upcoming' 
                    : 'status-finished';
  let statusText;
  if (typeof i18n !== 'undefined') {
    statusText = status === 'en cours' ? i18n.t('status.tournament.ongoing')
               : status === 'à venir' ? i18n.t('status.tournament.upcoming')
               : i18n.t('status.tournament.finished');
  } else {
    statusText = status === 'en cours' ? 'Ongoing'
               : status === 'à venir' ? 'Upcoming'
               : 'Finished';
  }
  statusEl.innerHTML = `<span class="status-badge ${statusClass}">${statusText}</span>`;

  // Dates and info
  document.getElementById('start-date').textContent = formatDate(tournament.startDate);
  
  // End date will be updated after matches are loaded
  document.getElementById('end-date').textContent = formatDate(tournament.endDate);
  
  document.getElementById('tournament-type').textContent = formatTournamentTypeForDisplay(tournament);
  document.getElementById('participants-count').textContent = tournament.participantsCount || '0';

  // Description (may contain HTML coming from Challonge)
  if (tournament.description) {
    document.getElementById('description-container').style.display = 'block';
    // render as HTML (trusted source: Challonge description)
    const descriptionEl = document.getElementById('tournament-description');
    descriptionEl.innerHTML = tournament.description;
    hardenExternalAnchors(descriptionEl);
  }

  // Make the entire participants card clickable to open the Participants tab
  try {
    const participantsCountEl = document.getElementById('participants-count');
    const participantsCard = participantsCountEl ? participantsCountEl.parentElement : null;
    if (participantsCard) {
      // Visual affordance
      try { participantsCard.style.cursor = 'pointer'; } catch (e) {}
      try { participantsCard.title = 'Voir les participants'; } catch (e) {}
      // Make accessible: allow focusing the card
      try { participantsCard.tabIndex = 0; } catch (e) {}

      const tid = tournament._id || tournament.id || null;
      const openParticipants = () => {
        try { switchTab('participants'); } catch (e) {}
        try {
          if (tid) localStorage.setItem(`tournament_active_tab_${tid}`, 'participants');
          else localStorage.setItem('tournament_active_tab', 'participants');
        } catch (e) {}
      };

      const openAndScroll = () => {
        openParticipants();
        try {
          const el = document.getElementById('tab-content-participants');
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (e) {}
      };

      // Attach handlers to the card (delegated on the whole card)
      participantsCard.addEventListener('click', openAndScroll);
      participantsCard.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openAndScroll(); }
      });

      // Also keep the numeric element semantically a live count (no duplicate handlers needed)
    }
  } catch (e) { /* ignore attach errors */ }

  // Challonge link
  if (tournament.fullUrl) {
    // Detect source type from source.type or from URL pattern
    const sourceType = tournament.source?.type || 
      (tournament.startggId ? 'startgg' : 
       (tournament.challongeId ? 'challonge' : null));
    
    if (sourceType === 'startgg') {
      document.getElementById('startgg-link-container').style.display = 'block';
      document.getElementById('startgg-link').href = tournament.fullUrl;
    } else {
      document.getElementById('challonge-link-container').style.display = 'block';
      document.getElementById('challonge-link').href = tournament.fullUrl;
    }
  }
}

function displayParticipants(participants, matches = [], options = {}) {
  const container = document.getElementById('participants-list');
  
  if (!participants || participants.length === 0) {
    container.innerHTML = '<p style="color: #9ca3af;">No participants</p>';
    return;
  }

  const opt = (options && typeof options === 'object' && !Array.isArray(options)) ? options : {};
  const rankOnly = !!opt.rankOnly;

  // Best-effort ranking when Challonge doesn't provide finalRank yet (e.g. awaiting_review).
  // Only used when rankOnly=true (Groups→SE).
  let statsById = null;
  if (rankOnly) {
    try {
      const map = new Map();
      (participants || []).forEach(p => {
        const pid = p && (p.challongeId != null ? String(p.challongeId) : null);
        if (!pid) return;
        map.set(pid, {
          pid,
          qualified: false,
          maxFinalRound: 0,
          finalWins: 0,
          groupWins: 0,
          groupLosses: 0,
          seed: (p.seed != null ? Number(p.seed) : null)
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

        const get = (pid) => {
          if (!pid) return null;
          if (!map.has(pid)) map.set(pid, { pid, qualified: false, maxFinalRound: 0, finalWins: 0, groupWins: 0, groupLosses: 0, seed: null });
          return map.get(pid);
        };

        // For group stage matches, also try to find participant by name since IDs might not match
        const getByName = (playerName) => {
          if (!playerName) return null;
          for (const [pid, stat] of map.entries()) {
            const participant = (participants || []).find(p => String(p.challongeId) === pid);
            if (participant && (participant.name === playerName || participant.displayName === playerName)) {
              return stat;
            }
          }
          return null;
        };

        let s1 = get(p1);
        let s2 = get(p2);
        
        // If not found by ID (group stage), try by name
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
          // Group stage - determine winner by comparing with player IDs or names
          if (winner) {
            let p1Won = false;
            let p2Won = false;
            
            if (winner === p1) {
              p1Won = true;
            } else if (winner === p2) {
              p2Won = true;
            } else if (m.player1Name && m.player2Name) {
              // Try to match by name when IDs don't match
              const winnerParticipant = (participants || []).find(part => 
                String(part.challongeId) === winner || 
                part.name === m.player1Name || 
                part.displayName === m.player1Name ||
                part.name === m.player2Name || 
                part.displayName === m.player2Name
              );
              if (winnerParticipant) {
                if (winnerParticipant.name === m.player1Name || winnerParticipant.displayName === m.player1Name) {
                  p1Won = true;
                } else if (winnerParticipant.name === m.player2Name || winnerParticipant.displayName === m.player2Name) {
                  p2Won = true;
                }
              }
            }
            
            if (s1) {
              if (p1Won) s1.groupWins += 1;
              else if (p2Won) s1.groupLosses += 1;
            }
            if (s2) {
              if (p2Won) s2.groupWins += 1;
              else if (p1Won) s2.groupLosses += 1;
            }
          }
        }
      });

      statsById = map;
    } catch (e) {
      statsById = null;
    }
  }

  // Sort by "classement" (finalRank). For groups→SE: do not fall back to seed.
  // In spoiler mode: sort alphabetically instead to avoid revealing winner
  const spoilerMode = typeof window.isSpoilerModeEnabled === 'function' && window.isSpoilerModeEnabled();
  
  let sorted;
  if (spoilerMode) {
    // Alphabetical sort in spoiler mode
    sorted = [...participants].sort((a, b) => {
      const nameA = (a.displayName || a.name || '').toLowerCase();
      const nameB = (b.displayName || b.name || '').toLowerCase();
      return nameA.localeCompare(nameB, 'fr');
    });
  } else {
    // Normal ranking sort
    sorted = [...participants].sort((a, b) => {
      const ar = (a && a.finalRank != null) ? Number(a.finalRank) : null;
      const br = (b && b.finalRank != null) ? Number(b.finalRank) : null;
      const aHas = Number.isFinite(ar) && ar > 0;
      const bHas = Number.isFinite(br) && br > 0;
      if (aHas && bHas) return ar - br;
      if (aHas && !bHas) return -1;
      if (!aHas && bHas) return 1;

      if (rankOnly && statsById) {
        const aid = a && a.challongeId != null ? String(a.challongeId) : null;
        const bid = b && b.challongeId != null ? String(b.challongeId) : null;
        const sa = aid ? statsById.get(aid) : null;
        const sb = bid ? statsById.get(bid) : null;

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
      }

      if (!rankOnly) {
        const as = (a && a.seed != null) ? Number(a.seed) : null;
        const bs = (b && b.seed != null) ? Number(b.seed) : null;
        const aSeed = Number.isFinite(as) && as > 0;
        const bSeed = Number.isFinite(bs) && bs > 0;
        if (aSeed && bSeed) return as - bs;
        if (aSeed && !bSeed) return -1;
        if (!aSeed && bSeed) return 1;
      }

      return 0;
    });
  }

  container.innerHTML = '';
  sorted.forEach((participant, idx) => {
    const row = document.createElement('div');
    row.style.cssText = 'display: flex; align-items: center; padding: 0.75rem 1rem; background-color: #1f2937; border-radius: 0.5rem; transition: background-color 0.2s;';
    row.onmouseover = () => row.style.backgroundColor = '#374151';
    row.onmouseout = () => row.style.backgroundColor = '#1f2937';
    
    // Rank badge
    let rankBadge = '';
    if (participant.finalRank) {
      const rankColor = participant.finalRank === 1 ? '#fbbf24' 
                      : participant.finalRank === 2 ? '#9ca3af'
                      : participant.finalRank === 3 ? '#cd7f32'
                      : '#4b5563';
      rankBadge = `<div style="display: inline-flex; align-items: center; justify-content: center; min-width: 2.5rem; height: 2rem; background-color: ${rankColor}; color: white; border-radius: 0.25rem; font-weight: bold; margin-right: 1rem;">#${participant.finalRank}</div>`;
    } else if (rankOnly) {
      const rank = idx + 1;
      const rankColor = rank === 1 ? '#fbbf24'
                      : rank === 2 ? '#9ca3af'
                      : rank === 3 ? '#cd7f32'
                      : '#4b5563';
      rankBadge = `<div style="display: inline-flex; align-items: center; justify-content: center; min-width: 2.5rem; height: 2rem; background-color: ${rankColor}; color: white; border-radius: 0.25rem; font-weight: bold; margin-right: 1rem;">#${rank}</div>`;
    } else if (participant.seed) {
      rankBadge = `<div style="display: inline-flex; align-items: center; justify-content: center; min-width: 2.5rem; height: 2rem; background-color: #4b5563; color: #d1d5db; border-radius: 0.25rem; font-size: 0.875rem; margin-right: 1rem;">Seed ${participant.seed}</div>`;
    }

    // Find all matches for this participant
    // For group stage matches, player IDs might not match challongeId, so also check by name
    const participantMatches = matches.filter(m => {
      const matchByIdP1 = m.player1Id === participant.challongeId;
      const matchByIdP2 = m.player2Id === participant.challongeId;
      const matchByNameP1 = m.player1Name && (m.player1Name === participant.name || m.player1Name === participant.displayName);
      const matchByNameP2 = m.player2Name && (m.player2Name === participant.name || m.player2Name === participant.displayName);
      return matchByIdP1 || matchByIdP2 || matchByNameP1 || matchByNameP2;
    }).sort((a, b) => {
      // Sort by date (oldest first)
      const getTime = (m) => {
        const d = m && (m.completedAt || m.startedAt || m.updatedAt || m.createdAt);
        if (!d) return 0;
        const t = new Date(d).getTime();
        return Number.isFinite(t) ? t : 0;
      };
      return getTime(a) - getTime(b);
    });

    // Create match history (V for victory, D for defeat)
    const matchHistory = participantMatches.map(match => {
      if (!match.winnerId) return null; // Skip unfinished matches
      
      // Determine if participant won (check both by ID and by name)
      // Convert IDs to strings for comparison (Start.gg uses string IDs)
      let isWinner = false;
      const winnerIdStr = String(match.winnerId);
      const participantIdStr = participant.challongeId != null ? String(participant.challongeId) : null;
      const player1IdStr = match.player1Id != null ? String(match.player1Id) : null;
      const player2IdStr = match.player2Id != null ? String(match.player2Id) : null;
      
      if (participantIdStr && winnerIdStr === participantIdStr) {
        isWinner = true;
      } else if (player1IdStr && winnerIdStr === player1IdStr && (match.player1Name === participant.name || match.player1Name === participant.displayName)) {
        isWinner = true;
      } else if (player2IdStr && winnerIdStr === player2IdStr && (match.player2Name === participant.name || match.player2Name === participant.displayName)) {
        isWinner = true;
      }
      
      const mid = match.challongeId || match.id || match._id || match.matchId || '';
      const baseStyle = 'display: inline-flex; align-items: center; justify-content: center; width: 1.5rem; height: 1.5rem; border-radius: 50%; font-weight: bold; font-size: 0.75rem; margin-left: 0.25rem; cursor: pointer;';
      // Render badge without inline onclick; use delegation on #participants-list
      if (isWinner) {
        return `<span class="match-badge" data-match-id="${escapeHtml(mid)}" style="${baseStyle} background-color: #10b981; color: white;">V</span>`;
      }
      return `<span class="match-badge" data-match-id="${escapeHtml(mid)}" style="${baseStyle} background-color: #ef4444; color: white;">D</span>`;
    }).filter(h => h !== null).join('');

    row.innerHTML = `
      <span class="spoiler-block">${rankBadge}</span>
      <div style="flex: 1; min-width: 0; overflow: hidden;">
        <a href="/player-detail.html?name=${encodeURIComponent(participant.displayName || participant.name)}" style="font-weight: bold; color: white; margin-bottom: 0.125rem; cursor: pointer; text-decoration: none; display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escHtml(participant.displayName || participant.name)}</a>
        ${participant.name !== participant.displayName && participant.displayName ? `<div style=\"color: #9ca3af; font-size: 0.875rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;\">${escHtml(participant.name)}</div>` : ''}
      </div>
      <div class="spoiler-block" style="display: flex; align-items: center; gap: 0.25rem; margin-left: 0.5rem; flex-shrink: 0;">
        ${matchHistory}
      </div>
    `;
    
    container.appendChild(row);
  });

  // Attach delegated click handler once to participants container to handle match-badge clicks
  try {
    if (!container.dataset.matchListenerAdded) {
      container.addEventListener('click', (ev) => {
        const badge = ev.target.closest && ev.target.closest('.match-badge');
        if (!badge) return;
        const mid = badge.getAttribute('data-match-id');
        try { console.debug('participant badge clicked, mid=', mid); } catch(e) {}
        goToMatchById(mid);
      });
      container.dataset.matchListenerAdded = '1';
    }
  } catch (e) { /* ignore listener attach errors */ }
}

// Enrich matches with participant names when player1Name/player2Name are missing
function enrichMatchesWithParticipantNames(matches, participants) {
  if (!matches || !participants || participants.length === 0) return;
  
  // Create a lookup map: participantId -> participant name
  const participantMap = new Map();
  participants.forEach(p => {
    if (p.challongeId) {
      participantMap.set(p.challongeId, p.name);
    }
  });
  
  // Enrich each match
  matches.forEach(match => {
    // For Start.gg matches: normalize player1/player2 objects to player1Name/player2Name
    if (match.player1 && typeof match.player1 === 'object' && match.player1.name) {
      match.player1Name = match.player1.name;
      match.player1Id = match.player1.startggEntrantId || match.player1Id;
    }
    if (match.player2 && typeof match.player2 === 'object' && match.player2.name) {
      match.player2Name = match.player2.name;
      match.player2Id = match.player2.startggEntrantId || match.player2Id;
    }
    
    // For Challonge matches: add names from participant map if missing
    if (!match.player1Name && match.player1Id) {
      match.player1Name = participantMap.get(match.player1Id) || null;
    }
    if (!match.player2Name && match.player2Id) {
      match.player2Name = participantMap.get(match.player2Id) || null;
    }
  });
}

async function loadMatches(tournamentId) {
  try {
    const response = await fetch(`/api/tournaments/${tournamentId}/matches`);
    if (!response.ok) {
      document.getElementById('matches-list').innerHTML = `<p style="color: #9ca3af;">${i18n.t('tournamentDetail.noMatches') || 'No matches available'}</p>`;
      document.getElementById('bracket-container').innerHTML = `<p style="color: #9ca3af;">${i18n.t('tournamentDetail.noMatchesForBracket') || 'No matches available to display bracket'}</p>`;
      return;
    }

    const data = await response.json();
    // matches loaded
    // Load races for this tournament as well (used to show entrant times)
    let races = [];
    try {
      const racesRes = await fetch(`/api/tournaments/${tournamentId}/races`);
      if (racesRes.ok) {
        const racesJson = await racesRes.json();
        races = racesJson.races || [];
      }
    } catch (e) {
      // ignore race loading errors
    }

    const allMatches = data.matches || [];
    
    // Store for re-rendering on spoiler mode change
    currentMatches = allMatches;
    currentRaces = races;
    
    // Update end date with last match date now that matches and races are loaded
    updateEndDateFromMatches(allMatches, races);

    // Enrich matches with participant names if missing (for group stages)
    enrichMatchesWithParticipantNames(allMatches, currentTournament.participants || []);

    // If Challonge group stages are present, matches will have `groupId`.
    // Render group stage separately and only show the final bracket in the Bracket tab.
    const groupStageMatches = allMatches.filter(m => m.groupId !== null && m.groupId !== undefined);
    const finalStageMatches = allMatches.filter(m => m.groupId === null || m.groupId === undefined);
    const hasGroupsThenFinal = groupStageMatches.length > 0 && finalStageMatches.length > 0;
    const isGroupsThenFinalSE = hasGroupsThenFinal && currentTournament && currentTournament.tournamentType !== 'double elimination';

    // Update the displayed tournament type when we detect group stages.
    if (hasGroupsThenFinal) {
      try {
        const label = computeGroupsThenFinalLabel(groupStageMatches, finalStageMatches);
        if (label) {
          document.getElementById('tournament-type').textContent = label;
        }
      } catch (e) {
        // ignore label errors
      }
    }

    displayMatches(allMatches, currentTournament, races);
    displayBracket(hasGroupsThenFinal ? finalStageMatches : allMatches, currentTournament, races);
    if (hasGroupsThenFinal) {
      displayGroupStages(groupStageMatches, currentTournament.participants || [], races);
    }
    displayQualifications(races);
    currentOptions = { rankOnly: isGroupsThenFinalSE };
    displayParticipants(currentTournament.participants || [], allMatches, currentOptions);
  } catch (error) {
    console.error('Error loading matches:', error);
    const errText = (typeof i18n !== 'undefined' && typeof i18n.t === 'function') ? i18n.t('common.error') : 'Loading error';
    document.getElementById('matches-list').innerHTML = `<p style="color: #ef4444;">${errText}</p>`;
    document.getElementById('bracket-container').innerHTML = `<p style="color: #ef4444;">${errText}</p>`;
  }
}

let _lastQualificationRaces = [];

function displayQualifications(races = []) {
  _lastQualificationRaces = races || [];
  const container = document.getElementById('qualifications-list');
  
  if (!races || !Array.isArray(races) || races.length === 0) {
    const noQualText = typeof i18n !== 'undefined' ? i18n.t('common.noResults') : 'No results';
    container.innerHTML = `<p style="color: #9ca3af;">${noQualText}</p>`;
    return;
  }

  // Filter qualification races: races without a matchId (not linked to a match)
  // AND races with tournamentPhase set to 'Qualifications' (for Start.gg tournaments)
  const qualificationRaces = races.filter(race => 
    (!race.matchId && !race.tournamentPhase) || 
    race.tournamentPhase === 'Qualifications'
  );

  if (qualificationRaces.length === 0) {
    const noQualText = typeof i18n !== 'undefined' ? i18n.t('common.noResults') : 'No results';
    container.innerHTML = `<p style="color: #9ca3af;">${noQualText}</p>`;
    return;
  }

  // Sort by date (most recent first)
  const sortedRaces = qualificationRaces.slice().sort((a, b) => {
    const dateA = new Date(a.endedAt || a.startedAt || a.createdAt || 0).getTime();
    const dateB = new Date(b.endedAt || b.startedAt || b.createdAt || 0).getTime();
    return dateB - dateA;
  });

  container.innerHTML = '';

  sortedRaces.forEach(race => {
    const card = createQualificationRaceCard(race);
    container.appendChild(card);
  });
}

// Re-render qualifications when spoiler mode toggles
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('spoilerModeChanged', () => {
    try { displayQualifications(_lastQualificationRaces); } catch (e) { /* ignore */ }
  });
}

function createQualificationRaceCard(race) {
  const card = document.createElement('div');
  card.style.cssText = 'background-color: #1f2937; padding: 1rem; border-radius: 0.5rem; margin-bottom: 0.75rem;';

  // Race header
  const header = document.createElement('div');
  header.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;';

  const titleDiv = document.createElement('div');
  const raceTitle = document.createElement('h3');
  raceTitle.style.cssText = 'font-size: 1rem; font-weight: bold; color: #fbbf24; margin-bottom: 0.25rem;';
  // Make the race name a clickable link to the internal race detail page
  const raceName = race.name || 'Race de qualification';
  const raceLinkElem = document.createElement('a');
  raceLinkElem.textContent = raceName;
  raceLinkElem.style.cssText = 'color: inherit; text-decoration: none; cursor: pointer;';
  try {
    const rid = race._id || race.id || null;
    if (rid) raceLinkElem.href = '/race-detail.html?id=' + encodeURIComponent(rid);
    else raceLinkElem.href = '#';
  } catch (e) {
    raceLinkElem.href = '#';
  }
  raceTitle.appendChild(raceLinkElem);
  
  const raceGoal = document.createElement('p');
  raceGoal.style.cssText = 'font-size: 0.875rem; color: #9ca3af; margin-bottom: 0.25rem;';
  if (race.goal) {
    raceGoal.textContent = race.goal;
  }
  
  titleDiv.appendChild(raceTitle);
  if (race.goal) titleDiv.appendChild(raceGoal);
  
  // Display race.info (description) if present
  if (race.info) {
    const raceInfoText = document.createElement('p');
    raceInfoText.style.cssText = 'font-size: 0.875rem; color: #d1d5db; font-style: italic;';
    raceInfoText.textContent = race.info;
    titleDiv.appendChild(raceInfoText);
  }
  
  header.appendChild(titleDiv);

  // Race link
  if (race.url) {
    const linkDiv = document.createElement('div');
    const rawUrl = (race.url || '').toString().trim();
    let path = rawUrl;
    if (/^https?:\/\//i.test(path)) {
      try {
        path = new URL(path).pathname || '';
      } catch (e) {
        path = path.replace(/^https?:\/\/(www\.)?racetime\.gg/i, '');
      }
    } else if (/racetime\.gg/i.test(path)) {
      path = path.replace(/^https?:\/\/(www\.)?racetime\.gg/i, '');
    }
    path = '/' + String(path || '').replace(/^\/+/, '');
    const parts = path.split('/').filter(Boolean);
    if (parts.length >= 3 && parts[0] === parts[1]) parts.splice(1, 1);
    const href = 'https://racetime.gg/' + parts.join('/');
    
    const link = document.createElement('a');
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.style.cssText = 'display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.35rem 0.65rem; border-radius: 0.25rem; font-size: 0.8rem; color: #C2CECF; background: #222222; border: 1px solid #C2CECF; text-decoration: none;';
    link.innerHTML = '<img src="assets/racetime.svg" alt="Racetime" style="width: 16px; height: 16px;">Racetime';
    linkDiv.appendChild(link);
    header.appendChild(linkDiv);
  }

  card.appendChild(header);

  // Race date range (start and end with time)
  if (race.startedAt || race.endedAt) {
    const dateDiv = document.createElement('div');
    dateDiv.style.cssText = 'font-size: 0.875rem; color: #9ca3af; margin-bottom: 0.75rem;';
    
    const parts = [];
    if (race.startedAt) {
      const startLabel = typeof i18n !== 'undefined' ? i18n.t('raceDetail.start') : '📅 Start';
      parts.push(`${startLabel}: ${formatDateTime(race.startedAt)}`);
    }
    if (race.endedAt) {
      const endLabel = typeof i18n !== 'undefined' ? i18n.t('raceDetail.end') : '🏁 Fin';
      parts.push(`${endLabel}: ${formatDateTime(race.endedAt)}`);
    }
    
    dateDiv.textContent = parts.join(' • ');
    card.appendChild(dateDiv);
  }

  // Entrants list
  if (race.entrants && race.entrants.length > 0) {
    const entrantsDiv = document.createElement('div');
    entrantsDiv.style.cssText = 'margin-top: 0.75rem; border-top: 1px solid #374151; padding-top: 0.75rem;';

    const entrantsTitle = document.createElement('div');
    entrantsTitle.style.cssText = 'font-size: 0.875rem; color: #9ca3af; margin-bottom: 0.5rem; font-weight: 600;';
    const participantsText = typeof i18n !== 'undefined' ? i18n.t('tournamentDetail.participants') : 'Participants';
    entrantsTitle.textContent = `${participantsText} (${race.entrants.length})`;
    entrantsDiv.appendChild(entrantsTitle);

    // Sort entrants by place or alphabetically if spoiler mode is enabled
    const isSpoilerMode = typeof window.isSpoilerModeEnabled === 'function' && window.isSpoilerModeEnabled();
    const sortedEntrants = race.entrants.slice().sort((a, b) => {
      if (isSpoilerMode) {
        // Sort alphabetically by userName in spoiler mode
        const nameA = (a.userName || '').toLowerCase();
        const nameB = (b.userName || '').toLowerCase();
        return nameA.localeCompare(nameB);
      }
      const placeA = a.place || 999;
      const placeB = b.place || 999;
      return placeA - placeB;
    });

    sortedEntrants.forEach(entrant => {
      const entrantDiv = document.createElement('div');
      entrantDiv.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 0.5rem; background-color: #374151; border-radius: 0.25rem; margin-bottom: 0.35rem;';

      const leftDiv = document.createElement('div');
      leftDiv.style.cssText = 'display: flex; align-items: center; gap: 0.75rem;';

      // Place badge (hidden in spoiler mode)
      if (entrant.place) {
        const placeBadge = document.createElement('span');
        placeBadge.className = 'spoiler-block';
        placeBadge.style.cssText = 'font-weight: bold; font-size: 0.875rem; color: #fbbf24; min-width: 1.5rem; text-align: center;';
        placeBadge.textContent = `${entrant.place}.`;
        leftDiv.appendChild(placeBadge);
      }

      // Player name: link to internal player-detail; keep external userUrl as a small icon if present
      const playerDisplayName = entrant.userName || 'Unknown';
      const playerLink = document.createElement('a');
      playerLink.style.cssText = 'color: #60a5fa; font-weight: 500; font-size: 0.875rem; text-decoration: none;';
      playerLink.textContent = playerDisplayName;
      try {
        playerLink.href = '/player-detail.html?name=' + encodeURIComponent(playerDisplayName);
      } catch (e) {
        playerLink.href = '/player-detail.html?name=' + encodeURIComponent(String(playerDisplayName));
      }
      leftDiv.appendChild(playerLink);

      // Do not show external Racetime icon for entrants; internal player pages are used instead

      entrantDiv.appendChild(leftDiv);

      // Time (hidden in spoiler mode)
      const rightDiv = document.createElement('div');
      if (entrant.finishTimeMs || entrant.finishTime) {
        const time = document.createElement('span');
        time.className = 'spoiler-block';
        time.style.cssText = 'font-family: monospace; color: #d1d5db; font-size: 0.875rem;';
        const formattedTime = formatTime(entrant.finishTimeMs || entrant.finishTime);
        time.textContent = formattedTime || entrant.status || '';
        rightDiv.appendChild(time);
      } else if (entrant.status) {
        const status = document.createElement('span');
        status.className = 'spoiler-block';
        status.style.cssText = 'color: #9ca3af; font-size: 0.875rem; font-style: italic;';
        status.textContent = entrant.status;
        rightDiv.appendChild(status);
      }
      entrantDiv.appendChild(rightDiv);

      entrantsDiv.appendChild(entrantDiv);
    });

    card.appendChild(entrantsDiv);
  }

  return card;
}

function computeGroupsThenFinalLabel(groupStageMatches, finalStageMatches) {
  const groupIds = Array.from(new Set(groupStageMatches.map(m => m.groupId))).filter(v => v !== null && v !== undefined);
  if (!groupIds.length) return null;

  // Estimate group size as the median unique player count per group
  const groupSizes = groupIds.map(gid => {
    const ids = new Set();
    groupStageMatches
      .filter(m => m.groupId === gid)
      .forEach(m => {
        if (m.player1Id) ids.add(m.player1Id);
        if (m.player2Id) ids.add(m.player2Id);
      });
    return ids.size;
  }).filter(n => n > 0).sort((a, b) => a - b);

  const groupSize = groupSizes.length ? groupSizes[Math.floor(groupSizes.length / 2)] : null;

  // Estimate advancement: unique players in final stage / number of groups
  const finalPlayers = new Set();
  finalStageMatches.forEach(m => {
    if (m.player1Id) finalPlayers.add(m.player1Id);
    if (m.player2Id) finalPlayers.add(m.player2Id);
  });

  let advance = null;
  if (finalPlayers.size && groupIds.length) {
    const raw = finalPlayers.size / groupIds.length;
    if (Number.isFinite(raw) && raw > 0) {
      const rounded = Math.round(raw);
      // only accept if close to integer
      if (Math.abs(raw - rounded) < 0.01) advance = rounded;
    }
  }

  if (groupSize && advance) {
    if (typeof i18n !== 'undefined') {
      const template = i18n.t('tournamentTypes.groupsThenSEWithAdvance') || 'Groups ({groupSize} → {advance}) then Single Elimination';
      return template.replace('{groupSize}', groupSize).replace('{advance}', advance);
    }
    return `Groups (${groupSize} → ${advance}) then Single Elimination`;
  }
  return i18n.t('tournamentTypes.groupsThenSE') || 'Groups then Single Elimination';
}

function displayMatches(matches, tournament, races = []) {
  const container = document.getElementById('matches-list');
  
  // Ensure matches is an array
  if (!matches || !Array.isArray(matches) || matches.length === 0) {
    container.innerHTML = `<p style="color: #9ca3af;">${i18n.t('tournamentDetail.noMatches') || 'No matches available'}</p>`;
    return;
  }

  // Detect Start.gg multi-phase tournament (Main Bracket + Preliminary Bracket etc.), in declared phase order
  const declaredOrder = (tournament && Array.isArray(tournament.phases) ? tournament.phases : [])
    .slice().sort((a, b) => (a.phaseOrder || 0) - (b.phaseOrder || 0)).map(p => p.name);
  const phaseRank = name => (declaredOrder.indexOf(name) + 1) || Infinity;
  const phases = [...new Set(matches.filter(m => m && m.phase).map(m => m.phase))]
    .sort((a, b) => phaseRank(a) - phaseRank(b));
  // A lone Swiss / round robin phase also needs per-phase rendering: its rounds are not "Finale", "Demi-finales"...
  const hasStartggPhases = phases.length > 1 || (phases.length === 1 && isStandingsPhase(tournament, phases[0]));

  // Detect Challonge group stage matches using `groupId` when available.
  const groupStageMatches = matches.filter(m => m && (m.groupId !== null && m.groupId !== undefined));
  const finalStageMatches = matches.filter(m => m && (m.groupId === null || m.groupId === undefined));
  const hasGroupsThenFinal = groupStageMatches.length > 0 && finalStageMatches.length > 0;
  const isGroupsThenFinalSE = hasGroupsThenFinal && tournament && tournament.tournamentType !== 'double elimination';

  const getMatchTime = (m) => {
    const d = m && (m.completedAt || m.startedAt || m.updatedAt || m.createdAt);
    if (!d) return 0;
    const t = new Date(d).getTime();
    return Number.isFinite(t) ? t : 0;
  };

  // Only clear once at the start.
  container.innerHTML = '';

  // Start.gg multi-phase tournament: render each phase as a separate section
  if (hasStartggPhases && !hasGroupsThenFinal) {
    // Sort: Main Bracket first, then Preliminary Bracket, then others
    const sortedPhases = phases.slice().sort((a, b) => {
      const al = (a || '').toLowerCase();
      const bl = (b || '').toLowerCase();
      const aIsMain = al.includes('main') || (al === 'bracket' && !al.includes('preliminary'));
      const bIsMain = bl.includes('main') || (bl === 'bracket' && !bl.includes('preliminary'));
      if (aIsMain && !bIsMain) return -1;
      if (!aIsMain && bIsMain) return 1;
      return 0;
    });

    sortedPhases.forEach((phaseName, phaseIdx) => {
      const phaseMatches = matches.filter(m => m.phase === phaseName);
      if (phaseMatches.length === 0) return;

      // Phase header
      const phaseHeader = document.createElement('h3');
      phaseHeader.style.cssText = phaseIdx > 0 ? 'font-size: 1.25rem; font-weight: bold; margin-top: 2.5rem; margin-bottom: 1rem; padding-top: 1.5rem; border-top: 2px solid #374151;' : 'font-size: 1.25rem; font-weight: bold; margin-top: 0.5rem; margin-bottom: 1rem;';
      phaseHeader.textContent = phaseName;
      phaseHeader.classList.add('text-gold');
      container.appendChild(phaseHeader);

      // Separate winner and loser bracket matches within this phase
      const winnerMatches = phaseMatches.filter(m => (m.round || 0) > 0);
      const loserMatches = phaseMatches.filter(m => (m.round || 0) < 0);

      const groupByRound = (matchList) => {
        const byRound = {};
        matchList.forEach(match => {
          const round = match.round || 0;
          if (!byRound[round]) byRound[round] = [];
          byRound[round].push(match);
        });
        return byRound;
      };

      const winnerByRound = groupByRound(winnerMatches);
      const loserByRound = groupByRound(loserMatches);
      const phaseIsDE = Object.keys(loserByRound).length > 0;

      // Winner bracket rounds (from Grand Finals to Round 1)
      const winnerRounds = Object.keys(winnerByRound).map(r => parseInt(r)).sort((a, b) => b - a);
      const totalWinnerRounds = winnerRounds.length;

      const phaseIsStandings = isStandingsPhase(tournament, phaseName);

      winnerRounds.forEach((round, index) => {
        const roundName = phaseIsStandings
          ? `${i18n.t('tournamentDetail.roundNumber') || 'Tour'} ${round}`
          : getRoundNameForBracket(round, 'winner', totalWinnerRounds, totalWinnerRounds - index - 1, phaseIsDE);
        const roundHeader = document.createElement('h4');
        roundHeader.style.cssText = 'font-size: 1.1rem; font-weight: bold; margin-top: 1.25rem; margin-bottom: 0.75rem;';
        roundHeader.textContent = roundName;
        roundHeader.classList.add('text-gold');
        container.appendChild(roundHeader);

        winnerByRound[round]
          .slice()
          .sort((a, b) => getMatchTime(b) - getMatchTime(a))
          .forEach(m => container.appendChild(createMatchCard(m, races)));
      });

      // Loser bracket rounds
      if (phaseIsDE) {
        const loserRounds = Object.keys(loserByRound).map(r => parseInt(r)).sort((a, b) => a - b);
        const totalLoserRounds = loserRounds.length;

        loserRounds.forEach((round, index) => {
          const roundName = getRoundNameForBracket(round, 'loser', totalLoserRounds, totalLoserRounds - index - 1, true);
          const roundHeader = document.createElement('h4');
          roundHeader.style.cssText = 'font-size: 1.1rem; font-weight: bold; margin-top: 1.25rem; margin-bottom: 0.75rem; color: #a78bfa;';
          roundHeader.textContent = roundName;
          container.appendChild(roundHeader);

          loserByRound[round]
            .slice()
            .sort((a, b) => getMatchTime(b) - getMatchTime(a))
            .forEach(m => container.appendChild(createMatchCard(m, races)));
        });
      }
    });

    return;
  }

  // Special rendering for "Groups (4 → 2) then Single Elimination"
  if (isGroupsThenFinalSE) {
    // Finals first
    const finalsHeader = document.createElement('h3');
    finalsHeader.style.cssText = 'font-size: 1.25rem; font-weight: bold; margin-top: 0.5rem; margin-bottom: 1rem;';
    finalsHeader.textContent = i18n.t('tournamentDetail.finalStage') || 'Finals — Single Elimination';
    finalsHeader.classList.add('text-gold');
    container.appendChild(finalsHeader);

    // Group final stage matches by round and show titles (Finale, Demi-finales, ...)
    const winnerMatches = finalStageMatches.filter(m => (m.round || 0) > 0);
    const byRound = {};
    winnerMatches.forEach(m => {
      const r = m.round || 0;
      if (!byRound[r]) byRound[r] = [];
      byRound[r].push(m);
    });
    const rounds = Object.keys(byRound).map(r => parseInt(r)).sort((a, b) => b - a);
    const totalRounds = rounds.length;

    rounds.forEach((round, idx) => {
      const roundTitle = document.createElement('h3');
      roundTitle.style.cssText = 'font-size: 1.1rem; font-weight: bold; margin-top: 1.25rem; margin-bottom: 0.75rem;';
      roundTitle.textContent = getRoundNameForBracket(round, 'winner', totalRounds, totalRounds - idx - 1, false);
      roundTitle.classList.add('text-gold');
      container.appendChild(roundTitle);

      byRound[round]
        .slice()
        .sort((a, b) => {
          const ta = getMatchTime(a);
          const tb = getMatchTime(b);
          if (tb !== ta) return tb - ta;
          return (b.challongeId || 0) - (a.challongeId || 0);
        })
        .forEach(m => container.appendChild(createMatchCard(m, races)));
    });

    // Groups after finals
    const gsHeader = document.createElement('h3');
    gsHeader.style.cssText = 'font-size: 1.25rem; font-weight: bold; margin-top: 2rem; margin-bottom: 1rem;';
    gsHeader.textContent = 'Group Stage';
    gsHeader.classList.add('text-gold');
    container.appendChild(gsHeader);

    const groupIds = Array.from(new Set(groupStageMatches.map(m => m.groupId)))
      .filter(v => v !== null && v !== undefined)
      .sort((a, b) => (a - b));

    groupIds.forEach((gid, idx) => {
      const groupTitle = document.createElement('h4');
      groupTitle.style.cssText = 'font-size: 1rem; font-weight: bold; margin-top: 1rem; margin-bottom: 0.75rem; color: #9ca3af;';
      const letter = String.fromCharCode('A'.charCodeAt(0) + (idx % 26));
      groupTitle.textContent = `${i18n.t('tournamentDetail.group') || 'Group'} ${letter}`;
      container.appendChild(groupTitle);

      groupStageMatches
        .filter(m => m.groupId === gid)
        .slice()
        .sort((a, b) => {
          const ta = getMatchTime(a);
          const tb = getMatchTime(b);
          if (tb !== ta) return tb - ta;
          return (b.challongeId || 0) - (a.challongeId || 0);
        })
        .forEach(m => container.appendChild(createMatchCard(m, races)));
    });

    return;
  }

  if (hasGroupsThenFinal && isGroupsThenFinalSE) {
    // For this format: finals first, newest -> oldest
    const finalsHeader = document.createElement('h3');
    finalsHeader.style.cssText = 'font-size: 1.25rem; font-weight: bold; margin-top: 0.5rem; margin-bottom: 1rem;';
    finalsHeader.textContent = i18n.t('tournamentDetail.finalStage') || 'Finals — Single Elimination';
    finalsHeader.classList.add('text-gold');
    container.appendChild(finalsHeader);

    finalStageMatches
      .slice()
      .sort((a, b) => {
        const ta = getMatchTime(a);
        const tb = getMatchTime(b);
        if (tb !== ta) return tb - ta;
        return (b.challongeId || 0) - (a.challongeId || 0);
      })
      .forEach(m => container.appendChild(createMatchCard(m, races)));

    // Groups after finals
    const gsHeader = document.createElement('h3');
    gsHeader.style.cssText = 'font-size: 1.25rem; font-weight: bold; margin-top: 2rem; margin-bottom: 1rem;';
    gsHeader.textContent = i18n.t('tournamentDetail.groupStage') || 'Group Stage';
    gsHeader.classList.add('text-gold');
    container.appendChild(gsHeader);

    const groupIds = Array.from(new Set(groupStageMatches.map(m => m.groupId)))
      .filter(v => v !== null && v !== undefined)
      .sort((a, b) => (a - b));

    groupIds.forEach((gid, idx) => {
      const groupTitle = document.createElement('h4');
      groupTitle.style.cssText = 'font-size: 1rem; font-weight: bold; margin-top: 1rem; margin-bottom: 0.75rem; color: #9ca3af;';
      const letter = String.fromCharCode('A'.charCodeAt(0) + (idx % 26));
      groupTitle.textContent = `${i18n.t('tournamentDetail.group') || 'Group'} ${letter}`;
      container.appendChild(groupTitle);

      groupStageMatches
        .filter(m => m.groupId === gid)
        .slice()
        .sort((a, b) => {
          const ta = getMatchTime(a);
          const tb = getMatchTime(b);
          if (tb !== ta) return tb - ta;
          return (b.challongeId || 0) - (a.challongeId || 0);
        })
        .forEach(m => container.appendChild(createMatchCard(m, races)));
    });

    return;
  }

  if (hasGroupsThenFinal) {
    // Group stage section
    const gsHeader = document.createElement('h3');
    gsHeader.style.cssText = 'font-size: 1.25rem; font-weight: bold; margin-top: 0.5rem; margin-bottom: 1rem;';
    gsHeader.textContent = i18n.t('tournamentDetail.groupStage') || 'Group Stage';
    gsHeader.classList.add('text-gold');
    container.appendChild(gsHeader);

    const groupIds = Array.from(new Set(groupStageMatches.map(m => m.groupId)))
      .filter(v => v !== null && v !== undefined)
      .sort((a, b) => (a - b));

    groupIds.forEach((gid, idx) => {
      const groupTitle = document.createElement('h4');
      groupTitle.style.cssText = 'font-size: 1rem; font-weight: bold; margin-top: 1rem; margin-bottom: 0.75rem; color: #9ca3af;';
      const letter = String.fromCharCode('A'.charCodeAt(0) + (idx % 26));
      groupTitle.textContent = `${i18n.t('tournamentDetail.group') || 'Group'} ${letter}`;
      container.appendChild(groupTitle);

      const groupMatches = groupStageMatches
        .filter(m => m.groupId === gid)
        .slice()
        .sort((a, b) => (a.challongeId || 0) - (b.challongeId || 0));

      groupMatches.forEach(match => {
        const matchCard = createMatchCard(match, races);
        container.appendChild(matchCard);
      });
    });

    // Final stage section
    const finalsHeader = document.createElement('h3');
    finalsHeader.style.cssText = 'font-size: 1.25rem; font-weight: bold; margin-top: 2rem; margin-bottom: 1rem;';
    finalsHeader.textContent = i18n.t('tournamentDetail.finalStage') || 'Finals — Single Elimination';
    finalsHeader.classList.add('text-gold');
    container.appendChild(finalsHeader);

    // Continue rendering final stage matches with the existing bracket logic below
    matches = finalStageMatches;
  }

  // Separate winner and loser bracket matches
  const winnerMatches = (matches || []).filter(m => m && m.round > 0);
  const loserMatches = (matches || []).filter(m => m && m.round < 0);

  // Group by round
  const groupByRound = (matchList) => {
    const byRound = {};
    matchList.forEach(match => {
      const round = match.round || 0;
      if (!byRound[round]) byRound[round] = [];
      byRound[round].push(match);
    });
    return byRound;
  };

  const winnerByRound = groupByRound(winnerMatches);
  const loserByRound = groupByRound(loserMatches);

  const isDoubleElimination = Object.keys(loserByRound).length > 0;

  // Display winner bracket (from Grand Finals to Round 1)
  const winnerRounds = Object.keys(winnerByRound).map(r => parseInt(r)).sort((a, b) => b - a);
  const totalWinnerRounds = winnerRounds.length;
  
  winnerRounds.forEach((round, index) => {
    const roundName = getRoundNameForBracket(round, 'winner', totalWinnerRounds, totalWinnerRounds - index - 1, isDoubleElimination);
    
    const roundHeader = document.createElement('h3');
    roundHeader.style.cssText = 'font-size: 1.25rem; font-weight: bold; margin-top: 1.5rem; margin-bottom: 1rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
    roundHeader.textContent = roundName;
    roundHeader.title = roundName;
    roundHeader.classList.add('text-gold');
    container.appendChild(roundHeader);

    winnerByRound[round].forEach(match => {
      const matchCard = createMatchCard(match, races);
      container.appendChild(matchCard);
    });
  });

  // Display loser bracket (from LB Final to Round 1)
  const loserRounds = Object.keys(loserByRound).map(r => parseInt(r)).sort((a, b) => a - b);
  const totalLoserRounds = loserRounds.length;
  
  loserRounds.forEach((round, index) => {
    const roundName = getRoundNameForBracket(round, 'loser', totalLoserRounds, totalLoserRounds - index - 1, true);
    
    const roundHeader = document.createElement('h3');
    roundHeader.style.cssText = 'font-size: 1.25rem; font-weight: bold; margin-top: 1.5rem; margin-bottom: 1rem; color: #a78bfa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
    roundHeader.textContent = roundName;
    roundHeader.title = roundName;
    container.appendChild(roundHeader);

    loserByRound[round].forEach(match => {
      const matchCard = createMatchCard(match, races);
      container.appendChild(matchCard);
    });
  });
}

// Delegated click handler: navigate to race-detail when clicking a manche card (except Racetime links)
document.addEventListener('click', function(e) {
  try {
    const container = document.getElementById('matches-list');
    if (!container) return;
    let el = e.target;
    while (el && el !== container) {
      if (el.dataset && el.dataset.raceId) {
        // ignore clicks on internal links (racetime button)
        try {
          const a = e.target.closest && e.target.closest('a');
          if (a && a.getAttribute && a.getAttribute('href') && a.getAttribute('href').indexOf('racetime.gg') !== -1) return;
        } catch (err) {}
        const id = el.dataset.raceId;
        if (id) {
          window.location.href = '/race-detail.html?id=' + encodeURIComponent(id);
        }
        return;
      }
      el = el.parentElement;
    }
  } catch (err) { /* ignore */ }
});

function parseChallongeScores(scoresCsv, matchState = '') {
  if (!scoresCsv) return null;
  const raw = String(scoresCsv).trim();
  if (!raw) return null;

  const parsePair = (pair) => {
    const m = /^\s*(-?\d+)\s*-\s*(-?\d+)\s*$/.exec(String(pair || ''));
    if (!m) return null;
    const p1 = parseInt(m[1], 10);
    const p2 = parseInt(m[2], 10);
    if (!Number.isFinite(p1) || !Number.isFinite(p2)) return null;
    return { p1, p2 };
  };

  const parts = raw.includes(',') ? raw.split(',') : [raw];
  let games = parts.map(parsePair).filter(Boolean);
  if (!games.length) return null;

  let isMultiGame = raw.includes(',') && games.length > 1;
  const singlePair = (!raw.includes(',')) && parts.length === 1 && games.length === 1;
  // Challonge sometimes stores BO3 as a series score like "2-1" (no per-game detail).
  const isSeriesOnly = singlePair && (Math.max(games[0].p1, games[0].p2) > 1);

  // Compute series score from per-game results when multiple games are provided.
  let seriesP1 = 0;
  let seriesP2 = 0;
  for (const g of games) {
    if (g.p1 > g.p2) seriesP1 += 1;
    else if (g.p2 > g.p1) seriesP2 += 1;
  }

  // Best-of inference (best effort). For this tournament we expect BO3.
  let bestOf = null;
  if (games.length === 3) bestOf = 3;
  else if (games.length === 5) bestOf = 5;
  else {
    const maxWins = Math.max(seriesP1, seriesP2);
    if (maxWins === 2 && games.length <= 3) bestOf = 3;
    else if (maxWins === 3 && games.length <= 5) bestOf = 5;
    else if (matchState !== 'complete' && games.length <= 3) bestOf = 3;
  }

  // If the scoresCsv is a single pair, it might already be a series score.
  if (parts.length === 1 && !raw.includes(',') && games.length === 1) {
    seriesP1 = games[0].p1;
    seriesP2 = games[0].p2;
  }

  // If we only have a series score (e.g. "2-1"), synthesize per-game lines so the tooltip
  // can still show "Manche 1/2/3". The exact order of games is unknown.
  if (isSeriesOnly) {
    const maxWins = Math.max(seriesP1, seriesP2);
    if (maxWins === 2) bestOf = 3;
    else if (maxWins === 3) bestOf = 5;

    const buildSyntheticGames = (w1, w2) => {
      const out = [];
      // Handle obvious deterministic cases first
      // 2-0 or 0-2 -> all games won by same player (order irrelevant)
      if ((w1 === 2 && w2 === 0) || (w1 === 0 && w2 === 2)) {
        const winner = w1 === 2 ? 1 : 2;
        for (let i = 0; i < w1 + w2; i++) {
          if (winner === 1) out.push({ p1: 1, p2: 0, ambiguous: false });
          else out.push({ p1: 0, p2: 1, ambiguous: false });
        }
        return out;
      }

      // 2-1 or 1-2 -> the decisive (last) game winner is known (the series winner),
      // earlier games' ordering is ambiguous. We place the decisive game last and mark it unambiguous.
      if ((w1 === 2 && w2 === 1) || (w1 === 1 && w2 === 2)) {
        const winner = w1 > w2 ? 1 : 2;
        let rem1 = w1;
        let rem2 = w2;
        // consume one win for the decisive last game
        if (winner === 1) rem1 -= 1; else rem2 -= 1;
        // push the ambiguous games first (order unknown)
        while (rem1 > 0 || rem2 > 0) {
          if (rem1 > 0) { out.push({ p1: 1, p2: 0, ambiguous: true }); rem1 -= 1; }
          if (rem2 > 0) { out.push({ p1: 0, p2: 1, ambiguous: true }); rem2 -= 1; }
        }
        // push decisive game last (unambiguous)
        if (winner === 1) out.push({ p1: 1, p2: 0, ambiguous: false });
        else out.push({ p1: 0, p2: 1, ambiguous: false });
        return out;
      }

      // Fallback: alternate wins as before, mark all as ambiguous since precise order is unknown.
      let turn = (w1 >= w2) ? 1 : 2;
      while (w1 > 0 || w2 > 0) {
        if (turn === 1 && w1 > 0) { out.push({ p1: 1, p2: 0, ambiguous: true }); w1 -= 1; }
        else if (turn === 2 && w2 > 0) { out.push({ p1: 0, p2: 1, ambiguous: true }); w2 -= 1; }
        else if (w1 > 0) { out.push({ p1: 1, p2: 0, ambiguous: true }); w1 -= 1; }
        else if (w2 > 0) { out.push({ p1: 0, p2: 1, ambiguous: true }); w2 -= 1; }
        turn = (turn === 1) ? 2 : 1;
      }
      return out;
    };

    const synthetic = buildSyntheticGames(seriesP1, seriesP2);
    if (synthetic && synthetic.length) {
      games = synthetic;
      isMultiGame = games.length > 1;
    }
  }

  const played = games.length;
  const denom = bestOf || played;
  const label = bestOf ? `BO${bestOf}` : 'Series';

  return { games, seriesP1, seriesP2, played, denom, label, isMultiGame, isSeriesOnly };
}

let __matchTooltipEl = null;
function ensureMatchTooltip() {
  if (__matchTooltipEl) return __matchTooltipEl;
  const el = document.createElement('div');
  el.style.cssText = 'position: fixed; z-index: 9999; pointer-events: none; background: #111827; border: 1px solid #374151; color: #d1d5db; padding: 0.5rem 0.75rem; border-radius: 0.5rem; font-size: 0.75rem; box-shadow: 0 4px 10px rgba(0,0,0,0.35); max-width: 640px; min-width: 320px; display: none;';
  document.body.appendChild(el);
  __matchTooltipEl = el;
  return el;
}

function attachMatchTooltip(card, match, parsedScores) {
  // Only attach tooltip when there are at least 2 games to show
  if (!card || !parsedScores || !parsedScores.games || parsedScores.games.length < 2) return;

  const tooltip = ensureMatchTooltip();

  const p1 = sanitizeDisplayName(match.player1Name || (i18n.t('tournamentDetail.tbd') || 'TBD'));
  const p2 = sanitizeDisplayName(match.player2Name || (i18n.t('tournamentDetail.tbd') || 'TBD'));

  let cum1 = 0;
  let cum2 = 0;
  // Filter out the 3rd game (index 2) if it's 0-0 (Challonge bug). Preserve original manche numbering.
  const displayGames = parsedScores.games.map((g, i) => ({ g, i })).filter(item => !(item.i === 2 && item.g.p1 === 0 && item.g.p2 === 0));
  if (!displayGames.length) return;

  const lines = displayGames.map((item) => {
    const g = item.g;
    const origIdx = item.i;
    if (g.p1 > g.p2) cum1 += 1;
    else if (g.p2 > g.p1) cum2 += 1;
    const winner = g.p1 > g.p2 ? p1 : (g.p2 > g.p1 ? p2 : 'Tie');
    // Keep the cumulative score in a single monospace token: "(1-0)" with no whitespace.
    const cum = `(${cum1}-${cum2})`;
    // Use flex: left label flexible (wraps only if needed), right block fixed width to keep score columns aligned
    return `<div style="display:flex; gap:0.5rem; align-items:center;">
      <div style="flex:1; min-width:0; color:#9ca3af; overflow-wrap:anywhere; white-space:normal; word-break:break-word;">Manche ${origIdx + 1}${parsedScores && parsedScores.isSeriesOnly && g.ambiguous ? ' <span style=\"color:#6b7280; font-size:0.65rem; margin-left:0.25rem;\">(ordre non contractuel)</span>' : ''}</div>
      <div style="display:flex; gap:0.5rem; align-items:center; width:260px; flex-shrink:0;">
        <div style="width:3.5rem; font-family: monospace; color:#C2CECF; text-align:left;">${g.p1}-${g.p2}</div>
        <div style="width:3.75rem; font-family: monospace; color:#d1d5db; text-align:left;">${cum}</div>
        <div style="width:1rem; color:#9ca3af; text-align:center;">→</div>
        <div style="flex:1; min-width:0; color:#d1d5db; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(winner)}</div>
      </div>
    </div>`;
  }).join('');

  const show = (ev) => {
    tooltip.innerHTML = lines;
    tooltip.style.display = 'block';
    move(ev);
  };
  const hide = () => { tooltip.style.display = 'none'; };
  const move = (ev) => {
    if (!ev) return;
    const offset = 14;
    let x = ev.clientX + offset;
    let y = ev.clientY + offset;
    const rect = tooltip.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (x + rect.width + 8 > vw) x = Math.max(8, ev.clientX - rect.width - offset);
    if (y + rect.height + 8 > vh) y = Math.max(8, ev.clientY - rect.height - offset);
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
  };

  card.addEventListener('mouseenter', show);
  card.addEventListener('mousemove', move);
  card.addEventListener('mouseleave', hide);
}

// Find all races linked to a match (by matchId, startggSetId, raceUrls, or raceUrl)
function findRacesForMatch(match, races) {
  if (!races || races.length === 0) return [];
  
  const matchId = match._id || match.id || null;
  const normalizeUrl = u => (u || '').toString().replace(/^\/+/, '').toLowerCase();
  
  // First, find races by startggSetId (start.gg tournaments, supports BO3)
  if (match.startggSetId) {
    const setId = String(match.startggSetId);
    const bySetId = races.filter(r => r.startggSetId && String(r.startggSetId) === setId);
    if (bySetId.length > 0) {
      // If raceUrls order is available, use it (admin-set manche order)
      if (match.raceUrls && match.raceUrls.length > 0) {
        const targets = match.raceUrls.map(u => normalizeUrl(u));
        const ordered = [];
        for (const t of targets) {
          const found = bySetId.find(r => {
            const ru = normalizeUrl(r.url);
            return ru === t || ru.endsWith(t) || t.endsWith(ru);
          });
          if (found) ordered.push(found);
        }
        // Append any races found by setId but not in raceUrls (shouldn't happen, but defensive)
        for (const r of bySetId) {
          if (!ordered.includes(r)) ordered.push(r);
        }
        if (ordered.length > 0) return ordered;
      }
      bySetId.sort((a, b) => {
        const dateA = a.startedAt ? new Date(a.startedAt).getTime() : 0;
        const dateB = b.startedAt ? new Date(b.startedAt).getTime() : 0;
        return dateA - dateB;
      });
      return bySetId;
    }
  }

  // Then, find races by matchId (Challonge matches)
  let matchedRaces = races.filter(r => {
    if (r.matchId && matchId) {
      return String(r.matchId) === String(matchId);
    }
    return false;
  });
  
  // If no races found, try raceUrls array (BO3 support for start.gg)
  if (matchedRaces.length === 0 && match.raceUrls && match.raceUrls.length > 0) {
    const targets = match.raceUrls.map(u => normalizeUrl(u));
    // Preserve raceUrls order (admin-set manche order)
    const ordered = [];
    for (const t of targets) {
      const found = races.find(r => {
        const ru = normalizeUrl(r.url);
        return ru === t || ru.endsWith(t) || t.endsWith(ru);
      });
      if (found) ordered.push(found);
    }
    if (ordered.length > 0) return ordered;
    // Fallback: unordered match
    matchedRaces = races.filter(r => {
      const ru = normalizeUrl(r.url);
      return targets.some(t => ru === t || ru.endsWith(t) || t.endsWith(ru));
    });
  }

  // Fallback: single raceUrl
  if (matchedRaces.length === 0 && match.raceUrl) {
    const target = normalizeUrl(match.raceUrl);
    const slug = target.split('/').filter(Boolean).pop();
    
    matchedRaces = races.filter(r => {
      const ru = normalizeUrl(r.url);
      return ru === target || ru.endsWith(target) || target.endsWith(ru) || ru.endsWith(slug);
    });
  }
  
  // Sort races by startedAt to get correct order
  matchedRaces.sort((a, b) => {
    const dateA = a.startedAt ? new Date(a.startedAt).getTime() : 0;
    const dateB = b.startedAt ? new Date(b.startedAt).getTime() : 0;
    return dateA - dateB;
  });
  
  return matchedRaces;
}

function createMatchCard(match, races = []) {
  const card = document.createElement('div');
  // Assign stable id so we can scroll to the match from participants
  try { card.id = 'match-' + (match.challongeId || match.id || match._id || match.matchId || ''); } catch (e) {}
  card.style.cssText = 'background-color: #1f2937; padding: 1rem; border-radius: 0.5rem; margin-bottom: 0.75rem;';
  
  const stateColor = match.state === 'complete' ? '#10b981' 
                   : match.state === 'open' ? '#3b82f6'
                   : '#6b7280';
  
  const stateBadge = `<span style="background-color: ${stateColor}; color: white; padding: 0.25rem 0.5rem; border-radius: 0.25rem; font-size: 0.75rem;">${formatMatchState(match.state)}</span>`;

  // Find all races linked to this match
  const matchRaces = findRacesForMatch(match, races);
  const isMultiRaceSeries = matchRaces.length > 1;

  // For group stage matches, scoresCsv often contains race times (e.g., "0-32717") instead of match scores.
  // Detect this and compute real match score from winnerId.
  let displayScore1 = null;
  let displayScore2 = null;
  
  // Handle Start.gg displayScore format: "PlayerA W - PlayerB L"
  if (match.displayScore && typeof match.displayScore === 'string' && !match.scoresCsv) {
    const parts = match.displayScore.split(' - ');
    if (parts.length === 2) {
      const p1Part = parts[0].trim(); // "PlayerA W"
      const p2Part = parts[1].trim(); // "PlayerB L"
      
      if (p1Part.endsWith(' W')) {
        displayScore1 = 1;
        displayScore2 = 0;
      } else if (p2Part.endsWith(' W')) {
        displayScore1 = 0;
        displayScore2 = 1;
      }
    }
  }
  // Handle Challonge scoresCsv
  else if (match.scoresCsv) {
    const raw = String(match.scoresCsv).trim();
    const parts = raw.split('-');
    
    // Check if scores look like times (large numbers > 1000) or game scores
    if (parts.length === 2) {
      const val1 = parseInt(parts[0], 10);
      const val2 = parseInt(parts[1], 10);
      
      // If either value is > 1000, assume these are race times, not match scores
      if (Number.isFinite(val1) && Number.isFinite(val2) && (val1 > 1000 || val2 > 1000)) {
        // Calculate match score from winnerId
        if (match.winnerId === match.player1Id) {
          displayScore1 = 1;
          displayScore2 = 0;
        } else if (match.winnerId === match.player2Id) {
          displayScore1 = 0;
          displayScore2 = 1;
        } else {
          displayScore1 = 0;
          displayScore2 = 0;
        }
      } else {
        const parsedScores = parseChallongeScores(match.scoresCsv, match.state);
        displayScore1 = parsedScores ? parsedScores.seriesP1 : val1;
        displayScore2 = parsedScores ? parsedScores.seriesP2 : val2;
      }
    } else if (raw.includes(',')) {
      const parsedScores = parseChallongeScores(match.scoresCsv, match.state);
      displayScore1 = parsedScores ? parsedScores.seriesP1 : null;
      displayScore2 = parsedScores ? parsedScores.seriesP2 : null;
    }
  }
  
  const player1Winner = match.winnerId === match.player1Id;
  const player2Winner = match.winnerId === match.player2Id;

  // Helper to get race link HTML
  const getRaceLinkHtml = (race) => {
    if (!race || !race.url) return '';
    const rawUrl = (race.url || '').toString().trim();
    let path = rawUrl;
    if (/^https?:\/\//i.test(path)) {
      try {
        path = new URL(path).pathname || '';
      } catch (e) {
        path = path.replace(/^https?:\/\/(www\.)?racetime\.gg/i, '');
      }
    } else if (/racetime\.gg/i.test(path)) {
      path = path.replace(/^https?:\/\/(www\.)?racetime\.gg/i, '');
    }
    path = '/' + String(path || '').replace(/^\/+/, '');
    const parts = path.split('/').filter(Boolean);
    if (parts.length >= 3 && parts[0] === parts[1]) parts.splice(1, 1);
    const href = 'https://racetime.gg/' + parts.join('/');
    return `<a href="${href}" target="_blank" rel="noopener noreferrer" data-stop-propagation style="display:inline-flex; align-items:center; gap:0.35rem; padding:0.2rem 0.4rem; border-radius:0.25rem; font-size:0.7rem; color:#C2CECF; background:#222222; border:1px solid #C2CECF; text-decoration:none;"><img src="assets/racetime.svg" alt="Racetime" style="width:14px;height:14px;">Racetime</a>`;
  };

  // Helper to extract times from a race for this match
  const getTimesFromRace = (race) => {
    let t1 = null, t2 = null;
    if (!race) return { time1: t1, time2: t2 };
    
    // Prefer a pairwise mapping so the two players cannot resolve to the same entrant.
    try {
      const mapped = computeTimesFromRace(match, race);
      if (mapped) {
        if (mapped.time1 !== null && mapped.time1 !== undefined) t1 = mapped.time1;
        if (mapped.time2 !== null && mapped.time2 !== undefined) t2 = mapped.time2;
      }
    } catch (e) {}

    // Fallback to per-name lookup for any still-missing side.
    if (t1 === null || t1 === undefined) t1 = findEntrantTime(race, match.player1Name);
    if (t2 === null || t2 === undefined) t2 = findEntrantTime(race, match.player2Name);

    // Sanity check: if both times are identical and non-null, matching likely failed.
    if (t1 && t2 && t1 === t2 && t1 !== 'DNF' && t1 !== 'DQ') {
      t1 = null;
      t2 = null;
    }
    
    // Fallback to place-based mapping
    if ((t1 === null || t1 === undefined) && (t2 === null || t2 === undefined)) {
      try {
        const entrants = race.entrants || [];
        const winnerEntr = entrants.find(e => e && (e.place === 1 || e.place === '1'));
        const loserEntr = entrants.find(e => e !== winnerEntr);
        if (winnerEntr) {
          const wt = getTimeFromEntrantObj(winnerEntr, race);
          const lt = loserEntr ? getTimeFromEntrantObj(loserEntr, race) : null;
          const winnerName = normalizeName(winnerEntr.userName || (winnerEntr.user && winnerEntr.user.name) || winnerEntr.name || winnerEntr.displayName || '');
          const loserName = normalizeName((loserEntr && (loserEntr.userName || (loserEntr.user && loserEntr.user.name) || loserEntr.name || loserEntr.displayName)) || '');
          const matchP1 = normalizeName(match.player1Name || '');
          const matchP2 = normalizeName(match.player2Name || '');

          // Prefer mapping winner/loser by actual entrant names when available.
          if (winnerName && loserName) {
            if (winnerName === matchP1 && loserName === matchP2) {
              t1 = t1 || wt;
              t2 = t2 || lt;
            } else if (winnerName === matchP2 && loserName === matchP1) {
              t2 = t2 || wt;
              t1 = t1 || lt;
            }
          } else if (!isMultiRaceSeries) {
            // Only use overall set winner as a last resort for single-race matches.
            if (player1Winner) {
              t1 = t1 || wt;
              t2 = t2 || lt;
            } else if (player2Winner) {
              t2 = t2 || wt;
              t1 = t1 || lt;
            }
          }
        }
      } catch (e) {}
    }
    
    return { time1: t1, time2: t2 };
  };

  // Generate manches HTML if multi-race series
  let manchesHtml = '';
  if (isMultiRaceSeries) {
    manchesHtml = '<div style="margin-top: 0.75rem; border-top: 1px solid #374151; padding-top: 0.75rem;">';
    manchesHtml += '<div style="font-size: 0.75rem; color: #6b7280; margin-bottom: 0.5rem;">Détail des manches :</div>';
    
    matchRaces.forEach((race, idx) => {
      const raceLink = getRaceLinkHtml(race);
      const raceDetailUrl = race && race._id ? '/race-detail.html?id=' + encodeURIComponent(race._id) : '#';
      const times = getTimesFromRace(race);
      
      // Determine manche winner from race
      let mancheWinner = null;
      try {
        const entrants = race.entrants || [];
        const winnerEntr = entrants.find(e => e && (e.place === 1 || e.place === '1'));
        if (winnerEntr) {
          const winnerName = winnerEntr.userName || (winnerEntr.user && winnerEntr.user.name) || '';
          const norm = s => (s || '').toLowerCase().trim();
          if (norm(winnerName) === norm(match.player1Name) || norm(winnerName).includes(norm(match.player1Name)) || norm(match.player1Name).includes(norm(winnerName))) {
            mancheWinner = 1;
          } else if (norm(winnerName) === norm(match.player2Name) || norm(winnerName).includes(norm(match.player2Name)) || norm(match.player2Name).includes(norm(winnerName))) {
            mancheWinner = 2;
          }
        }
      } catch (e) {}
      
      manchesHtml += `
        <div role="link" tabindex="0" data-race-id="${race && race._id ? race._id : ''}" style="cursor:pointer;text-decoration:none;color:inherit;display:block;">
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.4rem 0.5rem; background: #111827; border-radius: 0.25rem; margin-bottom: 0.35rem; font-size: 0.8rem;">
            <span style="color: #9ca3af; font-weight: 500;">Manche ${idx + 1}</span>
            <div class="spoiler-block" style="display: flex; align-items: center; gap: 1rem;">
              <span class="${mancheWinner === 1 ? 'spoiler-winner' : ''}" style="color: ${mancheWinner === 1 ? '#fbbf24' : '#d1d5db'}; min-width: 80px;">${escHtml(sanitizeDisplayName(match.player1Name) || 'P1')}: <span style="color: #10b981; font-family: monospace;">${times.time1 || '-'}</span></span>
              <span class="${mancheWinner === 2 ? 'spoiler-winner' : ''}" style="color: ${mancheWinner === 2 ? '#fbbf24' : '#d1d5db'}; min-width: 80px;">${escHtml(sanitizeDisplayName(match.player2Name) || 'P2')}: <span style="color: #10b981; font-family: monospace;">${times.time2 || '-'}</span></span>
              ${raceLink}
            </div>
          </div>
        </div>
      `;
    });
    
    manchesHtml += '</div>';
  }

  // For single race, get times and race link
  let singleRaceLinkHtml = '';
  let time1 = null;
  let time2 = null;
  
  if (!isMultiRaceSeries && matchRaces.length === 1) {
    const race = matchRaces[0];
    singleRaceLinkHtml = getRaceLinkHtml(race);
    const times = getTimesFromRace(race);
    time1 = times.time1;
    time2 = times.time2;
  } else if (!isMultiRaceSeries && match.raceUrl) {
    // Fallback to old behavior for backwards compat
    const normalizeUrl = u => (u || '').toString().replace(/^\/+/, '').toLowerCase();
    const target = normalizeUrl(match.raceUrl);
    const race = races.find(r => {
      const ru = normalizeUrl(r.url);
      return ru === target || ru.endsWith(target) || target.endsWith(ru);
    });
    if (race) {
      singleRaceLinkHtml = getRaceLinkHtml(race);
      const times = getTimesFromRace(race);
      time1 = times.time1;
      time2 = times.time2;
    }
  }

  card.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem;">
      <div style="font-size: 0.875rem; color: #9ca3af;">
        ${match.completedAt ? formatDateTime(match.completedAt) : match.startedAt ? formatDateTime(match.startedAt) : 'Not scheduled'}${match.groupId !== null && match.groupId !== undefined && match.round ? ` • Round ${match.round}` : ''}
      </div>
      <div style="display: flex; align-items: center; gap: 0.5rem;">
        ${!isMultiRaceSeries ? singleRaceLinkHtml : ''}
        ${stateBadge}
      </div>
    </div>
    <div style="display: flex; justify-content: space-between; align-items: center;">
      <div style="flex: 1;">
        <div style="display: flex; align-items: center; margin-bottom: 0.5rem;">
          ${match.player1Name ? `<a href="/player-detail.html?name=${encodeURIComponent(sanitizeDisplayName(match.player1Name))}" class="match-player-name ${player1Winner ? 'match-winner spoiler-winner' : ''}" style="font-weight: ${player1Winner ? 'bold' : 'normal'}; color: ${player1Winner ? '#fbbf24' : 'white'}; flex: 1; text-decoration: none;">${escHtml(sanitizeDisplayName(match.player1Name))}</a>` : (i18n.t('tournamentDetail.tbd') || 'TBD')}
          ${displayScore1 !== null && displayScore2 !== null ? `
            <span class="spoiler-block" style="color: #9ca3af; margin-left: 8rem; display:flex; align-items:center; gap:4rem;">
              ${!isMultiRaceSeries ? `<span>${time1 !== null && time1 !== undefined ? time1 : '-'}</span>` : ''}
              <span style="display:inline-block; min-width:2rem; text-align:center; font-family:monospace;">${displayScore1}</span>
            </span>
          ` : ''}
        </div>
        <div style="display: flex; align-items: center;">
          ${match.player2Name ? `<a href="/player-detail.html?name=${encodeURIComponent(sanitizeDisplayName(match.player2Name))}" class="match-player-name ${player2Winner ? 'match-winner spoiler-winner' : ''}" style="font-weight: ${player2Winner ? 'bold' : 'normal'}; color: ${player2Winner ? '#fbbf24' : 'white'}; flex: 1; text-decoration: none;">${escHtml(sanitizeDisplayName(match.player2Name))}</a>` : (i18n.t('tournamentDetail.tbd') || 'TBD')}
          ${displayScore2 !== null && displayScore1 !== null ? `
            <span class="spoiler-block" style="color: #9ca3af; margin-left: 8rem; display:flex; align-items:center; gap:4rem;">
              ${!isMultiRaceSeries ? `<span>${time2 !== null && time2 !== undefined ? time2 : '-'}</span>` : ''}
              <span style="display:inline-block; min-width:2rem; text-align:center; font-family:monospace;">${displayScore2}</span>
            </span>
          ` : ''}
        </div>
      </div>
    </div>
    ${manchesHtml}
  `;
  
  return card;
}

// Navigate to a match card by its challongeId/id: switch to matches tab and scroll.
function goToMatchById(id) {
  // Always switch to matches tab (prefer clicking the tab button so handlers run)
  try {
    const tabBtn = document.querySelector('.tab-btn[data-tab="matches"]');
    if (tabBtn) tabBtn.click();
    else switchTab('matches');
  } catch (e) {}

  if (!id) return;
  const elId = 'match-' + id;

  // Small delay to allow the matches tab to become visible, then lookup/scroll.
  const doLookup = () => {
    // Prefer the element inside the matches list so we don't highlight the bracket copy
    const matchesContainer = document.getElementById('matches-list');
    const escapeId = (s) => {
      try {
        if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
      } catch (e) {}
      return s.replace(/([ #;?%&,.+*~\':"!^$\[\]()=>|\/\\])/g, '\\$1');
    };
    let el = null;
    try {
      const esc = escapeId(elId);
      if (matchesContainer) el = matchesContainer.querySelector('#' + esc);
    } catch (e) { el = null; }

    // fallback to global lookup if not found inside matches container
    if (!el) el = document.getElementById(elId);

    if (el) {
      el.scrollIntoView({behavior: 'smooth', block: 'center'});
      el.style.outline = '3px solid #fbbf24';
      setTimeout(() => { el.style.outline = ''; }, 1800);
      return;
    }

    // If element not yet present (matches may load later), poll briefly inside matches container first
    let attempts = 0;
    const iv = setInterval(() => {
      attempts += 1;
      try {
        const esc = escapeId(elId);
        if (matchesContainer) el = matchesContainer.querySelector('#' + esc);
      } catch (e) { el = null; }
      if (!el) el = document.getElementById(elId);
      if (el) {
        clearInterval(iv);
        el.scrollIntoView({behavior: 'smooth', block: 'center'});
        el.style.outline = '3px solid #fbbf24';
        setTimeout(() => { el.style.outline = ''; }, 1800);
      } else if (attempts > 15) {
        clearInterval(iv);
      }
    }, 200);
  };

  setTimeout(doLookup, 120);
}

// Helpers to map race entrant times to match players
function rTrim(s, ch) { if (!s) return s; while (s.endsWith(ch)) s = s.slice(0, -1); return s; }

function normalizeName(s){
  if (!s) return '';
  try {
    return s.toString().normalize('NFKD').replace(/\p{Diacritic}/gu,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  } catch (e) {
    return s.toString().toLowerCase();
  }
}

function findEntrantTime(race, playerName){
  if (!race || !race.entrants || !playerName) return null;
  const targetRaw = playerName;
  const target = normalizeName(targetRaw);
  const targetTokens = target.split(' ').filter(Boolean);

  let best = {score: 0, entrant: null};
  const matchCompletedAt = race.endedAt || race.startedAt || null;

  for (const ent of race.entrants) {
    // Entrant name can be nested under different keys depending on source
    const rawName = (ent.user && (ent.user.name || ent.user.id)) || ent.name || ent.displayName || '';
    const uname = normalizeName(rawName);
    if (!uname) continue;
    const entrantTokens = uname.split(' ').filter(Boolean);

    let score = 0;

    // Exact full-string match (highest confidence)
    if (uname === target) score += 300;

    // Exact token match: any token equal to target (good confidence)
    if (entrantTokens.includes(target)) score += 200;

    // All target tokens present in entrant tokens (e.g., 'xavi cola')
    const allTokensPresent = targetTokens.length > 0 && targetTokens.every(t => entrantTokens.includes(t));
    if (allTokensPresent) score += 180;

    // Whole-word containment: check word boundaries for target inside entrant
    try {
      const re = new RegExp('\\b' + escapeRegExp(target) + '\\b');
      if (re.test(uname)) score += 160;
    } catch (e) {}

    // Prefix/suffix handling: treat short nickname prefixes as good matches (e.g. 'ico' vs 'icola')
    try {
      const utoks = uname.split(' ').filter(Boolean);
      const ttoks = target.split(' ').filter(Boolean);
      outer: for (const u of utoks) {
        for (const t of ttoks) {
          if (u.startsWith(t) || t.startsWith(u)) {
            const diff = Math.abs(u.length - t.length);
            if (diff <= 3) { score += 220; break outer; }
          }
        }
      }
    } catch (e) {}

    // Time proximity bonus if timestamps exist
    if (matchCompletedAt && ent.finishedAt) {
      try {
        const m1 = new Date(matchCompletedAt).getTime();
        const m2 = new Date(ent.finishedAt).getTime();
        if (!isNaN(m1) && !isNaN(m2)) {
          const diff = Math.abs(m1 - m2) / 1000; // seconds
          if (diff <= 10) score += 120;
          else if (diff <= 60) score += 80;
          else if (diff <= 600) score += 40;
        }
      } catch (e) {}
    }

    // Levenshtein similarity as fallback (normalized)
    const lev = levenshtein(uname, target);
    const maxLen = Math.max(uname.length, target.length) || 1;
    const similarity = 1 - (lev / maxLen);
    if (similarity > 0.85) score += 140;
    else if (similarity > 0.7) score += 80;

    // Penalize short accidental matches (avoid 'cola' matching 'icola')
    if (target.length < 4 && uname.includes(target) && !entrantTokens.includes(target)) {
      score -= 50;
    }

    if (score > best.score) {
      best = {score, entrant: ent};
    }
  }

  // Accept only sufficiently confident matches
  if (best.entrant && best.score >= 150) {
    if (best.entrant.finishTimeMs) return formatMs(best.entrant.finishTimeMs);
    if (best.entrant.finishTime) return prettifyDurationString(best.entrant.finishTime);
    // Entrant matched but no finish time available -> consider DNF
    return 'DNF';
  }
  return null;
}

function escapeRegExp(str){ return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function escapeHtml(str){
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function levenshtein(a, b){
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({length: m+1}, () => new Array(n+1));
  for (let i=0;i<=m;i++) dp[i][0]=i;
  for (let j=0;j<=n;j++) dp[0][j]=j;
  for (let i=1;i<=m;i++){
    for (let j=1;j<=n;j++){
      const cost = a[i-1] === b[j-1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost);
    }
  }
  return dp[m][n];
}

function formatMs(ms){
  if (ms == null) return null;
  const total = Math.round(Number(ms)/1000);
  if (isNaN(total)) return null; // Return null if conversion failed
  const h = Math.floor(total/3600); const m = Math.floor((total%3600)/60); const s = total%60;
  if (h>0) return `${h}:${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
  return `${m}:${s.toString().padStart(2,'0')}`;
}

function prettifyDurationString(str){
  if (!str) return null;
  // Robust parser for ISO8601-like durations such as "PT2H38M59.697785S" or "P0DT02H38M59.697785S"
  try {
    const re = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/;
    const m = re.exec(str);
    if (!m) return str;
    const h = parseInt(m[2] || 0, 10);
    const mm = parseInt(m[3] || 0, 10);
    const ss = Math.floor(parseFloat(m[4] || 0));
    if (h > 0) return `${h}:${mm.toString().padStart(2,'0')}:${ss.toString().padStart(2,'0')}`;
    return `${mm}:${ss.toString().padStart(2,'0')}`;
  } catch (e) {
    return str;
  }
}

function formatTime(value) {
  if (!value && value !== 0) return null;
  // If it's a number, treat as milliseconds
  if (typeof value === 'number') return formatMs(value);
  // If it's a string starting with P (ISO duration), parse it
  if (typeof value === 'string' && value.startsWith('P')) return prettifyDurationString(value);
  // Otherwise try to parse as number
  const num = Number(value);
  if (!isNaN(num)) return formatMs(num);
  return null;
}

function switchTab(tabName) {
  // Hide all tabs
  document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.style.color = '#9ca3af';
    btn.style.borderBottomColor = 'transparent';
    btn.classList.remove('active');
  });

  // Show selected tab
  document.getElementById(`tab-content-${tabName}`).style.display = 'block';
  const activeBtn = document.getElementById(`tab-${tabName}`);
  activeBtn.style.color = '#fbbf24';
  activeBtn.style.borderBottomColor = '#fbbf24';
  activeBtn.classList.add('active');
}

function getTournamentStatus(tournament) {
  const today = new Date();

  const parseDate = (value) => {
    if (!value) return null;
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  };

  const startDate = parseDate(tournament && tournament.startDate);
  const endDate = parseDate(tournament && tournament.endDate);

  // If status is explicitly complete or awaiting_review, it's finished
  if (tournament && (tournament.status === 'complete' || tournament.status === 'awaiting_review')) return 'terminé';

  // Règle métier: on considère un tournoi terminé au bout d'1 an.
  const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
  if (startDate && (today.getTime() - startDate.getTime()) >= YEAR_MS) return 'terminé';
  
  // If explicit end date and we're past it
  if (endDate && today > endDate) return 'terminé';

  if (startDate && today < startDate) return 'à venir';
  if (startDate && endDate && today >= startDate && today <= endDate) return 'en cours';
  if (startDate && !endDate && today >= startDate) return 'en cours';
  return 'terminé';
}

function formatDate(dateString) {
  if (!dateString) return 'Undefined';
  const date = new Date(dateString);
  let locale = 'en-US';
  if (typeof i18n !== 'undefined' && typeof i18n.getLanguage === 'function') {
    const lang = i18n.getLanguage();
    const localeMap = { 'en': 'en-US', 'fr': 'fr-FR', 'de': 'de-DE', 'es': 'es-ES', 'it': 'it-IT' };
    locale = localeMap[lang] || 'en-US';
  }
  const options = { year: 'numeric', month: 'long', day: 'numeric' };
  return date.toLocaleDateString(locale, options);
}

function formatDateTime(dateString) {
  if (!dateString) return 'Undefined';
  const date = new Date(dateString);
  if (isNaN(date.getTime())) return 'Undefined';
  let locale = 'en-US';
  if (typeof i18n !== 'undefined' && typeof i18n.getLanguage === 'function') {
    const lang = i18n.getLanguage();
    const localeMap = { 'en': 'en-US', 'fr': 'fr-FR', 'de': 'de-DE', 'es': 'es-ES', 'it': 'it-IT' };
    locale = localeMap[lang] || 'en-US';
  }
  return date.toLocaleString(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatTournamentType(type) {
  if (typeof i18n !== 'undefined') {
    const typeKey = type ? type.toLowerCase().replace(/[\s_]+/g, '') : '';
    const typeMap = {
      'singleelimination': 'tournamentTypes.singleElimination',
      'doubleelimination': 'tournamentTypes.doubleElimination',
      'roundrobin': 'tournamentTypes.roundRobin',
      'swiss': 'tournamentTypes.swiss',
      'exhibition': 'tournamentTypes.exhibition',
      'customschedule': 'tournamentTypes.customSchedule'
    };
    if (typeMap[typeKey]) {
      return i18n.t(typeMap[typeKey]);
    }
  }
  const types = {
    'single_elimination': 'Single Elimination',
    'double_elimination': 'Double Elimination',
    'round_robin': 'Round Robin',
    'swiss': 'Swiss System',
    'exhibition': 'Exhibition',
    'custom_schedule': 'Custom Schedule'
  };
  return types[type] || type || 'Undefined';
}

// Build a composite tournament type label from phases data when available
function formatTournamentTypeForDisplay(tournament) {
  if (!tournament) return formatTournamentType(null);
  
  // If tournament has multi-phase data, build a composite label
  if (tournament.phases && Array.isArray(tournament.phases) && tournament.phases.length > 1) {
    const bracketTypeLabel = (bt) => {
      const map = {
        'SINGLE_ELIMINATION': 'SE',
        'DOUBLE_ELIMINATION': 'DE',
        'ROUND_ROBIN': 'Round Robin',
        'SWISS': 'Swiss',
        'EXHIBITION': 'Exhibition',
        'CUSTOM_SCHEDULE': 'Custom'
      };
      return map[bt] || (bt || '').replace(/_/g, ' ');
    };
    
    // Sort phases by phaseOrder
    const sorted = [...tournament.phases].sort((a, b) => (a.phaseOrder || 0) - (b.phaseOrder || 0));
    const parts = sorted.map(p => {
      const name = p.name || 'Phase';
      const bt = bracketTypeLabel(p.bracketType);
      const pools = p.groupCount > 1 ? ` (${p.groupCount} pools)` : '';
      return `${name} (${bt}${pools})`;
    });
    // Grouped Challonge brackets run side by side, start.gg phases follow each other
    return parts.join(tournament.challongeBrackets?.length ? ' / ' : ' → ');
  }
  
  return formatTournamentType(tournament.tournamentType);
}

function formatMatchState(state) {
  const states = {
    'complete': 'Finished',
    'open': 'Ongoing',
    'pending': 'Pending'
  };
  return states[state] || state || 'Unknown';
}

function sanitizeDisplayName(s) {
  if (!s && s !== '') return s;
  try {
    let str = s.toString();
    // Remove leading/trailing whitespace and common list markers like '-' or '•'
    str = str.trim().replace(/^[-•\s]+/, '').replace(/[\u2022]+$/, '').trim();
    return str;
  } catch (e) { return s; }
}

function parseRaceParticipants(text){
  if (!text) return [];
  // Trim leading labels like 'Bracket ...:'
  const afterColon = text.split(':').pop().trim();
  // common separators: vs, v, - , ◦
  const sep = /\s+vs\.?\s+|\s+v\.?\s+|\s+-\s+|\s+—\s+|\s+vs\s+|\s+\u2022\s+/i;
  const parts = text.split(sep).map(p=>p.trim()).filter(Boolean);
  if (parts.length >= 2) return parts.slice(0,2);
  // if no clear separator, try splitting by comma
  const comma = text.split(',').map(p=>p.trim()).filter(Boolean);
  if (comma.length >= 2) return comma.slice(0,2);
  return [];
}

function getTimeFromEntrant(race, index){
  try{
    const ent = (race.entrants||[])[index];
    if (!ent) return null;
    if (ent.finishTime) {
      const pretty = prettifyDurationString(ent.finishTime);
      // if prettified is zero-length, treat as unknown (don't assume DNF automatically)
      if (pretty === '0:00' || pretty === '0:00:00') return null;
      return pretty;
    }
    // support finishTimeMs (milliseconds) if present
    if (ent.finishTimeMs || ent.finishTimeMs === 0) {
      const msVal = Number(ent.finishTimeMs);
      if (!isNaN(msVal) && msVal > 0) return formatMs(msVal);
      // zero or invalid, treat as unknown
      return null;
    }
    // if finishTime missing, but finishedAt and race.startedAt exist, compute duration
    if (ent.finishedAt && race.startedAt) {
      const start = new Date(race.startedAt).getTime();
      const fin = new Date(ent.finishedAt).getTime();
      if (!isNaN(start) && !isNaN(fin)){
        const ms = fin - start;
        // if duration is negative or clearly invalid, return null
        if (ms <= 0) return null;
        return formatMs(ms);
      }
    }
    // if finishedAt exists but no race startedAt, try using race.endedAt as reference (less reliable)
    if (ent.finishedAt && race.endedAt) {
      const end = new Date(race.endedAt).getTime();
      const fin = new Date(ent.finishedAt).getTime();
      if (!isNaN(end) && !isNaN(fin)){
        const ms = fin - (end - 1); // best-effort: if finishedAt equals endedAt, avoid zero
        if (ms <= 0) return null;
        return formatMs(ms);
      }
    }
    // as last resort, interpret status flags indicating DNF
    if (ent.status) {
      const st = ent.status.toString().toLowerCase();
      if (st.includes('dnf') || st.includes('forfeit') || st.includes('forfeited') || st.includes('quit') || st.includes('disqual')) return 'DNF';
    }
  }catch(e){}
  return null;
}

function getTimeFromEntrantObj(ent, race){
    try{
    if (!ent) return null;
    if (ent.finishTime) {
      const pretty = prettifyDurationString(ent.finishTime);
      if (pretty === '0:00' || pretty === '0:00:00') return null;
      return pretty;
    }
    if (ent.finishTimeMs || ent.finishTimeMs === 0) {
      const msVal = Number(ent.finishTimeMs);
      if (!isNaN(msVal) && msVal > 0) return formatMs(msVal);
      return null;
    }
    if (ent.finishedAt && race && race.startedAt) {
      const start = new Date(race.startedAt).getTime();
      const fin = new Date(ent.finishedAt).getTime();
      if (!isNaN(start) && !isNaN(fin)){
        const ms = fin - start;
        if (ms <= 0) return null;
        return formatMs(ms);
      }
    }
    if (ent.status) {
      const st = ent.status.toString().toLowerCase();
      if (st.includes('dnf') || st.includes('forfeit') || st.includes('forfeited') || st.includes('quit') || st.includes('disqual')) return 'DNF';
    }
  }catch(e){}
  return null;
}

function computeTimesFromRace(match, race){
  if (!race || !race.entrants || !Array.isArray(race.entrants)) return null;
  const entrants = race.entrants.map(ent => {
    const rawName = (ent.user && (ent.user.name || ent.user.id)) || ent.userName || ent.name || ent.displayName || ent.comment || '';
    return {
      raw: rawName || '',
      norm: normalizeName(rawName || ''),
      status: ent.status || (ent.status && ent.status.value) || '',
      finishTime: ent.finishTime || null,
      finishTimeMs: ent.finishTimeMs || ent.finishTimeMs === 0 ? ent.finishTimeMs : null,
      finishedAt: ent.finishedAt || null,
      obj: ent
    };
  });

  const p1 = normalizeName(match.player1Name || '');
  const p2 = normalizeName(match.player2Name || '');

  const scoreEntrantForPlayer = (playerNorm, ent) => {
    if (!playerNorm || !ent || !ent.norm) return -Infinity;

    const playerTokens = playerNorm.split(' ').filter(Boolean);
    const entrantTokens = ent.norm.split(' ').filter(Boolean);
    let score = 0;

    if (ent.norm === playerNorm) score += 1000;

    if (playerTokens.length && playerTokens.every(token => entrantTokens.includes(token))) score += 350;

    if (playerTokens.some(token => entrantTokens.includes(token))) score += 260;

    try {
      const re = new RegExp('\\b' + escapeRegExp(playerNorm) + '\\b');
      if (re.test(ent.norm)) score += 220;
    } catch (e) {}

    for (const pTok of playerTokens) {
      for (const eTok of entrantTokens) {
        if (pTok === eTok) {
          score += 180;
          continue;
        }
        if ((eTok.startsWith(pTok) || pTok.startsWith(eTok)) && Math.abs(eTok.length - pTok.length) <= 4) {
          score += 120;
        }
      }
    }

    const lev = levenshtein(ent.norm, playerNorm);
    const similarity = 1 - (lev / Math.max(ent.norm.length, playerNorm.length, 1));
    if (similarity > 0.9) score += 160;
    else if (similarity > 0.75) score += 80;

    if (ent.finishTime || ent.finishTimeMs || ent.finishedAt || ent.status === 'dnf' || ent.status === 'dq') {
      score += 15;
    }

    return score;
  };

  let bestPair = { score: -Infinity, ent1: null, ent2: null };
  entrants.forEach((ent1, idx1) => {
    entrants.forEach((ent2, idx2) => {
      if (idx1 === idx2) return;
      const totalScore = scoreEntrantForPlayer(p1, ent1) + scoreEntrantForPlayer(p2, ent2);
      if (totalScore > bestPair.score) {
        bestPair = { score: totalScore, ent1, ent2 };
      }
    });
  });

  // Single-player or malformed race fallback.
  if (!bestPair.ent1 && entrants.length === 1) {
    bestPair.ent1 = entrants[0];
  }

  const out = {time1: null, time2: null};
  if (bestPair.ent1) out.time1 = getTimeFromEntrantObj(bestPair.ent1.obj, race);
  if (bestPair.ent2) out.time2 = getTimeFromEntrantObj(bestPair.ent2.obj, race);

  return out;
}

function getRoundName(round) {
  if (round > 0) return `Round ${round}`;
  if (round === -1) return 'Finals';
  if (round === -2) return 'Semifinals';
  if (round === -3) return 'Quarterfinals';
  return `Round ${round}`;
}

function displayGroupStages(groupMatches, participants, races = []) {
  const container = document.getElementById('group-stages-container');
  const content = document.getElementById('group-stages-content');
  
  if (!groupMatches || groupMatches.length === 0) {
    container.style.display = 'none';
    return;
  }
  
  // Check spoiler mode
  const spoilerMode = typeof window.isSpoilerModeEnabled === 'function' && window.isSpoilerModeEnabled();
  
  container.style.display = 'block';
  content.innerHTML = '';
  
  // Group matches by groupId
  const groupIds = Array.from(new Set(groupMatches.map(m => m.groupId)))
    .filter(v => v !== null && v !== undefined)
    .sort((a, b) => a - b);
  
  // Create a grid container for all groups
  const gridContainer = document.createElement('div');
  gridContainer.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap: 1.5rem;';
  
  groupIds.forEach((gid, idx) => {
    const letter = String.fromCharCode('A'.charCodeAt(0) + (idx % 26));
    const groupContainer = document.createElement('div');
    groupContainer.style.cssText = 'background-color: #1f2937; padding: 1rem; border-radius: 0.5rem; border: 1px solid #374151;';
    
    // Group title
    const title = document.createElement('h3');
    title.style.cssText = 'font-size: 1.1rem; font-weight: bold; margin-bottom: 0.75rem; color: #fbbf24; text-align: center;';
    title.textContent = `${i18n.t('tournamentDetail.group') || 'Group'} ${letter}`;
    groupContainer.appendChild(title);
    
    // Get matches for this group
    const matches = groupMatches.filter(m => m.groupId === gid);
    
    // Get participants in this group
    const participantNames = new Set();
    matches.forEach(m => {
      if (m.player1Name) participantNames.add(m.player1Name);
      if (m.player2Name) participantNames.add(m.player2Name);
    });
    
    if (spoilerMode) {
      // In spoiler mode: just show participant names alphabetically, no results
      const sortedNames = Array.from(participantNames).sort((a, b) => 
        (a || '').toLowerCase().localeCompare((b || '').toLowerCase(), 'fr')
      );
      
      const namesList = document.createElement('div');
      namesList.style.cssText = 'display: flex; flex-direction: column; gap: 0.25rem;';
      
      sortedNames.forEach(name => {
        const row = document.createElement('div');
        row.style.cssText = 'padding: 0.5rem; background-color: #111827; border-radius: 0.25rem; color: #d1d5db;';
        row.innerHTML = `<a href="/player-detail.html?name=${encodeURIComponent(sanitizeDisplayName(name))}" style="color: inherit; text-decoration: none;">${escHtml(sanitizeDisplayName(name))}</a>`;
        namesList.appendChild(row);
      });
      
      groupContainer.appendChild(namesList);
    } else {
      // Normal mode: show standings with wins/losses
      // Calculate standings (wins/losses for each participant)
      const standings = new Map();
      participantNames.forEach(name => {
        standings.set(name, { name, wins: 0, losses: 0 });
      });
    
      matches.forEach(m => {
        if (!m.winnerId || !m.player1Name || !m.player2Name) return;
        
        // Determine winner by name
        const p1Participant = participants.find(p => p.name === m.player1Name || p.displayName === m.player1Name);
        const p2Participant = participants.find(p => p.name === m.player2Name || p.displayName === m.player2Name);
        
        let winnerName = null;
        let loserName = null;
        
        if (p1Participant && m.winnerId === p1Participant.challongeId) {
          winnerName = m.player1Name;
          loserName = m.player2Name;
        } else if (p2Participant && m.winnerId === p2Participant.challongeId) {
          winnerName = m.player2Name;
          loserName = m.player1Name;
        } else if (m.winnerId === m.player1Id) {
          winnerName = m.player1Name;
          loserName = m.player2Name;
        } else if (m.winnerId === m.player2Id) {
          winnerName = m.player2Name;
          loserName = m.player1Name;
        }
        
        if (winnerName && standings.has(winnerName)) {
          standings.get(winnerName).wins++;
        }
        if (loserName && standings.has(loserName)) {
          standings.get(loserName).losses++;
        }
      });
      
      // Sort standings by wins (descending)
      const sortedStandings = Array.from(standings.values()).sort((a, b) => b.wins - a.wins);
      
      // Display standings table
      const standingsTable = document.createElement('div');
      standingsTable.style.cssText = 'margin-bottom: 1rem;';
      
      sortedStandings.forEach((standing, pos) => {
        const row = document.createElement('div');
        row.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 0.5rem; background-color: #111827; border-radius: 0.25rem; margin-bottom: 0.25rem;';
        
        const qualified = pos < 2; // Top 2 qualify
        const nameStyle = qualified ? 'color: #fbbf24; font-weight: bold;' : 'color: #9ca3af;';
        
        row.innerHTML = `
          <a href="/player-detail.html?name=${encodeURIComponent(sanitizeDisplayName(standing.name))}" style="${nameStyle} text-decoration: none;">${pos + 1}. ${escHtml(sanitizeDisplayName(standing.name))}</a>
          <span style="color: #9ca3af; font-size: 0.875rem;">${standing.wins}V - ${standing.losses}D</span>
        `;
        standingsTable.appendChild(row);
      });
      
      groupContainer.appendChild(standingsTable);
      
      // Display matches
      const matchesContainer = document.createElement('div');
      matchesContainer.style.cssText = 'display: flex; flex-direction: column; gap: 0.5rem;';
      
      matches
        .sort((a, b) => {
          const getTime = (m) => {
            const d = m && (m.completedAt || m.startedAt || m.updatedAt || m.createdAt);
            if (!d) return 0;
            const t = new Date(d).getTime();
            return Number.isFinite(t) ? t : 0;
          };
          return getTime(a) - getTime(b);
        })
        .forEach(match => {
          const matchCard = createCompactMatchCard(match, races);
          matchesContainer.appendChild(matchCard);
        });
      
      groupContainer.appendChild(matchesContainer);
    } // End of else (normal mode)
    gridContainer.appendChild(groupContainer);
  });
  
  content.appendChild(gridContainer);
}

// Compact match card for group stages visualization
function createCompactMatchCard(match, races = []) {
  const card = document.createElement('div');
  card.id = 'match-' + (match.challongeId || match.id || match._id || match.matchId || '');
  card.style.cssText = 'background-color: #111827; padding: 0.5rem; border-radius: 0.25rem; cursor: pointer;';
  
  // Make card clickable to go to match details
  card.addEventListener('click', () => {
    goToMatchById(match.challongeId || match.id || match._id || match.matchId || '');
  });
  
  const player1Winner = match.winnerId === match.player1Id || 
                        (match.player1Name && match.winnerId && isMatchWinner(match, match.player1Name));
  const player2Winner = match.winnerId === match.player2Id ||
                        (match.player2Name && match.winnerId && isMatchWinner(match, match.player2Name));
  
  // Calculate display scores
  let displayScore1 = null;
  let displayScore2 = null;
  
  if (match.scoresCsv) {
    const raw = String(match.scoresCsv).trim();
    const parts = raw.split('-');
    
    if (parts.length === 2) {
      const val1 = parseInt(parts[0], 10);
      const val2 = parseInt(parts[1], 10);
      
      if (Number.isFinite(val1) && Number.isFinite(val2) && (val1 > 1000 || val2 > 1000)) {
        if (match.winnerId === match.player1Id || player1Winner) {
          displayScore1 = 1;
          displayScore2 = 0;
        } else if (match.winnerId === match.player2Id || player2Winner) {
          displayScore1 = 0;
          displayScore2 = 1;
        } else {
          displayScore1 = 0;
          displayScore2 = 0;
        }
      } else {
        displayScore1 = val1;
        displayScore2 = val2;
      }
    }
  }
  
  card.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; font-size: 0.875rem;">
      <div style="flex: 1;">
        <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem;">
          ${match.player1Name ? `<a href="/player-detail.html?name=${encodeURIComponent(sanitizeDisplayName(match.player1Name))}" style="font-weight: ${player1Winner ? 'bold' : 'normal'}; color: ${player1Winner ? '#fbbf24' : 'white'}; text-decoration: none;">${escHtml(sanitizeDisplayName(match.player1Name))}</a>` : (i18n.t('tournamentDetail.tbd') || 'TBD')}
          ${displayScore1 !== null ? `<span style="color: #9ca3af; font-family: monospace;">${displayScore1}</span>` : ''}
        </div>
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          ${match.player2Name ? `<a href="/player-detail.html?name=${encodeURIComponent(sanitizeDisplayName(match.player2Name))}" style="font-weight: ${player2Winner ? 'bold' : 'normal'}; color: ${player2Winner ? '#fbbf24' : 'white'}; text-decoration: none;">${escHtml(sanitizeDisplayName(match.player2Name))}</a>` : (i18n.t('tournamentDetail.tbd') || 'TBD')}
          ${displayScore2 !== null ? `<span style="color: #9ca3af; font-family: monospace;">${displayScore2}</span>` : ''}
        </div>
      </div>
    </div>
  `;
  
  return card;
}

// Helper to check if a player name matches the winner
function isMatchWinner(match, playerName) {
  // This is a simplified check - can be improved
  return false;
}

function displayBracket(matches, tournament) {
  const container = document.getElementById('bracket-container');
  
  // Ensure matches is an array
  if (!matches || !Array.isArray(matches) || matches.length === 0) {
    container.innerHTML = `<p style="color: #9ca3af;">${i18n.t('tournamentDetail.noMatchesForBracket') || 'No matches available to display bracket'}</p>`;
    return;
  }

  if (!tournament) {
    container.innerHTML = '<p style="color: #ef4444;">Error: missing tournament information</p>';
    return;
  }

  // Check spoiler mode - in spoiler mode, only show groups (if any) without results
  const spoilerMode = typeof window.isSpoilerModeEnabled === 'function' && window.isSpoilerModeEnabled();
  
  if (spoilerMode) {
    // Check if there are group stage matches
    const groupStageMatches = matches.filter(m => m && m.groupId !== null && m.groupId !== undefined);
    
    if (groupStageMatches.length > 0) {
      // Display groups with participants (alphabetically sorted, no results)
      displaySpoilerGroupsOnly(groupStageMatches, tournament.participants || [], container);
    } else {
      // No groups, show message
      const bracketHiddenText = (typeof i18n !== 'undefined' && i18n.t)
        ? i18n.t('tournamentDetail.bracketHiddenSpoiler', {}, 'Bracket hidden in spoiler-free mode')
        : 'Bracket hidden in spoiler-free mode';
      container.innerHTML = `<div class="spoiler-message" style="display:block;color:#9ca3af;font-style:italic;padding:2rem;text-align:center;background:#1f2937;border-radius:0.5rem;">${bracketHiddenText}</div>`;
    }
    return;
  }

  // Normal display
  // Check if it's a double elimination tournament (handle both formats: with space or underscore)
  const tournamentType = (tournament.tournamentType || '').toLowerCase().replace(/[\s_]+/g, '');
  const isDoubleElimination = tournamentType === 'doubleelimination';
  
  // Check for Start.gg phases (Main Bracket vs Preliminary Bracket, etc.).
  // Phases without sets yet (e.g. final brackets after groups) are listed too, as "not started".
  const matchPhases = [...new Set(matches.filter(m => m.phase).map(m => m.phase))];
  const declaredPhases = matchPhases.length && Array.isArray(tournament.phases)
    ? tournament.phases.slice().sort((a, b) => (a.phaseOrder || 0) - (b.phaseOrder || 0)).map(p => p.name).filter(Boolean)
    : [];
  const phases = [...new Set([...declaredPhases, ...matchPhases])];
  const hasMultiplePhases = phases.length > 1;
  
  // Check if Start.gg tournament with phase groups (pools)
  const phaseGroups = [...new Set(matches.filter(m => m.phaseGroup).map(m => m.phaseGroup))];
  const hasPhaseGroups = phaseGroups.length > 1;
  
  container.innerHTML = '';
  
  if (hasMultiplePhases) {
    // Multi-phase Start.gg tournament (e.g., Main Bracket + Preliminary Bracket)
    displayMultiPhaseBracket(matches, container, isDoubleElimination, phases, tournament);
  } else if (phases.length === 1 && isStandingsPhase(tournament, phases[0])) {
    displayStandingsPhase(matches, container, getPhaseKind(tournament, phases[0]) === 'swiss');
  } else if (hasPhaseGroups) {
    // Start.gg pools - display each pool as a separate bracket
    displayPoolsBracket(matches, container, isDoubleElimination, phaseGroups);
  } else if (isDoubleElimination) {
    displayDoubleEliminationBracket(matches, container);
  } else {
    displaySingleEliminationBracket(matches, container);
  }
}

// Display multi-phase Start.gg tournament (Main Bracket + Preliminary Bracket)
function displayMultiPhaseBracket(matches, container, isDoubleElimination, phases, tournament) {
  // Sort phases: "Main Bracket" or "Bracket" first, then "Preliminary Bracket" or others
  phases.sort((a, b) => {
    const aLower = (a || '').toLowerCase();
    const bLower = (b || '').toLowerCase();
    
    // Main Bracket / Bracket should come first
    const aIsMain = aLower.includes('main') || (aLower === 'bracket' && !aLower.includes('preliminary'));
    const bIsMain = bLower.includes('main') || (bLower === 'bracket' && !bLower.includes('preliminary'));
    
    if (aIsMain && !bIsMain) return -1;
    if (!aIsMain && bIsMain) return 1;
    return 0;
  });

  // Build a lookup for per-phase bracket type from tournament.phases data
  const phaseBracketTypeMap = {};
  if (tournament && tournament.phases && Array.isArray(tournament.phases)) {
    tournament.phases.forEach(p => {
      if (p.name) {
        const bt = (p.bracketType || '').toLowerCase().replace(/[\s_]+/g, '');
        phaseBracketTypeMap[p.name] = bt === 'doubleelimination';
      }
    });
  }
  
  phases.forEach((phaseName, idx) => {
    const phaseMatches = matches.filter(m => m.phase === phaseName);

    // Detect per-phase double elimination: from tournament.phases data, or fallback to match round analysis
    let phaseIsDE = isDoubleElimination; // default to global detection
    if (phaseName in phaseBracketTypeMap) {
      phaseIsDE = phaseBracketTypeMap[phaseName];
    } else {
      // Fallback: if any match in this phase has a negative round, it's double elimination
      const hasNegativeRound = phaseMatches.some(m => m.round < 0);
      if (hasNegativeRound) phaseIsDE = true;
    }
    
    // Create phase section
    const phaseSection = document.createElement('div');
    phaseSection.className = 'phase-section';
    phaseSection.style.cssText = idx > 0 ? 'margin-top: 3rem; border-top: 2px solid #374151; padding-top: 2rem;' : '';
    
    // Phase title
    const phaseTitle = document.createElement('h3');
    phaseTitle.style.cssText = 'font-size: 1.5rem; font-weight: bold; margin-bottom: 1.5rem; text-align: center; color: #fbbf24;';
    phaseTitle.textContent = phaseName;
    phaseSection.appendChild(phaseTitle);
    
    // Check if this phase has pools
    const phaseGroups = [...new Set(phaseMatches.filter(m => m.phaseGroup).map(m => m.phaseGroup))];
    const hasPhaseGroups = phaseGroups.length > 1;
    
    const bracketContainer = document.createElement('div');
    bracketContainer.className = 'phase-bracket-container';
    
    if (phaseMatches.length === 0) {
      // No matches yet (e.g., Main Bracket not started)
      bracketContainer.innerHTML = `<p style="color: #9ca3af; text-align: center; font-style: italic;">${i18n.t('tournamentDetail.bracketNotStarted') || 'Bracket not started yet'}</p>`;
    } else if (isStandingsPhase(tournament, phaseName)) {
      // Swiss / round robin: elimination trees make no sense, show standings and rounds
      displayStandingsPhase(phaseMatches, bracketContainer, getPhaseKind(tournament, phaseName) === 'swiss');
    } else if (hasPhaseGroups) {
      // This phase has pools
      displayPoolsBracket(phaseMatches, bracketContainer, phaseIsDE, phaseGroups);
    } else if (phaseIsDE) {
      displayDoubleEliminationBracket(phaseMatches, bracketContainer);
    } else {
      displaySingleEliminationBracket(phaseMatches, bracketContainer);
    }
    
    phaseSection.appendChild(bracketContainer);
    container.appendChild(phaseSection);
  });
}

// Normalized start.gg bracketType of a phase ('swiss', 'roundrobin', 'doubleelimination'...)
function getPhaseKind(tournament, phaseName) {
  const phase = (tournament && Array.isArray(tournament.phases) ? tournament.phases : []).find(p => p.name === phaseName);
  return phase ? String(phase.bracketType || '').toLowerCase().replace(/[\s_]+/g, '') : '';
}

function isStandingsPhase(tournament, phaseName) {
  const kind = getPhaseKind(tournament, phaseName);
  return kind === 'swiss' || kind === 'roundrobin';
}

// Swiss / round robin phase: one standings table per pool, with its matches (by round for Swiss)
function displayStandingsPhase(phaseMatches, container, isSwiss) {
  const groups = new Map();
  phaseMatches.forEach(m => {
    const key = m.phaseGroup || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  });

  const getTime = (m) => {
    const t = new Date(m && (m.completedAt || m.startedAt || 0)).getTime();
    return Number.isFinite(t) ? t : 0;
  };

  const grid = document.createElement('div');
  grid.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 1.5rem;';

  [...groups.keys()].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true })).forEach((key, idx) => {
    const matches = groups.get(key);
    const box = document.createElement('div');
    box.style.cssText = 'background-color: #1f2937; padding: 1rem; border-radius: 0.5rem; border: 1px solid #374151;';

    if (!isSwiss) {
      const title = document.createElement('h4');
      title.style.cssText = 'font-size: 1.1rem; font-weight: bold; margin-bottom: 0.75rem; color: #fbbf24; text-align: center;';
      title.textContent = `${i18n.t('tournamentDetail.group') || 'Group'} ${key || String.fromCharCode(65 + (idx % 26))}`;
      box.appendChild(title);
    }

    const standings = new Map();
    const entry = (name) => {
      if (!standings.has(name)) standings.set(name, { name, wins: 0, losses: 0 });
      return standings.get(name);
    };
    matches.forEach(m => {
      const n1 = m.player1Name, n2 = m.player2Name;
      if (!n1 || !n2 || n1 === 'TBD' || n2 === 'TBD') return;
      entry(n1); entry(n2);
      if (m.winnerId && m.winnerId === m.player1Id) { entry(n1).wins++; entry(n2).losses++; }
      else if (m.winnerId && m.winnerId === m.player2Id) { entry(n2).wins++; entry(n1).losses++; }
    });

    [...standings.values()]
      .sort((a, b) => b.wins - a.wins || a.losses - b.losses || a.name.localeCompare(b.name))
      .forEach((s, pos) => {
        const row = document.createElement('div');
        row.style.cssText = 'display: flex; justify-content: space-between; align-items: center; padding: 0.5rem; background-color: #111827; border-radius: 0.25rem; margin-bottom: 0.25rem;';
        const link = document.createElement('a');
        link.href = '/player-detail.html?name=' + encodeURIComponent(sanitizeDisplayName(s.name));
        link.style.cssText = 'color: #e5e7eb; text-decoration: none;';
        link.textContent = `${pos + 1}. ${sanitizeDisplayName(s.name)}`;
        const record = document.createElement('span');
        record.style.cssText = 'color: #9ca3af; font-size: 0.875rem;';
        record.textContent = `${s.wins}V - ${s.losses}D`;
        row.appendChild(link);
        row.appendChild(record);
        box.appendChild(row);
      });

    const list = document.createElement('div');
    list.style.cssText = 'display: flex; flex-direction: column; gap: 0.5rem; margin-top: 1rem;';
    if (isSwiss) {
      const byRound = new Map();
      matches.forEach(m => {
        const round = m.round || 0;
        if (!byRound.has(round)) byRound.set(round, []);
        byRound.get(round).push(m);
      });
      [...byRound.keys()].sort((a, b) => a - b).forEach(round => {
        const header = document.createElement('div');
        header.style.cssText = 'color: #fbbf24; font-weight: bold; font-size: 0.9rem; margin-top: 0.5rem;';
        header.textContent = `Round ${round}`;
        list.appendChild(header);
        byRound.get(round).sort((a, b) => getTime(a) - getTime(b)).forEach(m => list.appendChild(createCompactMatchCard(m, currentRaces)));
      });
    } else {
      matches.slice().sort((a, b) => getTime(a) - getTime(b)).forEach(m => list.appendChild(createCompactMatchCard(m, currentRaces)));
    }
    box.appendChild(list);
    grid.appendChild(box);
  });

  container.appendChild(grid);
}

// Display groups in spoiler mode - only player names, alphabetically sorted, no results
function displaySpoilerGroupsOnly(groupMatches, participants, container) {
  container.innerHTML = '';
  
  // Group matches by groupId
  const groupIds = Array.from(new Set(groupMatches.map(m => m.groupId)))
    .filter(v => v !== null && v !== undefined)
    .sort((a, b) => a - b);
  
  // Create container for groups
  const spoilerGroupsContainer = document.createElement('div');
  spoilerGroupsContainer.className = 'spoiler-groups-container';
  spoilerGroupsContainer.innerHTML = '<p style="color: #9ca3af; font-style: italic; margin-bottom: 1rem;">Group composition (alphabetical order):</p>';
  
  const gridContainer = document.createElement('div');
  gridContainer.style.cssText = 'display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1rem;';
  
  groupIds.forEach((gid, idx) => {
    const letter = String.fromCharCode('A'.charCodeAt(0) + (idx % 26));
    const groupContainer = document.createElement('div');
    groupContainer.style.cssText = 'background-color: #1f2937; padding: 1rem; border-radius: 0.5rem; border: 1px solid #374151;';
    
    // Group title
    const title = document.createElement('h3');
    title.style.cssText = 'font-size: 1rem; font-weight: bold; margin-bottom: 0.75rem; color: #fbbf24; text-align: center;';
    title.textContent = `${i18n.t('tournamentDetail.group') || 'Group'} ${letter}`;
    groupContainer.appendChild(title);
    
    // Get matches for this group
    const matches = groupMatches.filter(m => m.groupId === gid);
    
    // Get participants in this group
    const participantNames = new Set();
    matches.forEach(m => {
      if (m.player1Name) participantNames.add(m.player1Name);
      if (m.player2Name) participantNames.add(m.player2Name);
    });
    
    // Sort alphabetically
    const sortedNames = Array.from(participantNames).sort((a, b) => 
      (a || '').toLowerCase().localeCompare((b || '').toLowerCase(), 'fr')
    );
    
    // Display names only (no results/rankings)
    const namesList = document.createElement('div');
    sortedNames.forEach(name => {
      const row = document.createElement('div');
      row.style.cssText = 'padding: 0.4rem 0.5rem; background-color: #111827; border-radius: 0.25rem; margin-bottom: 0.25rem; color: #d1d5db; font-size: 0.9rem;';
      
      row.innerHTML = `<a href="/player-detail.html?name=${encodeURIComponent(name)}" style="color: inherit; text-decoration: none;">${escHtml(name)}</a>`;
      namesList.appendChild(row);
    });
    
    groupContainer.appendChild(namesList);
    gridContainer.appendChild(groupContainer);
  });
  
  spoilerGroupsContainer.appendChild(gridContainer);
  container.appendChild(spoilerGroupsContainer);
}

// Display Start.gg pools/phase groups as separate brackets
function displayPoolsBracket(matches, container, isDoubleElimination, phaseGroups) {
  container.innerHTML = '';
  
  // Sort phase groups
  phaseGroups.sort((a, b) => {
    const numA = parseInt(a) || 0;
    const numB = parseInt(b) || 0;
    return numA - numB;
  });
  
  // Create tabs for each pool
  const tabsContainer = document.createElement('div');
  tabsContainer.className = 'pools-tabs';
  tabsContainer.style.cssText = 'display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1.5rem;';
  
  const poolsContent = document.createElement('div');
  poolsContent.className = 'pools-content';
  
  phaseGroups.forEach((poolId, idx) => {
    const letter = String.fromCharCode('A'.charCodeAt(0) + idx);
    
    // Create tab button
    const tabBtn = document.createElement('button');
    tabBtn.className = `pool-tab ${idx === 0 ? 'active' : ''}`;
    tabBtn.style.cssText = `
      padding: 0.5rem 1rem;
      background-color: ${idx === 0 ? '#3b82f6' : '#374151'};
      color: ${idx === 0 ? '#fff' : '#9ca3af'};
      border: none;
      border-radius: 0.5rem;
      cursor: pointer;
      font-weight: 600;
      transition: all 0.2s;
    `;
    tabBtn.textContent = `Pool ${letter}`;
    tabBtn.dataset.pool = poolId;
    
    tabBtn.addEventListener('click', () => {
      // Update active tab
      tabsContainer.querySelectorAll('.pool-tab').forEach(t => {
        t.style.backgroundColor = '#374151';
        t.style.color = '#9ca3af';
        t.classList.remove('active');
      });
      tabBtn.style.backgroundColor = '#3b82f6';
      tabBtn.style.color = '#fff';
      tabBtn.classList.add('active');
      
      // Show corresponding pool content
      poolsContent.querySelectorAll('.pool-bracket').forEach(p => {
        p.style.display = 'none';
      });
      const poolDiv = poolsContent.querySelector(`[data-pool="${poolId}"]`);
      if (poolDiv) {
        poolDiv.style.display = 'block';
        // Redraw SVG connectors for this pool now that it's visible
        setTimeout(() => {
          poolDiv.querySelectorAll('.bracket-section, .phase-bracket-container').forEach(section => {
            const bracketHTML = section.querySelector('.bracket-container');
            const svg = section.querySelector('svg');
            if (bracketHTML && svg) {
              // Re-trigger connector drawing
              const roundCols = bracketHTML.querySelectorAll('[data-round-index]');
              const totalRounds = roundCols.length;
              // Gather round data from the DOM
              const sortedRounds = [];
              const byRound = {};
              roundCols.forEach(col => {
                const round = parseInt(col.getAttribute('data-round'));
                sortedRounds.push(round);
                byRound[round] = [];
              });
              const bracketType = section.classList.contains('loser-bracket-section') ? 'loser' : 'winner';
              const isPoolBracket = true;
              drawBracketConnectors(bracketHTML, svg, totalRounds, bracketType, byRound, sortedRounds, isPoolBracket);
            }
          });
        }, 50);
      }
    });
    
    tabsContainer.appendChild(tabBtn);
    
    // Create pool bracket content
    const poolDiv = document.createElement('div');
    poolDiv.className = 'pool-bracket';
    poolDiv.dataset.pool = poolId;
    poolDiv.style.display = idx === 0 ? 'block' : 'none';
    
    // Filter matches for this pool
    const poolMatches = matches.filter(m => m.phaseGroup === poolId);
    
    if (poolMatches.length === 0) {
      poolDiv.innerHTML = '<p style="color: #9ca3af;">No matches in this pool</p>';
    } else if (isDoubleElimination) {
      // Separate winner and loser bracket matches
      const winnerMatches = poolMatches.filter(m => m.round > 0);
      const loserMatches = poolMatches.filter(m => m.round < 0);
      
      if (winnerMatches.length > 0) {
        const winnerTitle = document.createElement('h4');
        winnerTitle.textContent = i18n.t('tournamentDetail.winnersBracket') || 'Winners Bracket';
        winnerTitle.style.cssText = 'color: #10b981; margin-bottom: 1rem; font-size: 1.1rem;';
        poolDiv.appendChild(winnerTitle);
        
        const winnerContainer = document.createElement('div');
        winnerContainer.className = 'bracket-section winner-bracket-section';
        displayBracketSection(winnerMatches, winnerContainer, 'winner', true, true);
        poolDiv.appendChild(winnerContainer);
      }
      
      if (loserMatches.length > 0) {
        const loserTitle = document.createElement('h4');
        loserTitle.textContent = i18n.t('tournamentDetail.losersBracket') || 'Losers Bracket';
        loserTitle.style.cssText = 'color: #ef4444; margin: 1.5rem 0 1rem 0; font-size: 1.1rem;';
        poolDiv.appendChild(loserTitle);
        
        const loserContainer = document.createElement('div');
        loserContainer.className = 'bracket-section loser-bracket-section';
        // Convert negative rounds to positive for display
        const loserMatchesForDisplay = loserMatches.map(m => ({ ...m, round: Math.abs(m.round) }));
        displayBracketSection(loserMatchesForDisplay, loserContainer, 'loser', true, true);
        poolDiv.appendChild(loserContainer);
      }
    } else {
      // Single elimination pool
      displayBracketSection(poolMatches, poolDiv, 'winner', false, true);
    }
    
    poolsContent.appendChild(poolDiv);
  });
  
  container.appendChild(tabsContainer);
  container.appendChild(poolsContent);
}

function displaySingleEliminationBracket(matches, container) {
  // Ensure matches is an array
  if (!matches || !Array.isArray(matches)) {
    container.innerHTML = '<p style="color: #9ca3af;">Error: invalid match data</p>';
    return;
  }
  
  // Filter out group stage matches (only show final stage bracket)
  const finalStageMatches = matches.filter(m => m && (m.groupId === null || m.groupId === undefined));
  
  if (finalStageMatches.length === 0) {
    container.innerHTML = `<p style="color: #9ca3af;">${i18n.t('tournamentDetail.noFinalsMatches') || 'No finals matches available'}</p>`;
    return;
  }
  
  // Use the same bracket section display with SVG connectors
  container.innerHTML = '';
  displayBracketSection(finalStageMatches, container, 'winner', false);
}

function displayDoubleEliminationBracket(matches, container) {
  // Separate Winner and Loser brackets
  const winnerMatches = [];
  const loserMatches = [];
  
  // Ensure matches is an array
  if (!matches || !Array.isArray(matches)) {
    container.innerHTML = '<p style="color: #9ca3af;">Error: invalid match data</p>';
    return;
  }
  
  matches.forEach(match => {
    if (!match) return;
    const round = match.round || 0;
    // Positive rounds = winner bracket, negative rounds = loser bracket
    if (round > 0) {
      winnerMatches.push(match);
    } else if (round < 0) {
      loserMatches.push(match);
    }
  });
  
  container.innerHTML = '';
  
  // Winner Bracket (includes grand finals)
  if (winnerMatches.length > 0) {
    const winnerSection = document.createElement('div');
    winnerSection.style.cssText = 'margin-bottom: 2rem;';
    
    const winnerTitle = document.createElement('h3');
    winnerTitle.style.cssText = 'font-size: 1.25rem; font-weight: bold; margin-bottom: 1rem; text-align: center;';
    winnerTitle.textContent = '🏆 ' + (typeof i18n !== 'undefined' ? i18n.t('tournamentDetail.winnersBracket') : 'Winners Bracket');
    winnerTitle.classList.add('text-gold');
    winnerSection.appendChild(winnerTitle);
    
    const winnerBracketDiv = document.createElement('div');
    displayBracketSection(winnerMatches, winnerBracketDiv, 'winner', true);
    winnerSection.appendChild(winnerBracketDiv);
    
    container.appendChild(winnerSection);
  }
  
  // Loser Bracket
  if (loserMatches.length > 0) {
    const loserSection = document.createElement('div');
    loserSection.style.cssText = 'margin-bottom: 2rem;';
    
    const loserTitle = document.createElement('h3');
    loserTitle.style.cssText = 'font-size: 1.25rem; font-weight: bold; color: #ef4444; margin-bottom: 1rem; text-align: center;';
    loserTitle.textContent = '💔 ' + (typeof i18n !== 'undefined' ? i18n.t('tournamentDetail.losersBracket') : 'Losers Bracket');
    loserSection.appendChild(loserTitle);
    
    const loserBracketDiv = document.createElement('div');
    displayBracketSection(loserMatches, loserBracketDiv, 'loser', true);
    loserSection.appendChild(loserBracketDiv);
    
    container.appendChild(loserSection);
  }
}

function displayBracketSection(matches, container, bracketType = 'winner', isDoubleElimination = false, isPoolBracket = false) {
  // Group matches by round
  const byRound = {};
  matches.forEach(match => {
    const round = match.round || 0;
    if (!byRound[round]) byRound[round] = [];
    byRound[round].push(match);
  });

  // Sort rounds
  // Detect convention: Challonge uses -1 as first losers round (sort descending),
  // Start.gg uses most-negative as first losers round (sort ascending)
  const loserRoundNumbers = Object.keys(byRound).map(r => parseInt(r)).filter(r => r < 0);
  const isChallongeConvention = loserRoundNumbers.includes(-1);
  const sortedRounds = Object.keys(byRound).map(r => parseInt(r)).sort((a, b) => {
    if (bracketType === 'loser') {
      // Challonge: -1 first (descending). Start.gg: most negative first (ascending).
      return isChallongeConvention ? (b - a) : (a - b);
    } else {
      return a - b;
    }
  });
  
  // Sort matches within each round by their ID to maintain logical order
  sortedRounds.forEach(round => {
    byRound[round].sort((a, b) => {
      // For Start.gg: use startggSetId, fallback to challongeId, then maintain insertion order
      const aId = a.startggSetId || a.challongeId;
      const bId = b.startggSetId || b.challongeId;
      if (aId && bId) {
        // Both have IDs, sort by ID (handle both string and numeric)
        return aId.localeCompare ? aId.localeCompare(bId) : (aId - bId);
      }
      // No ID available, keep insertion order (stable sort)
      return 0;
    });
  });
  
  const numRounds = sortedRounds.length;
  const columnWidth = `${100 / numRounds}%`;
  
  // Create bracket wrapper with position relative for SVG overlay
  const bracketWrapper = document.createElement('div');
  bracketWrapper.style.cssText = 'position: relative; width: 100%;';
  
  // Create bracket HTML
  const bracketHTML = document.createElement('div');
  bracketHTML.style.cssText = 'display: flex; gap: 0.5rem; width: 100%; position: relative;';
  bracketHTML.className = 'bracket-container';
  
  sortedRounds.forEach((round, index) => {
    const isGrandFinal = bracketType === 'winner' && index === sortedRounds.length - 1 && !isPoolBracket;
    const roundColumn = createRoundColumn(byRound[round], round, columnWidth, bracketType, numRounds, index, isGrandFinal, isDoubleElimination, isPoolBracket);
    bracketHTML.appendChild(roundColumn);
  });
  
  bracketWrapper.appendChild(bracketHTML);
  
  // Create SVG overlay for connector lines
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 0;';
  svg.setAttribute('preserveAspectRatio', 'none');
  bracketWrapper.appendChild(svg);
  
  container.appendChild(bracketWrapper);
  
  // Draw connector lines after a brief delay to ensure elements are rendered
  setTimeout(() => drawBracketConnectors(bracketHTML, svg, sortedRounds.length, bracketType, byRound, sortedRounds, isPoolBracket), 50);
}

function createRoundColumn(matches, round, width, bracketType = 'winner', totalRounds = 0, roundIndex = 0, isGrandFinal = false, isDoubleElimination = false, isPoolBracket = false) {
  const roundColumn = document.createElement('div');
  roundColumn.style.cssText = `display: flex; flex-direction: column; width: ${width}; position: relative;`;
  roundColumn.setAttribute('data-round', round);
  roundColumn.setAttribute('data-round-index', roundIndex);
  
  // Round header
  const header = document.createElement('div');
  header.style.cssText = 'font-weight: bold; margin-bottom: 0.75rem; text-align: center; padding: 0.4rem; background-color: #374151; border-radius: 0.25rem; font-size: 0.75rem;';
  
  header.textContent = getRoundNameForBracket(round, bracketType, totalRounds, roundIndex, isDoubleElimination, isPoolBracket);
  header.classList.add('text-gold');
  
  roundColumn.appendChild(header);
  
  // Matches in this round
  const isGrandFinaleRound = isGrandFinal;
  const matchesContainer = document.createElement('div');
  matchesContainer.style.cssText = `display: flex; flex-direction: column; gap: ${isGrandFinaleRound ? '1rem' : '0.5rem'}; flex: 1; justify-content: ${isGrandFinaleRound ? 'center' : 'space-around'};`;
  matchesContainer.className = 'matches-container';
  
  matches.forEach((match, idx) => {
    const matchWrapper = document.createElement('div');
    matchWrapper.className = 'bracket-match-wrapper';
    matchWrapper.style.cssText = 'position: relative; z-index: 1;';
    matchWrapper.setAttribute('data-match-id', match.challongeId || match.id || match._id || '');
    matchWrapper.setAttribute('data-match-index', idx);
    
    // Add label for grand finals matches
    if (isGrandFinaleRound && matches.length > 1) {
      const matchLabel = document.createElement('div');
      matchLabel.style.cssText = 'font-size: 0.7rem; color: #9ca3af; margin-bottom: 0.25rem; text-align: center;';
      matchLabel.textContent = idx === 0 ? (i18n.t('tournamentDetail.match1') || 'Match 1') : (i18n.t('tournamentDetail.bracketReset') || 'Bracket Reset');
      matchWrapper.appendChild(matchLabel);
    }
    
    const matchCard = createBracketMatchCard(match, isGrandFinal);
    matchWrapper.appendChild(matchCard);
    matchesContainer.appendChild(matchWrapper);
  });
  
  roundColumn.appendChild(matchesContainer);
  return roundColumn;
}

function drawBracketConnectors(bracketContainer, svg, totalRounds, bracketType = 'winner', roundsData = {}, sortedRounds = [], isPoolBracket = false) {
  if (!bracketContainer || !svg) return;
  
  const rounds = bracketContainer.querySelectorAll('[data-round-index]');
  if (rounds.length < 2) return;
  
  // Clear existing paths
  svg.innerHTML = '';
  
  const bracketRect = bracketContainer.getBoundingClientRect();
  
  // Draw connectors between consecutive rounds
  for (let i = 0; i < rounds.length - 1; i++) {
    const currentRound = rounds[i];
    const nextRound = rounds[i + 1];
    
    const currentMatches = currentRound.querySelectorAll('.bracket-match-wrapper');
    const nextMatches = nextRound.querySelectorAll('.bracket-match-wrapper');
    
    const isLoserBracket = bracketType === 'loser';
    const currentRoundNumber = sortedRounds ? sortedRounds[i] : null;
    
    // For losers brackets in pools: in DE, some losers rounds have cross-bracket seeding
    // from the winners bracket, so 1-to-1 connectors may not be perfectly accurate.
    // However, we still draw them as visual aids for bracket progression.
    
    // Check if next round is Grand Finals (only for main double elimination brackets)
    // NOT for pools/preliminary brackets which are self-contained
    // Grand Finals is detected by having multiple matches in the final round (Match 1 + Bracket Reset)
    const isGrandFinalsRound = !isPoolBracket && i === rounds.length - 2 && bracketType === 'winner' && nextMatches.length > 1;
    
    if (isGrandFinalsRound) {
      // Grand Finals: connect first match from current round to first match of GF
      if (currentMatches.length > 0 && nextMatches.length > 0) {
        drawConnector(currentMatches[0], nextMatches[0], svg, bracketRect);
      }
      
      // If there's a Bracket Reset (multiple matches in GF), draw horizontal connector
      if (nextMatches.length > 1) {
        drawHorizontalConnector(nextMatches[0], nextMatches[1], svg, bracketRect);
      }
      continue;
    }
    
    // Heuristic: if next round has exactly half the matches of current round, it's 2-to-1
    const is2to1 = nextMatches.length * 2 === currentMatches.length;
    
    // For losers brackets where match counts are equal, this means some players
    // come from the winners bracket and some from the previous losers round.
    // The seeding/mapping is complex, so we use 1-to-1 positional connectors
    // which is the best visual approximation.
    
    if (is2to1) {
      // Each match in the next round connects to two matches in the current round
      nextMatches.forEach((nextMatch, nextIdx) => {
        const sourceIdx1 = nextIdx * 2;
        const sourceIdx2 = nextIdx * 2 + 1;
        
        if (sourceIdx1 < currentMatches.length) {
          drawConnector(currentMatches[sourceIdx1], nextMatch, svg, bracketRect);
        }
        if (sourceIdx2 < currentMatches.length) {
          drawConnector(currentMatches[sourceIdx2], nextMatch, svg, bracketRect);
        }
      });
    } else if (nextMatches.length === currentMatches.length) {
      // 1-to-1 connections (e.g., losers bracket inter-rounds where some
      // players come from winners bracket — only draw positional connectors)
      nextMatches.forEach((nextMatch, nextIdx) => {
        if (nextIdx < currentMatches.length) {
          drawConnector(currentMatches[nextIdx], nextMatch, svg, bracketRect);
        }
      });
    } else {
      // Fallback: try to connect matches in order (useful for irregular brackets)
      const ratio = currentMatches.length / nextMatches.length;
      if (ratio >= 2) {
        // More than 2-to-1: connect multiple source matches to each destination
        nextMatches.forEach((nextMatch, nextIdx) => {
          const startIdx = Math.floor(nextIdx * ratio);
          const endIdx = Math.floor((nextIdx + 1) * ratio);
          for (let srcIdx = startIdx; srcIdx < endIdx && srcIdx < currentMatches.length; srcIdx++) {
            drawConnector(currentMatches[srcIdx], nextMatch, svg, bracketRect);
          }
        });
      } else {
        // Less than 2-to-1: connect in order
        const minLength = Math.min(currentMatches.length, nextMatches.length);
        for (let idx = 0; idx < minLength; idx++) {
          drawConnector(currentMatches[idx], nextMatches[idx], svg, bracketRect);
        }
      }
    }
  }
  
  // Setup hover effects for path highlighting
  setupPathHighlighting(bracketContainer);
}

function drawConnector(fromMatch, toMatch, svg, bracketRect, position = 'middle') {
  if (!fromMatch || !toMatch) return;
  
  const fromRect = fromMatch.getBoundingClientRect();
  const toRect = toMatch.getBoundingClientRect();
  
  // Calculate positions relative to bracket container
  // Always start from center-right of source match
  const x1 = fromRect.right - bracketRect.left;
  const y1 = fromRect.top + fromRect.height / 2 - bracketRect.top;
  
  // Always end at center-left of destination match
  const x2 = toRect.left - bracketRect.left;
  const y2 = toRect.top + toRect.height / 2 - bracketRect.top;
  
  // Create path with horizontal then vertical segments
  const midX = x1 + (x2 - x1) / 2;
  
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  const pathData = `M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`;
  
  path.setAttribute('d', pathData);
  path.setAttribute('stroke', '#4b5563');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('fill', 'none');
  path.setAttribute('opacity', '0.6');
  path.classList.add('bracket-connector');
  
  // Store match IDs for path highlighting
  const fromMatchId = fromMatch.getAttribute('data-match-id');
  const toMatchId = toMatch.getAttribute('data-match-id');
  if (fromMatchId) path.setAttribute('data-from-match', fromMatchId);
  if (toMatchId) path.setAttribute('data-to-match', toMatchId);
  
  svg.appendChild(path);
}

function drawHorizontalConnector(fromMatch, toMatch, svg, bracketRect) {
  if (!fromMatch || !toMatch) return;
  
  const fromRect = fromMatch.getBoundingClientRect();
  const toRect = toMatch.getBoundingClientRect();
  
  // Start from center-bottom of first match
  const x1 = fromRect.left + fromRect.width / 2 - bracketRect.left;
  const y1 = fromRect.bottom - bracketRect.top;
  
  // End at center-top of second match
  const x2 = toRect.left + toRect.width / 2 - bracketRect.left;
  const y2 = toRect.top - bracketRect.top;
  
  // Vertical line connecting the two matches
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  const pathData = `M ${x1} ${y1} L ${x2} ${y2}`;
  
  path.setAttribute('d', pathData);
  path.setAttribute('stroke', '#4b5563');
  path.setAttribute('stroke-width', '2');
  path.setAttribute('fill', 'none');
  path.setAttribute('opacity', '0.6');
  path.classList.add('bracket-connector');
  
  // Store match IDs for path highlighting
  const fromMatchId = fromMatch.getAttribute('data-match-id');
  const toMatchId = toMatch.getAttribute('data-match-id');
  if (fromMatchId) path.setAttribute('data-from-match', fromMatchId);
  if (toMatchId) path.setAttribute('data-to-match', toMatchId);
  
  svg.appendChild(path);
}

function setupPathHighlighting(bracketContainer) {
  if (!bracketContainer) return;
  
  const allMatchWrappers = bracketContainer.querySelectorAll('.bracket-match-wrapper');
  const svg = bracketContainer.parentElement.querySelector('svg');
  if (!svg) return;
  
  // Build a map of match connections: matchId -> [previous match IDs where player came from]
  const matchConnections = new Map();
  const allConnectors = svg.querySelectorAll('.bracket-connector');
  
  allConnectors.forEach(connector => {
    const fromMatchId = connector.getAttribute('data-from-match');
    const toMatchId = connector.getAttribute('data-to-match');
    if (fromMatchId && toMatchId) {
      if (!matchConnections.has(toMatchId)) {
        matchConnections.set(toMatchId, []);
      }
      matchConnections.get(toMatchId).push(fromMatchId);
    }
  });
  
  // Helper to get player names from a match card
  const getPlayerNames = (matchCard) => {
    if (!matchCard) return [];
    // Get the two player divs (first two children with display:flex)
    const playerDivs = matchCard.querySelectorAll(':scope > div');
    const names = [];
    playerDivs.forEach(div => {
      // Find the span that contains the player name
      const nameSpan = div.querySelector('span > span[title]');
      if (nameSpan) {
        names.push(nameSpan.textContent.trim());
      } else {
        // Fallback: check for TBD or direct text
        const firstSpan = div.querySelector('span');
        if (firstSpan) {
          const text = firstSpan.textContent.trim();
          if (text && text !== 'TBD') {
            names.push(text);
          }
        }
      }
    });
    return names;
  };
  
  // Helper to check if a match card contains a player
  const matchContainsPlayer = (matchCard, playerName) => {
    const names = getPlayerNames(matchCard);
    return names.some(name => name === playerName);
  };
  
  const clearHighlights = () => {
    // Remove all highlights
    allMatchWrappers.forEach(wrapper => {
      const card = wrapper.querySelector('[id^="match-"]');
      if (card) {
        card.style.boxShadow = '';
        // Reset border color to original based on card type
        // Grand Finals cards have gold border (#fbbf24), others have gray (#374151)
        const isGrandFinal = card.style.border && card.style.border.includes('#fbbf24');
        card.style.borderColor = isGrandFinal ? '#fbbf24' : '#374151';
      }
    });
    
    // Reset all connectors
    allConnectors.forEach(connector => {
      connector.style.stroke = '#4b5563';
      connector.style.opacity = '0.6';
      connector.style.strokeWidth = '2';
    });
  };
  
  const highlightPlayerPath = (playerName, startMatchId) => {
    if (!playerName) return;
    
    // Trace player's path backwards through the bracket
    const playerPath = new Set();
    playerPath.add(startMatchId);
    
    const traceBackwards = (matchId) => {
      const previousMatches = matchConnections.get(matchId) || [];
      
      previousMatches.forEach(prevMatchId => {
        // Skip if already in path
        if (playerPath.has(prevMatchId)) return;
        
        // Find the match wrapper with this ID
        const prevWrapper = Array.from(allMatchWrappers).find(
          w => w.getAttribute('data-match-id') === prevMatchId
        );
        
        if (!prevWrapper) return;
        
        const prevCard = prevWrapper.querySelector('[id^="match-"]');
        if (!prevCard) return;
        
        // Check if this previous match contains our player
        if (matchContainsPlayer(prevCard, playerName)) {
          playerPath.add(prevMatchId);
          // Continue tracing backwards
          traceBackwards(prevMatchId);
        }
      });
    };
    
    traceBackwards(startMatchId);
    
    // Highlight matches in the player's path
    allMatchWrappers.forEach(wrapper => {
      const matchId = wrapper.getAttribute('data-match-id');
      const card = wrapper.querySelector('[id^="match-"]');
      
      if (card && playerPath.has(matchId)) {
        card.style.boxShadow = '0 0 12px 2px rgba(251, 191, 36, 0.6)';
        card.style.borderColor = '#fbbf24';
        card.style.transition = 'all 0.2s ease';
      }
    });
    
    // Highlight connectors in the path
    allConnectors.forEach(connector => {
      const fromMatchId = connector.getAttribute('data-from-match');
      const toMatchId = connector.getAttribute('data-to-match');
      
      if (playerPath.has(fromMatchId) && playerPath.has(toMatchId)) {
        connector.style.stroke = '#fbbf24';
        connector.style.opacity = '1';
        connector.style.strokeWidth = '3';
      } else {
        connector.style.opacity = '0.2';
      }
    });
  };
  
  allMatchWrappers.forEach(matchWrapper => {
    const matchCard = matchWrapper.querySelector('[id^="match-"]');
    if (!matchCard) return;
    
    const currentMatchId = matchWrapper.getAttribute('data-match-id');
    
    // Get the two player rows (the divs directly inside the card)
    const playerRows = matchCard.querySelectorAll(':scope > div');
    
    playerRows.forEach((row, rowIndex) => {
      // Find player name in this row
      const nameSpan = row.querySelector('span > span[title]');
      let playerName = null;
      
      if (nameSpan) {
        playerName = nameSpan.textContent.trim();
      } else {
        const firstSpan = row.querySelector('span');
        if (firstSpan) {
          const text = firstSpan.textContent.trim();
          if (text && text !== 'TBD') {
            playerName = text;
          }
        }
      }
      
      if (!playerName) return;
      
      // Add hover events to the row
      row.addEventListener('mouseenter', () => {
        clearHighlights();
        highlightPlayerPath(playerName, currentMatchId);
      });
    });
    
    // Add mouseleave to the entire card for clean reset
    matchCard.addEventListener('mouseleave', () => {
      clearHighlights();
    });
  });
}

function getRoundNameForBracket(round, bracketType, totalRounds, roundIndex, isDoubleElimination = false, isPoolBracket = false) {
  const roundsFromEnd = totalRounds - roundIndex - 1;

  // Pool bracket naming for Start.gg (uses rounds from start, not from end)
  if (isPoolBracket) {
    if (bracketType === 'winner') {
      // Winners bracket in pool - use roundIndex (0-based) to determine round name
      // For a typical 4-player pool: Round 1 = Quarts, Round 2 = Semis (Winners Finals for pool)
      if (roundsFromEnd === 0) {
        // Last winners round in pool = Winners Semi-Finals (leads to pool finals)
        return i18n.t('tournamentDetail.winnersSemiFinal') || 'Winners Semi-Final';
      }
      if (roundsFromEnd === 1) {
        // Second to last = Winners Quarter-Finals
        return i18n.t('tournamentDetail.winnersQuarterFinal') || 'Winners Quarter-Final';
      }
      return `${i18n.t('tournamentDetail.winnersRound') || 'Winners Round'} ${roundIndex + 1}`;
    }
    // Losers bracket in pool
    if (roundIndex === 0) {
      // First losers round = Losers Round 1
      return `${i18n.t('tournamentDetail.losersRound') || 'Losers Round'} 1`;
    }
    if (roundsFromEnd === 0) {
      // Last losers round = Losers Quarter-Final (leads to pool finals loser side)
      return i18n.t('tournamentDetail.losersQuarterFinal') || 'Losers Quarter-Final';
    }
    return `${i18n.t('tournamentDetail.losersRound') || 'Losers Round'} ${roundIndex + 1}`;
  }

  // Single elimination / finals bracket (i18n)
  if (bracketType === 'winner' && !isDoubleElimination) {
    if (roundsFromEnd === 0) return i18n.t('tournamentDetail.finals') || 'Finale';
    if (roundsFromEnd === 1) return i18n.t('tournamentDetail.semiFinals') || 'Demi-finales';
    if (roundsFromEnd === 2) return i18n.t('tournamentDetail.quarterFinals') || 'Quarts de finale';
    if (roundsFromEnd === 3) return i18n.t('tournamentDetail.roundOf16') || 'Round of 16';
    if (roundsFromEnd === 4) return i18n.t('tournamentDetail.roundOf32') || 'Round of 32';
    if (roundsFromEnd === 5) return i18n.t('tournamentDetail.roundOf64') || 'Round of 64';
    return `${i18n.t('tournamentDetail.roundNumber') || 'Tour'} ${roundIndex + 1}`;
  }

  // Double elimination naming (i18n)
  if (bracketType === 'loser') {
    // roundIndex is now correct (0 = first losers round) thanks to platform-aware sort
    // Only use named rounds (Final, Semifinals, etc.) when there are enough rounds (>=4)
    // For small brackets (preliminary phases with 2-3 rounds), use simple numbered rounds
    if (totalRounds >= 4) {
      if (roundsFromEnd === 0) return i18n.t('tournamentDetail.lbFinal') || 'LB Final';
      if (roundsFromEnd === 1) return i18n.t('tournamentDetail.lbSemifinals') || 'LB Semifinals';
      if (roundsFromEnd === 2) return i18n.t('tournamentDetail.lbQuarterfinals') || 'LB Quarterfinals';
    }
    return `${i18n.t('tournamentDetail.losersRound') || 'LB Round'} ${roundIndex + 1}`;
  }

  // Winner bracket double elimination
  if (bracketType === 'winner') {
    // Only use named rounds (Grand Finals, WB Final, etc.) when there are enough rounds (>=4)
    // For small brackets (preliminary phases with 2-3 rounds), use simple numbered rounds
    if (totalRounds >= 4) {
      if (roundsFromEnd === 0) return `👑 ${i18n.t('tournamentDetail.grandFinals') || 'Grand Finals'}`;
      if (roundsFromEnd === 1) return i18n.t('tournamentDetail.wbFinal') || 'WB Final';
      if (roundsFromEnd === 2) return i18n.t('tournamentDetail.semifinals') || 'Semifinals';
      if (roundsFromEnd === 3) return i18n.t('tournamentDetail.quarterfinals') || 'Quarterfinals';
    }
    return `${i18n.t('tournamentDetail.wbRound') || 'Round'} ${roundIndex + 1}`;
  }

  // Fallback
  return `${i18n.t('tournamentDetail.losersRound') || 'LB Round'} ${roundIndex + 1}`;
}

function createBracketMatchCard(match, isFinal = false) {
  const card = document.createElement('div');
  // Stable id so clicking this bracket card can jump to the matches tab
  try { card.id = 'match-' + (match.challongeId || match.id || match._id || match.matchId || ''); } catch (e) {}
  try { card.style.cursor = 'pointer'; } catch (e) {}
  try {
    const bid = match.challongeId || match.id || match._id || match.matchId || '';
    if (bid) card.addEventListener('click', () => goToMatchById(bid));
  } catch (e) {}
  const cardStyle = isFinal 
    ? 'cursor: pointer; background-color: #1f2937; border-radius: 0.5rem; overflow: hidden; border: 2px solid #fbbf24; font-size: 1rem; max-width: 400px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3); outline: none;'
    : 'cursor: pointer; background-color: #1f2937; border-radius: 0.25rem; overflow: hidden; border: 1px solid #374151; font-size: 0.75rem; outline: none;';
  
  card.style.cssText = cardStyle;
  
  const player1Winner = match.winnerId === match.player1Id;
  const player2Winner = match.winnerId === match.player2Id;
  
  const padding = isFinal ? '0.75rem 1rem' : '0.35rem 0.5rem';
  const playerStyle = (isWinner, withDivider) => [
    'display: flex; justify-content: space-between; align-items: center;',
    `padding: ${padding};`,
    `background-color: ${isWinner ? '#065f46' : '#1f2937'};`,
    withDivider ? 'border-bottom: 1px solid #374151;' : '',
    'white-space: nowrap; overflow: hidden; text-overflow: ellipsis; gap: 0.5rem;'
  ].filter(Boolean).join(' ');
  
  // Only apply winner background if both players are defined (not TBD)
  const player1Style = playerStyle(player1Winner && match.player1Name && match.player2Name, true);
  const player2Style = playerStyle(player2Winner && match.player1Name && match.player2Name, false);
  
  const parsedScores = parseChallongeScores(match.scoresCsv, match.state);
  const getScore = (index) => {
    if (!parsedScores) return '';
    return index === 0 ? String(parsedScores.seriesP1) : String(parsedScores.seriesP2);
  };
  
  const truncateName = (name) => {
    if (!name) return i18n.t('tournamentDetail.tbd') || 'TBD';
    return name;
  };
  
  card.innerHTML = `
    <div class="bracket-player ${player1Winner ? 'bracket-winner spoiler-bracket-winner' : ''}" style="${player1Style}">
      <span class="${player1Winner ? 'spoiler-winner' : ''}" style="font-weight: ${player1Winner ? 'bold' : 'normal'}; color: ${player1Winner ? '#fbbf24' : '#d1d5db'}; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escHtml(match.player1Name || (i18n.t('tournamentDetail.tbd') || 'TBD'))}">
        ${match.player1Name ? `<span style="color: inherit; display: inline; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escHtml(match.player1Name)}">${escHtml(truncateName(sanitizeDisplayName(match.player1Name)))}</span>` : (i18n.t('tournamentDetail.tbd') || 'TBD')}
      </span>
      ${match.scoresCsv ? `<span class="spoiler-block" style="color: #9ca3af; font-weight: bold; margin-left: 0.5rem; flex-shrink: 0;">${getScore(0)}</span>` : ''}
    </div>
    <div class="bracket-player ${player2Winner ? 'bracket-winner spoiler-bracket-winner' : ''}" style="${player2Style}">
      <span class="${player2Winner ? 'spoiler-winner' : ''}" style="font-weight: ${player2Winner ? 'bold' : 'normal'}; color: ${player2Winner ? '#fbbf24' : '#d1d5db'}; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escHtml(match.player2Name || (i18n.t('tournamentDetail.tbd') || 'TBD'))}">
        ${match.player2Name ? `<span style="color: inherit; display: inline; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escHtml(match.player2Name)}">${escHtml(truncateName(sanitizeDisplayName(match.player2Name)))}</span>` : (i18n.t('tournamentDetail.tbd') || 'TBD')}
      </span>
      ${match.scoresCsv ? `<span class="spoiler-block" style="color: #9ca3af; font-weight: bold; margin-left: 0.5rem; flex-shrink: 0;">${getScore(1)}</span>` : ''}
    </div>
  `;
  
  // Add match state indicator only for 'open' matches (ongoing)
  if (match.state === 'open') {
    const stateIndicator = document.createElement('div');
    stateIndicator.style.cssText = 'padding: 0.25rem; text-align: center; background-color: #374151; font-size: 0.75rem; color: #9ca3af;';
    stateIndicator.textContent = formatMatchState(match.state);
    card.appendChild(stateIndicator);
  }

  // Tooltip: détail des manches sur le bracket uniquement (pas dans l'onglet Matchs).
  // When races are linked in a specific order (via raceUrls), build games from actual race data
  let tooltipScores = parsedScores;
  if (match.raceUrls && match.raceUrls.length >= 2 && typeof currentRaces !== 'undefined' && currentRaces.length > 0) {
    const matchRaces = findRacesForMatch(match, currentRaces);
    if (matchRaces.length >= 2) {
      // Build games from actual race results
      const p1Name = (match.player1Name || '').toLowerCase();
      const p2Name = (match.player2Name || '').toLowerCase();
      const realGames = [];
      let cum1 = 0, cum2 = 0;
      for (const race of matchRaces) {
        if (!race.entrants || race.entrants.length < 2) {
          realGames.push({ p1: 0, p2: 0, ambiguous: false });
          continue;
        }
        // Find winner: entrant with place === 1
        const winner = race.entrants.find(e => e.place === 1);
        if (!winner) {
          realGames.push({ p1: 0, p2: 0, ambiguous: false });
          continue;
        }
        const winnerName = (winner.user?.name || winner.userName || '').toLowerCase();
        // Match winner to player1 or player2
        const isP1 = winnerName === p1Name || p1Name.includes(winnerName) || winnerName.includes(p1Name);
        const isP2 = winnerName === p2Name || p2Name.includes(winnerName) || winnerName.includes(p2Name);
        if (isP1) {
          realGames.push({ p1: 1, p2: 0, ambiguous: false });
          cum1++;
        } else if (isP2) {
          realGames.push({ p1: 0, p2: 1, ambiguous: false });
          cum2++;
        } else {
          // Couldn't determine — use player aliases if available, else fallback
          realGames.push({ p1: 0, p2: 0, ambiguous: true });
        }
      }
      tooltipScores = {
        games: realGames,
        seriesP1: cum1,
        seriesP2: cum2,
        played: realGames.length,
        denom: realGames.length,
        label: `${cum1}-${cum2}`,
        isMultiGame: true,
        isSeriesOnly: false
      };
    }
  } else if (tooltipScores && tooltipScores.isSeriesOnly && match.raceUrls && match.raceUrls.length >= 2) {
    // Fallback: just remove "ordre non contractuel" when raceUrls ordering is available
    tooltipScores.isSeriesOnly = false;
    if (tooltipScores.games) {
      tooltipScores.games.forEach(g => { g.ambiguous = false; });
    }
  }
  try { attachMatchTooltip(card, match, tooltipScores); } catch (e) {}
  
  return card;
}
