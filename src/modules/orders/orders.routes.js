'use strict';

const express = require('express');
const router  = express.Router();
const { body, query } = require('express-validator');

const {
  listOrders, getOrder, createOrder, updateOrder,
  updateOrderStatus, updateCallStatus, deleteOrder,
  getStatsSummary, getStatsChart,
} = require('./orders.controller');

const { validate }     = require('../../middlewares/validate.middleware');
const { authenticate } = require('../../middlewares/auth.middleware');
const { tenantScope }  = require('../../middlewares/tenant.middleware');
const { phoneField }   = require('../../utils/validators');

// All order routes require auth + tenant scope
router.use(authenticate, tenantScope);

// ── Stats (MUST be before /:orderId to avoid param collision) ─────────────────
router.get('/stats/summary', getStatsSummary);
router.get(
  '/stats/chart',
  [query('period').optional().isIn(['7d', '30d', '90d']).withMessage('period must be 7d, 30d, or 90d')],
  validate,
  getStatsChart
);

// ── Orders CRUD ───────────────────────────────────────────────────────────────
router.get(
  '/',
  [
    query('status').optional().isIn(['PENDING','CONFIRMED','CANCELLED','FAKE','DELIVERED']),
    query('callStatus').optional().isIn(['NOT_CALLED','CONFIRMED','REJECTED','NO_RESPONSE']),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('sortBy').optional().isIn(['createdAt','updatedAt','totalPrice']),
    query('sortOrder').optional().isIn(['asc','desc']),
  ],
  validate,
  listOrders
);

router.post(
  '/',
  [
    body('customerName').trim().notEmpty().withMessage('Customer name is required'),
    phoneField('customerPhone'),
    body('productName').trim().notEmpty().withMessage('Product name is required'),
    body('totalPrice').notEmpty().isDecimal({ decimal_digits: '0,2' }).toFloat()
      .withMessage('Valid total price required'),
    body('quantity').optional().isInt({ min: 1 }).toInt(),
    body('externalId').optional().trim(),
    body('address').optional().trim(),
    body('notes').optional().trim(),
  ],
  validate,
  createOrder
);

router.get('/:orderId', getOrder);

router.put(
  '/:orderId',
  [
    body('customerName').optional().trim().notEmpty(),
    phoneField('customerPhone', false),   // optional
    body('productName').optional().trim().notEmpty(),
    body('totalPrice').optional().isDecimal({ decimal_digits: '0,2' }).toFloat(),
    body('quantity').optional().isInt({ min: 1 }).toInt(),
  ],
  validate,
  updateOrder
);

router.patch(
  '/:orderId/status',
  [
    body('status')
      .notEmpty()
      .isIn(['PENDING','CONFIRMED','CANCELLED','FAKE','DELIVERED'])
      .withMessage('Invalid order status'),
    body('notes').optional().trim().isLength({ max: 500 }),
  ],
  validate,
  updateOrderStatus
);

router.patch(
  '/:orderId/call-status',
  [
    body('callStatus')
      .notEmpty()
      .isIn(['NOT_CALLED','CONFIRMED','REJECTED','NO_RESPONSE'])
      .withMessage('Invalid call status'),
  ],
  validate,
  updateCallStatus
);

router.delete('/:orderId', deleteOrder);

module.exports = router;
