const connectDB = require('../../config/database');
const { Race, Player } = require('../../models');

function parseISODuration(str) {
  // very small parser for PT#H#M#S
  // normalize P##DT... to PT... (e.g. P0DT02H38M59.697785S)
  const cleaned = String(str).replace(/^P(?:\d+D)?T/, 'PT');
  const re = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/;
  const m = re.exec(cleaned);
  if (!m) return null;
  const h = parseInt(m[1] || 0, 10);
  const min = parseInt(m[2] || 0, 10);
  const s = parseFloat(m[3] || 0);
  return Math.round(((h * 3600) + (min * 60) + s) * 1000);
}

function parseTimeToMs(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  const s = String(value).trim();
  if (!s) return null;
  // ISO duration
  if (s.startsWith('PT')) return parseISODuration(s);
  // colon format H:MM:SS or M:SS
  if (s.includes(':')) {
    const parts = s.split(':').map(p => parseFloat(p));
    if (parts.length === 3) {
      return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
    }
    if (parts.length === 2) {
      return Math.round((parts[0] * 60 + parts[1]) * 1000);
    }
  }
  // numeric string: could be seconds or milliseconds; assume seconds if <= 10000
  const num = Number(s);
  if (!Number.isNaN(num)) {
    if (num > 10000) return Math.round(num); // likely already milliseconds
    return Math.round(num * 1000); // assume seconds
  }
  return null;
}

(async () => {
  try {
    await connectDB();
    console.log('Connected');

    // Races
    const raceCursor = Race.find({}).cursor();
    let raceUpdated = 0;
    for (let race = await raceCursor.next(); race != null; race = await raceCursor.next()) {
      let modified = false;
      if (Array.isArray(race.entrants)) {
        for (const ent of race.entrants) {
          if ((ent.finishTime || ent.finishTime === 0) && !ent.finishTimeMs) {
            const ms = parseTimeToMs(ent.finishTime);
            if (ms != null) {
              ent.finishTimeMs = ms;
              modified = true;
            }
          }
        }
      }
      if (modified) {
        await race.save();
        raceUpdated++;
      }
    }

    // Players
    const playerCursor = Player.find({}).cursor();
    let playerUpdated = 0;
    for (let player = await playerCursor.next(); player != null; player = await playerCursor.next()) {
      let modified = false;
      if (player.stats) {
        if ((player.stats.bestTime || player.stats.bestTime === 0) && !player.stats.bestTimeMs) {
          const ms = parseTimeToMs(player.stats.bestTime);
          if (ms != null) { player.stats.bestTimeMs = ms; modified = true; }
        }
        if ((player.stats.averageTime || player.stats.averageTime === 0) && !player.stats.averageTimeMs) {
          const ms = parseTimeToMs(player.stats.averageTime);
          if (ms != null) { player.stats.averageTimeMs = ms; modified = true; }
        }
      }
      if (modified) { await player.save(); playerUpdated++; }
    }

    console.log(`Races updated: ${raceUpdated}, Players updated: ${playerUpdated}`);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
