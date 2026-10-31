// Server-side SEO for the public HTML pages.
//
// The pages are static files whose metadata used to be set only by
// public/js/seo.js once the browser ran it. Crawlers that do not execute
// JavaScript (social previews, Bing, Discord, Slack...) saw a bare <title>.
// This module renders the title, description, canonical, Open Graph,
// Twitter and JSON-LD tags into the HTML before it is sent, looking up the
// game, tournament, player or race for the detail pages.

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { Game, Tournament, Player, Race } = require('../models');
const { calculateTournamentStatus } = require('../helpers/tournament-status');
const { buildPlayerRacesFilter } = require('../helpers/player-races-filter');
const { countPlayerTournaments } = require('../helpers/player-tournaments');
const { gameLabel, tournamentGameLabel } = require('../helpers/game-label');
const { coverUrl } = require('../helpers/game-covers');
const { readHistory } = require('../helpers/game-history');
const { cachedGameStats } = require('../routes/games');
const { LANGUAGES, localizedPath } = require('../helpers/site-routes');
const { texts, fill, count } = require('./seo-texts');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// Square logo for social previews and the Organization logo
const DEFAULT_IMAGE_PATH = '/assets/icon-512.png';

// Public page templates; their titles and descriptions are in seo-texts.js.
// The search and comparison pages answer any query: not worth indexing.
const PAGE_ROBOTS = {
  '/search.html': 'noindex,follow',
  '/compare-players.html': 'noindex,follow'
};
const PAGE_FILES = Object.keys(texts('en').pages);

const templateCache = new Map();

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// JSON inside <script type="application/ld+json"> must not be able to close the tag.
function jsonLdEscape(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function normalizeDescription(text, maxLength = 160) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  const clipped = normalized.slice(0, maxLength - 1);
  const boundary = clipped.lastIndexOf(' ');
  return `${(boundary > 100 ? clipped.slice(0, boundary) : clipped).trim()}...`;
}

function absoluteUrl(siteUrl, input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  try {
    const resolved = new URL(raw, `${siteUrl}/`);
    return /^https?:$/i.test(resolved.protocol) ? resolved.href : '';
  } catch {
    return '';
  }
}

function breadcrumb(siteUrl, items, lang = 'en') {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: absoluteUrl(siteUrl, localizedPath(lang, item.url))
    }))
  };
}

function compact(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

async function findGameForRaceCategory(category) {
  const slug = String(category || '').toLowerCase().trim();
  if (!slug) return null;
  return Game.findOne({
    $or: [
      { 'integrations.racetime.gameSlug': slug },
      { 'integrations.racetime.gameSlugs': slug },
      { id: slug }
    ]
  }).select('id name official randomizer').lean();
}

async function gameMeta(query, siteUrl, lang) {
  const t = texts(lang);
  const id = String(query.id || '').trim();
  if (!id) return null;
  const game = await Game.findOne({ id, enabled: { $ne: false } }).lean();
  if (!game) return null;

  const displayTitle = gameLabel(game) || 'Game';
  const gameName = game.official?.name || game.name || displayTitle;
  // Each page gets its own description: what the randomizer does (the first
  // sentence of its history) and how much of it the site follows
  const [history, stats] = await Promise.all([
    readHistory(game.id).catch(() => null),
    cachedGameStats(game.id)
  ]);
  // Histories are written in English and French: no sentence in another language
  const intro = String(history?.intro?.[lang] || '').trim();
  const firstSentence = intro.match(/^.+?[.!?](?=\s|$)/)?.[0] || intro;
  const counts = stats && [
    stats.totalRaces && count(lang, 'races', stats.totalRaces),
    stats.totalTournaments && count(lang, 'tournaments', stats.totalTournaments)
  ].filter(Boolean);
  const lead = displayTitle !== gameName ? fill(t.gameLead, { title: displayTitle, game: gameName }) : displayTitle;
  // The counts first: past 160 characters, search results cut the end
  const description = counts?.length
    ? `${fill(t.gameCounts, { title: displayTitle, counts: counts.join(t.and) })} ${firstSentence}`.trim()
    : (firstSentence ? `${firstSentence} ${t.gameFallback}` : fill(t.gameFallbackLead, { lead }));
  const canonicalPath = `/games/${encodeURIComponent(game.id)}`;
  const image = coverUrl(game.id);
  // The site shown on the page (chosen official site, else the only known site, else the legacy
  // field); a Discord thread says nothing about the randomizer's identity
  const resources = game.resources || {};
  const website = resources.officialSite?.url || (resources.sites?.length === 1 ? resources.sites[0].url : '') || game.randomizer?.website;
  const sameAs = [website]
    .filter((url) => /^https?:\/\//i.test(String(url || '')) && !/^https?:\/\/(www\.)?discord\.(com|gg)\//i.test(url));

  return {
    title: `${displayTitle} - Randomizer`,
    heading: displayTitle,
    description,
    canonicalPath,
    image,
    jsonLd: [
      breadcrumb(siteUrl, [
        { name: t.crumbs.home, url: '/' },
        { name: t.crumbs.games, url: '/games' },
        { name: displayTitle, url: canonicalPath }
      ], lang),
      // The page is about the randomizer, a modified version of the base game:
      // its site is the randomizer's, never the base game's
      compact({
        '@context': 'https://schema.org',
        '@type': 'VideoGame',
        name: displayTitle,
        url: absoluteUrl(siteUrl, localizedPath(lang, canonicalPath)),
        inLanguage: lang,
        image: absoluteUrl(siteUrl, image) || undefined,
        description: normalizeDescription(intro || description, 500),
        isBasedOn: displayTitle !== gameName ? compact({
          '@type': 'VideoGame',
          name: gameName,
          gamePlatform: game.platforms?.length ? game.platforms : undefined
        }) : undefined,
        sameAs: sameAs.length ? sameAs : undefined
      })
    ]
  };
}

const TOURNAMENT_STATUS_KEYS = { 'à venir': 'upcoming', 'en cours': 'ongoing', 'terminé': 'completed' };

function tournamentStatus(tournament, lang) {
  if (!tournament.startDate && !tournament.endDate) return '';
  return texts(lang).status[TOURNAMENT_STATUS_KEYS[calculateTournamentStatus(tournament)]] || '';
}

async function tournamentMeta(query, siteUrl, lang) {
  const t = texts(lang);
  const id = String(query.id || '').trim();
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  const tournament = await Tournament.findById(id).populate('game', 'id name official randomizer').lean();
  if (!tournament) return null;

  const tournamentGame = tournamentGameLabel(tournament) || 'randomizer';
  const status = tournamentStatus(tournament, lang);
  const participants = Number(tournament.participantsCount) || (Array.isArray(tournament.participants) ? tournament.participants.length : 0);
  // "Upcoming <game> tournament" in English, "Tournoi <game> à venir" in French
  const description = fill(t.tournamentDescription, {
    name: tournament.name,
    game: tournamentGame,
    status: status ? (t.statusAfter ? ` ${status}` : `${status} `) : '',
    participants: participants ? fill(t.tournamentParticipants, { participants: count(lang, 'participants', participants) }) : ''
  });
  const canonicalPath = `/tournaments/${encodeURIComponent(String(tournament._id))}`;
  const image = coverUrl(tournament.game?.id);

  return {
    title: fill(t.tournamentTitle, { name: tournament.name }),
    heading: tournament.name,
    description,
    canonicalPath,
    image,
    jsonLd: [
      breadcrumb(siteUrl, [
        { name: t.crumbs.home, url: '/' },
        { name: t.crumbs.tournaments, url: '/tournaments' },
        { name: tournament.name, url: canonicalPath }
      ], lang),
      // Google requires a start date on an Event: undated tournaments get none
      tournament.startDate && compact({
        '@context': 'https://schema.org',
        '@type': 'Event',
        name: tournament.name,
        url: absoluteUrl(siteUrl, localizedPath(lang, canonicalPath)),
        startDate: tournament.startDate ? new Date(tournament.startDate).toISOString() : undefined,
        endDate: tournament.endDate ? new Date(tournament.endDate).toISOString() : undefined,
        eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
        // Challonge `url` is a bare slug: only a full address is a location
        location: { '@type': 'VirtualLocation', url: [tournament.fullUrl, tournament.url].find((u) => /^https?:\/\//i.test(String(u || ''))) || absoluteUrl(siteUrl, canonicalPath) },
        image: absoluteUrl(siteUrl, image) || undefined,
        description
      })
    ].filter(Boolean)
  };
}

// Race count and most played games of a player, for a preview worth clicking.
async function playerRaceSummary(player) {
  const { filter } = player.userId
    ? buildPlayerRacesFilter({ userId: player.userId, aliases: player.aliases })
    : buildPlayerRacesFilter({ names: [player.name], aliases: player.aliases });
  const byCategory = await Race.aggregate([
    { $match: filter },
    { $group: { _id: '$category', count: { $sum: 1 } } }
  ]).option({ maxTimeMS: 3000 });

  // Several racetime categories can belong to one game
  const byGame = new Map();
  await Promise.all(byCategory.map(async ({ _id: category, count }) => {
    const game = await findGameForRaceCategory(category);
    const key = game?.id || category;
    const entry = byGame.get(key) || { name: gameLabel(game) || category, count: 0 };
    entry.count += count;
    byGame.set(key, entry);
  }));

  const games = [...byGame.values()].sort((a, b) => b.count - a.count);
  return {
    total: games.reduce((sum, g) => sum + g.count, 0),
    games: games.slice(0, 2).map((g) => g.name).filter(Boolean)
  };
}

async function playerMeta(query, siteUrl, lang) {
  const t = texts(lang);
  const id = String(query.id || '').trim();
  const name = String(query.name || '').trim();
  let player = null;
  if (id) {
    player = await Player.findOne({ userId: id }).lean();
  } else if (name) {
    player = await Player.findOne({ name }).collation({ locale: 'en', strength: 2 }).lean();
  }
  if (!player) return null;

  const playerName = player.name || player.userId;
  // Counted as the page counts them (/api/players/:id/races and /tournaments).
  // A slow count must not cost the whole preview: fall back to the generic text.
  const [{ total: racesCount, games }, tournamentsCount] = await Promise.all([
    playerRaceSummary(player),
    countPlayerTournaments({ Tournament, userId: player.userId || null, names: [player.name, ...(player.aliases || [])] })
  ]).catch((error) => {
    console.error('SEO counts failed for player:', error.message);
    return [{ total: 0, games: [] }, 0];
  });
  const facts = [
    racesCount && `${count(lang, 'races', racesCount)}${games.length ? ` (${games.join(', ')})` : ''}`,
    tournamentsCount && count(lang, 'tournaments', tournamentsCount)
  ].filter(Boolean);
  const description = facts.length
    ? fill(t.playerFacts, { name: playerName, facts: facts.join(', ') })
    : fill(t.playerFallback, { name: playerName });
  const canonicalPath = player.userId
    ? `/players/${encodeURIComponent(player.userId)}`
    : `/players/name/${encodeURIComponent(playerName)}`;
  const sameAs = [
    player.racetimeUrl,
    player.challongeUrl,
    player.twitch ? `https://www.twitch.tv/${encodeURIComponent(player.twitch)}` : ''
  ].filter((url) => /^https?:\/\//i.test(String(url || '')));

  return {
    title: fill(t.playerTitle, { name: playerName }),
    heading: playerName,
    description,
    canonicalPath,
    ogType: 'profile',
    jsonLd: [
      breadcrumb(siteUrl, [
        { name: t.crumbs.home, url: '/' },
        { name: t.crumbs.players, url: '/players' },
        { name: playerName, url: canonicalPath }
      ], lang),
      {
        '@context': 'https://schema.org',
        '@type': 'ProfilePage',
        url: absoluteUrl(siteUrl, localizedPath(lang, canonicalPath)),
        inLanguage: lang,
        mainEntity: compact({
          '@type': 'Person',
          name: playerName,
          alternateName: player.aliases?.length ? player.aliases.slice(0, 10) : undefined,
          sameAs: sameAs.length ? sameAs : undefined
        })
      }
    ]
  };
}

async function raceMeta(query, siteUrl, lang) {
  const t = texts(lang);
  const id = String(query.id || '').trim();
  const url = String(query.url || '').trim();
  let race = null;
  if (id && mongoose.Types.ObjectId.isValid(id)) {
    race = await Race.findById(id).select('-info').lean();
  } else if (url) {
    const racePath = url.replace(/^https?:\/\/racetime\.gg/i, '').replace(/^\/+/, '');
    race = await Race.findOne({ url: { $in: [racePath, `/${racePath}`] } }).select('-info').lean();
  }
  if (!race) return null;

  const [game, tournament] = await Promise.all([
    findGameForRaceCategory(race.category),
    race.tournamentId ? Tournament.findById(race.tournamentId).select('name').lean() : null
  ]);
  const gameName = gameLabel(game) || race.category;
  const goal = String(race.goal || '').trim() || 'Race';
  const matchup = String(race.matchPlayers || '').trim();
  const label = matchup ? `${matchup} (${goal})` : goal;
  const entrants = Array.isArray(race.entrants) ? race.entrants.length : 0;
  const day = race.startedAt ? new Date(race.startedAt).toISOString().slice(0, 10) : '';
  const parts = [fill(t.raceLead, { game: gameName }), `${label}, ${count(lang, 'entrants', entrants)}.`];
  if (day) parts.push(fill(t.raceStarted, { day }));
  if (tournament?.name) parts.push(fill(t.raceTournament, { name: tournament.name }));
  const description = parts.join(' ');
  const canonicalPath = `/races/${encodeURIComponent(String(race._id))}`;
  const image = coverUrl(game?.id);

  return {
    // Thousands of races share a goal: the day tells their pages apart
    title: fill(t.raceTitle, { label, game: gameName, day: day ? ` (${day})` : '' }),
    heading: gameName,
    description,
    canonicalPath,
    image,
    jsonLd: [
      breadcrumb(siteUrl, [
        { name: t.crumbs.home, url: '/' },
        { name: t.crumbs.races, url: '/races' },
        { name: `${gameName} - ${label}`, url: canonicalPath }
      ], lang)
      // No Event: a race is not an event people attend, and Event markup on
      // thousands of races would be reported as invalid by search engines
    ]
  };
}

// <h1> of each detail page, filled by its script; the server writes the entity
// name in it so crawlers that skip JavaScript do not read "Loading..."
const DETAIL_HEADING_IDS = {
  '/game-detail.html': 'game-meta',
  '/tournament-detail.html': 'tournament-title',
  '/player-detail.html': 'player-name',
  '/race-detail.html': 'race-game'
};

const DETAIL_RESOLVERS = {
  '/game-detail.html': gameMeta,
  '/tournament-detail.html': tournamentMeta,
  '/player-detail.html': playerMeta,
  '/race-detail.html': raceMeta
};

function websiteSchema(siteUrl, lang) {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'Randomizer',
      url: `${siteUrl}/`,
      inLanguage: LANGUAGES,
      potentialAction: {
        '@type': 'SearchAction',
        target: `${siteUrl}${localizedPath(lang, '/search')}?q={search_term_string}`,
        'query-input': 'required name=search_term_string'
      }
    },
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: 'Randomizer',
      url: `${siteUrl}/`,
      logo: `${siteUrl}${DEFAULT_IMAGE_PATH}`
    }
  ];
}

function readTemplate(file) {
  if (process.env.NODE_ENV === 'production' && templateCache.has(file)) {
    return templateCache.get(file);
  }
  const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
  templateCache.set(file, html);
  return html;
}

function renderHead(meta, siteUrl, lang, titleAttrs = '') {
  const canonical = `${siteUrl}${localizedPath(lang, meta.canonicalPath)}`;
  const indexable = !String(meta.robots || '').includes('noindex');
  const image = absoluteUrl(siteUrl, meta.image) || `${siteUrl}${DEFAULT_IMAGE_PATH}`;
  const title = htmlEscape(meta.title);
  const description = htmlEscape(normalizeDescription(meta.description));
  const lines = [
    `<title${titleAttrs}>${title}</title>`,
    `<meta name="description" content="${description}">`,
    `<meta name="robots" content="${htmlEscape(meta.robots || 'index,follow')}">`,
    `<link rel="canonical" href="${htmlEscape(canonical)}">`,
    `<meta property="og:type" content="${htmlEscape(meta.ogType || 'website')}">`,
    '<meta property="og:site_name" content="Randomizer">',
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:url" content="${htmlEscape(canonical)}">`,
    `<meta property="og:image" content="${htmlEscape(image)}">`,
    `<meta property="og:image:alt" content="${title}">`,
    `<meta property="og:locale" content="${texts(lang).locale}">`,
    ...LANGUAGES.filter((other) => other !== lang).map((other) => `<meta property="og:locale:alternate" content="${texts(other).locale}">`),
    // Covers are small and vertical, the logo square: a large card would crop them.
    '<meta name="twitter:card" content="summary">',
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${description}">`,
    `<meta name="twitter:image" content="${htmlEscape(image)}">`
  ];
  // The same page in every language; English, without prefix, for the others
  if (indexable) {
    for (const other of LANGUAGES) {
      lines.push(`<link rel="alternate" hreflang="${other}" href="${htmlEscape(`${siteUrl}${localizedPath(other, meta.canonicalPath)}`)}">`);
    }
    lines.push(`<link rel="alternate" hreflang="x-default" href="${htmlEscape(`${siteUrl}${meta.canonicalPath}`)}">`);
  }
  if (meta.jsonLd) {
    lines.push(`<script type="application/ld+json" id="seo-structured-data">${jsonLdEscape(meta.jsonLd)}</script>`);
  }
  return lines.join('\n  ');
}

// Returns { status, html } for a public page (a route from helpers/site-routes.js),
// or null when it is not one.
async function renderPage(route, siteUrl) {
  const { file } = route;
  const lang = route.lang || 'en';
  const query = route.params || {};
  if (!PAGE_FILES.includes(file)) return null;

  const [title, description] = texts(lang).pages[file];
  let meta = { title, description, robots: PAGE_ROBOTS[file], canonicalPath: route.path };
  let status = 200;
  let specific = false;

  if (file === '/index.html') {
    meta.jsonLd = websiteSchema(siteUrl, lang);
  }

  const resolver = DETAIL_RESOLVERS[file];
  if (resolver) {
    const hasParams = ['id', 'name', 'url'].some((key) => query[key]);
    let detail = null;
    try {
      detail = hasParams ? await resolver(query, siteUrl, lang) : null;
    } catch (error) {
      console.error(`SEO lookup failed for ${file}:`, error.message);
      detail = undefined; // lookup error: serve the generic page, do not claim a 404
    }
    if (detail) {
      meta = { ...meta, ...detail };
      specific = true;
    } else if (detail === null) {
      // Missing or unknown entity: tell crawlers instead of indexing an empty shell.
      status = hasParams ? 404 : 200;
      meta.robots = 'noindex,follow';
    }
  }

  // The rendered head carries its own robots tag.
  let html = readTemplate(file).replace(/\n[ \t]*<meta name="robots"[^>]*>/i, '');
  html = html.replace(/<title([^>]*)>[\s\S]*?<\/title>/i, (match, attrs) => (
    // An entity title must not be reset to the generic translated one by i18n.js,
    // but other attributes (the id the page scripts look up) are kept.
    renderHead(meta, siteUrl, lang, specific ? attrs.replace(/\s+data-i18n-page-title="[^"]*"/i, '') : attrs)
  ));
  // The language of the address; i18n.js and seo.js leave the server's title
  // alone while the page shows that language
  html = html.replace(/<html([^>]*)>/i, (match, attrs) => (
    `<html${attrs.replace(/\s+lang="[^"]*"/i, '')} lang="${lang}" data-seo-lang="${lang}">`
  ));
  if (specific && meta.heading && DETAIL_HEADING_IDS[file]) {
    const headingRe = new RegExp(`<h1([^>]*\\sid="${DETAIL_HEADING_IDS[file]}"[^>]*)>[\\s\\S]*?<\\/h1>`, 'i');
    html = html.replace(headingRe, (match, attrs) => (
      // Without data-i18n, the translations do not put "Loading..." back
      `<h1${attrs.replace(/\s+data-i18n="[^"]*"/i, '')}>${htmlEscape(meta.heading)}</h1>`
    ));
  }
  if (specific) {
    // Tells seo.js the head already describes this entity.
    html = html.replace(/<html([^>]*)>/i, '<html$1 data-seo-ssr="1">');
  }

  return { status, html };
}

module.exports = { renderPage };
