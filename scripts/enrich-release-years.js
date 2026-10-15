#!/usr/bin/env node
/**
 * Renseigner l'année de sortie des jeux depuis IGDB
 *
 * La catégorie Twitch d'un jeu donne son identifiant IGDB (même base de jeux) : la date
 * vient de la fiche IGDB de cette catégorie. Sans catégorie Twitch, IGDB est cherché par
 * nom et seul un nom identique est retenu.
 * Seuls les jeux sans année sont modifiés (sauf --force).
 *
 * Usage:
 *   node scripts/enrich-release-years.js --dry-run        # Afficher sans rien écrire
 *   node scripts/enrich-release-years.js                  # Écrire les années trouvées
 *   node scripts/enrich-release-years.js --ids oot,mm     # Certains jeux seulement
 *   node scripts/enrich-release-years.js --skip a,b       # Ignorer des jeux (catégorie trompeuse)
 *
 * Variables d'environnement requises:
 *   TWITCH_CLIENT_ID     - Client ID de l'application Twitch (sert aussi pour IGDB)
 *   TWITCH_CLIENT_SECRET - Client Secret de l'application Twitch
 */

const path = require('path');
const axios = require('axios');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const connectDB = require('../config/database');
const { Game } = require('../models');

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const IGDB_DELAY_MS = 300; // IGDB : 4 requêtes par seconde au maximum

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');
const listArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1].split(',').map(s => s.trim()).filter(Boolean) : null;
};
const ONLY_IDS = listArg('--ids');
const SKIP_IDS = new Set(listArg('--skip') || []);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const normalize = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

async function getAccessToken() {
  const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
    params: { client_id: TWITCH_CLIENT_ID, client_secret: TWITCH_CLIENT_SECRET, grant_type: 'client_credentials' }
  });
  return response.data.access_token;
}

/**
 * Identifiants IGDB des catégories Twitch, par paquets de 100
 */
async function fetchIgdbIdsByCategory(token, categoryIds) {
  const result = {};
  for (let i = 0; i < categoryIds.length; i += 100) {
    const chunk = categoryIds.slice(i, i + 100);
    const params = new URLSearchParams();
    chunk.forEach(id => params.append('id', id));
    const response = await axios.get(`https://api.twitch.tv/helix/games?${params}`, {
      headers: { 'Client-ID': TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` }
    });
    for (const category of response.data.data || []) {
      if (category.igdb_id) result[category.id] = category.igdb_id;
    }
  }
  return result;
}

async function igdbQuery(token, body) {
  await sleep(IGDB_DELAY_MS);
  const response = await axios.post('https://api.igdb.com/v4/games', body, {
    headers: { 'Client-ID': TWITCH_CLIENT_ID, Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }
  });
  return response.data || [];
}

/**
 * Date de première sortie des fiches IGDB, par paquets de 500
 */
async function fetchReleaseDates(token, igdbIds) {
  const result = {};
  for (let i = 0; i < igdbIds.length; i += 500) {
    const chunk = igdbIds.slice(i, i + 500);
    const rows = await igdbQuery(token, `fields name,first_release_date; where id = (${chunk.join(',')}); limit 500;`);
    for (const row of rows) result[row.id] = row;
  }
  return result;
}

async function searchByName(token, name) {
  const rows = await igdbQuery(token, `search "${name.replace(/"/g, '')}"; fields name,first_release_date; limit 10;`);
  return rows.find(row => normalize(row.name) === normalize(name) && row.first_release_date) || null;
}

async function main() {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    console.error('❌ TWITCH_CLIENT_ID et TWITCH_CLIENT_SECRET sont requis');
    process.exit(1);
  }
  await connectDB();

  const filter = FORCE ? {} : { $or: [{ 'official.releaseYear': null }, { 'official.releaseYear': { $exists: false } }] };
  if (ONLY_IDS) filter.id = { $in: ONLY_IDS };
  const games = (await Game.find(filter).select('id name official integrations.twitch').lean())
    .filter(game => !SKIP_IDS.has(game.id));
  console.log(`🎮 ${games.length} jeux à traiter${DRY_RUN ? ' (simulation)' : ''}`);

  const token = await getAccessToken();
  const categoryIds = [...new Set(games.map(g => g.integrations?.twitch?.categoryId).filter(Boolean))];
  const igdbByCategory = await fetchIgdbIdsByCategory(token, categoryIds);
  const releases = await fetchReleaseDates(token, [...new Set(Object.values(igdbByCategory))]);

  let updated = 0;
  const notFound = [];
  for (const game of games) {
    const gameName = game.official?.name || game.name;
    const categoryId = game.integrations?.twitch?.categoryId;
    let match = categoryId && releases[igdbByCategory[categoryId]];
    let source = 'twitch';
    if (!match?.first_release_date) {
      match = await searchByName(token, gameName);
      source = 'search';
    }
    if (!match?.first_release_date) {
      notFound.push(`${game.id} | ${gameName}`);
      continue;
    }

    const releaseDate = new Date(match.first_release_date * 1000);
    const releaseYear = releaseDate.getUTCFullYear();
    console.log(`${game.id} | ${gameName} | ${releaseYear} | ${source}: ${match.name}`);
    if (!DRY_RUN) {
      const set = { 'official.releaseYear': releaseYear };
      if (!game.official?.releaseDate || FORCE) set['official.releaseDate'] = releaseDate;
      await Game.updateOne({ id: game.id }, { $set: set });
    }
    updated++;
  }

  console.log(`\n✅ ${updated} années ${DRY_RUN ? 'trouvées' : 'enregistrées'}, ${notFound.length} introuvables`);
  if (notFound.length) console.log(notFound.map(line => `  - ${line}`).join('\n'));
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('❌', error.response?.data || error.message);
  await mongoose.disconnect();
  process.exit(1);
});
