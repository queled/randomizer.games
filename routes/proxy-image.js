const express = require('express');
const router = express.Router();
const { validateProxyUrl, checkProxyUrl, isSafeImageContentType, setRelayedImageHeaders } = require('../middleware/security');

// Simple in-memory cache for proxied images
const imageCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 50; // Limit cache size to prevent memory issues

// Clean old cache entries
function cleanCache() {
  const now = Date.now();
  for (const [key, value] of imageCache.entries()) {
    if (value.expires < now) {
      imageCache.delete(key);
    }
  }
  // If still too large, remove oldest entries
  if (imageCache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(imageCache.entries())
      .sort((a, b) => a[1].expires - b[1].expires);
    const toRemove = entries.slice(0, imageCache.size - MAX_CACHE_SIZE);
    toRemove.forEach(([key]) => imageCache.delete(key));
  }
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
const FETCH_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 3;

// Read the body while counting bytes, so an oversized image is dropped
// before it is fully held in memory.
async function readCappedBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch (e) { /* ignore */ }
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

router.get('/', validateProxyUrl, async (req, res) => {
  const imageUrl = req.query.url;
  setRelayedImageHeaders(res);
  
  // Check cache
  const cached = imageCache.get(imageUrl);
  if (cached && cached.expires > Date.now()) {
    res.set('Content-Type', cached.contentType);
    res.set('Cache-Control', 'public, max-age=300');
    return res.send(cached.buffer);
  }

  try {
    // Redirects are followed by hand, and every hop is checked against the
    // same whitelist: a whitelisted host must not be able to bounce the
    // request to an internal or non-whitelisted address (SSRF).
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    let currentUrl = imageUrl;
    let response = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      response = await fetch(currentUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; RandomizerBot/1.0)',
          Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8'
        },
        redirect: 'manual',
        signal
      });

      if (response.status < 300 || response.status >= 400) break;

      const location = response.headers.get('location');
      if (!location || hop === MAX_REDIRECTS) {
        return res.status(502).json({ error: 'Too many redirects' });
      }
      let nextUrl;
      try {
        nextUrl = new URL(location, currentUrl).toString();
      } catch (e) {
        return res.status(502).json({ error: 'Invalid redirect' });
      }
      const check = checkProxyUrl(nextUrl);
      if (!check.ok) {
        return res.status(403).json({ error: 'Redirect target not allowed' });
      }
      currentUrl = check.url;
    }

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to fetch image' });
    }

    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    
    // Validate content type before downloading the body (no SVG, no HTML)
    if (!isSafeImageContentType(contentType)) {
      return res.status(415).json({ error: 'Invalid content type' });
    }

    const buffer = await readCappedBody(response, MAX_IMAGE_BYTES);
    if (!buffer) {
      return res.status(413).json({ error: 'Image too large' });
    }

    // Cache the image
    imageCache.set(imageUrl, {
      buffer,
      contentType,
      expires: Date.now() + CACHE_TTL
    });

    // Clean old cache entries periodically
    if (imageCache.size > MAX_CACHE_SIZE * 0.8) {
      cleanCache();
    }

    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=300');
    res.send(buffer);
  } catch (error) {
    console.error('Error proxying image:', error.message);
    const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    res.status(timedOut ? 504 : 500).json({ error: 'Failed to proxy image' });
  }
});

module.exports = router;
