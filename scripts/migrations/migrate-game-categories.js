#!/usr/bin/env node
/**
 * One-off migration: moves the former hard-coded categories of the game page
 * (public/js/game-detail.js) into the `categories` and `categorySettings` fields
 * of two games, writes those of a third, all linked to their racetime goals,
 * and clears the generic placeholder categories ("Standard settings"...) of the
 * other games.
 *
 * Idempotent: these games are overwritten with the content below, and only
 * category lists made entirely of placeholders are cleared.
 *
 * Usage:
 *   node scripts/migrations/migrate-game-categories.js
 *   node scripts/migrations/migrate-game-categories.js --dry-run
 */

const mongoose = require('mongoose');
const connectDB = require('../../config/database');
const { Game } = require('../../models');

const isDryRun = process.argv.includes('--dry-run');

const CONTENT = {
  sm64: {
    categories: [
      {
        id: '70-star',
        name: '70 Star',
        description: 'Collect 70 stars in a randomized seed, then defeat Bowser in the Sky.',
        translations: { fr: { name: '70 étoiles', description: 'Récupérer 70 étoiles dans une seed randomisée, puis vaincre Bowser dans le ciel.' } },
        racetimeGoals: [{ slug: 'sm64r', goal: '70 Star' }]
      },
      {
        id: '70-star-non-stop',
        name: '70 Star Non Stop',
        description: '70 Star with the Non Stop modification: collecting a star no longer sends Mario out of the course.',
        translations: { fr: { name: '70 étoiles Non Stop', description: '70 étoiles avec la modification Non Stop : récupérer une étoile ne fait plus sortir Mario du niveau.' } },
        racetimeGoals: [{ slug: 'sm64r', goal: '70 Star Non Stop' }]
      },
      {
        id: '120-star',
        name: '120 Star',
        description: 'Collect all 120 stars, then defeat Bowser in the Sky.',
        translations: { fr: { name: '120 étoiles', description: 'Récupérer les 120 étoiles, puis vaincre Bowser dans le ciel.' } },
        racetimeGoals: [{ slug: 'sm64r', goal: '120 Star' }]
      },
      {
        id: '120-star-non-stop',
        name: '120 Star Non Stop',
        description: '120 Star with the Non Stop modification: Mario stays in the course after each star.',
        translations: { fr: { name: '120 étoiles Non Stop', description: '120 étoiles avec la modification Non Stop : Mario reste dans le niveau après chaque étoile.' } },
        racetimeGoals: [{ slug: 'sm64r', goal: '120 Star Non Stop' }]
      }
    ],
    // Several randomizers of the game coexist, each with its own options
    categorySettings: []
  },

  oot: {
    // Racetime goals of this randomizer are rulesets (techniques allowed) and game modes
    categories: [
      {
        id: 'standard',
        name: 'Standard',
        description: 'The default ruleset of OoTR races, played with glitchless logic: it lists the techniques allowed. The leaderboards of its earlier versions are archived.',
        translations: { fr: { name: 'Standard', description: 'Le règlement par défaut des courses OoTR, joué en logique glitchless : il liste les techniques autorisées. Les classements de ses versions précédentes sont archivés.' } },
        racetimeGoals: ['Standard Ruleset', 'Standard Ruleset (2025)', 'Standard Ruleset (pre 10/24)'].map(goal => ({ slug: 'ootr', goal }))
      },
      {
        id: 'league',
        name: 'League',
        description: 'OoTR League: seasons of 1v1 matches between players of the same skill division, on the settings of the season.',
        translations: { fr: { name: 'League', description: 'OoTR League : des saisons de matchs en 1 contre 1 entre joueurs d\'une même division de niveau, avec les réglages de la saison.' } },
        racetimeGoals: ['League Season 10', 'League Season 9', 'League Season 8'].map(goal => ({ slug: 'ootr', goal }))
      },
      {
        id: 'random-settings-league',
        name: 'Random Settings League',
        description: 'Each seed draws its settings at random. Only official matches of the league may use this goal.',
        translations: { fr: { name: 'Random Settings League', description: 'Chaque seed tire ses réglages au hasard. Seuls les matchs officiels de la ligue peuvent utiliser cet objectif.' } },
        racetimeGoals: ['Random settings league', 'Random settings league (Season 1)'].map(goal => ({ slug: 'ootr', goal }))
      },
      {
        id: 'triforce-blitz',
        name: 'Triforce Blitz',
        description: 'Short mode: three Triforce pieces are hidden in dungeons and finding them ends the race. Many seeds take under an hour; competitive play has a two-hour limit.',
        translations: { fr: { name: 'Triforce Blitz', description: 'Mode court : trois fragments de Triforce sont cachés dans les donjons, les trouver termine la course. Beaucoup de seeds se bouclent en moins d\'une heure ; la compétition impose une limite de deux heures.' } },
        racetimeGoals: ['Triforce Blitz', 'Triforce Blitz Archive'].map(goal => ({ slug: 'ootr', goal }))
      },
      {
        id: 'ddr',
        name: 'Dungeon Door Requirement (DDR)',
        description: 'Glitched ruleset played with glitchless logic: clips and quality-of-life glitches are allowed, so racers learn glitches without leaving the logic of the seed.',
        translations: { fr: { name: 'Dungeon Door Requirement (DDR)', description: 'Règlement avec glitches joué en logique glitchless : clips et glitches de confort sont autorisés, pour apprendre les glitches sans sortir de la logique de la seed.' } },
        racetimeGoals: [{ slug: 'ootr', goal: 'DDR ruleset' }]
      },
      {
        id: 'no-im-ww',
        name: 'No IM/WW',
        description: 'Glitched ruleset banning only the most broken glitches: wrong warps, item manipulation, SRM and ACE. The default ruleset of glitched logic.',
        translations: { fr: { name: 'No IM/WW', description: 'Règlement avec glitches qui n\'interdit que les plus radicaux : wrong warps, manipulation d\'objets, SRM et ACE. Le règlement par défaut de la logique glitched.' } },
        racetimeGoals: [{ slug: 'ootr', goal: 'No IM/WW ruleset' }]
      }
    ],
    categorySettings: [
      {
        name: 'Logic',
        description: 'Techniques the seed may require: glitchless logic goes with the Standard, DDR and GGJ rulesets.',
        values: ['Glitchless', 'Glitched', 'No Logic'],
        translations: { fr: { name: 'Logique', description: 'Techniques que la seed peut exiger : la logique glitchless va avec les règlements Standard, DDR et GGJ.' } }
      },
      {
        name: 'Rainbow Bridge',
        description: 'What opens the bridge to Ganon\'s Castle.',
        values: ['Always Open', 'Vanilla', 'Spiritual Stones', 'Medallions', 'Dungeons', 'Gold Skulltula Tokens', 'Hearts'],
        translations: { fr: { name: 'Pont arc-en-ciel', description: 'Ce qui ouvre le pont vers le château de Ganon.' } }
      },
      {
        name: 'Ganon\'s Boss Key',
        description: 'Where the key to Ganon\'s tower is, or whether it is needed at all.',
        values: ['Remove', 'Vanilla', 'Own Dungeon', 'Anywhere', 'Light Arrow Cutscene'],
        translations: { fr: { name: 'Clé du boss de Ganon', description: 'Où se trouve la clé de la tour de Ganon, ou si elle est nécessaire.' } }
      },
      {
        name: 'Small keys',
        description: 'Where the small keys of a dungeon can be found.',
        values: ['Remove', 'Vanilla', 'Own Dungeon', 'Any Dungeon', 'Overworld Only', 'Anywhere'],
        translations: { fr: { name: 'Petites clés', description: 'Où peuvent se trouver les petites clés d\'un donjon.' } }
      },
      {
        name: 'Entrance shuffle',
        description: 'Kinds of entrances mixed together.',
        values: ['Dungeons', 'Grottos', 'Interiors', 'Overworld', 'Owl Drops', 'Warp Songs', 'Spawn Points'],
        translations: { fr: { name: 'Mélange des entrées', description: 'Types d\'entrées mélangées entre elles.' } }
      },
      {
        name: 'Shuffled items',
        description: 'Locations added to the item pool beyond chests.',
        values: ['Songs', 'Gold Skulltula Tokens', 'Shops', 'Scrubs', 'Cows', 'Pots & Crates', 'Freestanding Items', 'Silver Rupees', 'Ocarinas', 'Kokiri Sword'],
        translations: { fr: { name: 'Objets mélangés', description: 'Emplacements ajoutés au pool d\'objets en plus des coffres.' } }
      }
    ]
  },

  alttp: {
    categories: [
      {
        id: 'tournament-solo',
        name: 'Tournament (Solo)',
        description: 'Tournament races played alone, with the settings of each tournament.',
        translations: { fr: { name: 'Tournoi (solo)', description: 'Courses de tournois jouées seul, avec les réglages propres à chaque tournoi.' } },
        racetimeGoals: [{ slug: 'alttpr', goal: 'Beat the game - Tournament (Solo)' }]
      },
      {
        id: 'tournament-coop',
        name: 'Tournament (Co-op)',
        description: 'Tournament races played in teams.',
        translations: { fr: { name: 'Tournoi (co-op)', description: 'Courses de tournois jouées en équipe.' } },
        racetimeGoals: [{ slug: 'alttpr', goal: 'Beat the game - Tournament (Co-op)' }]
      },
      {
        id: 'casual',
        name: 'Casual',
        description: 'Races outside tournaments: weeklies, community races and practice, with any settings.',
        translations: { fr: { name: 'Casual', description: 'Courses hors tournoi : weeklies, courses communautaires et entraînement, avec tous types de réglages.' } },
        racetimeGoals: [{ slug: 'alttpr', goal: 'Beat the game - Casual' }]
      },
      {
        id: 'spoiler',
        name: 'Spoiler',
        description: 'Players receive the spoiler log, which lists where every item is, and get planning time before the start.',
        translations: { fr: { name: 'Spoiler', description: 'Les joueurs reçoivent le spoiler log, qui indique l\'emplacement de chaque objet, et disposent d\'un temps de préparation avant le départ.' } },
        racetimeGoals: [{ slug: 'alttpr', goal: 'Beat the game - Spoiler' }]
      },
      {
        id: 'glitched',
        name: 'Glitched',
        description: 'Seeds whose logic expects glitches (Overworld Glitches or Major Glitches).',
        translations: { fr: { name: 'Glitched', description: 'Seeds dont la logique suppose des glitches (Overworld Glitches ou Major Glitches).' } },
        racetimeGoals: [{ slug: 'alttpr', goal: 'Beat the game (glitched)' }]
      },
      {
        id: 'step-ladder',
        name: 'Step Ladder',
        description: 'Scheduled ranked races of the Step Ladder (alttpr.racing), each slot with its own mode: Simple, Keys, Entrance, Inverted, Mystery…',
        translations: { fr: { name: 'Step Ladder', description: 'Courses classées programmées du Step Ladder (alttpr.racing), chaque créneau avec son mode : Simple, Keys, Entrance, Inverted, Mystery…' } },
        racetimeGoals: [
          'Beat the game (Simple)',
          'Beat the game (Keys)',
          'Beat the game (Entrance)',
          'Beat the game (Inverted)',
          'Beat the game (Mystery)',
          'Beat the game (Group)',
          'Beat the game (1v1)',
          'Beat the game (Spoiler)',
          'Beat the game (Glitched)',
          'Beat the game (Fun)'
        ].map(goal => ({ slug: 'alttpr-ladder', goal }))
      }
    ],
    categorySettings: [
      {
        name: 'World state',
        description: 'Standard starts with the Hyrule Castle escape, Open skips it, Inverted starts in the Dark World, Retro makes arrows cost rupees and sells universal small keys.',
        values: ['Standard', 'Open', 'Inverted', 'Retro'],
        translations: { fr: { name: 'État du monde', description: 'Standard commence par l\'évasion du château d\'Hyrule, Open la saute, Inverted démarre dans le Dark World, Retro fait payer les flèches en rubis et vend des petites clés universelles.' } }
      },
      {
        name: 'Goal',
        description: 'What ends the seed.',
        values: ['Defeat Ganon', 'Fast Ganon', 'All Dungeons', 'Master Sword Pedestal', 'Triforce Pieces'],
        translations: { fr: { name: 'Objectif', description: 'Ce qui termine la seed.' } }
      },
      {
        name: 'Dungeon items',
        description: 'Dungeon items that can be found outside their dungeon; Keysanity shuffles maps, compasses, small keys and big keys.',
        values: ['Standard', 'Maps & Compasses', 'Maps, Compasses & Small Keys', 'Keysanity'],
        translations: { fr: { name: 'Objets de donjon', description: 'Objets de donjon pouvant se trouver hors de leur donjon ; Keysanity mélange cartes, boussoles, petites clés et grandes clés.' } }
      },
      {
        name: 'Swords',
        description: 'How swords are placed, or whether there is none.',
        values: ['Randomized', 'Assured', 'Vanilla', 'Swordless'],
        translations: { fr: { name: 'Épées', description: 'Placement des épées, ou leur absence.' } }
      },
      {
        name: 'Logic',
        description: 'Techniques the seed may require to be completed.',
        values: ['No Glitches', 'Overworld Glitches', 'Major Glitches', 'No Logic'],
        translations: { fr: { name: 'Logique', description: 'Techniques que la seed peut exiger pour être terminée.' } }
      },
      {
        name: 'Entrance shuffle',
        description: 'Mixes the entrances of dungeons, caves and houses; each level mixes more of them.',
        values: ['None', 'Simple', 'Restricted', 'Full', 'Crossed', 'Insanity'],
        translations: { fr: { name: 'Mélange des entrées', description: 'Mélange les entrées des donjons, grottes et maisons ; chaque niveau en mélange davantage.' } }
      },
      {
        name: 'Boss shuffle',
        description: 'Bosses fought in each dungeon.',
        values: ['None', 'Simple', 'Full', 'Random'],
        translations: { fr: { name: 'Mélange des boss', description: 'Boss affrontés dans chaque donjon.' } }
      },
      {
        name: 'Enemy shuffle',
        description: 'Enemies met in the world.',
        values: ['None', 'Shuffled', 'Random'],
        translations: { fr: { name: 'Mélange des ennemis', description: 'Ennemis rencontrés dans le monde.' } }
      }
    ]
  }
};

// Generic categories an earlier import gave several games, shown nowhere
const PLACEHOLDERS = new Set([
  'Standard|Standard settings',
  'Hell Mode|Difficult settings',
  'Hard|Difficult settings',
  'Triforce Hunt|Triforce pieces hunt',
  'All Dungeons|All dungeons required',
  'Normal|Normal mode',
  'Hard|Hard mode',
  'Casual|Casual mode'
]);

async function main() {
  await connectDB();

  try {
    console.log(`\n🎯 Migrate game categories${isDryRun ? ' (dry-run)' : ''}`);

    for (const [id, content] of Object.entries(CONTENT)) {
      const game = await Game.findOne({ id }).select('id categories').lean();
      if (!game) {
        console.warn(`⚠️ ${id}: jeu introuvable, ignoré`);
        continue;
      }
      console.log(`✏️ ${id}: ${(game.categories || []).map(c => c.name).join(', ') || '(aucune)'} → ${content.categories.map(c => c.name).join(', ')}, ${content.categorySettings.length} réglages`);
      if (!isDryRun) {
        await Game.updateOne({ id }, { $set: content });
      }
    }

    const others = await Game.find({ id: { $nin: Object.keys(CONTENT) }, 'categories.0': { $exists: true } })
      .select('id categories').lean();
    for (const game of others) {
      const labels = game.categories.map(c => `${c.name}|${c.description}`);
      if (!labels.every(label => PLACEHOLDERS.has(label))) {
        console.log(`✔️ ${game.id}: catégories conservées (${game.categories.map(c => c.name).join(', ')})`);
        continue;
      }
      console.log(`🧹 ${game.id}: retire ${labels.join(' ; ')}`);
      if (!isDryRun) {
        await Game.updateOne({ _id: game._id }, { $set: { categories: [] } });
      }
    }

    console.log('✅ Terminé');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(err => {
  console.error('❌ Erreur migration catégories:', err.message);
  process.exitCode = 1;
});
