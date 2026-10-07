const axios = require('axios');

const SRL_BASE_URL = 'https://www.speedrunslive.com';

// Goal keywords that mark a race as a randomizer race inside a mixed SRL category
const RANDO_GOAL = /rando|randomi[sz]|\bseed\b|\bflags?\b|permalink|\bperm\b/i;

// ROM hacks raced in the same SRL "hacks" categories as the randomizers
const NON_RANDO_HACKS = /parallel worlds|goddess of wisdom|secrets of the past|kaizo|bs zelda|zelda'?s birthday|master quest|\bmq\b|\bredux\b|ocarina of time 3d|beta quest|bingo/i;

/**
 * SRL categories holding randomizer races, mapped to the racetime category of
 * the same game so they show up on its game page and in tournament auto-link.
 *
 * mode 'all'   → every race of the category is a randomizer race
 * mode 'rando' → only races whose goal names a randomizer (RANDO_GOAL or include)
 * exclude      → goals to drop even in mode 'all'
 * minYear      → races before the randomizer existed are other hacks
 */
const SRL_GAME_MAPPINGS = [
  { srl: 'alttphacks', category: 'alttpr', mode: 'all', minYear: 2017, exclude: NON_RANDO_HACKS },
  { srl: 'oothacks', category: 'ootr', mode: 'all', minYear: 2018, exclude: NON_RANDO_HACKS },
  { srl: 'mmrandom', category: 'mmr', mode: 'all', exclude: /bingo/i },
  { srl: 'mmhacks', category: 'mmr', mode: 'rando', include: /majora|\bmmr\b/i },
  { srl: 'twwrandom', category: 'twwr', mode: 'all' },
  { srl: 'tmchacks', category: 'tmcr', mode: 'all' },
  { srl: 'tlozhacks', category: 'z1r', mode: 'all' },
  { srl: 'zelda2hacks', category: 'z2r', mode: 'all' },
  { srl: 'z1m1', category: 'z1m1', mode: 'all' },
  { srl: 'tlozmetroid', category: 'z1m1', mode: 'all' },
  { srl: 'alttpsm', category: 'smz3', mode: 'all' },
  { srl: 'oosrando', category: 'oosr', mode: 'all' },
  { srl: 'ooarando', category: 'ooar', mode: 'all' },
  { srl: 'ladxrando', category: 'ladxr', mode: 'all' },
  { srl: 'hkhacks', category: 'hkr', mode: 'all' },
  { srl: 'aosr', category: 'aosr', mode: 'all' },
  { srl: 'crystalishacks', category: 'crystalis-rando', mode: 'all' },
  { srl: 'ffhacks', category: 'ff1r', mode: 'all' },
  { srl: 'ff6random', category: 'ff6wc', mode: 'rando', include: /beyond chaos|ff6wc|worlds collide/i },
  { srl: 'dwhacks', category: 'dwr', mode: 'all' },
  { srl: 'dw2hacks', category: 'dw2r', mode: 'all' },
  { srl: 'dw3hacks', category: 'dw3r', mode: 'all' },
  { srl: 'dw4hacks', category: 'dw4r', mode: 'all' },
  { srl: 'smb3hacks', category: 'smb3r', mode: 'rando' },
  { srl: 'supermetroidhacks', category: 'smr', mode: 'rando' },
  { srl: 'sm64hacks', category: 'sm64r', mode: 'rando' },
  { srl: 'megamanhacks', category: 'mm2r', mode: 'rando', only: /(mega ?man|rockman|mm) ?2\b.*rando/i },
  { srl: 'mzmhacks', category: 'mzmr', mode: 'rando' },
  { srl: 'smrpghacks', category: 'smrpgr', mode: 'rando' },
  { srl: 'SMWhacks', category: 'smwr', mode: 'rando' },
  { srl: 'mp1hacks', category: 'mpr', mode: 'rando' },
  { srl: 'mp2hacks', category: 'mp2r', mode: 'rando' },
  { srl: 'metroidhacks', category: 'm1r', mode: 'rando' }
];

function isRandomizerRace(race, mapping) {
  const goal = String(race?.raceGoal || '');
  const year = new Date(Number(race?.raceDate || 0) * 1000).getUTCFullYear();

  if (mapping.minYear && year < mapping.minYear) return false;
  if (mapping.exclude && mapping.exclude.test(goal)) return false;
  if (mapping.only) return mapping.only.test(goal);
  if (mapping.mode === 'all') return true;
  return RANDO_GOAL.test(goal) || !!(mapping.include && mapping.include.test(goal));
}

function getSrlRacePath(raceId) {
  return `/srl/${raceId}`;
}

function getSrlRaceWebUrl(raceId) {
  return `${SRL_BASE_URL}/races/result/${raceId}`;
}

function secondsToIsoDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `P0DT${pad(h)}H${pad(m)}M${pad(s)}S`;
}

function ordinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] || 'th'}`;
}

// SRL marks forfeits with time -1 and disqualifications with time -2 (place 9998/9999)
function formatEntrant(entrant) {
  const time = Number(entrant?.time);
  const finished = Number.isFinite(time) && time > 0;
  const status = finished
    ? 'done'
    : (/dq/i.test(entrant?.placeText || '') || time === -2 ? 'dq' : 'dnf');

  return {
    userName: entrant?.playerName || '',
    status,
    finishTime: finished ? secondsToIsoDuration(time) : null,
    finishTimeMs: finished ? time * 1000 : null,
    place: finished ? entrant.place : null,
    placeOrdinal: finished ? ordinal(entrant.place) : null,
    comment: entrant?.message || null
  };
}

/**
 * Convert an SRL past result into the Race document fields.
 * SRL only records when the results were saved (raceDate), so the start is
 * estimated from the slowest finish time.
 */
function formatRace(race, category) {
  const entrants = (race.entrants || []).map(formatEntrant);
  const endedAt = new Date(Number(race.raceDate) * 1000);
  const slowestMs = Math.max(0, ...entrants.map((e) => e.finishTimeMs || 0));
  const startedAt = new Date(endedAt.getTime() - slowestMs);
  const goal = String(race.raceGoal || '').trim();

  return {
    name: `srl/${race.raceId}`,
    category,
    url: getSrlRacePath(race.raceId),
    status: 'finished',
    goal: goal.slice(0, 500),
    info: goal.slice(0, 10000),
    startedAt,
    endedAt,
    recordable: true,
    entrants,
    source: {
      type: 'speedrunslive',
      externalId: String(race.raceId),
      url: getSrlRaceWebUrl(race.raceId),
      importedAt: new Date()
    }
  };
}

class SpeedRunsLiveAPI {
  constructor() {
    this.baseURL = `${SRL_BASE_URL}/api`;
  }

  /**
   * Get past results for an SRL game, newest first
   * @param {string} game - SRL game abbreviation (e.g. 'oothacks')
   * @param {number} page - Page number (1-based)
   * @param {number} pageSize - Races per page (SRL accepts up to 500)
   */
  async getPastResults(game, page = 1, pageSize = 500) {
    const response = await axios.get(`${this.baseURL}/pastresults`, {
      params: { game, pageNumber: page, pageSize },
      timeout: 60000
    });
    const data = response.data || {};
    if (!Array.isArray(data.data)) {
      return { races: [], totalPages: 0 };
    }
    return { races: data.data, totalPages: Number(data.totalPages) || 0 };
  }
}

module.exports = new SpeedRunsLiveAPI();
module.exports.SRL_GAME_MAPPINGS = SRL_GAME_MAPPINGS;
module.exports.isRandomizerRace = isRandomizerRace;
module.exports.formatRace = formatRace;
module.exports.getSrlRaceWebUrl = getSrlRaceWebUrl;
