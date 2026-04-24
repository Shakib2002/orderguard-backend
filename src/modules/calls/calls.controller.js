'use strict';

const { getPrismaClient } = require('../../config/database');
const { sendSuccess, sendCreated, buildPaginationMeta } = require('../../utils/response');
const { AppError } = require('../../middlewares/error.middleware');
const { HTTP, PAGINATION, MAX_CALL_ATTEMPTS } = require('../../config/constants');

// ── List Calls ────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/calls
 * All call logs for this tenant. Filterable by orderId, status.
 */
const listCalls = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const page = parseInt(req.query.page, 10) || PAGINATION.DEFAULT_PAGE;
    const limit = Math.min(parseInt(req.query.limit, 10) || PAGINATION.DEFAULT_LIMIT, PAGINATION.MAX_LIMIT);
    const skip = (page - 1) * limit;

    const where = { tenantId: req.tenantId };
    if (req.query.orderId) where.orderId = req.query.orderId;
    if (req.query.status) where.status = req.query.status;

    const [calls, total] = await Promise.all([
      prisma.call.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          order: {
            select: { customerName: true, customerPhone: true, productName: true },
          },
        },
      }),
      prisma.call.count({ where }),
    ]);

    return sendSuccess(res, {
      data: calls,
      meta: buildPaginationMeta(total, page, limit),
    });
  } catch (err) {
    next(err);
  }
};

// ── Get Calls for an Order ────────────────────────────────────────────────────

/**
 * GET /api/v1/calls/order/:orderId
 */
const getCallsByOrder = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();

    // Verify order belongs to tenant
    const order = await prisma.order.findFirst({
      where: { id: req.params.orderId, tenantId: req.tenantId },
    });
    if (!order) throw new AppError('Order not found.', HTTP.NOT_FOUND);

    const calls = await prisma.call.findMany({
      where: { orderId: req.params.orderId, tenantId: req.tenantId },
      orderBy: { attemptNo: 'asc' },
    });

    return sendSuccess(res, { data: calls });
  } catch (err) {
    next(err);
  }
};

// ── Log a Manual Call ─────────────────────────────────────────────────────────

/**
 * POST /api/v1/calls
 * Manually log a call attempt (no Twilio integration).
 */
const logCall = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const { orderId, status, keypress, duration, notes } = req.body;

    // Validate the order exists under this tenant
    const order = await prisma.order.findFirst({
      where: { id: orderId, tenantId: req.tenantId },
      include: { calls: { select: { id: true } } },
    });
    if (!order) throw new AppError('Order not found.', HTTP.NOT_FOUND);

    if (order.calls.length >= MAX_CALL_ATTEMPTS) {
      throw new AppError(
        `Maximum call attempts (${MAX_CALL_ATTEMPTS}) reached for this order.`,
        HTTP.BAD_REQUEST
      );
    }

    const attemptNo = order.calls.length + 1;

    // Create call log and update order call status in a transaction
    const [call] = await prisma.$transaction([
      prisma.call.create({
        data: {
          tenantId: req.tenantId,
          orderId,
          attemptNo,
          isManual: true,
          status,
          keypress,
          duration,
        },
      }),
      prisma.order.update({
        where: { id: orderId },
        data: {
          callStatus: mapKeypressToCallStatus(keypress, status),
        },
      }),
    ]);

    return sendCreated(res, {
      message: 'Call logged successfully.',
      data: call,
    });
  } catch (err) {
    next(err);
  }
};

// ── Update Call (Twilio webhook update) ──────────────────────────────────────

/**
 * PATCH /api/v1/calls/:id
 * Used to update call status/keypress after Twilio webhook arrives.
 */
const updateCall = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const { status, keypress, duration, callSid } = req.body;

    const existing = await prisma.call.findFirst({
      where: { id: req.params.id, tenantId: req.tenantId },
    });
    if (!existing) throw new AppError('Call record not found.', HTTP.NOT_FOUND);

    const [updated] = await prisma.$transaction([
      prisma.call.update({
        where: { id: req.params.id },
        data: {
          ...(status !== undefined && { status }),
          ...(keypress !== undefined && { keypress }),
          ...(duration !== undefined && { duration }),
          ...(callSid !== undefined && { callSid }),
        },
      }),
      prisma.order.update({
        where: { id: existing.orderId },
        data: {
          callStatus: mapKeypressToCallStatus(
            keypress ?? existing.keypress,
            status ?? existing.status
          ),
        },
      }),
    ]);

    return sendSuccess(res, { message: 'Call updated.', data: updated });
  } catch (err) {
    next(err);
  }
};

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Map a keypress value + call status to an OrderCallStatus enum value.
 * 1 = confirm, 2 = cancel, null = no response
 */
const mapKeypressToCallStatus = (keypress, callStatus) => {
  if (keypress === '1') return 'CONFIRMED';
  if (keypress === '2') return 'REJECTED';
  if (callStatus === 'completed') return 'NO_RESPONSE';
  if (callStatus === 'failed' || callStatus === 'no-answer') return 'NO_RESPONSE';
  return 'CALLING';
};

module.exports = { listCalls, getCallsByOrder, logCall, updateCall };
