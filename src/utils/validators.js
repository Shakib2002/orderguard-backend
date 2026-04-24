'use strict';

/**
 * Shared express-validator validation chains.
 * Import these and use in route-specific validators.
 */

const { body, param, query } = require('express-validator');

// ── Common field validators ───────────────────────────────────────────────────

const emailField = (field = 'email') =>
  body(field).isEmail().normalizeEmail().withMessage('Valid email address is required');

const passwordField = (field = 'password') =>
  body(field)
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters')
    .matches(/[A-Z]/)
    .withMessage('Password must contain at least one uppercase letter')
    .matches(/[0-9]/)
    .withMessage('Password must contain at least one number');

const phoneField = (field = 'customerPhone') =>
  body(field)
    .matches(/^(\+?880|0)1[3-9]\d{8}$/)
    .withMessage('Enter a valid Bangladesh phone number (e.g. 01712345678)');

const paginationQuery = [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be a positive integer')
    .toInt(),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100')
    .toInt(),
];

const cuidParam = (field = 'id') =>
  param(field).notEmpty().withMessage(`${field} is required`);

// ── Slug generator ────────────────────────────────────────────────────────────

/**
 * Convert a business name to a URL-safe slug.
 * e.g. "My Shop BD" → "my-shop-bd"
 * @param {string} name
 * @returns {string}
 */
const toSlug = (name) =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50);

module.exports = {
  emailField,
  passwordField,
  phoneField,
  paginationQuery,
  cuidParam,
  toSlug,
};
