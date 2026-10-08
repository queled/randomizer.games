const racetimeAPI = require('./racetime');
const { getRaceLabel } = require('../helpers/race-match-linking');
const {
  QUALIFIER_PHASE,
  goalTokens,
  collectCandidateCategories
} = require('./tournament-autolink');

const DAY_MS = 24 * 60 * 60 * 1000;
// Qualifiers are played in the weeks before the bracket starts
const WINDOW_BEFORE_MS = 120 * DAY_MS;
const WINDOW_AFTER_MS = 14 * DAY_MS;
// Racetime pages scanned around the qualifiers already found in the database
const RACETIME_SCAN_PADDING_MS = 10 * DAY_MS;
const RACETIME_DELAY_MS = 500;
const MIN_QUALIFIER_ENTRANTS = 3;

// "Qualifier #13", "qualifier 18", "Qualifier race #3", "Qualifiers #1", "Qualifier B", "Live Quals 2"
const QUALIFIER_RE = /\bqual(?:if(?:ier|ication)|)s?\b(?:\s+race)?\s*#?\s*(\d{1,3}|[a-z])\b/i;
// Rooms announcing a qualifier without being one
const NOT_QUALIFIER_RE = /\b(practice|showcase|not|format|draft|mock)\b/i;
// Words of a qualifier label that never name the event
const QUALIFIER_STOPWORDS = new Set(['qualifier', 'qualifiers', 'qualification', 'qual', 'quals', 'race', 'online', 'async', 'live', 'na', 'eu', 'weekly']);
// A room goal naming an event ("Scrubs Tournament Season 8") rather than a ruleset
const GOAL_EVENT_RE = /\b(tournament|tourney|league|cup|season|qualif\w*|s\d+)\b/i;

function eventTokens(text) {
  return goalTokens(text).filter((token) => !QUALIFIER_STOPWORDS.has(token) && !/^\d+$/.test(token));
}

/**
 * Qualifier room label: "OoTR Standard Tournament Season 7: Qualifier #13 (NA Weekly)"
 * → { index: '13', eventTokens: ['s7'] }. The event is read before the qualifier
 * number and right after it ("Qualifier race #3 Season 2 tournament"), up to a separator.
 */
function parseQualifierLabel(race) {
  const label = getRaceLabel(race);
  if (NOT_QUALIFIER_RE.test(label)) return null;
  const match = QUALIFIER_RE.exec(label);
  if (!match) return null;

  const before = label.slice(0, match.index);
  const after = label.slice(match.index + match[0].length).split(/[-|(:,\n]/)[0];
  return {
    label,
    index: match[1].toUpperCase(),
    eventTokens: [...new Set(eventTokens(`${before} ${after}`))]
  };
}

function getGameTokens(tournament) {
  const game = tournament?.game && typeof tournament.game === 'object' ? tournament.game : null;
  return new Set(goalTokens([
    tournament?.gameName,
    game?.name,
    game?.official?.name,
    game?.randomizer?.shortName,
    game?.randomizer?.tinyName
  ].filter(Boolean).join(' ')));
}

function getTournamentTokens(tournament) {
  return new Set([...goalTokens(tournament?.name), ...getGameTokens(tournament)]);
}

/**
 * Words of the tournament name the qualifier room does not say ("challenge", "cup"
 * for a Challenge Cup), seasons and game names aside: among tournaments claiming
 * the same room, the one with none is the event the qualifiers are for.
 */
function countExtraNameTokens(race, tournament) {
  const said = new Set([...(parseQualifierLabel(race)?.eventTokens || []), ...eventTokens(race?.goal)]);
  const gameTokens = getGameTokens(tournament);
  return new Set(goalTokens(tournament?.name).filter((token) => (
    !said.has(token) &&
    !gameTokens.has(token) &&
    !/^(s|top)?\d+$/.test(token)
  ))).size;
}

function getQualifierWindow(tournament) {
  const start = tournament?.startDate ? new Date(tournament.startDate).getTime() : NaN;
  if (Number.isNaN(start)) return null;
  return {
    minDate: new Date(start - WINDOW_BEFORE_MS),
    maxDate: new Date(start + WINDOW_AFTER_MS)
  };
}

/**
 * How a race qualifies for a tournament: 'named' when its label names the tournament
 * (season, series...), 'bare' for a plain "Qualifier 3" played before it, null otherwise.
 */
function matchQualifierToTournament(race, tournament, window = getQualifierWindow(tournament)) {
  if (!window || ['pending', 'cancelled', 'open', 'invitational'].includes(race?.status)) return null;
  const startedAt = new Date(race?.startedAt || race?.openedAt || 0);
  if (startedAt < window.minDate || startedAt > window.maxDate) return null;

  const parsed = parseQualifierLabel(race);
  if (!parsed) return null;
  // Two players running a qualifier async ("[ASYNC] S8 Qualifier #3") are not one
  const fewEntrants = Array.isArray(race?.entrants) && race.entrants.length && race.entrants.length < MIN_QUALIFIER_ENTRANTS;
  if (fewEntrants && /\basync\b/i.test(parsed.label)) return null;

  const tournamentTokens = getTournamentTokens(tournament);
  if (parsed.eventTokens.length) {
    return parsed.eventTokens.every((token) => tournamentTokens.has(token)) ? 'named' : null;
  }

  // A plain label relies on the room goal: naming this event ("Triforce Blitz"),
  // a ruleset ("Standard Ruleset"), or another event
  const goal = String(race?.goal || '');
  const goalTokens = eventTokens(goal);
  if (goalTokens.length && goalTokens.every((token) => tournamentTokens.has(token))) return 'named';
  if (GOAL_EVENT_RE.test(goal)) return null;
  // A plain qualifier of two players may be a match: a named one is sure ("SGL2026 - Live Quals 1")
  if (fewEntrants) return null;
  return 'bare';
}

function toProposal(race, matchType, { inDatabase, tournament }) {
  const parsed = parseQualifierLabel(race);
  return {
    raceUrl: race.url,
    raceLabel: parsed?.label || getRaceLabel(race),
    qualifierIndex: parsed?.index || null,
    raceEntrants: Array.isArray(race.entrants) ? race.entrants.length : null,
    startedAt: race.startedAt || race.openedAt || null,
    goal: race.goal || null,
    matchType,
    extraNameTokens: countExtraNameTokens(race, tournament),
    inDatabase,
    // Attached before qualifiers had their own phase
    attached: !!race.tournamentId && String(race.tournamentId) === String(tournament?._id)
  };
}

// Qualifier rooms of the database a tournament can take (not attached elsewhere)
async function findDatabaseQualifiers({ tournament, Race }) {
  const window = getQualifierWindow(tournament);
  if (!window) return [];
  const categories = collectCandidateCategories(tournament, await Race.find({ tournamentId: tournament._id }).select('category').lean());
  if (!categories.length) return [];

  const races = await Race.find({
    category: { $in: categories },
    startedAt: { $gte: window.minDate, $lte: window.maxDate },
    info: /\bqual(?:if|s?\b)/i,
    $or: [{ tournamentId: null }, { tournamentId: tournament._id }]
  }).select('-entrants.comment').lean();

  return races
    .filter((race) => !(race.matchId || race.startggSetId))
    .map((race) => ({ race, matchType: matchQualifierToTournament(race, tournament, window) }))
    .filter(({ matchType }) => matchType);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Racetime lists past races newest first: first page holding races opened before `date`
async function findRacetimePage(category, date, numPages) {
  let lo = 1;
  let hi = numPages;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const { races } = await racetimeAPI.getPastRaces(category, mid, { showEntrants: false });
    const last = races[races.length - 1];
    if (last && new Date(last.openedAt) > date) lo = mid + 1;
    else hi = mid;
    await sleep(RACETIME_DELAY_MS);
  }
  return lo;
}

// Qualifier rooms of racetime opened between minDate and maxDate
async function scanRacetimeQualifiers({ category, minDate, maxDate, tournament }) {
  const first = await racetimeAPI.getPastRaces(category, 1, { showEntrants: false });
  if (!first.numPages) return [];

  const found = [];
  let page = await findRacetimePage(category, maxDate, first.numPages);
  for (; page <= first.numPages; page++) {
    const { races } = await racetimeAPI.getPastRaces(category, page, { showEntrants: false });
    if (!races.length) break;
    for (const race of races) {
      const openedAt = new Date(race.openedAt);
      if (openedAt < minDate || openedAt > maxDate) continue;
      const url = `/${category}/${String(race.name).split('/').pop()}`;
      const matchType = matchQualifierToTournament({ ...race, url, entrants: null }, tournament);
      if (matchType) found.push({ race: { ...race, url, entrants: null }, matchType });
    }
    if (new Date(races[races.length - 1].openedAt) < minDate) break;
    await sleep(RACETIME_DELAY_MS);
  }
  return found;
}

/**
 * Qualifier rooms a tournament can take: those of the database, plus (with
 * `racetime`) the ones of racetime.gg the database is missing. The racetime scan
 * covers the dates of the qualifiers already found, or the whole window without any.
 */
async function buildQualifierPreview({ tournament, Race, racetime = false }) {
  const fromDatabase = await findDatabaseQualifiers({ tournament, Race });
  const proposals = fromDatabase
    .filter(({ race }) => race.tournamentPhase !== QUALIFIER_PHASE)
    .map(({ race, matchType }) => toProposal(race, matchType, { inDatabase: true, tournament }));
  const alreadyAttached = fromDatabase.length - proposals.length;

  if (racetime) {
    const window = getQualifierWindow(tournament);
    const dates = fromDatabase.map(({ race }) => new Date(race.startedAt).getTime());
    const minDate = dates.length ? new Date(Math.max(Math.min(...dates) - RACETIME_SCAN_PADDING_MS, window.minDate.getTime())) : window?.minDate;
    const maxDate = dates.length ? new Date(Math.min(Math.max(...dates) + RACETIME_SCAN_PADDING_MS, window.maxDate.getTime())) : window?.maxDate;
    const categories = collectCandidateCategories(tournament, fromDatabase.map(({ race }) => race));

    if (minDate && maxDate) {
      for (const category of categories) {
        const scanned = await scanRacetimeQualifiers({ category, minDate, maxDate, tournament });
        const urls = scanned.map(({ race }) => race.url);
        const known = new Map((await Race.find({ url: { $in: urls } }).select('url tournamentId matchId startggSetId').lean())
          .map((race) => [race.url, race]));
        for (const { race, matchType } of scanned) {
          const existing = known.get(race.url);
          // Rooms of the database were already judged above (or belong to another tournament)
          if (existing) continue;
          proposals.push(toProposal(race, matchType, { inDatabase: false, tournament }));
        }
      }
    }
  }

  proposals.sort((a, b) => new Date(a.startedAt || 0) - new Date(b.startedAt || 0));
  return { proposals, alreadyAttached };
}

/**
 * Import a racetime room (and its players) into the database: "/ootr/amazing-deadhand-3884"
 */
async function importRacetimeRace({ raceUrl, Race, Player }) {
  const [category, slug] = String(raceUrl).replace(/^https?:\/\/(www\.)?racetime\.gg/i, '').split('/').filter(Boolean);
  if (!category || !slug) throw new Error(`Invalid racetime URL ${raceUrl}`);

  const raceData = await racetimeAPI.getRace(category, slug);
  if (!raceData) throw new Error(`Race ${raceUrl} not found on racetime.gg`);
  const url = `/${category}/${slug}`.toLowerCase();

  const race = await Race.findOneAndUpdate(
    { url },
    {
      $set: {
        name: raceData.name,
        category,
        status: raceData.status,
        goal: raceData.goal,
        info: raceData.info,
        startedAt: raceData.startedAt,
        endedAt: raceData.endedAt,
        recordable: raceData.recordable,
        entrants: racetimeAPI.toStoredEntrants(raceData.entrants),
        source: { type: 'racetime', externalId: raceData.name, url: `https://racetime.gg${url}`, importedAt: new Date() }
      }
    },
    { upsert: true, new: true }
  );

  for (const entrant of raceData.entrants || []) {
    if (!entrant.user?.id) continue;
    await Player.findOneAndUpdate(
      { userId: entrant.user.id },
      { $set: { name: entrant.user.name, discriminator: entrant.user.discriminator, racetimeUrl: entrant.user.url || entrant.user.id } },
      { upsert: true }
    );
  }

  return race;
}

/**
 * Attach races to a tournament as qualifiers, importing from racetime.gg the ones
 * the database does not have yet
 */
async function applyQualifiers({ tournament, raceUrls, Race, Player }) {
  let attached = 0;
  let imported = 0;
  const errors = [];

  for (const raceUrl of raceUrls) {
    try {
      let race = await Race.findOne({ url: raceUrl });
      if (!race) {
        race = await importRacetimeRace({ raceUrl, Race, Player });
        imported++;
        await sleep(RACETIME_DELAY_MS);
      }

      if (race.tournamentId && String(race.tournamentId) !== String(tournament._id)) {
        errors.push(`Race ${raceUrl} is already attached to another tournament`);
        continue;
      }
      if (race.matchId || race.startggSetId) {
        errors.push(`Race ${raceUrl} is linked to a match`);
        continue;
      }

      race.tournamentId = tournament._id;
      race.tournamentPhase = QUALIFIER_PHASE;
      race.tournamentPool = undefined;
      race.tournamentRound = undefined;
      race.matchConfidence = undefined;
      race.matchPlayers = undefined;
      await race.save();
      attached++;
    } catch (error) {
      errors.push(`Error attaching ${raceUrl}: ${error.message}`);
    }
  }

  return { attached, imported, total: raceUrls.length, errors };
}

module.exports = {
  QUALIFIER_PHASE,
  parseQualifierLabel,
  matchQualifierToTournament,
  getQualifierWindow,
  buildQualifierPreview,
  importRacetimeRace,
  applyQualifiers
};
