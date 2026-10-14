#!/usr/bin/env node
/**
 * Lit le profil racetime.gg de chaque joueur (source de vérité) :
 * - le nom affiché devient le nom racetime actuel, même sans course récente ;
 * - un compte que racetime ne connaît plus (404) ou qu'il a anonymisé après sa
 *   suppression (« --Deleted Account-- ») est marqué supprimé (`racetimeDeletedAt`)
 *   et quitte les listes de joueurs ; ses courses restent.
 *   Un compte marqué qui répond de nouveau est rétabli.
 *
 * Les joueurs lus le moins récemment passent en premier. Les joueurs SpeedRunsLive
 * n'ont pas de compte racetime ni de document Player : ils ne sont pas concernés.
 *
 * Usage :
 *   node scripts/sync-racetime-profiles.js [--dry-run] [--limit N] [--stale-days N] [--user ID]
 *     --limit N       au plus N profils lus
 *     --user ID       seulement ce compte racetime
 *     --stale-days N  seulement les profils non lus depuis N jours
 */

const mongoose = require('mongoose');
const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.resolve(process.cwd(), '.env') });

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/randomizer';
const RATE_LIMIT_MS = parseInt(process.env.RACETIME_RATE_LIMIT_MS) || 1000;
// Erreurs (hors 404) de suite avant d'abandonner : racetime est sans doute indisponible
const MAX_CONSECUTIVE_ERRORS = 10;
const { Player } = require('../models');

// Nom que racetime donne à un compte supprimé : son id reste, le profil est vidé
const DELETED_ACCOUNT_NAME = '--Deleted Account--';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs() {
  const args = process.argv.slice(2);
  const value = (flag) => (args.includes(flag) ? parseInt(args[args.indexOf(flag) + 1], 10) : null);
  return {
    dryRun: args.includes('--dry-run'),
    limit: value('--limit'),
    staleDays: value('--stale-days'),
    user: args.includes('--user') ? args[args.indexOf('--user') + 1] : null
  };
}

// { status: 200, data } | { status: 404 }, après une pause en cas de 429
async function fetchProfile(userId) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await axios.get(`https://racetime.gg/user/${encodeURIComponent(userId)}/data`, {
        timeout: 15000,
        headers: { 'User-Agent': 'RandomizerWebsite/1.0' }
      });
      return { status: 200, data: response.data };
    } catch (error) {
      const status = error.response?.status;
      if (status === 404) return { status: 404 };
      if (status === 429 && attempt === 0) {
        await sleep(60000);
        continue;
      }
      throw error;
    }
  }
  throw new Error('429 Too Many Requests');
}

async function main() {
  const { dryRun, limit, staleDays, user } = parseArgs();
  await mongoose.connect(MONGODB_URI);

  const filter = user ? { userId: user } : { userId: { $nin: [null, ''] } };
  if (staleDays) {
    filter.$or = [
      { racetimeCheckedAt: null },
      { racetimeCheckedAt: { $lt: new Date(Date.now() - staleDays * 24 * 3600 * 1000) } }
    ];
  }
  let query = Player.find(filter).select('userId name discriminator racetimeDeletedAt').sort({ racetimeCheckedAt: 1 }).lean();
  if (limit) query = query.limit(limit);
  const players = await query;
  console.log(`🔎 ${players.length} profil(s) racetime à lire${dryRun ? ' (dry run)' : ''}`);

  const stats = { read: 0, renamed: 0, deleted: 0, restored: 0, errors: 0 };
  let consecutiveErrors = 0;
  for (const player of players) {
    let profile;
    try {
      profile = await fetchProfile(player.userId);
      consecutiveErrors = 0;
    } catch (error) {
      stats.errors++;
      console.error(`   ⚠️ ${player.name} (${player.userId}) : ${error.message}`);
      if (++consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error('❌ Trop d\'erreurs de suite, arrêt');
        process.exitCode = 1;
        break;
      }
      await sleep(RATE_LIMIT_MS);
      continue;
    }
    stats.read++;

    const update = { $set: { racetimeCheckedAt: new Date() } };
    if (profile.status === 404 || profile.data?.name === DELETED_ACCOUNT_NAME) {
      if (profile.status !== 404) update.$set.name = DELETED_ACCOUNT_NAME;
      if (!player.racetimeDeletedAt) {
        update.$set.racetimeDeletedAt = new Date();
        stats.deleted++;
        console.log(`   🗑️ ${player.name} (${player.userId}) : compte supprimé de racetime`);
      }
    } else {
      const { name, discriminator, url } = profile.data || {};
      if (name) update.$set.name = name;
      if (discriminator) update.$set.discriminator = discriminator;
      if (url) update.$set.racetimeUrl = `https://racetime.gg${url}`;
      if (name && name !== player.name) {
        stats.renamed++;
        console.log(`   ✏️ ${player.name} → ${name}`);
      }
      if (player.racetimeDeletedAt) {
        update.$unset = { racetimeDeletedAt: 1 };
        stats.restored++;
        console.log(`   ♻️ ${name || player.name} : compte de nouveau connu de racetime`);
      }
    }
    if (!dryRun) await Player.updateOne({ _id: player._id }, update);
    await sleep(RATE_LIMIT_MS);
  }

  console.log(`\n✅ ${stats.read} lu(s), ${stats.renamed} renommé(s), ${stats.deleted} supprimé(s), ${stats.restored} rétabli(s), ${stats.errors} erreur(s)`);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
