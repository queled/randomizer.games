const test = require('node:test');
const assert = require('node:assert/strict');
const { pngSize } = require('../helpers/game-covers');

test('pngSize reads the size from the PNG header', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAQgAAAFgCAYAAAA', 'base64');
  assert.deepEqual(pngSize(png), { width: 264, height: 352 });
});

test('pngSize refuses what is not a PNG', () => {
  assert.equal(pngSize(Buffer.from('GIF89a, not a PNG at all.')), null);
  assert.equal(pngSize(Buffer.alloc(4)), null);
});
