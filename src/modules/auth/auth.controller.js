'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { getPrismaClient } = require('../../config/database');
const { config } = require('../../config/env');
const { BCRYPT_ROUNDS, HTTP, PLAN_LIMITS } = require('../../config/constants');
const { sendSuccess, sendCreated, sendError } = require('../../utils/response');
const { AppError } = require('../../middlewares/error.middleware');

// ── Token helpers ─────────────────────────────────────────────────────────────

/**
 * Build the JWT payload (same shape used everywhere).
 */
const buildPayload = (user) => ({
  userId: user.id,
  tenantId: user.tenantId,
  email: user.email,
  role: user.role,
});

/**
 * Sign access + refresh JWTs and persist the refresh token hash.
 * Returns { accessToken, refreshToken }.
 *
 * @param {object} user        - Prisma User record
 * @param {object} prisma      - Prisma client
 * @param {string|null} oldHash - Hash to delete before inserting new one (rotation)
 */
const issueTokens = async (user, prisma, oldHash = null) => {
  const payload = buildPayload(user);

  const accessToken = jwt.sign(payload, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessExpiresIn, // '15m'
  });

  const rawRefresh = jwt.sign(payload, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshExpiresIn, // '30d'
  });

  // Hash the raw refresh token for secure DB storage
  const tokenHash = crypto.createHash('sha256').update(rawRefresh).digest('hex');

  // Parse '30d' → ms → Date
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  // Atomically rotate: delete old hash (if any), insert new one
  await prisma.$transaction([
    ...(oldHash
      ? [prisma.refreshToken.deleteMany({ where: { tokenHash: oldHash } })]
      : []),
    prisma.refreshToken.create({
      data: { userId: user.id, tokenHash, expiresAt },
    }),
  ]);

  return { accessToken, refreshToken: rawRefresh };
};

/**
 * Hash a raw refresh token for DB lookup.
 */
const hashToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

// ── Slug generator ────────────────────────────────────────────────────────────

/**
 * Generate a URL-safe slug from a business name.
 * Appends 4 random digits to guarantee uniqueness without a DB round-trip.
 * e.g. "My Shop BD" → "my-shop-bd-4821"
 */
const generateSlug = (businessName) => {
  const base = businessName
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 46); // reserve 5 chars for "-XXXX"

  const suffix = Math.floor(1000 + Math.random() * 9000); // always 4 digits
  return `${base}-${suffix}`;
};

// ── Shared user response shape ────────────────────────────────────────────────

const formatUser = (user) => ({
  id: user.id,
  email: user.email,
  fullName: user.fullName,
  role: user.role,
});

const formatTenant = (tenant) => ({
  id: tenant.id,
  businessName: tenant.businessName,
  slug: tenant.slug,
  inboundEmail: tenant.inboundEmail,
  whatsappNumber: tenant.whatsappNumber ?? null,
  planType: tenant.planType,
  isActive: tenant.isActive,
  createdAt: tenant.createdAt,
});

// ── Register ──────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/auth/register
 * Creates a Tenant + first SELLER user in one DB transaction.
 * Body (validated by Joi): { businessName, email, password, fullName, phone }
 */
const register = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const { businessName, email, password, fullName, phone } = req.body;

    // Check email uniqueness upfront for a clean error message
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return sendError(res, {
        statusCode: HTTP.CONFLICT,
        message: 'An account with this email already exists.',
        errors: [{ field: 'email', message: 'Email is already registered' }],
      });
    }

    // Generate slug (4-digit suffix makes collision near-impossible)
    let slug = generateSlug(businessName);
    // Belt-and-suspenders: if slug collides, regenerate once
    const slugExists = await prisma.tenant.findUnique({ where: { slug } });
    if (slugExists) slug = generateSlug(businessName);

    const inboundEmail = `${slug}@mail.orderguard.app`;
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Atomic: Tenant + User created together or not at all
    const { tenant, user } = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          businessName,
          slug,
          inboundEmail,
          whatsappNumber: phone, // store phone as whatsappNumber
        },
      });

      const user = await tx.user.create({
        data: {
          tenantId: tenant.id,
          email,
          passwordHash,
          fullName,
          role: 'SELLER',
        },
      });

      return { tenant, user };
    });

    const { accessToken, refreshToken } = await issueTokens(user, prisma);

    return sendCreated(res, {
      message: 'Registration successful. Welcome to OrderGuard!',
      data: {
        accessToken,
        refreshToken,
        user: formatUser(user),
        tenant: formatTenant(tenant),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── Login ─────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/auth/login
 * Body: { email, password }
 */
const login = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const { email, password } = req.body;

    // Single query: user + tenant (avoids N+1)
    const user = await prisma.user.findUnique({
      where: { email },
      include: {
        tenant: {
          select: {
            id: true, businessName: true, slug: true, inboundEmail: true,
            whatsappNumber: true, planType: true, isActive: true, createdAt: true,
          },
        },
      },
    });

    // Use same error for "not found" and "wrong password" to prevent user enumeration
    if (!user) {
      return sendError(res, {
        statusCode: HTTP.UNAUTHORIZED,
        message: 'Invalid email or password.',
      });
    }

    // 403 — tenant suspended (distinct from auth failure)
    if (!user.tenant.isActive) {
      return sendError(res, {
        statusCode: HTTP.FORBIDDEN,
        message: 'This account has been suspended. Please contact support@orderguard.app.',
      });
    }

    const passwordMatch = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatch) {
      return sendError(res, {
        statusCode: HTTP.UNAUTHORIZED,
        message: 'Invalid email or password.',
      });
    }

    const { accessToken, refreshToken } = await issueTokens(user, prisma);

    return sendSuccess(res, {
      message: 'Login successful.',
      data: {
        accessToken,
        refreshToken,
        user: formatUser(user),
        tenant: formatTenant(user.tenant),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── Refresh Token (with rotation) ─────────────────────────────────────────────

/**
 * POST /api/v1/auth/refresh
 * Body: { refreshToken }
 *
 * Security model:
 *  1. Verify JWT signature + expiry
 *  2. Look up hash in DB — if not found it was already rotated (replay attack)
 *  3. Delete old hash, issue new access + refresh token pair
 */
const refresh = async (req, res, next) => {
  try {
    const { refreshToken: rawToken } = req.body;
    const prisma = getPrismaClient();

    // Step 1 — verify JWT
    let decoded;
    try {
      decoded = jwt.verify(rawToken, config.jwt.refreshSecret);
    } catch (err) {
      return sendError(res, {
        statusCode: HTTP.UNAUTHORIZED,
        message: err.name === 'TokenExpiredError'
          ? 'Refresh token expired. Please log in again.'
          : 'Invalid refresh token.',
      });
    }

    // Step 2 — check hash exists in DB (detects replay / already-rotated token)
    const tokenHash = hashToken(rawToken);
    const storedToken = await prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: {
            tenant: { select: { isActive: true } },
          },
        },
      },
    });

    if (!storedToken) {
      // Possible token theft / reuse — could add logging/alerting here
      return sendError(res, {
        statusCode: HTTP.UNAUTHORIZED,
        message: 'Refresh token has already been used or revoked. Please log in again.',
      });
    }

    if (new Date() > storedToken.expiresAt) {
      await prisma.refreshToken.delete({ where: { tokenHash } });
      return sendError(res, {
        statusCode: HTTP.UNAUTHORIZED,
        message: 'Refresh token expired. Please log in again.',
      });
    }

    const { user } = storedToken;

    if (!user.tenant?.isActive) {
      return sendError(res, {
        statusCode: HTTP.FORBIDDEN,
        message: 'Account suspended. Contact support.',
      });
    }

    // Step 3 — rotate: delete old hash + issue new pair
    const tokens = await issueTokens(user, prisma, tokenHash);

    return sendSuccess(res, {
      message: 'Tokens refreshed successfully.',
      data: tokens,
    });
  } catch (err) {
    next(err);
  }
};

// ── Logout ────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/auth/logout  [PROTECTED]
 * Invalidates the refresh token stored in DB.
 * Body: { refreshToken }  — optional but recommended so client doesn't need
 * a separate lookup. Falls back to deleting ALL tokens for the user.
 */
const logout = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const { refreshToken: rawToken } = req.body;

    if (rawToken) {
      // Invalidate specific token
      const tokenHash = hashToken(rawToken);
      await prisma.refreshToken.deleteMany({ where: { tokenHash } });
    } else {
      // Nuclear option: revoke ALL sessions for this user
      await prisma.refreshToken.deleteMany({ where: { userId: req.user.userId } });
    }

    return sendSuccess(res, {
      message: 'Logged out successfully.',
      data: null,
    });
  } catch (err) {
    next(err);
  }
};

// ── Me ────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/auth/me  [PROTECTED]
 * Returns current user + tenant + plan limits + live usage stats.
 */
const me = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const { userId, tenantId } = req.user;

    // Start of current calendar month
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    // Parallel fetch: user profile + usage stats
    const [user, orderCounts, callsThisMonth, totalOrders] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true, email: true, fullName: true, role: true,
          fcmToken: true, createdAt: true,
          tenant: {
            select: {
              id: true, businessName: true, slug: true, inboundEmail: true,
              whatsappNumber: true, gmailAddress: true,
              planType: true, isActive: true, createdAt: true,
            },
          },
        },
      }),

      // Orders grouped by status (for dashboard overview)
      prisma.order.groupBy({
        by: ['status'],
        where: { tenantId },
        _count: { _all: true },
      }),

      // Calls this month
      prisma.call.count({
        where: { tenantId, createdAt: { gte: monthStart } },
      }),

      // Total orders ever
      prisma.order.count({ where: { tenantId } }),
    ]);

    if (!user) throw new AppError('User not found.', HTTP.NOT_FOUND);

    // Build status breakdown map
    const ordersByStatus = Object.fromEntries(
      orderCounts.map((g) => [g.status, g._count._all])
    );

    // Plan limits for the tenant's current plan
    const planLimits = PLAN_LIMITS[user.tenant.planType] || PLAN_LIMITS.FREE;

    return sendSuccess(res, {
      data: {
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          role: user.role,
          fcmToken: user.fcmToken,
          createdAt: user.createdAt,
        },
        tenant: user.tenant,
        plan: {
          type: user.tenant.planType,
          limits: {
            ordersPerMonth: planLimits.ordersPerMonth === Infinity ? null : planLimits.ordersPerMonth,
            callsPerMonth: planLimits.callsPerMonth === Infinity ? null : planLimits.callsPerMonth,
            users: planLimits.users === Infinity ? null : planLimits.users,
          },
        },
        usage: {
          totalOrders,
          ordersByStatus,
          callsThisMonth,
          fakeOrders: ordersByStatus['FAKE'] || 0,
          pendingOrders: ordersByStatus['PENDING'] || 0,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

// ── Update FCM Token ──────────────────────────────────────────────────────────

/**
 * PATCH /api/v1/auth/fcm-token  [PROTECTED]
 */
const updateFcmToken = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    await prisma.user.update({
      where: { id: req.user.userId },
      data: { fcmToken: req.body.fcmToken },
    });
    return sendSuccess(res, { message: 'FCM token updated.' });
  } catch (err) {
    next(err);
  }
};

module.exports = { register, login, refresh, logout, me, updateFcmToken };
