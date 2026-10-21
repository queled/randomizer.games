#!/usr/bin/env node
/**
 * Fetch the covers of the games that have none (public/assets/<id>.png)
 *
 * Sources, in this order:
 *   1. the IGDB box art of the game's Twitch category, only when the category
 *      bears the game's exact name (256 × 341, converted to PNG with sips:
 *      macOS only);
 *   2. speedrun.com: the game whose name (international, Twitch) is exactly
 *      one of the game's names; when several are, the one of its release
 *      year. Its id is kept in integrations.speedrun (unless set by hand).
 *      speedrun.com throttles hard (about 15 requests, then 10 minutes):
 *      --no-speedrun leaves it out, for a quick first pass.
 * A game no source matches exactly is listed and left without a cover: no
 * cover of another game of the same name.
 *
 * Usage:
 *   node scripts/fetch-covers.js --dry-run
 *   node scripts/fetch-covers.js
 *   node scripts/fetch-covers.js --no-speedrun
 *   node scripts/fetch-covers.js --ids a,b
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const axios = require('axios');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const connectDB = require('../config/database');
const { Game } = require('../models');
const { norm } = require('../services/game-names');

const ASSETS = path.join(__dirname, '..', 'public', 'assets');
const SRC_API = 'https://www.speedrun.com/api/v1';
// speedrun.com serves its images to browsers only (Cloudflare), and only under ".png"
const BROWSER = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  Accept: 'image/avif,image/webp,image/png,*/*',
  Referer: 'https://www.speedrun.com/'
};
const DELAY_MS = 1000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// GET, waiting as long as speedrun.com asks when it answers 429
async function get(url, config, attempt = 0) {
  try {
    return await axios.get(url, { timeout: 30000, ...config });
  } catch (error) {
    if (error.response?.status !== 429 || attempt >= 3) throw error;
    const wait = (Number(error.response.headers['retry-after']) || 60) + 5;
    console.log(`  ⏳ speedrun.com demande d’attendre ${wait} s`);
    await sleep(wait * 1000);
    return get(url, config, attempt + 1);
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const idsIndex = args.indexOf('--ids');
  return {
    dryRun: args.includes('--dry-run'),
    speedrun: !args.includes('--no-speedrun'),
    ids: idsIndex !== -1 ? args[idsIndex + 1].split(',').filter(Boolean) : null
  };
}

const namesOf = game => [...new Set([game.name, game.official?.name].filter(Boolean))];
// A PNG at least 100 px wide: Twitch serves a 52 × 72 placeholder for a category without box art
const isPng = buffer => buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47 && buffer.readUInt32BE(16) >= 100;

// speedrun.com game exactly named like the game, else null
async function findOnSpeedrun(game) {
  const keys = new Set(namesOf(game).map(norm));
  const found = new Map();
  for (const name of namesOf(game)) {
    const { data } = await get(`${SRC_API}/games`, { params: { name, max: 20 } });
    await sleep(DELAY_MS);
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
  const buffer = Buffer.from(data);
  return isPng(buffer) ? buffer : null;
}

async function twitchCover(game) {
  const twitch = game.integrations?.twitch;
  if (!twitch?.boxArtUrl || !twitch.categoryName || !namesOf(game).some(n => norm(n) === norm(twitch.categoryName))) return null;
  const { data } = await axios.get(twitch.boxArtUrl.replace('{width}', '256').replace('{height}', '341'), {
    responseType: 'arraybuffer', timeout: 30000
  });
  const jpg = path.join(os.tmpdir(), `cover-${game.id}.jpg`);
  const png = jpg.replace(/\.jpg$/, '.png');
  fs.writeFileSync(jpg, Buffer.from(data));
  execFileSync('sips', ['-s', 'format', 'png', jpg, '--out', png], { stdio: 'ignore' });
  const buffer = fs.readFileSync(png);
  fs.rmSync(jpg, { force: true });
  fs.rmSync(png, { force: true });
  return isPng(buffer) ? buffer : null;
}

async function main() {
  const options = parseArgs();
  await connectDB();
  const query = options.ids ? { id: { $in: options.ids } } : {};
  const games = (await Game.find(query, { id: 1, name: 1, official: 1, image: 1, logo: 1, integrations: 1 }).lean())
    .filter(g => !fs.existsSync(path.join(ASSETS, `${g.id}.png`)) && !String(g.image || g.logo || '').startsWith('assets/'));
  console.log(`🖼️ ${games.length} jeux sans jaquette${options.dryRun ? ' (simulation)' : ''}`);

  const stats = { speedrun: [], twitch: [], none: [] };
  for (const game of games) {
    try {
      let buffer = await twitchCover(game);
      let source = buffer ? 'twitch' : null;
      let srcGame = null;
      if (!buffer && options.speedrun) {
        srcGame = await findOnSpeedrun(game);
        if (srcGame) {
          buffer = await speedrunCover(srcGame);
          await sleep(DELAY_MS);
          if (buffer) source = 'speedrun';
        }
      }
      if (!buffer) {
        stats.none.push(game.id);
        console.log(`  ✗ ${game.id} — ${game.name}`);
        continue;
      }
      stats[source].push(game.id);
      console.log(`  ✓ ${game.id} — ${game.name} (${source === 'speedrun' ? `speedrun.com : ${srcGame.names.international}` : `Twitch : ${game.integrations.twitch.categoryName}`})`);
      if (options.dryRun) continue;
      fs.writeFileSync(path.join(ASSETS, `${game.id}.png`), buffer);
      if (source === 'speedrun' && game.integrations?.speedrun?.confidence !== 'manual') {
        await Game.updateOne({ id: game.id }, {
          $set: {
            'integrations.speedrun': {
              enabled: true, gameId: srcGame.id, weblink: srcGame.weblink, confidence: 'auto', lastSync: new Date()
            }
          }
        });
      }
    } catch (error) {
      stats.none.push(game.id);
      console.log(`  ⚠️ ${game.id} — ${error.response?.status || error.message}`);
    }
  }

  console.log(`\n=== Résumé ===`);
  console.log(`speedrun.com : ${stats.speedrun.length}, Twitch (IGDB) : ${stats.twitch.length}, sans jaquette : ${stats.none.length}`);
  await mongoose.disconnect();
}

main().catch(error => {
  console.error('❌ Erreur :', error.message);
  process.exit(1);
});
