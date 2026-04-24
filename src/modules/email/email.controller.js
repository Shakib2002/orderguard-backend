'use strict';

const { getPrismaClient } = require('../../config/database');
const { sendSuccess, sendCreated } = require('../../utils/response');
const { AppError } = require('../../middlewares/error.middleware');
const { HTTP } = require('../../config/constants');
const { decrypt } = require('../../utils/crypto');

// ── List Email Configs ────────────────────────────────────────────────────────

/**
 * GET /api/v1/email
 * Returns the email configuration and last check timestamp.
 */
const getEmailStatus = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const config = await prisma.emailConfig.findUnique({
      where: { tenantId: req.tenantId },
      select: {
        id: true, gmailAddress: true, lastCheckedAt: true, isActive: true,
      },
    });

    return sendSuccess(res, {
      data: config
        ? { ...config, hasPassword: true }
        : { hasPassword: false, isActive: false },
    });
  } catch (err) {
    next(err);
  }
};

// ── Parse / Simulate Email Orders ────────────────────────────────────────────

/**
 * POST /api/v1/email/parse
 * Manually trigger email parsing (dev/test — simulates receiving an order email).
 * In production, this would be triggered by a scheduled job or webhook.
 *
 * Expected body: { subject, body, from, messageId }
 * Returns the parsed order fields (does not auto-create the order).
 */
const parseEmail = async (req, res, next) => {
  try {
    const { subject, body: emailBody, from, messageId } = req.body;

    const parsed = extractOrderFromEmail({ subject, body: emailBody, from });

    if (!parsed) {
      return sendSuccess(res, {
        message: 'Could not extract order information from the provided email.',
        data: null,
      });
    }

    return sendSuccess(res, {
      message: 'Email parsed successfully.',
      data: {
        ...parsed,
        rawEmailId: messageId,
        parseConfidence: parsed._confidence,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── Ingest Parsed Email as Order ──────────────────────────────────────────────

/**
 * POST /api/v1/email/ingest
 * Takes a fully parsed order payload and creates an Order record.
 */
const ingestEmailOrder = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const {
      customerName, customerPhone, address, productName,
      quantity, totalPrice, externalId, rawEmailId, notes,
    } = req.body;

    const order = await prisma.order.create({
      data: {
        tenantId: req.tenantId,
        externalId,
        customerName,
        customerPhone,
        address,
        productName,
        quantity: quantity || 1,
        totalPrice,
        rawEmailId,
        notes,
        status: 'PENDING',
        callStatus: 'NOT_CALLED',
      },
    });

    return sendCreated(res, {
      message: 'Order created from email.',
      data: order,
    });
  } catch (err) {
    next(err);
  }
};

// ── Mark Email Config as Checked ─────────────────────────────────────────────

/**
 * PATCH /api/v1/email/last-checked
 * Update the lastCheckedAt timestamp (called by the polling job).
 */
const markChecked = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const config = await prisma.emailConfig.findUnique({
      where: { tenantId: req.tenantId },
    });
    if (!config) throw new AppError('Email configuration not found.', HTTP.NOT_FOUND);

    const updated = await prisma.emailConfig.update({
      where: { tenantId: req.tenantId },
      data: { lastCheckedAt: new Date() },
      select: { id: true, lastCheckedAt: true },
    });

    return sendSuccess(res, { data: updated });
  } catch (err) {
    next(err);
  }
};

// ── Email Parser Helper ───────────────────────────────────────────────────────

/**
 * Rudimentary pattern-matching parser for common Bangladeshi e-commerce
 * order notification emails (Daraz, Chaldal, Pathao, etc.).
 *
 * Returns a structured order object or null if confidence is too low.
 * Extend this with ML/NLP as the product matures.
 *
 * @param {{ subject: string, body: string, from: string }} email
 * @returns {object|null}
 */
const extractOrderFromEmail = ({ subject, body, from }) => {
  const text = `${subject}\n${body}`;
  let confidence = 0;
  const result = {};

  // Phone number
  const phoneMatch = text.match(/(?:phone|mobile|contact|মোবাইল)[:\s]*(\+?880|0)?(1[3-9]\d{8})/i);
  if (phoneMatch) {
    result.customerPhone = `0${phoneMatch[2]}`;
    confidence += 30;
  }

  // Customer name
  const nameMatch = text.match(/(?:customer|name|নাম|গ্রাহক)[:\s]+([A-Za-zঀ-৿\s]{3,50})/i);
  if (nameMatch) {
    result.customerName = nameMatch[1].trim();
    confidence += 20;
  }

  // Product name
  const productMatch = text.match(/(?:product|item|পণ্য)[:\s]+([^\n]{3,100})/i);
  if (productMatch) {
    result.productName = productMatch[1].trim();
    confidence += 20;
  }

  // Price
  const priceMatch = text.match(/(?:total|amount|price|মূল্য|টাকা)[:\s]*(?:BDT|৳|Tk\.?)?\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (priceMatch) {
    result.totalPrice = parseFloat(priceMatch[1].replace(/,/g, ''));
    confidence += 20;
  }

  // Address
  const addressMatch = text.match(/(?:address|ঠিকানা|delivery)[:\s]+([^\n]{5,200})/i);
  if (addressMatch) {
    result.address = addressMatch[1].trim();
    confidence += 10;
  }

  result._confidence = confidence;

  return confidence >= 50 ? result : null;
};

module.exports = { getEmailStatus, parseEmail, ingestEmailOrder, markChecked };
