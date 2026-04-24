'use strict';

const { validationResult } = require('express-validator');
const { sendError } = require('../utils/response');
const { HTTP } = require('../config/constants');

/**
 * Validate middleware — runs after express-validator chains.
 * If there are validation errors, returns a structured 422 response.
 * Otherwise passes control to the next handler.
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return sendError(res, {
      statusCode: HTTP.UNPROCESSABLE_ENTITY,
      message: 'Validation failed. Please check the errors below.',
      errors: errors.array().map((err) => ({
        field: err.path || err.param,
        message: err.msg,
        value: err.value,
      })),
    });
  }

  next();
};

module.exports = { validate };
