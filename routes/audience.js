/**
 * Page views sent by the public pages (public/js/footer.js), counted in the
 * Audience tab of the admin. See services/audience.js.
 */

const express = require('express');
const router = express.Router();
const { recordView } = require('../services/audience');

const SITE_HOST = new URL(process.env.SITE_URL || 'https://randomizer.games').host;

/**
 * POST /api/seen { path, referrer }
 */
router.post('/', async (req, res) => {
  // Always answered at once: the page does not wait for it
  res.status(204).end();
  // The admin's own browsing is not audience
  if (req.cookies?.adminSession) return;
  const { path, referrer } = req.body || {};
  if (typeof path !== 'string' || path.length > 300) return;
  try {
    await recordView({
      pathname: path,
      referrer: typeof referrer === 'string' ? referrer.slice(0, 500) : '',
      ip: req.ip,
      userAgent: String(req.get('user-agent') || '').slice(0, 500),
      at: new Date(),
      siteHost: SITE_HOST
    });
  } catch (error) {
    console.error('Audience: page view not saved:', error.message);
  }
});

module.exports = router;
