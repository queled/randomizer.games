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
 *   node scripts/discover-tournaments.js --max-pages 5        # Limit pagination
 *   node scripts/discover-tournaments.js --since 2024-01-01   # Only tournaments after date
 *   node scripts/discover-tournaments.js --game ootr          # Only search for a specific game
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Game, Tournament, Match } = require('../models');
const StartGGAPI = require('../services/startgg');
const challongeAPI = require('../services/challonge');
const findGameForTournament = require('../helpers/findGameForTournament');
const sanitizeHtml = require('sanitize-html');

// ─── Configuration ───────────────────────────────────────────────────────────

const RATE_LIMIT_MS = 1500; // ms between API calls
const DEFAULT_MAX_PAGES = null;

// Keywords that strongly indicate an actual randomizer / multiworld tournament
const RANDOMIZER_SIGNAL_KEYWORDS = [
  'randomizer', 'randomiser', 'rando',
  'multiworld', 'multi-world', 'multi world',
  'archipelago'
];

// Extra suffixes used to build targeted search queries from known game aliases
const QUERY_SUFFIX_KEYWORDS = [
  'randomizer',
  'multiworld',
  'archipelago'
];

// ─── CLI argument parsing ────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    source: 'all',       // 'all', 'startgg', 'challonge'
    dryRun: false,
    keywords: [],
    maxPages: DEFAULT_MAX_PAGES,
    since: null,         // ISO date
    game: null           // specific game slug to search for
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

function buildStartGGSearchQueries(game, extraKeywords = []) {
  const queries = new Set();

  if (!game) return [];

  const aliases = getGameAliases(game);
  const randomizerAliases = getRandomizerAliases(game);

  for (const alias of randomizerAliases) {
    queries.add(alias);
  }

  for (const alias of aliases.slice(0, 8)) {
    if (
      alias.includes('randomizer') ||
      alias.includes('randomiser') ||
      alias.includes('rando') ||
      alias.includes('multiworld') ||
      alias.includes('archipelago')
    ) {
      queries.add(alias);
      continue;
    }

    for (const suffix of QUERY_SUFFIX_KEYWORDS) {
      queries.add(`${alias} ${suffix}`);
    }
  }

  for (const keyword of extraKeywords || []) {
    const normalized = normalizeText(keyword);
    if (normalized) queries.add(normalized);
  }

  return [...queries];
}

function formatMaxPages(maxPages) {
  return maxPages == null ? '∞' : String(maxPages);
}

function findMatchingGame(tournament, games = []) {
  const text = buildTournamentSearchText(tournament);
  const eventGameIds = new Set(
    (tournament.events || [])
      .map(event => Number(event.game?.id))
      .filter(Number.isFinite)
  );

  for (const game of games) {
    const configuredGameId = Number(game.integrations?.startgg?.videogameId);
    if (Number.isFinite(configuredGameId) && eventGameIds.has(configuredGameId)) {
      return { game, reason: 'startggGameId' };
    }
  }

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
    return { searchTerms: [], gameMap: new Map() };
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

async function discoverStartGG({ searchTerms, keywords, maxPages, since, dryRun, games }) {
  if (!process.env.STARTGG_API_TOKEN) {
    console.warn('⚠️  STARTGG_API_TOKEN not set – skipping start.gg discovery');
    return { found: 0, imported: 0, skipped: 0, errors: 0 };
  }

  const api = new StartGGAPI();
  const stats = { found: 0, imported: 0, skipped: 0, errors: 0 };

  const seenSlugs = new Set();
  // Check which startgg tournaments already exist
  const existingStartgg = await Tournament.find({ startggId: { $exists: true, $ne: null } }).select('startggId startggSlug').lean();
  const existingStartggIds = new Set(existingStartgg.map(t => t.startggId));

  console.log(`\n🔍 Start.gg: Searching ${games.length} game(s)...`);

  for (const game of games) {
    const searchQueries = buildStartGGSearchQueries(game, keywords);
    console.log(`\n   🎮 Game: ${game.id} — ${game.name}`);
    console.log(`      Queries: ${searchQueries.slice(0, 8).join(', ')}${searchQueries.length > 8 ? ` ... (+${searchQueries.length - 8} more)` : ''}`);
    console.log(`      Max pages: ${formatMaxPages(maxPages)}`);

    for (const searchQuery of searchQueries) {
      console.log(`\n      🔎 Searching: "${searchQuery}"`);

      for (let page = 1; maxPages == null || page <= maxPages; page++) {
        try {
          await sleep(RATE_LIMIT_MS);

          const searchOpts = { perPage: 25, page };
          if (since) searchOpts.afterDate = since;

          const result = await api.searchTournaments(searchQuery, searchOpts);

          if (!result.tournaments.length) break;

          console.log(`         Page ${page}/${result.totalPages} – ${result.tournaments.length} results (total: ${result.total})`);

          for (const tournament of result.tournaments) {
            if (seenSlugs.has(tournament.slug)) continue;
            seenSlugs.add(tournament.slug);
            stats.found++;

            const isRandomizer = isRandomizerTournament(tournament, [game]);
            if (!isRandomizer) continue;

            const alreadyExists = tournament.events?.some(e => existingStartggIds.has(e.id));
            if (alreadyExists) {
              stats.skipped++;
              continue;
            }

            if (dryRun) {
              console.log(`         📋 [DRY-RUN] Would import: ${tournament.name} (${tournament.slug}) → ${game.id}`);
              tournament.events?.forEach(e => {
                console.log(`            └── Event: ${e.name} (${e.numEntrants || '?'} entrants) – Game: ${e.game?.name || 'N/A'}`);
              });
              stats.imported++;
              continue;
            }

            try {
              await importStartGGTournament(api, tournament);
              stats.imported++;
            } catch (err) {
              console.error(`         ❌ Error importing ${tournament.slug}: ${err.message}`);
              stats.errors++;
            }
          }

          if (page >= result.totalPages) break;

        } catch (err) {
          console.error(`         ❌ Search error page ${page}: ${err.message}`);
          stats.errors++;
          break;
        }
      }
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

  return hasRandomizerSignal(tournament, [matchingGame.game]);
}

/**
 * Import a full tournament from start.gg (fetches detailed data then saves)
 */
async function importStartGGTournament(api, tournamentPreview) {
  const slug = tournamentPreview.slug.startsWith('tournament/') ? tournamentPreview.slug : `tournament/${tournamentPreview.slug}`;

  console.log(`      ⬇️  Importing: ${tournamentPreview.name}`);

  await sleep(RATE_LIMIT_MS);
  const tournamentData = await api.getTournament(slug);

  if (!tournamentData || !tournamentData.events?.length) {
    console.log(`      ⚠️  No events found for ${tournamentPreview.name}`);
    return;
  }

  for (const event of tournamentData.events) {
    // Try to match to a game in our DB
    const matchForGame = await findGameForTournament({
      providedGameSlug: null,
      providedGameId: event.game?.id,
      tournamentName: `${tournamentData.name} - ${event.name}`,
      tournamentDescription: event.game?.name || ''
    });

    // Build participants
    const participants = [];
    const playerMap = new Map();

    const sources = event.standings?.length ? event.standings : event.entrants || [];
    for (const entry of sources) {
      const pList = entry.participants || [];
      for (const participant of pList) {
        const gamerTag = participant.gamerTag || participant.userName || 'Unknown';
        if (!playerMap.has(gamerTag)) {
          playerMap.set(gamerTag, {
            name: gamerTag,
            seed: entry.seed || null,
            finalRank: entry.placement || null,
            startggUserId: participant.userId,
            startggUserSlug: participant.userSlug,
            prefix: participant.prefix
          });
          participants.push(playerMap.get(gamerTag));
        }
      }
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
    const matches = (event.sets || []).map(set => ({
      startggSetId: set.id,
      round: set.round,
      displayScore: set.displayScore,
      completedAt: set.completedAt,
      state: set.state,
      phase: set.phase?.name || null,
      phaseGroup: set.phaseGroup?.displayIdentifier || null,
      player1: {
        startggEntrantId: set.entrants?.[0]?.id,
        name: set.entrants?.[0]?.name || 'TBD'
      },
      player2: {
        startggEntrantId: set.entrants?.[1]?.id,
        name: set.entrants?.[1]?.name || 'TBD'
      },
      winnerId: set.winnerId
    }));

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

    console.log(`         ✅ ${tournamentPayload.name} – ${participants.length} participants, ${matches.length} matches${matchForGame ? ` → ${matchForGame.gameSlug}` : ''}`);
  }
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
    const existingChallonge = await Tournament.find({ challongeId: { $exists: true, $ne: null } }).select('challongeId').lean();
    const existingChallongeIds = new Set(existingChallonge.map(t => t.challongeId));

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
async function importChallongeTournament(tournamentPreview) {
  const challongeId = tournamentPreview.url || tournamentPreview.id;

  console.log(`   ⬇️  Importing: ${tournamentPreview.name}`);

  const tournamentData = await challongeAPI.getTournament(challongeId);
  if (!tournamentData) {
    console.log(`   ⚠️  No data returned for ${challongeId}`);
    return;
  }

  const participants = await challongeAPI.getParticipants(challongeId);
  const matches = await challongeAPI.getMatches(challongeId);

  // Determine game
  const matchForGame = await findGameForTournament({
    providedGameSlug: null,
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
      importedAt: new Date()
    }
  };

  if (matchForGame) {
    tournamentPayload.game = matchForGame.gameId;
    tournamentPayload.gameSlug = matchForGame.gameSlug;
  } else if (tournamentData.gameId) {
    tournamentPayload.gameId = tournamentData.gameId;
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
      games
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
