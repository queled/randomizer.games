const express = require('express');
const router = express.Router();
const { Game } = require('../models');

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

async function getTwitchToken() {
  if (twitchAccessToken && twitchTokenExpires > Date.now()) {
    return twitchAccessToken;
  }

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

// Combo games that should fetch streams from multiple source games
const COMBO_GAMES = {
  'ootmm': ['The Legend of Zelda: Ocarina of Time', 'The Legend of Zelda: Majora\'s Mask'],
  'smz3': ['The Legend of Zelda: A Link to the Past', 'Super Metroid'],
  'hodbt': ['Castlevania: Harmony of Dissonance', 'Bomberman Tournament'],
  'mpcg': ['Metroid Prime', 'Metroid Prime 2: Echoes'],
  'z1m1': ['The Legend of Zelda', 'Metroid'],
  'z1m1z3m3': ['The Legend of Zelda', 'Metroid', 'The Legend of Zelda: A Link to the Past', 'Metroid Prime 3: Corruption']
};

// Keywords that must appear in title/tags for combo games (case-insensitive)
const COMBO_KEYWORDS = {
  'ootmm': ['ootmm', 'oot mm', 'ootxmm', 'oot x mm', 'ocarina majora', 'oot+mm', 'oot/mm'],
  'smz3': ['smz3', 'sm z3', 'smxz3', 'sm x z3', 'super metroid link', 'metroid alttp', 'sm+z3', 'z3sm'],
  'hodbt': ['hodbt', 'hod bt', 'hodxbt', 'harmony bomberman'],
  'mpcg': ['mpcg', 'crossgame', 'cross game', 'mp1 mp2', 'prime crossover'],
  'z1m1': ['z1m1', 'z1 m1', 'zelda metroid nes', 'z1xm1'],
  'z1m1z3m3': ['z1m1z3m3', 'z1m1z3', 'multiworld', 'quad randomizer', 'quad crossover randomizer']
};

// Per-game extra filters:
// - PER_GAME_TITLE_KEYWORDS: require one of these keywords to appear in title/tags
// - PER_GAME_ALLOWED_TWITCH_CATEGORIES: only accept streams whose Twitch category name matches one of these
const PER_GAME_TITLE_KEYWORDS = {
  // ootmq requires "master quest" or "mq" or "ootmqr" in title/tags
  'ootmq': ['master quest', 'mq', 'ootmqr']
};

const PER_GAME_ALLOWED_TWITCH_CATEGORIES = {
  // alttpfs should only accept streams whose Twitch category is Four Swords
  'alttpfs': ['The Legend of Zelda: Four Swords Adventures', 'The Legend of Zelda: Four Swords']
};

// Twitch game category names (as they appear on Twitch) - fallback only
const TWITCH_GAME_NAMES = {
  // === ZELDA SERIES ===
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
  'ootmm': 'The Legend of Zelda: Ocarina of Time', // combo - aussi MM
  'ss': 'The Legend of Zelda: Skyward Sword',
  'tmc': 'The Legend of Zelda: The Minish Cap',
  'tp': 'The Legend of Zelda: Twilight Princess',
  'tww': 'The Legend of Zelda: The Wind Waker',
  'twwhd': 'The Legend of Zelda: The Wind Waker HD',
  'z1': 'The Legend of Zelda',
  'z2': 'Zelda II: The Adventure of Link',
  
  // === ZELDA COMBOS ===
  'smz3': 'Super Metroid', // combo - aussi ALttP
  'z1m1': 'The Legend of Zelda', // combo - aussi Metroid NES
  'z1m1z3m3': 'The Legend of Zelda', // mega combo
  
  // === METROID SERIES ===
  'am2r': 'AM2R',
  'm1': 'Metroid',
  'md': 'Metroid Dread',
  'mf': 'Metroid Fusion',
  'mfo': 'Metroid Fusion',
  'mp': 'Metroid Prime',
  'mp2': 'Metroid Prime 2: Echoes',
  'mp3': 'Metroid Prime 3: Corruption',
  'mpcg': 'Metroid Prime', // combo - aussi MP2
  'mpr': 'Metroid Prime Remastered',
  'msr': 'Metroid: Samus Returns',
  'mzm': 'Metroid: Zero Mission',
  'sm': 'Super Metroid',
  
  // === CASTLEVANIA SERIES ===
  'aos': 'Castlevania: Aria of Sorrow',
  'c2': 'Castlevania II: Simon\'s Quest',
  'cotm': 'Castlevania: Circle of the Moon',
  'dos': 'Castlevania: Dawn of Sorrow',
  'hod': 'Castlevania: Harmony of Dissonance',
  'hodbt': 'Castlevania: Harmony of Dissonance', // combo
  'ooe': 'Castlevania: Order of Ecclesia',
  'por': 'Castlevania: Portrait of Ruin',
  'sotn': 'Castlevania: Symphony of the Night',
  
  // === KINGDOM HEARTS SERIES ===
  'kh2fm': ['Kingdom Hearts II', 'Kingdom Hearts HD 1.5 + 2.5 ReMIX'],
  'kh3': 'Kingdom Hearts III',
  'khfm': ['Kingdom Hearts', 'Kingdom Hearts HD 1.5 + 2.5 ReMIX'],
  
  // === MARIO SERIES ===
  'pm': 'Paper Mario',
  'pmttyd': 'Paper Mario: The Thousand-Year Door',
  'sm64': 'Super Mario 64',
  'smb3': 'Super Mario Bros. 3',
  'smr': 'Super Mario RPG',
  'smw': 'Super Mario World',
  'mlss': 'Mario & Luigi: Superstar Saga',
  
  // === DONKEY KONG SERIES ===
  'dk64': 'Donkey Kong 64',
  'dkr': 'Diddy Kong Racing',
  
  // === FINAL FANTASY SERIES ===
  'ff': 'Final Fantasy',
  'ff5': 'Final Fantasy V',
  'ff6': 'Final Fantasy VI',
  
  // === DRAGON QUEST/WARRIOR SERIES ===
  'dw': 'Dragon Warrior',
  'dw2': 'Dragon Warrior II',
  'dw3': 'Dragon Warrior III',
  'dw4': 'Dragon Warrior IV',
  
  // === MEGA MAN SERIES ===
  'mm2': 'Mega Man 2',
  
  // === POKÉMON SERIES ===
  'pe': 'Pokémon Emerald',
  'prb': 'Pokémon Red and Blue',
  'up': 'Pokémon Crystal', // Universal Pokemon Randomizer works on various
  
  // === OTHER GAMES ===
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
  'zexion': 'Zexion',
  
  // Standalone Twitch category for multiworld/randomizer content
  'archipelago': 'Archipelago'
};

// Categories for which we should include all streams in the Twitch category
// (no title/tag 'randomizer' filtering). Lowercase keys.
const PASS_THROUGH_TWITCH_CATEGORIES = new Set(['archipelago']);

// Acronymes/diminutifs des randomizers à chercher dans le titre des streams
// Mappé par Twitch game name (ou array de noms) pour vérifier que c'est la bonne catégorie
const RANDOMIZER_ACRONYMS = {
  // === ZELDA SERIES ===
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
  
  // === METROID SERIES ===
  'AM2R': ['am2r rando', 'am2rr'],
  'Metroid': ['m1r', 'nes metroid rando', 'quad randomizer', 'quad crossover randomizer'],
  'Metroid Dread': ['dread rando', 'mdr'],
  'Metroid Fusion': ['mfr', 'fusion rando'],
  'Metroid Prime': ['mpr', 'prime rando', 'mp1r'],
  'Metroid Prime 2: Echoes': ['mp2r', 'echoes rando'],
  'Metroid Prime 3: Corruption': ['mp3r', 'corruption rando', 'quad randomizer', 'quad crossover randomizer'],
  'Metroid Prime Remastered': ['mprr', 'remastered rando'],
  'Metroid: Samus Returns': ['msrr', 'sr rando'],
  'Metroid: Zero Mission': ['mzmr', 'zm rando'],
  'Super Metroid': ['smr', 'sm rando', 'varia'],
  
  // === CASTLEVANIA SERIES ===
  'Castlevania: Aria of Sorrow': ['aosr', 'aos rando'],
  'Castlevania II: Simon\'s Quest': ['cv2r', 'simons quest rando'],
  'Castlevania: Circle of the Moon': ['cotmr', 'cotm rando'],
  'Castlevania: Dawn of Sorrow': ['dosr', 'dos rando'],
  'Castlevania: Harmony of Dissonance': ['hodr', 'hod rando'],
  'Castlevania: Order of Ecclesia': ['ooer', 'ooe rando'],
  'Castlevania: Portrait of Ruin': ['porr', 'por rando'],
  'Castlevania: Symphony of the Night': ['sotnr', 'sotn rando'],
  
  // === KINGDOM HEARTS SERIES ===
  'Kingdom Hearts II': ['kh2r', 'kh2 rando', 'kh2fm rando'],
  'Kingdom Hearts HD 1.5 + 2.5 ReMIX': ['kh2r', 'kh2fm rando', 'khfmr'],
  'Kingdom Hearts III': ['kh3r', 'kh3 rando'],
  'Kingdom Hearts': ['khfmr', 'kh1 rando'],
  
  // === MARIO SERIES ===
  'Paper Mario': ['pm64r', 'pm64 rando'],
  'Paper Mario: The Thousand-Year Door': ['ttydr', 'ttyd rando', 'pmttyd rando'],
  'Super Mario 64': ['sm64r', 'sm64 rando'],
  'Super Mario Bros. 3': ['smb3r', 'smb3 rando'],
  'Super Mario RPG': ['smrpgr', 'smrpg rando'],
  'Super Mario World': ['smwr', 'smw rando'],
  'Mario & Luigi: Superstar Saga': ['mlssr', 'mlss rando'],
  
  // === DONKEY KONG SERIES ===
  'Donkey Kong 64': ['dk64r', 'dk64 rando'],
  'Diddy Kong Racing': ['dkrr', 'dkr rando'],
  
  // === FINAL FANTASY SERIES ===
  'Final Fantasy': ['ff1r', 'ffr', 'ff1 rando'],
  'Final Fantasy V': ['ff5r', 'ffvr', 'ffvcd'],
  'Final Fantasy VI': ['ff6r', 'ff6wc', 'worlds collide'],
  
  // === DRAGON QUEST/WARRIOR SERIES ===
  'Dragon Warrior': ['dwr', 'dw1r'],
  'Dragon Warrior II': ['dw2r'],
  'Dragon Warrior III': ['dw3r'],
  'Dragon Warrior IV': ['dw4r'],
  
  // === MEGA MAN SERIES ===
  'Mega Man 2': ['mm2r', 'mm2 rando'],
  
  // === POKÉMON SERIES ===
  'Pokémon Emerald': ['emerald rando', 'pkmne'],
  'Pokémon Red and Blue': ['pokemon rando', 'pkmnrb'],
  'Pokémon Crystal': ['crystal rando', 'universal pokemon'],
  
  // === OTHER GAMES ===
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
const twitchStreamsInFlight = new Map();

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

  try {
    const response = await fetch(`https://api.twitch.tv/helix/games?name=${encodeURIComponent(gameName)}`, {
      headers: {
        'Client-ID': TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${token}`
      }
    });

    if (response.ok) {
      const data = await response.json();
      if (data.data && data.data.length > 0) {
        gameIdCache[gameName] = data.data[0].id;
        return data.data[0].id;
      }
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
      const response = await fetch(`https://api.twitch.tv/helix/streams?game_id=${encodeURIComponent(normalizedCategoryId)}&first=100`, {
        headers: {
          'Client-ID': TWITCH_CLIENT_ID,
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        let candidateStreams = (data.data || []);

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

// Filter streams for combo games by checking if title/tags contain combo-specific keywords
function filterComboStreams(streams, gameId) {
  const keywords = COMBO_KEYWORDS[gameId.toLowerCase()];
  if (!keywords || keywords.length === 0) {
    return streams; // No filtering for non-combo games
  }

  return streams.filter(stream => {
    const title = (stream.title || '').toLowerCase();
    const tags = (stream.tags || []).map(t => t.toLowerCase());
    const combined = title + ' ' + tags.join(' ');
    
    // Check if any of the combo keywords appear in title or tags
    return keywords.some(keyword => combined.includes(keyword.toLowerCase()));
  });
}

// Check if a stream is a randomizer stream based on title, tags, and game-specific acronyms
function isRandomizerStream(stream, gameName) {
  const title = (stream.title || '').toLowerCase();
  const tags = (stream.tags || []).map(t => t.toLowerCase());

  // Extra global rule: accept streams with explicit multiworld/archipelago mention in title.
  // The game category constraint is already enforced upstream via Twitch game_id filtering.
  if (title.includes('multiworld') || title.includes('archipelago')) {
    return true;
  }
  
  // Check generic randomizer/rando mentions
  if (title.includes('randomizer') || title.includes('rando')) {
    return true;
  }
  if (tags.some(t => t.includes('randomizer') || t.includes('rando'))) {
    return true;
  }
  
  // Check game-specific acronyms in title
  const acronyms = RANDOMIZER_ACRONYMS[gameName];
  if (acronyms && acronyms.length > 0) {
    // Check if any acronym appears in the title
    // Use word boundary matching to avoid false positives (e.g., "SSR" not matching "USSR")
    for (const acronym of acronyms) {
      const acroLower = acronym.toLowerCase();
      // For short acronyms (like "ssr", "ootr"), use word boundary check
      // For longer phrases (like "jets of time"), use simple includes
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
      const response = await fetch(`https://api.twitch.tv/helix/streams?game_id=${gameId}&first=100`, {
        headers: {
          'Client-ID': TWITCH_CLIENT_ID,
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        let candidateStreams = (data.data || []);

        // By default, only include streams that mention randomizer/rando in title or tags,
        // OR that use game-specific acronyms (e.g., "OoTR", "SSR", "ALBWR").
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

// Fetch entrants marked as live-streaming (with a Twitch channel) for a given race
async function fetchRacetimeLiveEntrants(dataUrl) {
  const cacheKey = `racetime-live:race:${dataUrl}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  let liveEntrants = [];
  try {
    const response = await fetch(`${RACETIME_HOST_URL}${dataUrl}`, {
      headers: { Accept: 'application/json' }
    });
    if (response.ok) {
      const data = await response.json();
      const entrants = Array.isArray(data.entrants) ? data.entrants : [];
      liveEntrants = entrants
        .filter(e => e?.stream_live && e?.user?.twitch_channel)
        .map(e => {
          const login = (e.user.twitch_name || extractTwitchLoginFromChannelUrl(e.user.twitch_channel) || '').toLowerCase();
          if (!login) return null;
          return {
            twitchLogin: login,
            raceUrl: data.url ? `${RACETIME_HOST_URL}${data.url}` : null,
            raceGoal: data.goal?.name || null
          };
        })
        .filter(Boolean);
    }
  } catch (error) {
    console.warn(`Racetime live entrants fetch failed for ${dataUrl}:`, error?.message || error);
  }

  setCache(cacheKey, liveEntrants, RACETIME_LIVE_CACHE_TTL);
  return liveEntrants;
}

// Confirm live status/viewer count directly with Twitch for a batch of logins (no title/tag filtering)
async function fetchTwitchStreamsByLogins(logins) {
  const uniqueLogins = Array.from(new Set((logins || []).map(l => String(l || '').toLowerCase()).filter(Boolean))).slice(0, 100);
  if (!uniqueLogins.length) return [];

  const token = await getTwitchToken();
  if (!token) return [];

  try {
    const params = uniqueLogins.map(login => `user_login=${encodeURIComponent(login)}`).join('&');
    const response = await fetch(`https://api.twitch.tv/helix/streams?${params}&first=100`, {
      headers: {
        'Client-ID': TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${token}`
      }
    });

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
      startedAt: stream.started_at
    }));
  } catch (error) {
    console.warn('Error confirming racetime-detected streams with Twitch:', error?.message || error);
    return [];
  }
}

// Build extra stream entries for a game by cross-referencing racetime.gg live races with Twitch.
// Purely additive: returns [] on any error or when the game has no racetime slug configured.
async function fetchRacetimeLiveStreamsForGame(gameDoc, gameIdLower) {
  try {
    const slugs = getRacetimeSlugsForGame(gameDoc);
    if (!slugs.length) return [];

    const candidates = [];
    for (const slug of slugs) {
      const races = await fetchRacetimeInProgressRaces(slug);
      const entrantLists = await mapWithConcurrency(races, 4, race => fetchRacetimeLiveEntrants(race.data_url));
      for (const entrants of entrantLists) {
        candidates.push(...entrants);
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

    return confirmedStreams.map(stream => {
      const info = raceInfoByLogin.get(String(stream.userLogin || '').toLowerCase());
      return {
        ...stream,
        gameId: gameIdLower,
        source: 'racetime-live',
        raceUrl: info?.raceUrl || null,
        raceGoal: info?.raceGoal || null
      };
    });
  } catch (error) {
    console.warn(`Racetime live augmentation failed for ${gameIdLower}:`, error?.message || error);
    return [];
  }
}

async function buildGameStreamsResult(gameId) {
  const gameIdLower = String(gameId || '').toLowerCase();
  const cacheKey = `streams:${gameIdLower}`;

  const cached = getCached(cacheKey);
  if (cached) {
    return cached;
  }

  const gameDoc = await Game.findOne({ id: gameIdLower, enabled: { $ne: false } });
  if (!gameDoc) {
    return {
      gameId,
      streams: [],
      total: 0,
      message: 'Game not supported yet',
      fetchedAt: new Date().toISOString()
    };
  }

  const comboGames = COMBO_GAMES[gameIdLower];
  let twitchStreamsAll = [];

  if (comboGames) {
    const streamPromises = comboGames.map(gameName => fetchTwitchStreams(gameName, PASS_THROUGH_TWITCH_CATEGORIES.has(String(gameName).toLowerCase())));
    const results = await Promise.all(streamPromises);

    const streamMap = new Map();
    for (const streams of results) {
      for (const stream of streams) {
        if (!streamMap.has(stream.id)) {
          streamMap.set(stream.id, stream);
        }
      }
    }
    twitchStreamsAll = Array.from(streamMap.values());
    twitchStreamsAll = filterComboStreams(twitchStreamsAll, gameIdLower);
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
      const kws = titleKeywords.map(k => k.toLowerCase());
      twitchStreamsAll = twitchStreamsAll.filter(s => {
        const title = (s.title || '').toLowerCase();
        const tags = (s.tags || []).map(t => (t || '').toLowerCase()).join(' ');
        const combined = title + ' ' + tags;
        return kws.some(k => combined.includes(k));
      });
    }

    const allowedCats = PER_GAME_ALLOWED_TWITCH_CATEGORIES[gameIdLower];
    if (allowedCats && allowedCats.length > 0) {
      const allowed = allowedCats.map(a => a.toLowerCase());
      twitchStreamsAll = twitchStreamsAll.filter(s => allowed.includes((s.gameName || '').toLowerCase()));
    }
  } catch (e) {
    console.warn('Per-game stream filtering failed for', gameIdLower, e);
  }

  let allStreams = twitchStreamsAll
    .map(stream => ({
      ...stream,
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

async function buildStreamsStatsByGame() {
  const games = await Game.find({ enabled: { $ne: false } }).select('id').lean();
  const gameIds = games
    .map(game => String(game.id || '').toLowerCase())
    .filter(Boolean);

  const stats = {};
  const concurrency = Math.min(8, gameIds.length);
  let index = 0;

  async function worker() {
    while (index < gameIds.length) {
      const currentIndex = index;
      index += 1;
      const gameId = gameIds[currentIndex];

      try {
        const result = await buildGameStreamsResult(gameId);
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

setTimeout(() => {
  buildStreamsStatsByGame()
    .then(result => {
      setCache('streams:stats-by-game', result);
    })
    .catch(err => {
      console.warn('Warmup /api/streams/stats/by-game failed:', err?.message || err);
    });
}, 2500);

router.get('/stats/by-game', async (req, res, next) => {
  try {
    const cacheKey = 'streams:stats-by-game';
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json(cached);
    }
    const result = await buildStreamsStatsByGame();

    setCache(cacheKey, result);
    res.json(result);
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

// Get Twitch user avatar by username (streams the image directly)
router.get('/twitch-avatar/:username', async (req, res, next) => {
  try {
    const { username } = req.params;
    const cacheKey = `twitch-avatar:${username.toLowerCase()}`;
    
    // Check cache for avatar URL
    const cached = getCached(cacheKey);
    let avatarUrl = cached?.avatarUrl;
    
    if (!avatarUrl) {
      const token = await getTwitchToken();
      if (!token) {
        return res.status(503).json({ error: 'Twitch API not configured' });
      }

      const response = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(username)}`, {
        headers: {
          'Client-ID': TWITCH_CLIENT_ID,
          'Authorization': `Bearer ${token}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        if (data.data && data.data.length > 0) {
          avatarUrl = data.data[0].profile_image_url;
          if (avatarUrl) {
            setCache(cacheKey, { avatarUrl });
          }
        }
      }
      
      if (!avatarUrl) {
        setCache(cacheKey, { avatarUrl: null });
        return res.status(204).end();
      }
    }
    
    // Stream the image directly instead of redirecting
    try {
      const imgResponse = await fetch(avatarUrl);
      if (imgResponse.ok) {
        const contentType = imgResponse.headers.get('content-type') || 'image/png';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=3600');
        
        // Stream the response body
        const arrayBuffer = await imgResponse.arrayBuffer();
        return res.send(Buffer.from(arrayBuffer));
      }
    } catch (e) {
      console.error('Error streaming Twitch avatar:', e);
    }
    
    return res.status(204).end();
  } catch (error) {
    console.error('Error fetching Twitch avatar:', error);
    return res.status(204).end();
  }
});

// Get all randomizer streams (not game-specific)
router.get('/', async (req, res, next) => {
  try {
    const cacheKey = 'streams:all';
    
    // Check cache
    const cached = getCached(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const token = await getTwitchToken();
    if (!token) {
      return res.json({ streams: [], total: 0, message: 'Twitch API not configured' });
    }

    // Build reverse map: Twitch game name -> gameIds (from DB only)
    const fallbackTwitchGameToGameIds = new Map();
    const twitchCategoryIdToGameRefs = new Map();
    const games = await Game.find({ enabled: { $ne: false } });
    for (const game of games) {
      const gameId = (game.id || '').toLowerCase();
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
      // Fetch streams from known categories with bounded concurrency
      const categoryEntries = Array.from(twitchCategoryIdToGameRefs.entries());
      const categoryResults = await mapWithConcurrency(categoryEntries, 8, async ([categoryId, refs]) => {
        const primary = refs[0] || { gameId: 'unknown', categoryName: '' };
        const includeAll = PASS_THROUGH_TWITCH_CATEGORIES.has(String(primary.categoryName || '').toLowerCase());
        const streams = await fetchTwitchStreamsByCategoryId(categoryId, primary.categoryName, includeAll);
        return { streams, primaryGameId: primary.gameId };
      });

      for (const result of categoryResults) {
        for (const stream of (result?.streams || [])) {
          if (!streamMap.has(stream.id)) {
            streamMap.set(stream.id, {
              ...stream,
              gameId: result.primaryGameId
            });
          }
        }
      }

      // Fallback only for games without explicit categoryId
      const fallbackGameNames = Array.from(fallbackTwitchGameToGameIds.keys());
      const fallbackResults = await mapWithConcurrency(fallbackGameNames, 8, async (gameName) => {
        const streams = await fetchTwitchStreams(gameName, PASS_THROUGH_TWITCH_CATEGORIES.has(String(gameName).toLowerCase()));
        const gameIds = fallbackTwitchGameToGameIds.get(gameName) || [];
        const primaryGameId = gameIds[0] || 'unknown';
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

    // Sort streams by viewer count (highest first)
    allStreams.sort((a, b) => (b.viewerCount || 0) - (a.viewerCount || 0));

    const result = {
      streams: allStreams,
      total: allStreams.length,
      fetchedAt: new Date().toISOString()
    };


    setCache(cacheKey, result);

    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
