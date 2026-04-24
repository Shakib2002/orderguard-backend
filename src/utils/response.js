'use strict';

/**
 * Consistent API response builder.
 * All responses follow the shape:
 *   { success: boolean, data: any, message: string, errors?: any[] }
 */

/**
 * Send a successful response.
 * @param {import('express').Response} res
 * @param {object} options
 * @param {any}    options.data
 * @param {string} options.message
 * @param {number} options.statusCode  - Defaults to 200
 * @param {object} options.meta        - Optional pagination/meta info
 */
const sendSuccess = (res, { data = null, message = 'Success', statusCode = 200, meta } = {}) => {
  const payload = { success: true, message, data };
  if (meta) payload.meta = meta;
  return res.status(statusCode).json(payload);
};

/**
 * Send a created (201) response.
 */
const sendCreated = (res, { data = null, message = 'Created successfully' } = {}) => {
  return sendSuccess(res, { data, message, statusCode: 201 });
};

/**
 * Send an error response.
 * @param {import('express').Response} res
 * @param {object} options
 * @param {string}   options.message
 * @param {number}   options.statusCode  - Defaults to 400
 * @param {any[]}    options.errors       - Detailed error list (e.g., validation errors)
 */
const sendError = (res, { message = 'An error occurred', statusCode = 400, errors } = {}) => {
  const payload = { success: false, message, data: null };
  if (errors) payload.errors = errors;
  return res.status(statusCode).json(payload);
};

/**
 * Build pagination metadata for list endpoints.
 * @param {number} total   - Total record count
 * @param {number} page    - Current page (1-indexed)
 * @param {number} limit   - Items per page
 */
const buildPaginationMeta = (total, page, limit) => ({
  total,
  page,
  limit,
  totalPages: Math.ceil(total / limit),
  hasNext: page * limit < total,
  hasPrev: page > 1,
});

module.exports = { sendSuccess, sendCreated, sendError, buildPaginationMeta };
