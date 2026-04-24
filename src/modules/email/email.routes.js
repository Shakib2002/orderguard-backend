'use strict';

const express = require('express');
const router = express.Router();
const { body } = require('express-validator');

const {
  saveEmailConfig,
  getEmailConfig,
  deleteEmailConfig,
  testEmailConfig,
  getRawEmails,
  parseEmail,
  ingestEmailOrder,
} = require('./email.controller');

const { validate } = require('../../middlewares/validate.middleware');
const { authenticate } = require('../../middlewares/auth.middleware');
const { tenantScope } = require('../../middlewares/tenant.middleware');
const { phoneField } = require('../../utils/validators');

// All email routes require auth + tenant scope
router.use(authenticate, tenantScope);

// ── Email Config ──────────────────────────────────────────────────────────────

router.post(
  '/config',
  [
    body('gmailAddress')
      .isEmail().normalizeEmail()
      .withMessage('Valid Gmail address required')
      .custom((v) => v.endsWith('@gmail.com'))
      .withMessage('Must be a Gmail address (@gmail.com)'),
    body('gmailAppPassword')
      .notEmpty().withMessage('Gmail App Password is required')
      .isLength({ min: 16, max: 19 })
      .withMessage('Gmail App Password must be 16 characters (spaces allowed)'),
  ],
  validate,
  saveEmailConfig
);

router.get('/config', getEmailConfig);

router.delete('/config', deleteEmailConfig);

router.post('/config/test', testEmailConfig);

// ── Raw Emails ────────────────────────────────────────────────────────────────

router.get('/raw', getRawEmails);

// ── Manual Parse / Ingest (dev + integration) ─────────────────────────────────

router.post(
  '/parse',
  [
    body('subject').notEmpty().withMessage('Email subject is required'),
    body('body').notEmpty().withMessage('Email body is required'),
    body('from').optional().isEmail(),
    body('messageId').optional().trim(),
  ],
  validate,
  parseEmail
);

router.post(
  '/ingest',
  [
    body('customerName').trim().notEmpty().withMessage('Customer name is required'),
    phoneField('customerPhone'),
    body('productName').trim().notEmpty().withMessage('Product name is required'),
    body('totalPrice')
      .notEmpty()
      .isDecimal({ decimal_digits: '0,2' })
      .toFloat()
      .withMessage('Valid total price is required'),
    body('rawEmailId').optional().trim(),
  ],
  validate,
  ingestEmailOrder
);

module.exports = router;
