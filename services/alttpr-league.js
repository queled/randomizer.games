/**
 * Team league (https://alttprleague.com, Open league on its open. subdomain):
 * teams of three players meet once a week, each match being two races (1v1
 * or co-op) between their players. The site has no API: each team page holds
 * every season of the team, one tab per season, with its division and the
 * players and finish times of each of its matches.
 */

const axios = require('axios');

const SITES = {
  invitational: { baseUrl: 'https://alttprleague.com', name: 'ALTTPR League' },
  open: { baseUrl: 'https://open.alttprleague.com', name: 'ALTTPR League Open' }
};
const REQUEST_DELAY_MS = 300;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getPage(site, path, attempt = 0) {
  await sleep(REQUEST_DELAY_MS);
  try {
    const { data } = await axios.get(`${SITES[site].baseUrl}${path}`, {
      timeout: 30000,
      responseType: 'text',
      headers: { 'User-Agent': 'RandomizerWebsite/1.0' }
    });
    return data;
  } catch (error) {
    // The site is slow at times: try again a little later
    if (attempt < 2 && (!error.response || error.response.status >= 500)) {
      await sleep(5000 * (attempt + 1));
      return getPage(site, path, attempt + 1);
    }
    throw error;
  }
}

function text(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "1:43:26" → ms; null for "DNF" or an empty cell */
function parseTime(str) {
  const m = String(str || '').match(/^(\d+):(\d\d):(\d\d)$/);
  return m ? ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 : null;
}

/** Seasons the site lists, the current one (its home page) included */
async function listSeasons(site) {
  const html = await getPage(site, '/');
  const past = [...html.matchAll(/href="\/season_(\d+)\/"/g)].map(m => Number(m[1]));
  const current = Number((html.match(/<title>[^<]*Season (\d+)/) || [])[1]);
  return [...new Set([...past, current].filter(Number.isFinite))].sort((a, b) => a - b);
}

// One side of a race: its players (anchors to their page) and their times ("1:35:01", ", 1:37:26", "DNF")
function parseSide(namesCell, timesCell) {
  const players = [...namesCell.matchAll(/players\/([^/"]+)\/"[^>]*>([^<]+)</g)].map(m => ({ slug: m[1], name: text(m[2]) }));
  const times = [...timesCell.matchAll(/<span>([^<]*)<\/span>/g)].map(m => m[1].replace(/^[,\s]+/, '').trim()).filter(Boolean);
  return { players, times: times.map(parseTime), dnf: times.some(t => /dnf|ff|forfeit/i.test(t)) };
}

/**
 * One season of a team: { slug, name, league, division, roster, matches }, each
 * match { label, opponent: { slug, name }, races: [{ result, team, opponent }] }
 * with `result` "Win", "Loss" or "Tie" for this team. null when the team did
 * not play that season.
 */
async function getTeamSeason(site, season, slug) {
  const html = await getPage(site, `/season_${season}/teams/${slug}/`);
  const tab = [...html.matchAll(/data-tab="(\d+)">Season (\d+)</g)].find(m => Number(m[2]) === season);
  if (!tab) return null;
  const start = html.search(new RegExp(`class="season(?: active)? tab-${tab[1]}"`));
  if (start < 0) return null;
  const rest = html.slice(start + 1);
  const next = rest.search(/class="season(?: active)? tab-/);
  const section = next < 0 ? rest : rest.slice(0, next);

  const name = text((html.match(new RegExp(`class="team-name tab-${tab[1]}(?: active)?">([^<]*)<`)) || [])[1]) || slug;
  const info = text((section.match(/class="season-info">([\s\S]*?)<table/) || [])[1]);
  const league = (info.match(/League:\s*(.+?)\s+Division:/) || [])[1] || null;
  const division = (info.match(/Division:\s*(.+?)\s+Season Score:/) || [])[1] || null;
  // The roster cards come before the matches table
  const roster = [...section.slice(0, Math.max(0, section.indexOf('class="stats"'))).matchAll(/players\/([^/"]+)\/"[^>]*>[\s\S]*?class="card-name">([^<]+)</g)]
    .map(m => ({ slug: m[1], name: text(m[2]) }));

  const matches = [];
  for (const [, body] of section.matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)) {
    const label = text((body.match(/class="event"[^>]*>([\s\S]*?)<\/td>/) || [])[1]);
    const opponentLink = body.match(/teams\/([a-z0-9_]+)\/"[^>]*>([^<]*)</);
    const races = [];
    for (const [, row] of body.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
      const vs = cells.findIndex(c => text(c) === 'vs');
      if (vs < 3) continue;
      races.push({
        result: text(cells[vs - 3]) || null,
        team: parseSide(cells[vs - 2], cells[vs - 1]),
        opponent: parseSide(cells[vs + 1] || '', cells[vs + 2] || '')
      });
    }
    if (label && opponentLink && races.length) {
      matches.push({ label, opponent: { slug: opponentLink[1], name: text(opponentLink[2]) }, races });
    }
  }
  return { slug, name, league, division, roster, matches };
}

/** Teams of a season, read from their pages */
async function getSeason(site, season) {
  const html = await getPage(site, `/season_${season}/teams/`);
  const slugs = [...new Set([...html.matchAll(/href="\/(?:season_\d+\/)?teams\/([a-z0-9_]+)\/"/g)].map(m => m[1]))];
  const teams = [];
  for (const slug of slugs) {
    const team = await getTeamSeason(site, season, slug);
    if (team) teams.push(team);
  }
  return teams;
}

module.exports = { SITES, listSeasons, getSeason, getTeamSeason, parseTime };
