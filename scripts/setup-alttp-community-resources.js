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

function translations(en, fr, es, de, it, pt) {
  return {
    en,
    fr,
    es,
    de,
    it,
    pt
  };
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
        description: "Fork of BigDunka's tracker with glitched support; recommended stable version.",
        translations: translations(
          { name: 'Muffins Tracker', description: "Fork of BigDunka's tracker with glitched support; recommended stable version." },
          { name: 'Muffins Tracker', description: 'Fork de BigDunka avec support glitched, version stable recommandée.' },
          { name: 'Muffins Tracker', description: 'Fork del tracker de BigDunka con soporte glitched; versión estable recomendada.' },
          { name: 'Muffins Tracker', description: 'Fork von BigDunkas Tracker mit Glitched-Support; empfohlene stabile Version.' },
          { name: 'Muffins Tracker', description: 'Fork del tracker di BigDunka con supporto glitched; versione stabile consigliata.' },
          { name: 'Muffins Tracker', description: 'Fork do tracker do BigDunka com suporte a glitched; versão estável recomendada.' }
        ),
        source: 'manual'
      },
      {
        name: 'EmoTracker',
        url: 'https://emotracker.net',
        description: 'Native multi-game tracker for Windows with LTTPR community packs.',
        translations: translations(
          { name: 'EmoTracker', description: 'Native multi-game tracker for Windows with LTTPR community packs.' },
          { name: 'EmoTracker', description: 'Tracker natif multi-jeux Windows avec packs communautaires LTTPR.' },
          { name: 'EmoTracker', description: 'Tracker nativo multijuego para Windows con paquetes comunitarios de LTTPR.' },
          { name: 'EmoTracker', description: 'Nativer Multi-Game-Tracker für Windows mit LTTPR-Community-Paketen.' },
          { name: 'EmoTracker', description: 'Tracker nativo multi-gioco per Windows con pacchetti community LTTPR.' },
          { name: 'EmoTracker', description: 'Tracker nativo multi-jogo para Windows com pacotes da comunidade LTTPR.' }
        ),
        source: 'manual'
      },
      {
        name: 'CodeTracker (pack EmoTracker)',
        url: 'https://github.com/codemann8/alttp_codetracker',
        description: 'Full DR/OWR pack for EmoTracker (installable through package manager).',
        translations: translations(
          { name: 'CodeTracker (EmoTracker pack)', description: 'Full DR/OWR pack for EmoTracker (installable through package manager).' },
          { name: 'CodeTracker (pack EmoTracker)', description: 'Pack complet DR/OWR pour EmoTracker (installable via package manager).' },
          { name: 'CodeTracker (pack de EmoTracker)', description: 'Paquete completo DR/OWR para EmoTracker (instalable desde el gestor de paquetes).' },
          { name: 'CodeTracker (EmoTracker-Paket)', description: 'Vollständiges DR/OWR-Paket für EmoTracker (über den Paketmanager installierbar).' },
          { name: 'CodeTracker (pacchetto EmoTracker)', description: 'Pacchetto completo DR/OWR per EmoTracker (installabile dal package manager).' },
          { name: 'CodeTracker (pacote do EmoTracker)', description: 'Pacote completo DR/OWR para EmoTracker (instalável pelo gerenciador de pacotes).' }
        ),
        source: 'manual'
      },
      {
        name: "BigDunka's Tracker (deprecated)",
        url: 'https://alttprtracker.dunka.net/',
        description: 'Historic web tracker, now deprecated.',
        translations: translations(
          { name: "BigDunka's Tracker (deprecated)", description: 'Historic web tracker, now deprecated.' },
          { name: "BigDunka's Tracker (deprecated)", description: 'Tracker web historique, déprécié.' },
          { name: "BigDunka's Tracker (obsoleto)", description: 'Tracker web histórico, actualmente obsoleto.' },
          { name: "BigDunkas Tracker (veraltet)", description: 'Historischer Web-Tracker, inzwischen veraltet.' },
          { name: "Tracker di BigDunka (deprecato)", description: 'Tracker web storico, ora deprecato.' },
          { name: "Tracker do BigDunka (obsoleto)", description: 'Tracker web histórico, agora obsoleto.' }
        ),
        source: 'manual'
      },
      {
        name: 'OpenTracker',
        url: 'https://github.com/trippsc2/OpenTracker/releases',
        description: 'Open-source cross-platform auto-tracker for ALttPR.',
        translations: translations(
          { name: 'OpenTracker', description: 'Open-source cross-platform auto-tracker for ALttPR.' },
          { name: 'OpenTracker', description: 'Auto-tracker open source cross-platform pour ALttPR.' },
          { name: 'OpenTracker', description: 'Auto-tracker de código abierto y multiplataforma para ALttPR.' },
          { name: 'OpenTracker', description: 'Open-Source plattformübergreifender Auto-Tracker für ALttPR.' },
          { name: 'OpenTracker', description: 'Auto-tracker open source multipiattaforma per ALttPR.' },
          { name: 'OpenTracker', description: 'Auto-tracker open source multiplataforma para ALttPR.' }
        ),
        source: 'manual'
      },
      {
        name: "Crossproduct's ALttP Tracker",
        url: 'http://www.twitch.tv/crossproduct/',
        description: 'Original JavaScript tracker.',
        translations: translations(
          { name: "Crossproduct's ALttP Tracker", description: 'Original JavaScript tracker.' },
          { name: "Crossproduct's ALttP Tracker", description: 'Tracker JavaScript original.' },
          { name: 'Tracker de ALttP de Crossproduct', description: 'Tracker original en JavaScript.' },
          { name: 'Crossproducts ALttP-Tracker', description: 'Originaler JavaScript-Tracker.' },
          { name: 'Tracker ALttP di Crossproduct', description: 'Tracker JavaScript originale.' },
          { name: 'Tracker de ALttP do Crossproduct', description: 'Tracker JavaScript original.' }
        ),
        source: 'manual'
      },
      {
        name: "TestRunnerSRL's fork of Cross HUD",
        url: 'https://testrunnersrl.github.io/lttp-tracker/',
        description: "TestRunnerSRL's adaptation of Cross's original tracker.",
        translations: translations(
          { name: "TestRunnerSRL's fork of Cross HUD", description: "TestRunnerSRL's adaptation of Cross's original tracker." },
          { name: "TestRunnerSRL's fork of Cross HUD", description: 'Adaptation du tracker original de Cross.' },
          { name: 'Fork de Cross HUD por TestRunnerSRL', description: 'Adaptación de TestRunnerSRL del tracker original de Cross.' },
          { name: 'TestRunnerSRLs Fork von Cross HUD', description: 'TestRunnerSRLs Anpassung von Cross’ ursprünglichem Tracker.' },
          { name: 'Fork di Cross HUD di TestRunnerSRL', description: 'Adattamento di TestRunnerSRL del tracker originale di Cross.' },
          { name: 'Fork do Cross HUD por TestRunnerSRL', description: 'Adaptação do tracker original do Cross por TestRunnerSRL.' }
        ),
        source: 'manual'
      },
      {
        name: "Codeflayer's Mobile Tracker",
        url: 'https://alttprtracker.com/',
        description: 'Mobile tracker with entrance and keysanity support.',
        translations: translations(
          { name: "Codeflayer's Mobile Tracker", description: 'Mobile tracker with entrance and keysanity support.' },
          { name: "Codeflayer's Mobile Tracker", description: 'Tracker mobile avec support entrées et keysanity.' },
          { name: 'Tracker móvil de Codeflayer', description: 'Tracker móvil con soporte para entrances y keysanity.' },
          { name: 'Codeflayers Mobile-Tracker', description: 'Mobiler Tracker mit Entrance- und Keysanity-Unterstützung.' },
          { name: 'Tracker mobile di Codeflayer', description: 'Tracker mobile con supporto entrance e keysanity.' },
          { name: 'Tracker mobile do Codeflayer', description: 'Tracker mobile com suporte a entrances e keysanity.' }
        ),
        source: 'manual'
      },
      {
        name: "Hyphen-ated's fork of Chaz HUD",
        url: 'https://hyphen-ated.github.io/lttp-tracker/',
        description: "Downloadable fork of Chaz's HUD.",
        translations: translations(
          { name: "Hyphen-ated's fork of Chaz HUD", description: "Downloadable fork of Chaz's HUD." },
          { name: "Hyphen-ated's fork of Chaz HUD", description: 'Fork téléchargeable du HUD Chaz.' },
          { name: 'Fork de Chaz HUD por Hyphen-ated', description: 'Fork descargable del HUD de Chaz.' },
          { name: 'Hyphen-ateds Fork von Chaz HUD', description: 'Herunterladbarer Fork von Chaz’ HUD.' },
          { name: 'Fork di Chaz HUD di Hyphen-ated', description: 'Fork scaricabile dell’HUD di Chaz.' },
          { name: 'Fork do Chaz HUD por Hyphen-ated', description: 'Fork baixável do HUD do Chaz.' }
        ),
        source: 'manual'
      },
      {
        name: 'Voice-activated fork of Chaz HUD',
        url: 'https://lttp-voice-tracker.firebaseapp.com/',
        description: 'Voice-activated tracker announcing collected items.',
        translations: translations(
          { name: 'Voice-activated fork of Chaz HUD', description: 'Voice-activated tracker announcing collected items.' },
          { name: 'Voice-activated fork of Chaz HUD', description: 'Tracker voice-activated pour annoncer les items.' },
          { name: 'Fork de Chaz HUD con voz', description: 'Tracker activado por voz para anunciar los objetos recogidos.' },
          { name: 'Sprachgesteuerter Fork von Chaz HUD', description: 'Sprachgesteuerter Tracker, der gesammelte Items ansagt.' },
          { name: 'Fork vocale di Chaz HUD', description: 'Tracker con attivazione vocale che annuncia gli oggetti raccolti.' },
          { name: 'Fork do Chaz HUD com voz', description: 'Tracker com ativação por voz para anunciar os itens coletados.' }
        ),
        source: 'manual'
      },
      {
        name: 'Printable Tracker',
        url: 'https://drive.google.com/file/d/1nA4K_TlIRhwo59dqZaWuk084MMjg2KSw',
        description: 'Printable paper tracker version.',
        translations: translations(
          { name: 'Printable Tracker', description: 'Printable paper tracker version.' },
          { name: 'Printable Tracker', description: 'Version papier imprimable.' },
          { name: 'Tracker imprimible', description: 'Versión en papel imprimible del tracker.' },
          { name: 'Druckbarer Tracker', description: 'Druckbare Papier-Version des Trackers.' },
          { name: 'Tracker stampabile', description: 'Versione cartacea stampabile del tracker.' },
          { name: 'Tracker imprimível', description: 'Versão em papel imprimível do tracker.' }
        ),
        source: 'manual'
      },
      {
        name: "Orphis' Entrance Tracker",
        url: 'https://orphis.github.io/alttp_entrance_randomizer_tracker/',
        description: 'Entrance tracker (in development).',
        translations: translations(
          { name: "Orphis' Entrance Tracker", description: 'Entrance tracker (in development).' },
          { name: "Orphis' Entrance Tracker", description: 'Tracker Entrance (en développement).' },
          { name: 'Tracker de Entrances de Orphis', description: 'Tracker de entrances (en desarrollo).' },
          { name: 'Orphis’ Entrance-Tracker', description: 'Entrance-Tracker (in Entwicklung).' },
          { name: 'Entrance Tracker di Orphis', description: 'Tracker entrance (in sviluppo).' },
          { name: 'Tracker de Entrances do Orphis', description: 'Tracker de entrances (em desenvolvimento).' }
        ),
        source: 'manual'
      },
      {
        name: 'Entrando',
        url: 'https://github.com/telethar/Entrando',
        description: 'Downloadable entrance tracker with note support.',
        translations: translations(
          { name: 'Entrando', description: 'Downloadable entrance tracker with note support.' },
          { name: 'Entrando', description: 'Tracker Entrance téléchargeable avec notes.' },
          { name: 'Entrando', description: 'Tracker de entrances descargable con soporte de notas.' },
          { name: 'Entrando', description: 'Herunterladbarer Entrance-Tracker mit Notizfunktion.' },
          { name: 'Entrando', description: 'Tracker entrance scaricabile con supporto note.' },
          { name: 'Entrando', description: 'Tracker de entrances baixável com suporte a anotações.' }
        ),
        source: 'manual'
      }
    ];

    const guides = [
      {
        name: 'Common things that stump newcomers',
        url: 'https://docs.google.com/document/d/1eOabgvHCKqncO9JzZQR6T-b6yuTtAOuu3INZyOIRupM/edit?tab=t.0#heading=h.3r5cbtzb9jed',
        description: 'Good first read for new players.',
        translations: translations(
          { name: 'Common things that stump newcomers', description: 'Good first read for new players.' },
          { name: 'Points fréquents qui bloquent les nouveaux', description: 'Bonne première lecture pour les nouveaux joueurs.' },
          { name: 'Cosas comunes que confunden a principiantes', description: 'Buena primera lectura para jugadores nuevos.' },
          { name: 'Häufige Stolpersteine für Neueinsteiger', description: 'Gute erste Lektüre für neue Spieler.' },
          { name: 'Problemi comuni per i nuovi giocatori', description: 'Buona prima lettura per i nuovi giocatori.' },
          { name: 'Dúvidas comuns de iniciantes', description: 'Boa primeira leitura para novos jogadores.' }
        ),
        type: 'guide',
        source: 'manual'
      },
      {
        name: 'ALttPR Guides & Documentation',
        url: 'https://docs.google.com/document/d/1UsGmZ-1L5gCceUPSewlfLZ7zaGprnjJCIaxxMiKqheY/edit?tab=t.0#heading=h.w96dxmxv4uno',
        description: 'Detailed documentation and advanced resources.',
        translations: translations(
          { name: 'ALttPR Guides & Documentation', description: 'Detailed documentation and advanced resources.' },
          { name: 'Guides & Documentation ALttPR', description: 'Documentation détaillée et ressources avancées.' },
          { name: 'Guías y documentación de ALttPR', description: 'Documentación detallada y recursos avanzados.' },
          { name: 'ALttPR Leitfäden & Dokumentation', description: 'Detaillierte Dokumentation und fortgeschrittene Ressourcen.' },
          { name: 'Guide e documentazione ALttPR', description: 'Documentazione dettagliata e risorse avanzate.' },
          { name: 'Guias e documentação ALttPR', description: 'Documentação detalhada e recursos avançados.' }
        ),
        type: 'guide',
        source: 'manual'
      },
      {
        name: 'ALTTP Glitches Overview',
        url: 'https://docs.google.com/document/d/1RTJ0oVPioSaEr_S_Ya49z1xZfHz168IcOinfP-BGaZ8/edit?tab=t.0',
        description: 'Overview of useful glitches.',
        translations: translations(
          { name: 'ALTTP Glitches Overview', description: 'Overview of useful glitches.' },
          { name: 'Aperçu des glitches ALTTP', description: 'Vue d’ensemble des glitches utiles.' },
          { name: 'Resumen de glitches de ALTTP', description: 'Resumen de glitches útiles.' },
          { name: 'ALTTP Glitches Überblick', description: 'Überblick über nützliche Glitches.' },
          { name: 'Panoramica dei glitch di ALTTP', description: 'Panoramica dei glitch utili.' },
          { name: 'Visão geral de glitches de ALTTP', description: 'Visão geral dos glitches úteis.' }
        ),
        type: 'guide',
        source: 'manual'
      }
    ];

    const other = [
      {
        name: 'ALTTP Randomizer (Official Discord)',
        url: 'https://discord.gg/alttprandomizer',
        description: 'Official ALttPR Discord server.',
        translations: translations(
          { name: 'ALTTP Randomizer (Official Discord)', description: 'Official ALttPR Discord server.' },
          { name: 'ALTTP Randomizer (Discord officiel)', description: 'Serveur Discord officiel ALttPR.' },
          { name: 'ALTTP Randomizer (Discord oficial)', description: 'Servidor oficial de Discord de ALttPR.' },
          { name: 'ALTTP Randomizer (Offizielles Discord)', description: 'Offizieller ALttPR-Discord-Server.' },
          { name: 'ALTTP Randomizer (Discord ufficiale)', description: 'Server Discord ufficiale di ALttPR.' },
          { name: 'ALTTP Randomizer (Discord oficial)', description: 'Servidor oficial do Discord do ALttPR.' }
        ),
        type: 'discord',
        source: 'manual'
      },
      {
        name: 'French ALttPR Community',
        url: 'https://discord.gg/wSM8KGVqh9',
        description: 'French ALttPR Discord community.',
        translations: translations(
          { name: 'French ALttPR Community', description: 'French ALttPR Discord community.' },
          { name: 'Communauté ALttPR francophone', description: 'Discord FR ALttPR.' },
          { name: 'Comunidad ALttPR francófona', description: 'Comunidad de Discord ALttPR en francés.' },
          { name: 'Französische ALttPR-Community', description: 'Französische ALttPR-Discord-Community.' },
          { name: 'Comunità ALttPR francofona', description: 'Comunità Discord ALttPR in francese.' },
          { name: 'Comunidade ALttPR francófona', description: 'Comunidade Discord ALttPR em francês.' }
        ),
        type: 'discord',
        source: 'manual'
      },
      {
        name: 'Generate an ALttPR Seed',
        url: 'https://alttpr.com/en/randomizer',
        description: 'Create an ALttPR seed.',
        translations: translations(
          { name: 'Generate an ALttPR Seed', description: 'Create an ALttPR seed.' },
          { name: 'Générer une seed ALttPR', description: 'Création de seed ALttPR.' },
          { name: 'Generar una seed de ALttPR', description: 'Crear una seed de ALttPR.' },
          { name: 'ALttPR-Seed generieren', description: 'Erstelle eine ALttPR-Seed.' },
          { name: 'Genera una seed ALttPR', description: 'Crea una seed ALttPR.' },
          { name: 'Gerar seed de ALttPR', description: 'Criar uma seed de ALttPR.' }
        ),
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
