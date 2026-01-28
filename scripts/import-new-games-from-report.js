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

  const resources = {
    sites: (entry.randomizers || []).map(r => ({
      url: r.url || null,
      name: r.name || r.url || 'Source',
      source: 'rando-list',
      isArchipelago: !!r.isArchipelago
    })),
    officialSite: null
  };

  if (resources.sites.length === 1) {
    resources.officialSite = {
      url: resources.sites[0].url,
      name: resources.sites[0].name,
      isArchipelago: resources.sites[0].isArchipelago
    };
  }

  const primaryRandomizer = (entry.randomizers && entry.randomizers[0]) || {};

  return {
    id,
    name: entry.originalName,
    displayName,
    officialName: entry.originalName,
    enabled: true,
    randomizer: {
      name: entry.randomizerName || (entry.originalName + ' Randomizer'),
      shortName: entry.randomizerShortName || (entry.suggestedId || id).toUpperCase() + ' Randomizer',
      tinyName: entry.randomizerTinyName || (entry.suggestedId || id).toUpperCase(),
      opensource: !!primaryRandomizer.opensource
    },
    resources,
    integrations: {
      randoList: {
        enabled: true,
        gameName: entry.originalName,
        confidence: 'manual',
        lastSync: new Date()
      },
      racetime: {
        enabled: false,
        gameSlug: null,
        confidence: 'manual'
      }
    },
    source: {
      origin: 'rando-list',
      createdAt: new Date(),
      autoCreated: true
    }
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
  for (const entry of toImport) {
    const doc = buildGameDocument(entry);
    try {
      const exists = await Game.findOne({ id: doc.id });
      if (exists) {
        console.log(`Skipping ${doc.id} — already exists`);
        continue;
      }
      const g = new Game(doc);
      await g.save();
      console.log(`Created: ${doc.id} -> ${doc.displayName}`);
      created.push(doc.id);
    } catch (err) {
      console.error(`Error creating ${doc.id}:`, err.message);
    }
  }

  await mongoose.disconnect();
  console.log(`\nDone. ${created.length} game(s) created.`);
}

main().catch(e => { console.error(e); process.exit(1); });
