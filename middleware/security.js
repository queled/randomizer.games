const rateLimit = require('express-rate-limit');
const validator = require('validator');

// Check if in development mode
const isDevelopment = process.env.NODE_ENV === 'development';

// Images served through the API (avatars, stream thumbnails): a page shows
// dozens of them, so they have their own, larger budget (mediaLimiter).
const MEDIA_PATH = /^\/api\/(avatar|proxy-image|streams\/twitch-avatar)(\/|\?|$)/;
const isMediaRequest = (req) => MEDIA_PATH.test(req.originalUrl);

// The admin panel makes many calls; its routes require a session (256-bit
// token, not guessable) and the login has its own limiter.
const isAdminRequest = (req) => req.originalUrl.startsWith('/api/admin/') && !req.originalUrl.startsWith('/api/admin/login');

// Rate limiting configuration. Limiters are mounted on sub-paths, where
// req.path is relative: the full URL (originalUrl) is what the skips test.
const createRateLimiter = (windowMs, max, message, skip = () => false) => {
  return rateLimit({
    windowMs,
    limit: max,
    message: { error: message || 'Too many requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
    // Skip rate limiting for health checks and in development
    skip: (req) => isDevelopment || req.originalUrl.split('?')[0] === '/api/health' || skip(req)
  });
};

// General API rate limiter - More lenient in development (600 req/15min vs 150 in prod)
const apiLimiter = createRateLimiter(
  15 * 60 * 1000,
  isDevelopment ? 600 : 150,
  'Too many API requests, please try again later',
  (req) => isMediaRequest(req) || isAdminRequest(req)
);

// Images through the API: about ten pages full of avatars per 15 minutes
const mediaLimiter = createRateLimiter(
  15 * 60 * 1000,
  1000,
  'Too many image requests, please try again later',
  (req) => !isMediaRequest(req)
);

// Strict rate limiter for write operations - More lenient in development (100 req/hour vs 20 in prod)
const strictLimiter = createRateLimiter(
  60 * 60 * 1000,
  isDevelopment ? 100 : 20,
  'Too many requests to this endpoint, please try again later'
);

// Search rate limiter - More lenient in development (500 req/min vs 50 in prod)
const searchLimiter = createRateLimiter(
  60 * 1000,
  isDevelopment ? 500 : 50,
  'Too many search requests'
);

// Stricter limiter for admin login attempts
const adminLoginLimiter = createRateLimiter(
  15 * 60 * 1000,
  isDevelopment ? 50 : 10,
  'Too many admin login attempts, please try again later'
);

// MongoDB injection protection: drop keys starting with "$" or holding a "."
// (operators, dotted paths) from the query string and the parsed body.
const isUnsafeKey = (key) => key.startsWith('$') || key.includes('.');

const stripUnsafeKeys = (value) => {
  if (Array.isArray(value)) {
    value.forEach(stripUnsafeKeys);
  } else if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (isUnsafeKey(key)) delete value[key];
      else stripUnsafeKeys(value[key]);
    }
  }
  return value;
};

// Express 5 parses req.query again on every read: store one sanitized copy on
// the request so later middleware (validatePagination) can also adjust it.
const mongoSanitize = (req, res, next) => {
  Object.defineProperty(req, 'query', {
    value: stripUnsafeKeys(req.query),
    writable: true,
    configurable: true,
    enumerable: true
  });
  stripUnsafeKeys(req.body);
  next();
};

// Validation middleware
const validatePagination = (req, res, next) => {
  const { limit, page } = req.query;
  
  if (limit) {
    const limitNum = parseInt(limit);
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
      return res.status(400).json({ error: 'Invalid limit parameter (must be 1-100)' });
    }
    req.query.limit = limitNum;
  }
  
  if (page) {
    const pageNum = parseInt(page);
    if (isNaN(pageNum) || pageNum < 1 || pageNum > 10000) {
      return res.status(400).json({ error: 'Invalid page parameter (must be 1-10000)' });
    }
    req.query.page = pageNum;
  }
  
  next();
};

// Validate MongoDB ObjectId
const validateObjectId = (paramName) => {
  return (req, res, next) => {
    const id = req.params[paramName];
    if (id && !/^[a-fA-F0-9]{24}$/.test(id)) {
      return res.status(400).json({ error: `Invalid ${paramName} format` });
    }
    next();
  };
};

// Validate URL for proxy (whitelist approach)
// Whitelist allowed domains for image proxy
const PROXY_ALLOWED_DOMAINS = [
  'racetime.gg',
  'www.racetime.gg',
  'challonge.com',
  'www.challonge.com',
  'cdn.cloudflare.steamstatic.com',
  'steamcdn-a.akamaihd.net',
  'static-cdn.jtvnw.net', // Twitch
  'avatars.githubusercontent.com',
  'i.imgur.com'
];

const isPrivateHost = (host) => {
  return /^(0\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|169\.254\.|\[|::1|localhost)/i.test(host);
};

/**
 * Check one URL against the image proxy rules. Used for the requested URL and
 * again for every redirect hop. Returns { ok: true, url } or { ok: false, status, error }.
 */
const checkProxyUrl = (rawUrl) => {
  if (typeof rawUrl !== 'string' || !rawUrl || rawUrl.length > 2048) {
    return { ok: false, status: 400, error: 'Invalid URL format' };
  }
  if (!validator.isURL(rawUrl, { protocols: ['http', 'https'], require_protocol: true })) {
    return { ok: false, status: 400, error: 'Invalid URL format' };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch (error) {
    return { ok: false, status: 400, error: 'Invalid URL' };
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return { ok: false, status: 400, error: 'Invalid URL format' };
  }

  // No embedded credentials and no custom port (only standard web ports).
  if (parsedUrl.username || parsedUrl.password || parsedUrl.port) {
    return { ok: false, status: 403, error: 'Domain not allowed for proxying' };
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  const isAllowed = PROXY_ALLOWED_DOMAINS.some(domain =>
    hostname === domain || hostname.endsWith('.' + domain)
  );
  if (!isAllowed) {
    return { ok: false, status: 403, error: 'Domain not allowed for proxying' };
  }

  // Prevent SSRF to internal networks
  if (isPrivateHost(hostname)) {
    return { ok: false, status: 403, error: 'Cannot proxy internal addresses' };
  }

  return { ok: true, url: parsedUrl.toString() };
};

// Validate URL for proxy (whitelist approach)
const validateProxyUrl = (req, res, next) => {
  const { url } = req.query;
  
  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  const result = checkProxyUrl(url);
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error });
  }
  next();
};

// Secure error handler (don't leak stack traces in production)
const errorHandler = (err, req, res, next) => {
  console.error('Error:', {
    message: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    ip: req.ip
  });
  
  // Only expose error details when explicitly running in development, so a
  // server started without NODE_ENV never leaks stack traces.
  const showDetails = process.env.NODE_ENV === 'development';
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  
  res.status(status).json({
    error: {
      message: showDetails ? err.message : 'An error occurred',
      status,
      ...(showDetails ? { stack: err.stack } : {})
    }
  });
};

// Image types we accept to relay from third-party hosts. SVG is excluded on
// purpose: it can carry scripts and would run them on our own origin.
const SAFE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/pjpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/bmp'
]);

const isSafeImageContentType = (contentType) => {
  const mime = String(contentType || '').split(';')[0].trim().toLowerCase();
  return SAFE_IMAGE_TYPES.has(mime);
};

// Headers for responses that relay third-party bytes: the browser must not
// sniff them into another type, nor run anything if the URL is opened directly.
const setRelayedImageHeaders = (res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
};

module.exports = {
  apiLimiter,
  mediaLimiter,
  strictLimiter,
  searchLimiter,
  adminLoginLimiter,
  validatePagination,
  validateObjectId,
  validateProxyUrl,
  checkProxyUrl,
  isSafeImageContentType,
  setRelayedImageHeaders,
  errorHandler,
  mongoSanitize
};
