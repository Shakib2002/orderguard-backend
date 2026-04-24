'use strict';

const express = require('express');
const router = express.Router();
const { body } = require('express-validator');

const { getEmailStatus, parseEmail, ingestEmailOrder, markChecked } = require('./email.controller');
const { validate } = require('../../middlewares/validate.middleware');
const { authenticate } = require('../../middlewares/auth.middleware');
const { tenantScope } = require('../../middlewares/tenant.middleware');
const { phoneField } = require('../../utils/validators');

router.use(authenticate, tenantScope);

router.get('/status', getEmailStatus);
router.patch('/last-checked', markChecked);

// Parse a raw email and return extracted order fields
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

// Ingest a parsed order from email (creates an Order record)
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
