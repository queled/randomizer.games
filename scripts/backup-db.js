#!/usr/bin/env node
/**
 * Script de backup MongoDB
 * Crée une sauvegarde JSON de toutes les collections
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();
const mongoose = require('mongoose');

// Importer les modèles
const models = require('../models');

const backupDir = path.join(__dirname, '..', 'backups');

async function backup() {
  try {
    // Créer le dossier backups s'il n'existe pas
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    // Créer un dossier avec timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0] + '_' + new Date().getTime();
    const backupPath = path.join(backupDir, timestamp);
    fs.mkdirSync(backupPath, { recursive: true });

    // Connexion à MongoDB
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer');
    console.log('✅ Connecté à MongoDB');

    // Collections à sauvegarder
    const collections = ['games', 'races', 'players', 'tournaments', 'matches', 'runs'];
    
    let totalDocs = 0;

    for (const collectionName of collections) {
      try {
        const collection = mongoose.connection.collection(collectionName);
        const docs = await collection.find({}).toArray();
        
        const backupFile = path.join(backupPath, `${collectionName}.json`);
        fs.writeFileSync(backupFile, JSON.stringify(docs, null, 2));
        
        console.log(`  ✅ ${collectionName}: ${docs.length} documents`);
        totalDocs += docs.length;
      } catch (error) {
        console.warn(`  ⚠️ ${collectionName}: ${error.message}`);
      }
    }

    console.log(`\n✅ Backup créé: ${backupPath}`);
    console.log(`   Total: ${totalDocs} documents`);

    // Créer un lien symbolic "latest"
    const latestLink = path.join(backupDir, 'latest');
    try {
      if (fs.existsSync(latestLink)) fs.unlinkSync(latestLink);
      fs.symlinkSync(backupPath, latestLink);
      console.log(`   Lien 'latest' créé`);
    } catch (error) {
      console.warn(`   ⚠️ Impossible de créer le lien 'latest': ${error.message}`);
    }

    await mongoose.connection.close();
    console.log('✅ Déconnecté de MongoDB\n');

  } catch (error) {
    console.error('❌ Erreur lors du backup:', error.message);
    process.exit(1);
  }
}

backup();
