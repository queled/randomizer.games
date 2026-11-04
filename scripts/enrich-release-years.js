#!/usr/bin/env node
/**
 * Renseigner l'année de sortie des jeux depuis IGDB
 *
 * La catégorie Twitch d'un jeu donne son identifiant IGDB (même base de jeux) : la date
 * vient de la fiche IGDB de cette catégorie. Sans catégorie Twitch, IGDB est cherché par
 * nom et seul un nom identique est retenu, si une seule fiche IGDB le porte (sinon on ne
 * sait pas laquelle est la bonne).
 * Dans les deux cas, la fiche IGDB est écartée si elle est sortie après la première release
 * GitHub du randomizer (dépôts propres à la fiche) : un randomizer n'existe pas avant son
 * jeu, c'est donc un homonyme (catégorie Twitch mal rattachée, autre jeu du même nom).
 * Seuls les jeux sans année sont modifiés (sauf --force).
 *
 * Usage:
 *   node scripts/enrich-release-years.js --dry-run        # Afficher sans rien écrire
 *   node scripts/enrich-release-years.js                  # Écrire les années trouvées
 *   node scripts/enrich-release-years.js --ids a,b     # Certains jeux seulement
 *   node scripts/enrich-release-years.js --skip a,b       # Ignorer des jeux (catégorie trompeuse)
 *
 * Variables d'environnement requises:
 *   TWITCH_CLIENT_ID     - Client ID de l'application Twitch (sert aussi pour IGDB)
 *   TWITCH_CLIENT_SECRET - Client Secret de l'application Twitch
 * Facultative :
 *   GITHUB_TOKEN         - Jeton GitHub, au-delà de 60 jeux par heure
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

// Fiche IGDB du même nom, si elle est la seule (rejected : la raison du refus)
async function searchByName(token, name) {
  const rows = await igdbQuery(token, `search "${name.replace(/"/g, '')}"; fields name,first_release_date; limit 10;`);
  const same = rows.filter(row => normalize(row.name) === normalize(name) && row.first_release_date);
  if (same.length > 1) return { rejected: `${same.length} fiches IGDB de ce nom` };
  return same[0] || null;
}

// Dépôts GitHub (propriétaire/nom) des liens de la fiche
function githubRepos(game) {
  const urls = [game.resources?.officialSite?.url, ...(game.resources?.sites || []).map(site => site.url)];
  const repos = urls
    .map(url => /^https:\/\/github\.com\/([^/]+\/[^/#?]+)/.exec(url || '')?.[1]?.replace(/\.git$/, ''))
    .filter(Boolean);
  return [...new Set(repos)];
}

// Date de la première release GitHub des dépôts propres à la fiche, sinon null. Un dépôt
// lié à d'autres fiches (même projet pour plusieurs jeux, fork Archipelago à plusieurs
// mondes) peut avoir des releases d'avant la sortie du jeu : il n'est pas pris en compte.
async function firstGithubRelease(game) {
  let first = null;
  for (const repo of githubRepos(game)) {
    const prefix = new RegExp(`^https://github\\.com/${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/|$)`, 'i');
    const shared = await Game.exists({ id: { $ne: game.id }, $or: [{ 'resources.officialSite.url': prefix }, { 'resources.sites.url': prefix }] });
    if (shared) continue;
    try {
      const { data } = await axios.get(`https://api.github.com/repos/${repo}/releases`, {
        params: { per_page: 100 },
        headers: {
          'User-Agent': 'randomizer.games',
          Accept: 'application/vnd.github+json',
          // Sans jeton, GitHub accepte 60 requêtes par heure
          ...(process.env.GITHUB_TOKEN && { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` })
        },
        timeout: 15000
      });
      for (const release of data) {
        const date = release.published_at && new Date(release.published_at);
        if (date && (!first || date < first)) first = date;
      }
    } catch (error) {
      console.warn(`  ⚠️ ${repo} : releases GitHub illisibles (${error.response?.status || error.message})`);
    }
  }
  return first;
}

async function main() {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    console.error('❌ TWITCH_CLIENT_ID et TWITCH_CLIENT_SECRET sont requis');
    process.exit(1);
  }
  await connectDB();

  const filter = FORCE ? {} : { $or: [{ 'official.releaseYear': null }, { 'official.releaseYear': { $exists: false } }] };
  if (ONLY_IDS) filter.id = { $in: ONLY_IDS };
  const games = (await Game.find(filter).select('id name official resources integrations.twitch').lean())
    .filter(game => !SKIP_IDS.has(game.id));
  console.log(`🎮 ${games.length} jeux à traiter${DRY_RUN ? ' (simulation)' : ''}`);

  const token = await getAccessToken();
  const categoryIds = [...new Set(games.map(g => g.integrations?.twitch?.categoryId).filter(Boolean))];
  const igdbByCategory = await fetchIgdbIdsByCategory(token, categoryIds);
  const releases = await fetchReleaseDates(token, [...new Set(Object.values(igdbByCategory))]);

  let updated = 0;
  const notFound = [];
  const rejected = [];
  for (const game of games) {
    const gameName = game.official?.name || game.name;
    const categoryId = game.integrations?.twitch?.categoryId;
    let match = categoryId && releases[igdbByCategory[categoryId]];
    let source = 'twitch';
    if (!match?.first_release_date) {
      match = await searchByName(token, gameName);
      source = 'search';
    }
    if (match?.first_release_date) {
      const firstRelease = await firstGithubRelease(game);
      const released = new Date(match.first_release_date * 1000);
      if (firstRelease && released > firstRelease) {
        match = { rejected: `${source}: ${match.name}, sorti le ${released.toISOString().slice(0, 10)}, après la 1re release du randomizer (${firstRelease.toISOString().slice(0, 10)})` };
      }
    }
    if (match?.rejected) {
      rejected.push(`${game.id} | ${gameName} | ${match.rejected}`);
      continue;
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

  console.log(`\n✅ ${updated} années ${DRY_RUN ? 'trouvées' : 'enregistrées'}, ${notFound.length} introuvables, ${rejected.length} écartées`);
  if (rejected.length) console.log(`Écartées (homonymes possibles) :\n${rejected.map(line => `  - ${line}`).join('\n')}`);
  if (notFound.length) console.log(notFound.map(line => `  - ${line}`).join('\n'));
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error('❌', error.response?.data || error.message);
  await mongoose.disconnect();
  process.exit(1);
});
