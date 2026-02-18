#!/usr/bin/env node
/**
 * Normalise les URLs des races Racetime en BDD.
 *
 * Corrige notamment les cas dupliqués:
 *   /dread-rando/dread-rando/helpful-elun-8995
 * -> /dread-rando/helpful-elun-8995
 */

const mongoose = require('mongoose');
require('dotenv').config({ path: process.cwd() + '/.env' });
const { Race } = require('../models');

function normalizeRacePath(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;

  let path = raw;
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname || '';
    } catch (e) {
      path = path.replace(/^https?:\/\/(www\.)?racetime\.gg/i, '');
    }
  } else if (/racetime\.gg/i.test(path)) {
    path = path.replace(/^https?:\/\/(www\.)?racetime\.gg/i, '');
  }

  path = '/' + path.replace(/^\/+/, '');
  const parts = path.split('/').filter(Boolean);

  if (parts.length >= 3 && parts[0] === parts[1]) {
    parts.splice(1, 1);
  }

  return '/' + parts.join('/');
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);

  try {
    const races = await Race.find({ url: { $exists: true, $ne: null } })
      .select('_id url')
      .lean();

    let changed = 0;
    let conflicts = 0;
    let removedDuplicates = 0;

    for (const race of races) {
      const normalized = normalizeRacePath(race.url);
      if (!normalized || normalized === race.url) continue;

      try {
        await Race.updateOne({ _id: race._id }, { $set: { url: normalized } });
        changed += 1;
      } catch (err) {
        if (err && err.code === 11000) {
          conflicts += 1;
          const existing = await Race.findOne({ url: normalized }).select('_id').lean();
          if (existing && String(existing._id) !== String(race._id)) {
            await Race.deleteOne({ _id: race._id });
            removedDuplicates += 1;
          }
        } else {
          throw err;
        }
      }
    }

    const badLeft = await Race.countDocuments({ url: /^\/([^/]+)\/\1\// });
    console.log(`✅ Races normalisées: ${changed}`);
    console.log(`⚠️ Conflits index unique ignorés: ${conflicts}`);
    console.log(`🧹 Doublons supprimés: ${removedDuplicates}`);
    console.log(`📌 Races encore dupliquées: ${badLeft}`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(err => {
  console.error('❌ Erreur normalize-race-urls:', err.message);
  process.exitCode = 1;
});
