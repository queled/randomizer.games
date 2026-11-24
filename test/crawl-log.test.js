const test = require('node:test');
const assert = require('node:assert/strict');
const { engineOf, kindOf, dayOf } = require('../services/crawl-log');

test('crawl log: the engine comes from the user agent', () => {
  assert.equal(engineOf('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), 'google');
  assert.equal(engineOf('Mozilla/5.0 (compatible; Google-InspectionTool/1.0)'), 'google');
  assert.equal(engineOf('Mozilla/5.0 (compatible; bingbot/2.0)'), 'bing');
  assert.equal(engineOf('Mozilla/5.0 (Macintosh) Safari/605.1.15'), null);
  assert.equal(engineOf(undefined), null);
});

test('crawl log: site pages, API calls and the rest', () => {
  assert.equal(kindOf('/'), 'page');
  assert.equal(kindOf('/fr/games/example'), 'page');
  assert.equal(kindOf('/tournaments'), 'page');
  assert.equal(kindOf('/api/games/example'), 'api');
  assert.equal(kindOf('/robots.txt'), 'other');
  assert.equal(kindOf('/js/app.js'), 'other');
  // A redirect is not a page
  assert.equal(kindOf('/games/'), 'other');
});

test('crawl log: days are Google days, in Pacific time', () => {
  assert.equal(dayOf(new Date('2030-01-02T07:00:00Z')), '2030-01-01');
  assert.equal(dayOf(new Date('2030-01-02T09:00:00Z')), '2030-01-02');
});
