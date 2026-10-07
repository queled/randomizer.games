/**
 * Admin Authentication Middleware
 * 
 * Simple token-based authentication for admin routes.
 * In production, consider using a more robust solution like JWT or OAuth.
 */

const crypto = require('crypto');

// Admin token from environment. The public default is only accepted when
// NODE_ENV is explicitly 'development', so a server started without NODE_ENV
// cannot be unlocked with a token anyone can read in the source.
const DEFAULT_ADMIN_TOKEN = 'dev-admin-token-change-in-production';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || DEFAULT_ADMIN_TOKEN;

if (process.env.NODE_ENV !== 'development' && ADMIN_TOKEN === DEFAULT_ADMIN_TOKEN) {
  throw new Error('ADMIN_TOKEN must be set to a strong value (only NODE_ENV=development may use the default)');
}

// Simple in-memory session store (use Redis in production for multi-instance)
const sessions = new Map();
const SESSION_DURATION = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Generate a secure session token
 */
function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Create a new session
 */
function createSession(adminId = 'admin') {
  const token = generateSessionToken();
  const session = {
    adminId,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_DURATION
  };
  sessions.set(token, session);
  
  // Cleanup expired sessions periodically
  cleanupExpiredSessions();
  
  return token;
}

/**
 * Validate a session token
 */
function validateSession(token) {
  if (!token) return null;
  
  const session = sessions.get(token);
  if (!session) return null;
  
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  
  return session;
}

/**
 * Cleanup expired sessions
 */
function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (now > session.expiresAt) {
      sessions.delete(token);
    }
  }
}

/**
 * Middleware to verify admin token for login
 */
function verifyAdminToken(providedToken) {
  // Only plain strings are accepted (a JSON body could send arrays or objects).
  if (typeof providedToken !== 'string' || !providedToken) {
    return false;
  }

  // Compare fixed-length digests so neither the content nor the length of the
  // real token leaks through response timing.
  const provided = crypto.createHash('sha256').update(providedToken, 'utf8').digest();
  const expected = crypto.createHash('sha256').update(ADMIN_TOKEN, 'utf8').digest();
  return crypto.timingSafeEqual(provided, expected);
}

/**
 * Middleware to require admin authentication
 */
function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  const cookieToken = req.cookies?.adminSession;

  let sessionToken = null;
  let session = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const bearerToken = authHeader.slice(7).trim();
    if (bearerToken) {
      session = validateSession(bearerToken);
      if (session) {
        sessionToken = bearerToken;
      }
    }
  }

  if (!session && cookieToken) {
    session = validateSession(cookieToken);
    if (session) {
      sessionToken = cookieToken;
    }
  }
  
  if (!session) {
    return res.status(401).json({ 
      error: 'Unauthorized',
      message: 'Valid admin session required'
    });
  }
  
  // Attach session info to request
  req.adminSession = session;
  req.adminSessionToken = sessionToken;
  next();
}

/**
 * Optional admin check (doesn't block if not authenticated)
 */
function optionalAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  const cookieToken = req.cookies?.adminSession;

  let session = null;
  let sessionToken = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const bearerToken = authHeader.slice(7).trim();
    if (bearerToken) {
      session = validateSession(bearerToken);
      if (session) {
        sessionToken = bearerToken;
      }
    }
  }

  if (!session && cookieToken) {
    session = validateSession(cookieToken);
    if (session) {
      sessionToken = cookieToken;
    }
  }

  req.adminSession = session;
  req.adminSessionToken = sessionToken;
  next();
}

/**
 * Destroy a session
 */
function destroySession(token) {
  sessions.delete(token);
}

module.exports = {
  verifyAdminToken,
  createSession,
  validateSession,
  destroySession,
  requireAdmin,
  optionalAdmin
};
