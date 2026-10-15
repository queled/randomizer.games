const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const path = require('path');
const connectDB = require('./config/database');
const { Game, Tournament, Player, Race } = require('./models');
const seoPages = require('./services/seo-pages');
const { 
  apiLimiter, 
  mediaLimiter,
  searchLimiter,
  validatePagination,
  errorHandler,
  mongoSanitize
} = require('./middleware/security');
require('dotenv').config({ quiet: true });

const app = express();
const PORT = process.env.PORT || 3000;
const SITEMAP_CACHE_TTL = 30 * 60 * 1000;
// A sitemap file holds at most 50,000 URLs; stay well below
const SITEMAP_MAX_URLS = 40000;
const SITE_URL = (process.env.SITE_URL || 'https://randomizer.games').replace(/\/+$/, '');
let sitemapCache = { files: null, expiresAt: 0, inFlight: null };

function xmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatLastMod(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

function buildSitemapEntry(loc, lastmod) {
  const safeLoc = `${SITE_URL}${loc}`;
  const lastmodTag = lastmod ? `<lastmod>${xmlEscape(lastmod)}</lastmod>` : '';
  return `<url><loc>${xmlEscape(safeLoc)}</loc>${lastmodTag}</url>`;
}

function buildUrlset(entries) {
  const urls = entries.map(([loc, lastmod]) => buildSitemapEntry(loc, lastmod)).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
}

/**
 * Every sitemap file by name: "sitemap.xml" is the index, the others
 * ("sitemaps/players-1.xml"...) hold the URLs of one kind of page.
 */
async function generateSitemaps() {
  const staticEntries = [
    ['/', null],
    ['/games.html', null],
    ['/races.html', null],
    ['/tournaments.html', null],
    ['/players.html', null],
    ['/streams.html', null],
    ['/resources.html', null],
    ['/about.html', null],
    ['/terms.html', null]
  ];

  const [games, tournaments, players, races] = await Promise.all([
    Game.find({ enabled: { $ne: false } }).select('id updatedAt').sort({ updatedAt: -1 }).lean(),
    Tournament.find({}).select('_id updatedAt').sort({ updatedAt: -1 }).lean(),
    // Accounts deleted from racetime leave the player lists, and the sitemap
    Player.find({
      $or: [{ userId: { $exists: true, $ne: '' } }, { name: { $exists: true, $ne: '' } }],
      racetimeDeletedAt: null
    })
      .select('userId name updatedAt')
      .sort({ updatedAt: -1 })
      .lean(),
    // Most recent races only: older ones are reached through players and tournaments
    Race.find({}).select('_id updatedAt startedAt').sort({ startedAt: -1, updatedAt: -1 }).limit(1000).lean()
  ]);

  const groups = {
    pages: staticEntries,
    games: games.filter((game) => game?.id)
      .map((game) => [`/game-detail.html?id=${encodeURIComponent(game.id)}`, formatLastMod(game.updatedAt)]),
    tournaments: tournaments.filter((tournament) => tournament?._id)
      .map((tournament) => [`/tournament-detail.html?id=${encodeURIComponent(String(tournament._id))}`, formatLastMod(tournament.updatedAt)]),
    players: players.map((player) => {
      const identifier = player?.userId
        ? `id=${encodeURIComponent(player.userId)}`
        : (player?.name ? `name=${encodeURIComponent(player.name)}` : '');
      return identifier ? [`/player-detail.html?${identifier}`, formatLastMod(player.updatedAt)] : null;
    }).filter(Boolean),
    races: races.filter((race) => race?._id)
      .map((race) => [`/race-detail.html?id=${encodeURIComponent(String(race._id))}`, formatLastMod(race.updatedAt || race.startedAt)])
  };

  const files = new Map();
  for (const [name, entries] of Object.entries(groups)) {
    for (let part = 0; part * SITEMAP_MAX_URLS < entries.length; part++) {
      const chunk = entries.slice(part * SITEMAP_MAX_URLS, (part + 1) * SITEMAP_MAX_URLS);
      const lastmod = chunk.map(([, date]) => date).filter(Boolean).sort().pop() || '';
      files.set(`sitemaps/${name}-${part + 1}.xml`, { xml: buildUrlset(chunk), lastmod });
    }
  }

  const index = Array.from(files, ([file, { lastmod }]) => (
    `<sitemap><loc>${xmlEscape(`${SITE_URL}/${file}`)}</loc>${lastmod ? `<lastmod>${xmlEscape(lastmod)}</lastmod>` : ''}</sitemap>`
  )).join('');
  files.set('sitemap.xml', {
    xml: `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${index}</sitemapindex>`
  });
  return files;
}

async function getSitemapCached(name) {
  if (!sitemapCache.files || sitemapCache.expiresAt <= Date.now()) {
    if (!sitemapCache.inFlight) {
      sitemapCache.inFlight = generateSitemaps()
        .then((files) => {
          sitemapCache.files = files;
          sitemapCache.expiresAt = Date.now() + SITEMAP_CACHE_TTL;
          return files;
        })
        .finally(() => {
          sitemapCache.inFlight = null;
        });
    }
    await sitemapCache.inFlight;
  }
  return sitemapCache.files.get(name)?.xml || null;
}

// Trust proxy (important for rate limiting behind reverse proxy)
app.set('trust proxy', 1);

// Security middleware
app.use(helmet());

// CORS configuration - restrict in production
const corsOptions = {
  origin: process.env.NODE_ENV === 'production' 
    ? [
        'https://randomizer.games',
        'https://www.randomizer.games',
        // HTTPS subdomains only, anchored on both ends
        /^https:\/\/([a-z0-9-]+\.)+randomizer\.games$/
      ]
    : '*',
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

app.use(compression());

// Cookie parser for admin sessions
app.use(cookieParser());

app.use(express.json({ 
  limit: '1mb' // Prevent payload attacks
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// MongoDB injection protection (after the body parsers, so it sees the body)
app.use(mongoSanitize);

// Adjust CSP and Permissions-Policy to avoid browser warnings when served via tunnels
// Allow blob: for images (used by some browsers when loading blobs) and set a
// conservative Permissions-Policy to avoid unrecognized-feature warnings.
app.use((req, res, next) => {
  try {
    // Content Security Policy: scripts only from our own files. Inline
    // scripts and inline event handlers (onclick=, onerror=...) are refused,
    // so markup injected through third-party data (race goals, tournament or
    // player names) cannot run code. Pages use data-* attributes instead
    // (see public/js/ui-events.js and the admin dispatcher).
    // Inline styles stay allowed: the templates rely on style="" attributes.
    const csp = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; connect-src 'self'; img-src 'self' data: blob:; script-src 'self'; script-src-attr 'none'; style-src 'self' 'unsafe-inline';";
    res.setHeader('Content-Security-Policy', csp);

    // Permissions-Policy: define a minimal, widely-supported set to avoid browser warnings
    // (features set to () disable them). This avoids sending newer/unrecognized tokens.
    const perms = 'geolocation=(), microphone=(), camera=(), display-capture=()';
    res.setHeader('Permissions-Policy', perms);
  } catch (e) {
    // if headers cannot be set for some reason, ignore and continue
  }
  next();
});

// Search engines show the favicon next to results: serve the real icon, a
// square PNG whose side is a multiple of 48 px as Google asks.
app.get('/favicon.ico', (req, res) => {
  res.type('image/png');
  res.sendFile(path.join(__dirname, 'public', 'assets', 'favicon-48.png'), { maxAge: '7d' });
});

// One URL per page: /index.html duplicates the home page.
app.get('/index.html', (req, res) => {
  const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  res.redirect(301, `/${query}`);
});

// Public pages get their title, description, canonical, social and JSON-LD
// tags rendered on the server so crawlers that skip JavaScript see them.
app.get(['/', '/:page.html'], async (req, res, next) => {
  try {
    const page = await seoPages.renderPage(req.path, req.query, SITE_URL);
    if (!page) return next();
    res.status(page.status);
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(page.html);
  } catch (error) {
    next(error);
  }
});

app.get(['/sitemap.xml', '/sitemaps/:file.xml'], async (req, res, next) => {
  try {
    const xml = await getSitemapCached(req.params.file ? `sitemaps/${req.params.file}.xml` : 'sitemap.xml');
    if (!xml) return next();
    res.type('application/xml');
    res.send(xml);
  } catch (error) {
    next(error);
  }
});

// Serve static files. Images rarely change, so browsers may reuse them for a
// day instead of revalidating each one on every page view. JS/CSS keep the
// default (always revalidated) because their URLs are not versioned.
app.use('/assets', express.static(path.join(__dirname, 'public', 'assets'), { maxAge: '1d' }));
app.use(express.static(path.join(__dirname, 'public')));

// Apply rate limiting to all API routes (images have their own budget)
app.use('/api/', apiLimiter);
app.use('/api/', mediaLimiter);

// Apply pagination validation to routes that use it
app.use('/api/tournaments', validatePagination);
app.use('/api/runs', validatePagination);
app.use('/api/players', validatePagination);

// Apply stricter rate limiting to search
app.use('/api/search', searchLimiter);

// API Routes
app.use('/api/games', require('./routes/games'));
app.use('/api/tournaments', require('./routes/tournaments'));
app.use('/api/runs', require('./routes/runs'));
app.use('/api/players', require('./routes/players'));
app.use('/api/sync', require('./routes/sync'));
app.use('/api/racetime', require('./routes/racetime'));
app.use('/api/avatar', require('./routes/avatar'));
app.use('/api/streams', require('./routes/streams'));
app.use('/api/search', require('./routes/search'));
app.use('/api/proxy-image', require('./routes/proxy-image'));

// Admin routes (authenticated: no general rate limit, the login has its own)
app.use('/api/admin', require('./routes/admin'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    version: '2.0.0'
  });
});

// Unknown API routes answer JSON; unknown pages get the 404 page
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// Error handling - use secure error handler
app.use(errorHandler);

// Start server
const startServer = async () => {
  try {
    // Connect to MongoDB first
    await connectDB();
    
    app.listen(PORT, () => {
      console.log(`🚀 Randomizer API running on http://localhost:${PORT}`);
      console.log(`📊 Environment: ${process.env.NODE_ENV}`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

module.exports = app;
