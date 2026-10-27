/**
 * Double forfeits in the elimination brackets of start.gg events.
 *
 * start.gg cannot knock out both players of a set: when both forfeit, organizers report a win
 * for one of them, who then loses their next set without playing it. Such a set is told apart
 * by its racetime.gg rooms, which nobody finished, and by that next set, lost with no room.
 * The first set is marked `doubleForfeit` (both players out there), the next one
 * `withdrawnEntrantId` (the opponent goes through alone): the tournament page and the
 * provisional ranks read them.
 */

const STARTGG_COMPLETED = 3;

const roomsOf = m => (Array.isArray(m.raceUrls) && m.raceUrls.length ? m.raceUrls : [m.raceUrl]).filter(Boolean);

// "https://racetime.gg/<category>/<room>" or "/<category>/<room>" → "<category>/<room>", as in race.name
const roomName = url => String(url || '').replace(/^https?:\/\/(?:www\.)?racetime\.gg/i, '').replace(/^\/+|\/+$/g, '');

const sideIds = m => [m.player1?.startggEntrantId, m.player2?.startggEntrantId].map(id => (id ? String(id) : null));

const isElimination = (phases, name) => {
  const phase = (phases || []).find(p => p.name === name);
  return /elimination/i.test(phase?.bracketType || '');
};

/** A room nobody finished: cancelled, or over with every entrant out */
function isUnfinished(race) {
  if (race.status === 'cancelled') return true;
  return race.status === 'finished' && !(race.entrants || []).some(e => e.status === 'done');
}

/**
 * Marks the double forfeits on the matches (stored shape), in place.
 * @param unfinishedRooms Set of room names ("<category>/<room>") nobody finished
 * @returns number of double forfeits found
 */
function markDoubleForfeits(matches, phases, unfinishedRooms) {
  for (const m of matches) {
    delete m.doubleForfeit;
    delete m.withdrawnEntrantId;
  }
  let found = 0;
  for (const m of matches) {
    const rooms = roomsOf(m);
    if (Number(m.state) !== STARTGG_COMPLETED || m.winnerId == null || !rooms.length) continue;
    if (!isElimination(phases, m.phase) || !rooms.every(url => unfinishedRooms.has(roomName(url)))) continue;
    const winner = String(m.winnerId);
    const round = m.round || 0;
    // Their next set on the same side of the bracket (losers rounds are negative)
    const next = matches
      .filter(n => n.phase === m.phase && Math.sign(n.round || 0) === Math.sign(round)
        && Math.abs(n.round || 0) > Math.abs(round) && sideIds(n).includes(winner))
      .sort((a, b) => Math.abs(a.round) - Math.abs(b.round))[0];
    if (!next || Number(next.state) !== STARTGG_COMPLETED || next.winnerId == null) continue;
    if (String(next.winnerId) === winner || roomsOf(next).length) continue;
    m.doubleForfeit = true;
    next.withdrawnEntrantId = winner;
    found++;
  }
  return found;
}

/** The rooms linked to completed matches that nobody finished */
async function findUnfinishedRooms(matches, Race) {
  const names = [...new Set(matches
    .filter(m => Number(m.state) === STARTGG_COMPLETED)
    .flatMap(roomsOf).map(roomName))];
  if (!names.length) return new Set();
  const races = await Race.find({ name: { $in: names } }).select('name status entrants.status').lean();
  return new Set(races.filter(isUnfinished).map(r => r.name));
}

module.exports = { markDoubleForfeits, findUnfinishedRooms, isUnfinished };
