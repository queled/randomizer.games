#!/usr/bin/env node
require('dotenv').config();
const connectDB = require('./config/database');
const { Game } = require('./models');

(async () => {
  try {
    await connectDB();
    
    // Mettre à jour le game A Link to the Past
    const result = await Game.updateOne(
      { name: 'A Link to the Past' },
      {
        'integrations.racetime.gameSlug': 'alttpr',
        'integrations.racetime.gameSlugs': ['alttpr-ladder']
      }
    );
    
    console.log('Updated:', result.modifiedCount, 'game(s)');
    
    // Vérifier la mise à jour
    const alttp = await Game.findOne({ name: 'A Link to the Past' });
    console.log('\nNouveaux slugs:');
    console.log('  gameSlug:', alttp?.integrations?.racetime?.gameSlug);
    console.log('  gameSlugs:', alttp?.integrations?.racetime?.gameSlugs);
    
    process.exit(0);
  } catch (e) {
    console.error('Erreur:', e.message);
    process.exit(1);
  }
})();
