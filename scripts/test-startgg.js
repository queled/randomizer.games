#!/usr/bin/env node

/**
 * Test script for start.gg API
 * 
 * Usage: node scripts/test-startgg.js <tournament-url>
 * Example: node scripts/test-startgg.js https://www.start.gg/tournament/ocarina-of-time-randomizer-standard-tournament-season-9/events
 * 
 * Before running:
 * 1. Get API token from https://start.gg/admin/profile/developer
 * 2. Set environment variable: export STARTGG_API_TOKEN=your_token_here
 */

require('dotenv').config();
const StartGGAPI = require('../services/startgg');

async function main() {
  const url = process.argv[2];
  
  if (!url) {
    console.error('Usage: node scripts/test-startgg.js <tournament-url>');
    console.error('Example: node scripts/test-startgg.js https://www.start.gg/tournament/ocarina-of-time-randomizer-standard-tournament-season-9/events');
    process.exit(1);
  }

  if (!process.env.STARTGG_API_TOKEN) {
    console.error('Error: STARTGG_API_TOKEN environment variable not set');
    console.error('Get your token from: https://start.gg/admin/profile/developer');
    console.error('Then set it: export STARTGG_API_TOKEN=your_token_here');
    process.exit(1);
  }

  const api = new StartGGAPI();
  const slug = StartGGAPI.extractSlugFromUrl(url);

  if (!slug) {
    console.error('Error: Could not extract tournament slug from URL');
    console.error('URL should be like: https://www.start.gg/tournament/tournament-name/events');
    process.exit(1);
  }

  console.log(`\n📊 Testing start.gg API with tournament: ${slug}\n`);

  try {
    console.log('⏳ Fetching tournament data...\n');
    const tournament = await api.getTournament(slug);

    console.log('✅ Tournament fetched successfully!\n');
    console.log('═══════════════════════════════════════');
    console.log('📋 TOURNAMENT INFO');
    console.log('═══════════════════════════════════════');
    console.log(`ID: ${tournament.id}`);
    console.log(`Name: ${tournament.name}`);
    console.log(`Slug: ${tournament.slug}`);
    console.log(`Start Date: ${tournament.startDate}`);
    console.log(`End Date: ${tournament.endDate}`);
    console.log(`Attendees: ${tournament.numAttendees}`);
    console.log(`Source URL: ${tournament.sourceUrl}`);
    console.log(`Events: ${tournament.events.length}`);

    // Display each event
    tournament.events.forEach((event, idx) => {
      console.log('\n═══════════════════════════════════════');
      console.log(`🎮 EVENT #${idx + 1}: ${event.name}`);
      console.log('═══════════════════════════════════════');
      console.log(`ID: ${event.id}`);
      console.log(`Slug: ${event.slug}`);
      console.log(`Game: ${event.game?.name || 'Unknown'}`);
      console.log(`State: ${event.state}`);
      console.log(`Entrants: ${event.numEntrants}`);
      console.log(`Start Date: ${event.startDate}`);
      
      if (event.standings && event.standings.length > 0) {
        console.log(`\n🏆 Top ${Math.min(8, event.standings.length)} Standings:`);
        event.standings.slice(0, 8).forEach(standing => {
          const participants = standing.participants.map(p => p.gamerTag || p.userName).join(', ');
          console.log(`  ${standing.placement}. ${standing.entrantName} (${participants})`);
        });
      }

      if (event.sets && event.sets.length > 0) {
        console.log(`\n📝 Sample matches (showing ${Math.min(3, event.sets.length)} of ${event.sets.length}):`);
        event.sets.slice(0, 3).forEach(set => {
          const entrant1 = set.entrants[0]?.name || 'Unknown';
          const entrant2 = set.entrants[1]?.name || 'Unknown';
          console.log(`  Round ${set.round}: ${entrant1} vs ${entrant2}`);
          if (set.displayScore) console.log(`    Score: ${set.displayScore}`);
          if (set.completedAt) console.log(`    Completed: ${set.completedAt}`);
        });
      }
    });

    console.log('\n═══════════════════════════════════════');
    console.log('📊 DATA STRUCTURE FOR IMPORT');
    console.log('═══════════════════════════════════════');
    console.log('\nTournament structure:');
    console.log(JSON.stringify(tournament, null, 2).slice(0, 500) + '...\n');

    console.log('✅ Test completed successfully!');
    console.log('\n💡 Next steps:');
    console.log('1. Review the data structure above');
    console.log('2. Map the data to your database schema');
    console.log('3. Create import script similar to import-challonge.js');
    console.log('4. Test import with this tournament');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    if (error.response?.data) {
      console.error('Response data:', JSON.stringify(error.response.data, null, 2));
    }
    process.exit(1);
  }
}

main();
