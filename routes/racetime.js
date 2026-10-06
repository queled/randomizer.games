const express = require('express');
const axios = require('axios');
const router = express.Router();

const RACETIME_HOST = 'racetime.gg';

function isAllowedRacetimeHost(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  return normalized === RACETIME_HOST || normalized.endsWith('.' + RACETIME_HOST);
}

function normalizeAllowedRacetimeUrl(rawUrl, { requireUserPath = false } = {}) {
  try {
    const parsed = new URL(rawUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    if (!isAllowedRacetimeHost(parsed.hostname)) return null;

    const pathname = parsed.pathname.replace(/\/+$/, '');
    if (requireUserPath && !/^\/user\/[^/]+(?:\/[^/]+)?$/i.test(pathname)) {
      return null;
    }

    return `https://${RACETIME_HOST}${pathname}${parsed.search}`;
  } catch (e) {
    return null;
  }
}

function normalizeRacetimeMediaUrl(urlOrPath) {
  const raw = String(urlOrPath || '').trim().replace(/^['\"]|['\"]$/g, '');
  if (!raw) return null;

  if (raw.startsWith('//')) {
    return normalizeAllowedRacetimeUrl('https:' + raw);
  }

  if (raw.startsWith('/')) {
    return normalizeAllowedRacetimeUrl(`https://${RACETIME_HOST}${raw}`);
  }

  if (/^https?:\/\//i.test(raw)) {
    return normalizeAllowedRacetimeUrl(raw);
  }

  return null;
}

function normalizeBase(urlOrId){
  const raw = String(urlOrId || '').trim();
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) {
    return normalizeAllowedRacetimeUrl(raw, { requireUserPath: true });
  }

  if (raw.startsWith('/user/')) {
    return normalizeAllowedRacetimeUrl(`https://${RACETIME_HOST}${raw}`, { requireUserPath: true });
  }

  if (/^user\//i.test(raw)) {
    return normalizeAllowedRacetimeUrl(`https://${RACETIME_HOST}/${raw}`, { requireUserPath: true });
  }

  if (!/^[A-Za-z0-9_-]+$/.test(raw)) {
    return null;
  }

  return `https://${RACETIME_HOST}/user/${encodeURIComponent(raw)}`;
}

router.get('/avatar', async (req, res) => {
  const { url, id } = req.query;
  const base = normalizeBase(url || id);
  if (!base) return res.status(400).json({ error: 'missing url or id' });

  // Prefer parsing the profile HTML first (og:image / background-image / /media/)
  // so we can detect explicit media avatars. Only if no candidate is found
  // we'll fall back to the simple `/avatar` endpoint.
  const rtAvatar = base + '/avatar';

  // 2) Fetch profile HTML and try to extract image, but only from the user's profile block
  try {
    const r = await axios.get(base, { timeout: 8000, headers: { Accept: 'text/html,application/xhtml+xml' } });
    const text = r.data || '';

    // Try og:image first (site may provide a canonical profile image)
    const og = text.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i);
    if (og && og[1]){
      const imgUrl = og[1];
      try{
        const streamRes = await axios.get(imgUrl, { responseType: 'stream', timeout: 10000 });
        res.setHeader('Content-Type', streamRes.headers['content-type'] || 'image/*');
        if (streamRes.headers['cache-control']) res.setHeader('Cache-Control', streamRes.headers['cache-control']);
        return streamRes.data.pipe(res);
      }catch(e){ /* fallthrough */ }
    }

    // If a name param is provided, try to find the avatar closest to that name
    const queryName = (req.query.name || '').trim();
    if (queryName) {
      // Search for a user-pop block that contains the matching name and extract avatar only from that block
      const escaped = queryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const nameInnerRe = new RegExp('<span[^>]*class=["\']name["\'][^>]*>\\s*' + escaped + '\\s*<\\/span>', 'i');
      const userPopRe = /<(a|span)[^>]*class=["']?[^"'>]*user-pop[^"'>]*["']?[^>]*>([\s\S]*?)<\/(?:a|span)>/ig;
      let m;
      let matchedUserPop = false;
      while ((m = userPopRe.exec(text)) !== null) {
        const block = m[0];
        if (nameInnerRe.test(block)) {
          matchedUserPop = true;
          // found the block for this user; look for avatar inside it
          const bgMatch = block.match(/background-image\s*:\s*url\(([^)]+)\)/i);
          if (bgMatch && bgMatch[1]){
            const urlcandidate = normalizeRacetimeMediaUrl(bgMatch[1]);
            if (!urlcandidate) return res.status(400).json({ error: 'invalid avatar source' });
            try{
              const streamRes = await axios.get(urlcandidate, { responseType: 'stream', timeout: 10000 });
              res.setHeader('Content-Type', streamRes.headers['content-type'] || 'image/*');
              if (streamRes.headers['cache-control']) res.setHeader('Cache-Control', streamRes.headers['cache-control']);
              return streamRes.data.pipe(res);
            }catch(e){ /* fallthrough */ }
          }
          const mediaMatch = block.match(/https?:\/\/racetime\.gg\/media\/[^"'\)\s>]+/i) || block.match(/\/media\/[^"'\)\s>]+/i);
          if (mediaMatch && mediaMatch[0]){
            const murl = normalizeRacetimeMediaUrl(mediaMatch[0]);
            if (!murl) return res.status(400).json({ error: 'invalid avatar source' });
            try{
              const streamRes = await axios.get(murl, { responseType: 'stream', timeout: 10000 });
              res.setHeader('Content-Type', streamRes.headers['content-type'] || 'image/*');
              if (streamRes.headers['cache-control']) res.setHeader('Cache-Control', streamRes.headers['cache-control']);
              return streamRes.data.pipe(res);
            }catch(e){ /* fallthrough */ }
          }
          break; // don't search other user-pop blocks
        }
      }
      if (matchedUserPop) {
        // We found the user's block but no avatar within it — do not pick images from elsewhere
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        // Return 204 No Content to avoid 404 entries in client network console
        return res.status(204).end();
      }
    }

    // Extract a slice around the user-profile section to avoid picking unrelated avatars
    const upIndex = text.indexOf('<div class="user-profile"');
    const slice = upIndex >= 0 ? text.slice(upIndex, upIndex + 4000) : text.slice(0, 4000);

    // Try background-image within profile slice
    const bgMatch = slice.match(/background-image\s*:\s*url\(([^)]+)\)/i);
    if (bgMatch && bgMatch[1]){
      const urlcandidate = normalizeRacetimeMediaUrl(bgMatch[1]);
      if (!urlcandidate) return res.status(400).json({ error: 'invalid avatar source' });
      try{
        const streamRes = await axios.get(urlcandidate, { responseType: 'stream', timeout: 10000 });
        res.setHeader('Content-Type', streamRes.headers['content-type'] || 'image/*');
        if (streamRes.headers['cache-control']) res.setHeader('Cache-Control', streamRes.headers['cache-control']);
        return streamRes.data.pipe(res);
      }catch(e){ /* fallthrough */ }
    }

    // Try /media/ occurrences inside profile slice
    const mediaMatch = slice.match(/https?:\/\/racetime\.gg\/media\/[^"'\)\s>]+/i) || slice.match(/\/media\/[^"'\)\s>]+/i);
    if (mediaMatch && mediaMatch[0]){
      const m = normalizeRacetimeMediaUrl(mediaMatch[0]);
      if (!m) return res.status(400).json({ error: 'invalid avatar source' });
      try{
        const streamRes = await axios.get(m, { responseType: 'stream', timeout: 10000 });
        res.setHeader('Content-Type', streamRes.headers['content-type'] || 'image/*');
        if (streamRes.headers['cache-control']) res.setHeader('Cache-Control', streamRes.headers['cache-control']);
        return streamRes.data.pipe(res);
      }catch(e){ /* fallthrough */ }
    }
  } catch (e) {
    // ignore
  }

  // If we couldn't find an explicit profile avatar, return 204 so the client can choose a fallback
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  return res.status(204).end();
});

// Find a user page from racetime search by query (returns JSON { url })
router.get('/find', async (req, res) => {
  const q = req.query.q || req.query.name;
  if (!q) return res.status(400).json({ error: 'missing q' });
  try {
    const s = await axios.get('https://racetime.gg/search?q=' + encodeURIComponent(q), { timeout: 8000 });
    const text = s.data || '';

    // Parse all user links and prefer an exact (case-insensitive) match on the displayed name
    const userLinkRe = /<a\b[^>]*href=['"](\/user\/[^'\"]+)['"][^>]*>([\s\S]*?)<\/a>/ig;
    const nameRe = /<span[^>]*class=["']name["'][^>]*>([^<]+)<\/span>/i;
    let m;
    let candidates = [];
    while ((m = userLinkRe.exec(text)) !== null) {
      const href = m[1];
      const inner = m[2] || '';
      const nm = inner.match(nameRe);
      const displayName = nm && nm[1] ? nm[1].trim() : null;
      candidates.push({ href, displayName });
    }

    if (candidates.length) {
      const qnorm = q.trim().toLowerCase();
      // Try exact match
      let pick = candidates.find(c => c.displayName && c.displayName.toLowerCase() === qnorm);
      if (!pick) {
        // Try startsWith
        pick = candidates.find(c => c.displayName && c.displayName.toLowerCase().startsWith(qnorm));
      }
      if (!pick) {
        // Try includes
        pick = candidates.find(c => c.displayName && c.displayName.toLowerCase().includes(qnorm));
      }
      if (!pick) {
        // Fallback to first candidate
        pick = candidates[0];
      }
      if (pick && pick.href) {
        let url = pick.href;
        if (url.startsWith('/')) url = 'https://racetime.gg' + url;
        return res.json({ url });
      }
    }
  } catch (e) {
    // ignore
  }
  // Return 200 with null url when not found to avoid 404 in client network logs
  return res.json({ url: null });
});

// Lightweight check: does this racetime profile contain an explicit avatar?
router.get('/has-avatar', async (req, res) => {
  const { url, id, name } = req.query;
  const base = normalizeBase(url || id);
  if (!base) return res.status(400).json({ error: 'missing url or id' });
  try {
    const r = await axios.get(base, { timeout: 8000, headers: { Accept: 'text/html,application/xhtml+xml' } });
    const text = r.data || '';

    // og:image
    const og = text.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i);
    if (og && og[1]) return res.json({ has: true });

    const queryName = (name || '').trim();
    if (queryName) {
      const escaped = queryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const nameInnerRe = new RegExp('<span[^>]*class=["\\\']name["\\\'][^>]*>\\s*' + escaped + '\\s*<\\/span>', 'i');
      const userPopRe = /<(a|span)[^>]*class=["']?[^"'>]*user-pop[^"'>]*["']?[^>]*>([\s\S]*?)<\/(?:a|span)>/ig;
      let m;
      while ((m = userPopRe.exec(text)) !== null) {
        const block = m[0];
        if (nameInnerRe.test(block)) {
          // found the block for this user; look for avatar indicators inside it
          if (/background-image\s*:\s*url\(/i.test(block)) return res.json({ has: true });
          if (/https?:\/\/racetime\.gg\/media\//i.test(block) || /\/media\//i.test(block)) return res.json({ has: true });
          return res.json({ has: false });
        }
      }
    }

    // inspect profile slice
    const upIndex = text.indexOf('<div class="user-profile"');
    const slice = upIndex >= 0 ? text.slice(upIndex, upIndex + 4000) : text.slice(0, 4000);
    if (/background-image\s*:\s*url\(/i.test(slice)) return res.json({ has: true });
    if (/https?:\/\/racetime\.gg\/media\//i.test(slice) || /\/media\//i.test(slice)) return res.json({ has: true });

    return res.json({ has: false });
  } catch (e) {
    return res.json({ has: false });
  }
});

// Endpoint: extract a Twitch channel URL from a Racetime profile page
// Returns JSON: { twitch: 'https://twitch.tv/chan' } or { twitch: null }
router.get('/twitch', async (req, res) => {
  const { url, id, name } = req.query;
  const base = normalizeBase(url || id);
  if (!base) return res.status(400).json({ error: 'missing url or id' });
  try {
    const r = await axios.get(base, { timeout: 8000, headers: { Accept: 'text/html,application/xhtml+xml' } });
    const text = r.data || '';

    // Look for full Twitch URLs in the profile HTML
    const twMatch = text.match(/https?:\/\/(?:www\.)?twitch\.tv\/[A-Za-z0-9_\-]+/i);
    if (twMatch && twMatch[0]) {
      const twitchUrl = twMatch[0].replace(/\/+$/, '');
      return res.json({ twitch: twitchUrl });
    }

    // Also look for anchor tags linking to twitch (href attributes)
    const hrefMatch = text.match(/href=["']([^"']*twitch\.tv[^"']*)["']/i);
    if (hrefMatch && hrefMatch[1]) {
      const href = hrefMatch[1].replace(/&amp;/g, '&');
      const full = href.match(/https?:\/\/(?:www\.)?twitch\.tv\/[A-Za-z0-9_\-]+/i);
      if (full && full[0]) return res.json({ twitch: full[0].replace(/\/+$/, '') });
    }

    return res.json({ twitch: null });
  } catch (e) {
    return res.json({ twitch: null });
  }
});

module.exports = router;
