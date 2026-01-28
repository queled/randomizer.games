/**
 * Migration script to update gameName for all tournaments by fetching from Challonge
 * This ensures we have the full game name from Challonge (e.g., "The Legend of Zelda: Ocarina of Time Randomizer")
 * rather than just the internal Game document name.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { Tournament } = require('../../models');
const challongeAPI = require('../../services/challonge');

async function updateTournamentGameNames() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    // Get all tournaments that have a challongeId
    const tournaments = await Tournament.find({ challongeId: { $exists: true, $ne: null } });
    console.log(`Found ${tournaments.length} tournaments with Challonge IDs`);

    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (const tournament of tournaments) {
      try {
        console.log(`\nProcessing: ${tournament.name} (Challonge ID: ${tournament.challongeId})`);
        
        // Fetch fresh data from Challonge
        const challongeData = await challongeAPI.getTournament(tournament.challongeId);
        
        if (challongeData.gameName) {
          const oldGameName = tournament.gameName;
          tournament.gameName = challongeData.gameName;
          await tournament.save();
          
          console.log(`  ✓ Updated gameName: "${oldGameName}" → "${challongeData.gameName}"`);
          updated++;
        } else {
          console.log(`  ⊘ No gameName from Challonge, skipping`);
          skipped++;
        }
        
        // Add a small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
        
      } catch (error) {
        console.error(`  ✗ Error processing tournament ${tournament.name}:`, error.message);
        errors++;
      }
    }

    console.log('\n=== Migration Summary ===');
    console.log(`Total tournaments: ${tournaments.length}`);
    console.log(`Updated: ${updated}`);
    console.log(`Skipped: ${skipped}`);
    console.log(`Errors: ${errors}`);

  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\nDisconnected from MongoDB');
  }
}

updateTournamentGameNames();
