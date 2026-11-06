/**
 * Restreams of marathon runs in another language, archived on YouTube with the
 * marathon's tag at the end of the title: "<Game> en 1:23:45 (<Category>) [<EVENT>]".
 */

const RANDOMIZER_RE = /\brando\b|randomi[sz]er|archipelago|multiworld/i;
const EVENT_TAG_RE = /\[([a-z][a-z0-9]*\d{2,4})\]\s*$/i;
const TIME_RE = /\b(\d{1,2}):(\d{2}):(\d{2})\b/;
// A run's time in the restream's title and the time the marathon gives: within a few minutes
const RUN_TIME_TOLERANCE_S = 15 * 60;

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');

// "Game Randomizer" → "game"; "BONUS GAME 2 - Game" → "game"
function gameKey(name) {
  return norm(String(name || '').replace(/^bonus game\s*\d*\s*-\s*/i, '').replace(/\brandomi[sz]er\b/ig, ''));
}

function titleEvent(title) {
  const m = String(title).match(EVENT_TAG_RE);
  return m ? m[1].toLowerCase() : null;
}

function titleRunTime(title) {
  const m = String(title).match(TIME_RE);
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
}

/**
 * The run a restream's title is of, among the marathon's randomizer runs: same event,
 * the run's game named in the title; between runs of the same game, the closest time.
 * @param runs [{ event: { short }, name, runTime }]
 * @returns the run, or null
 */
function matchRestream(title, runs) {
  if (!RANDOMIZER_RE.test(title)) return null;
  const event = titleEvent(title);
  if (!event) return null;
  const words = norm(title);
  const matching = runs.filter(run => String(run.event && run.event.short).toLowerCase() === event
    && gameKey(run.name).length >= 3 && words.includes(gameKey(run.name)));
  if (matching.length <= 1) return matching[0] || null;
  const time = titleRunTime(title);
  if (time === null) return null;
  const close = matching.filter(run => run.runTime && Math.abs(run.runTime - time) <= RUN_TIME_TOLERANCE_S)
    .sort((a, b) => Math.abs(a.runTime - time) - Math.abs(b.runTime - time));
  return close[0] || null;
}

module.exports = { matchRestream, titleEvent, titleRunTime, RANDOMIZER_RE };
