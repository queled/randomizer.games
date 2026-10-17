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

module.exports = { SITES, fetchGames, parseGamesPage, decodeEntities };
