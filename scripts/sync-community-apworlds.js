#!/usr/bin/env node
/**
 * Sync the community APWorlds list
 *
 * The Archipelago community spreadsheet (services/community-apworlds.js) lists
 * the worlds playable outside the core install. Each row is tied to a game of
 * the site, looked up in this order:
 *   1. integrations.apworld.gameNames, kept from the previous runs (or set by
 *      hand, confidence "manual");
 *   2. OVERRIDES below;
 *   3. the game's names, exactly (site, official, randomizer, rando-list,
 *      Twitch, archipelago.gg / multiworld.gg world).
 * A row only a looser form of its name matches (subtitle, without brackets…)
 * is listed for review and left alone, as is a name several games match: no
 * guess, no false positive. A row nothing matches becomes a new game (Twitch
 * category and release year looked up next).
 *
 * The sync owns, on each game, the links it adds (source "apworld"):
 *   - the APWorld itself (releases, else setup guide, else Discord), shown as
 *     a community APWorld with its stability ("broken" gets a warning);
 *   - the PopTracker / tracker pack, the setup guide, the invite to the
 *     Discord server of the support thread.
 * It drops them when the row leaves the list, and replaces a link added by
 * hand to the same repository. A row of the game's own archipelago.gg /
 * multiworld.gg world gets neither APWorld nor guide (the page stands for
 * them); a variant ("Name - Mode", "Name (Recomp)") keeps its own. Run it after
 * sync-archipelago-games.js, which ties those worlds.
 *
 * Usage:
 *   node scripts/sync-community-apworlds.js --dry-run
 *   node scripts/sync-community-apworlds.js
 *   node scripts/sync-community-apworlds.js --no-create   # don't create games
 *   node scripts/sync-community-apworlds.js --verbose     # every row and its game
 */

const path = require('path');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const connectDB = require('../config/database');
const { Game } = require('../models');
const { fetchCommunityWorlds } = require('../services/community-apworlds');
const { norm, withoutBrackets, subtitle, mainTitle, gameNames, pickCandidate, newGameId, runEnrichment } = require('../services/game-names');

const SOURCE = 'apworld';
const SITE_HOST_RE = /^https?:\/\/(?:www\.)?(archipelago|multiworld)\.gg(?:\/|$)/i;
const STATUS_RANK = { stable: 0, unstable: 1, broken: 2 };
const REPO_RE =/^https?:\/\/(?:www\.)?(github\.com|gitlab\.com|codeberg\.org)\/([^/?#]+)\/([^/?#]+)/i;

// Row name → game id (or ids), null for a game of its own (created) where a
// looser form of the name points to another game, false for a row left out
const OVERRIDES = {
  // Variants, remakes and other spellings of a game of the site
  'DELTARUNE': 'deltarune',
  'Metroid Fusion': 'mf',
  'Mother (Earthbound Beginnings)': 'eb',
  'Halo The Master Chief Collection': 'hceatcc', // only Halo CE Anniversary so far
  'Final Fantasy XII: Open World': 'ff12',
  'Final Fantasy XII: Trial Mode': 'ff12',
  'Final Fantasy Tactics: Ivalice Island (FFT PSX)': 'fft',
  'Kingdom Hearts: Chain of Memories (GBA)': 'khcom',
  'The Legend of Zelda: Ocarina of Time - Ship of Harkinian': 'oot',
  'The Legend Zelda: Ocarina of Time (Updated, not Ship)': 'oot',
  'The Legend of Zelda: Wind Waker HD': 'twwhd',
  'The Legend of Zelda: A Link to the Past OWR': 'alttp',
  'Mega Man Battle Network 6': 'mmbn6',
  'Noita - Enemysanity': 'noita',
  'Call of Duty: Black Ops 3 - Zombies': 'codbo3',
  'Yakuza | Like a Dragon Gaiden: The Man Who Erased His Name': 'ladgtmwehn',
  'Plants vs. Zombies: GOTY': 'pvz',
  'Plants vs. Zombies: Replanted': 'pvz',
  'Ratchet & Clank 2: Going Commando': 'rc2',
  'Ratchet & Clank 3: Up Your Arsenal': 'rc3',
  'Spyro 3: Year of the Dragon': 'spyro3',
  'Super Mario Land 2: The Golden Coins': 'sml26gc',
  'Super Mario World: Spicy Mycena Waffles': 'smwsmw',
  'Age of Empires II: Definite Edition': 'aoe2de',
  'Castlevania: Symphony of the Night (SymphonyRecomp)': 'sotn',
  'Donkey Kong Country (Mirrored)': 'dkc',
  'Donkey Kong Toluca (DKC3)': 'dkc3',
  'Dragon Quest 2': 'dw2',
  'Factorio: Space Age': 'factorio',
  'Final Fantasy XIII - Lightning Returns': 'lrff13',
  'Hollow Knight: Silksong (Batsong)': 'hks',
  'Jurassic Park (SNES)': 'jp',
  'Knights of the Old Republic (KotoR)': 'swkotor',
  'Pokémon Trading Card Game (GameBoy)': 'pkmntcg',
  'Quest 64 (Recomp)': 'q64',
  'Star Wars: Episode 1 Racer': 'swe1r',
  'Momodora 4 - Reverie Under the Moonlight': 'mrutm',
  'Paper Mario 64': 'pm',
  'Final Fantasy 6 Worlds Collide': 'ff6',
  'Final Fantasy 1: Pixel Remaster': 'ff1pr',
  'Final Fantasy 1 (PSP)': 'ff1psp',
  'Dark Cloud 1': 'dc1',
  'Wario Land 1': 'wl1',
  'Mega Man 1': 'mm1',
  'Pikmin 1': 'pikmin',
  'Minecraft': 'minecraft',
  'Minecraft Fabric': 'minecraft',
  'Minecraft Modded': 'minecraft',
  'Tyrian / Tyrian 2000': 'tyrian',
  'Digimon World 1': 'digimonworld',
  'Chibi Robo! Plug into Adventure': 'crobo!',
  'Chrono Trigger Rando-Dalton Imperial (SNES)': 'ct',
  'Gato Roboto B-Side': 'gr',
  '2048.0': '2048',
  // Games of their own, though a looser form of their name is another game's
  'Age of Mythology: Retold': null,
  'Castlevania: Legacy of Darkness': null,
  'Castlevania: Lords of Shadow': null,
  'Citadel (Luanti)': null,
  'The Elder Scrolls IV: Oblivion Remastered': null,
  'Spyro: A Hero\'s Tail': null,
  'High Roller': null,
  'The Legend of Heroes: Trails Beyond the Horizon': null,
  'The Legend of Heroes: Trails in the Sky the 3rd': null,
  'Mario & Luigi: Dream Team': null,
  'Super Mario 64 - Spicy Mycena 64': null,
  'Minecraft: Vault Hunters (Modpack)': null,
  'Outward: Definitive Edition': null,
  'Pokémon Ranger (Quest)': null,
  'Total War: Warhammer III': null
};

// Row name → name of the new game, for rows of one game under several names
const NEW_GAME_NAMES = {
  'Yet Another Rhythm Game (YARG)': 'YARG',
  'YARG (Guitar Hero/Rockband)': 'YARG',
  'YAYARG (YARG Custom Songs)': 'YARG',
  'Pokémon Ranger (Quest)': 'Pokémon Ranger'
};

// New game name → id, where the initials read badly
const NEW_GAME_IDS = {
  'V Rising': 'vrising',
  'Total War: Warhammer III': 'twwh3',
  'YOHANE THE PARHELION -BLAZE in the DEEPBLUE-': 'yohane'
};

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun: args.includes('--dry-run'),
    create: !args.includes('--no-create'),
    enrich: !args.includes('--no-enrich'),
    verbose: args.includes('--verbose')
  };
}

const allNames = game => [
  ...gameNames(game),
  game.integrations?.archipelago?.gameName,
  game.integrations?.multiworld?.gameName
].filter(Boolean);

function buildIndexes(games) {
  const byId = new Map(games.map(g => [g.id, g]));
  const strong = new Map();
  const weak = new Map();
  const add = (map, key, game) => {
    if (!key) return;
    const set = map.get(key) || new Set();
    set.add(game);
    map.set(key, set);
  };
  for (const game of games) {
    for (const name of allNames(game)) {
      add(strong, norm(name), game);
      for (const loose of [subtitle(name), mainTitle(name), withoutBrackets(name)]) {
        if (loose && norm(loose) !== norm(name)) add(weak, norm(loose), game);
      }
    }
    add(weak, norm(game.id), game);
  }
  return { byId, strong, weak };
}

// Games of a row: { games } (several for some overrides), else why none
function matchRow(row, indexes) {
  const override = OVERRIDES[row.name];
  if (override === false) return { games: [], skip: true };
  if (override === null) return { games: [], how: 'override' };
  if (override) {
    const games = [].concat(override).map(id => indexes.byId.get(id)).filter(Boolean);
    return { games, how: 'override', skip: !games.length };
  }

  const strong = [...(indexes.strong.get(norm(row.name)) || [])];
  if (strong.length) {
    const { game, ambiguous } = pickCandidate(strong, [row.name]);
    return game ? { games: [game], how: 'name' } : { games: [], ambiguous };
  }

  const loose = new Set();
  for (const form of [row.name, withoutBrackets(row.name), subtitle(row.name), mainTitle(row.name)]) {
    if (!form) continue;
    for (const index of [indexes.strong, indexes.weak]) {
      for (const game of index.get(norm(form)) || []) loose.add(game);
    }
  }
  if (loose.size) return { games: [], review: [...loose].map(g => g.id) };
  return { games: [], how: 'none' };
}

const repoKey = url => {
  const m = String(url || '').match(REPO_RE);
  return m ? `${m[1]}/${m[2]}/${m[3].replace(/\.git$/, '')}`.toLowerCase() : null;
};
const isDiscord = url => /^https?:\/\/(?:www\.)?discord(?:app)?\.com\//i.test(url || '');
const isDiscordInvite = url => /^https?:\/\/(?:www\.)?discord(?:\.gg|(?:app)?\.com\/invite)\//i.test(url || '');

// Servers of the support threads: a thread only opens for members, the Discord
// tab links to the server's invite instead
const DISCORD_SERVERS = {
  '731205301247803413': { name: 'Archipelago', url: 'https://discord.gg/8Z65BR2' },
  '1085716850370957462': { name: 'AP After Dark (18+)', url: 'https://discord.gg/Sbhy4ykUKn' }
};

// Invite of a support link: its server's for a thread, the link itself for an invite
function discordInvite(url) {
  const server = DISCORD_SERVERS[String(url).match(/\/channels\/(\d+)/)?.[1]];
  if (server) return { url: server.url, name: server.name, translations: { fr: { name: server.name } } };
  if (isDiscordInvite(url)) return { url, name: 'Discord', translations: { fr: { name: 'Discord' } } };
  return null;
}
const isSiteHost = url => SITE_HOST_RE.test(url || '');

// Repository name ("owner/Archipelago" for a fork of Archipelago), else host
function linkName(url) {
  if (isDiscord(url)) return 'Discord Archipelago';
  const repo = String(url).match(REPO_RE);
  if (repo) return /^archipelago$/i.test(repo[3]) ? `${repo[2]}/${repo[3]}` : repo[3];
  const luanti = String(url).match(/content\.luanti\.org\/packages\/[^/]+\/([^/?#]+)/);
  if (luanti) return luanti[1];
  return new URL(url).hostname.replace(/^www\./, '');
}

/**
 * Links of a row: { site, tracker, guide, discord }. The links cell holds
 * one link, the first of its labels ("APWorld, Poptracker" → the APWorld).
 */
function rowLinks(row) {
  const firstLabel = String(row.links.text || '').split(',')[0].trim();
  const linkIsTracker = /tracker/i.test(firstLabel);
  const links = {};

  const download = row.links.url && !linkIsTracker && !isSiteHost(row.links.url) ? row.links.url : null;
  const guide = row.guide.url && !isSiteHost(row.guide.url) && !isDiscord(row.guide.url) ? row.guide.url : null;
  const discord = isDiscord(row.support.url) ? row.support.url : null;

  const siteUrl = download || guide || discord || (isDiscord(row.links.url) ? row.links.url : null);
  if (siteUrl) {
    links.site = {
      url: siteUrl,
      name: linkName(siteUrl),
      source: SOURCE,
      isArchipelago: true,
      isMultiworld: false,
      isObsolete: false,
      apworldStatus: row.status
    };
  }
  if (row.links.url && linkIsTracker) {
    links.tracker = {
      url: row.links.url,
      name: /poptracker/i.test(firstLabel) ? 'PopTracker' : firstLabel,
      source: SOURCE
    };
  }
  if (guide && guide !== siteUrl) {
    links.guide = {
      url: guide,
      name: 'APWorld setup guide',
      translations: { fr: { name: 'Guide d’installation de l’APWorld' } },
      type: 'tutorial',
      source: SOURCE
    };
  }
  const invite = discord && discordInvite(discord);
  if (invite) links.discord = { ...invite, type: 'discord', source: SOURCE };
  return links;
}

const strip = list => JSON.stringify((list || []).map(({ _id, ...rest }) => rest));

/**
 * New resources and integration of a game from its rows (none: the game left
 * the list). A link added by hand to the same repository makes way; a
 * rando-list link to it stays (sync-rando-list.js owns it): the API shows the
 * APWorld, with its status, in its place.
 */
function planGame(game, rows, now) {
  const resources = game.resources || {};
  // A row of the game's archipelago.gg / multiworld.gg world: that page stands for it
  const pageWorlds = new Set(['archipelago', 'multiworld']
    .filter(site => game.integrations?.[site]?.enabled && game.integrations[site].gameName)
    .map(site => norm(game.integrations[site].gameName)));
  const all = rows.map(row => {
    const links = rowLinks(row);
    // The core world's row ("Core") or the world of the game's page: the page stands for it
    if (row.pr === 'Core' || pageWorlds.has(norm(row.name)) || pageWorlds.has(norm(withoutBrackets(row.name)))) {
      delete links.site;
      delete links.guide;
    }
    // Several rows (variants): each guide says which one it is about
    if (links.guide && rows.length > 1) {
      links.guide.name += ` (${row.name})`;
      links.guide.translations.fr.name += ` (${row.name})`;
    }
    return links;
  });
  const wanted = kind => all.map(l => l[kind]).filter(Boolean)
    .filter((link, i, list) => list.findIndex(o => o.url === link.url) === i);

  // One link per repository, the most stable row's
  const wantedSites = wanted('site')
    .sort((a, b) => STATUS_RANK[a.apworldStatus] - STATUS_RANK[b.apworldStatus])
    .filter((site, i, list) => !repoKey(site.url) || list.findIndex(o => repoKey(o.url) === repoKey(site.url)) === i);
  const wantedRepos = new Set(wantedSites.map(s => repoKey(s.url)).filter(Boolean));
  const replaced = site => site.source === 'manual' && (site.isArchipelago || site.isMultiworld) && !isSiteHost(site.url) &&
    (wantedSites.some(w => w.url === site.url) || wantedRepos.has(repoKey(site.url)));
  const kept = (resources.sites || []).filter(site => site.source !== SOURCE && !replaced(site));
  const sites = [
    ...kept,
    ...wantedSites.filter(w => !kept.some(site => site.url === w.url))
  ];

  const merge = (list, add) => {
    const own = (list || []).filter(item => item.source !== SOURCE);
    return [...own, ...add.filter(item => !own.some(o => o.url === item.url))];
  };
  const trackers = merge(resources.trackers, wanted('tracker'));
  const guides = merge(resources.guides, wanted('guide'));
  const other = merge(resources.other, wanted('discord'));

  const set = {};
  if (strip(sites) !== strip(resources.sites)) set['resources.sites'] = sites;
  if (strip(trackers) !== strip(resources.trackers)) set['resources.trackers'] = trackers;
  if (strip(guides) !== strip(resources.guides)) set['resources.guides'] = guides;
  if (strip(other) !== strip(resources.other)) set['resources.other'] = other;

  const old = game.integrations?.apworld || {};
  const next = {
    enabled: rows.length > 0,
    gameNames: rows.length ? rows.map(r => r.name).sort() : (old.gameNames || []),
    mature: rows.some(r => r.mature),
    confidence: old.confidence === 'manual' && old.gameNames?.length ? 'manual' : 'auto'
  };
  if (next.enabled !== !!old.enabled || JSON.stringify(next.gameNames) !== JSON.stringify(old.gameNames || []) ||
      next.mature !== !!old.mature || next.confidence !== old.confidence) {
    set['integrations.apworld'] = { ...next, lastSync: now };
  } else if (Object.keys(set).length) {
    set['integrations.apworld.lastSync'] = now;
  }
  return set;
}

// Name of a new game: without "(Platform)", "(Beta)"… unless another game has it
function newGameName(row, indexes) {
  if (NEW_GAME_NAMES[row.name]) return NEW_GAME_NAMES[row.name];
  const short = withoutBrackets(row.name);
  return short && !indexes.strong.has(norm(short)) && !indexes.weak.has(norm(short)) ? short : row.name;
}

function newGameDoc(id, name, rows, now) {
  const site = rows.map(row => rowLinks(row).site).find(Boolean);
  return {
    id,
    name,
    official: { name },
    randomizer: {
      displayName: `${name} Randomizer`,
      shortName: `${id.toUpperCase()} Randomizer`,
      tinyName: id.toUpperCase(),
      name: `${name} Randomizer`,
      website: site?.url || null,
      opensource: null
    },
    resources: { sites: [], trackers: [], guides: [], other: [] },
    // The schema's default confidence ("manual") would keep enrich-twitch.js away
    integrations: { twitch: { confidence: 'auto' } },
    source: { origin: SOURCE, importedAt: now },
    enabled: true,
    categories: []
  };
}

async function main() {
  const options = parseArgs();
  const now = new Date();

  let rows;
  try {
    rows = await fetchCommunityWorlds();
    console.log(`📥 Tableur des APWorlds communautaires : ${rows.length} jeux`);
  } catch (error) {
    console.error(`❌ Tableur illisible, rien n’est modifié : ${error.message}`);
    process.exit(1);
  }

  await connectDB();
  const games = await Game.find({}, { id: 1, name: 1, official: 1, randomizer: 1, resources: 1, integrations: 1 }).lean();
  const indexes = buildIndexes(games);
  if (options.dryRun) console.log('ℹ️ Simulation (--dry-run) : rien n’est écrit');

  // Rows kept from the previous runs, then the others
  const plan = new Map(); // game id → rows
  const report = { hows: {}, ambiguous: [], review: [], unmatched: [] };
  const rowByName = new Map(rows.map(r => [r.name, r]));
  const taken = new Set();
  const tie = (game, row, how) => {
    plan.set(game.id, [...(plan.get(game.id) || []), row]);
    taken.add(row.name);
    report.hows[how] = (report.hows[how] || 0) + 1;
    if (options.verbose) console.log(`  « ${row.name} » → ${game.id} (${how})`);
  };
  for (const game of games) {
    const apworld = game.integrations?.apworld;
    if (!apworld?.gameNames?.length || (!apworld.enabled && apworld.confidence !== 'manual')) continue;
    for (const name of apworld.gameNames) {
      // An override to other games wins; a game created for the row (null) keeps it
      if (rowByName.has(name) && !taken.has(name) && !OVERRIDES[name] && OVERRIDES[name] !== false) tie(game, rowByName.get(name), 'kept');
    }
  }
  for (const row of rows) {
    if (taken.has(row.name)) continue;
    const { games: found, how, ambiguous, review, skip } = matchRow(row, indexes);
    if (skip) continue;
    if (ambiguous) report.ambiguous.push({ row, candidates: ambiguous });
    else if (review) report.review.push({ row, candidates: review });
    else if (!found.length) report.unmatched.push(row);
    else for (const game of found) tie(game, row, how);
  }

  // Games tied to rows before, now on none: their links go
  for (const game of games) {
    if (plan.has(game.id)) continue;
    if (game.integrations?.apworld?.enabled || ['sites', 'trackers', 'guides', 'other'].some(k => (game.resources?.[k] || []).some(i => i.source === SOURCE))) {
      plan.set(game.id, []);
    }
  }

  const stats = { updated: 0, unchanged: 0, removed: [], created: [] };
  for (const [id, gameRows] of plan) {
    const game = indexes.byId.get(id);
    const set = planGame(game, gameRows, now);
    if (!Object.keys(set).length) {
      stats.unchanged++;
      continue;
    }
    if (!gameRows.length) stats.removed.push(id);
    console.log(`  ✏️ ${id} : ${Object.keys(set).filter(k => !k.endsWith('.lastSync')).join(', ')}`);
    if (!options.dryRun) await Game.updateOne({ id }, { $set: set });
    stats.updated++;
  }

  // Rows without a game: one new game per name
  const newGames = new Map();
  for (const row of report.unmatched) {
    const name = newGameName(row, indexes);
    const entry = newGames.get(norm(name)) || { name, rows: [] };
    entry.rows.push(row);
    newGames.set(norm(name), entry);
  }
  const takenIds = new Set(games.map(g => g.id));
  if (newGames.size) {
    console.log(`\n${options.create ? '🆕 Jeux créés' : '🆕 Jeux à créer (--no-create)'} :`);
  }
  for (const { name, rows: gameRows } of newGames.values()) {
    const id = NEW_GAME_IDS[name] && !takenIds.has(NEW_GAME_IDS[name]) ? NEW_GAME_IDS[name] : newGameId(name, takenIds);
    takenIds.add(id);
    const labels = gameRows.map(r => `${r.name !== name ? `« ${r.name} » ` : ''}[${r.status}${r.mature ? ', 18+' : ''}]`).join(' + ');
    console.log(`  + ${id} — ${name} ${labels}`);
    if (!options.create || options.dryRun) continue;
    const doc = newGameDoc(id, name, gameRows, now);
    const set = planGame(doc, gameRows, now);
    await Game.create({
      ...doc,
      resources: {
        sites: set['resources.sites'] || [],
        trackers: set['resources.trackers'] || [],
        guides: set['resources.guides'] || [],
        other: set['resources.other'] || []
      },
      integrations: { ...doc.integrations, apworld: set['integrations.apworld'] }
    });
    stats.created.push(id);
  }

  console.log(`\nRattachés : ${Object.entries(report.hows).map(([how, n]) => `${n} ${how}`).join(', ') || 'aucun'}`);
  for (const a of report.ambiguous) console.log(`  ⚠️ « ${a.row.name} » : plusieurs jeux possibles (${a.candidates.join(', ')}), ignoré`);
  for (const r of report.review) console.log(`  🔎 « ${r.row.name} » : nom approchant de ${r.candidates.join(', ')}, à vérifier (OVERRIDES)`);

  console.log(`\n=== Résumé ===`);
  console.log(`Jeux mis à jour : ${stats.updated}, inchangés : ${stats.unchanged}, ` +
    `créés : ${options.dryRun || !options.create ? `${newGames.size} (non écrits)` : stats.created.length}, ` +
    `à vérifier : ${report.review.length + report.ambiguous.length}`);
  if (stats.removed.length) console.log(`Sortis du tableur : ${stats.removed.join(', ')}`);

  await mongoose.disconnect();

  if (!options.dryRun && options.enrich && stats.created.length) runEnrichment(stats.created);
}

main().catch(error => {
  console.error('❌ Erreur :', error.message);
  process.exit(1);
});
