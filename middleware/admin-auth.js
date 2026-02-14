/**
 * Admin Authentication Middleware
 * 
 * Simple token-based authentication for admin routes.
 * In production, consider using a more robust solution like JWT or OAuth.
 */

const crypto = require('crypto');

// Admin token from environment (generate a secure one for production)
const DEFAULT_ADMIN_TOKEN = 'dev-admin-token-change-in-production';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || DEFAULT_ADMIN_TOKEN;

if (process.env.NODE_ENV === 'production' && (!process.env.ADMIN_TOKEN || ADMIN_TOKEN === DEFAULT_ADMIN_TOKEN)) {
  throw new Error('ADMIN_TOKEN must be set to a strong value in production');
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
  // Use timing-safe comparison to prevent timing attacks
  if (!providedToken || providedToken.length !== ADMIN_TOKEN.length) {
    return false;
  }
  
  try {
    return crypto.timingSafeEqual(
      Buffer.from(providedToken),
      Buffer.from(ADMIN_TOKEN)
    );
  } catch {
    return false;
  }
}

/**
 * Middleware to require admin authentication
 */
function requireAdmin(req, res, next) {
  // Check for session token in header or cookie
  const authHeader = req.headers.authorization;
  const cookieToken = req.cookies?.adminSession;
  
  let sessionToken = null;
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    sessionToken = authHeader.slice(7);
  } else if (cookieToken) {
    sessionToken = cookieToken;
  }
  
  const session = validateSession(sessionToken);
  
  if (!session) {
    return res.status(401).json({ 
      error: 'Unauthorized',
      message: 'Valid admin session required'
    });
  }
  
  // Attach session info to request
  req.adminSession = session;
  next();
}

/**
 * Optional admin check (doesn't block if not authenticated)
 */
function optionalAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  const cookieToken = req.cookies?.adminSession;
  
  let sessionToken = null;
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    sessionToken = authHeader.slice(7);
  } else if (cookieToken) {
    sessionToken = cookieToken;
  }
  
  req.adminSession = validateSession(sessionToken);
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
  optionalAdmin,
  ADMIN_TOKEN
};
