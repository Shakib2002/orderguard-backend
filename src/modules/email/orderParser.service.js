'use strict';

/**
 * Order Parser Service
 * Extracts structured order data from raw email text using regex patterns.
 * Supports both English and Bangla order notification formats.
 *
 * Extracted from email.controller.js to be shared with gmailFetcher.service.js
 */

// ── Subject keyword filter ────────────────────────────────────────────────────

const ORDER_SUBJECT_KEYWORDS = [
  'অর্ডার',
  'order',
  'purchase',
  'new order',
  'নতুন অর্ডার',
  'order confirmation',
  'অর্ডার কনফার্মেশন',
  'booking',
  'invoice',
];

/**
 * Check if an email subject matches any order-related keyword.
 * @param {string} subject
 * @returns {boolean}
 */
const isOrderEmail = (subject = '') => {
  const lower = subject.toLowerCase();
  return ORDER_SUBJECT_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
};

// ── Order field extractor ─────────────────────────────────────────────────────

/**
 * Extract structured order fields from email subject + body text.
 * Returns null if confidence score is below threshold (< 50).
 *
 * Scoring:
 *   phone    → +30
 *   name     → +20
 *   product  → +20
 *   price    → +20
 *   address  → +10
 *
 * @param {{ subject: string, body: string, from?: string }} email
 * @returns {object|null}
 */
const extractOrderFromEmail = ({ subject = '', body = '', from = '' }) => {
  const text = `${subject}\n${body}`;
  let confidence = 0;
  const result = {};

  // ── Phone ──────────────────────────────────────────────────────────────────
  const phoneMatch = text.match(
    /(?:phone|mobile|contact|মোবাইল|ফোন|নম্বর)[:\s]*(\+?880|0)?(1[3-9]\d{8})/i
  );
  if (phoneMatch) {
    result.customerPhone = `0${phoneMatch[2]}`;
    confidence += 30;
  } else {
    // Fallback: bare 11-digit BD number anywhere in body
    const barePhone = text.match(/\b0(1[3-9]\d{8})\b/);
    if (barePhone) {
      result.customerPhone = `0${barePhone[1]}`;
      confidence += 15;
    }
  }

  // ── Customer name ──────────────────────────────────────────────────────────
  const nameMatch = text.match(
    /(?:customer|name|নাম|গ্রাহক|buyer)[:\s]+([A-Za-z\u0980-\u09FF\s]{3,50})/i
  );
  if (nameMatch) {
    result.customerName = nameMatch[1].trim();
    confidence += 20;
  }

  // ── Product ────────────────────────────────────────────────────────────────
  const productMatch = text.match(
    /(?:product|item|পণ্য|product name|item name)[:\s]+([^\n]{3,100})/i
  );
  if (productMatch) {
    result.productName = productMatch[1].trim();
    confidence += 20;
  }

  // ── Price ──────────────────────────────────────────────────────────────────
  const priceMatch = text.match(
    /(?:total|amount|price|মূল্য|টাকা|cost)[:\s]*(?:BDT|৳|Tk\.?)?\s*([\d,]+(?:\.\d{1,2})?)/i
  );
  if (priceMatch) {
    result.totalPrice = parseFloat(priceMatch[1].replace(/,/g, ''));
    confidence += 20;
  }

  // ── Address ────────────────────────────────────────────────────────────────
  const addressMatch = text.match(
    /(?:address|ঠিকানা|delivery address|shipping)[:\s]+([^\n]{5,200})/i
  );
  if (addressMatch) {
    result.address = addressMatch[1].trim();
    confidence += 10;
  }

  // ── Quantity ───────────────────────────────────────────────────────────────
  const qtyMatch = text.match(/(?:quantity|qty|পরিমাণ)[:\s]*(\d+)/i);
  if (qtyMatch) result.quantity = parseInt(qtyMatch[1], 10);

  // ── External ID ────────────────────────────────────────────────────────────
  const idMatch = text.match(
    /(?:order\s*(?:id|no|number|#)|order ID)[:\s#]*([A-Z0-9-]{4,30})/i
  );
  if (idMatch) result.externalId = idMatch[1].trim();

  result._confidence = confidence;

  return confidence >= 50 ? result : null;
};

module.exports = { extractOrderFromEmail, isOrderEmail, ORDER_SUBJECT_KEYWORDS };
