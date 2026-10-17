/**
 * Game lists of the Archipelago web hosts
 *
 * archipelago.gg lists the worlds shipped with Archipelago, multiworld.gg (a
 * community host) many more. Both serve the same /games page: one
 * <details data-game="…"> per world, with its description and links (game
 * page, setup guides, wiki, bug tracker). multiworld.gg adds a display name
 * (data-display-name) when the world's name is not the game's.
 */

const axios = require('axios');

const SITES = {
  archipelago: { key: 'archipelago', label: 'Archipelago', base: 'https://archipelago.gg', minGames: 50 },
  multiworld: { key: 'multiworld', label: 'Multiworld', base: 'https://multiworld.gg', minGames: 150 }
};

function decodeEntities(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

const stripTags = html => decodeEntities(String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function parseGamesPage(html, site) {
  const games = [];
  const blockRe = /<details\s+data-game="([^"]*)"([^>]*)>([\s\S]*?)<\/details>/g;
  let match;
  while ((match = blockRe.exec(html))) {
    const [, rawName, attrs, body] = match;
    const name = decodeEntities(rawName).trim();
    if (!name) continue;
    const displayAttr = attrs.match(/data-display-name="([^"]*)"/);
    const displayName = displayAttr ? decodeEntities(displayAttr[1]).trim() : name;

    const links = {};
    const linkRe = /<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let link;
    while ((link = linkRe.exec(body))) {
      const label = stripTags(link[2]).toLowerCase();
      const url = new URL(decodeEntities(link[1]), site.base).href;
      if (label === 'game page') links.gamePage = url;
      else if (label === 'setup guides') links.setupGuide = url;
      else if (label === 'wiki') links.wiki = url;
      else if (label === 'report a bug') links.bugTracker = url;
    }
    if (!links.gamePage) continue;

    const version = body.match(/<div class="world_version">([\s\S]*?)<\/div>/);
    const authors = body.match(/<div class="author_credit">([\s\S]*?)<\/div>/);
    games.push({
      site: site.key,
      name,
      displayName,
      version: version ? stripTags(version[1]).replace(/^version:\s*/i, '') : null,
      authors: authors ? stripTags(authors[1]).replace(/^created by:\s*/i, '') : null,
      ...links
    });
  }
  return games;
}

/**
 * Worlds listed by a site. Throws when the page is unreachable or lists far
 * fewer games than usual (layout change), so that a broken page never reads as
 * "every game was removed".
 */
async function fetchGames(siteKey) {
  const site = SITES[siteKey];
  const { data } = await axios.get(`${site.base}/games`, {
    timeout: 30000,
    headers: { 'User-Agent': 'RandomizerWebsite/1.0' },
    responseType: 'text'
  });
  const games = parseGamesPage(data, site);
  if (games.length < site.minGames) {
    throw new Error(`${site.label} : ${games.length} jeux lus sur ${site.base}/games (au moins ${site.minGames} attendus)`);
  }
  return games;
}

const WIKI = { host: 'archipelago.miraheze.org', api: 'https://archipelago.miraheze.org/w/api.php' };

// "Pokémon Mystery Dungeon: Explorers of Sky" and "Pokemon Mystery Dungeon Explorers of Sky",
// "Ratchet & Clank: The Odd Couple" and "Ratchet & Clank: Odd Couple"
const wikiKey = title => String(title || '')
  .normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .toLowerCase()
  .replace(/\bthe\b/g, '')
  .replace(/[^a-z0-9]/g, '');

const wikiTitle = url => decodeURIComponent(new URL(url).pathname.replace(/^\/wiki\//, '')).replace(/_/g, ' ');

// Same escaping as MediaWiki's own links
const wikiUrl = title => `https://${WIKI.host}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))
  .replace(/%(3A|2F|3B|40|24|21|2A|2C|7E)/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))}`;

async function wikiQuery(params) {
  const { data } = await axios.get(WIKI.api, {
    timeout: 30000,
    headers: { 'User-Agent': 'RandomizerWebsite/1.0' },
    params: { action: 'query', format: 'json', formatversion: 2, ...params }
  });
  return data;
}

// Titles among `titles` that have a page (redirects included)
async function existingWikiTitles(titles) {
  const existing = new Set();
  for (let i = 0; i < titles.length; i += 50) {
    const chunk = titles.slice(i, i + 50);
    const { query } = await wikiQuery({ titles: chunk.join('|') });
    const normalized = new Map((query.normalized || []).map(n => [n.from, n.to]));
    const found = new Set((query.pages || []).filter(p => !p.missing && !p.invalid).map(p => p.title));
    for (const title of chunk) {
      if (found.has(normalized.get(title) || title)) existing.add(title);
    }
  }
  return existing;
}

// Every article of the wiki, by wikiKey; articles before redirects
async function wikiArticles() {
  const byKey = new Map();
  const pages = [];
  let next = {};
  do {
    const data = await wikiQuery({ generator: 'allpages', gapnamespace: 0, gaplimit: 500, prop: 'info', ...next });
    pages.push(...(data.query?.pages || []));
    next = data.continue || null;
  } while (next);
  pages.sort((a, b) => Number(!!a.redirect) - Number(!!b.redirect));
  for (const page of pages) {
    const key = wikiKey(page.title);
    if (!byKey.has(key)) byKey.set(key, page.title);
  }
  return byKey;
}

/**
 * The sites' wiki links name pages that don't exist ("BKSimulator" for "BK
 * Simulator", "DOOM II (Beta)"). Each link to a missing page points to the
 * article of the same name, spelling aside, else the variant's game
 * ("(Beta)" dropped), else goes. Returns the links changed; a wiki that cannot
 * be read leaves them as they are.
 */
async function resolveWikiLinks(worlds) {
  const onWiki = worlds.filter(w => w.wiki && new URL(w.wiki).host === WIKI.host);
  const titles = [...new Set(onWiki.map(w => wikiTitle(w.wiki)))];
  const existing = await existingWikiTitles(titles);
  const missing = onWiki.filter(w => !existing.has(wikiTitle(w.wiki)));
  if (!missing.length) return [];

  const articles = await wikiArticles();
  const changes = [];
  for (const world of missing) {
    const title = wikiTitle(world.wiki);
    const variant = title.replace(/\s*\(beta\)\s*$|\s+beta$/i, '');
    const found = articles.get(wikiKey(title)) || articles.get(wikiKey(variant));
    const wiki = found ? wikiUrl(found) : null;
    changes.push({ world: world.name, from: world.wiki, to: wiki });
    world.wiki = wiki;
  }
  return changes;
}

module.exports = { SITES, fetchGames, parseGamesPage, decodeEntities, resolveWikiLinks };
