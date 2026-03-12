#!/usr/bin/env node

/**
 * Import tournament from start.gg
 * 
 * Usage: node scripts/import-startgg.js <tournament-url-or-slug>
 * Example: node scripts/import-startgg.js https://www.start.gg/tournament/ocarina-of-time-randomizer-standard-tournament-season-9/events
 * Or: node scripts/import-startgg.js tournament/ocarina-of-time-randomizer-standard-tournament-season-9
 * 
 * Before running:
 * 1. Set STARTGG_API_TOKEN in .env file
 * 2. Ensure MongoDB is running
 */

const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });
const sanitizeHtml = require('sanitize-html');
const StartGGAPI = require('../services/startgg');
const findGameForTournament = require('../helpers/findGameForTournament');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer';

function parseStartGGSlug(input) {
  if (!input) return null;
  
  // If it's already a slug like "tournament/xxx", return it
  if (input.startsWith('tournament/')) return input;
  
  // Try to extract from URL
  const extracted = StartGGAPI.extractSlugFromUrl(input);
  if (extracted) return extracted;
  
  // Assume it's a tournament name without "tournament/" prefix
  return `tournament/${input}`;
}

async function main() {
  const args = process.argv.slice(2);
  if (!args[0]) {
    console.error('❌ Start.gg tournament URL or slug required');
    console.error('Usage: node scripts/import-startgg.js <tournament-url-or-slug>');
    console.error('Example: node scripts/import-startgg.js https://www.start.gg/tournament/ocarina-of-time-randomizer-standard-tournament-season-9/events');
    process.exit(1);
  }

  if (!process.env.STARTGG_API_TOKEN) {
    console.error('❌ STARTGG_API_TOKEN not set in environment');
    console.error('Get your token from: https://start.gg/admin/profile/developer');
    process.exit(1);
  }

  const raw = args[0];
  const slug = parseStartGGSlug(raw);
  if (!slug) {
    console.error('❌ Unable to parse start.gg slug from input');
    process.exit(1);
  }

  console.log(`\n📊 Importing tournament from start.gg: ${slug}\n`);

  // Connect to MongoDB
  await mongoose.connect(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  const { Tournament } = require('../models');

  const api = new StartGGAPI();

  try {
    console.log('⏳ Fetching tournament data from start.gg...');
    const tournamentData = await api.getTournament(slug);
    
    if (!tournamentData) {
      console.error('❌ No tournament data returned');
      process.exit(1);
    }

    console.log(`✅ Fetched: ${tournamentData.name}`);
    console.log(`   Events: ${tournamentData.events.length}`);
    console.log(`   Attendees: ${tournamentData.numAttendees}\n`);

    // Import each event as a separate tournament (or link them as needed)
    for (const event of tournamentData.events) {
      console.log(`\n🎮 Processing event: ${event.name}`);
      
      // Determine game mapping
      const matchForGame = await findGameForTournament({
        providedGameSlug: null,
        providedGameId: event.game?.id,
        tournamentName: `${tournamentData.name} - ${event.name}`,
        tournamentDescription: event.game?.name || ''
      });

      // Build participants list from standings (if available) or entrants (for active tournaments)
      const participants = [];
      const playerMap = new Map(); // Track players to avoid duplicates
      
      // Use standings if available (completed tournaments)
      if (event.standings && event.standings.length > 0) {
        for (const standing of event.standings) {
          for (const participant of standing.participants) {
            const gamerTag = participant.gamerTag || participant.userName || 'Unknown';
            
            if (!playerMap.has(gamerTag)) {
              playerMap.set(gamerTag, {
                name: gamerTag,
                finalRank: standing.placement,
                startggUserId: participant.userId,
                startggUserSlug: participant.userSlug,
                prefix: participant.prefix
              });
              participants.push(playerMap.get(gamerTag));
            }
          }
        }
      }
      // Fallback to entrants list (for active/in-progress tournaments)
      else if (event.entrants && event.entrants.length > 0) {
        for (const entrant of event.entrants) {
          for (const participant of entrant.participants) {
            const gamerTag = participant.gamerTag || participant.userName || 'Unknown';
            
            if (!playerMap.has(gamerTag)) {
              playerMap.set(gamerTag, {
                name: gamerTag,
                seed: entrant.seed,
                finalRank: null, // Not yet determined
                startggUserId: participant.userId,
                startggUserSlug: participant.userSlug,
                prefix: participant.prefix
              });
              participants.push(playerMap.get(gamerTag));
            }
          }
        }
      }

      console.log(`   Found ${participants.length} unique participants`);

      // Determine bracket type from phases
      const bracketType = event.phases?.[0]?.bracketType || 'SINGLE_ELIMINATION';
      const bracketTypeMap = {
        'SINGLE_ELIMINATION': 'single_elimination',
        'DOUBLE_ELIMINATION': 'double_elimination',
        'ROUND_ROBIN': 'round_robin',
        'SWISS': 'swiss',
        'EXHIBITION': 'exhibition',
        'CUSTOM_SCHEDULE': 'custom_schedule'
      };
      const tournamentType = bracketTypeMap[bracketType] || bracketType.toLowerCase();

      // Build matches array from sets
      const newMatches = [];
      if (event.sets && event.sets.length > 0) {
        for (const set of event.sets) {
          const match = {
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
          };
          newMatches.push(match);
        }
      }

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

      if (existingLinkMap.size) {
        console.log(`   Preserved ${existingLinkMap.size} existing race link(s)`);
      }

      console.log(`   Found ${matches.length} matches (sets)`);
      console.log(`   Bracket type: ${tournamentType}`);

      // Build phases array
      const phases = [];
      if (event.phases && event.phases.length > 0) {
        for (const phase of event.phases) {
          phases.push({
            startggPhaseId: phase.id,
            name: phase.name,
            bracketType: phase.bracketType,
            phaseOrder: phase.phaseOrder,
            numSeeds: phase.numSeeds,
            groupCount: phase.groupCount,
            state: phase.state
          });
        }
      }

      console.log(`   Found ${phases.length} phase(s)`);

      // Create tournament document
      // event.slug already contains full path like "tournament/xxx/event/yyy"
      const eventUrl = `https://start.gg/${event.slug}`;
      const tournamentPayload = {
        name: `${tournamentData.name} - ${event.name}`,
        startggId: event.id,
        startggTournamentId: tournamentData.id,
        startggSlug: event.slug,
        url: eventUrl,
        fullUrl: eventUrl,
        tournamentType: tournamentType,
        state: event.state?.toLowerCase() || 'complete',
        participantsCount: event.numEntrants,
        participants: participants,
        matches: matches,
        phases: phases,
        setsTotal: event.setsTotal || matches.length,
        startDate: event.startDate || tournamentData.startDate,
        endDate: tournamentData.endDate,
        gameName: event.game?.name || null,
        source: {
          type: 'startgg',
          externalId: String(event.id),
          tournamentId: String(tournamentData.id),
          url: `https://start.gg/${tournamentData.slug}/events/${event.slug}`,
          importedAt: new Date()
        }
      };

      if (matchForGame) {
        tournamentPayload.game = matchForGame.gameId;
        tournamentPayload.gameSlug = matchForGame.gameSlug;
        console.log(`   Mapped to game: ${matchForGame.gameSlug}`);
      } else if (event.game?.id) {
        tournamentPayload.gameId = event.game.id;
        console.log(`   Using start.gg game ID: ${event.game.id}`);
      }

      // Upsert tournament
      const tournament = await Tournament.findOneAndUpdate(
        { startggId: event.id },
        { $set: tournamentPayload, $currentDate: { updatedAt: true } },
        { upsert: true, new: true }
      );

      console.log(`   ✅ Tournament saved: ${tournament._id}`);

      console.log(`   👤 Players: skipped (source-of-truth = races Racetime)`);
    }

    console.log('\n✅ Import completed successfully!');
    console.log(`\n💡 View tournament at: http://localhost:3000/tournaments.html`);

  } catch (error) {
    console.error('\n❌ Import failed:', error.message);
    if (error.response?.data) {
      console.error('API Response:', JSON.stringify(error.response.data, null, 2));
    }
    console.error(error.stack);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

main();
