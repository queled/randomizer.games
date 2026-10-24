// Game histories: public/data/history/<id>.json, read by the game page's History tab.
// The admin edits them in place, in the same layout as the hand-written files.
const fs = require('fs/promises');
const path = require('path');

const HISTORY_DIR = path.join(__dirname, '..', 'public', 'data', 'history');
const LANGUAGES = ['fr', 'en', 'es', 'de', 'it', 'pt'];

function historyPath(gameId) {
  const id = String(gameId || '').toLowerCase();
  if (!/^[a-z0-9-]+$/.test(id)) {
    throw Object.assign(new Error('Invalid game id'), { status: 400 });
  }
  return path.join(HISTORY_DIR, `${id}.json`);
}

// A text in several languages, as { fr, en, ... } in the site's language order.
// A plain string stays a string (a date such as "2005" reads the same in every language).
function normalizeLocalized(value) {
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object') return null;
  const out = {};
  for (const lang of LANGUAGES) {
    const text = typeof value[lang] === 'string' ? value[lang].trim() : '';
    if (text) out[lang] = text;
  }
  return Object.keys(out).length ? out : null;
}

function normalizeHistory(input) {
  if (!input || typeof input !== 'object') {
    throw Object.assign(new Error('History must be an object'), { status: 400 });
  }
  const history = {};
  const intro = normalizeLocalized(input.intro);
  if (intro) history.intro = intro;

  history.events = (Array.isArray(input.events) ? input.events : [])
    .map(event => {
      const out = {};
      const date = normalizeLocalized(event?.date);
      const title = normalizeLocalized(event?.title);
      const text = normalizeLocalized(event?.text);
      if (date) out.date = date;
      if (title) out.title = title;
      if (text) out.text = text;
      return out;
    })
    .filter(event => event.title || event.text);

  history.sources = (Array.isArray(input.sources) ? input.sources : [])
    .map(source => ({
      label: String(source?.label || '').trim(),
      url: String(source?.url || '').trim()
    }))
    .filter(source => source.label && source.url);
  for (const source of history.sources) {
    if (!/^https?:\/\//i.test(source.url)) {
      throw Object.assign(new Error(`Invalid source URL: ${source.url}`), { status: 400 });
    }
  }

  if (!history.events.length) {
    throw Object.assign(new Error('A history needs at least one event'), { status: 400 });
  }
  return history;
}

async function readHistory(gameId) {
  try {
    return JSON.parse(await fs.readFile(historyPath(gameId), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Written to a temporary file then renamed, so the page never reads half a file
async function writeHistory(gameId, input) {
  const history = normalizeHistory(input);
  const file = historyPath(gameId);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
  return history;
}

async function deleteHistory(gameId) {
  try {
    await fs.unlink(historyPath(gameId));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// A game whose id changes keeps its history, unless a file already has the new id
async function renameHistory(oldId, newId) {
  if (await readHistory(newId)) return;
  try {
    await fs.rename(historyPath(oldId), historyPath(newId));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

module.exports = { LANGUAGES, normalizeHistory, readHistory, writeHistory, deleteHistory, renameHistory };
