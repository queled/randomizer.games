/**
 * Community APWorlds list
 *
 * The Archipelago community keeps a spreadsheet of the worlds playable outside
 * the core install (maintained by Scipio, mirrored by the Archipelago wiki's
 * Game Support Tracker). Its "Playable Worlds" tab has one row per game:
 * stability, PR status, 18+ / unrated flag, then a links cell (APWorld,
 * releases, PopTracker…), a setup guide and a support thread (Discord).
 *
 * The CSV export drops the links: the sheet is read from its xlsx export,
 * which keeps one link per cell. An xlsx file is a zip of XML files, read here
 * with zlib alone.
 */

const zlib = require('zlib');
const axios = require('axios');

const SHEET_ID = '1iuzDTOAvdoNe8Ne8i461qGNucg5OuEoF-Ikqs8aUQZw';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
const TAB = 'Playable Worlds';
const MIN_ROWS = 500;

const STATUS = { stable: 'stable', unstable: 'unstable', 'broken on main': 'broken' };

// Files of a zip archive, by name
function unzip(buffer) {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('archive zip illisible');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + size);
    files.set(name, method === 8 ? zlib.inflateRawSync(data) : data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const decodeXml = s => String(s || '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const attr = (tag, name) => decodeXml((tag.match(new RegExp(`\\s${name}="([^"]*)"`)) || [])[1] || '') || null;

// Text of an <si> / <is> element: its runs put together
const runText = xml => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => decodeXml(m[1])).join('');

/**
 * Rows of a sheet: { [column letter]: { text, url } } by row number. A cell's
 * url is its link, with the link's anchor ("location") when it has one.
 */
function readSheet(files, tabName) {
  const read = name => files.get(name)?.toString('utf8') || '';
  const workbook = read('xl/workbook.xml');
  const sheetTag = [...workbook.matchAll(/<sheet\s[^>]*>/g)].map(m => m[0]).find(tag => attr(tag, 'name') === tabName);
  if (!sheetTag) throw new Error(`onglet « ${tabName} » absent`);
  const rels = new Map([...read('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\s[^>]*>/g)]
    .map(m => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  const path = `xl/${rels.get(attr(sheetTag, 'r:id')).replace(/^\/?xl\//, '')}`;
  const sheet = read(path);
  const sheetRels = new Map([...read(path.replace(/([^/]+)$/, '_rels/$1.rels')).matchAll(/<Relationship\s[^>]*>/g)]
    .map(m => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  const shared = [...read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => runText(m[1]));

  const rows = new Map();
  const cell = ref => {
    const [, column, row] = ref.match(/^([A-Z]+)(\d+)$/);
    if (!rows.has(+row)) rows.set(+row, {});
    const cells = rows.get(+row);
    return (cells[column] = cells[column] || { text: '', url: null });
  };
  for (const [, tag, body] of sheet.matchAll(/<c(\s[^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const type = attr(tag, 't');
    const value = (body || '').match(/<v>([\s\S]*?)<\/v>/)?.[1];
    let text = '';
    if (type === 's') text = shared[Number(value)] || '';
    else if (type === 'inlineStr') text = runText(body || '');
    else if (value !== undefined) text = decodeXml(value);
    cell(attr(tag, 'r')).text = text.trim();
  }
  for (const [tag] of sheet.matchAll(/<hyperlink\s[^>]*>/g)) {
    const target = sheetRels.get(attr(tag, 'r:id'));
    if (!target) continue;
    const location = attr(tag, 'location');
    cell(attr(tag, 'ref')).url = location ? `${target}#${location}` : target;
  }
  return rows;
}

/**
 * Games of the list: { name, status (stable / unstable / broken), pr, mature,
 * links: { label, url }, guide, support, notes }. Throws when the sheet cannot
 * be read or holds far fewer rows than usual, so that a broken export never
 * reads as "every world was removed".
 */
async function fetchCommunityWorlds() {
  const { data } = await axios.get(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`, {
    timeout: 60000,
    responseType: 'arraybuffer',
    headers: { 'User-Agent': 'RandomizerWebsite/1.0' }
  });
  const rows = readSheet(unzip(Buffer.from(data)), TAB);

  // Columns by header, the header row being the one that starts with "Game"
  const headerRow = [...rows.entries()].find(([, cells]) => cells.A?.text === 'Game');
  if (!headerRow) throw new Error('ligne d’en-tête introuvable');
  const columns = {};
  for (const [column, { text }] of Object.entries(headerRow[1])) columns[text.toLowerCase()] = column;
  const col = (cells, header) => cells[columns[header]] || { text: '', url: null };

  const worlds = [];
  for (const [row, cells] of rows) {
    if (row <= headerRow[0]) continue;
    const name = cells.A?.text;
    if (!name || name.length > 120) continue;
    const stability = col(cells, 'stability').text.toLowerCase();
    if (!STATUS[stability]) continue; // section headers, notes
    worlds.push({
      name,
      status: STATUS[stability],
      pr: col(cells, 'pr status').text,
      mature: /^(1|true)$/i.test(col(cells, '18+ / unrated').text),
      links: col(cells, 'links & downloads'),
      guide: col(cells, 'setup guides'),
      support: col(cells, 'support'),
      notes: col(cells, 'notes').text
    });
  }
  if (worlds.length < MIN_ROWS) {
    throw new Error(`${worlds.length} jeux lus dans le tableur (au moins ${MIN_ROWS} attendus)`);
  }
  return worlds;
}

module.exports = { SHEET_URL, fetchCommunityWorlds, readSheet, unzip };
