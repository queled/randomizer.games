#!/usr/bin/env node
/**
 * Sync the games of archipelago.gg and multiworld.gg
 *
 * Both sites list the Archipelago worlds they host (services/archipelago.js).
 * Each world is tied to a game of the site, looked up in this order:
 *   1. integrations.archipelago / integrations.multiworld .gameName, kept from
 *      the previous runs (or set by hand, confidence "manual");
 *   2. OVERRIDES below, for names the next steps get wrong;
 *   3. on multiworld.gg, the game of the archipelago.gg world of the same name;
 *   4. the archipelago.gg / multiworld.gg links the game already has
 *      (rando-list, former manual import);
 *   5. the game's names (site, official, randomizer, rando-list, Twitch), then
 *      the part after the colon ("Series: Subtitle").
 * A world no game matches becomes a new game (id built from its name, then
 * Twitch category and release year looked up). A name several games match is
 * listed and left alone.
 *
 * The sync owns, on each game, the links it adds (source "archipelago"): the
 * game page on each site, the setup guide (archipelago.gg's when it has the
 * world) and the wiki (checked on the wiki itself: the sites' links sometimes
 * name pages that don't exist). It drops the game pages of the former manual import,
 * replaced by its own, and the links of a world that left a site. When the
 * official site was an Archipelago / Multiworld link, it points to the game's
 * page. A site whose page cannot be read is left as it is.
 *
 * Usage:
 *   node scripts/sync-archipelago-games.js
 *   node scripts/sync-archipelago-games.js --dry-run
 *   node scripts/sync-archipelago-games.js --no-create     # don't create games
 *   node scripts/sync-archipelago-games.js --site multiworld
 *   node scripts/sync-archipelago-games.js --verbose       # every world and its game
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const connectDB = require('../config/database');
const { Game } = require('../models');
const { SITES, fetchGames, resolveWikiLinks } = require('../services/archipelago');
const { norm, withoutBrackets, subtitle, mainTitle, gameNames, pickCandidate, newGameId, randomizerShortNames, runEnrichment } = require('../services/game-names');

const SOURCE = 'archipelago';
const SITE_HOST_RE = /^https?:\/\/(?:www\.)?(archipelago|multiworld)\.gg(?:\/|$)/i;
const GAME_PAGE_RE = /^https?:\/\/(?:www\.)?(archipelago|multiworld)\.gg\/games\/([^/]+)\//i;

// World name → game id (or ids, for a world of several games of the site), null
// for a game of its own (created) where the names or the former links point to
// another game, false for a variant of a world already tied to the game
const SHARED_OVERRIDES = {
  'Muse Dash': null,
  'Lufia II Ancient Cave': 'l2ac',
  'Kingdom Hearts': 'khfm',
  'Sonic Adventure 2 Battle': 'sa2',
  'Yu-Gi-Oh! 2006': 'ygoumw2006',
  'DELTARUNE': 'deltarune'
};
const OVERRIDES = {
  archipelago: { ...SHARED_OVERRIDES },
  multiworld: {
    ...SHARED_OVERRIDES,
    'Digimon World': null,
    'Cat Quest': null,
    "Luigi's Mansion": 'lm',
    "Majora's Mask Recompiled": 'mm',
    'Final Fantasy IV Free Enterprise': 'ff4',
    'Pokemon FireRed and LeafGreen': 'pkmnfl',
    'Quake 1': 'quake',
    'Metroid Fusion': 'mf',
    'Xenoblade X': 'xcx',
    // Variant worlds, beside the base game's
    'The Legend of Zelda: A Link to the Past': false,
    'Super Metroid Map Rando': false,
    'SM64 Romhack': false
  }
};

function parseArgs() {
  const args = process.argv.slice(2);
  const siteIndex = args.indexOf('--site');
  const site = siteIndex !== -1 ? args[siteIndex + 1] : null;
  if (site && !SITES[site]) {
    console.error(`--site : ${Object.keys(SITES).join(' ou ')}`);
    process.exit(2);
  }
  return {
    dryRun: args.includes('--dry-run'),
    create: !args.includes('--no-create'),
    enrich: !args.includes('--no-enrich'),
    verbose: args.includes('--verbose'),
    sites: site ? [site] : Object.keys(SITES)
  };
}

const worldNames = world => [...new Set([world.name, world.displayName, withoutBrackets(world.name), withoutBrackets(world.displayName)])];

// World name of an archipelago.gg / multiworld.gg link: game page or setup guide anchor
function linkedWorld(url) {
  const page = String(url || '').match(GAME_PAGE_RE);
  if (page) return { site: page[1].toLowerCase(), name: safeDecode(page[2]) };
  const guide = String(url || '').match(/^https?:\/\/(?:www\.)?(archipelago|multiworld)\.gg\/tutorial\/?#(.+)$/i);
  if (guide) return { site: guide[1].toLowerCase(), name: safeDecode(guide[2]) };
  return null;
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function buildIndexes(games) {
  const byId = new Map(games.map(g => [g.id, g]));
  const strong = new Map();
  const weak = new Map();
  const linked = { archipelago: new Map(), multiworld: new Map() };
  const add = (map, key, game) => {
    if (!key) return;
    const set = map.get(key) || new Set();
    set.add(game);
    map.set(key, set);
  };
  for (const game of games) {
    for (const name of gameNames(game)) {
      add(strong, norm(name), game);
      // Looser forms: subtitle, main title, without brackets nor "Version"
      for (const loose of [subtitle(name), mainTitle(name), withoutBrackets(name), String(name).replace(/\s+version$/i, '')]) {
        if (loose && norm(loose) !== norm(name)) add(weak, norm(loose), game);
      }
    }
    add(weak, norm(game.id), game);
    for (const site of game.resources?.sites || []) {
      const world = linkedWorld(site.url);
      if (world) add(linked[world.site], norm(world.name), game);
    }
  }
  return { byId, strong, weak, linked };
}

// Games of a world: { games } (several for some overrides), else why none
function matchWorld(world, siteKey, indexes, apMatches) {
  const names = worldNames(world);
  const override = OVERRIDES[siteKey]?.[world.name];
  if (override === false) return { games: [], how: 'variant', skip: true };
  if (override === null) return { games: [], how: 'override' };
  if (override) {
    const games = [].concat(override).map(id => indexes.byId.get(id)).filter(Boolean);
    return { games, how: 'override', skip: !games.length };
  }

  if (siteKey === 'multiworld') {
    for (const name of names) {
      const game = apMatches.get(norm(name));
      if (game) return { games: [game], how: 'archipelago' };
    }
  }

  for (const [how, index, keyOf] of [
    ['link', indexes.linked[siteKey], norm],
    ['name', indexes.strong, norm],
    ['subtitle', indexes.weak, norm],
    ['subtitle', indexes.strong, n => norm(subtitle(n))]
  ]) {
    const candidates = new Set();
    for (const name of names) {
      for (const game of index.get(keyOf(name)) || []) candidates.add(game);
    }
    if (!candidates.size) continue;
    const { game, ambiguous } = pickCandidate(candidates, names);
    if (game) return { games: [game], how };
    return { games: [], how, ambiguous };
  }
  return { games: [], how: 'none' };
}

/**
 * Worlds of a site tied to games: the games already tied first (they keep
 * their world), then the others. A game takes one world per site.
 */
function matchSite(siteKey, worlds, games, indexes, apMatches) {
  const matches = new Map(); // world name → games
  const claimed = new Map(); // game id → world name
  const report = { ambiguous: [], conflicts: [], unmatched: [], hows: {} };
  const worldByName = new Map(worlds.map(w => [w.name, w]));

  for (const game of games) {
    const name = game.integrations?.[siteKey]?.gameName;
    if (!name || !worldByName.has(name) || claimed.has(game.id)) continue;
    if (!game.integrations[siteKey].enabled && game.integrations[siteKey].confidence !== 'manual') continue;
    matches.set(name, [...(matches.get(name) || []), game]);
    claimed.set(game.id, name);
  }
  if (matches.size) report.hows.kept = matches.size;

  for (const world of worlds) {
    if (matches.has(world.name)) continue;
    const { games: found, how, ambiguous, skip } = matchWorld(world, siteKey, indexes, apMatches);
    if (ambiguous) {
      report.ambiguous.push({ world: world.name, candidates: ambiguous });
      continue;
    }
    if (skip) continue;
    if (!found.length) {
      report.unmatched.push(world);
      continue;
    }
    const free = found.filter(game => !claimed.has(game.id));
    for (const game of found.filter(g => claimed.has(g.id))) {
      report.conflicts.push({ world: world.name, game: game.id, takenBy: claimed.get(game.id) });
    }
    if (!free.length) continue;
    matches.set(world.name, free);
    for (const game of free) claimed.set(game.id, world.name);
    report.hows[how] = (report.hows[how] || 0) + 1;
  }
  return { matches, report };
}

function siteLink(siteKey, world) {
  return {
    url: world.gamePage,
    name: SITES[siteKey].label,
    source: SOURCE,
    isArchipelago: siteKey === 'archipelago',
    isMultiworld: siteKey === 'multiworld',
    isObsolete: false
  };
}

function guideLinks(worldsBySite) {
  const guides = [];
  const setup = worldsBySite.archipelago?.setupGuide ? ['archipelago', worldsBySite.archipelago]
    : worldsBySite.multiworld?.setupGuide ? ['multiworld', worldsBySite.multiworld] : null;
  if (setup) {
    const label = SITES[setup[0]].label;
    guides.push({
      url: setup[1].setupGuide,
      name: `${label} setup guide`,
      translations: { fr: { name: `Guide d’installation ${label}` } },
      type: 'tutorial',
      source: SOURCE
    });
  }
  const wiki = worldsBySite.multiworld?.wiki || worldsBySite.archipelago?.wiki;
  if (wiki) {
    guides.push({
      url: wiki,
      name: 'Archipelago Wiki',
      translations: { fr: { name: 'Wiki Archipelago' } },
      type: 'wiki',
      source: SOURCE
    });
  }
  return guides;
}

const hostOf = url => (String(url || '').match(SITE_HOST_RE) || [])[1]?.toLowerCase() || null;
const strip = list => JSON.stringify((list || []).map(({ _id, ...rest }) => rest));

/**
 * New resources and integrations of a game from its worlds. worldsBySite
 * holds the world of each site read (null: not on it); sites not read keep
 * their links.
 */
function planGame(game, worldsBySite, fetchedSites, now) {
  const resources = game.resources || {};
  const fetched = new Set(fetchedSites);
  const ownedHere = item => fetched.has(hostOf(item.url)) &&
    (item.source === SOURCE || (item.source === 'manual' && GAME_PAGE_RE.test(item.url)));

  const sites = (resources.sites || []).filter(site => !ownedHere(site));
  for (const siteKey of fetchedSites) {
    const world = worldsBySite[siteKey];
    if (world && !sites.some(site => site.url === world.gamePage)) sites.push(siteLink(siteKey, world));
  }

  // Worlds of the sites not read: those the game had
  const known = { ...worldsBySite };
  for (const siteKey of Object.keys(SITES)) {
    if (fetched.has(siteKey)) continue;
    const page = (resources.sites || []).find(site => site.source === SOURCE && hostOf(site.url) === siteKey);
    const guide = (resources.guides || []).find(g => g.source === SOURCE && g.type === 'tutorial' && hostOf(g.url) === siteKey);
    known[siteKey] = page ? { gamePage: page.url, setupGuide: guide?.url } : null;
  }
  const otherGuides = (resources.guides || []).filter(g => g.source !== SOURCE);
  const guides = [
    ...otherGuides,
    ...guideLinks(known).filter(g => !otherGuides.some(o => o.url === g.url))
  ];

  // Official site: the game's Archipelago page when it was an Archipelago / Multiworld link
  const ownSite = ['archipelago', 'multiworld'].find(siteKey => known[siteKey]?.gamePage);
  const ownPage = ownSite && {
    url: known[ownSite].gamePage,
    name: SITES[ownSite].label,
    isArchipelago: ownSite === 'archipelago',
    isMultiworld: ownSite === 'multiworld'
  };
  let officialSite = resources.officialSite?.url ? resources.officialSite : null;
  if (officialSite && hostOf(officialSite.url)) {
    // A generic Archipelago link (rando-list) stays while the game has no page of its own
    officialSite = ownPage || (GAME_PAGE_RE.test(officialSite.url) ? null : officialSite);
  } else if (!officialSite && ownPage) {
    // No other site to show first
    const website = game.randomizer?.website;
    const others = sites.filter(site => !site.isObsolete && !hostOf(site.url));
    if (!others.length && (!website || hostOf(website))) officialSite = ownPage;
  }

  const set = {};
  const unset = {};
  if (strip(sites) !== strip(resources.sites)) set['resources.sites'] = sites;
  if (strip(guides) !== strip(resources.guides)) set['resources.guides'] = guides;
  const oldOfficial = resources.officialSite?.url ? resources.officialSite : null;
  if (JSON.stringify(officialSite) !== JSON.stringify(oldOfficial)) {
    if (officialSite) set['resources.officialSite'] = officialSite;
    else unset['resources.officialSite'] = '';
  }

  for (const siteKey of fetchedSites) {
    const world = worldsBySite[siteKey];
    const old = game.integrations?.[siteKey] || {};
    if (!world && !old.enabled) continue;
    const next = {
      enabled: !!world,
      gameName: world ? world.name : old.gameName,
      confidence: old.gameName && old.confidence === 'manual' ? 'manual' : 'auto'
    };
    if (next.enabled !== !!old.enabled || next.gameName !== old.gameName || next.confidence !== old.confidence) {
      set[`integrations.${siteKey}`] = { ...next, lastSync: now };
    } else if (Object.keys(set).length) {
      set[`integrations.${siteKey}.lastSync`] = now;
    }
  }
  return { set, unset };
}

// multiworld.gg's display name, without "(Beta)", "(Rogue)"…
function newGameName(worldsBySite) {
  const world = worldsBySite.multiworld || worldsBySite.archipelago;
  return withoutBrackets(world.displayName) || world.name;
}

function newGameDoc(id, worldsBySite, now) {
  const world = worldsBySite.archipelago || worldsBySite.multiworld;
  const name = newGameName(worldsBySite);
  // The schema's default confidence ("manual") would keep enrich-twitch.js away
  const integrations = { twitch: { confidence: 'auto' } };
  for (const [siteKey, w] of Object.entries(worldsBySite)) {
    if (w) integrations[siteKey] = { enabled: true, gameName: w.name, confidence: 'auto', lastSync: now };
  }
  return {
    id,
    name,
    official: { name },
    randomizer: {
      displayName: `${name} Randomizer`,
      ...randomizerShortNames(name, id),
      name: `${name} Randomizer`,
      website: world.gamePage,
      opensource: null
    },
    resources: { sites: [], trackers: [], guides: [], other: [] },
    integrations,
    source: { origin: SOURCE, importedAt: now },
    enabled: true,
    categories: []
  };
}

async function main() {
  const options = parseArgs();
  const now = new Date();

  const worldsBySiteKey = {};
  for (const siteKey of options.sites) {
    try {
      worldsBySiteKey[siteKey] = await fetchGames(siteKey);
      console.log(`📥 ${SITES[siteKey].label} : ${worldsBySiteKey[siteKey].length} jeux`);
    } catch (error) {
      console.error(`❌ ${SITES[siteKey].label} illisible, laissé tel quel : ${error.message}`);
    }
  }
  const fetchedSites = Object.keys(worldsBySiteKey);
  if (!fetchedSites.length) process.exit(1);

  try {
    const wikiChanges = await resolveWikiLinks(Object.values(worldsBySiteKey).flat());
    for (const { world, from, to } of wikiChanges) {
      console.log(`📖 Wiki « ${world} » : ${from} → ${to || 'aucune page, lien retiré'}`);
    }
  } catch (error) {
    console.error(`⚠️ Wiki Archipelago illisible, liens laissés tels quels : ${error.message}`);
  }

  await connectDB();
  const games = await Game.find({}, { id: 1, name: 1, official: 1, randomizer: 1, resources: 1, integrations: 1 }).lean();
  const indexes = buildIndexes(games);
  if (options.dryRun) console.log('ℹ️ Simulation (--dry-run) : rien n’est écrit');

  // Per game id: its world on each site read
  const plan = new Map();
  const pending = []; // worlds without a game, keyed by site
  const apMatches = new Map();
  const reports = {};
  for (const siteKey of fetchedSites) {
    const { matches, report } = matchSite(siteKey, worldsBySiteKey[siteKey], games, indexes, apMatches);
    reports[siteKey] = report;
    for (const world of worldsBySiteKey[siteKey]) {
      for (const game of matches.get(world.name) || []) {
        if (siteKey === 'archipelago') {
          for (const name of worldNames(world)) apMatches.set(norm(name), game);
        }
        const entry = plan.get(game.id) || {};
        entry[siteKey] = world;
        plan.set(game.id, entry);
        if (options.verbose) console.log(`  ${SITES[siteKey].label} « ${world.name} » → ${game.id}`);
      }
    }
    for (const world of report.unmatched) pending.push({ siteKey, world });
  }

  // Worlds without a game: one new game per name, shared by both sites
  const created = [];
  const takenIds = new Set(games.map(g => g.id));
  const newByName = new Map();
  for (const { siteKey, world } of pending) {
    const keys = worldNames(world).map(norm);
    const entry = keys.map(key => newByName.get(key)).find(Boolean) || { worlds: {} };
    for (const key of keys) newByName.set(key, entry);
    if (!entry.worlds[siteKey]) entry.worlds[siteKey] = world;
  }
  for (const entry of new Set(newByName.values())) {
    const worlds = { archipelago: null, multiworld: null, ...entry.worlds };
    const id = newGameId(newGameName(worlds), takenIds);
    takenIds.add(id);
    created.push({ id, worlds });
  }

  // Games tied to a world before, now on none: their links go
  for (const game of games) {
    if (plan.has(game.id)) continue;
    if (fetchedSites.some(siteKey => game.integrations?.[siteKey]?.enabled) ||
        (game.resources?.sites || []).some(s => (s.source === SOURCE || (s.source === 'manual' && GAME_PAGE_RE.test(s.url))) && fetchedSites.includes(hostOf(s.url))) ||
        (game.resources?.guides || []).some(g => g.source === SOURCE)) {
      plan.set(game.id, {});
    }
  }

  const stats = { updated: 0, created: 0, unchanged: 0, removed: [] };
  const byId = indexes.byId;
  for (const [id, worlds] of plan) {
    const game = byId.get(id);
    const worldsBySite = {};
    for (const siteKey of fetchedSites) worldsBySite[siteKey] = worlds[siteKey] || null;
    const { set, unset } = planGame(game, worldsBySite, fetchedSites, now);
    if (!Object.keys(set).length && !Object.keys(unset).length) {
      stats.unchanged++;
      continue;
    }
    const gone = fetchedSites.filter(siteKey => game.integrations?.[siteKey]?.enabled && !worldsBySite[siteKey]);
    if (gone.length) stats.removed.push(`${id} (${gone.map(s => SITES[s].label).join(', ')})`);
    const changes = Object.keys(set).concat(Object.keys(unset).map(k => `-${k}`))
      .filter(k => !k.endsWith('.lastSync')).join(', ');
    console.log(`  ✏️ ${id} : ${changes}`);
    if (!options.dryRun) {
      await Game.updateOne({ id }, { ...(Object.keys(set).length && { $set: set }), ...(Object.keys(unset).length && { $unset: unset }) });
    }
    stats.updated++;
  }

  if (created.length) {
    console.log(`\n${options.create ? '🆕 Jeux créés' : '🆕 Jeux à créer (--no-create)'} :`);
    for (const { id, worlds } of created) {
      const names = Object.entries(worlds).filter(([, w]) => w).map(([s, w]) => `${SITES[s].label} « ${w.name} »`).join(', ');
      console.log(`  + ${id} — ${names}`);
      if (!options.create || options.dryRun) continue;
      const doc = newGameDoc(id, worlds, now);
      const { set } = planGame(doc, worlds, fetchedSites, now);
      await Game.create({ ...doc, resources: { ...doc.resources, sites: set['resources.sites'] || [], guides: set['resources.guides'] || [], officialSite: set['resources.officialSite'] } });
      stats.created++;
    }
  }

  for (const siteKey of fetchedSites) {
    const report = reports[siteKey];
    const label = SITES[siteKey].label;
    console.log(`\n${label} : ${Object.entries(report.hows).map(([how, n]) => `${n} ${how}`).join(', ')}`);
    for (const a of report.ambiguous) console.log(`  ⚠️ « ${a.world} » : plusieurs jeux possibles (${a.candidates.join(', ')}), ignoré`);
    for (const c of report.conflicts) console.log(`  ⚠️ « ${c.world} » → ${c.game}, déjà lié à « ${c.takenBy} », ignoré`);
  }

  console.log(`\n=== Résumé ===`);
  console.log(`Jeux mis à jour : ${stats.updated}, inchangés : ${stats.unchanged}, créés : ${options.dryRun ? `${created.length} (simulation)` : stats.created}`);
  if (stats.removed.length) console.log(`Retirés d’un site : ${stats.removed.join(' ; ')}`);

  await mongoose.disconnect();

  if (!options.dryRun && options.enrich && stats.created) runEnrichment(created.map(c => c.id));
}

main().catch(error => {
  console.error('❌ Erreur :', error.message);
  process.exit(1);
});
