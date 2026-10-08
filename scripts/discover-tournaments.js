#!/usr/bin/env node
/**
 * Discover & Import Randomizer/Multiworld tournaments
 * 
 * Searches start.gg and challonge.com for tournaments matching randomizer games
 * already present in the database, and imports new ones.
 * 
 * Usage:
 *   node scripts/discover-tournaments.js                      # Full discovery (all sources)
 *   node scripts/discover-tournaments.js --source startgg     # Start.gg only
 *   node scripts/discover-tournaments.js --source challonge   # Challonge only
 *   node scripts/discover-tournaments.js --dry-run            # Preview without importing
 *   node scripts/discover-tournaments.js --keywords "keyword1,keyword2"  # Extra keywords
 *   node scripts/discover-tournaments.js --max-pages 5        # Limit pagination (start.gg short-name queries: 5 max)
 *   node scripts/discover-tournaments.js --since 2024-01-01   # Only tournaments after date
 *   node scripts/discover-tournaments.js --game ootr          # Only search for a specific game
 *   node scripts/discover-tournaments.js --source startgg --game oot --startgg-slug tournament/example
 *   node scripts/discover-tournaments.js --source speedgaming --dry-run   # Brackets listed on speedgaming.org/events
 *   node scripts/discover-tournaments.js --source midos --dry-run         # OoT brackets linked from midos.house
 *   node scripts/discover-tournaments.js --source speedgaming --challonge-url https://challonge.com/xyz
 */

const path = require('path');
const axios = require('axios');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Game, Tournament, Match, Race } = require('../models');
const StartGGAPI = require('../services/startgg');
const challongeAPI = require('../services/challonge');
const findGameForTournament = require('../helpers/findGameForTournament');
const sanitizeHtml = require('sanitize-html');
const { saveGroupedChallongeBracket } = require('../services/challonge-bracket-groups');
const { fillMissingFinalRanks } = require('../helpers/bracket-ranks');

// ─── Configuration ───────────────────────────────────────────────────────────

const RATE_LIMIT_MS = 1500; // ms between API calls
const DEFAULT_MAX_PAGES = null;
const STARTGG_RESULTS_PER_PAGE = 50;
const SPEEDGAMING_EVENTS_URL = 'https://speedgaming.org/events/';
const MIDOS_BASE_URL = 'https://midos.house';
const MIDOS_DELAY_MS = 300;

// Keywords that strongly indicate an actual randomizer / multiworld tournament
const RANDOMIZER_SIGNAL_KEYWORDS = [
  'randomizer', 'randomiser', 'rando',
  'multiworld', 'multi-world', 'multi world',
  'archipelago'
];

// Searched once for all games; distinctive randomizer short names are added per game
const STARTGG_GENERIC_QUERIES = ['randomizer', 'randomiser', 'rando', 'multiworld', 'archipelago'];
// Short-name queries ("sotn", "tpr"...) can match thousands of unrelated tournaments
const STARTGG_ALIAS_MAX_PAGES = 5;

// ─── CLI argument parsing ────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    source: 'all',       // 'all', 'startgg', 'challonge', 'speedgaming', 'midos'
    dryRun: false,
    keywords: [],
    maxPages: DEFAULT_MAX_PAGES,
    since: null,         // ISO date
    game: null,          // specific game slug to search for
    startggSlugs: [],    // explicit slugs/URLs bypass global search indexing
    challongeUrls: []    // explicit Challonge URLs checked alongside speedgaming.org
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--source':
        opts.source = args[++i] || 'all';
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--keywords':
        opts.keywords = (args[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
        break;
      case '--max-pages':
        {
          const raw = args[++i];
          const parsed = parseInt(raw, 10);
          opts.maxPages = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
        }
        break;
      case '--since':
        opts.since = args[++i] || null;
        break;
      case '--game':
        opts.game = args[++i] || null;
        break;
      case '--startgg-slug':
        if (args[i + 1]) opts.startggSlugs.push(args[++i]);
        break;
      case '--challonge-url':
        if (args[i + 1]) opts.challongeUrls.push(args[++i]);
        break;
      default:
        if (!args[i].startsWith('--')) {
          console.warn(`⚠️  Unknown argument: ${args[i]}`);
        }
    }
  }

  return opts;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// start.gg allows ~80 requests/min, and one full tournament fetch costs several: wait out 429s
async function withStartGGRetry(call, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    await sleep(RATE_LIMIT_MS);
    try {
      return await call();
    } catch (err) {
      if (err.response?.status !== 429 || attempt >= attempts) throw err;
      console.log(`   ⏳ start.gg rate limit, retrying in 60s (${attempt}/${attempts - 1})`);
      await sleep(60000);
    }
  }
}

const playerKey = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The same event can exist on two platforms (e.g. a Challonge bracket and its start.gg twin):
 * flag an existing tournament starting within 45 days with (almost) the same players.
 * Two different start.gg tournaments are never twins (weekly series share their players).
 */
async function findProbableDuplicate(playerNames, startDate, startggEventId, startggTournamentId) {
  const wanted = new Set(playerNames.map(playerKey).filter(Boolean));
  if (wanted.size < 4) return null;

  const query = {
    startggId: { $ne: startggEventId },
    $or: [{ startggId: null }, { startggTournamentId }]
  };
  if (startDate) {
    const time = new Date(startDate).getTime();
    const windowMs = 45 * 24 * 60 * 60 * 1000;
    query.startDate = { $gte: new Date(time - windowMs), $lte: new Date(time + windowMs) };
  }

  for (const existing of await Tournament.find(query).select('name participants.name').lean()) {
    const known = new Set((existing.participants || []).map(p => playerKey(p.name)).filter(Boolean));
    const smaller = Math.min(known.size, wanted.size);
    if (smaller < 4 || smaller / Math.max(known.size, wanted.size) < 0.7) continue;
    const shared = [...known].filter(name => wanted.has(name)).length;
    if (shared / smaller >= 0.8) return existing.name;
  }
  return null;
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqueNormalized(values) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

function getGameAliases(game) {
  return uniqueNormalized([
    game.id,
    game.name,
    game.official?.name,
    game.randomizer?.displayName,
    game.randomizer?.shortName,
    game.randomizer?.tinyName,
    game.randomizer?.name,
    ...(game.integrations?.startgg?.searchKeywords || []),
    ...(game.integrations?.challonge?.searchKeywords || [])
  ]).filter(alias => alias.length >= 3);
}

function getRandomizerAliases(game) {
  return uniqueNormalized([
    game.id,
    game.randomizer?.displayName,
    game.randomizer?.shortName,
    game.randomizer?.tinyName,
    game.randomizer?.name,
    ...(game.integrations?.startgg?.searchKeywords || []),
    ...(game.integrations?.challonge?.searchKeywords || [])
  ]).filter(alias => alias.length >= 3);
}

function textContainsAlias(text, alias) {
  if (!text || !alias) return false;

  if (alias.length <= 4 && /^[a-z0-9+]+$/i.test(alias)) {
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(alias)}([^a-z0-9]|$)`, 'i');
    return pattern.test(text);
  }

  return text.includes(alias);
}

function buildTournamentSearchText(tournament) {
  const eventText = (tournament.events || [])
    .map(event => `${event.name || ''} ${event.game?.name || ''}`)
    .join(' ');

  return normalizeText(`${tournament.name || ''} ${eventText}`);
}

const containsWord = (text, word) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(word)}([^a-z0-9]|$)`).test(text);

// Short names that only mean the randomizer ("ootr", "alttpr", "smz3"...): searched on their own
function getDistinctiveRandomizerAliases(game) {
  return uniqueNormalized([
    game.randomizer?.shortName,
    game.randomizer?.tinyName,
    ...(game.integrations?.startgg?.searchKeywords || [])
  ]).filter(alias => alias.length >= 3
    && alias !== normalizeText(game.id)
    && !RANDOMIZER_SIGNAL_KEYWORDS.some(keyword => alias.includes(keyword)));
}

/**
 * start.gg searches whole words in tournament names, so "zelda randomizer" adds nothing to
 * "randomizer": one pass over the generic keywords + the distinctive short names covers every game.
 */
function buildStartGGSearchQueries(games, extraKeywords = []) {
  return uniqueNormalized([
    ...STARTGG_GENERIC_QUERIES,
    ...games.flatMap(getDistinctiveRandomizerAliases),
    ...(extraKeywords || [])
  ]);
}

/**
 * Strict game match for global search results, where loose aliases ("air", "adventure")
 * hit hundreds of unrelated events: start.gg game, then names that only mean the randomizer.
 */
function matchStartGGGame(tournament, games) {
  const text = buildTournamentSearchText(tournament);
  const eventGames = (tournament.events || []).map(event => ({ id: Number(event.game?.id), name: normalizeText(event.game?.name) }));

  const byGameId = games.find(game => eventGames.some(event => event.id === Number(game.integrations?.startgg?.videogameId)));
  if (byGameId) return { game: byGameId, reason: 'startggGameId' };

  const byGameName = games.find(game => {
    const names = uniqueNormalized([game.name, game.official?.name]);
    return eventGames.some(event => event.name && names.includes(event.name));
  });
  if (byGameName) return { game: byGameName, reason: 'startggGameName' };

  for (const game of games) {
    const alias = getDistinctiveRandomizerAliases(game).find(a => a.length >= 4 && !a.includes(' ') && containsWord(text, a))
      || uniqueNormalized([game.randomizer?.displayName, game.randomizer?.name])
        .find(a => /randomi[sz]er/.test(a) && a.length >= 8 && text.includes(a));
    if (alias) return { game, reason: 'alias', alias };
  }
  return null;
}

// "rando" as a word, not "random": FGC "random select" brackets are not randomizers
const RANDOMIZER_SIGNAL_PATTERN = /(^|[^a-z0-9])(randomi[sz]er|rando|multi-?world|archipelago)([^a-z0-9]|$)/;

function formatMaxPages(maxPages) {
  return maxPages == null ? '∞' : String(maxPages);
}

function normalizeStartGGSlug(value) {
  const input = String(value || '').trim();
  const extracted = StartGGAPI.extractSlugFromUrl(input);
  const slug = (extracted || input
    .replace(/^https?:\/\/(?:www\.)?start\.gg\//i, '')
    .replace(/\/(?:events?)\/?$/i, '')
    .replace(/^\/+|\/+$/g, ''))
    .split('/event/')[0];
  return slug.startsWith('tournament/') ? slug : `tournament/${slug}`;
}

function findMatchingGame(tournament, games = []) {
  const text = buildTournamentSearchText(tournament);
  const eventGameIds = new Set(
    (tournament.events || [])
      .map(event => Number(event.game?.id))
      .filter(Number.isFinite)
  );

  // 1) Primary: match by start.gg videogame ID
  for (const game of games) {
    const configuredGameId = Number(game.integrations?.startgg?.videogameId);
    if (Number.isFinite(configuredGameId) && eventGameIds.has(configuredGameId)) {
      return { game, reason: 'startggGameId' };
    }
  }

  // 2) If the tournament events all have game IDs that don't match any of our
  //    configured videogameIds, do NOT fall back to text matching — this avoids
  //    false positives when start.gg provides a definitive game identity.
  if (eventGameIds.size > 0) {
    const anyGameHasId = games.some(g => Number.isFinite(Number(g.integrations?.startgg?.videogameId)));
    if (anyGameHasId) {
      // All our games have IDs configured but none matched → not our game
      return null;
    }
  }

  // 3) Fallback: text alias matching (only when game IDs are not available)
  for (const game of games) {
    const aliases = getGameAliases(game).sort((a, b) => b.length - a.length);
    for (const alias of aliases) {
      if (textContainsAlias(text, alias)) {
        return { game, reason: 'alias', alias };
      }
    }
  }

  return null;
}

function hasRandomizerSignal(tournament, games = []) {
  const text = buildTournamentSearchText(tournament);

  if (RANDOMIZER_SIGNAL_KEYWORDS.some(keyword => text.includes(keyword))) {
    return true;
  }

  return games.some(game =>
    getRandomizerAliases(game).some(alias => textContainsAlias(text, alias))
  );
}

// ─── Build search terms from games in database ──────────────────────────────

async function buildSearchTerms(gameSlug = null) {
  const query = { enabled: true };
  if (gameSlug) query.id = gameSlug;

  const games = await Game.find(query).lean();
  if (!games.length) {
    console.warn('⚠️  No games found in database');
    return { searchTerms: [], gameMap: new Map(), games: [] };
  }

  const searchTerms = new Set();
  const gameMap = new Map(); // keyword → game for quick matching

  for (const game of games) {
    // Collect various name forms to search for
    const names = [
      game.name,
      game.randomizer?.displayName,
      game.randomizer?.shortName,
      game.randomizer?.tinyName,
      game.randomizer?.name,
      game.id
    ].filter(Boolean);

    for (const name of names) {
      const lower = name.toLowerCase();
      searchTerms.add(lower);
      gameMap.set(lower, { gameId: game._id, gameSlug: game.id, gameName: game.name });
    }

    // Also add game name + "randomizer" / "rando" combos for more targeted searches
    if (game.official?.name) {
      const baseName = game.official.name.split(':')[0].trim(); // e.g. "The Legend of Zelda"
      searchTerms.add(`${baseName.toLowerCase()} randomizer`);
    }
  }

  return { searchTerms: [...searchTerms], gameMap, games };
}

// ─── Sanitize HTML description ──────────────────────────────────────────────

function cleanDescription(description) {
  if (!description) return null;
  return sanitizeHtml(description, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'br']),
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height']
    },
    allowedSchemesByTag: {
      a: ['http', 'https', 'mailto'],
      img: ['http', 'https', 'data']
    }
  });
}

// ─── Start.gg Discovery ─────────────────────────────────────────────────────

async function discoverStartGG({ searchTerms, keywords, maxPages, since, dryRun, games, tournamentSlugs = [], discoveredVia = null, trustSource = false, forceGame = false }) {
  if (!process.env.STARTGG_API_TOKEN) {
    console.warn('⚠️  STARTGG_API_TOKEN not set – skipping start.gg discovery');
    return { found: 0, imported: 0, skipped: 0, errors: 0 };
  }

  const api = new StartGGAPI();
  const stats = { found: 0, imported: 0, skipped: 0, errors: 0 };

  const seenSlugs = new Set();
  // Check which startgg tournaments already exist
  const existingStartgg = await Tournament.find({
    $or: [
      { startggId: { $exists: true, $ne: null } },
      { startggTournamentId: { $exists: true, $ne: null } }
    ]
  }).select('startggId startggTournamentId startggSlug').lean();
  const existingStartggIds = new Set(existingStartgg
    .filter(tournament => tournament.startggId != null)
    .map(tournament => String(tournament.startggId)));
  const existingStartggTournamentIds = new Set(existingStartgg
    .filter(tournament => tournament.startggTournamentId != null)
    .map(tournament => String(tournament.startggTournamentId)));
  const existingStartggSlugs = new Set(existingStartgg
    .map(tournament => String(tournament.startggSlug || '').split('/event/')[0])
    .filter(Boolean));

  console.log(`\n🔍 Start.gg: Searching ${games.length} game(s)...`);

  const isAlreadyImported = tournament => (
    existingStartggTournamentIds.has(String(tournament.id)) ||
    existingStartggSlugs.has(String(tournament.slug || '').split('/event/')[0]) ||
    (tournament.events || []).some(event => existingStartggIds.has(String(event.id)))
  );

  const inspectTournament = async (tournament, game, matched = false) => {
    if (!tournament?.slug || seenSlugs.has(tournament.slug)) return;
    seenSlugs.add(tournament.slug);
    stats.found++;

    // A curated source (Mido's House) already guarantees the game: names rarely say "randomizer"
    const accepted = matched || forceGame || (trustSource ? Boolean(findMatchingGame(tournament, [game])) : isRandomizerTournament(tournament, [game]));
    if (!accepted) return;

    if (isAlreadyImported(tournament)) {
      console.log(`         ↪ Already imported: ${tournament.name} (${tournament.slug})`);
      stats.skipped++;
      return;
    }

    if (dryRun) {
      console.log(`         📋 [DRY-RUN] Would import: ${tournament.name} (${tournament.slug}) → ${game.id}`);
      tournament.events?.forEach(event => {
        console.log(`            └── Event: ${event.name} (${event.numEntrants || '?'} entrants) – Game: ${event.game?.name || 'N/A'}`);
      });
      stats.imported++;
      return;
    }

    try {
      await importStartGGTournament(api, tournament, { game, discoveredVia });
      stats.imported++;
    } catch (err) {
      console.error(`         ❌ Error importing ${tournament.slug}: ${err.message}`);
      stats.errors++;
    }
  };

  for (const rawSlug of tournamentSlugs) {
    const slug = normalizeStartGGSlug(rawSlug);
    try {
      const tournament = await withStartGGRetry(() => api.getTournament(slug, { details: false }));
      if (!tournament) {
        console.warn(`   ⚠️  Start.gg tournament not found: ${slug}`);
        continue;
      }

      // `--game` with explicit slugs: the operator already chose the game, aliases are not required
      const match = forceGame ? { game: games[0] } : findMatchingGame(tournament, games);
      if (!match || (!trustSource && !forceGame && !hasRandomizerSignal(tournament, [match.game]))) {
        console.log(`   ↪ No matching randomizer game for explicit tournament: ${tournament.name} (${tournament.slug})`);
        continue;
      }

      console.log(`   🎯 Explicit Start.gg slug: ${tournament.slug}`);
      await inspectTournament(tournament, match.game);
    } catch (err) {
      console.error(`   ❌ Error fetching ${slug}: ${err.message}`);
      stats.errors++;
    }
  }

  if (tournamentSlugs.length) return stats;

  const searchQueries = buildStartGGSearchQueries(games, keywords);
  const genericQueries = new Set(STARTGG_GENERIC_QUERIES);
  console.log(`   ${searchQueries.length} queries (generic keywords + randomizer short names), alias queries capped at ${STARTGG_ALIAS_MAX_PAGES} pages`);

  const results = new Map(); // slug → tournament, a tournament often answers several queries
  for (const [index, searchQuery] of searchQueries.entries()) {
    const pageLimit = genericQueries.has(searchQuery)
      ? maxPages
      : Math.min(maxPages ?? STARTGG_ALIAS_MAX_PAGES, STARTGG_ALIAS_MAX_PAGES);

    for (let page = 1; pageLimit == null || page <= pageLimit; page++) {
      try {
        const searchOpts = { perPage: STARTGG_RESULTS_PER_PAGE, page };
        if (since) searchOpts.afterDate = since;

        const result = await withStartGGRetry(() => api.searchTournaments(searchQuery, searchOpts));
        if (!result.tournaments.length) break;

        for (const tournament of result.tournaments) {
          if (tournament?.slug && !results.has(tournament.slug)) results.set(tournament.slug, tournament);
        }
        if (page >= result.totalPages) break;
      } catch (err) {
        console.error(`   ❌ Search error "${searchQuery}" page ${page}: ${err.message}`);
        stats.errors++;
        break;
      }
    }

    if ((index + 1) % 50 === 0) console.log(`   … ${index + 1}/${searchQueries.length} queries, ${results.size} tournaments seen`);
  }

  console.log(`\n   ${results.size} tournaments seen, checking games...`);
  const toReview = [];
  for (const tournament of results.values()) {
    const text = buildTournamentSearchText(tournament);
    const match = matchStartGGGame(tournament, games);
    const hasSignal = RANDOMIZER_SIGNAL_PATTERN.test(text) || match?.reason === 'alias';

    if (!hasSignal) continue;
    if (!match) {
      if (!isAlreadyImported(tournament)) toReview.push(tournament);
      continue;
    }

    console.log(`   ✓ ${tournament.name} → ${match.game.id} (${match.reason}${match.alias ? `: ${match.alias}` : ''})`);
    await inspectTournament(tournament, match.game, true);
  }

  // Named like a randomizer but not tied to a tracked game: import by hand with --game + --startgg-slug
  if (toReview.length) {
    console.log(`\n   🔍 ${toReview.length} randomizer-like tournament(s) without a matching game (check, then --game <id> --startgg-slug <slug>):`);
    for (const tournament of toReview) {
      const eventGames = [...new Set((tournament.events || []).map(event => event.game?.name).filter(Boolean))].join(', ');
      console.log(`      • ${tournament.name} [${eventGames || 'no game'}] – ${tournament.slug}`);
    }
  }

  return stats;
}

/**
 * Check whether a tournament (from search results) looks like a randomizer/multiworld event
 */
function isRandomizerTournament(tournament, searchTerms) {
  const matchingGame = findMatchingGame(tournament, searchTerms);
  if (!matchingGame) return false;

  const hasSignal = hasRandomizerSignal(tournament, [matchingGame.game]);
  if (!hasSignal) return false;

  // Log the match reason for debugging
  const gameName = matchingGame.game.id || matchingGame.game.name;
  const reason = matchingGame.reason === 'startggGameId'
    ? `gameId match`
    : `alias "${matchingGame.alias}"`;
  console.log(`         ✓ ${tournament.name} → ${gameName} (${reason})`);

  return true;
}

/**
 * Import a full tournament from start.gg (fetches detailed data then saves)
 */
async function importStartGGTournament(api, tournamentPreview, { game = null, discoveredVia = null } = {}) {
  const slug = tournamentPreview.slug.startsWith('tournament/') ? tournamentPreview.slug : `tournament/${tournamentPreview.slug}`;

  console.log(`      ⬇️  Importing: ${tournamentPreview.name}`);

  const tournamentData = await withStartGGRetry(() => api.getTournament(slug));

  if (!tournamentData || !tournamentData.events?.length) {
    console.log(`      ⚠️  No events found for ${tournamentPreview.name}`);
    return;
  }

  // Skip sibling events tagged with another videogame (e.g. a non-randomizer side event)
  const videogameId = Number(game?.integrations?.startgg?.videogameId);
  const events = Number.isFinite(videogameId)
    ? tournamentData.events.filter(event => Number(event.game?.id) === videogameId)
    : tournamentData.events;

  // Some organisers mirror a bracket in a second event (e.g. registrations full of DQs + a
  // "Results Data" copy with the real scores, often under shortened tags): keep the copy with results
  const eventPlayers = event => new Set((event.standings?.length ? event.standings : event.entrants || [])
    .flatMap(entry => (entry.participants || []).map(p => playerKey(p.gamerTag || p.userName))).filter(Boolean));
  const playedSets = event => (event.sets || []).filter(set => set.displayScore && !/\bDQ\b/i.test(set.displayScore)).length;
  const keptEvents = [];
  for (const event of [...events].sort((a, b) => playedSets(b) - playedSets(a))) {
    const players = eventPlayers(event);
    if (!players.size) {
      console.log(`         ⏭️  Skipped "${event.name}": no entrants`);
      continue;
    }
    const twin = keptEvents.find(kept => {
      const keptPlayers = eventPlayers(kept);
      if (keptPlayers.size !== players.size) return false;
      const shared = [...players].filter(name => keptPlayers.has(name)).length;
      const sameShape = (kept.sets || []).length === (event.sets || []).length && !playedSets(event);
      return sameShape || shared / players.size >= 0.7;
    });
    if (twin) {
      console.log(`         ⏭️  Skipped "${event.name}": copy of event "${twin.name}"`);
      continue;
    }
    keptEvents.push(event);
  }

  for (const event of keptEvents) {
    // Try to match to a game in our DB
    const matchForGame = await findGameForTournament({
      providedGameSlug: game ? game.id : null,
      providedGameId: event.game?.id,
      tournamentName: `${tournamentData.name} - ${event.name}`,
      tournamentDescription: event.game?.name || ''
    });

    const participants = StartGGAPI.buildParticipants(event);

    const duplicateOf = await findProbableDuplicate(participants.map(p => p.name), event.startDate || tournamentData.startDate, event.id, tournamentData.id);
    if (duplicateOf) {
      console.log(`         ⏭️  Skipped "${tournamentData.name} - ${event.name}": same players and dates as existing "${duplicateOf}"`);
      continue;
    }

    // Bracket type
    const bracketTypeMap = {
      'SINGLE_ELIMINATION': 'single_elimination',
      'DOUBLE_ELIMINATION': 'double_elimination',
      'ROUND_ROBIN': 'round_robin',
      'SWISS': 'swiss',
      'EXHIBITION': 'exhibition',
      'CUSTOM_SCHEDULE': 'custom_schedule'
    };
    const bracketType = event.phases?.[0]?.bracketType || 'SINGLE_ELIMINATION';
    const tournamentType = bracketTypeMap[bracketType] || bracketType.toLowerCase();

    // Build matches from sets
    const newMatches = (event.sets || []).map(set => ({
      startggSetId: set.id,
      round: set.round,
      displayScore: set.displayScore,
      completedAt: set.completedAt,
      state: set.state,
      phase: set.phase?.name || null,
      phaseGroup: set.phaseGroup?.displayIdentifier || null,
      player1: StartGGAPI.setPlayer(set.entrants?.[0]),
      player2: StartGGAPI.setPlayer(set.entrants?.[1]),
      winnerId: set.winnerId
    }));

    // Preserve existing race links (raceUrl, raceUrls, linkScore) when re-importing
    const existingTournament = await Tournament.findOne({ startggId: event.id }).select('matches').lean();
    const existingLinkMap = new Map();
    if (existingTournament?.matches) {
      for (const m of existingTournament.matches) {
        if (m.startggSetId && (m.raceUrl || m.raceUrls?.length || m.linkScore)) {
          existingLinkMap.set(String(m.startggSetId), {
            raceUrl: m.raceUrl || null,
            raceUrls: m.raceUrls || [],
            linkScore: m.linkScore || null
          });
        }
      }
    }

    const matches = newMatches.map(m => {
      const existing = existingLinkMap.get(String(m.startggSetId));
      if (existing) {
        return { ...m, ...existing };
      }
      return m;
    });

    // Build phases
    const phases = (event.phases || []).map(phase => ({
      startggPhaseId: phase.id,
      name: phase.name,
      bracketType: phase.bracketType,
      phaseOrder: phase.phaseOrder,
      numSeeds: phase.numSeeds,
      groupCount: phase.groupCount,
      state: phase.state
    }));

    const eventUrl = `https://start.gg/${event.slug}`;
    const tournamentPayload = {
      name: `${tournamentData.name} - ${event.name}`,
      startggId: event.id,
      startggTournamentId: tournamentData.id,
      startggSlug: event.slug,
      url: eventUrl,
      fullUrl: eventUrl,
      tournamentType,
      state: event.state?.toLowerCase?.() || String(event.state || 'complete'),
      participantsCount: event.numEntrants,
      participants,
      matches,
      phases,
      setsTotal: event.setsTotal || matches.length,
      startDate: event.startDate || tournamentData.startDate,
      endDate: tournamentData.endDate,
      gameName: event.game?.name || null,
      source: {
        type: 'startgg',
        externalId: String(event.id),
        tournamentId: String(tournamentData.id),
        url: eventUrl,
        discoveredVia,
        importedAt: new Date()
      }
    };

    if (matchForGame) {
      tournamentPayload.game = matchForGame.gameId;
      tournamentPayload.gameSlug = matchForGame.gameSlug;
    }

    // Upsert
    await Tournament.findOneAndUpdate(
      { startggId: event.id },
      { $set: tournamentPayload, $currentDate: { updatedAt: true } },
      { upsert: true, new: true }
    );

    const preservedLinks = existingLinkMap.size;
    console.log(`         ✅ ${tournamentPayload.name} – ${participants.length} participants, ${matches.length} matches${matchForGame ? ` → ${matchForGame.gameSlug}` : ''}${preservedLinks ? ` (${preservedLinks} liens préservés)` : ''}`);
  }
}

// ─── SpeedGaming Discovery (speedgaming.org/events → Challonge and start.gg brackets) ─────

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/** Challonge URL → API identifier (`subdomain-slug` for organisation brackets). */
function parseChallongeRef(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { return null; }
  if (!/(^|\.)challonge\.com$/i.test(url.hostname)) return null;

  const subdomain = url.hostname.split('.').slice(0, -2).filter(part => part !== 'www')[0] || null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length > 1 && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(parts[0])) parts.shift();
  // /tournaments/signup/<token> pages carry no resolvable slug
  if (!parts.length || parts[0] === 'tournaments') return null;

  const slug = parts[0];
  return {
    apiId: subdomain ? `${subdomain}-${slug}` : slug,
    url: `https://${subdomain ? `${subdomain}.` : ''}challonge.com/${slug}`
  };
}

async function fetchSpeedGamingBrackets() {
  const { data: html } = await axios.get(SPEEDGAMING_EVENTS_URL, {
    timeout: 20000,
    headers: { 'User-Agent': 'RandomizerHub-discovery/1.0 (+tournament index)' }
  });

  const entries = [];
  for (const block of String(html).matchAll(/<p>([\s\S]*?)<\/p>/gi)) {
    const title = decodeEntities((block[1].match(/<a[^>]*>([\s\S]*?)<\/a>/i) || [])[1] || '').replace(/<[^>]+>/g, '').trim();
    for (const anchor of block[1].matchAll(/<a[^>]+href="([^"]*)"[^>]*>\s*Bracket\/standings\s*<\/a>/gi)) {
      // One href can hold several brackets ("Upper: <url> - Middle: <url>"): they share the event title as group
      const links = [...decodeEntities(anchor[1]).matchAll(/(?:([A-Za-z][A-Za-z ]*?):\s*)?(https?:\/\/[^\s"'<>]+)/g)];
      for (const [, label, link] of links) {
        entries.push({ title, link, group: links.length > 1 ? title : null, label: label ? label.trim() : null });
      }
    }
  }
  return entries;
}

/** Prefer Challonge's own game name, then the longest game alias found in the titles. */
function matchChallongeGame(tournament, title, games) {
  const gameName = normalizeText(tournament.gameName);
  if (gameName) {
    const exact = games.find(game => [game.name, game.official?.name].some(name => normalizeText(name) === gameName));
    if (exact) return { game: exact, reason: 'challongeGameName' };
  }

  const text = normalizeText(`${title} ${tournament.name} ${tournament.gameName || ''}`);
  let best = null;
  for (const game of games) {
    for (const alias of getGameAliases(game)) {
      if (textContainsAlias(text, alias) && (!best || alias.length > best.alias.length)) {
        best = { game, alias, reason: 'alias' };
      }
    }
  }
  return best;
}

async function discoverSpeedGaming({ games, dryRun, challongeUrls = [] }) {
  if (!process.env.CHALLONGE_API_KEY) {
    console.warn('⚠️  CHALLONGE_API_KEY not set – skipping speedgaming discovery');
    return { found: 0, imported: 0, skipped: 0, errors: 0 };
  }

  const stats = { found: 0, imported: 0, skipped: 0, errors: 0 };
  console.log('\n🔍 SpeedGaming: reading bracket links...');

  let entries = challongeUrls.map(link => ({ title: '', link }));
  if (!entries.length) {
    try {
      entries = await fetchSpeedGamingBrackets();
    } catch (err) {
      console.error(`   ❌ Could not read ${SPEEDGAMING_EVENTS_URL}: ${err.message}`);
      stats.errors++;
    }
  }

  const existingIds = new Set((await getKnownChallongeIds()).map(String));
  const seen = new Set();
  // start.gg brackets go to the start.gg import ("2026 ALTTPR Casual Boots Tournament")
  const startggSlugs = new Set();

  for (const { title, link, group = null, label = null } of entries) {
    if (/(^|\.)start\.gg\//i.test(link.replace(/^https?:\/\//, ''))) {
      const slug = StartGGAPI.extractSlugFromUrl(link);
      if (slug) startggSlugs.add(slug);
      continue;
    }
    const ref = parseChallongeRef(link);
    if (!ref) {
      if (/challonge\.com/i.test(link)) console.log(`   ↪ Unresolvable Challonge link: ${link}`);
      continue; // other hosts (sheets, league sites) have no bracket to import
    }
    if (seen.has(ref.apiId.toLowerCase())) continue;
    seen.add(ref.apiId.toLowerCase());
    stats.found++;

    try {
      await sleep(RATE_LIMIT_MS);
      let tournament;
      try {
        tournament = await challongeAPI.getTournament(ref.apiId).catch(async err => {
          if (err.response) throw err; // HTTP answers (404...) are final; only network errors are retried
          await sleep(RATE_LIMIT_MS * 2);
          return challongeAPI.getTournament(ref.apiId);
        });
      } catch (err) {
        // Private, deleted or not exposed by the API: keep it visible for manual review
        console.log(`   ⚠️  Unresolved (${err.response?.status || err.message}): ${link}${title ? ` — ${title}` : ''}`);
        stats.skipped++;
        continue;
      }

      if (existingIds.has(String(tournament.id))) {
        console.log(`   ↪ Already imported: ${tournament.name} (${ref.url})`);
        stats.skipped++;
        continue;
      }

      const match = matchChallongeGame(tournament, title, games);
      // Short game aliases (e.g. "sms") are too ambiguous here: require an explicit randomizer keyword
      const signalText = normalizeText(`${title} ${tournament.name}`);
      if (!match || !RANDOMIZER_SIGNAL_KEYWORDS.some(keyword => signalText.includes(keyword))) {
        console.log(`   ↪ Not a tracked randomizer: ${tournament.name} [${tournament.gameName || 'no game'}] (${ref.url})`);
        stats.skipped++;
        continue;
      }

      if (dryRun) {
        console.log(`   📋 [DRY-RUN] Would import: ${tournament.name} (${ref.url}) → ${match.game.id} (${match.reason}${match.alias ? `: ${match.alias}` : ''}) – ${tournament.participantsCount} participants, ${tournament.state}${group ? ` – bracket${label ? ` "${label}"` : ''} of "${group}"` : ''}`);
        stats.imported++;
        continue;
      }

      await importChallongeTournament({ name: tournament.name, url: ref.apiId }, match.game.id, { group, label, discoveredVia: 'speedgaming.org' });
      existingIds.add(String(tournament.id));
      stats.imported++;
    } catch (err) {
      console.error(`   ❌ Error processing ${link}: ${err.message}`);
      stats.errors++;
    }
  }

  if (startggSlugs.size) {
    console.log(`\n   start.gg brackets listed on speedgaming.org: ${startggSlugs.size}`);
    const startgg = await discoverStartGG({ games, dryRun, tournamentSlugs: [...startggSlugs], discoveredVia: 'speedgaming.org' });
    for (const key of Object.keys(stats)) stats[key] += startgg[key] || 0;
  }

  return stats;
}

// ─── Mido's House Discovery (OoT events → start.gg brackets) ───────────────────────

// Event pages only: brackets are read from public links, never copied from Mido's own data
async function fetchMidosStartGGSlugs() {
  const http = { timeout: 20000, headers: { 'User-Agent': 'RandomizerHub-discovery/1.0 (+tournament index)' } };
  const eventPaths = new Set();

  for (const page of ['/', '/archive']) {
    const { data } = await axios.get(`${MIDOS_BASE_URL}${page}`, http);
    for (const match of String(data).matchAll(/href="(\/event\/[^"\/#?]+\/[^"\/#?]+)"/g)) eventPaths.add(match[1]);
  }

  const slugs = new Map();
  for (const eventPath of eventPaths) {
    await sleep(MIDOS_DELAY_MS);
    try {
      const { data } = await axios.get(`${MIDOS_BASE_URL}${eventPath}`, http);
      for (const match of String(data).matchAll(/href="(https?:\/\/(?:www\.)?start\.gg\/tournament\/[^"#?\s]+)"/gi)) {
        const slug = StartGGAPI.extractSlugFromUrl(decodeEntities(match[1]));
        if (slug && !slugs.has(slug)) slugs.set(slug, eventPath);
      }
    } catch (err) {
      console.log(`   ⚠️  Could not read ${eventPath}: ${err.message}`);
    }
  }
  return { slugs, eventCount: eventPaths.size };
}

async function discoverMidos({ games, dryRun }) {
  const oot = games.find(game => game.id === 'oot');
  if (!oot) {
    console.warn("⚠️  Game 'oot' not selected/found – skipping Mido's House discovery");
    return { found: 0, imported: 0, skipped: 0, errors: 0 };
  }

  console.log("\n🔍 Mido's House: reading OoT event pages...");
  let result;
  try {
    result = await fetchMidosStartGGSlugs();
  } catch (err) {
    console.error(`   ❌ Could not read ${MIDOS_BASE_URL}: ${err.message}`);
    return { found: 0, imported: 0, skipped: 0, errors: 1 };
  }

  console.log(`   ${result.eventCount} event pages, ${result.slugs.size} distinct start.gg tournaments`);
  // An empty list must not fall through to discoverStartGG's global search
  if (!result.slugs.size) return { found: 0, imported: 0, skipped: 0, errors: 0 };

  return discoverStartGG({ games: [oot], dryRun, tournamentSlugs: [...result.slugs.keys()], discoveredVia: 'midos.house', trustSource: true });
}

// ─── Challonge Discovery ────────────────────────────────────────────────────

async function discoverChallonge({ searchTerms, games, keywords, since, dryRun }) {
  if (!process.env.CHALLONGE_API_KEY) {
    console.warn('⚠️  CHALLONGE_API_KEY not set – skipping Challonge discovery');
    return { found: 0, imported: 0, skipped: 0, errors: 0 };
  }

  const stats = { found: 0, imported: 0, skipped: 0, errors: 0 };
  const allKeywords = [...new Set([...RANDOMIZER_SIGNAL_KEYWORDS, ...keywords])];

  console.log(`\n🔍 Challonge: Searching tournaments...`);

  try {
    const listOpts = { state: 'all' };
    if (since) listOpts.createdAfter = since;

    const tournaments = await challongeAPI.searchTournaments(allKeywords, listOpts);
    stats.found = tournaments.length;

    console.log(`   Found ${tournaments.length} matching tournaments`);

    // Check existing
    const existingChallongeIds = new Set(await getKnownChallongeIds());

    for (const tournament of tournaments) {
      if (existingChallongeIds.has(tournament.id)) {
        stats.skipped++;
        continue;
      }

      // Extra check: is this really a randomizer tournament?
      const isRando = isRandomizerTournament(
        { name: tournament.name, events: [{ name: tournament.name, game: { name: tournament.gameName || '' } }] },
        games
      );
      if (!isRando) continue;

      if (dryRun) {
        console.log(`   📋 [DRY-RUN] Would import: ${tournament.name} (${tournament.url})`);
        stats.imported++;
        continue;
      }

      try {
        await importChallongeTournament(tournament);
        stats.imported++;
      } catch (err) {
        console.error(`   ❌ Error importing ${tournament.url}: ${err.message}`);
        stats.errors++;
      }

      await sleep(RATE_LIMIT_MS);
    }
  } catch (err) {
    console.error(`   ❌ Challonge listing error: ${err.message}`);
    stats.errors++;
  }

  return stats;
}

/**
 * Import a single Challonge tournament (fetches full data including participants/matches)
 */
// Challonge ids already stored, standalone or as one bracket of a grouped tournament
async function getKnownChallongeIds() {
  const tournaments = await Tournament.find({
    $or: [{ challongeId: { $exists: true, $ne: null } }, { 'challongeBrackets.0': { $exists: true } }]
  }).select('challongeId challongeBrackets.challongeId').lean();
  return tournaments.flatMap(t => [t.challongeId, ...(t.challongeBrackets || []).map(b => b.challongeId)]).filter(id => id != null).map(Number);
}

async function importChallongeTournament(tournamentPreview, gameSlug = null, { group = null, label = null, discoveredVia = null } = {}) {
  const challongeId = tournamentPreview.url || tournamentPreview.id;

  console.log(`   ⬇️  Importing: ${tournamentPreview.name}`);

  const tournamentData = await challongeAPI.getTournament(challongeId);
  if (!tournamentData) {
    console.log(`   ⚠️  No data returned for ${challongeId}`);
    return;
  }

  const matches = await challongeAPI.getMatches(challongeId);
  // Ranks of the played bracket while the organizer has not finalized it
  const participants = fillMissingFinalRanks({ tournamentData, participants: await challongeAPI.getParticipants(challongeId), matches });

  // Determine game
  const matchForGame = await findGameForTournament({
    providedGameSlug: gameSlug,
    providedGameId: tournamentData.gameId,
    tournamentName: tournamentData.name,
    tournamentDescription: tournamentData.description
  });

  const tournamentPayload = {
    name: tournamentData.name,
    challongeId: tournamentData.id,
    url: tournamentData.url,
    fullUrl: tournamentData.fullUrl,
    tournamentType: tournamentData.tournamentType,
    state: tournamentData.state,
    participantsCount: tournamentData.participantsCount,
    description: cleanDescription(tournamentData.description),
    participants,
    startDate: tournamentData.startedAt,
    endDate: tournamentData.completedAt,
    gameName: tournamentData.gameName,
    source: {
      type: 'challonge',
      externalId: String(tournamentData.id),
      url: tournamentData.fullUrl || tournamentData.url || null,
      group,
      discoveredVia,
      importedAt: new Date()
    }
  };

  if (matchForGame) {
    tournamentPayload.game = matchForGame.gameId;
    tournamentPayload.gameSlug = matchForGame.gameSlug;
  } else if (tournamentData.gameId) {
    tournamentPayload.gameId = tournamentData.gameId;
  }

  // One bracket among several of the same event: stored as a phase of the event's tournament
  if (group) {
    const { tournament, phaseName } = await saveGroupedChallongeBracket(
      { Tournament, Match, Race },
      { group, label, tournamentData, participants, matches, payload: tournamentPayload }
    );
    console.log(`      ✅ ${tournamentData.name} → "${tournament.name}" / ${phaseName} – ${participants.length} participants, ${matches.length} matches`);
    return;
  }

  const tournament = await Tournament.findOneAndUpdate(
    { challongeId: tournamentData.id },
    { $set: tournamentPayload, $currentDate: { updatedAt: true } },
    { upsert: true, new: true }
  );

  // Build participant map
  const participantMap = new Map();
  participants.forEach(p => {
    participantMap.set(p.challongeId, p);
    if (p.groupPlayerIds && Array.isArray(p.groupPlayerIds)) {
      p.groupPlayerIds.forEach(gid => participantMap.set(gid, p));
    }
  });

  // Upsert matches
  for (const m of matches) {
    const player1 = participantMap.get(m.player1Id) || null;
    const player2 = participantMap.get(m.player2Id) || null;

    await Match.findOneAndUpdate(
      { challongeId: m.id },
      {
        $set: {
          ...m,
          tournamentId: tournament._id,
          tournamentChallongeId: tournament.challongeId,
          player1Name: player1 ? (player1.displayName || player1.name) : null,
          player2Name: player2 ? (player2.displayName || player2.name) : null,
          source: { type: 'challonge', externalId: String(m.id), importedAt: new Date() }
        },
        $currentDate: { updatedAt: true }
      },
      { upsert: true }
    );
  }

  console.log(`      ✅ ${tournamentData.name} – ${participants.length} participants, ${matches.length} matches${matchForGame ? ` → ${matchForGame.gameSlug}` : ''}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║          🏆 Tournament Discovery & Import               ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log(`  Source:    ${opts.source}`);
  console.log(`  Dry-run:   ${opts.dryRun}`);
  console.log(`  Max pages: ${formatMaxPages(opts.maxPages)}`);
  console.log(`  Since:     ${opts.since || 'no limit'}`);
  console.log(`  Game:      ${opts.game || 'all games'}`);
  if (opts.keywords.length) console.log(`  Extra kw:  ${opts.keywords.join(', ')}`);

  await connectDB();

  const { searchTerms, gameMap, games } = await buildSearchTerms(opts.game);
  console.log(`\n📚 Loaded ${games?.length || 0} games → ${searchTerms.length} search terms`);

  const results = {};

  if (opts.source === 'all' || opts.source === 'startgg') {
    results.startgg = await discoverStartGG({
      searchTerms,
      keywords: opts.keywords,
      maxPages: opts.maxPages,
      since: opts.since,
      dryRun: opts.dryRun,
      games,
      tournamentSlugs: opts.startggSlugs,
      forceGame: Boolean(opts.game && opts.startggSlugs.length && games?.length === 1)
    });
  }

  if (opts.source === 'all' || opts.source === 'midos') {
    results.midos = await discoverMidos({ games, dryRun: opts.dryRun });
  }

  if (opts.source === 'all' || opts.source === 'speedgaming') {
    results.speedgaming = await discoverSpeedGaming({
      games,
      dryRun: opts.dryRun,
      challongeUrls: opts.challongeUrls
    });
  }

  if (opts.source === 'all' || opts.source === 'challonge') {
    results.challonge = await discoverChallonge({
      searchTerms,
      games,
      keywords: opts.keywords,
      since: opts.since,
      dryRun: opts.dryRun
    });
  }

  // Summary
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║                     📊 SUMMARY                          ║');
  console.log('╠═══════════════════════════════════════════════════════════╣');

  let totalImported = 0;
  let totalErrors = 0;

  for (const [source, stats] of Object.entries(results)) {
    console.log(`║  ${source.toUpperCase().padEnd(12)} Found: ${String(stats.found).padStart(4)} │ Imported: ${String(stats.imported).padStart(4)} │ Skipped: ${String(stats.skipped).padStart(4)} │ Errors: ${String(stats.errors).padStart(3)} ║`);
    totalImported += stats.imported;
    totalErrors += stats.errors;
  }

  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log(`║  Total imported: ${totalImported}   Errors: ${totalErrors}${opts.dryRun ? '   (DRY-RUN)' : ''}`.padEnd(60) + '║');
  console.log('╚═══════════════════════════════════════════════════════════╝');

  await mongoose.disconnect();
  process.exit(totalErrors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
