// IndexNow (Bing, Yandex, Seznam, Naver…): the site tells these engines which of its
// pages are new or changed instead of waiting for them to crawl the sitemap. Google
// does not take part; it keeps reading the sitemap.

// A key is 8 to 128 letters, digits or dashes; the engines fetch it at /<key>.txt
// to check that the submitter owns the site
const isIndexNowKey = (key) => /^[a-zA-Z0-9-]{8,128}$/.test(String(key || ''));

// <loc> and <lastmod> of each <url> (or <sitemap>) of a sitemap file
function parseSitemap(xml) {
  const entries = [];
  for (const [, block] of String(xml).matchAll(/<(?:url|sitemap)>([\s\S]*?)<\/(?:url|sitemap)>/g)) {
    const loc = block.match(/<loc>([^<]+)<\/loc>/)?.[1]?.trim();
    if (!loc) continue;
    const lastmod = block.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1]?.trim() || null;
    entries.push({ loc: loc.replace(/&amp;/g, '&'), lastmod });
  }
  return entries;
}

/**
 * The pages to submit: all of them the first time, then those changed since the
 * day of the last submission (a page without date is sent only the first time).
 */
function pagesToSubmit(entries, lastSubmittedAt) {
  if (!lastSubmittedAt) return entries.map((e) => e.loc);
  const since = new Date(lastSubmittedAt).toISOString().slice(0, 10);
  return entries.filter((e) => e.lastmod && e.lastmod.slice(0, 10) >= since).map((e) => e.loc);
}

// IndexNow takes at most 10,000 URLs per request
function chunk(list, size = 10000) {
  const chunks = [];
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
  return chunks;
}

module.exports = { isIndexNowKey, parseSitemap, pagesToSubmit, chunk };
