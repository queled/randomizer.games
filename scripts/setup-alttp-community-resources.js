#!/usr/bin/env node

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Game } = require('../models');

function mergeByUrl(existing = [], incoming = []) {
  const map = new Map();

  for (const item of existing) {
    if (!item?.url) continue;
    map.set(item.url, item);
  }

  for (const item of incoming) {
    if (!item?.url) continue;
    map.set(item.url, item);
  }

  return Array.from(map.values());
}

async function main() {
  console.log('🔧 Configuration des liens Communauté/Ressources ALttP...');

  try {
    await connectDB();

    const game = await Game.findOne({ id: 'alttp' });
    if (!game) {
      console.error('❌ Jeu "alttp" introuvable en base.');
      process.exit(1);
    }

    game.resources = game.resources || {};

    game.resources.officialSite = {
      url: 'https://alttpr.com/',
      name: 'ALttP Randomizer (officiel)',
      isArchipelago: false
    };

    const sites = [
      { url: 'https://archipelago.gg/games/A%20Link%20to%20the%20Past/info/en', name: 'Archipelago', source: 'manual', isArchipelago: true, isObsolete: false },
      { url: 'https://multiworld.gg/games/A%20Link%20to%20the%20Past/info/en', name: 'Multiworld', source: 'manual', isArchipelago: false, isObsolete: false },
      { url: 'https://github.com/aerinon/ALttPDoorRandomizer', name: 'Door Randomizer', source: 'manual', isArchipelago: false, isObsolete: false },
      { url: 'https://alttpr.gwaa.kiwi/en', name: "Karafruit's", source: 'manual', isArchipelago: false, isObsolete: false },
      { url: 'https://github.com/codemann8/ALttPDoorRandomizer', name: 'Overworld Randomizer', source: 'manual', isArchipelago: false, isObsolete: false },
      { url: 'https://alttpr.com/en', name: "Veetorp's", source: 'manual', isArchipelago: false, isObsolete: false }
    ];

    const trackers = [
      {
        name: 'Muffins Tracker',
        url: 'https://alttprtracker.mfns.dev/',
        description: 'Fork de BigDunka avec support glitched, version stable recommandée.',
        source: 'manual'
      },
      {
        name: 'EmoTracker',
        url: 'https://emotracker.net',
        description: 'Tracker natif multi-jeux Windows avec packs communautaires LTTPR.',
        source: 'manual'
      },
      {
        name: 'CodeTracker (pack EmoTracker)',
        url: 'https://github.com/codemann8/alttp_codetracker',
        description: 'Pack complet DR/OWR pour EmoTracker (installable via package manager).',
        source: 'manual'
      },
      {
        name: "BigDunka's Tracker (deprecated)",
        url: 'https://alttprtracker.dunka.net/',
        description: 'Tracker web historique, déprécié.',
        source: 'manual'
      },
      {
        name: 'OpenTracker',
        url: 'https://github.com/trippsc2/OpenTracker/releases',
        description: 'Auto-tracker open source cross-platform pour ALttPR.',
        source: 'manual'
      },
      {
        name: "Crossproduct's ALttP Tracker",
        url: 'http://www.twitch.tv/crossproduct/',
        description: 'Tracker JavaScript original.',
        source: 'manual'
      },
      {
        name: "TestRunnerSRL's fork of Cross HUD",
        url: 'https://testrunnersrl.github.io/lttp-tracker/',
        description: 'Adaptation du tracker original de Cross.',
        source: 'manual'
      },
      {
        name: "Codeflayer's Mobile Tracker",
        url: 'https://alttprtracker.com/',
        description: 'Tracker mobile avec support entrées et keysanity.',
        source: 'manual'
      },
      {
        name: "Hyphen-ated's fork of Chaz HUD",
        url: 'https://hyphen-ated.github.io/lttp-tracker/',
        description: 'Fork téléchargeable du HUD Chaz.',
        source: 'manual'
      },
      {
        name: 'Voice-activated fork of Chaz HUD',
        url: 'https://lttp-voice-tracker.firebaseapp.com/',
        description: 'Tracker voice-activated pour annoncer les items.',
        source: 'manual'
      },
      {
        name: 'Printable Tracker',
        url: 'https://drive.google.com/file/d/1nA4K_TlIRhwo59dqZaWuk084MMjg2KSw',
        description: 'Version papier imprimable.',
        source: 'manual'
      },
      {
        name: "Orphis' Entrance Tracker",
        url: 'https://orphis.github.io/alttp_entrance_randomizer_tracker/',
        description: 'Tracker Entrance (en développement).',
        source: 'manual'
      },
      {
        name: 'Entrando',
        url: 'https://github.com/telethar/Entrando',
        description: 'Tracker Entrance téléchargeable avec notes.',
        source: 'manual'
      }
    ];

    const guides = [
      {
        name: 'Common things that stump newcomers',
        url: 'https://docs.google.com/document/d/1eOabgvHCKqncO9JzZQR6T-b6yuTtAOuu3INZyOIRupM/edit?tab=t.0#heading=h.3r5cbtzb9jed',
        description: 'Bonne première lecture pour les nouveaux joueurs.',
        type: 'guide',
        source: 'manual'
      },
      {
        name: 'ALttPR Guides & Documentation',
        url: 'https://docs.google.com/document/d/1UsGmZ-1L5gCceUPSewlfLZ7zaGprnjJCIaxxMiKqheY/edit?tab=t.0#heading=h.w96dxmxv4uno',
        description: 'Documentation détaillée et ressources avancées.',
        type: 'guide',
        source: 'manual'
      },
      {
        name: 'ALTTP Glitches Overview',
        url: 'https://docs.google.com/document/d/1RTJ0oVPioSaEr_S_Ya49z1xZfHz168IcOinfP-BGaZ8/edit?tab=t.0',
        description: 'Vue d’ensemble des glitches utiles.',
        type: 'guide',
        source: 'manual'
      }
    ];

    const other = [
      {
        name: 'ALTTP Randomizer (Discord officiel)',
        url: 'https://discord.gg/alttprandomizer',
        description: 'Serveur Discord officiel ALttPR.',
        type: 'discord',
        source: 'manual'
      },
      {
        name: 'Communauté ALttPR francophone',
        url: 'https://discord.gg/wSM8KGVqh9',
        description: 'Discord FR ALttPR.',
        type: 'discord',
        source: 'manual'
      },
      {
        name: 'Générer une seed ALttPR',
        url: 'https://alttpr.com/en/randomizer',
        description: 'Création de seed ALttPR.',
        type: 'seed',
        source: 'manual'
      }
    ];

    game.resources.sites = mergeByUrl(game.resources.sites || [], sites);
    game.resources.trackers = mergeByUrl(game.resources.trackers || [], trackers);
    game.resources.guides = mergeByUrl(game.resources.guides || [], guides);
    game.resources.other = mergeByUrl(game.resources.other || [], other);

    game.markModified('resources');
    await game.save();

    console.log('✅ Ressources ALttP mises à jour');
    console.log(`   - Sites: ${game.resources.sites.length}`);
    console.log(`   - Trackers: ${game.resources.trackers.length}`);
    console.log(`   - Guides: ${game.resources.guides.length}`);
    console.log(`   - Other: ${game.resources.other.length}`);
  } catch (error) {
    console.error('❌ Erreur:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

main();
