const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const sharp = require('sharp');
const { COVERS_DIR, coverUrl, pngSize, toCoverWebp } = require('../helpers/game-covers');

test('pngSize reads the size from the PNG header', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAQgAAAFgCAYAAAA', 'base64');
  assert.deepEqual(pngSize(png), { width: 264, height: 352 });
});

test('pngSize refuses what is not a PNG', () => {
  assert.equal(pngSize(Buffer.from('GIF89a, not a PNG at all.')), null);
  assert.equal(pngSize(Buffer.alloc(4)), null);
});

test('coverUrl points to the cover in assets/covers, null without one', () => {
  const [file] = fs.readdirSync(COVERS_DIR).filter(f => /^[a-z0-9-]+\.webp$/.test(f));
  assert.equal(coverUrl(file.slice(0, -5).toUpperCase()), `/assets/covers/${file}`);
  assert.equal(coverUrl('no-such-game'), null);
  assert.equal(coverUrl(''), null);
});

test('coverUrl stays in the covers folder', () => {
  assert.equal(coverUrl('../icon-512'), null);
  assert.equal(coverUrl('..'), null);
});

test('toCoverWebp keeps every pixel of a cover already small enough', async () => {
  const pixels = Buffer.alloc(264 * 352 * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37) % 256;
  const raw = { raw: { width: 264, height: 352, channels: 3 } };
  const png = await sharp(pixels, raw).png().toBuffer();
  const webp = await toCoverWebp(png);
  const { data, info } = await sharp(webp).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.format, 'raw');
  assert.deepEqual([info.width, info.height], [264, 352]);
  assert.ok(data.equals(pixels));
});

test('toCoverWebp shrinks a large cover to twice its display size', async () => {
  const png = await sharp({ create: { width: 1440, height: 2160, channels: 3, background: '#336699' } }).png().toBuffer();
  const { width, height, format } = await sharp(await toCoverWebp(png)).metadata();
  assert.equal(format, 'webp');
  assert.deepEqual([width, height], [480, 720]);
});
