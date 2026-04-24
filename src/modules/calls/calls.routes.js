'use strict';

const express = require('express');
const router = express.Router();
const { body } = require('express-validator');

const { listCalls, getCallsByOrder, logCall, updateCall } = require('./calls.controller');
const { validate } = require('../../middlewares/validate.middleware');
const { authenticate } = require('../../middlewares/auth.middleware');
const { tenantScope } = require('../../middlewares/tenant.middleware');

router.use(authenticate, tenantScope);

router.get('/', listCalls);
router.get('/order/:orderId', getCallsByOrder);

router.post(
  '/',
  [
    body('orderId').notEmpty().withMessage('Order ID is required'),
    body('status')
      .notEmpty().withMessage('Call status is required')
      .isIn(['initiated', 'ringing', 'completed', 'failed', 'no-answer', 'busy'])
      .withMessage('Invalid call status'),
    body('keypress')
      .optional()
      .isIn(['1', '2', null])
      .withMessage('Keypress must be 1, 2, or null'),
    body('duration')
      .optional()
      .isInt({ min: 0 }).withMessage('Duration must be a non-negative integer')
      .toInt(),
  ],
  validate,
  logCall
);

router.patch(
  '/:id',
  [
    body('status')
      .optional()
      .isIn(['initiated', 'ringing', 'completed', 'failed', 'no-answer', 'busy'])
      .withMessage('Invalid call status'),
    body('keypress')
      .optional()
      .isIn(['1', '2', null])
      .withMessage('Keypress must be 1, 2, or null'),
    body('duration').optional().isInt({ min: 0 }).toInt(),
  ],
  validate,
  updateCall
);

module.exports = router;
