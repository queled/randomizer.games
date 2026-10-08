#!/usr/bin/env node
/**
 * Synchronise la collection Player à partir des races Racetime sur jeux randomizer.
 *
 * Règles:
 * - Upsert des joueurs ayant au moins une race sur un jeu randomizer actif
 * - Suppression des joueurs "tournoi uniquement" (tournois présents mais aucune race randomizer)
 * - Conservation des joueurs qui ont à la fois tournois + races
 *
 * Usage:
 *   node scripts/sync-players-from-races.js
 *   node scripts/sync-players-from-races.js --dry-run
 */

const connectDB = require('../config/database');
const mongoose = require('mongoose');
const { Game, Race, Player } = require('../models');
const { loadAliasIndex, getCanonicalName, normalizePlayerName } = require('../helpers/player-aliases');

const isDryRun = process.argv.includes('--dry-run');

function toLowerClean(value) {
  return String(value || '').toLowerCase().trim();
}

function getCategorySlug(category) {
  return toLowerClean(category).split('/')[0];
}

function hasTournaments(playerDoc) {
  return Array.isArray(playerDoc?.tournaments) && playerDoc.tournaments.length > 0;
}

function normalizeRacetimeProfileUrl(urlOrId) {
  const raw = String(urlOrId || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw.replace(/^http:\/\//i, 'https://').replace(/\/+$/, '');
  if (raw.startsWith('/')) return ('https://racetime.gg' + raw).replace(/\/+$/, '');
  if (raw.startsWith('user/')) return ('https://racetime.gg/' + raw).replace(/\/+$/, '');
  return 'https://racetime.gg/user/' + encodeURIComponent(raw);
}

async function getActiveRandomizerSlugs() {
  const games = await Game.find({
    enabled: { $ne: false },
    'integrations.racetime.enabled': true
  })
    .select('id integrations.racetime.gameSlug integrations.racetime.gameSlugs')
    .lean();

  const slugs = new Set();

  for (const game of games) {
    const gameId = toLowerClean(game?.id);
    const primary = toLowerClean(game?.integrations?.racetime?.gameSlug);
    const extras = Array.isArray(game?.integrations?.racetime?.gameSlugs)
      ? game.integrations.racetime.gameSlugs.map(toLowerClean)
      : [];

    if (gameId) {
      slugs.add(gameId);
      slugs.add(`${gameId}r`);
    }
    if (primary) slugs.add(primary);
    extras.forEach(s => s && slugs.add(s));
  }

  return slugs;
}

async function collectRacePlayers(allowedSlugs, aliasIndex) {
  const racePlayersByUserId = new Map();
  const raceCanonicalNames = new Set();

  const cursor = Race.find({ entrants: { $exists: true, $ne: [] } })
    .select('category entrants startedAt endedAt createdAt')
    .lean()
    .cursor();

  for await (const race of cursor) {
    const slug = getCategorySlug(race?.category);
    if (!slug || !allowedSlugs.has(slug)) continue;

    const raceTs = new Date(race?.startedAt || race?.endedAt || race?.createdAt || Date.now()).getTime();

    for (const entrant of race.entrants || []) {
      const userId = String(entrant?.userId || '').trim();
      const userName = String(entrant?.userName || '').trim();
      const canonicalName = getCanonicalName(aliasIndex, userName || userId);
      const normalizedCanonical = normalizePlayerName(canonicalName);

      if (normalizedCanonical) raceCanonicalNames.add(normalizedCanonical);
      if (!userId) continue;

      if (!racePlayersByUserId.has(userId)) {
        racePlayersByUserId.set(userId, {
          userId,
          name: canonicalName || userName || userId,
          discriminator: entrant?.userDiscriminator || null,
          racetimeUrl: normalizeRacetimeProfileUrl(entrant?.userUrl || userId),
          totalRaces: 0,
          totalWins: 0,
          lastSeenTs: raceTs
        });
      }

      const item = racePlayersByUserId.get(userId);
      item.totalRaces += 1;
      if (entrant?.place === 1 || entrant?.placeOrdinal === '1st') {
        item.totalWins += 1;
      }

      if (raceTs >= item.lastSeenTs) {
        item.lastSeenTs = raceTs;
        if (canonicalName) item.name = canonicalName;
        if (entrant?.userDiscriminator) item.discriminator = entrant.userDiscriminator;
        if (entrant?.userUrl) item.racetimeUrl = normalizeRacetimeProfileUrl(entrant.userUrl || userId);
      }
    }
  }

  return { racePlayersByUserId, raceCanonicalNames };
}

async function main() {
  await connectDB();

  try {
    console.log(`\n👤 Sync players from randomizer races${isDryRun ? ' (dry-run)' : ''}`);

    const allowedSlugs = await getActiveRandomizerSlugs();
    console.log(`🎮 Slugs randomizer actifs: ${allowedSlugs.size}`);

    if (allowedSlugs.size === 0) {
      console.log('⚠️ Aucun slug actif trouvé. Arrêt.');
      return;
    }

    const aliasIndex = await loadAliasIndex(Player);
    const { racePlayersByUserId, raceCanonicalNames } = await collectRacePlayers(allowedSlugs, aliasIndex);
    const existingPlayers = await Player.find({}).select('_id userId name tournaments twitch racetimeCheckedAt').lean();

    const existingByUserId = new Map();
    existingPlayers.forEach(p => {
      if (p?.userId) existingByUserId.set(String(p.userId), p);
    });

    let upserts = 0;
    const operations = [];

    for (const player of racePlayersByUserId.values()) {
      const existing = existingByUserId.get(player.userId);

      const setPayload = {
        name: player.name,
        discriminator: player.discriminator,
        racetimeId: player.userId,
        racetimeUrl: normalizeRacetimeProfileUrl(player.racetimeUrl || player.userId) || `https://racetime.gg/user/${encodeURIComponent(player.userId)}`,
        'stats.totalRaces': player.totalRaces,
        'stats.totalWins': player.totalWins
      };

      if (existing?.twitch) {
        setPayload.twitch = existing.twitch;
      }

      // The racetime profile is the truth: a race older than its last read keeps its name
      const checkedAt = existing?.racetimeCheckedAt ? new Date(existing.racetimeCheckedAt).getTime() : 0;
      if (checkedAt && player.lastSeenTs <= checkedAt) {
        delete setPayload.name;
        delete setPayload.discriminator;
        delete setPayload.racetimeUrl;
      }

      upserts += 1;
      operations.push({
        updateOne: {
          filter: { userId: player.userId },
          update: {
            $set: setPayload,
            $setOnInsert: { tournaments: [] },
            $currentDate: { updatedAt: true }
          },
          upsert: true
        }
      });
    }

    if (!isDryRun) {
      for (let i = 0; i < operations.length; i += 1000) {
        await Player.bulkWrite(operations.slice(i, i + 1000), { ordered: false });
      }
    }

    const raceUserIds = new Set(racePlayersByUserId.keys());

    const deletableIds = [];
    for (const p of existingPlayers) {
      const userId = String(p?.userId || '').trim();
      const normalizedName = normalizePlayerName(getCanonicalName(aliasIndex, p?.name || ''));
      const hasRaceByUserId = !!(userId && raceUserIds.has(userId));
      const hasRaceByName = !!(normalizedName && raceCanonicalNames.has(normalizedName));

      if (hasTournaments(p) && !hasRaceByUserId && !hasRaceByName) {
        deletableIds.push(p._id);
      }
    }

    if (!isDryRun && deletableIds.length > 0) {
      await Player.deleteMany({ _id: { $in: deletableIds } });
    }

    console.log(`✅ Upserts joueurs depuis races: ${upserts}`);
    console.log(`🧹 Joueurs tournoi-only à supprimer: ${deletableIds.length}`);
    if (isDryRun) {
      console.log('ℹ️ Dry-run: aucune écriture effectuée');
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(err => {
  console.error('❌ Erreur sync players:', err.message);
  process.exitCode = 1;
});
