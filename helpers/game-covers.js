// Game covers: public/assets/<id>.png, vertical like the IGDB box art (264 × 352)
const fs = require('fs/promises');
const path = require('path');

const ASSETS_DIR = path.join(__dirname, '..', 'public', 'assets');
const HISTORY_DIR = path.join(__dirname, '..', 'public', 'data', 'history');
const MAX_BYTES = 700 * 1024;

function coverPath(gameId) {
  const id = String(gameId || '').toLowerCase();
  if (!/^[a-z0-9-]+$/.test(id)) {
    throw Object.assign(new Error('Invalid game id'), { status: 400 });
  }
  return path.join(ASSETS_DIR, `${id}.png`);
}

// Ids of the files of a folder with this extension (covers, histories)
async function idsWithFile(dir, ext) {
  try {
    return new Set((await fs.readdir(dir)).filter(f => f.endsWith(ext)).map(f => f.slice(0, -ext.length)));
  } catch {
    return new Set();
  }
}

// The Archipelago and Multiworld logos sit with the covers but are not any game's
const SITE_LOGOS = ['archipelago', 'multiworld'];

async function coverIds() {
  const ids = await idsWithFile(ASSETS_DIR, '.png');
  SITE_LOGOS.forEach(id => ids.delete(id));
  return ids;
}

const historyIds = () => idsWithFile(HISTORY_DIR, '.json');

// Width and height from the PNG header, null when the bytes are not a PNG
function pngSize(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature) || buffer.toString('ascii', 12, 16) !== 'IHDR') {
    return null;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function writeCover(gameId, dataUrl) {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match) throw Object.assign(new Error('Expected a PNG data URL'), { status: 400 });
  const buffer = Buffer.from(match[1], 'base64');
  const size = pngSize(buffer);
  if (!size) throw Object.assign(new Error('Not a PNG image'), { status: 400 });
  if (buffer.length > MAX_BYTES) throw Object.assign(new Error('Cover too large (700 KB max)'), { status: 400 });
  if (size.width > 1200 || size.height > 1600) throw Object.assign(new Error('Cover too large (1200 × 1600 max)'), { status: 400 });
  const file = coverPath(gameId);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, buffer);
  await fs.rename(tmp, file);
  return size;
}

async function deleteCover(gameId) {
  try {
    await fs.unlink(coverPath(gameId));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// A game whose id changes keeps its cover, unless a file already has the new id
async function renameCover(oldId, newId) {
  if ((await coverIds()).has(String(newId).toLowerCase())) return;
  try {
    await fs.rename(coverPath(oldId), coverPath(newId));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

module.exports = { coverIds, historyIds, pngSize, writeCover, deleteCover, renameCover };
