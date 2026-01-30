#!/usr/bin/env node
/**
 * Importer des jeux depuis le rapport généré par sync-rando-list-v3.js
 *
 * Usage:
 *   node scripts/import-new-games-from-report.js            # dry-run (no DB changes)
 *   node scripts/import-new-games-from-report.js --apply   # apply changes to DB
 *   node scripts/import-new-games-from-report.js --ids id1,id2  # dry-run specific ids
 *   node scripts/import-new-games-from-report.js --report path/to/report.json
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const connectDB = require('../config/database');
const { Game } = require('../models');

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const idsIndex = argv.indexOf('--ids');
const idsFilter = idsIndex > -1 && argv[idsIndex + 1] ? argv[idsIndex + 1].split(',').map(s => s.trim()) : null;
const reportIndex = argv.indexOf('--report');
const reportPath = reportIndex > -1 && argv[reportIndex + 1]
  ? argv[reportIndex + 1]
  : path.join(__dirname, 'tmp', 'new-games-report.json');

async function loadReport(p) {
  if (!fs.existsSync(p)) throw new Error(`Report not found: ${p}`);
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

function buildGameDocument(entry) {
  const id = (entry.id || entry.suggestedId || generateSafeId(entry.originalName)).toLowerCase();
  const displayName = entry.displayName || entry.originalName;

  // Map randomizers to resources.sites
  const resources = {
    sites: (entry.randomizers || []).map((r, index) => ({
      url: r.url || null,
      name: r.name || r.url || 'Source',
      source: 'rando-list',
      isArchipelago: !!r.isArchipelago,
      isObsolete: false
    })),
    officialSite: null,
    trackers: [],
    guides: [],
    other: []
  };

  // Déterminer le site officiel principal (soit isMain=true, soit le premier)
  const mainRandomizer = (entry.randomizers || []).find(r => r.isMain) || (entry.randomizers && entry.randomizers[0]);
  if (mainRandomizer) {
    resources.officialSite = {
      url: mainRandomizer.url,
      name: mainRandomizer.name || mainRandomizer.url,
      isArchipelago: !!mainRandomizer.isArchipelago
    };
  }

  const primaryRandomizer = mainRandomizer || {};

  return {
    id,
    name: displayName, // Le nom affiché
    official: {
      name: entry.originalName, // Le nom original complet
      releaseYear: null, // À remplir manuellement plus tard
      website: null
    },
    randomizer: {
      name: entry.randomizerName || (entry.originalName + ' Randomizer'),
      displayName: entry.randomizerName || (entry.originalName + ' Randomizer'),
      shortName: entry.randomizerShortName || (entry.suggestedId || id).toUpperCase() + ' Randomizer',
      tinyName: entry.randomizerTinyName || (entry.suggestedId || id).toUpperCase(),
      website: mainRandomizer?.url || null,
      opensource: !!primaryRandomizer.opensource,
      addedDate: new Date()
    },
    resources,
    platforms: entry.platforms || [],
    series: entry.series || null,
    categories: [], // À remplir via l'admin
    integrations: {
      randoList: {
        enabled: true,
        seriesFile: entry.series ? `${entry.series.replace(/\s+/g, '_')}.yml` : null,
        gameName: entry.originalName,
        randomizerIdentifier: null,
        confidence: 'auto',
        lastSync: new Date()
      },
      racetime: {
        enabled: false,
        gameSlug: null,
        gameName: null,
        confidence: 'manual'
      },
      speedrun: {
        enabled: false,
        gameId: null,
        weblink: null,
        confidence: 'manual'
      }
    },
    source: {
      origin: 'rando-list',
      importedAt: new Date()
    },
    enabled: true
  };
}

function generateSafeId(name) {
  return name.toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

async function main() {
  console.log('\nImport script for new-games report');
  let report;
  try {
    report = await loadReport(reportPath);
  } catch (e) {
    console.error('Failed to load report:', e.message);
    process.exit(1);
  }

  const games = report.games || [];
  let toImport = games;
  if (idsFilter) {
    toImport = games.filter(g => idsFilter.includes(g.id) || idsFilter.includes(g.suggestedId));
  }

  if (toImport.length === 0) {
    console.log('No games selected to import. Exiting.');
    process.exit(0);
  }

  console.log(`\nFound ${toImport.length} game(s) to import from ${reportPath}`);

  if (!apply) {
    console.log('\n-- DRY RUN --\nThe following games would be created:');
    toImport.forEach(g => {
      const id = (g.id || g.suggestedId || generateSafeId(g.originalName)).toLowerCase();
      console.log(` - ${id}: ${g.displayName || g.originalName} (suggestedId: ${g.suggestedId})`);
    });
    console.log('\nRun with --apply to actually create the games in the DB.');
    process.exit(0);
  }

  // Apply changes
  await connectDB();

  const created = [];
  const updated = [];
  
  for (const entry of toImport) {
    const doc = buildGameDocument(entry);
    try {
      const exists = await Game.findOne({ id: doc.id });
      
      if (exists) {
        // Mettre à jour le jeu existant avec les nouvelles informations
        console.log(`Updating ${doc.id} — already exists, merging data...`);
        
        // Fusionner les sites (éviter les doublons d'URL)
        const existingSiteUrls = new Set(exists.resources?.sites?.map(s => s.url) || []);
        const newSites = (doc.resources?.sites || []).filter(s => !existingSiteUrls.has(s.url));
        
        if (newSites.length > 0) {
          exists.resources = exists.resources || {};
          exists.resources.sites = [...(exists.resources.sites || []), ...newSites];
          console.log(`  → Added ${newSites.length} new randomizer site(s)`);
        }
        
        // Mettre à jour le site officiel si pas déjà défini
        if (!exists.resources?.officialSite && doc.resources?.officialSite) {
          exists.resources.officialSite = doc.resources.officialSite;
          console.log(`  → Set official site`);
        }
        
        // Mettre à jour les informations du randomizer si manquantes
        if (!exists.randomizer?.name && doc.randomizer?.name) {
          exists.randomizer = exists.randomizer || {};
          exists.randomizer.name = doc.randomizer.name;
        }
        if (!exists.randomizer?.shortName && doc.randomizer?.shortName) {
          exists.randomizer = exists.randomizer || {};
          exists.randomizer.shortName = doc.randomizer.shortName;
        }
        if (!exists.randomizer?.tinyName && doc.randomizer?.tinyName) {
          exists.randomizer = exists.randomizer || {};
          exists.randomizer.tinyName = doc.randomizer.tinyName;
        }
        
        // Mettre à jour les platforms si manquantes
        if (doc.platforms && doc.platforms.length > 0 && (!exists.platforms || exists.platforms.length === 0)) {
          exists.platforms = doc.platforms;
          console.log(`  → Added platforms: ${doc.platforms.join(', ')}`);
        }
        
        // Mettre à jour la série si manquante
        if (doc.series && !exists.series) {
          exists.series = doc.series;
          console.log(`  → Added series: ${doc.series}`);
        }
        
        // Mettre à jour l'intégration rando-list
        if (!exists.integrations?.randoList?.enabled) {
          exists.integrations = exists.integrations || {};
          exists.integrations.randoList = doc.integrations.randoList;
          console.log(`  → Enabled rando-list integration`);
        } else {
          exists.integrations.randoList.lastSync = new Date();
        }
        
        // Sauvegarder les modifications
        await exists.save();
        updated.push(doc.id);
        
      } else {
        // Créer un nouveau jeu
        const g = new Game(doc);
        await g.save();
        console.log(`Created: ${doc.id} → ${doc.name}`);
        created.push(doc.id);
      }
      
    } catch (err) {
      console.error(`Error processing ${doc.id}:`, err.message);
    }
  }

  await mongoose.disconnect();
  console.log(`\n✅ Done!`);
  console.log(`   - ${created.length} game(s) created`);
  console.log(`   - ${updated.length} game(s) updated`);
}

main().catch(e => { console.error(e); process.exit(1); });
