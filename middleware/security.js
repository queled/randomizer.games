const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const validator = require('validator');

// Check if in development mode
const isDevelopment = process.env.NODE_ENV === 'development';

// Rate limiting configuration
const createRateLimiter = (windowMs, max, message) => {
  return rateLimit({
    windowMs,
    max,
    message: { error: message || 'Too many requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
    // Skip rate limiting for health checks and in development
    skip: (req) => req.path === '/api/health' || isDevelopment
  });
};

// General API rate limiter - More lenient in development (600 req/15min vs 100 in prod)
const apiLimiter = createRateLimiter(
  15 * 60 * 1000,
  isDevelopment ? 600 : 150,
  'Too many API requests, please try again later'
);

// Strict rate limiter for write operations - More lenient in development (100 req/hour vs 10 in prod)
const strictLimiter = createRateLimiter(
  60 * 60 * 1000,
  isDevelopment ? 100 : 20,
  'Too many requests to this endpoint, please try again later'
);

// Very strict for webhooks - More lenient in development (100 per minute vs 5 in prod)
const webhookLimiter = createRateLimiter(
  60 * 1000,
  isDevelopment ? 100 : 10,
  'Webhook rate limit exceeded'
);

// Search rate limiter - More lenient in development (500 req/min vs 30 in prod)
const searchLimiter = createRateLimiter(
  60 * 1000,
  isDevelopment ? 500 : 50,
  'Too many search requests'
);

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

// Sanitize string inputs (prevent XSS in user-provided strings)
const sanitizeString = (str, maxLength = 500) => {
  if (!str) return '';
  return String(str)
    .slice(0, maxLength)
    .replace(/[<>]/g, '') // Remove potential HTML tags
    .trim();
};

// Validate URL for proxy (whitelist approach)
const validateProxyUrl = (req, res, next) => {
  const { url } = req.query;
  
  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }
  
  // Validate URL format
  if (!validator.isURL(url, { protocols: ['http', 'https'], require_protocol: true })) {
    return res.status(400).json({ error: 'Invalid URL format' });
  }
  
  try {
    const parsedUrl = new URL(url);
    
    // Whitelist allowed domains for image proxy
    const allowedDomains = [
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
    
    const hostname = parsedUrl.hostname.toLowerCase();
    const isAllowed = allowedDomains.some(domain => 
      hostname === domain || hostname.endsWith('.' + domain)
    );
    
    if (!isAllowed) {
      return res.status(403).json({ error: 'Domain not allowed for proxying' });
    }
    
    // Prevent SSRF to internal networks
    const isPrivateIP = (host) => {
      return /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|169\.254\.|::1|localhost)/i.test(host);
    };
    
    if (isPrivateIP(hostname)) {
      return res.status(403).json({ error: 'Cannot proxy internal addresses' });
    }
    
    next();
  } catch (error) {
    return res.status(400).json({ error: 'Invalid URL' });
  }
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
  
  // Don't expose internal errors in production
  const isProduction = process.env.NODE_ENV === 'production';
  
  res.status(err.status || 500).json({
    error: {
      message: isProduction ? 'An error occurred' : err.message,
      status: err.status || 500,
      ...(isProduction ? {} : { stack: err.stack })
    }
  });
};

module.exports = {
  apiLimiter,
  strictLimiter,
  webhookLimiter,
  searchLimiter,
  validatePagination,
  validateObjectId,
  sanitizeString,
  validateProxyUrl,
  errorHandler,
  mongoSanitize: mongoSanitize()
};
