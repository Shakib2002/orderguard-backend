'use strict';

const express = require('express');
const router = express.Router();
const { body } = require('express-validator');

const {
  getSettings,
  updateSettings,
  listUsers,
  createUser,
  getEmailConfig,
  upsertEmailConfig,
  deleteEmailConfig,
} = require('./tenants.controller');
const { validate } = require('../../middlewares/validate.middleware');
const { authenticate, authorize } = require('../../middlewares/auth.middleware');
const { tenantScope } = require('../../middlewares/tenant.middleware');
const { emailField, passwordField } = require('../../utils/validators');

// All tenant routes require auth + tenant scope
router.use(authenticate, tenantScope);

// ── Settings ──────────────────────────────────────────────────────────────────
router.get('/settings', getSettings);

router.patch(
  '/settings',
  [
    body('businessName').optional().trim().isLength({ min: 2, max: 100 }),
    body('whatsappNumber')
      .optional()
      .matches(/^(\+?880|0)1[3-9]\d{8}$/)
      .withMessage('Enter a valid Bangladesh WhatsApp number'),
    body('gmailAddress').optional().isEmail().normalizeEmail(),
  ],
  validate,
  updateSettings
);

// ── Users (SUPER_ADMIN only) ──────────────────────────────────────────────────
router.get('/users', listUsers);

router.post(
  '/users',
  authorize('SUPER_ADMIN'),
  [
    emailField('email'),
    passwordField('password'),
    body('fullName').trim().notEmpty().withMessage('Full name is required'),
    body('role').optional().isIn(['SELLER', 'SUPER_ADMIN']).withMessage('Invalid role'),
  ],
  validate,
  createUser
);

// ── Email Config ──────────────────────────────────────────────────────────────
router.get('/email-config', getEmailConfig);

router.put(
  '/email-config',
  [
    body('gmailAddress').isEmail().normalizeEmail().withMessage('Valid Gmail address required'),
    body('gmailAppPassword')
      .notEmpty().withMessage('Gmail app password is required')
      .isLength({ min: 16, max: 20 }).withMessage('Gmail app password must be 16–20 characters'),
  ],
  validate,
  upsertEmailConfig
);

router.delete('/email-config', deleteEmailConfig);

module.exports = router;
