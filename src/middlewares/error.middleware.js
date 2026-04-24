'use strict';

const logger = require('../utils/logger');
const { sendError } = require('../utils/response');
const { HTTP } = require('../config/constants');
const { config } = require('../config/env');

/**
 * Global error handler — must be registered LAST in Express middleware chain.
 *
 * Handles:
 *  - Prisma errors (known codes)
 *  - JWT errors (though usually caught in auth middleware)
 *  - Generic application errors
 *  - Unhandled promise rejections passed via next(err)
 *
 * Response format: { success: false, message, data: null, errors?: [] }
 */
const errorHandler = (err, req, res, next) => {
  // Log full error in all environments; limit stack trace in production logs
  logger.error({
    message: err.message,
    stack: config.isDev ? err.stack : undefined,
    path: req.path,
    method: req.method,
    ip: req.ip,
    code: err.code,
  });

  // ── Prisma known error codes ───────────────────────────────────────────────
  if (err.code) {
    switch (err.code) {
      case 'P2002': {
        // Unique constraint violation
        const field = err.meta?.target?.join(', ') || 'field';
        return sendError(res, {
          statusCode: HTTP.CONFLICT,
          message: `A record with this ${field} already exists.`,
        });
      }
      case 'P2025':
        // Record not found (e.g., update/delete on non-existent record)
        return sendError(res, {
          statusCode: HTTP.NOT_FOUND,
          message: err.meta?.cause || 'Record not found.',
        });
      case 'P2003':
        return sendError(res, {
          statusCode: HTTP.BAD_REQUEST,
          message: 'Invalid reference: related record does not exist.',
        });
      case 'P2014':
        return sendError(res, {
          statusCode: HTTP.BAD_REQUEST,
          message: 'Relation violation: required relation would be broken.',
        });
      default:
        break;
    }
  }

  // ── JWT errors (fallback) ─────────────────────────────────────────────────
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    return sendError(res, {
      statusCode: HTTP.UNAUTHORIZED,
      message: 'Invalid or expired token.',
    });
  }

  // ── Syntax errors (malformed JSON body) ──────────────────────────────────
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return sendError(res, {
      statusCode: HTTP.BAD_REQUEST,
      message: 'Malformed JSON in request body.',
    });
  }

  // ── Custom application errors ─────────────────────────────────────────────
  if (err.isOperational) {
    return sendError(res, {
      statusCode: err.statusCode || HTTP.BAD_REQUEST,
      message: err.message,
    });
  }

  // ── Unhandled / unexpected errors ─────────────────────────────────────────
  return sendError(res, {
    statusCode: HTTP.INTERNAL_SERVER_ERROR,
    message: config.isDev
      ? err.message
      : 'An unexpected error occurred. Please try again later.',
    errors: config.isDev ? [{ stack: err.stack }] : undefined,
  });
};

/**
 * 404 handler — catches requests to undefined routes.
 */
const notFoundHandler = (req, res) => {
  return sendError(res, {
    statusCode: HTTP.NOT_FOUND,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
};

/**
 * Simple operational error class for known failure cases.
 */
class AppError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = { errorHandler, notFoundHandler, AppError };
