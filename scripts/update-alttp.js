#!/usr/bin/env node
/**
 * Mettre à jour alttp dans la BDD
 * - Supprimer l'ancien ID incorrect
 * - Fusionner les données du rapport avec le jeu existant
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Game } = require('../models');

async function main() {
  console.log('🔄 Mise à jour d\'alttp\n');
  
  try {
    await connectDB();
    
    // Lire le rapport
    const reportPath = path.join(__dirname, 'tmp', 'new-games-report.json');
    if (!fs.existsSync(reportPath)) {
      console.log('❌ Rapport non trouvé:', reportPath);
      process.exit(1);
    }
    
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const alttpEntry = report.games.find(g => g.id === 'alttp');
    
    if (!alttpEntry) {
      console.log('❌ Entrée "alttp" non trouvée dans le rapport');
      process.exit(1);
    }
    
    console.log('✓ Entrée alttp trouvée dans le rapport');
    
    // Chercher les jeux avec des IDs similaires à alttp
    const similarIds = ['alltp', 'a-link-to-the-past', 'a-link-to-the-past-randomizer'];
    const oldGames = await Game.find({ id: { $in: similarIds } });
    
    if (oldGames.length > 0) {
      console.log(`\n⚠️  Trouvé ${oldGames.length} ancien(s) jeu(x) à supprimer:`);
      for (const oldGame of oldGames) {
        console.log(`  - ${oldGame.id}`);
        await Game.deleteOne({ id: oldGame.id });
        console.log(`    → Supprimé`);
      }
    } else {
      console.log('\n ℹ️  Aucun ancien ID trouvé');
    }
    
    // Mettre à jour le jeu alttp existant
    const alttp = await Game.findOne({ id: 'alttp' });
    
    if (!alttp) {
      console.log('\n❌ Jeu "alttp" non trouvé dans la BDD');
      process.exit(1);
    }
    
    console.log('\n✓ Jeu "alttp" trouvé dans la BDD');
    
    // Fusionner les données
    // Mettre à jour les sites (éviter les doublons d'URL)
    const existingSiteUrls = new Set((alttp.resources?.sites || []).map(s => s.url));
    const newSites = (alttpEntry.randomizers || []).map(r => ({
      url: r.url || null,
      name: r.name || r.url || 'Source',
      source: 'csv-import',
      isArchipelago: !!r.isArchipelago,
      isObsolete: false
    })).filter(s => !existingSiteUrls.has(s.url));
    
    if (newSites.length > 0) {
      alttp.resources = alttp.resources || {};
      alttp.resources.sites = [...(alttp.resources.sites || []), ...newSites];
      console.log(`  → Ajouté ${newSites.length} site(s)`);
    }
    
    // Mettre à jour le site officiel si pas défini
    if (!alttp.resources?.officialSite && alttpEntry.randomizers?.length > 0) {
      const mainRandomizer = alttpEntry.randomizers[0];
      alttp.resources = alttp.resources || {};
      alttp.resources.officialSite = {
        url: mainRandomizer.url,
        name: mainRandomizer.name || 'Site officiel',
        isArchipelago: !!mainRandomizer.isArchipelago
      };
      console.log(`  → Défini site officiel`);
    }
    
    // Mettre à jour les infos randomizer si manquantes
    if (!alttp.randomizer?.shortName && alttpEntry.randomizerShortName) {
      alttp.randomizer = alttp.randomizer || {};
      alttp.randomizer.shortName = alttpEntry.randomizerShortName;
      console.log(`  → Mis à jour shortName`);
    }
    
    if (!alttp.randomizer?.tinyName && alttpEntry.randomizerTinyName) {
      alttp.randomizer = alttp.randomizer || {};
      alttp.randomizer.tinyName = alttpEntry.randomizerTinyName;
      console.log(`  → Mis à jour tinyName`);
    }
    
    // Sauvegarder
    await alttp.save();
    console.log('\n✅ Jeu "alttp" mis à jour avec succès');
    
  } catch (error) {
    console.error('❌ Erreur:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

main();
