'use strict';

const EventEmitter = require('events');
const { getPrismaClient } = require('../../config/database');
const logger = require('../../utils/logger');

// ── Order events (future webhooks/FCM) ────────────────────────────────────────
const orderEvents = new EventEmitter();

// ── Subject keyword filter ────────────────────────────────────────────────────
const ORDER_SUBJECT_KEYWORDS = [
  'অর্ডার', 'order', 'purchase', 'new order', 'নতুন অর্ডার',
  'order confirmation', 'অর্ডার কনফার্মেশন', 'booking', 'invoice',
];

const isOrderEmail = (subject = '') => {
  const lower = subject.toLowerCase();
  return ORDER_SUBJECT_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
};

// ── Regex patterns ────────────────────────────────────────────────────────────
const patterns = {
  orderId: [
    /order[:\s#]*([A-Z0-9\-]+)/i,
    /অর্ডার[:\s#]*([A-Z0-9\-]+)/i,
    /#(\d{4,10})/,
  ],
  phone: [
    /(?:phone|mobile|contact|ফোন|মোবাইল)[:\s]*(\+?880|0)?([0-9]{10,11})/i,
  ],
  customerName: [
    /(?:customer\s+name|customer|নাম)\s*:\s*([^\n,]{2,100})/i,
    /(?:billing name|shipping name)\s*:\s*([^\n,]{2,100})/i,
    /^name\s*:\s*([^\n,]{2,100})/im,
    /Dear\s+([^,\n]+)/i,
  ],
  address: [
    /(?:address|ঠিকানা|shipping address)[:\s]*([^\n]+(?:\n[^\n]+)?)/i,
    /(?:delivery address)[:\s]*([^\n]+)/i,
  ],
  product: [
    /(?:product|item|পণ্য)[:\s]*([^\n,]+)/i,
    /(?:order details?|items? ordered)[:\s]*([^\n]+)/i,
  ],
  price: [
    /(?:total|amount|মোট)[:\s]*(?:BDT|৳|Tk\.?|টাকা)?\s*([\d,]+\.?\d*)/i,
    /(?:৳|BDT|Tk)\s*([\d,]+)/i,
    /([\d,]+)\s*(?:টাকা|taka)/i,
  ],
  quantity: [
    /(?:qty|quantity|পরিমাণ)[:\s]*(\d+)/i,
    /(\d+)\s*(?:pcs|pieces|টি|টা)/i,
  ],
};

// ── Confidence weights ────────────────────────────────────────────────────────
const WEIGHTS = {
  phone: 0.30, customerName: 0.20, productName: 0.20,
  price: 0.15, address: 0.10, orderId: 0.05,
};

// ── Phone normalizer ──────────────────────────────────────────────────────────
const normalizePhone = (raw) => {
  if (!raw) return null;
  let n = String(raw).replace(/[\s\-().]/g, '');
  if (n.startsWith('+880')) n = '0' + n.slice(4);
  else if (n.startsWith('880')) n = '0' + n.slice(3);
  if (n.length === 10 && n.startsWith('1')) n = '0' + n;
  return /^01[3-9]\d{8}$/.test(n) ? n : null;
};

// ── Strategy: Regex ───────────────────────────────────────────────────────────
class RegexStrategy {
  parse(rawEmail) {
    const { subject = '', bodyText = '' } = rawEmail;
    const text = `${subject}\n${bodyText}`;
    const raw = {};
    let score = 0;

    const result = {
      externalId: null, customerName: null, customerPhone: null,
      address: null, productName: null, quantity: null, totalPrice: null,
      currency: 'BDT', confidence: 0, parseMethod: 'regex', rawFields: {},
    };

    // Order ID
    for (const p of patterns.orderId) {
      const m = text.match(p);
      if (m) { raw.orderId = m[1]; result.externalId = m[1].trim(); score += WEIGHTS.orderId; break; }
    }

    // Phone — labeled first, then bare
    const lp = text.match(patterns.phone[0]);
    let phone = lp ? normalizePhone((lp[1] || '') + lp[2]) : null;
    if (!phone) {
      const bare = text.match(/01[3-9]\d{8}/g);
      if (bare) phone = normalizePhone(bare[0]);
    }
    if (phone) { raw.phone = phone; result.customerPhone = phone; score += WEIGHTS.phone; }

    // Customer name
    for (const p of patterns.customerName) {
      const m = text.match(p);
      if (m && m[1].trim().length >= 2) {
        raw.customerName = m[1].trim().slice(0, 100);
        result.customerName = raw.customerName;
        score += WEIGHTS.customerName;
        break;
      }
    }

    // Address
    for (const p of patterns.address) {
      const m = text.match(p);
      if (m && m[1].trim().length >= 5) {
        raw.address = m[1].trim().slice(0, 300);
        result.address = raw.address;
        score += WEIGHTS.address;
        break;
      }
    }

    // Product
    for (const p of patterns.product) {
      const m = text.match(p);
      if (m && m[1].trim().length >= 2) {
        raw.product = m[1].trim().slice(0, 200);
        result.productName = raw.product;
        score += WEIGHTS.productName;
        break;
      }
    }

    // Price
    for (const p of patterns.price) {
      const m = text.match(p);
      if (m) {
        const price = parseFloat(m[1].replace(/,/g, ''));
        if (!isNaN(price) && price > 0) {
          raw.price = m[1];
          result.totalPrice = price;
          score += WEIGHTS.price;
          break;
        }
      }
    }

    // Quantity
    for (const p of patterns.quantity) {
      const m = text.match(p);
      if (m) {
        const qty = parseInt(m[1], 10);
        if (qty > 0 && qty < 10000) { raw.quantity = qty; result.quantity = qty; break; }
      }
    }

    result.confidence = Math.min(1.0, parseFloat(score.toFixed(2)));
    result.rawFields = raw;
    return result;
  }
}

// ── Strategy: AI stub (Phase 2) ───────────────────────────────────────────────
class AIStrategy {
  async parse(_rawEmail) {
    // TODO Phase 2: Call Claude/GPT API here — same output contract as RegexStrategy
    throw new Error('AI parsing not yet enabled. Set PARSER_STRATEGY=regex in env.');
  }
}

// ── OrderParserService — Strategy Pattern ─────────────────────────────────────
class OrderParserService {
  constructor(strategy = 'regex') {
    this._strategy = strategy === 'ai' ? new AIStrategy() : new RegexStrategy();
    this._strategyName = strategy;
  }

  /**
   * Parse a raw email into standardized OrderData.
   * @param {{ subject, bodyText, bodyHtml, fromAddress }} rawEmail
   * @returns {Promise<OrderData>}
   */
  async parse(rawEmail) {
    const result = await Promise.resolve(this._strategy.parse(rawEmail));
    logger.debug('orderParser: parsed', {
      subject: rawEmail.subject,
      confidence: result.confidence,
      method: result.parseMethod,
    });
    return result;
  }

  /**
   * Create an Order in DB from parsed result.
   * confidence >= 0.5 && valid phone → normal PENDING order
   * confidence <  0.5               → PENDING with manual-review note
   * Emits 'order.created' on success.
   *
   * @param {OrderData} parsed
   * @param {{ prisma, tenantId, rawEmailId?, subject? }} ctx
   * @returns {Promise<Order|null>}
   */
  async createOrderFromParsed(parsed, { prisma, tenantId, rawEmailId = null, subject = '' }) {
    if (!parsed) return null;

    const highConfidence = parsed.confidence >= 0.5 && Boolean(parsed.customerPhone);
    const notes = highConfidence
      ? `Auto-created via ${parsed.parseMethod} parser. Confidence: ${(parsed.confidence * 100).toFixed(0)}%`
      : `⚠️ Low confidence (${(parsed.confidence * 100).toFixed(0)}%). Manual review required.`;

    try {
      const order = await prisma.order.create({
        data: {
          tenantId,
          externalId:    parsed.externalId  || null,
          customerName:  parsed.customerName || 'Unknown Customer',
          customerPhone: parsed.customerPhone || '01000000000',
          address:       parsed.address      || null,
          productName:   parsed.productName  || subject || 'Unknown Product',
          quantity:      parsed.quantity     || 1,
          totalPrice:    parsed.totalPrice   || 0,
          rawEmailId,
          notes,
          status:     'PENDING',
          callStatus: 'NOT_CALLED',
        },
      });

      orderEvents.emit('order.created', { order, parsed, tenantId });

      logger.info('orderParser: order created', {
        tenantId, orderId: order.id,
        confidence: parsed.confidence, highConfidence,
      });

      return order;
    } catch (err) {
      logger.error('orderParser: failed to create order', { tenantId, error: err.message });
      return null;
    }
  }
}

// ── Singleton (strategy from env) ─────────────────────────────────────────────
const orderParser = new OrderParserService(process.env.PARSER_STRATEGY || 'regex');

// ── Backward-compat shim for email.controller.js ──────────────────────────────
const extractOrderFromEmail = ({ subject, body, from }) => {
  const result = new RegexStrategy().parse({ subject: subject || '', bodyText: body || '', fromAddress: from || '' });
  return result.confidence >= 0.5
    ? { ...result, _confidence: Math.round(result.confidence * 100) }
    : null;
};

module.exports = {
  OrderParserService,
  orderParser,
  orderEvents,
  isOrderEmail,
  ORDER_SUBJECT_KEYWORDS,
  normalizePhone,
  extractOrderFromEmail, // backward compat
};
