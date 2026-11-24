const test = require('node:test');
const assert = require('node:assert/strict');
const { isIndexNowKey, parseSitemap, pagesToSubmit, chunk } = require('../helpers/indexnow');

test('indexnow: a key is 8 to 128 letters, digits or dashes', () => {
  assert.equal(isIndexNowKey('a1b2c3d4e5f6'), true);
  assert.equal(isIndexNowKey('short'), false);
  assert.equal(isIndexNowKey('../etc/passwd'), false);
  assert.equal(isIndexNowKey(undefined), false);
});

test('indexnow: the sitemap gives each page and its date', () => {
  const xml = '<urlset><url><loc>https://example.com/a?x=1&amp;y=2</loc><lastmod>2030-01-02</lastmod></url>'
    + '<url><loc>https://example.com/b</loc></url></urlset>';
  assert.deepEqual(parseSitemap(xml), [
    { loc: 'https://example.com/a?x=1&y=2', lastmod: '2030-01-02' },
    { loc: 'https://example.com/b', lastmod: null }
  ]);
  const index = '<sitemapindex><sitemap><loc>https://example.com/sitemaps/games-1.xml</loc><lastmod>2030-01-03</lastmod></sitemap></sitemapindex>';
  assert.deepEqual(parseSitemap(index), [{ loc: 'https://example.com/sitemaps/games-1.xml', lastmod: '2030-01-03' }]);
});

test('indexnow: everything the first time, then the pages changed since that day', () => {
  const entries = [
    { loc: 'https://example.com/old', lastmod: '2030-01-01' },
    { loc: 'https://example.com/same-day', lastmod: '2030-01-05T08:00:00Z' },
    { loc: 'https://example.com/new', lastmod: '2030-01-06' },
    { loc: 'https://example.com/undated', lastmod: null }
  ];
  assert.equal(pagesToSubmit(entries, null).length, 4);
  assert.deepEqual(pagesToSubmit(entries, '2030-01-05T20:00:00Z'), ['https://example.com/same-day', 'https://example.com/new']);
});

test('indexnow: at most 10,000 pages per request', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.equal(chunk(Array.from({ length: 20001 })).length, 3);
});
