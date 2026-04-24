'use strict';

const { getPrismaClient } = require('../../config/database');
const { sendSuccess, sendCreated, sendError, buildPaginationMeta } = require('../../utils/response');
const { AppError } = require('../../middlewares/error.middleware');
const { HTTP, PAGINATION } = require('../../config/constants');

// ── List Orders ───────────────────────────────────────────────────────────────

/**
 * GET /api/v1/orders
 * Paginated list of orders scoped to the authenticated tenant.
 * Supports filtering by status, callStatus, and search by customerPhone.
 */
const listOrders = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const tenantId = req.tenantId;

    const page = parseInt(req.query.page, 10) || PAGINATION.DEFAULT_PAGE;
    const limit = Math.min(parseInt(req.query.limit, 10) || PAGINATION.DEFAULT_LIMIT, PAGINATION.MAX_LIMIT);
    const skip = (page - 1) * limit;

    // Build dynamic where clause
    const where = { tenantId };

    if (req.query.status) where.status = req.query.status;
    if (req.query.callStatus) where.callStatus = req.query.callStatus;
    if (req.query.phone) {
      where.customerPhone = { contains: req.query.phone };
    }
    if (req.query.search) {
      where.OR = [
        { customerName: { contains: req.query.search, mode: 'insensitive' } },
        { productName: { contains: req.query.search, mode: 'insensitive' } },
        { externalId: { contains: req.query.search } },
      ];
    }

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          calls: {
            orderBy: { attemptNo: 'desc' },
            take: 1, // Only last call attempt
            select: { status: true, keypress: true, attemptNo: true, createdAt: true },
          },
        },
      }),
      prisma.order.count({ where }),
    ]);

    return sendSuccess(res, {
      data: orders,
      meta: buildPaginationMeta(total, page, limit),
    });
  } catch (err) {
    next(err);
  }
};

// ── Get Single Order ──────────────────────────────────────────────────────────

/**
 * GET /api/v1/orders/:id
 */
const getOrder = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
      include: {
        calls: {
          orderBy: { attemptNo: 'asc' },
        },
      },
    });

    if (!order) {
      throw new AppError('Order not found.', HTTP.NOT_FOUND);
    }

    return sendSuccess(res, { data: order });
  } catch (err) {
    next(err);
  }
};

// ── Create Order ──────────────────────────────────────────────────────────────

/**
 * POST /api/v1/orders
 */
const createOrder = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const { externalId, customerName, customerPhone, address, productName, quantity, totalPrice, notes } = req.body;

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
        notes,
      },
    });

    return sendCreated(res, {
      message: 'Order created successfully.',
      data: order,
    });
  } catch (err) {
    next(err);
  }
};

// ── Update Order ──────────────────────────────────────────────────────────────

/**
 * PUT /api/v1/orders/:id
 * Full or partial update.
 */
const updateOrder = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const { externalId, customerName, customerPhone, address, productName, quantity, totalPrice, notes } = req.body;

    // Verify ownership before update
    const existing = await prisma.order.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    });
    if (!existing) throw new AppError('Order not found.', HTTP.NOT_FOUND);

    const updated = await prisma.order.update({
      where: { id: req.params.id },
      data: {
        ...(externalId !== undefined && { externalId }),
        ...(customerName !== undefined && { customerName }),
        ...(customerPhone !== undefined && { customerPhone }),
        ...(address !== undefined && { address }),
        ...(productName !== undefined && { productName }),
        ...(quantity !== undefined && { quantity }),
        ...(totalPrice !== undefined && { totalPrice }),
        ...(notes !== undefined && { notes }),
      },
    });

    return sendSuccess(res, { message: 'Order updated.', data: updated });
  } catch (err) {
    next(err);
  }
};

// ── Update Order Status ───────────────────────────────────────────────────────

/**
 * PATCH /api/v1/orders/:id/status
 * Only status and callStatus fields — separate endpoint for clarity.
 */
const updateOrderStatus = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const { status, callStatus } = req.body;

    const existing = await prisma.order.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    });
    if (!existing) throw new AppError('Order not found.', HTTP.NOT_FOUND);

    const updated = await prisma.order.update({
      where: { id: req.params.id },
      data: {
        ...(status !== undefined && { status }),
        ...(callStatus !== undefined && { callStatus }),
      },
    });

    return sendSuccess(res, { message: 'Order status updated.', data: updated });
  } catch (err) {
    next(err);
  }
};

// ── Delete Order ──────────────────────────────────────────────────────────────

/**
 * DELETE /api/v1/orders/:id
 */
const deleteOrder = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();

    const existing = await prisma.order.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    });
    if (!existing) throw new AppError('Order not found.', HTTP.NOT_FOUND);

    await prisma.order.delete({ where: { id: req.params.id } });

    return sendSuccess(res, { message: 'Order deleted successfully.', data: null });
  } catch (err) {
    next(err);
  }
};

// ── Order Stats ───────────────────────────────────────────────────────────────

/**
 * GET /api/v1/orders/stats
 * Returns order counts grouped by status for dashboard widgets.
 */
const getOrderStats = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const tenantId = req.tenantId;

    const [statusGroups, callStatusGroups, recentFake] = await Promise.all([
      prisma.order.groupBy({
        by: ['status'],
        where: { tenantId },
        _count: { _all: true },
      }),
      prisma.order.groupBy({
        by: ['callStatus'],
        where: { tenantId },
        _count: { _all: true },
      }),
      prisma.order.count({
        where: {
          tenantId,
          status: 'FAKE',
          createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
        },
      }),
    ]);

    const byStatus = Object.fromEntries(
      statusGroups.map((g) => [g.status, g._count._all])
    );
    const byCallStatus = Object.fromEntries(
      callStatusGroups.map((g) => [g.callStatus, g._count._all])
    );

    return sendSuccess(res, {
      data: {
        byStatus,
        byCallStatus,
        fakeOrdersLast30Days: recentFake,
      },
    });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  listOrders,
  getOrder,
  createOrder,
  updateOrder,
  updateOrderStatus,
  deleteOrder,
  getOrderStats,
};
