// Google Search Console, read with a service account: what people searched to
// see the site in Google, which pages were shown, and how much of the sitemap is
// indexed. The account is added as a user of the property in Search Console and
// its JSON key stays out of the repository (GOOGLE_SEARCH_CONSOLE_KEY_FILE).

const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');

const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const API = 'https://www.googleapis.com/webmasters/v3';
const TIMEOUT = 10000;
// Google refreshes these figures a few times a day at most
const TTL = 60 * 60 * 1000;

// The property holding the site: a Domain property unless told otherwise
function property() {
  if (process.env.SEARCH_CONSOLE_SITE) return process.env.SEARCH_CONSOLE_SITE;
  const host = new URL(process.env.SITE_URL || 'https://randomizer.games').hostname.replace(/^www\./, '');
  return `sc-domain:${host}`;
}

let key;
function readKey() {
  if (key !== undefined) return key;
  try {
    const parsed = JSON.parse(fs.readFileSync(process.env.GOOGLE_SEARCH_CONSOLE_KEY_FILE, 'utf8'));
    key = parsed.client_email && parsed.private_key ? parsed : null;
  } catch {
    key = null;
  }
  return key;
}

function hasKey() {
  return Boolean(process.env.GOOGLE_SEARCH_CONSOLE_KEY_FILE && readKey());
}

// The signed request a service account trades for an access token
function assertion(account, now = Date.now()) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const iat = Math.floor(now / 1000);
  const body = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: account.client_email, scope: SCOPE, aud: account.token_uri, iat, exp: iat + 3600 })}`;
  return `${body}.${crypto.createSign('RSA-SHA256').update(body).sign(account.private_key).toString('base64url')}`;
}

let token = null;
async function accessToken() {
  if (token && token.expiresAt > Date.now()) return token.value;
  const account = readKey();
  const { data } = await axios.post(account.token_uri, new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: assertion(account)
  }), { timeout: TIMEOUT });
  // Renewed a minute early
  token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  return token.value;
}

async function api(method, path, body) {
  const { data } = await axios({
    method,
    url: `${API}/sites/${encodeURIComponent(property())}${path}`,
    data: body,
    headers: { Authorization: `Bearer ${await accessToken()}` },
    timeout: TIMEOUT
  });
  return data;
}

// The cheapest call telling whether the account still reads the property
async function ping() {
  await api('get', '');
}

// Google dates its figures in Pacific time, "2026-01-05"
function dayOf(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(date);
}

// The last `days` days, today included: the latest ones are partial or still empty
function period(days, now = new Date()) {
  return { startDate: dayOf(new Date(now.getTime() - (days - 1) * 86400000)), endDate: dayOf(now) };
}

function shapeRow(row) {
  return {
    key: row.keys ? row.keys[0] : null,
    clicks: row.clicks || 0,
    impressions: row.impressions || 0,
    position: row.impressions ? Math.round(row.position * 10) / 10 : null
  };
}

// The total of the period, with the position averaged over the impressions
function totalOf(rows) {
  const clicks = rows.reduce((sum, row) => sum + row.clicks, 0);
  const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
  const weighted = rows.reduce((sum, row) => sum + (row.position || 0) * row.impressions, 0);
  return { clicks, impressions, position: impressions ? Math.round(10 * weighted / impressions) / 10 : null };
}

// Pages of the sitemaps Google was given, and how many of them it indexed
function sitemapCounts(sitemaps) {
  const web = (sitemaps || []).flatMap((sitemap) => sitemap.contents || []).filter((content) => content.type === 'web');
  return {
    submitted: web.reduce((sum, content) => sum + Number(content.submitted || 0), 0),
    indexed: web.reduce((sum, content) => sum + Number(content.indexed || 0), 0),
    errors: (sitemaps || []).reduce((sum, sitemap) => sum + Number(sitemap.errors || 0), 0),
    lastDownloaded: (sitemaps || []).map((sitemap) => sitemap.lastDownloaded).filter(Boolean).sort().at(-1) || null
  };
}

async function query(range, dimension, rowLimit) {
  const data = await api('post', '/searchAnalytics/query', { ...range, dimensions: [dimension], rowLimit, dataState: 'all' });
  const rows = (data.rows || []).map(shapeRow);
  // Days in order, the rest by what was shown most
  return dimension === 'date'
    ? rows.sort((a, b) => a.key.localeCompare(b.key))
    : rows.sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks);
}

const cache = new Map();

/**
 * Google Search over the last `days` days: totals, days, queries, pages,
 * countries and the sitemap. { configured: false } without a key.
 */
async function summarize(days, now = new Date()) {
  if (!hasKey()) return { configured: false };
  const hit = cache.get(days);
  if (hit && hit.expiresAt > now.getTime()) return hit.value;

  const range = period(days, now);
  const [daily, queries, pages, countries, sitemaps] = await Promise.all([
    query(range, 'date', 500),
    query(range, 'query', 20),
    query(range, 'page', 20),
    query(range, 'country', 10),
    api('get', '/sitemaps')
  ]);
  const value = {
    configured: true,
    property: property(),
    ...range,
    total: totalOf(daily),
    daily,
    queries,
    pages,
    countries,
    sitemap: sitemapCounts(sitemaps.sitemap),
    fetchedAt: now
  };
  cache.set(days, { value, expiresAt: now.getTime() + TTL });
  return value;
}

module.exports = { hasKey, ping, summarize, property, period, shapeRow, totalOf, sitemapCounts, assertion };
