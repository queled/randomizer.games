const test = require('node:test');
const assert = require('node:assert/strict');
const { AudienceSalt } = require('../models');
const { isBot, deviceOf, browserOf, dayOf, referrerOf, describeView } = require('../services/audience');

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

test('robots and scripts are not visitors', () => {
  assert.equal(isBot(CHROME), false);
  assert.equal(isBot(IPHONE), false);
  assert.equal(isBot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), true);
  assert.equal(isBot('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36'), true);
  assert.equal(isBot('Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'), true);
  assert.equal(isBot('curl/8.5.0'), true);
  assert.equal(isBot(''), true);
});

test('device and browser come from the user agent', () => {
  assert.equal(deviceOf(CHROME), 'desktop');
  assert.equal(deviceOf(IPHONE), 'mobile');
  assert.equal(deviceOf(ANDROID_TABLET), 'tablet');
  assert.equal(browserOf(CHROME), 'Chrome');
  assert.equal(browserOf(IPHONE), 'Safari');
  assert.equal(browserOf(`${CHROME} Edg/141.0.0.0`), 'Edge');
  assert.equal(browserOf('Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 Firefox/144.0'), 'Firefox');
});

test('days are counted in Paris time', () => {
  assert.equal(dayOf(new Date('2026-11-02T22:30:00Z')), '2026-11-02');
  assert.equal(dayOf(new Date('2026-11-02T23:30:00Z')), '2026-11-03');
});

test('only another site counts as a referrer', () => {
  assert.equal(referrerOf('https://www.google.com/', 'randomizer.games'), 'google.com');
  assert.equal(referrerOf('https://randomizer.games/games', 'randomizer.games'), null);
  assert.equal(referrerOf('https://www.randomizer.games/', 'randomizer.games'), null);
  assert.equal(referrerOf('', 'randomizer.games'), null);
});

test('a page view keeps the page, not the visitor', async (t) => {
  t.mock.method(AudienceSalt, 'updateOne', async () => ({}));
  t.mock.method(AudienceSalt, 'findOne', () => ({ lean: async () => ({ salt: 'a'.repeat(64) }) }));
  const at = new Date('2026-11-02T10:00:00Z');
  const base = { referrer: 'https://www.google.com/search', ip: '203.0.113.5', userAgent: CHROME, at, siteHost: 'randomizer.games', source: 'browser' };

  const view = await describeView({ ...base, pathname: '/fr/games/example?tab=history' });
  assert.equal(view.path, '/games/example');
  assert.equal(view.page, 'game-detail');
  assert.equal(view.lang, 'fr');
  assert.equal(view.referrer, 'google.com');
  assert.match(view.visitor, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(view).includes('203.0.113.5'));

  // Same browser the same day: same visitor; another browser: another one
  assert.equal((await describeView({ ...base, pathname: '/' })).visitor, view.visitor);
  assert.notEqual((await describeView({ ...base, pathname: '/', userAgent: IPHONE })).visitor, view.visitor);

  assert.equal(await describeView({ ...base, pathname: '/api/games' }), null);
  assert.equal(await describeView({ ...base, pathname: '/admin/' }), null);
  assert.equal(await describeView({ ...base, pathname: '/', userAgent: 'Googlebot/2.1' }), null);
});
