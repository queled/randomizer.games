const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { period, shapeRow, totalOf, sitemapCounts, assertion, property } = require('../services/search-console');

test('the period ends today and counts the days asked, in Google\'s time zone', () => {
  assert.deepEqual(period(7, new Date('2025-03-10T20:00:00Z')), { startDate: '2025-03-04', endDate: '2025-03-10' });
  // Early morning in UTC is still the day before in Pacific time
  assert.deepEqual(period(1, new Date('2025-03-10T03:00:00Z')), { startDate: '2025-03-09', endDate: '2025-03-09' });
});

test('rows keep their first key and a rounded position, none without impressions', () => {
  assert.deepEqual(shapeRow({ keys: ['some words'], clicks: 2, impressions: 10, position: 12.3456 }), { key: 'some words', clicks: 2, impressions: 10, position: 12.3 });
  assert.equal(shapeRow({ keys: ['2025-03-10'], clicks: 0, impressions: 0, position: 0 }).position, null);
});

test('the total position is averaged over the impressions', () => {
  const rows = [{ clicks: 1, impressions: 30, position: 2 }, { clicks: 0, impressions: 10, position: 10 }, { clicks: 0, impressions: 0, position: null }];
  assert.deepEqual(totalOf(rows), { clicks: 1, impressions: 40, position: 4 });
  assert.deepEqual(totalOf([]), { clicks: 0, impressions: 0, position: null });
});

test('sitemap counts add the web pages of every sitemap, images apart', () => {
  const sitemaps = [
    { errors: '0', lastDownloaded: '2025-03-01T10:00:00Z', contents: [{ type: 'web', submitted: '100', indexed: '40' }, { type: 'image', submitted: '30', indexed: '5' }] },
    { errors: '2', lastDownloaded: '2025-03-04T10:00:00Z', contents: [{ type: 'web', submitted: '20', indexed: '1' }] }
  ];
  assert.deepEqual(sitemapCounts(sitemaps), { submitted: 120, indexed: 41, errors: 2, lastDownloaded: '2025-03-04T10:00:00Z' });
  assert.deepEqual(sitemapCounts(undefined), { submitted: 0, indexed: 0, errors: 0, lastDownloaded: null });
});

test('the token request is signed by the account for an hour of read access', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const account = { client_email: 'reader@example.test', token_uri: 'https://example.test/token', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const [header, claims, signature] = assertion(account, 1700000000000).split('.');
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')), {
    iss: 'reader@example.test', scope: 'https://www.googleapis.com/auth/webmasters.readonly', aud: 'https://example.test/token', iat: 1700000000, exp: 1700003600
  });
  assert.ok(crypto.createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, 'base64url')));
});

test('the property is the domain of the site unless one is set', (t) => {
  const saved = { site: process.env.SITE_URL, property: process.env.SEARCH_CONSOLE_SITE };
  t.after(() => {
    for (const [name, value] of [['SITE_URL', saved.site], ['SEARCH_CONSOLE_SITE', saved.property]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  delete process.env.SEARCH_CONSOLE_SITE;
  process.env.SITE_URL = 'https://www.example.test/';
  assert.equal(property(), 'sc-domain:example.test');
  process.env.SEARCH_CONSOLE_SITE = 'https://example.test/';
  assert.equal(property(), 'https://example.test/');
});
