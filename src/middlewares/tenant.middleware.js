'use strict';

const { getPrismaClient } = require('../config/database');
const { sendError } = require('../utils/response');
const { HTTP } = require('../config/constants');

/**
 * Tenant scope middleware.
 *
 * Verifies the tenant from the JWT is active, then ensures req.tenantId
 * and req.tenantPlan are available for all downstream controllers.
 *
 * NOTE: authenticateToken already sets req.tenantId from the JWT payload.
 * This middleware performs the live DB check (isActive, planType) on top.
 *
 * Must be used AFTER authenticateToken.
 */
const tenantScope = async (req, res, next) => {
  try {
    // Support both req.tenantId (set by authenticateToken) and req.user.tenantId
    const tenantId = req.tenantId || req.user?.tenantId;

    if (!tenantId) {
      return sendError(res, {
        statusCode: HTTP.UNAUTHORIZED,
        message: 'Tenant information missing from token.',
      });
    }

    const prisma = getPrismaClient();
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, isActive: true, planType: true },
    });

    if (!tenant) {
      return sendError(res, {
        statusCode: HTTP.FORBIDDEN,
        message: 'Tenant not found.',
      });
    }

    if (!tenant.isActive) {
      return sendError(res, {
        statusCode: HTTP.FORBIDDEN,
        message: 'Your account has been suspended. Please contact support@orderguard.app.',
      });
    }

    // Guarantee req.tenantId is set even if authenticateToken didn't run first
    req.tenantId = tenant.id;
    req.tenantPlan = tenant.planType;

    next();
  } catch (err) {
    next(err);
  }
};

module.exports = { tenantScope };
