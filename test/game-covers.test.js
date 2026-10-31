const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { COVERS_DIR, coverUrl, pngSize } = require('../helpers/game-covers');

test('pngSize reads the size from the PNG header', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAQgAAAFgCAYAAAA', 'base64');
  assert.deepEqual(pngSize(png), { width: 264, height: 352 });
});

test('pngSize refuses what is not a PNG', () => {
  assert.equal(pngSize(Buffer.from('GIF89a, not a PNG at all.')), null);
  assert.equal(pngSize(Buffer.alloc(4)), null);
});

test('coverUrl points to the cover in assets/covers, null without one', () => {
  const [file] = fs.readdirSync(COVERS_DIR).filter(f => /^[a-z0-9-]+\.png$/.test(f));
  assert.equal(coverUrl(file.slice(0, -4).toUpperCase()), `/assets/covers/${file}`);
  assert.equal(coverUrl('no-such-game'), null);
  assert.equal(coverUrl(''), null);
});

test('coverUrl stays in the covers folder', () => {
  assert.equal(coverUrl('../icon-512'), null);
  assert.equal(coverUrl('..'), null);
});
