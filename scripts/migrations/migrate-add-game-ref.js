const connectDB = require('../config/database');
const { Tournament, Game } = require('../models');

(async () => {
  try {
    await connectDB();
    console.log('Connected');

    const cursor = Tournament.find({}).cursor();
    let updated = 0;

    // preload games for heuristic matching
    const games = await Game.find({}).lean();

    for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
      if (doc.game && doc.game.toString()) continue; // already set
      const legacyId = doc.gameId;

      let game = null;
      // 1) if legacyId looks like an ObjectId, try direct lookup by _id
      if (legacyId && /^[a-f0-9]{24}$/.test(String(legacyId))) {
        game = await Game.findById(legacyId);
      }

      // 2) if not found, try by id (slug)
      if (!game && legacyId) {
        game = await Game.findOne({ id: legacyId });
      }

      // 3) heuristic: try to match tournament.name or gameName against available games
      if (!game && doc.name) {
        const lname = doc.name.toLowerCase();
        for (const g of games) {
          if (lname.includes(g.id.toLowerCase()) || (g.name && lname.includes(g.name.toLowerCase().split(':')[0]))) { // match id or first part of name
            game = await Game.findById(g._id);
            break;
          }
        }
      }

      if (game) {
        doc.game = game._id;
        doc.gameSlug = game.id || game.shortName || null;
        await doc.save();
        updated++;
      } else {
        console.warn(`Game not found for tournament ${doc._id} legacy gameId=${legacyId}`);
      }
    }

    console.log(`Updated ${updated} tournaments with game ObjectId`);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
