const express = require('express');
const router = express.Router();
const { getRacetimeProfile, racetimeUserIdFrom, relayRacetimeImage, TWITCH_LOGIN_PATTERN } = require('../services/racetime-profile');

// Browsers keep an avatar an hour: a new racetime avatar shows up within the
// profile refresh delay (services/racetime-profile.js) plus this hour.
const AVATAR_CACHE_CONTROL = 'public, max-age=3600';

/**
 * GET /api/avatar?racetime=<user id or profile URL>&twitch=<login>
 * The player's racetime avatar, else their Twitch avatar (redirect), else 204
 * so the page keeps its placeholder.
 */
router.get('/', async (req, res, next) => {
  try {
    const userId = racetimeUserIdFrom(req.query.racetime);
    const requestedTwitch = String(req.query.twitch || '').trim().toLowerCase();
    let twitch = TWITCH_LOGIN_PATTERN.test(requestedTwitch) ? requestedTwitch : null;

    if (userId) {
      let profile = await getRacetimeProfile(userId);
      if (profile?.avatarUrl && await relayRacetimeImage(profile.avatarUrl, res, { cacheControl: AVATAR_CACHE_CONTROL })) return;
      if (profile?.avatarUrl) {
        // The stored avatar no longer loads: the player has likely changed it
        profile = await getRacetimeProfile(userId, { force: true });
        if (profile?.avatarUrl && await relayRacetimeImage(profile.avatarUrl, res, { cacheControl: AVATAR_CACHE_CONTROL })) return;
      }
      twitch = twitch || profile?.twitch || null;
    }

    res.setHeader('Cache-Control', AVATAR_CACHE_CONTROL);
    if (twitch) return res.redirect(302, `/api/streams/twitch-avatar/${encodeURIComponent(twitch)}`);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

module.exports = router;
