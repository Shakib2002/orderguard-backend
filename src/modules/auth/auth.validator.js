'use strict';

const Joi = require('joi');
const { sendError } = require('../../utils/response');
const { HTTP } = require('../../config/constants');

// ── Bangladesh phone regex ────────────────────────────────────────────────────
// Matches: 01XXXXXXXXX (11 digits, operator prefix 3–9)
const BD_PHONE_REGEX = /^01[3-9]\d{8}$/;

// ── Common Joi types ──────────────────────────────────────────────────────────
const joiEmail = Joi.string().email({ tlds: { allow: false } }).lowercase().trim();

const joiPassword = Joi.string()
  .min(8)
  .pattern(/[A-Z]/, 'uppercase')
  .pattern(/[0-9]/, 'number')
  .messages({
    'string.min': 'Password must be at least 8 characters',
    'string.pattern.name': 'Password must contain at least one {{#name}} character',
  });

const joiPhone = Joi.string().pattern(BD_PHONE_REGEX).messages({
  'string.pattern.base': 'Enter a valid Bangladesh phone number (e.g. 01712345678)',
});

// ── Auth Schemas ──────────────────────────────────────────────────────────────

const registerSchema = Joi.object({
  businessName: Joi.string().trim().min(2).max(100).required().messages({
    'string.min': 'Business name must be at least 2 characters',
    'string.max': 'Business name must not exceed 100 characters',
    'any.required': 'Business name is required',
  }),
  email: joiEmail.required().messages({
    'string.email': 'Enter a valid email address',
    'any.required': 'Email is required',
  }),
  password: joiPassword.required(),
  fullName: Joi.string().trim().min(2).max(100).required().messages({
    'any.required': 'Full name is required',
  }),
  phone: joiPhone.required().messages({
    'any.required': 'Phone number is required',
  }),
});

const loginSchema = Joi.object({
  email: joiEmail.required().messages({
    'any.required': 'Email is required',
  }),
  password: Joi.string().required().messages({
    'any.required': 'Password is required',
  }),
});

const refreshSchema = Joi.object({
  refreshToken: Joi.string().required().messages({
    'any.required': 'Refresh token is required',
  }),
});

const fcmTokenSchema = Joi.object({
  fcmToken: Joi.string().required().messages({
    'any.required': 'FCM token is required',
  }),
});

// ── Joi Validation Middleware Factory ─────────────────────────────────────────

/**
 * Returns an Express middleware that validates req.body against a Joi schema.
 * On failure → 422 with field-level errors array.
 * On success → strips unknown keys and assigns cleaned body.
 *
 * @param {Joi.ObjectSchema} schema
 */
const joiValidate = (schema) => (req, res, next) => {
  const { error, value } = schema.validate(req.body, {
    abortEarly: false,   // collect ALL errors, not just first
    stripUnknown: true,  // remove fields not in schema
    convert: true,       // coerce types (e.g. string → number)
  });

  if (error) {
    const errors = error.details.map((d) => ({
      field: d.path.join('.'),
      message: d.message.replace(/['"]/g, ''),
    }));

    return sendError(res, {
      statusCode: HTTP.UNPROCESSABLE_ENTITY,
      message: 'Validation failed. Please check the errors below.',
      errors,
    });
  }

  req.body = value; // use the sanitised + coerced value
  next();
};

module.exports = {
  joiValidate,
  registerSchema,
  loginSchema,
  refreshSchema,
  fcmTokenSchema,
  BD_PHONE_REGEX,
};
