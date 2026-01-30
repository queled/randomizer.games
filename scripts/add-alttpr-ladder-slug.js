#!/usr/bin/env node
/**
 * Ajouter le slug additionnel alttpr-ladder pour le jeu alttp
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Game } = require('../models');

async function main() {
  console.log('🔄 Ajout du slug additionnel pour alttp\n');
  
  try {
    await connectDB();
    
    // Trouver le jeu alttp
    const game = await Game.findOne({ id: 'alttp' });
    
    if (!game) {
      console.log('❌ Jeu "alttp" non trouvé');
      process.exit(1);
    }
    
    console.log(`✓ Jeu trouvé: ${game.name}`);
    console.log(`  Slug principal: ${game.integrations?.racetime?.gameSlug}`);
    console.log(`  Slugs additionnels: ${(game.integrations?.racetime?.gameSlugs || []).join(', ') || '(aucun)'}`);
    
    // Vérifier si alttpr-ladder est déjà dans la liste
    const currentSlugs = game.integrations?.racetime?.gameSlugs || [];
    if (currentSlugs.includes('alttpr-ladder')) {
      console.log('\n⚠️  Le slug "alttpr-ladder" est déjà présent');
      process.exit(0);
    }
    
    // Ajouter alttpr-ladder
    if (!game.integrations.racetime) {
      game.integrations.racetime = {};
    }
    if (!game.integrations.racetime.gameSlugs) {
      game.integrations.racetime.gameSlugs = [];
    }
    
    game.integrations.racetime.gameSlugs.push('alttpr-ladder');
    await game.save();
    
    console.log('\n✅ Slug additionnel ajouté avec succès');
    console.log(`  Slugs additionnels: ${game.integrations.racetime.gameSlugs.join(', ')}`);
    
  } catch (error) {
    console.error('❌ Erreur:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

main();
