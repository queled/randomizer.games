const express = require('express');
const { whenConnected } = require('../config/database');
const router = express.Router();
const { Game } = require('../models');
const { isSafeImageContentType, setRelayedImageHeaders } = require('../middleware/security');
const { titleNamesRace } = require('../helpers/restream-titles');
const { gameGoalFilters, isGoalAllowed } = require('../helpers/racetime-goals');
const { gameLabel } = require('../helpers/game-label');

// Cache for stream results (5 minutes TTL)
const cache = {
  data: {},
  expires: {}
};

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function getCached(key) {
  if (cache.data[key] && cache.expires[key] > Date.now()) {
    return cache.data[key];
  }
  return null;
}

function setCache(key, data, ttl = CACHE_TTL) {
  cache.data[key] = data;
  cache.expires[key] = Date.now() + ttl;
}

// Twitch API configuration
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;

let twitchAccessToken = null;
let twitchTokenExpires = 0;
let twitchTokenInFlight = null;

// Concurrent callers share a single token request
function getTwitchToken() {
  if (twitchAccessToken && twitchTokenExpires > Date.now()) {
    return Promise.resolve(twitchAccessToken);
  }
  if (!twitchTokenInFlight) {
    twitchTokenInFlight = requestTwitchToken().finally(() => {
      twitchTokenInFlight = null;
    });
  }
  return twitchTokenInFlight;
}

async function requestTwitchToken() {
  if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
    return null;
  }

  try {
    const response = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: TWITCH_CLIENT_ID,
        client_secret: TWITCH_CLIENT_SECRET,
        grant_type: 'client_credentials'
      })
    });

    if (!response.ok) {
      console.error('Failed to get Twitch token:', response.status);
      return null;
    }

    const data = await response.json();
    twitchAccessToken = data.access_token;
    twitchTokenExpires = Date.now() + (data.expires_in * 1000) - 60000; // Refresh 1 minute early
    return twitchAccessToken;
  } catch (error) {
    console.error('Error getting Twitch token:', error);
    return null;
  }
}

// Keywords that must appear in title/tags for combo games (case-insensitive)
const COMBO_KEYWORDS = {
  'ootmm': ['ootmm', 'oot mm', 'ootxmm', 'oot x mm', 'ocarina majora', 'oot+mm', 'oot/mm'],
  'smz3': ['smz3', 'sm z3', 'smxz3', 'sm x z3', 'super metroid link', 'metroid alttp', 'sm+z3', 'z3sm'],
  'hodbt': ['hodbt', 'hod bt', 'hodxbt', 'harmony bomberman'],
  'mpcg': ['mpcg', 'crossgame', 'cross game', 'mp1 mp2', 'prime crossover'],
  'z1m1': ['z1m1', 'z1 m1', 'zelda metroid nes', 'z1xm1'],
  'z1m1z3m3': ['z1m1z3m3', 'z1m1z3', 'multiworld', 'quad randomizer', 'quad crossover randomizer'],
  'mmtww': ['wily wars', 'wilywars', 'wily war', 'mmtww', 'mega world', 'megaworld'],
  'upkmn': ['upr', 'universal pokemon', 'universal pokémon', 'universal randomizer']
};

// Combo games: streams are fetched from the Twitch categories of their source
// games, then kept by COMBO_KEYWORDS (all of them when the game has none).
// Categories are given by ID: Twitch answers some names with a duplicate
// category (a remake, another version, a stub).
const COMBO_TWITCH_CATEGORY_IDS = {
  'ootmm': ['11557', '12482'],
  'smz3': ['9435', '7595'],
  'hodbt': ['16541', '8352'],
  'mpcg': ['14198', '1459'],
  'z1m1': ['10979', '19813'],
  'z1m1z3m3': ['10979', '19813', '9435', '7595'],
  // A remake without a Twitch category: streamed under the games it remakes,
  // the originals or the remake versions Twitch lists apart
  'mmtww': ['4815', '12870', '4133', '1478044090', '1003948618', '1311228706'],
  // A game sold as two editions, the third one has no category
  'fe14': ['405007883', '1674286069'],
  // Games sold as two versions, one category each (Twitch also lists the
  // DWM2 pair together, and the MMBN versions again in the Legacy Collection)
  'dwm2': ['395287996', '1982003207', '74065666'],
  'mmbn3': ['1550736308', '1388250717'],
  'mmbn5': ['1984284718', '324568485', '831068607', '1296951556'],
  'mmbn6': ['1565051033', '740052011', '1809826844', '1247663652'],
  'ie2': ['23396', '711834465'],
  'iegcs': ['259153033', '1080451162'],
  'medabots': ['20912', '1355062682'],
  'dwdd': ['1786018241', '22093'],
  // Twitch lists each pair together and one of its versions apart
  'pkmnrb': ['3623', '1528763908'],
  'pkmnbw': ['27602', '1432908059'],
  'pkmnbw2': ['33734', '1690221315'],
  // A game and its fan remake, one category each
  'legorrmm': ['9147', '375440842'],
  // A game randomized on its NES version, also streamed under its remakes'
  // categories (the Western titles of the mobile, console and DS versions)
  'dw': ['1565834559', '1775376845'],
  'dw2': ['604531278', '451728013', '835849790'],
  'dw3': ['1385699518', '1253712846'],
  'dw4': ['488153', '1734826487'],
  // The Super Famicom remake of the first two games, one category each
  'dq12': ['18994872', '327576750'],
  // A randomizer of every main game of a series, streamed under each game's
  // category, pair or version
  'upkmn': [
    '3623', '1528763908', '17124',
    '7528', '185837347', '14543',
    '9287', '1144464298', '10609', '13332',
    '2993', '1343302596', '19745', '23857',
    '27602', '1432908059', '33734', '1690221315',
    '103828', '2045592890', '460327',
    '491599', '1926347727', '497334', '351385416'
  ]
};

// Per-game extra filters:
// - PER_GAME_TITLE_KEYWORDS: require one of these keywords to start a word of the title/tags
// - PER_GAME_ALLOWED_TWITCH_CATEGORIES: only accept streams whose Twitch category name matches one of these
const PER_GAME_TITLE_KEYWORDS = {
  'ootmq': ['master quest', 'mq', 'ootmq'],
  // ROM hacks have no Twitch category of their own: they are streamed under
  // the game they modify (stored as their category), named in the title
  'ascent': ['ascent'],
  'cryogenesis': ['cryogenesis'],
  'dc': ['digital cube'],
  'mtbp': ['blue plague'],
  'nature': ['nature'],
  'oxide': ['oxide'],
  'recovery': ['recovery'],
  'smcr': ['cliffhanger'],
  'sme2': ['escape ii', 'escape 2'],
  'smeris': ['eris'],
  'smgd': ['golden dawn'],
  'smhm': ['hyper metroid'],
  'smpb': ['project base'],
  'stardust': ['stardust'],
  'subversion': ['subversion'],
  'szm': ['super zero mission'],
  'vitality': ['vitality'],
  'zf': ['z-factor', 'z factor', 'zfactor'],
  'msm': ['spooky mission'],
  'msm2': ['spooky mission 2', 'spooky mission ii'],
  's6': ['scrolls six', 'scrolls 6'],
  'wm': ['winter mission'],
  'zmdf': ['deep freeze'],
  'smredesign': ['redesign'],
  'superjunkoid': ['junkoid'],
  'cm64': ['cursed mario'],
  'sm64sm64': ['spicy mycena'],
  'smsa2': ['sunshine arcade'],
  'ootbijmqwt': ['water temple'],
  'zagdx': ['gdx'],
  'pkmncrystaldust': ['crystaldust', 'crystal dust'],
  'pkmng': ['gaia'],
  // Mods, modpacks and maps, streamed under their base game
  'bg3tot': ['trials of tav'],
  'easytutu': ['easytutu', 'tutu'],
  'secmod': ['secmod'],
  'ccmo': ['mental omega'],
  'ccr': ['reloaded'],
  'fwbm': ["bob's mods", 'bobs mods', "bob's"],
  'fp': ['platformer'],
  'payday2cd': ['criminal dawn'],
  'maem': ['aem'],
  'mvh': ['vault hunters'],
  'wynncraft': ['wynncraft'],
  'dapotheosis': ['drehmal'],
  'cl': ['citadel'],
  'oc': ['cargolock'],
  'mgsmgs': ['masala'],
  // Versions without a Twitch category of their own, streamed under another one
  'sth2006': ['sonic 06', 'sonic 2006', 'sonic the hedgehog 2006', 'sonic the hedgehog (2006)', 'sth06'],
  'ff1&2dos': ['dawn of souls'],
  'skc': ['knuckles collection', 's&k collection'],
  // Archipelago games without a Twitch category are streamed under Archipelago
  'jigsaw': ['jigsaw']
};

const PER_GAME_ALLOWED_TWITCH_CATEGORIES = {
  'alttpfs': ['The Legend of Zelda: Four Swords Adventures', 'The Legend of Zelda: Four Swords']
};

// Twitch game category names (as they appear on Twitch) - fallback only
const TWITCH_GAME_NAMES = {
  'alttp': 'The Legend of Zelda: A Link to the Past',
  'albw': 'The Legend of Zelda: A Link Between Worlds',
  'botw': 'The Legend of Zelda: Breath of the Wild',
  'ladx': 'The Legend of Zelda: Link\'s Awakening',
  'las': 'The Legend of Zelda: Link\'s Awakening',
  'mm': 'The Legend of Zelda: Majora\'s Mask',
  'ooa': 'The Legend of Zelda: Oracle of Ages',
  'oos': 'The Legend of Zelda: Oracle of Seasons',
  'oot': 'The Legend of Zelda: Ocarina of Time',
  'oot3d': 'The Legend of Zelda: Ocarina of Time 3D',
  'ootmm': 'The Legend of Zelda: Ocarina of Time', // combo
  'ss': 'The Legend of Zelda: Skyward Sword',
  'tmc': 'The Legend of Zelda: The Minish Cap',
  'tp': 'The Legend of Zelda: Twilight Princess',
  'tww': 'The Legend of Zelda: The Wind Waker',
  'twwhd': 'The Legend of Zelda: The Wind Waker HD',
  'z1': 'The Legend of Zelda',
  'z2': 'Zelda II: The Adventure of Link',
  
  'smz3': 'Super Metroid', // combo
  'z1m1': 'The Legend of Zelda', // combo
  'z1m1z3m3': 'The Legend of Zelda', // mega combo
  
  'am2r': 'AM2R',
  'm1': 'Metroid',
  'md': 'Metroid Dread',
  'mf': 'Metroid Fusion',
  'mp': 'Metroid Prime',
  'mp2': 'Metroid Prime 2: Echoes',
  'mp3': 'Metroid Prime 3: Corruption',
  'mpcg': 'Metroid Prime', // combo
  'mpr': 'Metroid Prime Remastered',
  'msr': 'Metroid: Samus Returns',
  'mzm': 'Metroid: Zero Mission',
  'sm': 'Super Metroid',
  
  'aos': 'Castlevania: Aria of Sorrow',
  'c2': 'Castlevania II: Simon\'s Quest',
  'cotm': 'Castlevania: Circle of the Moon',
  'dos': 'Castlevania: Dawn of Sorrow',
  'hod': 'Castlevania: Harmony of Dissonance',
  'hodbt': 'Castlevania: Harmony of Dissonance', // combo
  'ooe': 'Castlevania: Order of Ecclesia',
  'por': 'Castlevania: Portrait of Ruin',
  'sotn': 'Castlevania: Symphony of the Night',
  
  'kh2fm': ['Kingdom Hearts II', 'Kingdom Hearts HD 1.5 + 2.5 ReMIX'],
  'kh3': 'Kingdom Hearts III',
  'khfm': ['Kingdom Hearts', 'Kingdom Hearts HD 1.5 + 2.5 ReMIX'],
  
  'pm': 'Paper Mario',
  'pmttyd': 'Paper Mario: The Thousand-Year Door',
  'sm64': 'Super Mario 64',
  'smb3': 'Super Mario Bros. 3',
  'smr': 'Super Mario RPG',
  'smw': 'Super Mario World',
  'mlss': 'Mario & Luigi: Superstar Saga',
  
  'dk64': 'Donkey Kong 64',
  'dkr': 'Diddy Kong Racing',
  
  'ff': 'Final Fantasy',
  'ff5': 'Final Fantasy V',
  'ff6': 'Final Fantasy VI',
  
  'dw': 'Dragon Warrior',
  'dw2': 'Dragon Warrior II',
  'dw3': 'Dragon Warrior III',
  'dw4': 'Dragon Warrior IV',
  
  'mm2': 'Mega Man 2',
  
  'pkmne': 'Pokémon Emerald',
  'prb': 'Pokémon Red and Blue',
  'up': 'Pokémon Crystal', // randomizer of several games
  
  'alundra': 'Alundra',
  'arzette': 'Arzette: The Jewel of Faramore',
  'bk': 'Banjo-Kazooie',
  'blasphemous': 'Blasphemous',
  'brotn': 'Bloodstained: Ritual of the Night',
  'bt': 'Bomberman Tournament',
  'crystalis': 'Crystalis',
  'ct': 'Chrono Trigger',
  'de': 'Deus Ex',
  'dmw3': 'Digimon World 3',
  'hk': 'Hollow Knight',
  'iog': 'Illusion of Gaia',
  'l2ow': 'Lufia II: Rise of the Sinistrals',
  'landstalker': 'Landstalker',
  'psychonauts': 'Psychonauts',
  'rer': 'Resident Evil',
  'sb': 'Soul Blazer',
  'sekiro': 'Sekiro: Shadows Die Twice',
  'soe': 'Secret of Evermore',
  'som': 'Secret of Mana',
  'tboo': 'The Battle of Olympus',
  'terranigma': 'Terranigma',
  'timespinner': 'Timespinner',
  'tunic': 'TUNIC',
  'wl3': 'Wario Land 3',
  'xc2': 'Xenoblade Chronicles 2',
  'zexion': 'Zexion'
};

// Categories for which we should include all streams in the Twitch category
// (no title/tag 'randomizer' filtering). Lowercase keys.
const PASS_THROUGH_TWITCH_CATEGORIES = new Set(['archipelago']);

// Catch-all Twitch categories where some streamers put their randomizer runs:
// not a game of the site, so only queried for the aggregate list, filtered
// like any category, and shown without a game since the category doesn't tell
const MULTI_GAME_TWITCH_CATEGORY_IDS = [
  '27284' // Retro
];

// Acronymes/diminutifs des randomizers à chercher dans le titre des streams
// Mappé par Twitch game name (ou array de noms) pour vérifier que c'est la bonne catégorie
const RANDOMIZER_ACRONYMS = {
  'The Legend of Zelda: A Link to the Past': ['alttpr', 'lttpr', 'z3r', 'quad randomizer', 'quad crossover randomizer'],
  'The Legend of Zelda: A Link Between Worlds': ['albwr'],
  'The Legend of Zelda: Breath of the Wild': ['botwr'],
  'The Legend of Zelda: Link\'s Awakening': ['ladxr', 'lasr', 'ladx rando'],
  'The Legend of Zelda: Majora\'s Mask': ['mmr', 'mm rando'],
  'The Legend of Zelda: Oracle of Ages': ['ooar', 'ooa rando'],
  'The Legend of Zelda: Oracle of Seasons': ['oosr', 'oos rando'],
  'The Legend of Zelda: Ocarina of Time': ['ootr', 'oot rando'],
  'The Legend of Zelda: Ocarina of Time 3D': ['oot3dr'],
  'The Legend of Zelda: Skyward Sword': ['ssr', 'ss rando', 'sshd rando'],
  'The Legend of Zelda: The Minish Cap': ['tmcr', 'tmc rando'],
  'The Legend of Zelda: Twilight Princess': ['tpr', 'tp rando'],
  'The Legend of Zelda: The Wind Waker': ['twwr', 'tww rando', 'wwr'],
  'The Legend of Zelda: The Wind Waker HD': ['twwhdr'],
  'The Legend of Zelda': ['z1r', 'loz1r', 'tloz1r', 'quad randomizer', 'quad crossover randomizer'],
  'Zelda II: The Adventure of Link': ['z2r', 'aol rando'],
  
  'AM2R': ['am2r rando', 'am2rr'],
  'Metroid': ['m1r', 'nes metroid rando', 'quad randomizer', 'quad crossover randomizer'],
  'Metroid Dread': ['dread rando', 'mdr'],
  'Metroid Fusion': ['mfr', 'fusion rando'],
  'Metroid Prime': ['mpr', 'prime rando', 'mp1r'],
  'Metroid Prime 2: Echoes': ['mp2r', 'echoes rando'],
  'Metroid Prime 3: Corruption': ['mp3r', 'corruption rando'],
  'Metroid Prime Remastered': ['mprr', 'remastered rando'],
  'Metroid: Samus Returns': ['msrr', 'sr rando'],
  'Metroid: Zero Mission': ['mzmr', 'zm rando'],
  'Super Metroid': ['smr', 'sm rando', 'varia', 'quad randomizer', 'quad crossover randomizer'],
  
  'Castlevania: Aria of Sorrow': ['aosr', 'aos rando'],
  'Castlevania II: Simon\'s Quest': ['cv2r', 'simons quest rando'],
  'Castlevania: Circle of the Moon': ['cotmr', 'cotm rando'],
  'Castlevania: Dawn of Sorrow': ['dosr', 'dos rando'],
  'Castlevania: Harmony of Dissonance': ['hodr', 'hod rando'],
  'Castlevania: Order of Ecclesia': ['ooer', 'ooe rando'],
  'Castlevania: Portrait of Ruin': ['porr', 'por rando'],
  'Castlevania: Symphony of the Night': ['sotnr', 'sotn rando'],
  
  'Kingdom Hearts II': ['kh2r', 'kh2 rando', 'kh2fm rando'],
  'Kingdom Hearts HD 1.5 + 2.5 ReMIX': ['kh2r', 'kh2fm rando', 'khfmr'],
  'Kingdom Hearts III': ['kh3r', 'kh3 rando'],
  'Kingdom Hearts': ['khfmr', 'kh1 rando'],
  
  'Paper Mario': ['pm64r', 'pm64 rando'],
  'Paper Mario: The Thousand-Year Door': ['ttydr', 'ttyd rando', 'pmttyd rando'],
  'Super Mario 64': ['sm64r', 'sm64 rando'],
  'Super Mario Bros. 3': ['smb3r', 'smb3 rando'],
  'Super Mario RPG': ['smrpgr', 'smrpg rando'],
  'Super Mario World': ['smwr', 'smw rando'],
  'Mario & Luigi: Superstar Saga': ['mlssr', 'mlss rando'],
  
  'Donkey Kong 64': ['dk64r', 'dk64 rando'],
  'Diddy Kong Racing': ['dkrr', 'dkr rando'],
  
  'Final Fantasy': ['ff1r', 'ffr', 'ff1 rando'],
  'Final Fantasy V': ['ff5r', 'ffvr', 'ffvcd'],
  'Final Fantasy VI': ['ff6r', 'ff6wc', 'worlds collide'],
  
  'Dragon Warrior': ['dwr', 'dw1r'],
  'Dragon Warrior II': ['dw2r'],
  'Dragon Warrior III': ['dw3r'],
  'Dragon Warrior IV': ['dw4r'],
  
  'Mega Man 2': ['mm2r', 'mm2 rando'],
  
  'Pokémon Emerald': ['emerald rando', 'pkmne'],
  'Pokémon Red and Blue': ['pokemon rando', 'pkmnrb'],
  'Pokémon Crystal': ['crystal rando', 'universal pokemon'],
  
  'Alundra': ['alundra rando'],
  'Arzette: The Jewel of Faramore': ['arzette rando'],
  'Banjo-Kazooie': ['bkr', 'bk rando'],
  'Blasphemous': ['blasphe rando'],
  'Bloodstained: Ritual of the Night': ['rotn rando', 'bsrotn'],
  'Bomberman Tournament': ['bmtr'],
  'Chrono Trigger': ['jets of time', 'ctjot'],
  'Crystalis': ['crystalis rando'],
  'Deus Ex': ['dxr', 'deus ex rando'],
  'Digimon World 3': ['dmw3r', 'dw3 rando'],
  'Hollow Knight': ['hkr', 'hk rando', 'hollow knight rando'],
  'Illusion of Gaia': ['iogr', 'iog rando'],
  'Landstalker': ['landstalker rando'],
  'Lufia II: Rise of the Sinistrals': ['lufia rando', 'l2ow'],
  'Psychonauts': ['psy rando'],
  'Resident Evil': ['re rando', 'resident evil rando'],
  'Sekiro: Shadows Die Twice': ['sekiro rando'],
  'Secret of Evermore': ['evermizer', 'soe rando'],
  'Secret of Mana': ['somr', 'som rando'],
  'Soul Blazer': ['soul blazer rando'],
  'Terranigma': ['terranigma rando', 'terrafluky'],
  'The Battle of Olympus': ['tboo rando'],
  'Timespinner': ['timespinner rando'],
  'TUNIC': ['tunic rando'],
  'Wario Land 3': ['wl3r', 'wl3 rando'],
  'Xenoblade Chronicles 2': ['xc2r', 'xc2 rando']
};


// Cache for Twitch game IDs
const gameIdCache = {};
const gameIdNotFound = new Map(); // name -> expiry, unknown to the one-name lookup
const GAME_ID_NOT_FOUND_TTL = 30 * 60 * 1000;
const twitchStreamsInFlight = new Map();

function twitchHeaders(token) {
  return {
    'Client-ID': TWITCH_CLIENT_ID,
    'Authorization': `Bearer ${token}`
  };
}

// Twitch allows a bucket of requests (800) refilled over a minute and answers
// 429 beyond; refusals used to be treated as "no streams" and cached for 5
// minutes. Requests now follow the remaining quota Twitch reports: once it
// runs low they are spaced at the refill rate instead of being refused.
const twitchBucket = { tokens: null, limit: 800, updatedAt: 0 };
const TWITCH_MAX_RETRIES = 3;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function takeTwitchRequestSlot() {
  for (;;) {
    if (twitchBucket.tokens === null) return; // quota unknown until the first answer
    const now = Date.now();
    const refilled = (now - twitchBucket.updatedAt) * twitchBucket.limit / 60000;
    const tokens = Math.min(twitchBucket.limit, twitchBucket.tokens + refilled);
    if (tokens >= 1) {
      twitchBucket.tokens = tokens - 1;
      twitchBucket.updatedAt = now;
      return;
    }
    await sleep(Math.ceil((1 - tokens) * 60000 / twitchBucket.limit));
  }
}

function recordTwitchQuota(response) {
  const remaining = Number(response.headers.get('ratelimit-remaining'));
  const limit = Number(response.headers.get('ratelimit-limit'));
  if (Number.isFinite(limit) && limit > 0) twitchBucket.limit = limit;
  if (!Number.isFinite(remaining)) return;
  const now = Date.now();
  const local = twitchBucket.tokens === null
    ? Infinity
    : twitchBucket.tokens + (now - twitchBucket.updatedAt) * twitchBucket.limit / 60000;
  // Keep the more cautious of our estimate and Twitch's figure
  twitchBucket.tokens = Math.min(local, remaining);
  twitchBucket.updatedAt = now;
}

async function twitchFetch(url, token) {
  let response;
  for (let attempt = 0; attempt <= TWITCH_MAX_RETRIES; attempt++) {
    await takeTwitchRequestSlot();
    response = await fetch(url, { headers: twitchHeaders(token) });
    recordTwitchQuota(response);
    if (response.status !== 429 || attempt === TWITCH_MAX_RETRIES) return response;
    twitchBucket.tokens = 0;
    twitchBucket.updatedAt = Date.now();
  }
  return response;
}

// Resolve many Twitch category names at once (100 per request) into gameIdCache,
// instead of one /helix/games request per name
async function prefetchTwitchGameIds(names, token) {
  const pending = Array.from(new Set(names.map(n => String(n || '').trim()).filter(Boolean)))
    .filter(name => !gameIdCache[name] && !((gameIdNotFound.get(name) || 0) > Date.now()));

  for (let start = 0; start < pending.length; start += 100) {
    const chunk = pending.slice(start, start + 100);
    try {
      const params = chunk.map(name => `name=${encodeURIComponent(name)}`).join('&');
      const response = await twitchFetch(`https://api.twitch.tv/helix/games?${params}`, token);
      if (!response.ok) continue; // leave these to the one-by-one lookup
      const data = await response.json();
      const idByName = new Map((data.data || []).map(game => [String(game.name || '').toLowerCase(), game.id]));
      for (const name of chunk) {
        const id = idByName.get(name.toLowerCase());
        // Names Twitch answers under another title (aliases) are left to the
        // one-name lookup, which resolves them
        if (id) gameIdCache[name] = id;
      }
    } catch (error) {
      console.warn('Batched Twitch game lookup failed:', error?.message || error);
    }
  }
}

// Raw Twitch streams of one category (null when Twitch refuses). The same
// category is often asked twice in a row (by id, then by name resolving to
// that id): the identical request is shared for a minute.
const RAW_CATEGORY_STREAMS_TTL = 60 * 1000;
const rawCategoryStreams = new Map(); // categoryId -> { expiresAt, promise }

function fetchCategoryRawStreams(categoryId, token) {
  const key = String(categoryId);
  const entry = rawCategoryStreams.get(key);
  if (entry && entry.expiresAt > Date.now()) return entry.promise;

  const promise = (async () => {
    const response = await twitchFetch(`https://api.twitch.tv/helix/streams?game_id=${encodeURIComponent(key)}&first=100`, token);
    if (!response.ok) return null;
    const data = await response.json();
    return data.data || [];
  })();
  rawCategoryStreams.set(key, { expiresAt: Date.now() + RAW_CATEGORY_STREAMS_TTL, promise });
  // A refusal or error is not kept: the next caller asks Twitch again
  promise.then(result => {
    if (result === null) rawCategoryStreams.delete(key);
  }, () => rawCategoryStreams.delete(key));
  if (rawCategoryStreams.size > 2000) {
    const now = Date.now();
    for (const [k, v] of rawCategoryStreams) if (v.expiresAt <= now) rawCategoryStreams.delete(k);
  }
  return promise;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Number(concurrency) || 1);
  const results = new Array(list.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < list.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(list[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(limit, list.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function getTwitchGameId(gameName, token) {
  if (gameIdCache[gameName]) {
    return gameIdCache[gameName];
  }
  // Recently looked up and unknown to Twitch
  if ((gameIdNotFound.get(gameName) || 0) > Date.now()) {
    return null;
  }

  try {
    const response = await twitchFetch(`https://api.twitch.tv/helix/games?name=${encodeURIComponent(gameName)}`, token);

    if (response.ok) {
      const data = await response.json();
      if (data.data && data.data.length > 0) {
        gameIdCache[gameName] = data.data[0].id;
        return data.data[0].id;
      }
      // Twitch answered that this name does not exist: don't ask again for a while
      gameIdNotFound.set(gameName, Date.now() + GAME_ID_NOT_FOUND_TTL);
    }
  } catch (error) {
    console.error(`Error fetching Twitch game ID for ${gameName}:`, error);
  }
  
  return null;
}

async function fetchTwitchStreamsByCategoryId(categoryId, gameNameForFilter, includeAll = false) {
  const normalizedCategoryId = String(categoryId || '').trim();
  if (!normalizedCategoryId) {
    return [];
  }

  const cacheKey = `twitch-streams:category-id:${normalizedCategoryId}:${includeAll ? 'all' : 'filtered'}`;
  const cachedStreams = getCached(cacheKey);
  if (cachedStreams) {
    return cachedStreams;
  }

  const inflight = twitchStreamsInFlight.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const requestPromise = (async () => {
    const token = await getTwitchToken();
    if (!token) {
      return [];
    }

    const streams = [];

    try {
      const rawStreams = await fetchCategoryRawStreams(normalizedCategoryId, token);

      if (rawStreams) {
        let candidateStreams = rawStreams;

        if (!includeAll) {
          candidateStreams = candidateStreams.filter(stream => isRandomizerStream(stream, gameNameForFilter || stream.game_name));
        }

        streams.push(...candidateStreams.map(stream => ({
          platform: 'twitch',
          id: stream.id,
          userName: stream.user_name,
          userLogin: stream.user_login,
          title: stream.title,
          viewerCount: stream.viewer_count,
          thumbnailUrl: stream.thumbnail_url?.replace('{width}', '320').replace('{height}', '180'),
          gameName: stream.game_name,
          tags: stream.tags || [],
          url: `https://twitch.tv/${stream.user_login}`,
          startedAt: stream.started_at
        })));
      }
    } catch (error) {
      console.error('Error fetching Twitch streams by category ID:', error);
    }

    setCache(cacheKey, streams);
    return streams;
  })();

  twitchStreamsInFlight.set(cacheKey, requestPromise);
  try {
    return await requestPromise;
  } finally {
    twitchStreamsInFlight.delete(cacheKey);
  }
}

// Whether a stream's title or tags contain one of the keywords at the start
// of a word ("abc" must not match "xabc")
function streamMentions(stream, keywords) {
  const title = (stream.title || '').toLowerCase();
  const tags = (stream.tags || []).map(t => (t || '').toLowerCase()).join(' ');
  const combined = title + ' ' + tags;
  return keywords.some(keyword => {
    const escaped = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}`).test(combined);
  });
}

// A category shared by a game and its mods or duplicates: a stream naming a mod
// goes to it, any other to the first game that needs no keyword
function gameOfSharedCategory(stream, refs) {
  const named = refs.find(r => PER_GAME_TITLE_KEYWORDS[r.gameId] && streamMentions(stream, PER_GAME_TITLE_KEYWORDS[r.gameId]));
  return (named || refs.find(r => !PER_GAME_TITLE_KEYWORDS[r.gameId]) || refs[0]).gameId;
}

// Filter streams for combo games by checking if title/tags contain combo-specific keywords
function filterComboStreams(streams, gameId) {
  const keywords = COMBO_KEYWORDS[gameId.toLowerCase()];
  if (!keywords || keywords.length === 0) {
    return streams; // No filtering for non-combo games
  }

  return streams.filter(stream => streamMentions(stream, keywords));
}

const RANDO_WORD = /(^|[^a-z0-9])(randos?|randomi[sz]ed)([^a-z0-9]|$)/;

// Check if a stream is a randomizer stream based on title, tags, and game-specific acronyms
function isRandomizerStream(stream, gameName) {
  const title = (stream.title || '').toLowerCase();
  const tags = (stream.tags || []).map(t => t.toLowerCase());

  // Extra global rule: accept streams with explicit multiworld/archipelago mention in title or tags.
  // The game category constraint is already enforced upstream via Twitch game_id filtering
  // (the Twitch "Multiworld" category itself is an unrelated game and is never queried).
  if (title.includes('multiworld') || title.includes('archipelago')) {
    return true;
  }
  if (tags.some(t => t.includes('multiworld') || t.includes('archipelago'))) {
    return true;
  }
  
  // Check generic randomizer/rando mentions. "randomizer" is specific enough inside
  // another word (title "<Game>Randomizer", tag "<Series>Randomizer"); "rando" and "randomized"
  // must be whole words, or "random", "Randolocke" and Spanish "explorando" match
  if ([title, ...tags].some(text => /randomi[sz]er/.test(text) || RANDO_WORD.test(text))) {
    return true;
  }
  
  // Check game-specific acronyms in title
  const acronyms = RANDOMIZER_ACRONYMS[gameName];
  if (acronyms && acronyms.length > 0) {
    // Check if any acronym appears in the title
    // Use word boundary matching to avoid false positives (e.g., "ABC" not matching "XABC")
    for (const acronym of acronyms) {
      const acroLower = acronym.toLowerCase();
      // For short acronyms, use word boundary check
      // For longer phrases, use simple includes
      if (acroLower.includes(' ')) {
        // Multi-word phrase - simple includes
        if (title.includes(acroLower)) {
          return true;
        }
      } else {
        // Single word/acronym - check with word boundaries
        // Match if surrounded by non-alphanumeric or at start/end
        const regex = new RegExp(`(?:^|[^a-z0-9])${acroLower}(?:[^a-z0-9]|$)`, 'i');
        if (regex.test(title)) {
          return true;
        }
      }
    }
  }
  
  return false;
}

async function fetchTwitchStreams(gameName, includeAll = false) {
  const normalizedGameName = String(gameName || '').trim();
  if (!normalizedGameName) {
    return [];
  }

  const cacheKey = `twitch-streams:${normalizedGameName.toLowerCase()}:${includeAll ? 'all' : 'filtered'}`;
  const cachedStreams = getCached(cacheKey);
  if (cachedStreams) {
    return cachedStreams;
  }

  const inflight = twitchStreamsInFlight.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const requestPromise = (async () => {
  const token = await getTwitchToken();
  if (!token) {
    return [];
  }

  const streams = [];
  
  try {
    // Get the Twitch game ID for the game category
    const gameId = await getTwitchGameId(normalizedGameName, token);
    
    if (gameId) {
      const rawStreams = await fetchCategoryRawStreams(gameId, token);

      if (rawStreams) {
        let candidateStreams = rawStreams;

        // By default, only include streams that mention randomizer/rando in title or tags,
        // OR that use game-specific acronyms.
        // For some Twitch categories (e.g., Archipelago) we want to include all streams
        // regardless of title/tags because the category itself implies randomizer content.
        if (!includeAll) {
          candidateStreams = candidateStreams.filter(stream => isRandomizerStream(stream, normalizedGameName));
        }

        streams.push(...candidateStreams.map(stream => ({
          platform: 'twitch',
          id: stream.id,
          userName: stream.user_name,
          userLogin: stream.user_login,
          title: stream.title,
          viewerCount: stream.viewer_count,
          thumbnailUrl: stream.thumbnail_url?.replace('{width}', '320').replace('{height}', '180'),
          gameName: stream.game_name,
          tags: stream.tags || [],
          url: `https://twitch.tv/${stream.user_login}`,
          startedAt: stream.started_at
        })));
      }
    }
  } catch (error) {
    console.error('Error fetching Twitch streams:', error);
  }

  setCache(cacheKey, streams);
  return streams;
  })();

  twitchStreamsInFlight.set(cacheKey, requestPromise);
  try {
    return await requestPromise;
  } finally {
    twitchStreamsInFlight.delete(cacheKey);
  }
}

// ============================================================================
// Racetime.gg real-time augmentation
//
// Complementary source (never replaces the Twitch-category detection above):
// races currently in progress on racetime.gg expose their entrants, each of
// which can be flagged "stream_live" with a linked Twitch channel. We use this
// to catch streamers whose Twitch title/tags don't mention the randomizer
// (mistagged streams), by confirming with the Twitch API that they're
// actually live. If anything here fails, we simply return no extra streams.
// ============================================================================

const RACETIME_HOST_URL = 'https://racetime.gg';
const RACETIME_LIVE_CACHE_TTL = 90 * 1000; // races/entrants change fast

function getRacetimeSlugsForGame(gameDoc) {
  const slugs = new Set();
  const rt = gameDoc?.integrations?.racetime;
  if (rt?.gameSlug) slugs.add(String(rt.gameSlug).toLowerCase().trim());
  if (Array.isArray(rt?.gameSlugs)) {
    rt.gameSlugs.forEach(slug => {
      if (slug) slugs.add(String(slug).toLowerCase().trim());
    });
  }
  return Array.from(slugs).filter(Boolean);
}

function extractTwitchLoginFromChannelUrl(channelUrl) {
  try {
    const parsed = new URL(String(channelUrl || ''));
    if (!/(^|\.)twitch\.tv$/i.test(parsed.hostname)) return null;
    const login = parsed.pathname.split('/').filter(Boolean)[0];
    return login ? login.toLowerCase() : null;
  } catch (e) {
    return null;
  }
}

// Fetch the list of currently in-progress races for a racetime category slug
async function fetchRacetimeInProgressRaces(slug) {
  const cacheKey = `racetime-live:category:${slug}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  let races = [];
  try {
    const response = await fetch(`${RACETIME_HOST_URL}/${encodeURIComponent(slug)}/data`, {
      headers: { Accept: 'application/json' }
    });
    if (response.ok) {
      const data = await response.json();
      races = Array.isArray(data.current_races)
        ? data.current_races.filter(r => r?.status?.value === 'in_progress' && r?.data_url)
        : [];
    }
  } catch (error) {
    console.warn(`Racetime live fetch failed for category ${slug}:`, error?.message || error);
  }

  setCache(cacheKey, races, RACETIME_LIVE_CACHE_TTL);
  return races;
}

// Entrants of a race: those live-streaming (with a Twitch channel), and the
// names every entrant goes by, to recognize the race in a restream's title
async function fetchRacetimeLiveEntrants(dataUrl) {
  const cacheKey = `racetime-live:race:${dataUrl}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  let result = { liveEntrants: [], players: [] };
  try {
    const response = await fetch(`${RACETIME_HOST_URL}${dataUrl}`, {
      headers: { Accept: 'application/json' }
    });
    if (response.ok) {
      const data = await response.json();
      const entrants = Array.isArray(data.entrants) ? data.entrants : [];
      const raceUrl = data.url ? `${RACETIME_HOST_URL}${data.url}` : null;
      const raceGoal = data.goal?.name || null;
      result.liveEntrants = entrants
        .filter(e => e?.stream_live && e?.user?.twitch_channel)
        .map(e => {
          const login = (e.user.twitch_name || extractTwitchLoginFromChannelUrl(e.user.twitch_channel) || '').toLowerCase();
          if (!login) return null;
          return { twitchLogin: login, raceUrl, raceGoal };
        })
        .filter(Boolean);
      result.players = entrants
        .filter(e => e?.user)
        .map(e => ({
          names: [e.user.name, e.user.twitch_name, extractTwitchLoginFromChannelUrl(e.user.twitch_channel)].filter(Boolean),
          twitchLogin: (e.user.twitch_name || extractTwitchLoginFromChannelUrl(e.user.twitch_channel) || '').toLowerCase()
        }));
      result.raceUrl = raceUrl;
      result.raceGoal = raceGoal;
    }
  } catch (error) {
    console.warn(`Racetime live entrants fetch failed for ${dataUrl}:`, error?.message || error);
  }

  setCache(cacheKey, result, RACETIME_LIVE_CACHE_TTL);
  return result;
}

// Confirm live status/viewer count directly with Twitch for a batch of logins (no title/tag filtering)
async function fetchTwitchStreamsByLogins(logins) {
  const uniqueLogins = Array.from(new Set((logins || []).map(l => String(l || '').toLowerCase()).filter(Boolean))).slice(0, 100);
  if (!uniqueLogins.length) return [];

  const token = await getTwitchToken();
  if (!token) return [];

  try {
    const params = uniqueLogins.map(login => `user_login=${encodeURIComponent(login)}`).join('&');
    const response = await twitchFetch(`https://api.twitch.tv/helix/streams?${params}&first=100`, token);

    if (!response.ok) return [];

    const data = await response.json();
    return (data.data || []).map(stream => ({
      platform: 'twitch',
      id: stream.id,
      userName: stream.user_name,
      userLogin: stream.user_login,
      title: stream.title,
      viewerCount: stream.viewer_count,
      thumbnailUrl: stream.thumbnail_url?.replace('{width}', '320').replace('{height}', '180'),
      gameName: stream.game_name,
      tags: stream.tags || [],
      url: `https://twitch.tv/${stream.user_login}`,
      startedAt: stream.started_at,
      twitchCategoryId: stream.game_id
    }));
  } catch (error) {
    console.warn('Error confirming racetime-detected streams with Twitch:', error?.message || error);
    return [];
  }
}

// Restreams of racetime.gg races in progress: broadcasts of the races' Twitch
// categories, on another channel than a player's, whose title names the race's
// players (a tournament restream's title rarely says "rando").
async function findRestreamsOfRaces(races, categoryIds) {
  if (!races.length || !categoryIds.length) return [];
  const token = await getTwitchToken();
  if (!token) return [];

  const playerLogins = new Set(races.flatMap(race => race.players.map(p => p.twitchLogin)).filter(Boolean));
  const rawLists = await Promise.all(categoryIds.map(id => fetchCategoryRawStreams(id, token).catch(() => null)));
  const restreams = [];
  for (const stream of rawLists.flatMap(list => list || [])) {
    const login = String(stream.user_login || '').toLowerCase();
    if (!login || playerLogins.has(login)) continue;
    const race = races.find(r => titleNamesRace(stream.title, r.players.map(p => p.names)));
    if (!race) continue;
    restreams.push({
      platform: 'twitch',
      id: stream.id,
      userName: stream.user_name,
      userLogin: login,
      title: stream.title,
      viewerCount: stream.viewer_count,
      thumbnailUrl: stream.thumbnail_url?.replace('{width}', '320').replace('{height}', '180'),
      gameName: stream.game_name,
      tags: stream.tags || [],
      url: `https://twitch.tv/${stream.user_login}`,
      startedAt: stream.started_at,
      source: 'racetime-restream',
      raceUrl: race.raceUrl || null,
      raceGoal: race.raceGoal || null
    });
  }
  return restreams;
}

// Build extra stream entries for a game by cross-referencing racetime.gg live races with Twitch.
// Purely additive: returns [] on any error or when the game has no racetime slug configured.
async function fetchRacetimeLiveStreamsForGame(gameDoc, gameIdLower) {
  try {
    const slugs = getRacetimeSlugsForGame(gameDoc);
    if (!slugs.length) return [];

    const goalFilters = gameGoalFilters(gameDoc.integrations.racetime);
    const candidates = [];
    const racesWithPlayers = [];
    for (const slug of slugs) {
      const races = (await fetchRacetimeInProgressRaces(slug))
        .filter(race => isGoalAllowed(goalFilters, slug, race.goal));
      const raceEntrants = await mapWithConcurrency(races, 4, race => fetchRacetimeLiveEntrants(race.data_url));
      for (const race of raceEntrants) {
        candidates.push(...race.liveEntrants);
        if (race.players.length >= 2) racesWithPlayers.push(race);
      }
    }
    if (!candidates.length) return [];

    const raceInfoByLogin = new Map();
    for (const candidate of candidates) {
      if (!raceInfoByLogin.has(candidate.twitchLogin)) {
        raceInfoByLogin.set(candidate.twitchLogin, candidate);
      }
    }

    const confirmedStreams = await fetchTwitchStreamsByLogins(Array.from(raceInfoByLogin.keys()));

    const streams = confirmedStreams.map(({ twitchCategoryId, ...stream }) => {
      const info = raceInfoByLogin.get(String(stream.userLogin || '').toLowerCase());
      return {
        ...stream,
        gameId: gameIdLower,
        source: 'racetime-live',
        raceUrl: info?.raceUrl || null,
        raceGoal: info?.raceGoal || null
      };
    });

    const categoryIds = Array.from(new Set(confirmedStreams.map(s => s.twitchCategoryId).filter(Boolean)));
    const restreams = await findRestreamsOfRaces(racesWithPlayers, categoryIds);
    const knownLogins = new Set(streams.map(s => String(s.userLogin || '').toLowerCase()));
    for (const restream of restreams) {
      if (knownLogins.has(restream.userLogin)) continue;
      knownLogins.add(restream.userLogin);
      streams.push({ ...restream, gameId: gameIdLower });
    }
    return streams;
  } catch (error) {
    console.warn(`Racetime live augmentation failed for ${gameIdLower}:`, error?.message || error);
    return [];
  }
}

// preloadedDoc: the game document when the caller already has it (same
// lookup as below: enabled game whose id is exactly gameIdLower), or null
async function buildGameStreamsResult(gameId, preloadedDoc) {
  const gameIdLower = String(gameId || '').toLowerCase();
  const cacheKey = `streams:${gameIdLower}`;

  const cached = getCached(cacheKey);
  if (cached) {
    return cached;
  }

  const gameDoc = preloadedDoc !== undefined
    ? preloadedDoc
    : await Game.findOne({ id: gameIdLower, enabled: { $ne: false } });
  if (!gameDoc) {
    return {
      gameId,
      streams: [],
      total: 0,
      message: 'Game not supported yet',
      fetchedAt: new Date().toISOString()
    };
  }

  const comboCategoryIds = COMBO_TWITCH_CATEGORY_IDS[gameIdLower];
  let twitchStreamsAll = [];

  if (comboCategoryIds) {
    const results = await Promise.all(comboCategoryIds.map(id => fetchTwitchStreamsByCategoryId(id, null)));
    const streamMap = new Map();
    for (const stream of results.flat()) {
      if (!streamMap.has(stream.id)) streamMap.set(stream.id, stream);
    }
    twitchStreamsAll = filterComboStreams(Array.from(streamMap.values()), gameIdLower);
  } else {
    const twitchCategoryId = gameDoc.integrations?.twitch?.categoryId;
    const twitchNameFromDb = gameDoc.integrations?.twitch?.categoryName;
    const fallbackName = TWITCH_GAME_NAMES[gameIdLower] || gameDoc.official?.name || gameDoc.name;
    const twitchGameName = twitchNameFromDb || fallbackName;

    const includeAllForDocCategory = PASS_THROUGH_TWITCH_CATEGORIES.has(String(twitchNameFromDb || '').toLowerCase());

    if (twitchCategoryId) {
      twitchStreamsAll = await fetchTwitchStreamsByCategoryId(twitchCategoryId, twitchGameName, includeAllForDocCategory);
    }

    if (twitchStreamsAll.length === 0 && !twitchGameName) {
      return {
        gameId,
        streams: [],
        total: 0,
        message: 'Game not supported yet',
        fetchedAt: new Date().toISOString()
      };
    }

    let twitchStreams = [];

    if (twitchStreamsAll.length === 0 && Array.isArray(twitchGameName)) {
      const results = await Promise.all(twitchGameName.map(name => fetchTwitchStreams(name, PASS_THROUGH_TWITCH_CATEGORIES.has(String(name).toLowerCase()))));
      const streamMap = new Map();
      for (const streams of results) {
        for (const stream of streams) {
          if (!streamMap.has(stream.id)) {
            streamMap.set(stream.id, stream);
          }
        }
      }
      twitchStreams = Array.from(streamMap.values());
    } else if (twitchStreamsAll.length === 0) {
      twitchStreams = await fetchTwitchStreams(twitchGameName, PASS_THROUGH_TWITCH_CATEGORIES.has(String(twitchGameName).toLowerCase()));
    }

    if (twitchStreamsAll.length === 0) {
      twitchStreamsAll = twitchStreams;
    }
  }

  try {
    const titleKeywords = PER_GAME_TITLE_KEYWORDS[gameIdLower];
    if (titleKeywords && titleKeywords.length > 0) {
      twitchStreamsAll = twitchStreamsAll.filter(s => streamMentions(s, titleKeywords));
    }

    const allowedCats = PER_GAME_ALLOWED_TWITCH_CATEGORIES[gameIdLower];
    if (allowedCats && allowedCats.length > 0) {
      const allowed = allowedCats.map(a => a.toLowerCase());
      twitchStreamsAll = twitchStreamsAll.filter(s => allowed.includes((s.gameName || '').toLowerCase()));
    }
  } catch (e) {
    console.warn('Per-game stream filtering failed for', gameIdLower, e);
  }

  // Show the site's name rather than the Twitch styling (all capitals), except where the
  // category tells which game is played: combos and multi-game categories (Archipelago)
  const siteGameName = gameLabel(gameDoc);
  let allStreams = twitchStreamsAll
    .map(stream => ({
      ...stream,
      ...(siteGameName && !comboCategoryIds && !PASS_THROUGH_TWITCH_CATEGORIES.has(String(stream.gameName || '').toLowerCase())
        ? { gameName: siteGameName }
        : {}),
      gameId: gameIdLower
    }));

  // Additive augmentation: cross-reference racetime.gg live races to catch
  // streams that Twitch's category/title/tag detection missed (mistagged streams).
  // Never removes or alters anything found by the original method above.
  try {
    const knownIds = new Set(allStreams.map(s => s.id));
    const racetimeStreams = await fetchRacetimeLiveStreamsForGame(gameDoc, gameIdLower);
    for (const stream of racetimeStreams) {
      if (!knownIds.has(stream.id)) {
        knownIds.add(stream.id);
        allStreams.push(stream);
      }
    }
  } catch (e) {
    console.warn('Racetime live augmentation skipped for', gameIdLower, e?.message || e);
  }

  allStreams = allStreams.sort((a, b) => (b.viewerCount || 0) - (a.viewerCount || 0));

  const result = {
    gameId,
    streams: allStreams,
    total: allStreams.length,
    fetchedAt: new Date().toISOString()
  };

  setCache(cacheKey, result);
  return result;
}

// Twitch category names a game's stream lookup may use (see buildGameStreamsResult)
function twitchNamesForGame(gameDoc) {
  const gameIdLower = String(gameDoc.id || '').toLowerCase();
  if (COMBO_TWITCH_CATEGORY_IDS[gameIdLower]) return [];
  const name = gameDoc.integrations?.twitch?.categoryName
    || TWITCH_GAME_NAMES[gameIdLower] || gameDoc.official?.name || gameDoc.name;
  return Array.isArray(name) ? name : [name];
}

// Resolve every game's Twitch category names in a few batched requests
// instead of one per game (which, with the stream requests, exceeded
// Twitch's rate limit). Stream lists stay one request per category: a
// multi-category request cannot tell whether it returned every stream.
async function prefetchTwitchForGames(gameDocs) {
  const token = await getTwitchToken();
  if (!token) return;
  try {
    const names = gameDocs.flatMap(twitchNamesForGame).filter(n => typeof n === 'string');
    await prefetchTwitchGameIds(names, token);
  } catch (error) {
    // The per-game lookups below still work without the prefetch
    console.warn('Twitch prefetch failed:', error?.message || error);
  }
}

async function buildStreamsStatsByGame() {
  const gameDocs = await Game.find({ enabled: { $ne: false } });
  const gameIds = gameDocs
    .map(game => String(game.id || '').toLowerCase())
    .filter(Boolean);
  // Same document buildGameStreamsResult would find: id stored exactly in lowercase
  const docById = new Map();
  for (const doc of gameDocs) {
    if (doc.id && doc.id === doc.id.toLowerCase() && !docById.has(doc.id)) docById.set(doc.id, doc);
  }

  await prefetchTwitchForGames(Array.from(docById.values()));

  const stats = {};
  const concurrency = Math.min(8, gameIds.length);
  let index = 0;

  async function worker() {
    while (index < gameIds.length) {
      const currentIndex = index;
      index += 1;
      const gameId = gameIds[currentIndex];

      try {
        const result = await buildGameStreamsResult(gameId, docById.get(gameId) || null);
        const streams = result?.streams || [];
        stats[gameId] = {
          streamers: streams.length,
          viewers: streams.reduce((sum, stream) => sum + (stream.viewerCount || 0), 0)
        };
      } catch (error) {
        stats[gameId] = { streamers: 0, viewers: 0 };
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency || 1 }, () => worker()));

  return {
    stats,
    totalGames: gameIds.length,
    fetchedAt: new Date().toISOString()
  };
}

// Building these stats queries Twitch for every game and can take tens of
// seconds: an expired result keeps being served (up to STATS_MAX_STALE)
// while a single background refresh runs.
const STATS_BY_GAME_KEY = 'streams:stats-by-game';
const STATS_MAX_STALE = 30 * 60 * 1000;
let statsByGameInFlight = null;

function refreshStreamsStatsByGame() {
  if (!statsByGameInFlight) {
    statsByGameInFlight = buildStreamsStatsByGame()
      .then(result => {
        setCache(STATS_BY_GAME_KEY, result);
        return result;
      })
      .finally(() => {
        statsByGameInFlight = null;
      });
  }
  return statsByGameInFlight;
}

// Warmed once MongoDB is connected
whenConnected(() => setTimeout(() => {
  refreshStreamsStatsByGame().catch(err => {
    console.warn('Warmup /api/streams/stats/by-game failed:', err?.message || err);
  });
}, 2500));

router.get('/stats/by-game', async (req, res, next) => {
  try {
    const cached = getCached(STATS_BY_GAME_KEY);
    if (cached) {
      return res.json(cached);
    }

    const stale = cache.data[STATS_BY_GAME_KEY];
    if (stale && cache.expires[STATS_BY_GAME_KEY] + STATS_MAX_STALE > Date.now()) {
      refreshStreamsStatsByGame().catch(err => {
        console.warn('Refresh /api/streams/stats/by-game failed:', err?.message || err);
      });
      return res.json(stale);
    }

    res.json(await refreshStreamsStatsByGame());
  } catch (error) {
    next(error);
  }
});

// Get live streams for a game
router.get('/:gameId', async (req, res, next) => {
  try {
    const { gameId } = req.params;
    const result = await buildGameStreamsResult(gameId);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// Twitch avatars: login -> { avatarUrl, expires }, bounded (logins come from visitors)
const TWITCH_LOGIN_PATTERN = /^[a-z0-9_]{1,25}$/;
const TWITCH_AVATAR_TTL = 6 * 60 * 60 * 1000;
const TWITCH_AVATAR_CACHE_MAX = 2000;
const TWITCH_AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const twitchAvatarUrls = new Map();

function rememberTwitchAvatar(login, avatarUrl) {
  if (!twitchAvatarUrls.has(login) && twitchAvatarUrls.size >= TWITCH_AVATAR_CACHE_MAX) {
    twitchAvatarUrls.delete(twitchAvatarUrls.keys().next().value);
  }
  twitchAvatarUrls.set(login, { avatarUrl, expires: Date.now() + TWITCH_AVATAR_TTL });
}

// Profile pictures are served by Twitch's CDN only
function isTwitchCdnUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'static-cdn.jtvnw.net';
  } catch (e) {
    return false;
  }
}

// Get Twitch user avatar by username (streams the image directly)
router.get('/twitch-avatar/:username', async (req, res) => {
  try {
    const login = String(req.params.username || '').toLowerCase();
    if (!TWITCH_LOGIN_PATTERN.test(login)) {
      return res.status(400).json({ error: 'Invalid Twitch login' });
    }

    const cached = twitchAvatarUrls.get(login);
    let avatarUrl = cached && cached.expires > Date.now() ? cached.avatarUrl : undefined;

    if (avatarUrl === undefined) {
      const token = await getTwitchToken();
      if (!token) {
        return res.status(503).json({ error: 'Twitch API not configured' });
      }

      const response = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, {
        headers: {
          'Client-ID': TWITCH_CLIENT_ID,
          'Authorization': `Bearer ${token}`
        },
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) return res.status(204).end();

      const data = await response.json();
      const url = data?.data?.[0]?.profile_image_url;
      avatarUrl = isTwitchCdnUrl(url) ? url : null;
      rememberTwitchAvatar(login, avatarUrl);
    }

    if (!avatarUrl) return res.status(204).end();

    const imgResponse = await fetch(avatarUrl, { redirect: 'error', signal: AbortSignal.timeout(8000) });
    const contentType = (imgResponse.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const declaredLength = Number(imgResponse.headers.get('content-length'));
    if (!imgResponse.ok || !isSafeImageContentType(contentType)
      || (Number.isFinite(declaredLength) && declaredLength > TWITCH_AVATAR_MAX_BYTES)) {
      return res.status(204).end();
    }
    const buffer = Buffer.from(await imgResponse.arrayBuffer());
    if (buffer.length > TWITCH_AVATAR_MAX_BYTES) return res.status(204).end();

    setRelayedImageHeaders(res);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(buffer);
  } catch (error) {
    console.error('Error fetching Twitch avatar:', error.message);
    return res.status(204).end();
  }
});

// Get all randomizer streams (not game-specific)
// Every live randomizer stream: Twitch categories of all the games plus racetime live entrants
async function buildAllStreams() {
  const token = await getTwitchToken();
  if (!token) {
    return { streams: [], total: 0, message: 'Twitch API not configured' };
  }

  // Build reverse map: Twitch game name -> gameIds (from DB only)
  const fallbackTwitchGameToGameIds = new Map();
  const twitchCategoryIdToGameRefs = new Map();
  const comboGameIds = [];
  const games = await Game.find({ enabled: { $ne: false } });
  for (const game of games) {
    const gameId = (game.id || '').toLowerCase();
    // Combo games share their source games' categories: kept by their keywords, as on their page
    if (COMBO_TWITCH_CATEGORY_IDS[gameId]) {
      comboGameIds.push(gameId);
      continue;
    }
    const twitchCategoryId = game.integrations?.twitch?.categoryId;
    const twitchNameFromDb = game.integrations?.twitch?.categoryName;
    const fallbackName = TWITCH_GAME_NAMES[gameId] || game.official?.name || game.name;
    const twitchGameName = twitchNameFromDb || fallbackName;

    if (twitchCategoryId) {
      if (!twitchCategoryIdToGameRefs.has(twitchCategoryId)) {
        twitchCategoryIdToGameRefs.set(twitchCategoryId, []);
      }
      twitchCategoryIdToGameRefs.get(twitchCategoryId).push({
        gameId,
        categoryName: twitchNameFromDb || ''
      });
    } else {
      if (!twitchGameName) continue;
      const names = Array.isArray(twitchGameName) ? twitchGameName : [twitchGameName];
      for (const name of names) {
        if (!fallbackTwitchGameToGameIds.has(name)) {
          fallbackTwitchGameToGameIds.set(name, []);
        }
        fallbackTwitchGameToGameIds.get(name).push(gameId);
      }
    }
  }

  // Get all streams from known randomizer games
  const allStreams = [];
  const streamMap = new Map(); // To deduplicate
  
  try {
    // Combo games first: a stream naming the combo goes to it, not to a source game
    const comboResults = await mapWithConcurrency(comboGameIds, 4, async (gameId) => {
      const results = await Promise.all(COMBO_TWITCH_CATEGORY_IDS[gameId].map(id => fetchTwitchStreamsByCategoryId(id, null)));
      return { streams: filterComboStreams(results.flat(), gameId), primaryGameId: gameId };
    });

    // Fetch streams from known categories with bounded concurrency
    const categoryEntries = Array.from(twitchCategoryIdToGameRefs.entries());
    const categoryResults = await mapWithConcurrency(categoryEntries, 8, async ([categoryId, refs]) => {
      const primary = refs[0] || { gameId: 'unknown', categoryName: '' };
      const includeAll = PASS_THROUGH_TWITCH_CATEGORIES.has(String(primary.categoryName || '').toLowerCase());
      const streams = await fetchTwitchStreamsByCategoryId(categoryId, primary.categoryName, includeAll);
      // A multi-game category (Archipelago) doesn't tell which game is played
      return { streams, primaryGameId: includeAll ? null : primary.gameId, refs: includeAll ? null : refs };
    });
    const multiGameResults = await mapWithConcurrency(MULTI_GAME_TWITCH_CATEGORY_IDS, 2, async (categoryId) => ({
      streams: await fetchTwitchStreamsByCategoryId(categoryId, null),
      primaryGameId: null
    }));
    categoryResults.push(...multiGameResults);

    for (const result of [...comboResults, ...categoryResults]) {
      for (const stream of (result?.streams || [])) {
        if (!streamMap.has(stream.id)) {
          streamMap.set(stream.id, {
            ...stream,
            gameId: result.refs ? gameOfSharedCategory(stream, result.refs) : result.primaryGameId
          });
        }
      }
    }

    // Fallback only for games without explicit categoryId
    const fallbackGameNames = Array.from(fallbackTwitchGameToGameIds.keys());
    const fallbackResults = await mapWithConcurrency(fallbackGameNames, 8, async (gameName) => {
      const includeAll = PASS_THROUGH_TWITCH_CATEGORIES.has(String(gameName).toLowerCase());
      const streams = await fetchTwitchStreams(gameName, includeAll);
      const gameIds = fallbackTwitchGameToGameIds.get(gameName) || [];
      const primaryGameId = includeAll ? null : (gameIds[0] || 'unknown');
      return { streams, primaryGameId };
    });

    for (const result of fallbackResults) {
      for (const stream of (result?.streams || [])) {
        if (!streamMap.has(stream.id)) {
          streamMap.set(stream.id, {
            ...stream,
            gameId: result.primaryGameId
          });
        }
      }
    }
    
    allStreams.push(...streamMap.values());

    // Additive augmentation: cross-reference racetime.gg live races per game
    // to catch mistagged Twitch streams. Never removes anything found above.
    try {
      const gamesWithRacetimeSlug = games.filter(g => getRacetimeSlugsForGame(g).length > 0);
      const racetimeResults = await mapWithConcurrency(gamesWithRacetimeSlug, 4, async (game) => {
        const gameId = (game.id || '').toLowerCase();
        return fetchRacetimeLiveStreamsForGame(game, gameId);
      });
      for (const streams of racetimeResults) {
        for (const stream of (streams || [])) {
          if (!streamMap.has(stream.id)) {
            streamMap.set(stream.id, stream);
            allStreams.push(stream);
          }
        }
      }
    } catch (error) {
      console.warn('Racetime live augmentation skipped for aggregate streams:', error?.message || error);
    }
  } catch (error) {
    console.error('Error fetching Twitch streams:', error);
  }

  // Twitch category names follow each publisher's styling (all capitals): show the site's name
  const siteGameNames = new Map(games.map(g => [(g.id || '').toLowerCase(), gameLabel(g)]));
  for (const stream of allStreams) {
    const siteName = stream.gameId && siteGameNames.get(stream.gameId);
    if (siteName) stream.gameName = siteName;
  }

  // Sort streams by viewer count (highest first)
  allStreams.sort((a, b) => (b.viewerCount || 0) - (a.viewerCount || 0));

  const result = {
    streams: allStreams,
    total: allStreams.length,
    fetchedAt: new Date().toISOString()
  };


  return result;
}

// Building the list queries Twitch for every game and takes several seconds: like the stats
// by game, an expired list keeps being served (up to ALL_STREAMS_MAX_STALE) while a single
// background refresh runs, and a timer keeps it fresh so the home page never waits for it.
const ALL_STREAMS_KEY = 'streams:all';
const ALL_STREAMS_MAX_STALE = 15 * 60 * 1000;
let allStreamsInFlight = null;

function refreshAllStreams() {
  if (!allStreamsInFlight) {
    allStreamsInFlight = buildAllStreams()
      .then(result => {
        if (!result.message) setCache(ALL_STREAMS_KEY, result);
        return result;
      })
      .finally(() => {
        allStreamsInFlight = null;
      });
  }
  return allStreamsInFlight;
}

function warmAllStreams() {
  refreshAllStreams().catch(err => {
    console.warn('Refresh /api/streams failed:', err?.message || err);
  });
}
whenConnected(() => setTimeout(warmAllStreams, 4000));
// Refreshed a little before the cache expires
setInterval(warmAllStreams, CACHE_TTL - 30 * 1000).unref();

router.get('/', async (req, res, next) => {
  try {
    // ?limit=4: only the most watched streams (the home page shows four)
    const limit = parseInt(req.query.limit, 10);
    const send = (data) => res.json(limit > 0 && Array.isArray(data.streams)
      ? { ...data, streams: data.streams.slice(0, limit) }
      : data);

    const cached = getCached(ALL_STREAMS_KEY);
    if (cached) {
      return send(cached);
    }

    const stale = cache.data[ALL_STREAMS_KEY];
    if (stale && cache.expires[ALL_STREAMS_KEY] + ALL_STREAMS_MAX_STALE > Date.now()) {
      refreshAllStreams().catch(err => {
        console.warn('Refresh /api/streams failed:', err?.message || err);
      });
      return send(stale);
    }

    send(await refreshAllStreams());
  } catch (error) {
    next(error);
  }
});

module.exports = router;
