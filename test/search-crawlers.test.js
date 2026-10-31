const test = require('node:test');
const assert = require('node:assert/strict');
const dns = require('dns').promises;
const { isVerifiedCrawler, CRAWLER_HOST } = require('../helpers/search-crawlers');

const request = (ip, ua) => ({ ip, get: () => ua });

test('only the engines\' own domains count as crawler hosts', () => {
  assert.ok(CRAWLER_HOST.test('crawl-66-249-66-1.googlebot.com'));
  assert.ok(CRAWLER_HOST.test('msnbot-157-55-39-1.search.msn.com'));
  assert.ok(!CRAWLER_HOST.test('googlebot.com.example.net'));
  assert.ok(!CRAWLER_HOST.test('fakegooglebot.com'));
});

test('a crawler is trusted when its address and name match both ways', async (t) => {
  t.mock.method(dns, 'reverse', async () => ['crawl-66-249-66-2.googlebot.com']);
  t.mock.method(dns, 'lookup', async () => ({ address: '66.249.66.2' }));
  assert.equal(await isVerifiedCrawler(request('66.249.66.2', 'Mozilla/5.0 (compatible; Googlebot/2.1)')), true);
});

test('a crawler user agent from another address is not trusted', async (t) => {
  t.mock.method(dns, 'reverse', async () => ['crawl-66-249-66-3.googlebot.com']);
  t.mock.method(dns, 'lookup', async () => ({ address: '66.249.66.99' }));
  assert.equal(await isVerifiedCrawler(request('203.0.113.7', 'Googlebot/2.1')), false);
});

test('a visitor is not looked up at all', async (t) => {
  const reverse = t.mock.method(dns, 'reverse', async () => []);
  assert.equal(await isVerifiedCrawler(request('203.0.113.8', 'Mozilla/5.0 Firefox/140.0')), false);
  assert.equal(reverse.mock.callCount(), 0);
});
