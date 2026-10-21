#!/usr/bin/env node
/**
 * Fetch the covers of the games (public/assets/<id>.png)
 *
 * The cover is the game's IGDB box art (264 × 352, vertical like the site's
 * posters). The IGDB entry is the one of the game's Twitch category, else
 * found by name; it is taken only when it is the same game:
 *   - its name, or one of its alternative names, is exactly one of the game's
 *     own names (site, official, rando-list, Archipelago worlds; not the
 *     Twitch category's, which is what is being checked);
 *   - its first release year is the game's; an entry found by name (not
 *     through the Twitch category) needs the game's year to match.
 * With --speedrun, a game IGDB has no cover for then tries speedrun.com
 * (exact name; it throttles hard: about 15 requests, then 10 minutes).
 * A game no source matches is listed and left as it is: no cover of another
 * game of the same name.
 *
 * By default only the games without a cover are done; --replace-non-vertical
 * also replaces the square and landscape covers. Vertical covers are never
 * touched, nor the ones made by hand (HAND_MADE).
 *
 * Usage:
 *   node scripts/fetch-covers.js --dry-run
 *   node scripts/fetch-covers.js
 *   node scripts/fetch-covers.js --replace-non-vertical
 *   node scripts/fetch-covers.js --speedrun
 *   node scripts/fetch-covers.js --ids a,b
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const connectDB = require('../config/database');
const { Game } = require('../models');
const { norm } = require('../services/game-names');

const ASSETS = path.join(__dirname, '..', 'public', 'assets');
const IGDB_DELAY_MS = 300; // IGDB: 4 requests per second at most
const SRC_API = 'https://www.speedrun.com/api/v1';
// speedrun.com serves its images to browsers only (Cloudflare), and only under ".png"
const BROWSER = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  Accept: 'image/avif,image/webp,image/png,*/*',
  Referer: 'https://www.speedrun.com/'
};
const SRC_DELAY_MS = 1000;
// Covers made by hand: games of two versions, the covers cut diagonally
const HAND_MADE = new Set(['pkmnrb', 'pkmnbaw', 'pkmnbw2', 'pkmnfl', 'mmbn3', 'mmbn5', 'mmbn6', 'ie2', 'iegcs', 'medabots', 'dwm2', 'dq12']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function parseArgs() {
  const args = process.argv.slice(2);
  const idsIndex = args.indexOf('--ids');
  return {
    dryRun: args.includes('--dry-run'),
    replace: args.includes('--replace-non-vertical'),
    speedrun: args.includes('--speedrun'),
    ids: idsIndex !== -1 ? args[idsIndex + 1].split(',').filter(Boolean) : null
  };
}

// GET, waiting as long as the site asks when it answers 429
async function get(url, config, attempt = 0) {
  try {
    return await axios.get(url, { timeout: 30000, ...config });
  } catch (error) {
    if (error.response?.status !== 429 || attempt >= 3) throw error;
    const wait = (Number(error.response.headers['retry-after']) || 60) + 5;
    console.log(`  ⏳ ${new URL(url).host} demande d’attendre ${wait} s`);
    await sleep(wait * 1000);
    return get(url, config, attempt + 1);
  }
}

// Names the game goes by on the site and in the lists it is tied to
const namesOf = game => [...new Set([
  game.name,
  game.official?.name,
  game.integrations?.randoList?.gameName,
  ...(game.integrations?.randoList?.gameNames || []),
  game.integrations?.archipelago?.gameName,
  game.integrations?.multiworld?.gameName,
  ...(game.integrations?.apworld?.gameNames || [])
].filter(Boolean))];

// Width and height of a PNG, else null
function pngSize(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
// A cover: a PNG at least 100 px wide (Twitch and others serve tiny placeholders)
const isCover = buffer => (pngSize(buffer)?.width || 0) >= 100;
const isVertical = buffer => {
  const size = pngSize(buffer);
  return !!size && size.height / size.width > 1.15;
};

function coverFile(game) {
  const image = String(game.image || game.logo || '');
  return path.join(__dirname, '..', 'public', image.startsWith('assets/') ? image : `assets/${game.id}.png`);
}

class Igdb {
  async init() {
    const { data } = await axios.post('https://id.twitch.tv/oauth2/token', null, {
      params: { client_id: process.env.TWITCH_CLIENT_ID, client_secret: process.env.TWITCH_CLIENT_SECRET, grant_type: 'client_credentials' }
    });
    this.headers = { 'Client-ID': process.env.TWITCH_CLIENT_ID, Authorization: `Bearer ${data.access_token}` };
  }

  async games(body) {
    await sleep(IGDB_DELAY_MS);
    const { data } = await axios.post('https://api.igdb.com/v4/games', body, {
      headers: { ...this.headers, 'Content-Type': 'text/plain' }, timeout: 30000
    });
    return data || [];
  }

  // IGDB id of each Twitch category
  async idsOfCategories(categoryIds) {
    const result = {};
    for (let i = 0; i < categoryIds.length; i += 100) {
      const params = new URLSearchParams();
      categoryIds.slice(i, i + 100).forEach(id => params.append('id', id));
      const { data } = await get(`https://api.twitch.tv/helix/games?${params}`, { headers: this.headers });
      for (const category of data.data || []) if (category.igdb_id) result[category.id] = category.igdb_id;
    }
    return result;
  }
}

const FIELDS = 'fields name,first_release_date,cover.image_id,alternative_names.name,url;';

// The IGDB entry is the game: same name (or alternative name), same year when known
function sameGame(entry, game, { needYear = false } = {}) {
  if (!entry?.cover?.image_id) return false;
  const keys = new Set(namesOf(game).map(norm));
  const names = [entry.name, ...(entry.alternative_names || []).map(a => a.name)];
  if (!names.some(n => keys.has(norm(n)))) return false;
  const year = game.official?.releaseYear;
  if (needYear && !year) return false;
  return !year || !entry.first_release_date || new Date(entry.first_release_date * 1000).getUTCFullYear() === year;
}

async function findOnIgdb(igdb, game, igdbByCategory) {
  const fromCategory = igdbByCategory[game.integrations?.twitch?.categoryId];
  if (fromCategory) {
    const [entry] = await igdb.games(`${FIELDS} where id = ${fromCategory};`);
    if (sameGame(entry, game)) return { entry, via: 'Twitch' };
  }
  const found = new Map();
  for (const name of namesOf(game)) {
    for (const entry of await igdb.games(`search "${name.replace(/"/g, '')}"; ${FIELDS} limit 10;`)) {
      if (sameGame(entry, game, { needYear: true })) found.set(entry.id, entry);
    }
  }
  // Several entries pass (ports, homonyms of the same year): no guess
  return found.size === 1 ? { entry: [...found.values()][0], via: 'recherche' } : null;
}

async function igdbCover(entry) {
  const { data } = await axios.get(`https://images.igdb.com/igdb/image/upload/t_cover_big/${entry.cover.image_id}.png`, {
    responseType: 'arraybuffer', timeout: 30000
  });
  const buffer = Buffer.from(data);
  return isCover(buffer) ? buffer : null;
}

// speedrun.com game exactly named like the game, else null
async function findOnSpeedrun(game) {
  const keys = new Set(namesOf(game).map(norm));
  const found = new Map();
  for (const name of [game.name, game.official?.name].filter(Boolean)) {
    const { data } = await get(`${SRC_API}/games`, { params: { name, max: 20 } });
    await sleep(SRC_DELAY_MS);
    for (const g of data.data) {
      if ([g.names.international, g.names.twitch].some(n => n && keys.has(norm(n)))) found.set(g.id, g);
    }
  }
  const list = [...found.values()];
  if (list.length <= 1) return list[0] || null;
  const sameYear = list.filter(g => g.released && g.released === game.official?.releaseYear);
  return sameYear.length === 1 ? sameYear[0] : null;
}

async function speedrunCover(srcGame) {
  const { data } = await get(`https://www.speedrun.com/static/game/${srcGame.id}/cover.png`, {
    headers: BROWSER, responseType: 'arraybuffer'
  });
  await sleep(SRC_DELAY_MS);
  const buffer = Buffer.from(data);
  return isCover(buffer) ? buffer : null;
}

async function main() {
  const options = parseArgs();
  await connectDB();
  const query = options.ids ? { id: { $in: options.ids } } : {};
  const all = await Game.find(query, { id: 1, name: 1, official: 1, image: 1, logo: 1, integrations: 1 }).lean();
  const games = all.filter(game => {
    if (HAND_MADE.has(game.id)) return false;
    const file = coverFile(game);
    if (!fs.existsSync(file)) return true;
    return options.replace && !isVertical(fs.readFileSync(file));
  });
  const missing = games.filter(g => !fs.existsSync(coverFile(g))).length;
  console.log(`🖼️ ${missing} jeux sans jaquette, ${games.length - missing} jaquettes non verticales${options.dryRun ? ' (simulation)' : ''}`);

  const igdb = new Igdb();
  await igdb.init();
  const categoryIds = [...new Set(games.map(g => g.integrations?.twitch?.categoryId).filter(Boolean))];
  const igdbByCategory = await igdb.idsOfCategories(categoryIds);

  const stats = { igdb: [], speedrun: [], none: [] };
  for (const game of games) {
    const replacing = fs.existsSync(coverFile(game));
    try {
      let buffer = null;
      let label = null;
      let srcGame = null;
      const found = await findOnIgdb(igdb, game, igdbByCategory);
      if (found) {
        buffer = await igdbCover(found.entry);
        const year = found.entry.first_release_date ? new Date(found.entry.first_release_date * 1000).getUTCFullYear() : '?';
        label = `IGDB ${found.via} : ${found.entry.name}, ${year}, ${found.entry.url}`;
      }
      if (!buffer && options.speedrun) {
        srcGame = await findOnSpeedrun(game);
        if (srcGame) buffer = await speedrunCover(srcGame);
        if (buffer) label = `speedrun.com : ${srcGame.names.international}`;
      }
      if (!buffer) {
        stats.none.push(game.id);
        console.log(`  ✗ ${game.id} — ${game.name}${replacing ? ' (jaquette actuelle gardée)' : ''}`);
        continue;
      }
      stats[srcGame && label.startsWith('speedrun') ? 'speedrun' : 'igdb'].push(game.id);
      console.log(`  ✓ ${game.id} — ${game.name} (${label})${replacing ? ' — remplace la jaquette' : ''}`);
      if (options.dryRun) continue;
      fs.writeFileSync(coverFile(game), buffer);
      if (srcGame && game.integrations?.speedrun?.confidence !== 'manual') {
        await Game.updateOne({ id: game.id }, {
          $set: { 'integrations.speedrun': { enabled: true, gameId: srcGame.id, weblink: srcGame.weblink, confidence: 'auto', lastSync: new Date() } }
        });
      }
    } catch (error) {
      stats.none.push(game.id);
      console.log(`  ⚠️ ${game.id} — ${error.response?.status || error.message}`);
    }
  }

  console.log(`\n=== Résumé ===`);
  console.log(`IGDB : ${stats.igdb.length}, speedrun.com : ${stats.speedrun.length}, sans résultat : ${stats.none.length}`);
  await mongoose.disconnect();
}

main().catch(error => {
  console.error('❌ Erreur :', error.message);
  process.exit(1);
});
