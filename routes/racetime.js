const express = require('express');
const axios = require('axios');
const router = express.Router();
const { getRacetimeProfile, racetimeUserIdFrom } = require('../services/racetime-profile');

const MAX_SEARCH_LENGTH = 100;
const MAX_HTML_BYTES = 2 * 1024 * 1024;

// Find a user page from racetime search by query (returns JSON { url })
router.get('/find', async (req, res) => {
  const q = String(req.query.q || req.query.name || '').trim().slice(0, MAX_SEARCH_LENGTH);
  if (!q) return res.status(400).json({ error: 'missing q' });
  try {
    const s = await axios.get('https://racetime.gg/search?q=' + encodeURIComponent(q), {
      timeout: 8000,
      maxRedirects: 0,
      maxContentLength: MAX_HTML_BYTES,
      responseType: 'text'
    });
    const text = typeof s.data === 'string' ? s.data : '';

    // Parse all user links and prefer an exact (case-insensitive) match on the displayed name
    const userLinkRe = /<a\b[^>]*href=['"](\/user\/[^'"]+)['"][^>]*>([\s\S]*?)<\/a>/ig;
    const nameRe = /<span[^>]*class=["']name["'][^>]*>([^<]+)<\/span>/i;
    let m;
    const candidates = [];
    while ((m = userLinkRe.exec(text)) !== null) {
      const href = m[1];
      const inner = m[2] || '';
      const nm = inner.match(nameRe);
      const displayName = nm && nm[1] ? nm[1].trim() : null;
      candidates.push({ href, displayName });
    }

    if (candidates.length) {
      const qnorm = q.toLowerCase();
      const pick = candidates.find(c => c.displayName && c.displayName.toLowerCase() === qnorm)
        || candidates.find(c => c.displayName && c.displayName.toLowerCase().startsWith(qnorm))
        || candidates.find(c => c.displayName && c.displayName.toLowerCase().includes(qnorm))
        || candidates[0];
      const userId = racetimeUserIdFrom(pick && pick.href);
      if (userId) {
        return res.json({ url: 'https://racetime.gg' + pick.href.split(/[?#]/)[0] });
      }
    }
  } catch (e) {
    // ignore
  }
  // Return 200 with null url when not found to avoid 404 in client network logs
  return res.json({ url: null });
});

// Twitch channel of a racetime account, from its profile (JSON API)
// Returns JSON: { twitch: 'https://www.twitch.tv/chan' } or { twitch: null }
router.get('/twitch', async (req, res, next) => {
  try {
    const userId = racetimeUserIdFrom(req.query.url || req.query.id);
    if (!userId) return res.status(400).json({ error: 'missing url or id' });
    const profile = await getRacetimeProfile(userId);
    res.json({ twitch: profile?.twitch ? `https://www.twitch.tv/${encodeURIComponent(profile.twitch)}` : null });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
