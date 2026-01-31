#!/usr/bin/env node
/**
 * Fix ALTP game configuration - separate gameSlug and gameSlugs
 */
require('dotenv').config();
const mongoose = require('mongoose');

const connectDB = async () => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('DB connection timeout'));
    }, 30000);
    
    mongoose.connect(process.env.MONGODB_URI, {
      socketTimeoutMS: 20000,
      serverSelectionTimeoutMS: 20000,
    })
      .then(() => {
        clearTimeout(timer);
        console.log('✅ MongoDB connected');
        resolve();
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
};

async function fixALTPConfig() {
  try {
    await connectDB();
    
    const db = mongoose.connection.db;
    
    console.log('🔧 Fixing A Link to the Past configuration...');
    
    const result = await db.collection('games').findOneAndUpdate(
      { name: 'A Link to the Past' },
      {
        $set: {
          'integrations.racetime.gameSlug': 'alttpr',
          'integrations.racetime.gameSlugs': ['alttpr-ladder']
        }
      },
      { returnDocument: 'after' }
    );
    
    if (result.value) {
      console.log('✅ Updated successfully');
      console.log('  gameSlug:', result.value.integrations?.racetime?.gameSlug);
      console.log('  gameSlugs:', result.value.integrations?.racetime?.gameSlugs);
    } else {
      console.log('❌ Game not found');
    }
    
    await mongoose.disconnect();
    process.exit(0);
  } catch (e) {
    console.error('❌ Error:', e.message);
    process.exit(1);
  }
}

fixALTPConfig();
