const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const path = require('path');
const connectDB = require('./config/database');
const { 
  apiLimiter, 
  searchLimiter,
  validatePagination,
  errorHandler,
  mongoSanitize
} = require('./middleware/security');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

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
        /\.randomizer\.games$/
      ]
    : '*',
  credentials: true,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));

app.use(compression());

// MongoDB injection protection
app.use(mongoSanitize);

// Cookie parser for admin sessions
app.use(cookieParser());

// capture raw body for webhook signature verification in specific routes
app.use(express.json({ 
  verify: (req, res, buf) => { req.rawBody = buf; },
  limit: '1mb' // Prevent payload attacks
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Adjust CSP and Permissions-Policy to avoid browser warnings when served via tunnels
// Allow blob: for images (used by some browsers when loading blobs) and set a
// conservative Permissions-Policy to avoid unrecognized-feature warnings.
app.use((req, res, next) => {
  try {
    // Content Security Policy: keep inline scripts/styles for the current frontend,
    // but remove unsafe-eval and tighten the remaining directives.
    const csp = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; connect-src 'self'; img-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';";
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

// Respond to favicon requests to avoid noisy 404s in browser console
app.get('/favicon.ico', (req, res) => res.status(204).end());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Apply rate limiting to all API routes
app.use('/api/', apiLimiter);

// Apply pagination validation to routes that use it
app.use('/api/tournaments', validatePagination);
app.use('/api/runs', validatePagination);
app.use('/api/players', validatePagination);

// Apply stricter rate limiting to search
app.use('/api/search', searchLimiter);

// Legacy namespace hinting (non-breaking)
function markLegacyNamespace(canonicalPath) {
  return (req, res, next) => {
    res.setHeader('X-API-Canonical-Path', canonicalPath);
    next();
  };
}

// API Routes
app.use('/api/games', require('./routes/games'));
app.use('/api/tournaments', require('./routes/tournaments'));
app.use('/api/runs', require('./routes/runs'));
app.use('/api/players', require('./routes/players'));
app.use('/api/sync', markLegacyNamespace('/api/commands/sync'), require('./routes/sync'));
app.use('/api/sync-rando-list', markLegacyNamespace('/api/hooks/rando-list'), require('./routes/sync-rando-list'));
app.use('/api/racetime', markLegacyNamespace('/api/services/racetime'), require('./routes/racetime'));
app.use('/api/streams', require('./routes/streams'));
app.use('/api/search', markLegacyNamespace('/api/queries/search'), require('./routes/search'));
app.use('/api/proxy-image', markLegacyNamespace('/api/services/proxy-image'), require('./routes/proxy-image'));

// Canonical namespaces (hybrid REST + command/service/query separation)
app.use('/api/commands/sync', require('./routes/sync'));
app.use('/api/hooks/rando-list', require('./routes/sync-rando-list'));
app.use('/api/services/racetime', require('./routes/racetime'));
app.use('/api/services/proxy-image', require('./routes/proxy-image'));
app.use('/api/queries/search', require('./routes/search'));

// Admin routes (no rate limiting - authenticated)
app.use('/api/admin', require('./routes/admin'));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    version: '2.0.0'
  });
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
