const { Game, Tournament, Race } = require('../models');

/**
 * Merging two games of the site into one, and changing a game's id.
 *
 * A merge keeps the target game and deletes the source: the source's resources join the
 * target's (no duplicate URL), and what the target lacks (official site, media, release
 * date, integrations, categories) is taken from the source. The source's racetime.gg
 * categories become additional categories of the target, so its races, whose category
 * is a racetime.gg slug, stay as they are. The source's rando-list names are kept in
 * integrations.randoList.gameNames, so the rando-list sync keeps their sites on the
 * target and stops reporting them as new games.
 */

const RESOURCE_LISTS = ['sites', 'trackers', 'guides', 'other'];
const INTEGRATIONS = ['speedrun', 'twitch', 'startgg', 'challonge'];

function isEmpty(value) {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function mergeResources(target, source) {
  if (!target.resources) target.resources = {};
  const from = source.resources || {};
  let count = 0;

  if (!target.resources.officialSite?.url && from.officialSite?.url) {
    target.resources.officialSite = from.officialSite;
    count++;
  }

  for (const list of RESOURCE_LISTS) {
    if (!from[list]?.length) continue;
    if (!target.resources[list]) target.resources[list] = [];
    const urls = new Set(target.resources[list].map(r => r.url));
    for (const item of from[list]) {
      if (urls.has(item.url)) continue;
      const { _id, ...rest } = item.toObject ? item.toObject() : item;
      target.resources[list].push(rest);
      urls.add(item.url);
      count++;
    }
  }

  target.markModified('resources');
  return count;
}

function mergeRacetime(target, source) {
  const from = source.integrations?.racetime;
  if (!from?.gameSlug) return;
  const to = target.integrations.racetime;

  if (!to?.gameSlug) {
    target.integrations.racetime = from;
    return;
  }

  const slugs = new Set([to.gameSlug, ...(to.gameSlugs || [])]);
  for (const slug of [from.gameSlug, ...(from.gameSlugs || [])]) {
    if (!slugs.has(slug)) {
      to.gameSlugs = [...(to.gameSlugs || []), slug];
      slugs.add(slug);
    }
  }
  for (const [slug, filter] of from.goalFilters || []) {
    if (!to.goalFilters) to.goalFilters = new Map();
    if (!to.goalFilters.has(slug)) to.goalFilters.set(slug, filter);
  }
  to.enabled = to.enabled || from.enabled;
}

function mergeRandoList(target, source) {
  const from = source.integrations?.randoList || {};
  const to = target.integrations.randoList || (target.integrations.randoList = {});

  if (!to.gameName && from.gameName) {
    to.gameName = from.gameName;
    to.seriesFile = to.seriesFile || from.seriesFile;
  }
  // The source's names, so that the rando-list sync still recognizes them
  const names = [from.gameName, ...(from.gameNames || []), source.name, source.official?.name];
  const known = new Set([to.gameName, ...(to.gameNames || [])].filter(Boolean));
  for (const name of names) {
    if (!name || known.has(name)) continue;
    to.gameNames = [...(to.gameNames || []), name];
    known.add(name);
  }
  to.enabled = to.enabled || from.enabled;
}

function mergeCategories(target, source) {
  const ids = new Set((target.categories || []).map(c => c.id));
  for (const category of source.categories || []) {
    if (ids.has(category.id)) continue;
    const { _id, ...rest } = category.toObject ? category.toObject() : category;
    target.categories.push(rest);
    ids.add(category.id);
  }
  if (!target.categorySettings?.length && source.categorySettings?.length) {
    target.categorySettings = source.categorySettings;
  }
}

/**
 * Merges the game sourceId into targetId and deletes it.
 * Returns the number of resources added to the target.
 */
async function mergeGames(targetId, sourceId) {
  if (sourceId === targetId) throw Object.assign(new Error('Cannot merge a game with itself'), { status: 400 });

  const [target, source] = await Promise.all([
    Game.findOne({ id: targetId }),
    Game.findOne({ id: sourceId })
  ]);
  if (!target) throw Object.assign(new Error('Target game not found'), { status: 404 });
  if (!source) throw Object.assign(new Error(`Source game "${sourceId}" not found`), { status: 404 });

  const mergedResources = mergeResources(target, source);

  for (const field of ['platforms', 'logo', 'image', 'series']) {
    if (isEmpty(target[field]) && !isEmpty(source[field])) target[field] = source[field];
  }
  for (const field of ['name', 'releaseDate', 'releaseYear', 'website']) {
    if (isEmpty(target.official?.[field]) && !isEmpty(source.official?.[field])) {
      target.set(`official.${field}`, source.official[field]);
    }
  }
  for (const field of ['website', 'opensource', 'addedDate', 'updatedDate']) {
    if (isEmpty(target.randomizer?.[field]) && !isEmpty(source.randomizer?.[field])) {
      target.set(`randomizer.${field}`, source.randomizer[field]);
    }
  }

  if (!target.integrations) target.integrations = {};
  mergeRacetime(target, source);
  mergeRandoList(target, source);
  for (const name of INTEGRATIONS) {
    const from = source.integrations?.[name];
    if (from?.enabled && !target.integrations[name]?.enabled) target.integrations[name] = from;
  }
  target.markModified('integrations');
  mergeCategories(target, source);

  await target.save();

  await Tournament.updateMany(
    { $or: [{ gameId: sourceId }, { gameSlug: sourceId }, { game: source._id }] },
    { $set: { gameId: targetId, gameSlug: targetId, game: target._id } }
  );

  await Game.deleteOne({ _id: source._id });
  return { mergedResources };
}

/**
 * Changes a game's id (immutable in the schema) and the tournaments that point to it.
 */
async function changeGameId(oldId, newId) {
  if (await Game.exists({ id: newId })) {
    throw Object.assign(new Error(`A game with ID "${newId}" already exists`), { status: 409 });
  }
  const game = await Game.findOne({ id: oldId });
  if (!game) throw Object.assign(new Error('Game not found'), { status: 404 });

  await Game.collection.updateOne({ _id: game._id }, { $set: { id: newId } });
  await Tournament.updateMany({ gameId: oldId }, { $set: { gameId: newId } });
  await Tournament.updateMany({ gameSlug: oldId }, { $set: { gameSlug: newId } });
  // Races whose category is the game's id rather than a racetime.gg slug
  const slugs = [game.integrations?.racetime?.gameSlug, ...(game.integrations?.racetime?.gameSlugs || [])];
  if (!slugs.includes(oldId)) {
    await Race.updateMany({ category: oldId }, { $set: { category: newId } });
  }
}

module.exports = { mergeGames, changeGameId };
