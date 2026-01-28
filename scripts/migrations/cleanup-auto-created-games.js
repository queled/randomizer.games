/**
 * Script de nettoyage des jeux auto-créés incorrectement
 * Ces jeux ont été créés par randomizer au lieu de par jeu
 * 
 * Usage: node scripts/migrations/cleanup-auto-created-games.js [--apply]
 */

const mongoose = require('mongoose');
const connectDB = require('../../config/database');
const { Game } = require('../../models');

async function main() {
  const dryRun = !process.argv.includes('--apply');
  
  console.log('🧹 Nettoyage des jeux auto-créés incorrectement\n');
  
  if (dryRun) {
    console.log('⚠️  Mode DRY RUN - Aucune modification ne sera effectuée');
    console.log('   Utilisez --apply pour supprimer réellement\n');
  }
  
  try {
    await connectDB();
    
    // Trouver tous les jeux auto-créés depuis rando-list
    const autoCreatedGames = await Game.find({
      'source.origin': 'rando-list',
      'source.autoCreated': true
    });
    
    console.log(`📋 ${autoCreatedGames.length} jeu(x) auto-créé(s) trouvé(s):\n`);
    
    for (const game of autoCreatedGames) {
      console.log(`  - ${game.id}: ${game.displayName}`);
    }
    
    if (autoCreatedGames.length === 0) {
      console.log('\n✅ Aucun jeu à supprimer');
      return;
    }
    
    if (!dryRun) {
      console.log('\n🗑️  Suppression en cours...');
      
      const result = await Game.deleteMany({
        'source.origin': 'rando-list',
        'source.autoCreated': true
      });
      
      console.log(`\n✅ ${result.deletedCount} jeu(x) supprimé(s)`);
    } else {
      console.log(`\n📝 ${autoCreatedGames.length} jeu(x) seraient supprimés avec --apply`);
    }
    
  } catch (error) {
    console.error('\n❌ Erreur:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\n⚠️  MongoDB disconnected');
  }
}

main();
