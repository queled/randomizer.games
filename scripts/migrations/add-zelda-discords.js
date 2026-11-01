#!/usr/bin/env node
/**
 * One-off migration: adds the community Discord servers of Zelda randomizers
 * to the "other" resources of their games.
 *
 * - each link is checked against the game's existing links (same URL, or an
 *   older invite of the same server): an existing one gets its name and
 *   descriptions updated instead of being added twice
 * - the name is the Discord server's own name, the same in every language
 * - a new link goes after the game's own Discord links, before the ones
 *   the community APWorld sync manages
 *
 * Idempotent.
 *
 * Usage:
 *   node scripts/migrations/add-zelda-discords.js
 *   node scripts/migrations/add-zelda-discords.js --dry-run
 */

const mongoose = require('mongoose');
const connectDB = require('../../config/database');
const { Game } = require('../../models');

const isDryRun = process.argv.includes('--dry-run');

const LANGS = ['en', 'fr', 'es', 'de', 'it', 'pt'];

const officialServer = rando => ({
  en: `Official ${rando} Discord server.`,
  fr: `Serveur Discord officiel ${rando}.`,
  es: `Servidor oficial de Discord de ${rando}.`,
  de: `Offizieller ${rando}-Discord-Server.`,
  it: `Server Discord ufficiale di ${rando}.`,
  pt: `Servidor oficial do Discord do ${rando}.`
});

const ZELDA_GAMES = [
  'z1', 'z2', 'alttp', 'alttpfs', 'las', 'ladx', 'oot', 'oot3d', 'ootmq', 'ootbijmqwt',
  'mm', 'mm3d', 'ootmm', 'ooa', 'oos', 'tww', 'twwhd', 'tmc', 'tp', 'tphd', 'ph', 'st',
  'ss', 'sshd', 'albw', 'botw', 'totk', 'smz3', 'z1m1', 'z1m1z3m3', 'tfoer', 'twogr', 'zagdx'
];

const SERVERS = [
  {
    games: ['tp'],
    url: 'https://discord.gg/tprandomizer',
    oldUrls: ['https://discord.com/invite/ksavgkZ', 'https://discord.gg/ksavgkZ'],
    name: 'Twilight Princess Randomizer',
    descriptions: officialServer('TPR')
  },
  {
    games: ['mm'],
    url: 'https://discord.gg/7jBRhhJ',
    oldUrls: ['https://discord.com/invite/7jBRhhJ'],
    name: 'MM Randomizer Community',
    descriptions: officialServer('MMR')
  },
  {
    games: ['albw'],
    url: 'https://discord.gg/dmAJh2uY7M',
    oldUrls: ['https://discord.com/invite/dmAJh2uY7M'],
    name: 'ALBW Randomizer & Modding',
    descriptions: officialServer('ALBWR')
  },
  {
    games: ['tmc'],
    url: 'https://discord.com/invite/ndFuWbV',
    oldUrls: ['https://discord.gg/ndFuWbV'],
    name: 'Minish Maker',
    descriptions: officialServer('TMCR')
  },
  {
    // The link already on the game stays: no permanent invite is published
    games: ['alttp'],
    url: 'https://discord.gg/wSM8KGVqh9',
    oldUrls: [],
    keepUrl: true,
    name: 'Communauté ALttPR Francophone',
    descriptions: {
      en: 'French ALttPR Discord community.',
      fr: 'Discord FR ALttPR.',
      es: 'Comunidad de Discord ALttPR en francés.',
      de: 'Französische ALttPR-Discord-Community.',
      it: 'Comunità Discord ALttPR in francese.',
      pt: 'Comunidade Discord ALttPR em francês.'
    }
  },
  {
    games: ['oot'],
    url: 'https://discord.gg/w46yWPFXj',
    oldUrls: ['https://discord.com/invite/w46yWPFXj'],
    name: 'MaisonDeManu',
    descriptions: {
      en: 'French help server to learn OoTR tricks.',
      fr: 'Entraide FR pour apprendre les tricks OoTR.',
      es: 'Ayuda en francés para aprender los tricks de OoTR.',
      de: 'Französische Hilfe zum Lernen von OoTR-Tricks.',
      it: 'Aiuto in francese per imparare i trick di OoTR.',
      pt: 'Ajuda em francês para aprender os tricks de OoTR.'
    }
  },
  {
    games: ZELDA_GAMES,
    url: 'https://discord.gg/fkDSFcDhEE',
    oldUrls: ['https://discord.com/invite/fkDSFcDhEE'],
    name: 'Zelda Francophone',
    descriptions: {
      en: 'French-speaking Zelda community.',
      fr: 'Communauté Zelda francophone.',
      es: 'Comunidad Zelda francófona.',
      de: 'Französischsprachige Zelda-Community.',
      it: 'Comunità Zelda francofona.',
      pt: 'Comunidade Zelda francófona.'
    }
  }
];

const normUrl = url => (url || '').trim().replace(/\/+$/, '').toLowerCase();

function entryFor(server, existing) {
  const translations = Object.fromEntries(LANGS.map(lang =>
    [lang, { name: server.name, description: server.descriptions[lang] }]));
  return {
    ...(existing || {}),
    url: server.keepUrl && existing ? existing.url : server.url,
    name: server.name,
    description: server.descriptions.en,
    translations,
    type: 'discord',
    source: existing?.source || 'manual'
  };
}

const same = (a, b) => ['url', 'name', 'description', 'type'].every(k => a[k] === b[k]) &&
  LANGS.every(lang => a.translations?.[lang]?.name === b.translations?.[lang]?.name &&
    a.translations?.[lang]?.description === b.translations?.[lang]?.description);

async function main() {
  await connectDB();
  if (isDryRun) console.log('[DRY-RUN]');

  const gameIds = [...new Set(SERVERS.flatMap(s => s.games))];
  const games = await Game.find({ id: { $in: gameIds } }).select('id resources.other').lean();
  const missing = gameIds.filter(id => !games.some(g => g.id === id));
  if (missing.length) console.log(`⚠️  Jeux introuvables : ${missing.join(', ')}`);

  let added = 0, updated = 0;
  for (const game of games) {
    const other = [...(game.resources?.other || [])];
    let changed = false;

    for (const server of SERVERS.filter(s => s.games.includes(game.id))) {
      const urls = new Set([server.url, ...server.oldUrls].map(normUrl));
      const index = other.findIndex(item => urls.has(normUrl(item.url)));
      if (index >= 0) {
        const entry = entryFor(server, other[index]);
        if (same(entry, other[index])) continue;
        other[index] = entry;
        console.log(`${game.id} : mis à jour → ${server.name}`);
        updated++;
      } else {
        const synced = item => item.source === 'apworld' || item.source === 'archipelago';
        const lastOwnDiscord = other.findLastIndex(item => item.type === 'discord' && !synced(item));
        const firstSynced = other.findIndex(synced);
        const at = lastOwnDiscord >= 0 ? lastOwnDiscord + 1 : firstSynced >= 0 ? firstSynced : other.length;
        other.splice(at, 0, entryFor(server));
        console.log(`${game.id} : ajouté → ${server.name}`);
        added++;
      }
      changed = true;
    }

    if (changed && !isDryRun) {
      await Game.updateOne({ id: game.id }, { $set: { 'resources.other': other } });
    }
  }

  console.log(`\n${added} ajout(s), ${updated} mise(s) à jour${isDryRun ? ' (dry-run)' : ''}`);
  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
