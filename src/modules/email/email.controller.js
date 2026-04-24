'use strict';

const { getPrismaClient } = require('../../config/database');
const { sendSuccess, sendCreated } = require('../../utils/response');
const { AppError } = require('../../middlewares/error.middleware');
const { HTTP } = require('../../config/constants');
const { encrypt, decrypt } = require('../../utils/crypto');
const { testImapConnection } = require('./gmailFetcher.service');
const { extractOrderFromEmail } = require('./orderParser.service');

// ── EmailConfig — Save (upsert) ───────────────────────────────────────────────

/**
 * POST /api/v1/email/config  [PROTECTED]
 * Body: { gmailAddress, gmailAppPassword }
 *
 * 1. Encrypt app password with AES-256
 * 2. Upsert into EmailConfig table
 * 3. Test IMAP connection immediately
 * 4. Return success/fail with connection status
 */
const saveEmailConfig = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const { gmailAddress, gmailAppPassword } = req.body;
    const { tenantId } = req;

    const encryptedPassword = encrypt(gmailAppPassword);

    // Upsert config
    const config = await prisma.emailConfig.upsert({
      where: { tenantId },
      create: {
        tenantId,
        gmailAddress,
        gmailAppPassword: encryptedPassword,
        isActive: false, // set true only after connection test passes
      },
      update: {
        gmailAddress,
        gmailAppPassword: encryptedPassword,
        isActive: false,
      },
      select: { id: true, gmailAddress: true, isActive: true, lastCheckedAt: true },
    });

    // Test IMAP connection immediately
    let connectionOk = false;
    let connectionError = null;

    try {
      await testImapConnection(gmailAddress, gmailAppPassword);
      connectionOk = true;

      // Mark active if connection succeeded
      await prisma.emailConfig.update({
        where: { tenantId },
        data: { isActive: true },
      });
    } catch (err) {
      connectionError = err.message;
      // Keep isActive: false
    }

    return sendCreated(res, {
      message: connectionOk
        ? '✅ Gmail connected successfully! Polling will start within 2 minutes.'
        : `⚠️ Config saved but IMAP connection failed: ${connectionError}`,
      data: {
        ...config,
        isActive: connectionOk,
        gmailAppPassword: '****', // never return raw password
        connectionTest: connectionOk ? 'passed' : 'failed',
        connectionError: connectionError || null,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── EmailConfig — Get ─────────────────────────────────────────────────────────

/**
 * GET /api/v1/email/config  [PROTECTED]
 * Returns config without the app password.
 */
const getEmailConfig = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const config = await prisma.emailConfig.findUnique({
      where: { tenantId: req.tenantId },
      select: {
        id: true,
        gmailAddress: true,
        lastCheckedAt: true,
        isActive: true,
      },
    });

    return sendSuccess(res, {
      data: config
        ? { ...config, gmailAppPassword: '****', hasConfig: true }
        : { hasConfig: false, isActive: false },
    });
  } catch (err) {
    next(err);
  }
};

// ── EmailConfig — Delete ──────────────────────────────────────────────────────

/**
 * DELETE /api/v1/email/config  [PROTECTED]
 * Removes the EmailConfig and stops polling for this tenant.
 */
const deleteEmailConfig = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const existing = await prisma.emailConfig.findUnique({
      where: { tenantId: req.tenantId },
    });
    if (!existing) throw new AppError('No email configuration found.', HTTP.NOT_FOUND);

    await prisma.emailConfig.delete({ where: { tenantId: req.tenantId } });

    return sendSuccess(res, {
      message: 'Email configuration removed. Gmail polling stopped.',
      data: null,
    });
  } catch (err) {
    next(err);
  }
};

// ── Test existing connection ───────────────────────────────────────────────────

/**
 * POST /api/v1/email/config/test  [PROTECTED]
 * Re-test the saved IMAP connection without changing config.
 */
const testEmailConfig = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const config = await prisma.emailConfig.findUnique({
      where: { tenantId: req.tenantId },
    });
    if (!config) throw new AppError('No email configuration found. Please add one first.', HTTP.NOT_FOUND);

    const appPassword = decrypt(config.gmailAppPassword);

    try {
      await testImapConnection(config.gmailAddress, appPassword);

      await prisma.emailConfig.update({
        where: { tenantId: req.tenantId },
        data: { isActive: true },
      });

      return sendSuccess(res, {
        message: '✅ IMAP connection test passed.',
        data: { isActive: true, gmailAddress: config.gmailAddress },
      });
    } catch (err) {
      await prisma.emailConfig.update({
        where: { tenantId: req.tenantId },
        data: { isActive: false },
      });

      return sendSuccess(res, {
        message: `❌ IMAP connection test failed: ${err.message}`,
        data: { isActive: false, gmailAddress: config.gmailAddress },
      });
    }
  } catch (err) {
    next(err);
  }
};

// ── Raw Emails — list ─────────────────────────────────────────────────────────

/**
 * GET /api/v1/email/raw  [PROTECTED]
 * Returns recent raw emails fetched for this tenant (paginated).
 */
const getRawEmails = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const page  = Math.max(1, parseInt(req.query.page  || '1',  10));
    const limit = Math.min(50, parseInt(req.query.limit || '20', 10));
    const skip  = (page - 1) * limit;

    const [items, total] = await Promise.all([
      prisma.rawEmail.findMany({
        where: { tenantId: req.tenantId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: {
          id: true, messageId: true, subject: true, fromAddress: true,
          isParsed: true, processedAt: true, createdAt: true,
        },
      }),
      prisma.rawEmail.count({ where: { tenantId: req.tenantId } }),
    ]);

    return sendSuccess(res, {
      data: { items, total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
};

// ── Parse email manually (dev/test) ──────────────────────────────────────────

/**
 * POST /api/v1/email/parse  [PROTECTED]
 * Simulate receiving an order email — returns extracted order fields.
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
      data: { ...parsed, rawEmailId: messageId, parseConfidence: parsed._confidence },
    });
  } catch (err) {
    next(err);
  }
};

// ── Ingest email order (creates Order record) ─────────────────────────────────

/**
 * POST /api/v1/email/ingest  [PROTECTED]
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

    return sendCreated(res, { message: 'Order created from email.', data: order });
  } catch (err) {
    next(err);
  }
};

// ── Status (legacy compat) ────────────────────────────────────────────────────
const getEmailStatus = getEmailConfig;

module.exports = {
  saveEmailConfig,
  getEmailConfig,
  deleteEmailConfig,
  testEmailConfig,
  getRawEmails,
  parseEmail,
  ingestEmailOrder,
  getEmailStatus,
};
