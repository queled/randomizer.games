const express = require('express');
const router = express.Router();
const { validateProxyUrl } = require('../middleware/security');

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

router.get('/', validateProxyUrl, async (req, res) => {
  const imageUrl = req.query.url;
  
  // Check cache
  const cached = imageCache.get(imageUrl);
  if (cached && cached.expires > Date.now()) {
    res.set('Content-Type', cached.contentType);
    res.set('Cache-Control', 'public, max-age=300');
    return res.send(cached.buffer);
  }

  try {
    const response = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RandomizerBot/1.0)'
      },
      timeout: 10000 // 10 second timeout
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Failed to fetch image' });
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    
    // Validate image size (max 5MB)
    if (buffer.length > 5 * 1024 * 1024) {
      return res.status(413).json({ error: 'Image too large' });
    }
    
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    
    // Validate content type
    if (!contentType.startsWith('image/')) {
      return res.status(400).json({ error: 'Invalid content type' });
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
    res.status(500).json({ error: 'Failed to proxy image' });
  }
});

module.exports = router;
