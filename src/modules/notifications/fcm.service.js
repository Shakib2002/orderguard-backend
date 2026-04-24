'use strict';

/**
 * FCM Notification Service — OrderGuard
 * ─────────────────────────────────────────────────────────────────────────────
 * Uses Firebase Admin SDK (FREE tier — no cost).
 *
 * Setup:
 * 1. Go to Firebase Console → Project Settings → Service Accounts
 * 2. Click "Generate new private key" → download JSON
 * 3. Stringify it: JSON.stringify(require('./service-account.json'))
 * 4. Add to Render env: FIREBASE_SERVICE_ACCOUNT_JSON=<stringified JSON>
 *
 * Flutter setup:
 * - Add google-services.json to Flutter project
 * - Initialize FirebaseMessaging in Flutter main()
 * - Call POST /api/v1/settings/fcm-token with device token
 */

const cron   = require('node-cron');
const logger = require('../../utils/logger');
const { getPrismaClient } = require('../../config/database');

// ── Notification types ────────────────────────────────────────────────────────
const NOTIFICATION_TYPES = {
  NEW_ORDER:       'new_order',
  ORDER_CONFIRMED: 'order_confirmed',
  ORDER_FAKE:      'order_fake',
  CALL_FAILED:     'call_failed',
  SMS_REPLY:       'sms_reply',
  EMAIL_CONNECTED: 'email_connected',
  EMAIL_ERROR:     'email_error',
  DAILY_SUMMARY:   'daily_summary',
};

// ── Notification templates (Bangla) ───────────────────────────────────────────
const TEMPLATES = {
  new_order: {
    title: '📦 নতুন অর্ডার!',
    body:  '{customerName} — {productName} — ৳{price}',
  },
  order_confirmed: {
    title: '✅ অর্ডার কনফার্ম',
    body:  'অর্ডার #{orderId} — {customerName} কনফার্ম করেছে',
  },
  order_fake: {
    title: '❌ ফেক অর্ডার!',
    body:  'অর্ডার #{orderId} — ফেক হিসেবে চিহ্নিত হয়েছে',
  },
  call_failed: {
    title: '⚠️ কল হয়নি',
    body:  'অর্ডার #{orderId} — {customerName} কল রিসিভ করেনি',
  },
  sms_reply: {
    title: '💬 SMS Reply',
    body:  'অর্ডার #{orderId} — কাস্টমার {reply} বলেছে',
  },
  email_connected: {
    title: '✅ Gmail সংযুক্ত',
    body:  'Gmail polling শুরু হয়েছে। নতুন অর্ডার auto-detect হবে।',
  },
  email_error: {
    title: '⚠️ Gmail সংযোগ বিচ্ছিন্ন',
    body:  'Gmail পুনরায় সংযুক্ত করুন Settings থেকে',
  },
  daily_summary: {
    title: '📊 আজকের সারসংক্ষেপ',
    body:  'মোট {total} অর্ডার | {confirmed} কনফার্ম | {fake} ফেক',
  },
};

// ── Template interpolator ─────────────────────────────────────────────────────
const interpolate = (template, data = {}) => {
  return template.replace(/\{(\w+)\}/g, (_, key) => data[key] ?? '');
};

// ── Firebase Admin lazy init ──────────────────────────────────────────────────
let _firebaseApp = null;

const getFirebaseApp = () => {
  if (_firebaseApp) return _firebaseApp;

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;

  try {
    const admin = require('firebase-admin');
    if (admin.apps.length > 0) {
      _firebaseApp = admin.apps[0];
      return _firebaseApp;
    }
    const serviceAccount = JSON.parse(raw);
    _firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    logger.info('fcm: Firebase Admin initialized');
    return _firebaseApp;
  } catch (err) {
    logger.error('fcm: Firebase init failed', { error: err.message });
    return null;
  }
};

// ── FcmService class ──────────────────────────────────────────────────────────
class FcmService {

  /**
   * Build FCM message object from type + data.
   */
  _buildMessage(token, type, data = {}) {
    const template = TEMPLATES[type];
    if (!template) throw new Error(`Unknown notification type: ${type}`);

    const title = interpolate(template.title, data);
    const body  = interpolate(template.body,  data);

    // Stringify all data values (FCM requires string values)
    const payload = {};
    for (const [k, v] of Object.entries({ type, ...data })) {
      if (v !== null && v !== undefined) payload[k] = String(v);
    }

    return {
      token,
      notification: { title, body },
      data: payload,
      android: {
        priority: 'high',
        notification: { channelId: 'orderguard_orders', sound: 'default' },
      },
      apns: {
        payload: { aps: { sound: 'default', badge: 1 } },
      },
    };
  }

  /**
   * Send notification to a single user by userId.
   * Looks up fcmToken from DB. Clears invalid tokens automatically.
   *
   * @param {string} userId
   * @param {string} type  - NOTIFICATION_TYPES value
   * @param {object} data  - template interpolation data
   * @returns {Promise<boolean>} true if sent, false otherwise
   */
  async sendToUser(userId, type, data = {}) {
    const app = getFirebaseApp();
    if (!app) {
      logger.debug('fcm: Firebase not configured — skipping notification', { userId, type });
      return false;
    }

    const prisma = getPrismaClient();
    const user   = await prisma.user.findUnique({
      where:  { id: userId },
      select: { fcmToken: true, fullName: true },
    });

    if (!user?.fcmToken) {
      logger.debug('fcm: no FCM token for user', { userId });
      return false;
    }

    try {
      const admin   = require('firebase-admin');
      const message = this._buildMessage(user.fcmToken, type, data);
      const result  = await admin.messaging().send(message);

      logger.info('fcm: notification sent', { userId, type, messageId: result });
      return true;
    } catch (err) {
      // Token invalid or unregistered → clear it
      if (
        err.code === 'messaging/registration-token-not-registered' ||
        err.code === 'messaging/invalid-registration-token'
      ) {
        await prisma.user.update({
          where: { id: userId },
          data:  { fcmToken: null },
        });
        logger.warn('fcm: cleared invalid token', { userId, error: err.code });
      } else {
        logger.error('fcm: send failed', { userId, type, error: err.message });
      }
      return false;
    }
  }

  /**
   * Send notification to ALL users of a tenant.
   * Useful for multi-user tenants (owner + staff).
   *
   * @param {string} tenantId
   * @param {string} type
   * @param {object} data
   * @returns {Promise<{ sent: number, failed: number }>}
   */
  async sendToTenant(tenantId, type, data = {}) {
    const app = getFirebaseApp();
    if (!app) {
      logger.debug('fcm: Firebase not configured — skipping tenant notification', { tenantId, type });
      return { sent: 0, failed: 0 };
    }

    const prisma = getPrismaClient();
    const users  = await prisma.user.findMany({
      where:  { tenantId, fcmToken: { not: null } },
      select: { id: true, fcmToken: true },
    });

    if (users.length === 0) {
      logger.debug('fcm: no users with FCM tokens', { tenantId });
      return { sent: 0, failed: 0 };
    }

    const admin   = require('firebase-admin');
    const messages = users.map((u) => {
      try {
        return this._buildMessage(u.fcmToken, type, { ...data, tenantId });
      } catch (_) { return null; }
    }).filter(Boolean);

    if (messages.length === 0) return { sent: 0, failed: 0 };

    try {
      const response = await admin.messaging().sendEach(messages);
      let sent = 0, failed = 0;

      // Clear invalid tokens
      for (let i = 0; i < response.responses.length; i++) {
        const r = response.responses[i];
        if (r.success) {
          sent++;
        } else {
          failed++;
          const errCode = r.error?.code;
          if (
            errCode === 'messaging/registration-token-not-registered' ||
            errCode === 'messaging/invalid-registration-token'
          ) {
            await prisma.user.update({
              where: { id: users[i].id },
              data:  { fcmToken: null },
            });
          }
        }
      }

      logger.info('fcm: tenant notification sent', { tenantId, type, sent, failed });
      return { sent, failed };
    } catch (err) {
      logger.error('fcm: sendToTenant failed', { tenantId, type, error: err.message });
      return { sent: 0, failed: 0 };
    }
  }

  /**
   * Send daily summary to all active tenants.
   * Scheduled: every day at 9:00 PM Bangladesh time (15:00 UTC).
   */
  async sendDailySummary() {
    const app = getFirebaseApp();
    if (!app) return;

    const prisma   = getPrismaClient();
    const today    = new Date();
    const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    const tenants = await prisma.tenant.findMany({
      where:  { isActive: true },
      select: { id: true },
    });

    for (const { id: tenantId } of tenants) {
      const [total, confirmed, fake] = await Promise.all([
        prisma.order.count({ where: { tenantId, createdAt: { gte: dayStart } } }),
        prisma.order.count({ where: { tenantId, status: 'CONFIRMED', createdAt: { gte: dayStart } } }),
        prisma.order.count({ where: { tenantId, status: 'FAKE',      createdAt: { gte: dayStart } } }),
      ]);

      if (total === 0) continue; // skip tenants with no activity today

      await this.sendToTenant(tenantId, NOTIFICATION_TYPES.DAILY_SUMMARY, {
        total:     String(total),
        confirmed: String(confirmed),
        fake:      String(fake),
      });
    }

    logger.info('fcm: daily summary sent to all active tenants');
  }

  /**
   * Start the daily summary cron job.
   * 9:00 PM Bangladesh (UTC+6) = 15:00 UTC
   * Cron: "0 15 * * *"
   */
  startDailySummaryCron() {
    const app = getFirebaseApp();
    if (!app) {
      logger.debug('fcm: daily summary cron skipped (Firebase not configured)');
      return;
    }

    cron.schedule('0 15 * * *', () => {
      logger.info('fcm: running daily summary cron');
      this.sendDailySummary().catch((err) =>
        logger.error('fcm: daily summary cron error', { error: err.message })
      );
    });

    logger.info('fcm: daily summary cron started (runs at 21:00 BDT daily)');
  }
}

// ── Singleton export ──────────────────────────────────────────────────────────
const fcmService = new FcmService();

module.exports = { fcmService, NOTIFICATION_TYPES, TEMPLATES };
