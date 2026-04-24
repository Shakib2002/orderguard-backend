'use strict';

/**
 * Application-wide constants.
 * Avoid magic numbers scattered across the codebase.
 */

module.exports = {
  // Pagination defaults
  PAGINATION: {
    DEFAULT_PAGE: 1,
    DEFAULT_LIMIT: 20,
    MAX_LIMIT: 100,
  },

  // Bcrypt hashing rounds
  BCRYPT_ROUNDS: 12,

  // HTTP status codes (most common ones for clarity)
  HTTP: {
    OK: 200,
    CREATED: 201,
    NO_CONTENT: 204,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    UNPROCESSABLE_ENTITY: 422,
    TOO_MANY_REQUESTS: 429,
    INTERNAL_SERVER_ERROR: 500,
    SERVICE_UNAVAILABLE: 503,
  },

  // Tenant plan limits
  PLAN_LIMITS: {
    FREE: {
      ordersPerMonth: 200,
      callsPerMonth: 50,
      users: 2,
    },
    BASIC: {
      ordersPerMonth: 2000,
      callsPerMonth: 500,
      users: 5,
    },
    PRO: {
      ordersPerMonth: Infinity,
      callsPerMonth: Infinity,
      users: Infinity,
    },
  },

  // Call attempt limits per order
  MAX_CALL_ATTEMPTS: 3,

  // Slug generation
  SLUG_MAX_LENGTH: 50,
};
