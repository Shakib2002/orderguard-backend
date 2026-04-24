'use strict';

const express = require('express');
const router  = express.Router();
const { body } = require('express-validator');

const {
  getSettings, updateBusiness, updateCallPreferences,
  testEmailConnection, getInboundEmail, saveFcmToken,
} = require('./settings.controller');

const { validate }     = require('../../middlewares/validate.middleware');
const { authenticate } = require('../../middlewares/auth.middleware');
const { tenantScope }  = require('../../middlewares/tenant.middleware');

// All settings routes require auth + tenant scope
router.use(authenticate, tenantScope);

// ── Full settings dashboard ───────────────────────────────────────────────────
router.get('/', getSettings);

// ── Business info ─────────────────────────────────────────────────────────────
router.patch(
  '/business',
  [
    body('businessName').optional().trim().isLength({ min: 2, max: 100 })
      .withMessage('businessName must be 2–100 characters'),
    body('whatsappNumber').optional().trim()
      .matches(/^(\+?880|0)?1[3-9]\d{8}$/).withMessage('Invalid Bangladesh phone number')
      .customSanitizer((v) => v ? v.replace(/\D/g, '').replace(/^880/, '0') : null),
  ],
  validate,
  updateBusiness
);

// ── Call / SMS preferences ─────────────────────────────────────────────────────
router.patch(
  '/call-preferences',
  [
    body('autoCallEnabled').optional().isBoolean().toBoolean(),
    body('smsEnabled').optional().isBoolean().toBoolean(),
    body('retryAttempts').optional().isInt({ min: 1, max: 3 }).toInt(),
    body('callWindowStart').optional().trim().matches(/^([01]\d|2[0-3]):[0-5]\d$/)
      .withMessage('callWindowStart must be HH:MM'),
    body('callWindowEnd').optional().trim().matches(/^([01]\d|2[0-3]):[0-5]\d$/)
      .withMessage('callWindowEnd must be HH:MM'),
    body('delayMinutes').optional().isInt().toInt()
      .custom((v) => [0, 5, 10, 15, 30].includes(v))
      .withMessage('delayMinutes must be 0, 5, 10, 15, or 30'),
  ],
  validate,
  updateCallPreferences
);

// ── Email integration ─────────────────────────────────────────────────────────
router.post(
  '/email/test-connection',
  [
    body('gmailAddress').isEmail().normalizeEmail()
      .custom((v) => v.endsWith('@gmail.com')).withMessage('Must be a Gmail address'),
    body('gmailAppPassword').notEmpty().isLength({ min: 16, max: 19 })
      .withMessage('Gmail App Password must be 16 characters'),
  ],
  validate,
  testEmailConnection
);

router.get('/inbound-email', getInboundEmail);

// ── FCM push token ────────────────────────────────────────────────────────────
router.post(
  '/fcm-token',
  [body('fcmToken').notEmpty().trim().withMessage('fcmToken is required')],
  validate,
  saveFcmToken
);

module.exports = router;
