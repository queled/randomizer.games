// A series the organizer never validated on Challonge: score reported, no winner, the match left open.
// Over once its races all ended, one player ahead, with no more than one point per race and nothing
// played for a week (a 2-0 may still be a best of 5 between two races).
// Mirrored by settleMatchesFromRaces() in public/js/tournament-detail.js: keep both in sync.

const SETTLED_SERIES_DELAY_MS = 7 * 24 * 60 * 60 * 1000;

// { winnerId, loserId, completedAt } of a series over, or null
function settledSeries(match, races, now = Date.now()) {
  if (!match || match.state === 'complete' || match.winnerId != null) return null;
  const played = (races || []).filter(r => r && r.startedAt);
  if (!played.length || !played.every(r => r.status === 'finished' && r.endedAt)) return null;
  const [s1, s2] = String(match.scoresCsv || '').split('-').map(Number);
  if (!Number.isInteger(s1) || !Number.isInteger(s2) || s1 === s2 || Math.max(s1, s2) > played.length) return null;
  const completedAt = new Date(Math.max(...played.map(r => new Date(r.endedAt).getTime())));
  if (now - completedAt.getTime() < SETTLED_SERIES_DELAY_MS) return null;
  return {
    winnerId: s1 > s2 ? match.player1Id : match.player2Id,
    loserId: s1 > s2 ? match.player2Id : match.player1Id,
    completedAt
  };
}

module.exports = { settledSeries, SETTLED_SERIES_DELAY_MS };
