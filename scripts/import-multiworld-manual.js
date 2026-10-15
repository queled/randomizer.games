#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const connectDB = require('../config/database');
const { Game } = require('../models');

const ARCHIPELAGO = 'Archipelago';
const MULTIWORLD = 'Multiworld';

function buildSiteUrl(siteName, gameName) {
  const encodedName = encodeURIComponent(gameName);
  if (siteName === ARCHIPELAGO) {
    return `https://archipelago.gg/games/${encodedName}/info/en`;
  }
  return `https://multiworld.gg/games/${encodedName}/info/en`;
}

function parseSiteFlags(rawSite = '') {
  const normalized = rawSite.toLowerCase();
  return {
    hasArchipelago: normalized.includes('archipelago'),
    hasMultiworld: normalized.includes('multiworld')
  };
}

function parseEntries(markdown) {
  const lines = markdown.split(/\r?\n/);
  const entries = [];
  let pendingName = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const idMatch = line.match(/^id\s*:\s*(.+)$/i);
    const siteMatch = line.match(/^(site|source)\s*:\s*(.+)$/i);

    if (idMatch) {
      if (!pendingName) continue;
      const id = idMatch[1].trim().toLowerCase();
      entries.push({ name: pendingName, id, siteRaw: '' });
      continue;
    }

    if (siteMatch) {
      if (entries.length === 0) continue;
      entries[entries.length - 1].siteRaw = siteMatch[2].trim();
      continue;
    }

    if (line.endsWith(':')) {
      pendingName = line.slice(0, -1).trim();
      continue;
    }

    pendingName = line.trim();
  }

  return entries;
}

function mergeSites(existingSites = [], incomingSites = []) {
  const byUrl = new Map();

  for (const site of existingSites) {
    if (!site?.url) continue;
    byUrl.set(site.url, {
      url: site.url,
      name: site.name,
      description: site.description,
      source: site.source || 'manual',
      isArchipelago: !!site.isArchipelago,
      isMultiworld: !!site.isMultiworld,
      isObsolete: !!site.isObsolete
    });
  }

  for (const site of incomingSites) {
    byUrl.set(site.url, site);
  }

  return Array.from(byUrl.values());
}

function buildResources(entry) {
  const { hasArchipelago, hasMultiworld } = parseSiteFlags(entry.siteRaw || '');
  const sites = [];

  if (hasArchipelago) {
    sites.push({
      url: buildSiteUrl(ARCHIPELAGO, entry.name),
      name: ARCHIPELAGO,
      source: 'manual',
      isArchipelago: true,
      isMultiworld: false,
      isObsolete: false
    });
  }

  if (hasMultiworld) {
    sites.push({
      url: buildSiteUrl(MULTIWORLD, entry.name),
      name: MULTIWORLD,
      source: 'manual',
      isArchipelago: false,
      isMultiworld: true,
      isObsolete: false
    });
  }

  let officialSite = null;
  if (hasArchipelago) {
    officialSite = {
      url: buildSiteUrl(ARCHIPELAGO, entry.name),
      name: ARCHIPELAGO,
      isArchipelago: true,
      isMultiworld: false
    };
  } else if (hasMultiworld) {
    officialSite = {
      url: buildSiteUrl(MULTIWORLD, entry.name),
      name: MULTIWORLD,
      isArchipelago: false,
      isMultiworld: true
    };
  }

  return { sites, officialSite };
}

async function upsertGames(entries, apply = false) {
  const stats = {
    parsed: entries.length,
    created: 0,
    updated: 0,
    skippedInvalid: [],
    skippedDuplicateId: []
  };

  const seenById = new Map();
  const normalizedEntries = [];

  for (const entry of entries) {
    if (!entry.id || !entry.name || !entry.siteRaw) {
      stats.skippedInvalid.push(entry);
      continue;
    }

    const previous = seenById.get(entry.id);
    if (previous && previous.name.toLowerCase() !== entry.name.toLowerCase()) {
      stats.skippedDuplicateId.push({
        id: entry.id,
        firstName: previous.name,
        secondName: entry.name
      });
      continue;
    }

    if (!previous) {
      seenById.set(entry.id, entry);
      normalizedEntries.push(entry);
    }
  }

  for (const entry of normalizedEntries) {
    const resources = buildResources(entry);
    if (!resources.officialSite) {
      stats.skippedInvalid.push(entry);
      continue;
    }

    const existing = await Game.findOne({ id: entry.id });

    if (!apply) {
      if (existing) stats.updated += 1;
      else stats.created += 1;
      continue;
    }

    if (existing) {
      existing.resources = existing.resources || {};
      existing.resources.sites = mergeSites(existing.resources.sites || [], resources.sites);
      existing.resources.officialSite = resources.officialSite;

      if (!existing.name) existing.name = entry.name;
      if (!existing.official) existing.official = {};
      if (!existing.official.name) existing.official.name = entry.name;
      if (!existing.source) existing.source = {};
      if (!existing.source.origin) existing.source.origin = 'manual';
      if (!existing.source.importedAt) existing.source.importedAt = new Date();

      await existing.save();
      stats.updated += 1;
    } else {
      await Game.create({
        id: entry.id,
        name: entry.name,
        official: {
          name: entry.name
        },
        randomizer: {
          displayName: `${entry.name} Randomizer`,
          shortName: `${entry.id.toUpperCase()} Randomizer`,
          tinyName: entry.id.toUpperCase(),
          name: `${entry.name} Randomizer`,
          website: resources.officialSite.url,
          opensource: null
        },
        resources: {
          officialSite: resources.officialSite,
          sites: resources.sites,
          trackers: [],
          guides: [],
          other: []
        },
        source: {
          origin: 'manual',
          importedAt: new Date()
        },
        enabled: true,
        categories: []
      });
      stats.created += 1;
    }
  }

  return stats;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const fileArg = args.find(a => !a.startsWith('--')) || path.join(process.env.HOME || '', 'Desktop', 'multiworld.md');

  if (!fs.existsSync(fileArg)) {
    console.error(`❌ Fichier introuvable: ${fileArg}`);
    process.exit(1);
  }

  const markdown = fs.readFileSync(fileArg, 'utf8');
  const entries = parseEntries(markdown);

  console.log(`📄 Fichier: ${fileArg}`);
  console.log(`📦 Entrées détectées: ${entries.length}`);
  if (!apply) {
    console.log('ℹ️ Mode dry-run (ajouter --apply pour écrire en base)');
  }

  await connectDB();
  const stats = await upsertGames(entries, apply);
  await mongoose.disconnect();

  console.log('\n=== Résumé ===');
  console.log(`Créés: ${stats.created}`);
  console.log(`Mis à jour: ${stats.updated}`);
  console.log(`Ignorés (invalides): ${stats.skippedInvalid.length}`);
  console.log(`Ignorés (ID dupliqué): ${stats.skippedDuplicateId.length}`);

  if (stats.skippedInvalid.length > 0) {
    console.log('\nEntrées invalides:');
    for (const item of stats.skippedInvalid) {
      console.log(`- name="${item.name || ''}" id="${item.id || ''}" site="${item.siteRaw || ''}"`);
    }
  }

  if (stats.skippedDuplicateId.length > 0) {
    console.log('\nConflits ID dupliqué:');
    for (const item of stats.skippedDuplicateId) {
      console.log(`- id="${item.id}" : "${item.firstName}" vs "${item.secondName}"`);
    }
  }
}

main().catch(error => {
  console.error('❌ Erreur import:', error.message);
  process.exit(1);
});
