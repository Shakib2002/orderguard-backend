'use strict';

const { getPrismaClient } = require('../../config/database');
const { sendSuccess, sendError } = require('../../utils/response');
const { AppError } = require('../../middlewares/error.middleware');
const { HTTP } = require('../../config/constants');
const { encrypt, decrypt } = require('../../utils/crypto');

// ── Get Tenant Settings ───────────────────────────────────────────────────────

/**
 * GET /api/v1/tenants/settings
 * Returns current tenant profile (excluding sensitive encrypted fields).
 */
const getSettings = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const tenant = await prisma.tenant.findUnique({
      where: { id: req.tenantId },
      select: {
        id: true,
        businessName: true,
        slug: true,
        inboundEmail: true,
        whatsappNumber: true,
        gmailAddress: true,
        planType: true,
        isActive: true,
        createdAt: true,
        _count: {
          select: { orders: true, users: true },
        },
      },
    });

    if (!tenant) throw new AppError('Tenant not found.', HTTP.NOT_FOUND);

    return sendSuccess(res, { data: tenant });
  } catch (err) {
    next(err);
  }
};

// ── Update Tenant Settings ────────────────────────────────────────────────────

/**
 * PATCH /api/v1/tenants/settings
 */
const updateSettings = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const { businessName, whatsappNumber, gmailAddress } = req.body;

    const updated = await prisma.tenant.update({
      where: { id: req.tenantId },
      data: {
        ...(businessName !== undefined && { businessName }),
        ...(whatsappNumber !== undefined && { whatsappNumber }),
        ...(gmailAddress !== undefined && { gmailAddress }),
      },
      select: {
        id: true, businessName: true, slug: true, inboundEmail: true,
        whatsappNumber: true, gmailAddress: true, planType: true, isActive: true,
      },
    });

    return sendSuccess(res, { message: 'Settings updated successfully.', data: updated });
  } catch (err) {
    next(err);
  }
};

// ── List Tenant Users ─────────────────────────────────────────────────────────

/**
 * GET /api/v1/tenants/users
 */
const listUsers = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const users = await prisma.user.findMany({
      where: { tenantId: req.tenantId },
      select: {
        id: true, email: true, fullName: true, role: true, createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    return sendSuccess(res, { data: users });
  } catch (err) {
    next(err);
  }
};

// ── Invite / Create User ──────────────────────────────────────────────────────

/**
 * POST /api/v1/tenants/users
 * Creates an additional user under this tenant (SUPER_ADMIN only).
 */
const createUser = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const bcrypt = require('bcryptjs');
    const { BCRYPT_ROUNDS } = require('../../config/constants');
    const { email, password, fullName, role } = req.body;

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const user = await prisma.user.create({
      data: {
        tenantId: req.tenantId,
        email,
        passwordHash,
        fullName,
        role: role || 'SELLER',
      },
      select: { id: true, email: true, fullName: true, role: true, createdAt: true },
    });

    return sendSuccess(res, {
      statusCode: HTTP.CREATED,
      message: 'User created successfully.',
      data: user,
    });
  } catch (err) {
    next(err);
  }
};

// ── Email Config ──────────────────────────────────────────────────────────────

/**
 * GET /api/v1/tenants/email-config
 * Returns email config (app password masked).
 */
const getEmailConfig = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const config = await prisma.emailConfig.findUnique({
      where: { tenantId: req.tenantId },
      select: {
        id: true, gmailAddress: true, lastCheckedAt: true, isActive: true,
        // Never send the raw encrypted password to client
      },
    });

    return sendSuccess(res, {
      data: config
        ? { ...config, gmailAppPassword: '****' }
        : null,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * PUT /api/v1/tenants/email-config
 * Upsert email configuration (stores encrypted app password).
 */
const upsertEmailConfig = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const { gmailAddress, gmailAppPassword } = req.body;

    const encryptedPassword = encrypt(gmailAppPassword);

    const config = await prisma.emailConfig.upsert({
      where: { tenantId: req.tenantId },
      create: {
        tenantId: req.tenantId,
        gmailAddress,
        gmailAppPassword: encryptedPassword,
        isActive: true,
      },
      update: {
        gmailAddress,
        gmailAppPassword: encryptedPassword,
        isActive: true,
      },
      select: { id: true, gmailAddress: true, isActive: true, lastCheckedAt: true },
    });

    // Also update tenant's gmailAddress
    await prisma.tenant.update({
      where: { id: req.tenantId },
      data: { gmailAddress },
    });

    return sendSuccess(res, {
      message: 'Email configuration saved successfully.',
      data: { ...config, gmailAppPassword: '****' },
    });
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/v1/tenants/email-config
 */
const deleteEmailConfig = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const existing = await prisma.emailConfig.findUnique({
      where: { tenantId: req.tenantId },
    });

    if (!existing) throw new AppError('Email configuration not found.', HTTP.NOT_FOUND);

    await prisma.emailConfig.delete({ where: { tenantId: req.tenantId } });

    return sendSuccess(res, { message: 'Email configuration removed.', data: null });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  getSettings,
  updateSettings,
  listUsers,
  createUser,
  getEmailConfig,
  upsertEmailConfig,
  deleteEmailConfig,
};
