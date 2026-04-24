'use strict';

const express = require('express');
const router  = express.Router();
const { body } = require('express-validator');

const {
  manualLog, sendSms, initiateIvr,
  getCallsByOrder, smsWebhook, listCalls,
} = require('./calls.controller');

const { validate }     = require('../../middlewares/validate.middleware');
const { authenticate } = require('../../middlewares/auth.middleware');
const { tenantScope }  = require('../../middlewares/tenant.middleware');

// ── Public webhook (Twilio → no auth) ────────────────────────────────────────
router.post('/sms-webhook', smsWebhook);

// ── All other routes require auth + tenant scope ──────────────────────────────
router.use(authenticate, tenantScope);

// ── Manual verification endpoints ─────────────────────────────────────────────
router.post(
  '/manual-log',
  [
    body('orderId').notEmpty().withMessage('orderId is required'),
    body('outcome')
      .notEmpty()
      .isIn(['confirmed', 'cancelled', 'no_answer', 'fake'])
      .withMessage('outcome must be: confirmed | cancelled | no_answer | fake'),
    body('notes').optional().trim().isLength({ max: 500 }),
  ],
  validate,
  manualLog
);

router.post(
  '/send-sms',
  [body('orderId').notEmpty().withMessage('orderId is required')],
  validate,
  sendSms
);

router.post(
  '/initiate-ivr',
  [body('orderId').notEmpty().withMessage('orderId is required')],
  validate,
  initiateIvr
);

// ── Read endpoints ─────────────────────────────────────────────────────────────
router.get('/', listCalls);
router.get('/order/:orderId', getCallsByOrder);

module.exports = router;
