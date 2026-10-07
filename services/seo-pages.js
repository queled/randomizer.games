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

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DEFAULT_IMAGE_PATH = '/assets/favicon.png';

const PAGE_META = {
  '/index.html': {
    title: 'Randomizer - Races, Tournaments and Players for Randomizer Games',
    description: 'Randomizer games, races, tournaments and players in one place. Follow racetime.gg races, Challonge and start.gg brackets and live streams.'
  },
  '/games.html': {
    title: 'Randomizer Games - Randomizer',
    description: 'Browse hundreds of randomizer games and explore their races, tournaments and community resources.'
  },
  '/races.html': {
    title: 'Randomizer Races - Randomizer',
    description: 'Explore recent and historical randomizer races from racetime.gg with entrants, results and finish times.'
  },
  '/tournaments.html': {
    title: 'Randomizer Tournaments - Randomizer',
    description: 'Browse randomizer tournaments from Challonge and start.gg with brackets, participants and linked races.'
  },
  '/players.html': {
    title: 'Randomizer Players - Randomizer',
    description: 'Discover randomizer players, their aliases, race results and tournament history.'
  },
  '/streams.html': {
    title: 'Live Randomizer Streams - Randomizer',
    description: 'Live and recent randomizer streams on Twitch, by game and category.'
  },
  '/resources.html': {
    title: 'Related Sites - Randomizer',
    description: 'Useful links and community resources for randomizer players.'
  },
  '/about.html': {
    title: 'About - Randomizer',
    description: 'About Randomizer and how the data is collected and displayed.'
  },
  '/terms.html': {
    title: 'Terms of Use - Randomizer',
    description: 'Terms of use and legal information for the Randomizer website.'
  },
  '/search.html': {
    title: 'Search - Randomizer',
    description: 'Search games, races, tournaments and players.',
    robots: 'noindex,follow'
  },
  '/compare-players.html': {
    title: 'Compare Players - Randomizer',
    description: 'Compare head-to-head randomizer player results and shared race history.',
    robots: 'noindex,follow'
  },
  '/game-detail.html': {
    title: 'Game - Randomizer',
    description: 'Game details, linked races and tournament context.'
  },
  '/tournament-detail.html': {
    title: 'Tournament - Randomizer',
    description: 'Tournament details, brackets and linked races.'
  },
  '/player-detail.html': {
    title: 'Player Profile - Randomizer',
    description: 'Player profile with results, aliases and game activity.'
  },
  '/race-detail.html': {
    title: 'Race - Randomizer',
    description: 'Race details, standings and related tournament information.'
  }
};

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

function breadcrumb(siteUrl, items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: absoluteUrl(siteUrl, item.url)
    }))
  };
}

function gameDisplayName(game) {
  return game?.randomizer?.displayName || game?.randomizer?.shortName || game?.official?.name || game?.name || '';
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
  }).select('id name official randomizer image logo').lean();
}

async function gameMeta(query, siteUrl) {
  const id = String(query.id || '').trim();
  if (!id) return null;
  const game = await Game.findOne({ id, enabled: { $ne: false } }).lean();
  if (!game) return null;

  // Race counts depend on the racetime category resolution in routes/games.js
  // (a scan over every game); the description sticks to what the document holds.
  const displayTitle = gameDisplayName(game) || 'Game';
  const gameName = game.official?.name || game.name || displayTitle;
  const description = displayTitle !== gameName
    ? `${displayTitle} for ${gameName}: races, tournaments, players and community resources on Randomizer.`
    : `${displayTitle}: races, tournaments, players and community resources on Randomizer.`;
  const canonicalPath = `/game-detail.html?id=${encodeURIComponent(game.id)}`;
  const image = game.image || game.logo;
  const sameAs = [game.randomizer?.website, game.officialWebsite, game.official?.website, game.resources?.officialSite?.url]
    .filter((url) => /^https?:\/\//i.test(String(url || '')));

  return {
    title: `${displayTitle} - Randomizer`,
    description,
    canonicalPath,
    image,
    jsonLd: [
      breadcrumb(siteUrl, [
        { name: 'Home', url: '/' },
        { name: 'Games', url: '/games.html' },
        { name: displayTitle, url: canonicalPath }
      ]),
      compact({
        '@context': 'https://schema.org',
        '@type': 'VideoGame',
        name: gameName,
        alternateName: displayTitle !== gameName ? displayTitle : undefined,
        url: absoluteUrl(siteUrl, canonicalPath),
        image: absoluteUrl(siteUrl, image) || undefined,
        description,
        sameAs: sameAs.length ? sameAs : undefined
      })
    ]
  };
}

function tournamentStatus(tournament) {
  // Mirrors getTournamentStatus() in public/js/tournament-detail.js.
  const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  if (['complete', 'awaiting_review'].includes(tournament.status) || tournament.state === 'complete') return 'Completed';
  if (tournament.startDate && now - new Date(tournament.startDate).getTime() >= YEAR_MS) return 'Completed';
  if (tournament.endDate && new Date(tournament.endDate).getTime() < now) return 'Completed';
  if (tournament.startDate && new Date(tournament.startDate).getTime() > now) return 'Upcoming';
  return tournament.startDate ? 'Ongoing' : '';
}

async function tournamentMeta(query, siteUrl) {
  const id = String(query.id || '').trim();
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  const tournament = await Tournament.findById(id).populate('game', 'id name official randomizer image logo').lean();
  if (!tournament) return null;

  const gameLabel = tournament.gameName || gameDisplayName(tournament.game) || 'randomizer';
  const status = tournamentStatus(tournament);
  const participants = Number(tournament.participantsCount) || (Array.isArray(tournament.participants) ? tournament.participants.length : 0);
  const description = `${tournament.name} on Randomizer. ${status ? `${status} ` : ''}${gameLabel} tournament${participants ? ` with ${participants} participants` : ''}. Explore bracket, participants and linked races.`;
  const canonicalPath = `/tournament-detail.html?id=${encodeURIComponent(String(tournament._id))}`;
  const image = tournament.game?.image || tournament.game?.logo;

  return {
    title: `${tournament.name} - Tournament - Randomizer`,
    description,
    canonicalPath,
    image,
    jsonLd: [
      breadcrumb(siteUrl, [
        { name: 'Home', url: '/' },
        { name: 'Tournaments', url: '/tournaments.html' },
        { name: tournament.name, url: canonicalPath }
      ]),
      compact({
        '@context': 'https://schema.org',
        '@type': 'Event',
        name: tournament.name,
        url: absoluteUrl(siteUrl, canonicalPath),
        startDate: tournament.startDate ? new Date(tournament.startDate).toISOString() : undefined,
        endDate: tournament.endDate ? new Date(tournament.endDate).toISOString() : undefined,
        eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
        location: { '@type': 'VirtualLocation', url: tournament.fullUrl || tournament.url || absoluteUrl(siteUrl, canonicalPath) },
        image: absoluteUrl(siteUrl, image) || undefined,
        description
      })
    ]
  };
}

async function playerMeta(query, siteUrl) {
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
  const tournamentsCount = Array.isArray(player.tournaments) ? player.tournaments.length : 0;
  const description = tournamentsCount
    ? `${playerName} on Randomizer: randomizer race results, ${tournamentsCount} tournament${tournamentsCount > 1 ? 's' : ''} and game activity.`
    : `${playerName} on Randomizer: randomizer race results, tournaments and game activity.`;
  const canonicalPath = player.userId
    ? `/player-detail.html?id=${encodeURIComponent(player.userId)}`
    : `/player-detail.html?name=${encodeURIComponent(playerName)}`;
  const sameAs = [
    player.racetimeUrl,
    player.challongeUrl,
    player.twitch ? `https://www.twitch.tv/${encodeURIComponent(player.twitch)}` : ''
  ].filter((url) => /^https?:\/\//i.test(String(url || '')));

  return {
    title: `${playerName} - Randomizer Player Profile`,
    description,
    canonicalPath,
    ogType: 'profile',
    jsonLd: [
      breadcrumb(siteUrl, [
        { name: 'Home', url: '/' },
        { name: 'Players', url: '/players.html' },
        { name: playerName, url: canonicalPath }
      ]),
      {
        '@context': 'https://schema.org',
        '@type': 'ProfilePage',
        url: absoluteUrl(siteUrl, canonicalPath),
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

// Races imported from SpeedRunsLive keep their SRL page in source.url
function getRaceExternalUrl(race) {
  if (race?.source?.type === 'speedrunslive' && race.source.url) return race.source.url;
  if (!race?.url) return null;
  return `https://racetime.gg${race.url.startsWith('/') ? '' : '/'}${race.url}`;
}

async function raceMeta(query, siteUrl) {
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
  const gameName = gameDisplayName(game) || race.category;
  const goal = String(race.goal || '').trim() || 'Race';
  const matchup = String(race.matchPlayers || '').trim();
  const label = matchup ? `${matchup} (${goal})` : goal;
  const entrants = Array.isArray(race.entrants) ? race.entrants.length : 0;
  const parts = [`${gameName} race on Randomizer.`, `${label}, ${entrants} entrants.`];
  if (race.startedAt) parts.push(`Started ${new Date(race.startedAt).toISOString().slice(0, 10)}.`);
  if (tournament?.name) parts.push(`Tournament: ${tournament.name}.`);
  const description = parts.join(' ');
  const canonicalPath = `/race-detail.html?id=${encodeURIComponent(String(race._id))}`;
  const image = game?.image || game?.logo;

  return {
    title: `${label} - ${gameName} Race - Randomizer`,
    description,
    canonicalPath,
    image,
    jsonLd: [
      breadcrumb(siteUrl, [
        { name: 'Home', url: '/' },
        { name: 'Races', url: '/races.html' },
        { name: `${gameName} - ${label}`, url: canonicalPath }
      ]),
      compact({
        '@context': 'https://schema.org',
        '@type': 'Event',
        name: `${gameName} - ${label}`,
        url: absoluteUrl(siteUrl, canonicalPath),
        startDate: race.startedAt ? new Date(race.startedAt).toISOString() : undefined,
        endDate: race.endedAt ? new Date(race.endedAt).toISOString() : undefined,
        eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
        location: { '@type': 'VirtualLocation', url: getRaceExternalUrl(race) || absoluteUrl(siteUrl, canonicalPath) },
        image: absoluteUrl(siteUrl, image) || undefined,
        description
      })
    ]
  };
}

const DETAIL_RESOLVERS = {
  '/game-detail.html': gameMeta,
  '/tournament-detail.html': tournamentMeta,
  '/player-detail.html': playerMeta,
  '/race-detail.html': raceMeta
};

function websiteSchema(siteUrl) {
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: 'Randomizer',
      url: `${siteUrl}/`,
      potentialAction: {
        '@type': 'SearchAction',
        target: `${siteUrl}/search.html?q={search_term_string}`,
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

function renderHead(meta, siteUrl, titleAttrs = '') {
  const canonical = `${siteUrl}${meta.canonicalPath}`;
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
    '<meta property="og:locale" content="en_US">',
    // Game artwork and the logo are small square images: a large card would crop them.
    '<meta name="twitter:card" content="summary">',
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${description}">`,
    `<meta name="twitter:image" content="${htmlEscape(image)}">`
  ];
  if (meta.jsonLd) {
    lines.push(`<script type="application/ld+json" id="seo-structured-data">${jsonLdEscape(meta.jsonLd)}</script>`);
  }
  return lines.join('\n  ');
}

// Returns { status, html } for a public page, or null when the path is not one.
async function renderPage(pathname, query, siteUrl) {
  const file = pathname === '/' ? '/index.html' : pathname;
  const base = PAGE_META[file];
  if (!base) return null;

  let meta = { ...base, canonicalPath: pathname === '/index.html' ? '/' : pathname };
  let status = 200;
  let specific = false;

  if (file === '/index.html') {
    meta.jsonLd = websiteSchema(siteUrl);
  }

  const resolver = DETAIL_RESOLVERS[file];
  if (resolver) {
    const hasParams = ['id', 'name', 'url'].some((key) => query[key]);
    let detail = null;
    try {
      detail = hasParams ? await resolver(query, siteUrl) : null;
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
    renderHead(meta, siteUrl, specific ? attrs.replace(/\s+data-i18n-page-title="[^"]*"/i, '') : attrs)
  ));
  if (specific) {
    // Tells seo.js the head already describes this entity.
    html = html.replace(/<html([^>]*)>/i, '<html$1 data-seo-ssr="1">');
  }

  return { status, html };
}

module.exports = { renderPage, PAGE_META };
