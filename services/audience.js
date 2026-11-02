// Site audience, measured without cookies and without a third party.
// Each page view is stored with a visitor id that is a hash of the address and
// browser salted with a random value of the day: the salt is dropped after two
// days, so a visitor can be counted within a day but never followed across days
// or traced back to an address. Page views themselves expire after 13 months.

const crypto = require('crypto');
const { PageView, AudienceSalt } = require('../models');
const { parseSitePath } = require('../helpers/site-routes');

const TIME_ZONE = 'Europe/Paris';

// Robots, link previews and scripts: a browser user agent never contains these
const BOT_AGENT = /bot\b|bot\/|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|embedly|discord|telegram|whatsapp|skype|curl|wget|python|axios|node-fetch|undici|go-http|java\/|okhttp|httpclient|libwww|scrapy|phantom|puppeteer|playwright|selenium|monitor|uptime|pingdom|feedfetcher|mediapartners|yandex|baidu|semrush|ahrefs|mj12|petalbot|bytespider|gptbot|chatgpt|claude|anthropic|perplexity|ccbot|amazonbot|applebot|googleother|google-extended/i;

function isBot(userAgent) {
  return !userAgent || !/^Mozilla\//.test(userAgent) || BOT_AGENT.test(userAgent);
}

function deviceOf(userAgent) {
  if (/iPad|Tablet|Android(?!.*Mobile)/i.test(userAgent)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android/i.test(userAgent)) return 'mobile';
  return 'desktop';
}

function browserOf(userAgent) {
  if (/Edg(e|A|iOS)?\//.test(userAgent)) return 'Edge';
  if (/OPR\/|Opera/.test(userAgent)) return 'Opera';
  if (/SamsungBrowser/.test(userAgent)) return 'Samsung Internet';
  if (/Firefox|FxiOS/.test(userAgent)) return 'Firefox';
  if (/Chrome|CriOS|Chromium/.test(userAgent)) return 'Chrome';
  if (/Safari/.test(userAgent)) return 'Safari';
  return 'Autre';
}

// The calendar day in Paris, "2026-11-02"
function dayOf(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE }).format(date);
}

const saltCache = new Map();

async function saltOf(day) {
  if (saltCache.has(day)) return saltCache.get(day);
  // Two processes may create the salt of a new day at once: the unique index
  // keeps the first, and both read it back
  await AudienceSalt.updateOne(
    { day },
    { $setOnInsert: { salt: crypto.randomBytes(32).toString('hex') } },
    { upsert: true }
  ).catch((error) => { if (error.code !== 11000) throw error; });
  const { salt } = await AudienceSalt.findOne({ day }).lean();
  saltCache.clear();
  saltCache.set(day, salt);
  return salt;
}

async function visitorOf(ip, userAgent, at) {
  const salt = await saltOf(dayOf(at));
  return crypto.createHash('sha256').update(`${salt}|${ip}|${userAgent}`).digest('hex').slice(0, 16);
}

// Only the host of another site is kept ("www.google.com" -> "google.com")
function referrerOf(referrer, siteHost) {
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, '').toLowerCase();
    return host && host !== siteHost.replace(/^www\./, '') ? host : null;
  } catch {
    return null;
  }
}

/**
 * The page view behind an address and a request, or null when it should not
 * count (not a page of the site, robot).
 */
async function describeView({ pathname, referrer, ip, userAgent, at, siteHost, source }) {
  if (isBot(userAgent)) return null;
  const route = parseSitePath(String(pathname || '').split('?')[0]);
  if (!route || route.redirect) return null;
  return {
    at,
    path: route.path,
    page: route.file.slice(1, -'.html'.length),
    lang: route.lang,
    visitor: await visitorOf(ip, userAgent, at),
    referrer: referrerOf(referrer, siteHost),
    device: deviceOf(userAgent),
    browser: browserOf(userAgent),
    source
  };
}

async function recordView(input) {
  const view = await describeView({ ...input, source: 'browser' });
  if (view) await PageView.create(view);
  return view;
}

function top(match, field, limit) {
  return PageView.aggregate([
    { $match: { ...match, [field]: { $ne: null } } },
    { $group: { _id: `$${field}`, views: { $sum: 1 }, visitors: { $addToSet: { $concat: [{ $dateToString: { date: '$at', format: '%Y-%m-%d', timezone: TIME_ZONE } }, '$visitor'] } } } },
    { $project: { _id: 0, key: '$_id', views: 1, visits: { $size: '$visitors' } } },
    { $sort: { visits: -1, views: -1 } },
    { $limit: limit }
  ]);
}

// Visits: one per visitor and day, since the visitor id changes every day
async function totals(match) {
  const [row] = await PageView.aggregate([
    { $match: match },
    { $group: { _id: { day: { $dateToString: { date: '$at', format: '%Y-%m-%d', timezone: TIME_ZONE } }, visitor: '$visitor' }, views: { $sum: 1 } } },
    { $group: { _id: null, visits: { $sum: 1 }, views: { $sum: '$views' }, bounces: { $sum: { $cond: [{ $eq: ['$views', 1] }, 1, 0] } } } }
  ]);
  return { visits: row?.visits || 0, views: row?.views || 0, bounces: row?.bounces || 0 };
}

/**
 * The audience of the last `days` days, and of the days before for comparison
 */
async function summarize(days, now = new Date()) {
  const from = new Date(now.getTime() - days * 86400000);
  const before = new Date(from.getTime() - days * 86400000);
  const match = { at: { $gte: from, $lte: now } };

  const [current, previous, daily, pages, pageTypes, referrers, langs, devices, browsers, live, first] = await Promise.all([
    totals(match),
    totals({ at: { $gte: before, $lt: from } }),
    PageView.aggregate([
      { $match: match },
      { $group: { _id: { day: { $dateToString: { date: '$at', format: '%Y-%m-%d', timezone: TIME_ZONE } }, visitor: '$visitor' }, views: { $sum: 1 } } },
      { $group: { _id: '$_id.day', visits: { $sum: 1 }, views: { $sum: '$views' } } },
      { $project: { _id: 0, day: '$_id', visits: 1, views: 1 } },
      { $sort: { day: 1 } }
    ]),
    top(match, 'path', 20),
    top(match, 'page', 20),
    top(match, 'referrer', 15),
    top(match, 'lang', 10),
    top(match, 'device', 5),
    top(match, 'browser', 10),
    PageView.distinct('visitor', { at: { $gte: new Date(now.getTime() - 5 * 60000) } }),
    PageView.findOne().sort({ at: 1 }).select('at').lean()
  ]);

  return {
    days,
    from,
    to: now,
    firstViewAt: first?.at || null,
    liveVisitors: live.length,
    current,
    previous,
    daily,
    pages,
    pageTypes,
    referrers,
    langs,
    devices,
    browsers
  };
}

module.exports = { isBot, deviceOf, browserOf, dayOf, referrerOf, describeView, recordView, summarize };
