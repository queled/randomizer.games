/**
 * Admin Authentication Middleware
 * 
 * Token-based authentication for admin routes: the admin token opens a
 * session stored in MongoDB, carried by an httpOnly cookie.
 */

const crypto = require('crypto');
const { AdminSession } = require('../models');

// Admin token from environment. The public default is only accepted when
// NODE_ENV is explicitly 'development', so a server started without NODE_ENV
// cannot be unlocked with a token anyone can read in the source.
const DEFAULT_ADMIN_TOKEN = 'dev-admin-token-change-in-production';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || DEFAULT_ADMIN_TOKEN;

if (process.env.NODE_ENV !== 'development' && ADMIN_TOKEN === DEFAULT_ADMIN_TOKEN) {
  throw new Error('ADMIN_TOKEN must be set to a strong value (only NODE_ENV=development may use the default)');
}

const SESSION_DURATION = 24 * 60 * 60 * 1000; // 24 hours

// Sessions live in MongoDB (AdminSession) so a restart or a deploy does not log
// the admin out. The cookie holds a random token; only its hash is stored.
function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Create a new session, returns its token
 */
async function createSession(adminId = 'admin') {
  const token = crypto.randomBytes(32).toString('hex');
  await AdminSession.create({
    tokenHash: hashToken(token),
    adminId,
    expiresAt: new Date(Date.now() + SESSION_DURATION)
  });
  return token;
}

/**
 * Validate a session token
 */
async function validateSession(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  // MongoDB removes expired sessions only once a minute: check the date here too
  const session = await AdminSession.findOne({ tokenHash: hashToken(token), expiresAt: { $gt: new Date() } }).lean();
  if (!session) return null;
  return {
    adminId: session.adminId,
    createdAt: session.createdAt ? session.createdAt.getTime() : null,
    expiresAt: session.expiresAt.getTime()
  };
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
async function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const candidates = [bearerToken, req.cookies?.adminSession].filter(Boolean);

    let session = null;
    let sessionToken = null;
    for (const token of candidates) {
      session = await validateSession(token);
      if (session) {
        sessionToken = token;
        break;
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
  } catch (error) {
    next(error);
  }
}

/**
 * Destroy a session
 */
async function destroySession(token) {
  if (typeof token !== 'string' || !token) return;
  await AdminSession.deleteOne({ tokenHash: hashToken(token) });
}

module.exports = {
  verifyAdminToken,
  createSession,
  validateSession,
  destroySession,
  requireAdmin
};
