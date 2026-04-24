'use strict';

/**
 * Manual Verification Module — OrderGuard MVP
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 1 (NOW):   Manual Call Log + SMS (Twilio trial or copy-paste fallback)
 * Phase 2 (LATER): Auto IVR via Twilio Programmable Voice
 *
 * Twilio SMS pricing: ~$0.0075/SMS → $15 free credit = ~2,000 SMS
 * Sign up: https://www.twilio.com/try-twilio
 * Required env vars:
 *   TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx  (free trial gives $15)
 *   TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *   TWILIO_PHONE_NUMBER=+1xxxxxxxxxx  (Twilio trial number)
 *   TWILIO_ENABLED=true   (set false to use copy-paste fallback)
 */

const { getPrismaClient }  = require('../../config/database');
const { sendSuccess, sendCreated } = require('../../utils/response');
const { AppError }         = require('../../middlewares/error.middleware');
const { HTTP, MAX_CALL_ATTEMPTS } = require('../../config/constants');
const logger               = require('../../utils/logger');
const { orderEvents }      = require('../email/orderParser.service');

// ── Twilio client (lazy init) ─────────────────────────────────────────────────
let _twilioClient = null;
const getTwilioClient = () => {
  if (_twilioClient) return _twilioClient;
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;
  const twilio = require('twilio');
  _twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  return _twilioClient;
};

const TWILIO_ENABLED = process.env.TWILIO_ENABLED === 'true';

// ── Outcome → status maps ─────────────────────────────────────────────────────
const OUTCOME_ORDER_STATUS = {
  confirmed: 'CONFIRMED',
  cancelled: 'CANCELLED',
  fake:      'FAKE',
  no_answer: null, // don't change order status — only call status
};

const OUTCOME_CALL_STATUS = {
  confirmed: 'CONFIRMED',
  cancelled: 'REJECTED',
  fake:      'REJECTED',
  no_answer: 'NO_RESPONSE',
};

// ── SMS template builder ──────────────────────────────────────────────────────
const buildSmsText = (order, businessName) => {
  const price = Number(order.totalPrice).toLocaleString('bn-BD');
  return (
    `আপনার অর্ডার: ${order.productName}, মোট: ৳${price} টাকা।\n` +
    `কনফার্ম করতে reply করুন: YES\n` +
    `বাতিল করতে reply করুন: NO\n` +
    `- ${businessName || 'OrderGuard'}`
  );
};

// ── Helper: get order (tenant-scoped) ─────────────────────────────────────────
const getOrderOrFail = async (prisma, orderId, tenantId) => {
  const order = await prisma.order.findFirst({
    where: { id: orderId, tenantId },
    include: {
      calls:  { select: { id: true } },
      tenant: { select: { businessName: true } },
    },
  });
  if (!order) throw new AppError('Order not found.', HTTP.NOT_FOUND);
  return order;
};

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/calls/manual-log
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Seller made the call themselves. Log the result.
 * Body: { orderId, outcome: 'confirmed'|'cancelled'|'no_answer'|'fake', notes? }
 */
const manualLog = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const { orderId, outcome, notes } = req.body;
    const tenantId = req.tenantId;

    const order = await getOrderOrFail(prisma, orderId, tenantId);

    if (order.calls.length >= MAX_CALL_ATTEMPTS) {
      throw new AppError(`Maximum call attempts (${MAX_CALL_ATTEMPTS}) reached.`, HTTP.BAD_REQUEST);
    }

    const attemptNo   = order.calls.length + 1;
    const callStatus  = OUTCOME_CALL_STATUS[outcome];
    const orderStatus = OUTCOME_ORDER_STATUS[outcome];

    const [call] = await prisma.$transaction([
      prisma.call.create({
        data: {
          tenantId,
          orderId,
          attemptNo,
          type:     'MANUAL_LOG',
          isManual: true,
          status:   outcome === 'no_answer' ? 'no-answer' : 'completed',
          keypress: outcome === 'confirmed' ? '1' : outcome === 'cancelled' ? '2' : null,
          notes:    notes || null,
        },
      }),
      prisma.order.update({
        where: { id: orderId },
        data: {
          callStatus,
          ...(orderStatus && { status: orderStatus }),
          notes: order.notes
            ? `${order.notes}\n[${new Date().toISOString()}] Manual call: ${outcome}`
            : `[${new Date().toISOString()}] Manual call: ${outcome}`,
        },
      }),
    ]);

    // Emit event for downstream (FCM etc.)
    orderEvents.emit('order.call_logged', { orderId, outcome, tenantId });

    logger.info('calls: manual log', { tenantId, orderId, outcome, attemptNo });

    // Return updated order
    const updatedOrder = await prisma.order.findUnique({ where: { id: orderId } });
    return sendCreated(res, {
      message: `Call logged: ${outcome}. Order updated.`,
      data:    { call, order: updatedOrder },
    });
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/calls/send-sms
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Send verification SMS to customer.
 * Uses Twilio if TWILIO_ENABLED=true, otherwise returns text for manual send.
 * Body: { orderId }
 */
const sendSms = async (req, res, next) => {
  try {
    const prisma   = getPrismaClient();
    const { orderId } = req.body;
    const tenantId = req.tenantId;

    const order = await getOrderOrFail(prisma, orderId, tenantId);

    const smsText = buildSmsText(order, order.tenant?.businessName);

    if (!TWILIO_ENABLED) {
      // ── Fallback: return text for seller to send manually ─────────────────
      logger.info('calls: SMS fallback (TWILIO_ENABLED=false)', { tenantId, orderId });
      return sendSuccess(res, {
        message:       'SMS queued (manual send required — Twilio not configured)',
        data: {
          mode:          'manual',
          manualSmsText: smsText,
          customerPhone: order.customerPhone,
          orderId,
        },
      });
    }

    // ── Twilio SMS ─────────────────────────────────────────────────────────
    const client = getTwilioClient();
    if (!client) {
      throw new AppError(
        'Twilio not configured. Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.',
        HTTP.INTERNAL_SERVER_ERROR
      );
    }

    const attemptNo = order.calls.length + 1;
    let twilioMessage;

    try {
      twilioMessage = await client.messages.create({
        body: smsText,
        from: process.env.TWILIO_PHONE_NUMBER,
        to:   `+88${order.customerPhone}`,  // BD: +880XXXXXXXXXX
      });
    } catch (twilioErr) {
      logger.error('calls: Twilio SMS failed', { tenantId, orderId, error: twilioErr.message });
      throw new AppError(`SMS failed: ${twilioErr.message}`, HTTP.BAD_REQUEST);
    }

    // Create call record
    const call = await prisma.call.create({
      data: {
        tenantId,
        orderId,
        attemptNo,
        type:     'SMS',
        isManual: false,
        callSid:  twilioMessage.sid,
        status:   'sms_sent',
        notes:    `SMS sent to ${order.customerPhone}`,
      },
    });

    await prisma.order.update({
      where: { id: orderId },
      data:  { callStatus: 'NOT_CALLED' }, // wait for reply
    });

    logger.info('calls: SMS sent via Twilio', { tenantId, orderId, sid: twilioMessage.sid });

    return sendCreated(res, {
      message: `✅ SMS sent to ${order.customerPhone}`,
      data:    { call, sid: twilioMessage.sid, mode: 'twilio' },
    });
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/calls/initiate-ivr  [STUB — Phase 2]
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Phase 2: Twilio Programmable Voice — IVR (Interactive Voice Response)
 *
 * PLAN:
 * 1. Use Twilio.calls.create({ twiml: ... }) to dial customer
 * 2. TwiML script: "আপনার অর্ডার [product] কনফার্ম করতে 1 চাপুন, বাতিল করতে 2 চাপুন"
 * 3. Twilio posts keypress to /calls/twilio-webhook
 * 4. Webhook updates Order status + sends FCM to seller
 * Cost: ~$0.013/min (inbound) + $0.014/min (outbound) on trial
 */
const initiateIvr = async (req, res, next) => {
  try {
    return sendSuccess(res, {
      message: 'IVR coming in Phase 2. Please use manual-log or send-sms for now.',
      data: {
        phase:   2,
        eta:     'Q3 2025',
        docs:    'https://www.twilio.com/docs/voice/twiml',
        preview: {
          script: 'আপনার অর্ডার [product] কনফার্ম করতে 1 চাপুন, বাতিল করতে 2 চাপুন।',
          webhook: '/api/v1/calls/twilio-webhook',
        },
      },
    });
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/calls/order/:orderId
// ═══════════════════════════════════════════════════════════════════════════════
const getCallsByOrder = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const order = await prisma.order.findFirst({
      where: { id: req.params.orderId, tenantId: req.tenantId },
    });
    if (!order) throw new AppError('Order not found.', HTTP.NOT_FOUND);

    const calls = await prisma.call.findMany({
      where:   { orderId: req.params.orderId, tenantId: req.tenantId },
      orderBy: { attemptNo: 'asc' },
    });

    return sendSuccess(res, { data: calls });
  } catch (err) { next(err); }
};

// ═══════════════════════════════════════════════════════════════════════════════
// POST /api/v1/calls/sms-webhook  [PUBLIC — no auth, Twilio calls this]
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Twilio posts here when customer replies YES/NO to the SMS.
 * Validates Twilio signature, then updates order + sends FCM.
 *
 * Twilio webhook body (form-encoded):
 *   From=+8801712345678&Body=YES&MessageSid=SMxxxx&...
 */
const smsWebhook = async (req, res, next) => {
  try {
    // ── Signature verification (skip in dev) ──────────────────────────────
    if (TWILIO_ENABLED && process.env.NODE_ENV === 'production') {
      const twilio = require('twilio');
      const signature = req.headers['x-twilio-signature'] || '';
      const url       = `${process.env.BASE_URL}/api/v1/calls/sms-webhook`;
      const valid     = twilio.validateRequest(
        process.env.TWILIO_AUTH_TOKEN,
        signature,
        url,
        req.body
      );
      if (!valid) {
        logger.warn('calls: invalid Twilio webhook signature');
        return res.status(403).send('Forbidden');
      }
    }

    const prisma = getPrismaClient();
    const from   = req.body.From  || '';  // +8801712345678
    const body   = (req.body.Body || '').trim().toUpperCase();

    if (!from || !body) return res.status(200).send('OK');

    // Normalize phone: +8801712345678 → 01712345678
    const phone = from.replace(/^\+?880/, '0').replace(/\s/g, '');

    // Find the most recent unconfirmed order for this phone
    const order = await prisma.order.findFirst({
      where: {
        customerPhone: phone,
        status:        { in: ['PENDING'] },
      },
      orderBy: { createdAt: 'desc' },
      include: { tenant: { select: { businessName: true } } },
    });

    if (!order) {
      logger.info('calls: sms-webhook — no pending order for phone', { phone });
      return res.status(200).send('OK');
    }

    const reply   = body.startsWith('YES') ? 'YES' : body.startsWith('NO') ? 'NO' : null;
    if (!reply) {
      logger.info('calls: sms-webhook — unrecognized reply', { phone, body });
      return res.status(200).send('OK');
    }

    const newStatus = reply === 'YES' ? 'CONFIRMED' : 'CANCELLED';
    const callStatus = reply === 'YES' ? 'CONFIRMED' : 'REJECTED';

    await prisma.$transaction([
      prisma.order.update({
        where: { id: order.id },
        data:  { status: newStatus, callStatus },
      }),
      prisma.call.create({
        data: {
          tenantId:  order.tenantId,
          orderId:   order.id,
          type:      'SMS',
          isManual:  false,
          status:    'sms_replied',
          keypress:  reply === 'YES' ? '1' : '2',
          notes:     `Customer replied: ${reply}`,
          attemptNo: 1,
        },
      }),
    ]);

    // Emit for FCM (Flutter push notification)
    const emoji = reply === 'YES' ? '✅' : '❌';
    orderEvents.emit('order.sms_reply', {
      tenantId:  order.tenantId,
      orderId:   order.id,
      reply,
      newStatus,
      pushTitle:   `${emoji} Customer SMS Reply`,
      pushBody:    `${emoji} অর্ডার #${order.externalId || order.id.slice(-6)} কাস্টমার ${reply === 'YES' ? 'কনফার্ম' : 'বাতিল'} করেছে`,
    });

    logger.info('calls: sms-webhook processed', {
      tenantId: order.tenantId, orderId: order.id, reply, newStatus,
    });

    // Twilio expects TwiML or plain 200 response
    res.set('Content-Type', 'text/xml');
    return res.status(200).send('<Response></Response>');
  } catch (err) {
    logger.error('calls: sms-webhook error', { error: err.message });
    res.status(200).send('<Response></Response>'); // always 200 to Twilio
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// GET /api/v1/calls   (list all)
// ═══════════════════════════════════════════════════════════════════════════════
const listCalls = async (req, res, next) => {
  try {
    const prisma = getPrismaClient();
    const page   = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit  = Math.min(50, parseInt(req.query.limit, 10) || 20);
    const skip   = (page - 1) * limit;

    const where = { tenantId: req.tenantId };
    if (req.query.orderId) where.orderId = req.query.orderId;
    if (req.query.type)    where.type    = req.query.type;
    if (req.query.status)  where.status  = req.query.status;

    const [calls, total] = await Promise.all([
      prisma.call.findMany({
        where, skip, take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          order: { select: { customerName: true, customerPhone: true, productName: true } },
        },
      }),
      prisma.call.count({ where }),
    ]);

    return sendSuccess(res, {
      data: { calls, total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
};

module.exports = {
  manualLog, sendSms, initiateIvr,
  getCallsByOrder, smsWebhook, listCalls,
};
