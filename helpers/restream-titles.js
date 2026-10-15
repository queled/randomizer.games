/**
 * Reading Twitch video and stream titles of restreams: which event and which
 * players they are about.
 */

function normalizeName(str) {
  return String(str || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

// Mido's House series a video title points to, to tell apart the same players met in another tournament
const SERIES_KEYWORDS = {
  fr: /tournoi ?fr|hexagone/,
  tot: /\btot\b|tournament of truth/,
  s: /challenge cup|\bcc\b|standard/,
  pot: /pots? ?of ?time|\bpot\b/,
  rsl: /\brsl\b/,
  mp: /mix(?:ed)? ?pools?/,
  sl: /spoiler ?log/,
  mw: /multiworld|\bmw\b/,
  coop: /co-?op\b/,
  tfb: /triforce blitz|\btfb\b/,
  rot: /rupees of time|\brot\b/,
  efk: /escape from kak|\befk\b/,
  sgl: /speedgaming|\bsgl\b|\bsgss\b/,
  mentor: /mentor/,
  league: /league/,
  scrubs: /scrubs/
};

// `site`: where the event is scheduled (services/schedule-sites.js); the series keywords are Mido's House's
function titleFitsEvent(title, series, event, site = 'midos') {
  const lower = String(title).toLowerCase();
  const named = (site || 'midos') === 'midos' ? Object.keys(SERIES_KEYWORDS).filter(key => SERIES_KEYWORDS[key].test(lower)) : [];
  if (named.length && !named.includes(series)) return false;
  // "S6" in the title against season 2 of the event
  const season = lower.match(/\b(?:s|season|saison) ?(\d{1,2})\b/);
  const eventSeason = String(event || '').match(/^(\d{1,2})(?!\d)/);
  return !(season && eventSeason && season[1] !== eventSeason[1]);
}


// Practice, mock or scrim races: never the tournament race itself
const NOT_A_MATCH = /\b(?:practice|pratique|entrainement|entraînement|training|scrim|mock|vod ?review)\b/i;

/**
 * How many of the players a title names. `players` holds, for each player, the
 * names they go by (racetime.gg name, Twitch channel...); names shorter than 3
 * characters are ignored, as they would match anything.
 */
function countNamedPlayers(title, players) {
  const normalized = normalizeName(title);
  return players.filter(names => names.map(normalizeName).some(n => n.length >= 3 && normalized.includes(n))).length;
}

/**
 * A title is about the race when it names enough of its players: both of a
 * 1v1, at least half (and 2) of a bigger room.
 */
function titleNamesRace(title, players) {
  if (NOT_A_MATCH.test(String(title || ''))) return false;
  const needed = Math.max(2, Math.ceil(players.length / 2));
  return players.length >= 2 && countNamedPlayers(title, players) >= needed;
}

// Twitch broadcaster language → the English name Mido's House uses
const LANGUAGE_NAMES = { en: 'English', fr: 'French', de: 'German', es: 'Spanish', it: 'Italian', pt: 'Portuguese', ja: 'Japanese' };

module.exports = { normalizeName, titleFitsEvent, titleNamesRace, countNamedPlayers, LANGUAGE_NAMES };
