// What the search engines' crawlers fetch, day by day: Search Console tells what
// Google shows, not what it explored. Only crawlers whose address resolves back to
// the engine count (helpers/search-crawlers.js): many scanners call themselves
// Googlebot.

const { isVerifiedCrawler } = require('../helpers/search-crawlers');
const { parseSitePath } = require('../helpers/site-routes');

const ENGINES = [
  ['google', /Googlebot|Google-InspectionTool/i],
  ['bing', /bingbot/i],
  ['apple', /Applebot/i]
];

function engineOf(userAgent) {
  return ENGINES.find(([, pattern]) => pattern.test(userAgent || ''))?.[0] || null;
}

// A site page, an API call made while rendering one, or anything else
function kindOf(pathname) {
  if (pathname.startsWith('/api/')) return 'api';
  try {
    const route = parseSitePath(pathname);
    return route && !route.redirect ? 'page' : 'other';
  } catch {
    return 'other';
  }
}

// Google dates its figures in Pacific time: the same days, side by side
function dayOf(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(date);
}

async function recordCrawl(CrawlerDay, req, now = new Date()) {
  const engine = engineOf(req.get('user-agent'));
  if (!engine || !(await isVerifiedCrawler(req))) return;
  const kind = kindOf(req.path);
  const update = { $inc: { [kind === 'page' ? 'pages' : kind]: 1 }, $setOnInsert: { at: now } };
  if (kind === 'page') update.$addToSet = { paths: req.path };
  await CrawlerDay.updateOne({ day: dayOf(now), engine }, update, { upsert: true });
}

// Counted after the answer: a crawler never waits for it
function crawlLogger(CrawlerDay) {
  return (req, res, next) => {
    if (engineOf(req.get('user-agent'))) {
      recordCrawl(CrawlerDay, req).catch((error) => console.error('Crawl log failed:', error.message));
    }
    next();
  };
}

// A visitor sent by Google Search (google.com, google.fr…), as the audience records it
const GOOGLE_REFERRER = /^google\.[a-z.]+$/;

/**
 * The last `days` days, in Google's days: what each verified crawler fetched, the
 * distinct pages over the whole period, and the visits that came from Google
 * (PageView, the site's own audience), to set beside Search Console.
 */
async function summarize({ CrawlerDay, PageView }, days, now = new Date()) {
  const from = dayOf(new Date(now.getTime() - (days - 1) * 86400000));
  const [daily, totals, visits] = await Promise.all([
    CrawlerDay.aggregate([
      { $match: { day: { $gte: from } } },
      { $project: { _id: 0, day: 1, engine: 1, pages: 1, api: 1, other: 1, distinct: { $size: { $ifNull: ['$paths', []] } } } },
      { $sort: { day: 1, engine: 1 } }
    ]),
    CrawlerDay.aggregate([
      { $match: { day: { $gte: from } } },
      { $project: { engine: 1, pages: 1, paths: { $ifNull: ['$paths', []] } } },
      { $group: { _id: '$engine', pages: { $sum: '$pages' }, paths: { $push: '$paths' } } },
      { $project: { _id: 0, engine: '$_id', pages: 1, distinct: { $size: { $reduce: { input: '$paths', initialValue: [], in: { $setUnion: ['$$value', '$$this'] } } } } } }
    ]),
    // One visit per visitor and day, as in the audience; days a little over the
    // period are dropped by the day filter
    PageView.aggregate([
      { $match: { at: { $gte: new Date(now.getTime() - (days + 1) * 86400000) }, referrer: GOOGLE_REFERRER } },
      { $group: { _id: { day: { $dateToString: { date: '$at', format: '%Y-%m-%d', timezone: 'America/Los_Angeles' } }, visitor: '$visitor' } } },
      { $group: { _id: '$_id.day', visits: { $sum: 1 } } },
      { $match: { _id: { $gte: from } } },
      { $project: { _id: 0, day: '$_id', visits: 1 } },
      { $sort: { day: 1 } }
    ])
  ]);
  const first = await CrawlerDay.findOne().sort({ day: 1 }).select('day').lean();
  return { from, to: dayOf(now), since: first?.day || null, daily, totals, googleVisits: visits };
}

module.exports = { engineOf, kindOf, dayOf, recordCrawl, crawlLogger, summarize };
