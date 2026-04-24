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

// ── Strategy: AI — Gemini 2.5 Flash via OpenAI-compatible API ────────────────
class AIStrategy {
  constructor() {
    // ModelRouter expects 'sk_...' format — strip 'api-' prefix if present
    const rawKey = process.env.AI_API_KEY || '';
    this._apiKey  = rawKey.replace(/^api-/, '');
    this._baseUrl = (process.env.AI_BASE_URL || 'https://api.modelrouter.app/v1').replace(/\/$/, '');
    this._model   = process.env.AI_MODEL    || 'google/gemini-2.5-flash';
    this._regex   = new RegexStrategy(); // fallback
  }

  _buildPrompt(rawEmail) {
    const { subject = '', bodyText = '', fromAddress = '' } = rawEmail;
    return `You are an order data extraction assistant for a Bangladeshi e-commerce system.

Extract order information from the email below and return a JSON object with EXACTLY these fields:
{
  "externalId": string or null,       // order number / ID
  "customerName": string or null,
  "customerPhone": string or null,    // Bangladesh format: 01XXXXXXXXX (11 digits)
  "address": string or null,          // delivery address
  "productName": string or null,
  "quantity": number or null,
  "totalPrice": number or null        // numeric only, BDT
}

Rules:
- customerPhone MUST be in format 01XXXXXXXXX (11 digits). Remove +880 or 880 prefix.
- Return null for any field you cannot find.
- Return ONLY valid JSON, no markdown, no explanation.

EMAIL:
From: ${fromAddress}
Subject: ${subject}
Body:
${bodyText.slice(0, 3000)}`;
  }

  async parse(rawEmail) {
    if (!this._apiKey) {
      throw new Error('AI_API_KEY not set in environment. Set it in Render env vars.');
    }

    try {
      const response = await fetch(`${this._baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this._apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this._model,
          messages: [{ role: 'user', content: this._buildPrompt(rawEmail) }],
          response_format: { type: 'json_object' },
          temperature: 0.1,
          max_tokens: 512,
        }),
        signal: AbortSignal.timeout(15_000), // 15s timeout
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`AI API error ${response.status}: ${errText.slice(0, 200)}`);
      }

      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('AI returned empty response');

      const extracted = JSON.parse(content);

      // Normalize phone
      const phone = normalizePhone(extracted.customerPhone);

      // Calculate confidence (AI always gets 0.95 if phone found, else 0.80)
      const confidence = phone ? 0.95 : 0.80;

      return {
        externalId:    extracted.externalId    || null,
        customerName:  extracted.customerName  || null,
        customerPhone: phone,
        address:       extracted.address       || null,
        productName:   extracted.productName   || null,
        quantity:      Number(extracted.quantity)   || null,
        totalPrice:    Number(extracted.totalPrice) || null,
        currency:      'BDT',
        confidence,
        parseMethod:   'ai',
        rawFields:     extracted,
      };
    } catch (err) {
      logger.error('AIStrategy: failed, falling back to regex', { error: err.message });
      // Graceful fallback to regex so polling never breaks
      const fallback = this._regex.parse(rawEmail);
      fallback.parseMethod = 'regex-fallback';
      return fallback;
    }
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
