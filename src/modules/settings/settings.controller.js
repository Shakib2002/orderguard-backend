'use strict';

const { getPrismaClient }        = require('../../config/database');
const { sendSuccess, sendCreated } = require('../../utils/response');
const { AppError }               = require('../../middlewares/error.middleware');
const { HTTP }                   = require('../../config/constants');
const logger                     = require('../../utils/logger');
const { testImapConnection }     = require('../email/gmailFetcher.service');

// ── Helper: get or create CallSettings defaults ───────────────────────────────
const getOrCreateCallSettings = async (prisma, tenantId) => {
  return prisma.callSettings.upsert({
    where:  { tenantId },
    create: { tenantId },
    update: {},
  });
};

// ── Helper: get month start ───────────────────────────────────────────────────
const monthStart = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/settings
// ═══════════════════════════════════════════════════════════════════════════════
const getSettings = async (req, res, next) => {
  try {
    const prisma   = getPrismaClient();
    const tenantId = req.tenantId;

    const [tenant, emailConfig, callSettings, callsThisMonth, ordersThisMonth] =
      await Promise.all([
        prisma.tenant.findUnique({ where: { id: tenantId } }),
        prisma.emailConfig.findUnique({
          where:  { tenantId },
          select: { gmailAddress: true, isActive: true, lastCheckedAt: true },
        }),
        getOrCreateCallSettings(prisma, tenantId),
        prisma.call.count({
          where: { tenantId, createdAt: { gte: monthStart() } },
        }),
        prisma.order.count({
          where: { tenantId, createdAt: { gte: monthStart() } },
        }),
      ]);

    if (!tenant) throw new AppError('Tenant not found.', HTTP.NOT_FOUND);

    // Plan-based limits
    const PLAN_LIMITS = { FREE: 100, BASIC: 500, PRO: 99999 };
    const callsLimit  = PLAN_LIMITS[tenant.planType] || 100;

    return sendSuccess(res, {
      data: {
        tenant: {
          businessName:  tenant.businessName,
          slug:          tenant.slug,
          inboundEmail:  tenant.inboundEmail,
          planType:      tenant.planType,
          whatsappNumber: tenant.whatsappNumber || null,
        },
        emailConfig: emailConfig
          ? {
              gmailAddress:  emailConfig.gmailAddress,
              isActive:      emailConfig.isActive,
              lastCheckedAt: emailConfig.lastCheckedAt,
              isConnected:   emailConfig.isActive,
            }
          : null,
        integrations: {
          gmail: {
            connected: Boolean(emailConfig?.isActive),
            lastSync:  emailConfig?.lastCheckedAt || null,
          },
          whatsapp: {
            number:   tenant.whatsappNumber || null,
            verified: Boolean(tenant.whatsappNumber),
          },
          googleSheets: {
            connected:  false, // Phase 2
            sheetName:  null,
          },
        },
        callSettings: {
          autoCallEnabled: callSettings.autoCallEnabled,
          smsEnabled:      callSettings.smsEnabled,
          retryAttempts:   callSettings.retryAttempts,
          callWindowStart: callSettings.callWindowStart,
          callWindowEnd:   callSettings.callWindowEnd,
          delayMinutes:    callSettings.delayMinutes,
        },
        usage: {
          callsThisMonth,
          callsLimit,
          ordersThisMonth,
        },
      },
    });
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH /api/v1/settings/business
// ═══════════════════════════════════════════════════════════════════════════════
const updateBusiness = async (req, res, next) => {
  try {
    const prisma   = getPrismaClient();
    const { businessName, whatsappNumber } = req.body;

    const updated = await prisma.tenant.update({
      where: { id: req.tenantId },
      data: {
        ...(businessName    !== undefined && { businessName }),
        ...(whatsappNumber  !== undefined && { whatsappNumber: whatsappNumber || null }),
      },
      select: { id: true, businessName: true, slug: true, whatsappNumber: true, planType: true },
    });

    logger.info('settings: business updated', { tenantId: req.tenantId, by: req.userId });

    return sendSuccess(res, {
      message: 'Business settings updated.',
      data:    updated,
    });
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════════════════════════
// PATCH /api/v1/settings/call-preferences
// ═══════════════════════════════════════════════════════════════════════════════
const updateCallPreferences = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const {
      autoCallEnabled, smsEnabled, retryAttempts,
      callWindowStart, callWindowEnd, delayMinutes,
    } = req.body;

    // Validate time format HH:MM
    const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (callWindowStart && !timeRe.test(callWindowStart))
      throw new AppError('callWindowStart must be HH:MM format (e.g. "09:00")', HTTP.BAD_REQUEST);
    if (callWindowEnd && !timeRe.test(callWindowEnd))
      throw new AppError('callWindowEnd must be HH:MM format (e.g. "21:00")', HTTP.BAD_REQUEST);
    if (retryAttempts !== undefined && (retryAttempts < 1 || retryAttempts > 3))
      throw new AppError('retryAttempts must be 1, 2, or 3', HTTP.BAD_REQUEST);
    if (delayMinutes !== undefined && ![0, 5, 10, 15, 30].includes(delayMinutes))
      throw new AppError('delayMinutes must be 0, 5, 10, 15, or 30', HTTP.BAD_REQUEST);

    const updated = await prisma.callSettings.upsert({
      where:  { tenantId: req.tenantId },
      create: {
        tenantId: req.tenantId,
        ...(autoCallEnabled !== undefined && { autoCallEnabled }),
        ...(smsEnabled      !== undefined && { smsEnabled }),
        ...(retryAttempts   !== undefined && { retryAttempts }),
        ...(callWindowStart !== undefined && { callWindowStart }),
        ...(callWindowEnd   !== undefined && { callWindowEnd }),
        ...(delayMinutes    !== undefined && { delayMinutes }),
      },
      update: {
        ...(autoCallEnabled !== undefined && { autoCallEnabled }),
        ...(smsEnabled      !== undefined && { smsEnabled }),
        ...(retryAttempts   !== undefined && { retryAttempts }),
        ...(callWindowStart !== undefined && { callWindowStart }),
        ...(callWindowEnd   !== undefined && { callWindowEnd }),
        ...(delayMinutes    !== undefined && { delayMinutes }),
      },
    });

    logger.info('settings: call preferences updated', { tenantId: req.tenantId });

    return sendSuccess(res, {
      message: 'Call preferences updated.',
      data:    updated,
    });
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/settings/email/test-connection
// ═══════════════════════════════════════════════════════════════════════════════
const testEmailConnection = async (req, res, next) => {
  try {
    const { gmailAddress, gmailAppPassword } = req.body;

    try {
      // 8-second timeout handled inside testImapConnection
      await testImapConnection(gmailAddress, gmailAppPassword);
      return sendSuccess(res, {
        data: { connected: true, error: null, gmailAddress },
      });
    } catch (err) {
      return sendSuccess(res, {
        data: { connected: false, error: err.message, gmailAddress },
      });
    }
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/settings/inbound-email
// ═══════════════════════════════════════════════════════════════════════════════
const getInboundEmail = async (req, res, next) => {
  try {
    const prisma  = getPrismaClient();
    const tenant  = await prisma.tenant.findUnique({
      where:  { id: req.tenantId },
      select: { slug: true, inboundEmail: true },
    });
    if (!tenant) throw new AppError('Tenant not found.', HTTP.NOT_FOUND);

    const forwardingAddress = tenant.inboundEmail ||
      `${tenant.slug}@mail.orderguard.app`;

    return sendSuccess(res, {
      data: {
        forwardingAddress,
        setupSteps: [
          {
            step:        1,
            title:       'Gmail খুলুন',
            description: 'Settings (⚙️) > See all settings > Forwarding and POP/IMAP',
          },
          {
            step:        2,
            title:       'Forwarding Address যোগ করুন',
            description: `"Add a forwarding address" এ click করুন এবং এই address দিন: ${forwardingAddress}`,
          },
          {
            step:        3,
            title:       'Confirm করুন',
            description: 'Gmail একটি confirmation email পাঠাবে। সেই email-এর link click করুন।',
          },
          {
            step:        4,
            title:       'Forwarding চালু করুন',
            description: `"Forward a copy of incoming mail to ${forwardingAddress}" select করুন → Save Changes`,
          },
        ],
        alternativeMethod: {
          title:       'Gmail Filter ব্যবহার করুন',
          description: 'নির্দিষ্ট subject (অর্ডার, order) দিয়ে filter করে শুধু order email forward করুন।',
          filterQuery: 'subject:(অর্ডার OR order OR purchase OR invoice)',
        },
      },
    });
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/settings/fcm-token
// ═══════════════════════════════════════════════════════════════════════════════
const saveFcmToken = async (req, res, next) => {
  try {
    const prisma    = getPrismaClient();
    const { fcmToken } = req.body;

    await prisma.user.update({
      where: { id: req.userId },
      data:  { fcmToken },
    });

    logger.info('settings: FCM token saved', { userId: req.userId });

    return sendSuccess(res, {
      message: 'FCM token saved. Push notifications enabled.',
      data:    { fcmToken: fcmToken.slice(0, 20) + '...' },
    });
  } catch (err) { next(err); }
};

module.exports = {
  getSettings,
  updateBusiness,
  updateCallPreferences,
  testEmailConnection,
  getInboundEmail,
  saveFcmToken,
};
