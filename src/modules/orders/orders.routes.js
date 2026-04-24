'use strict';

const express = require('express');
const router = express.Router();

const {
  listOrders,
  getOrder,
  createOrder,
  updateOrder,
  updateOrderStatus,
  deleteOrder,
  getOrderStats,
} = require('./orders.controller');
const { createOrderValidator, updateOrderValidator, statusValidator } = require('./orders.validator');
const { validate } = require('../../middlewares/validate.middleware');
const { authenticate } = require('../../middlewares/auth.middleware');
const { tenantScope } = require('../../middlewares/tenant.middleware');

// All order routes require authentication + tenant scope
router.use(authenticate, tenantScope);

router.get('/stats', getOrderStats);         // Must come before /:id
router.get('/', listOrders);
router.post('/', createOrderValidator, validate, createOrder);
router.get('/:id', getOrder);
router.put('/:id', updateOrderValidator, validate, updateOrder);
router.patch('/:id/status', statusValidator, validate, updateOrderStatus);
router.delete('/:id', deleteOrder);

module.exports = router;
