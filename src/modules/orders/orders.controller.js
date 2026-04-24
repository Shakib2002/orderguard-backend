'use strict';

const { getPrismaClient } = require('../../config/database');
const { sendSuccess, sendCreated } = require('../../utils/response');
const { AppError } = require('../../middlewares/error.middleware');
const { HTTP, PAGINATION } = require('../../config/constants');
const logger = require('../../utils/logger');
const { orderEvents } = require('../email/orderParser.service');

// ── Allowed sort fields ────────────────────────────────────────────────────────
const SORTABLE = ['createdAt', 'updatedAt', 'totalPrice'];
const VALID_STATUS     = ['PENDING', 'CONFIRMED', 'CANCELLED', 'FAKE', 'DELIVERED'];
const VALID_CALL_STATUS = ['NOT_CALLED', 'CONFIRMED', 'REJECTED', 'NO_RESPONSE'];

// ── Helper: verify order belongs to tenant ────────────────────────────────────
const requireOrder = async (prisma, orderId, tenantId) => {
  const order = await prisma.order.findFirst({
    where: { id: orderId, tenantId },
  });
  if (!order) throw new AppError('Order not found.', HTTP.NOT_FOUND);
  return order;
};

// ── List Orders ───────────────────────────────────────────────────────────────
/**
 * GET /api/v1/orders
 * Query: status, callStatus, search, page, limit, sortBy, sortOrder
 */
const listOrders = async (req, res, next) => {
  try {
    const prisma   = getPrismaClient();
    const tenantId = req.tenantId;

    const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit = Math.min(
      Math.max(1, parseInt(req.query.limit, 10) || PAGINATION.DEFAULT_LIMIT),
      PAGINATION.MAX_LIMIT
    );
    const skip  = (page - 1) * limit;

    const sortBy    = SORTABLE.includes(req.query.sortBy) ? req.query.sortBy : 'createdAt';
    const sortOrder = req.query.sortOrder === 'asc' ? 'asc' : 'desc';

    // Build where clause
    const where = { tenantId };
    if (req.query.status    && VALID_STATUS.includes(req.query.status))
      where.status = req.query.status;
    if (req.query.callStatus && VALID_CALL_STATUS.includes(req.query.callStatus))
      where.callStatus = req.query.callStatus;
    if (req.query.search) {
      where.OR = [
        { customerName:  { contains: req.query.search, mode: 'insensitive' } },
        { customerPhone: { contains: req.query.search } },
        { externalId:    { contains: req.query.search, mode: 'insensitive' } },
        { productName:   { contains: req.query.search, mode: 'insensitive' } },
      ];
    }

    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        skip,
        take:     limit,
        orderBy:  { [sortBy]: sortOrder },
        include: {
          calls: {
            orderBy: { attemptNo: 'desc' },
            take: 1,
            select: { status: true, keypress: true, attemptNo: true, createdAt: true },
          },
        },
      }),
      prisma.order.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit);

    return sendSuccess(res, {
      data: {
        orders,
        pagination: {
          total,
          page,
          limit,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
        },
      },
    });
  } catch (err) { next(err); }
};

// ── Get Single Order ──────────────────────────────────────────────────────────
/**
 * GET /api/v1/orders/:orderId
 * Returns full order + all calls.
 */
const getOrder = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const order = await prisma.order.findFirst({
      where: { id: req.params.orderId, tenantId: req.tenantId },
      include: { calls: { orderBy: { attemptNo: 'asc' } } },
    });
    if (!order) throw new AppError('Order not found.', HTTP.NOT_FOUND);
    return sendSuccess(res, { data: order });
  } catch (err) { next(err); }
};

// ── Create Order (manual) ─────────────────────────────────────────────────────
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
        externalId:    externalId    || null,
        customerName,
        customerPhone,
        address:       address       || null,
        productName,
        quantity:      quantity      || 1,
        totalPrice,
        notes:         notes         || null,
        status:        'PENDING',
        callStatus:    'NOT_CALLED',
      },
    });

    logger.info('orders: manual order created', {
      tenantId: req.tenantId, orderId: order.id, by: req.userId,
    });

    return sendCreated(res, { message: 'Order created successfully.', data: order });
  } catch (err) { next(err); }
};

// ── Update Order (full edit) ──────────────────────────────────────────────────
/**
 * PUT /api/v1/orders/:orderId
 */
const updateOrder = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    await requireOrder(prisma, req.params.orderId, req.tenantId);

    const { externalId, customerName, customerPhone, address, productName, quantity, totalPrice, notes } = req.body;

    const updated = await prisma.order.update({
      where: { id: req.params.orderId },
      data: {
        ...(externalId    !== undefined && { externalId }),
        ...(customerName  !== undefined && { customerName }),
        ...(customerPhone !== undefined && { customerPhone }),
        ...(address       !== undefined && { address }),
        ...(productName   !== undefined && { productName }),
        ...(quantity      !== undefined && { quantity }),
        ...(totalPrice    !== undefined && { totalPrice }),
        ...(notes         !== undefined && { notes }),
      },
    });

    return sendSuccess(res, { message: 'Order updated.', data: updated });
  } catch (err) { next(err); }
};

// ── Update Order Status ───────────────────────────────────────────────────────
/**
 * PATCH /api/v1/orders/:orderId/status
 * Body: { status, notes? }
 */
const updateOrderStatus = async (req, res, next) => {
  try {
    const prisma    = getPrismaClient();
    const { status, notes } = req.body;
    const existing  = await requireOrder(prisma, req.params.orderId, req.tenantId);

    const appendNote = notes
      ? `\n[${new Date().toISOString()}] Status changed ${existing.status} → ${status}. Note: ${notes}`
      : `\n[${new Date().toISOString()}] Status changed ${existing.status} → ${status} by user ${req.userId}`;

    const updated = await prisma.order.update({
      where: { id: req.params.orderId },
      data:  {
        status,
        notes: existing.notes ? existing.notes + appendNote : appendNote.trim(),
      },
    });

    // Emit events for downstream actions
    if (status === 'CONFIRMED') {
      orderEvents.emit('order.confirmed', { order: updated, tenantId: req.tenantId });
      logger.info('orders: status → CONFIRMED', { tenantId: req.tenantId, orderId: updated.id });
    }
    if (status === 'DELIVERED') {
      orderEvents.emit('order.delivered', { order: updated, tenantId: req.tenantId });
      logger.info('orders: status → DELIVERED (follow-up queued)', { orderId: updated.id });
    }
    if (status === 'FAKE') {
      orderEvents.emit('order.flagged_fake', { order: updated, tenantId: req.tenantId });
      logger.warn('orders: status → FAKE', { tenantId: req.tenantId, orderId: updated.id });
    }

    return sendSuccess(res, { message: `Order status updated to ${status}.`, data: updated });
  } catch (err) { next(err); }
};

// ── Update Call Status ────────────────────────────────────────────────────────
/**
 * PATCH /api/v1/orders/:orderId/call-status
 * Body: { callStatus }
 */
const updateCallStatus = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const { callStatus } = req.body;
    await requireOrder(prisma, req.params.orderId, req.tenantId);

    const updated = await prisma.order.update({
      where: { id: req.params.orderId },
      data:  { callStatus },
    });

    logger.info('orders: call status updated', {
      tenantId: req.tenantId, orderId: updated.id, callStatus,
    });

    return sendSuccess(res, { message: `Call status updated to ${callStatus}.`, data: updated });
  } catch (err) { next(err); }
};

// ── Delete Order ──────────────────────────────────────────────────────────────
/**
 * DELETE /api/v1/orders/:orderId
 */
const deleteOrder = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    await requireOrder(prisma, req.params.orderId, req.tenantId);
    await prisma.order.delete({ where: { id: req.params.orderId } });

    logger.info('orders: order deleted', {
      tenantId: req.tenantId, orderId: req.params.orderId, by: req.userId,
    });

    return sendSuccess(res, { message: 'Order deleted successfully.', data: null });
  } catch (err) { next(err); }
};

// ── Stats: Summary ────────────────────────────────────────────────────────────
/**
 * GET /api/v1/orders/stats/summary
 */
const getStatsSummary = async (req, res, next) => {
  try {
    const prisma    = getPrismaClient();
    const tenantId  = req.tenantId;

    const now       = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      todayOrders,
      monthOrders,
      allOrders,
      callStats,
    ] = await Promise.all([
      // Today
      prisma.order.findMany({
        where: { tenantId, createdAt: { gte: todayStart } },
        select: { status: true, totalPrice: true },
      }),
      // This month
      prisma.order.findMany({
        where: { tenantId, createdAt: { gte: monthStart } },
        select: { status: true, totalPrice: true },
      }),
      // All time
      prisma.order.findMany({
        where:  { tenantId },
        select: { status: true },
      }),
      // Call stats from calls table
      prisma.call.groupBy({
        by:    ['status'],
        where: { tenantId },
        _count: { _all: true },
      }),
    ]);

    const summarize = (orders) => ({
      total:     orders.length,
      pending:   orders.filter((o) => o.status === 'PENDING').length,
      confirmed: orders.filter((o) => o.status === 'CONFIRMED').length,
      cancelled: orders.filter((o) => o.status === 'CANCELLED').length,
      fake:      orders.filter((o) => o.status === 'FAKE').length,
      delivered: orders.filter((o) => o.status === 'DELIVERED').length,
    });

    const todaySummary  = summarize(todayOrders);
    const monthSummary  = summarize(monthOrders);
    const allSummary    = summarize(allOrders);

    // Revenue protected = sum of FAKE orders' totalPrice (stopped revenue loss)
    const revenueProtected = monthOrders
      .filter((o) => o.status === 'FAKE')
      .reduce((sum, o) => sum + Number(o.totalPrice), 0);

    const confirmationRate = allSummary.total > 0
      ? parseFloat(((allSummary.confirmed / allSummary.total) * 100).toFixed(1))
      : 0;

    const callMap = Object.fromEntries(callStats.map((c) => [c.status, c._count._all]));
    const totalCalls = callStats.reduce((s, c) => s + c._count._all, 0);

    return sendSuccess(res, {
      data: {
        today: {
          total:     todaySummary.total,
          confirmed: todaySummary.confirmed,
          cancelled: todaySummary.cancelled,
          fake:      todaySummary.fake,
          pending:   todaySummary.pending,
        },
        thisMonth: {
          total:             monthSummary.total,
          confirmed:         monthSummary.confirmed,
          fake:              monthSummary.fake,
          revenueProtected:  parseFloat(revenueProtected.toFixed(2)),
        },
        allTime: {
          total:            allSummary.total,
          fakeDetected:     allSummary.fake,
          confirmationRate, // percentage
        },
        callStats: {
          totalCalls,
          answered:   (callMap['completed'] || 0),
          noResponse: (callMap['no-answer'] || callMap['no_answer'] || 0),
          failed:     (callMap['failed'] || 0),
        },
      },
    });
  } catch (err) { next(err); }
};

// ── Stats: Chart ──────────────────────────────────────────────────────────────
/**
 * GET /api/v1/orders/stats/chart?period=7d|30d|90d
 * Returns daily breakdown for fl_chart.
 */
const getStatsChart = async (req, res, next) => {
  try {
    const prisma   = getPrismaClient();
    const tenantId = req.tenantId;

    const periodMap = { '7d': 7, '30d': 30, '90d': 90 };
    const days      = periodMap[req.query.period] || 7;

    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    const orders = await prisma.order.findMany({
      where:  { tenantId, createdAt: { gte: since } },
      select: { status: true, createdAt: true, totalPrice: true },
      orderBy: { createdAt: 'asc' },
    });

    // Group by date string
    const map = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(since);
      d.setDate(d.getDate() + i);
      const key = d.toISOString().slice(0, 10);
      map[key] = { date: key, total: 0, confirmed: 0, fake: 0, cancelled: 0, pending: 0, revenue: 0 };
    }

    for (const o of orders) {
      const key = o.createdAt.toISOString().slice(0, 10);
      if (!map[key]) continue;
      map[key].total++;
      if (o.status === 'CONFIRMED')  { map[key].confirmed++; map[key].revenue += Number(o.totalPrice); }
      if (o.status === 'FAKE')       map[key].fake++;
      if (o.status === 'CANCELLED')  map[key].cancelled++;
      if (o.status === 'PENDING')    map[key].pending++;
    }

    return sendSuccess(res, {
      data: Object.values(map),
    });
  } catch (err) { next(err); }
};

module.exports = {
  listOrders,
  getOrder,
  createOrder,
  updateOrder,
  updateOrderStatus,
  updateCallStatus,
  deleteOrder,
  getStatsSummary,
  getStatsChart,
};
