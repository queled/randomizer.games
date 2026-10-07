// Shared rules for deciding which races and tournaments belong to a game.
// Used by the game pages, their stats, and the races/tournaments filters so all agree.

const CATEGORY_ALIASES = {
  'oot': ['oot', 'ootr'],
  'alttp': ['alttp', 'alttpr', 'alttpr-ladder'],
  'mm': ['mm', 'mmr'],
  'sm': ['sm', 'smr'],
  'sm64': ['sm64'],
  'tww': ['tww'],
  'dk64': ['dk64', 'dk64r'],
  'tp': ['tp'],
  'kh2fm': ['kh2fm', 'kh2r', 'kh2fmr'],
  'sotn': ['sotn'],
  'smz3': ['smz3'],
  'ootmm': ['ootmm'],
  'z1': ['z1', 'z1r'],
  'z2': ['z2', 'z2r']
};

const GAME_NAME_PATTERNS = {
  'oot': /ocarina\s*(of)?\s*time/i,
  'alttp': /link\s*(to)?\s*(the)?\s*past/i,
  'mm': /majora'?s?\s*mask/i,
  'sm': /super\s*metroid/i,
  'sm64': /super\s*mario\s*64/i,
  'dk64': /donkey\s*kong\s*64/i,
  'tww': /wind\s*waker/i,
  'tp': /twilight\s*princess/i,
  'kh2fm': /kingdom\s*hearts\s*(2|ii)/i,
  'sotn': /symphony\s*(of)?\s*(the)?\s*night/i,
  'smz3': /(^|\W)smz3($|\W)/i,
  'ootmm': /(^|\W)ootmm(r)?($|\W)/i,
  'z1': /(^|\W)(the\s+legend\s+of\s+zelda|zelda\s*1|z1r?)($|\W)/i,
  'z2': /(^|\W)(zelda\s*ii|adventure\s+of\s+link|z2r?)($|\W)/i
};

function escapeRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getExplicitRacetimeSlugs(gameDoc) {
  const slugs = new Set();

  const primary = gameDoc?.integrations?.racetime?.gameSlug;
  const extras = Array.isArray(gameDoc?.integrations?.racetime?.gameSlugs)
    ? gameDoc.integrations.racetime.gameSlugs
    : [];

  if (primary) slugs.add(String(primary).toLowerCase().trim());
  extras.forEach(slug => {
    if (slug) slugs.add(String(slug).toLowerCase().trim());
  });

  return Array.from(slugs).filter(Boolean);
}

function buildCategoryResolutionContext(games) {
  const explicitSlugOwners = new Map();
  const allGameIds = new Set();

  for (const game of games || []) {
    const gameId = String(game?.id || '').toLowerCase().trim();
    if (!gameId) continue;

    allGameIds.add(gameId);
    const explicitSlugs = getExplicitRacetimeSlugs(game);

    for (const slug of explicitSlugs) {
      if (!explicitSlugOwners.has(slug)) {
        explicitSlugOwners.set(slug, new Set());
      }
      explicitSlugOwners.get(slug).add(gameId);
    }
  }

  return { explicitSlugOwners, allGameIds };
}

function buildCategoryQuery(gameDoc, gameIdLower, resolutionContext = { explicitSlugOwners: new Map(), allGameIds: new Set() }) {
  const explicitSlugs = getExplicitRacetimeSlugs(gameDoc);
  const explicitSet = new Set(explicitSlugs);

  const categories = new Set();
  categories.add(gameIdLower);
  categories.add(`${gameIdLower}r`);

  const aliases = CATEGORY_ALIASES[gameIdLower] || [];
  aliases.forEach(c => categories.add(String(c).toLowerCase()));
  explicitSlugs.forEach(c => categories.add(String(c).toLowerCase()));

  for (const category of Array.from(categories)) {
    if (!category) {
      categories.delete(category);
      continue;
    }

    const owners = resolutionContext.explicitSlugOwners.get(category);
    if (owners && !owners.has(gameIdLower) && !explicitSet.has(category)) {
      categories.delete(category);
      continue;
    }

    const isOtherGameId = resolutionContext.allGameIds.has(category) && category !== gameIdLower;
    if (isOtherGameId && !explicitSet.has(category)) {
      categories.delete(category);
    }
  }

  const all = Array.from(categories).filter(Boolean);
  if (all.length === 0) {
    return { category: '__no_matching_category__' };
  }
  if (all.length === 1) {
    return { category: all[0] };
  }
  return { category: { $in: all } };
}

function buildTournamentQuery(gameDoc, gameIdLower) {
  const gamePattern = GAME_NAME_PATTERNS[gameIdLower];
  const conditions = [];

  if (gameDoc?._id) {
    conditions.push({ game: gameDoc._id });
  }

  if (gamePattern) {
    conditions.push({ gameName: { $regex: gamePattern } });
  }

  const candidateNames = [
    gameDoc?.name,
    gameDoc?.official?.name,
    gameDoc?.randomizer?.displayName,
    gameDoc?.randomizer?.shortName
  ].filter(Boolean);

  candidateNames.forEach(name => {
    conditions.push({ gameName: { $regex: new RegExp(escapeRegex(name), 'i') } });
  });

  if (conditions.length === 0) {
    return {};
  }

  return { $or: conditions };
}

module.exports = {
  CATEGORY_ALIASES,
  GAME_NAME_PATTERNS,
  escapeRegex,
  getExplicitRacetimeSlugs,
  buildCategoryResolutionContext,
  buildCategoryQuery,
  buildTournamentQuery
};
