/**
 * Game names shared by the syncs that tie outside game lists to the site's
 * games (archipelago.gg / multiworld.gg, community APWorlds): name keys,
 * looser forms, candidate picking, ids of new games and their enrichment.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const ROMAN = { ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10' };

// "Name A/B" and "Name A and B", "Name II" and "Name 2"
const norm = s => String(s || '')
  .normalize('NFD').replace(/\p{Diacritic}/gu, '')
  .toLowerCase()
  .replace(/\brandomi[sz]er\b|\band\b|&/g, ' ')
  .replace(/^\s*the\s+/, '')
  .replace(/\b(ii|iii|iv|vi|vii|viii|ix)\b/g, roman => ROMAN[roman])
  .replace(/[^a-z0-9]/g, '');

// "Name (Variant)" → "Name", "Name II (Beta)" → "Name II"
const withoutBrackets = s => String(s || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+beta$/i, '').trim();

const TITLE_SPLIT_RE = /\s*[:–]\s+|\s+-\s+/;
// "Series: Subtitle" → "Subtitle"
const subtitle = s => {
  const parts = String(s || '').split(TITLE_SPLIT_RE);
  return parts.length > 1 ? parts.slice(1).join(' ') : null;
};
// "Title 2: Subtitle" → "Title 2"
const mainTitle = s => {
  const parts = String(s || '').split(TITLE_SPLIT_RE);
  return parts.length > 1 ? parts[0] : null;
};

function gameNames(game) {
  const r = game.randomizer || {};
  const strip = s => (s ? String(s).replace(/\s*\brandomi[sz]er\b\s*/ig, ' ').trim() : s);
  return [
    game.name,
    game.official?.name,
    strip(r.displayName),
    strip(r.name),
    game.integrations?.randoList?.gameName,
    ...(game.integrations?.randoList?.gameNames || []),
    game.integrations?.twitch?.categoryName
  ].filter(Boolean);
}

// One game among candidates: the only one, else the one whose own name is the world's
function pickCandidate(candidates, names) {
  const list = [...(candidates || [])];
  if (list.length <= 1) return { game: list[0] || null };
  const keys = new Set(names.map(norm));
  for (const nameOf of [g => g.name, g => g.official?.name]) {
    const exact = list.filter(g => keys.has(norm(nameOf(g))));
    if (exact.length === 1) return { game: exact[0] };
  }
  return { game: null, ambiguous: list.map(g => g.id) };
}

// "Some Long Game Name" → "slgn", "Name 50" → "name50", a franchise word may have its own short form
function idCandidates(name) {
  const words = String(name)
    .replace(/^the legend of zelda\s*[:-]\s*/i, '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/'/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const slug = words.join('').toLowerCase().slice(0, 24);
  if (words.length === 1) return [slug];
  const initials = words.map(word => {
    const lower = word.toLowerCase();
    if (lower === 'pokemon') return 'pkmn';
    if (/^\d+$/.test(word)) return word;
    if (ROMAN[lower] && word === word.toUpperCase()) return ROMAN[lower];
    if (word.length >= 2 && word === word.toUpperCase()) return lower;
    return lower[0];
  }).join('');
  return initials.length >= 2 ? [initials, slug] : [slug];
}

function newGameId(name, takenIds) {
  const candidates = idCandidates(name).filter(Boolean);
  for (const id of candidates) {
    if (!takenIds.has(id)) return id;
  }
  const base = candidates[candidates.length - 1] || 'game';
  for (let n = 2; ; n++) {
    if (!takenIds.has(`${base}${n}`)) return `${base}${n}`;
  }
}

const SMALL_WORDS = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'in', 'n', 'of', 'on', 'the', 'to']);

// Short and tiny randomizer names: "Cavern of Dreams" → "CoD Randomizer" / "CoDR";
// a single word, numbered or not ("Portal 2"), keeps the id: "PORTAL2 Randomizer" / "PORTAL2"
function randomizerShortNames(name, id) {
  const words = withoutBrackets(name)
    .normalize('NFD').replace(/\p{Diacritic}/gu, '')
    .replace(/'/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (words.filter(word => !/^\d+$/.test(word)).length < 2) {
    return { shortName: `${id.toUpperCase()} Randomizer`, tinyName: id.toUpperCase() };
  }
  const initials = words.map((word, i) => {
    const lower = word.toLowerCase();
    if (lower === 'pokemon') return 'PKMN';
    if (/^\d+$/.test(word)) return word;
    if (ROMAN[lower] && word === word.toUpperCase()) return ROMAN[lower];
    if (word.length <= 3 && word.length >= 2 && word === word.toUpperCase()) return word;
    if (i > 0 && SMALL_WORDS.has(lower)) return lower[0];
    return word[0].toUpperCase();
  }).join('');
  return { shortName: `${initials} Randomizer`, tinyName: `${initials}R` };
}

function runEnrichment(ids) {
  for (const script of ['enrich-twitch.js', 'enrich-release-years.js']) {
    console.log(`\n▶ ${script} --ids ${ids.join(',')}`);
    const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', script), '--ids', ids.join(',')], {
      stdio: 'inherit',
      timeout: 5 * 60 * 1000
    });
    if (result.status !== 0) console.warn(`⚠️ ${script} : code ${result.status}`);
  }
}

module.exports = { ROMAN, norm, withoutBrackets, subtitle, mainTitle, gameNames, pickCandidate, idCandidates, newGameId, randomizerShortNames, runEnrichment };
