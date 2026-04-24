'use strict';

const jwt = require('jsonwebtoken');
const { config } = require('../config/env');
const { sendError } = require('../utils/response');
const { HTTP } = require('../config/constants');

// ── authenticateToken ─────────────────────────────────────────────────────────

/**
 * Middleware: verify JWT Bearer token from Authorization header.
 *
 * On success, attaches to req:
 *   req.user     → { userId, tenantId, email, role }
 *   req.tenantId → string (convenience alias)
 *   req.role     → string (convenience alias)
 */
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return sendError(res, {
      statusCode: HTTP.UNAUTHORIZED,
      message: 'Authorization header missing or malformed. Expected: Bearer <token>',
    });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, config.jwt.accessSecret);

    // Attach full context
    req.user = {
      userId: decoded.userId,
      tenantId: decoded.tenantId,
      email: decoded.email,
      role: decoded.role,
    };

    // Convenience aliases for cleaner route/controller code
    req.tenantId = decoded.tenantId;
    req.role = decoded.role;

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return sendError(res, {
        statusCode: HTTP.UNAUTHORIZED,
        message: 'Access token expired. Use POST /api/v1/auth/refresh to get a new one.',
      });
    }
    return sendError(res, {
      statusCode: HTTP.UNAUTHORIZED,
      message: 'Invalid access token.',
    });
  }
};

// ── requireRole ───────────────────────────────────────────────────────────────

/**
 * Middleware factory: restrict access to one or more roles.
 * Must be used AFTER authenticateToken.
 *
 * Usage:
 *   router.post('/admin-only', authenticateToken, requireRole('SUPER_ADMIN'), handler)
 *   router.post('/multi',      authenticateToken, requireRole('SELLER', 'SUPER_ADMIN'), handler)
 *
 * @param {...string} roles - Allowed Role enum values
 */
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) {
    return sendError(res, {
      statusCode: HTTP.UNAUTHORIZED,
      message: 'Authentication required.',
    });
  }

  if (!roles.includes(req.role)) {
    return sendError(res, {
      statusCode: HTTP.FORBIDDEN,
      message: `Access denied. This action requires role: ${roles.join(' or ')}.`,
    });
  }

  next();
};

// ── authenticate (alias kept for backwards compat with existing route files) ──
// Other modules (orders, calls, etc.) import `authenticate` — map to new name.
const authenticate = authenticateToken;

// ── authorize (alias kept for backwards compat) ───────────────────────────────
const authorize = requireRole;

module.exports = { authenticateToken, requireRole, authenticate, authorize };
