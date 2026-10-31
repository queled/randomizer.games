// Search engine crawlers render the pages, and each page calls the API
// several times from a handful of addresses: the API rate limit would answer
// them 429 and they would index empty pages. A crawler is trusted only when
// its address resolves back to the engine's domain (and that name to the same
// address), as Google and Bing document; a user agent alone can be faked.

const dns = require('dns').promises;

const CRAWLER_UA = /Googlebot|Google-InspectionTool|bingbot|Applebot/i;
const CRAWLER_HOST = /\.(googlebot\.com|google\.com|search\.msn\.com|applebot\.apple\.com)$/i;
const CACHE_TTL = 24 * 60 * 60 * 1000;
const CACHE_MAX = 5000;

const verified = new Map();

async function lookUp(ip) {
  try {
    const [host] = await dns.reverse(ip);
    if (!host || !CRAWLER_HOST.test(host)) return false;
    const { address } = await dns.lookup(host, { family: ip.includes(':') ? 6 : 4 });
    return address === ip;
  } catch {
    return false;
  }
}

async function isVerifiedCrawler(req) {
  if (!CRAWLER_UA.test(req.get('user-agent') || '')) return false;
  const ip = String(req.ip || '').replace(/^::ffff:/, '');
  if (!ip) return false;

  const cached = verified.get(ip);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const result = await lookUp(ip);
  if (verified.size >= CACHE_MAX) verified.delete(verified.keys().next().value);
  verified.set(ip, { result, expiresAt: Date.now() + CACHE_TTL });
  return result;
}

module.exports = { isVerifiedCrawler, CRAWLER_UA, CRAWLER_HOST };
