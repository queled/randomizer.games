#!/usr/bin/env node
/**
 * Corriger le source.origin des jeux importés
 * Change 'rando-list' en 'csv-import' pour les jeux importés
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Game } = require('../models');

async function main() {
  console.log('🔄 Correction du source.origin des jeux importés\n');
  
  try {
    await connectDB();
    
    // Trouver tous les jeux avec source.origin = 'rando-list'
    const result = await Game.updateMany(
      { 'source.origin': 'rando-list' },
      { $set: { 'source.origin': 'csv-import' } }
    );
    
    console.log(`✅ Mise à jour effectuée:`);
    console.log(`   - Jeux modifiés: ${result.modifiedCount}`);
    console.log(`   - Jeux matchés: ${result.matchedCount}`);
    
  } catch (error) {
    console.error('❌ Erreur:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

main();
