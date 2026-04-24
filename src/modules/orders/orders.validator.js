'use strict';

const { body } = require('express-validator');
const { phoneField } = require('../../utils/validators');

const createOrderValidator = [
  body('customerName')
    .trim()
    .notEmpty().withMessage('Customer name is required')
    .isLength({ max: 150 }).withMessage('Customer name too long'),

  phoneField('customerPhone'),

  body('productName')
    .trim()
    .notEmpty().withMessage('Product name is required')
    .isLength({ max: 250 }).withMessage('Product name too long'),

  body('totalPrice')
    .notEmpty().withMessage('Total price is required')
    .isDecimal({ decimal_digits: '0,2' }).withMessage('Total price must be a valid decimal number')
    .toFloat(),

  body('quantity')
    .optional()
    .isInt({ min: 1 }).withMessage('Quantity must be a positive integer')
    .toInt(),

  body('externalId')
    .optional()
    .trim()
    .isLength({ max: 100 }).withMessage('External ID too long'),

  body('address')
    .optional()
    .trim()
    .isLength({ max: 500 }).withMessage('Address too long'),

  body('notes')
    .optional()
    .trim()
    .isLength({ max: 1000 }).withMessage('Notes too long'),
];

const updateOrderValidator = [
  body('customerName')
    .optional()
    .trim()
    .isLength({ min: 1, max: 150 }).withMessage('Customer name must be 1–150 characters'),

  body('customerPhone')
    .optional()
    .matches(/^(\+?880|0)1[3-9]\d{8}$/)
    .withMessage('Enter a valid Bangladesh phone number'),

  body('productName')
    .optional()
    .trim()
    .isLength({ min: 1, max: 250 }).withMessage('Product name must be 1–250 characters'),

  body('totalPrice')
    .optional()
    .isDecimal({ decimal_digits: '0,2' }).withMessage('Total price must be a valid decimal number')
    .toFloat(),

  body('quantity')
    .optional()
    .isInt({ min: 1 }).withMessage('Quantity must be a positive integer')
    .toInt(),
];

const statusValidator = [
  body('status')
    .optional()
    .isIn(['PENDING', 'CONFIRMED', 'CANCELLED', 'FAKE', 'DELIVERED'])
    .withMessage('Invalid order status. Must be one of: PENDING, CONFIRMED, CANCELLED, FAKE, DELIVERED'),

  body('callStatus')
    .optional()
    .isIn(['NOT_CALLED', 'QUEUED', 'CALLING', 'CONFIRMED', 'REJECTED', 'NO_RESPONSE'])
    .withMessage('Invalid call status'),

  body()
    .custom((value, { req }) => {
      if (!req.body.status && !req.body.callStatus) {
        throw new Error('At least one of status or callStatus must be provided');
      }
      return true;
    }),
];

module.exports = { createOrderValidator, updateOrderValidator, statusValidator };
