'use strict';

// HOW SELLERS SET UP GMAIL FOR ORDERGUARD (show this in the Flutter app UI):
// ─────────────────────────────────────────────────────────────────────────────
// 1. Open Gmail → Settings (⚙️) → See all settings → Forwarding and POP/IMAP
// 2. Enable IMAP access → Save Changes
// 3. Go to Google Account (myaccount.google.com) → Security
// 4. Under "How you sign in to Google" → 2-Step Verification → must be ON
// 5. At the bottom → App passwords → Select app: "Mail", device: "Other"
// 6. Google gives a 16-character password → enter it in OrderGuard app
//
// Alternative — Gmail Filter Forwarding:
//   Create a Gmail filter: From:(any) Subject:(অর্ডার OR order)
//   → Forward to {slug}@mail.orderguard.app
// ─────────────────────────────────────────────────────────────────────────────

const Imap = require('imap');
const { simpleParser } = require('mailparser');
const cron = require('node-cron');

const { getPrismaClient } = require('../../config/database');
const { decrypt } = require('../../utils/crypto');
const logger = require('../../utils/logger');
const { extractOrderFromEmail, isOrderEmail } = require('./orderParser.service');

// ── Constants ─────────────────────────────────────────────────────────────────

const IMAP_TIMEOUT_MS   = 10_000; // 10 seconds
const MAX_EMAILS_PER_POLL = 20;   // cap per tenant per cycle
const CRON_SCHEDULE     = '*/2 * * * *'; // every 2 minutes

// ── IMAP config factory ───────────────────────────────────────────────────────

const buildImapConfig = (gmailAddress, appPassword) => ({
  user: gmailAddress,
  password: appPassword,
  host: 'imap.gmail.com',
  port: 993,
  tls: true,
  tlsOptions: { rejectUnauthorized: false },
  connTimeout: IMAP_TIMEOUT_MS,
  authTimeout: IMAP_TIMEOUT_MS,
});

// ── Test connection ───────────────────────────────────────────────────────────

/**
 * Attempt a quick IMAP connect + authenticate, then disconnect.
 * Resolves true on success, rejects with error on failure.
 *
 * @param {string} gmailAddress
 * @param {string} appPassword  - plaintext (already decrypted)
 * @returns {Promise<boolean>}
 */
const testImapConnection = (gmailAddress, appPassword) => {
  return new Promise((resolve, reject) => {
    const imap = new Imap(buildImapConfig(gmailAddress, appPassword));

    const cleanup = () => { try { imap.destroy(); } catch (_) {} };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('IMAP connection timed out after 10 seconds'));
    }, IMAP_TIMEOUT_MS);

    imap.once('ready', () => {
      clearTimeout(timer);
      imap.end();
      resolve(true);
    });

    imap.once('error', (err) => {
      clearTimeout(timer);
      cleanup();
      reject(err);
    });

    imap.connect();
  });
};

// ── Email fetching ────────────────────────────────────────────────────────────

/**
 * Open INBOX and search for UNSEEN messages since lastCheckedAt.
 * Returns array of parsed message objects.
 *
 * @param {Imap}      imap
 * @param {Date|null} since
 * @returns {Promise<Array>}
 */
const searchAndFetch = (imap, since) => {
  return new Promise((resolve, reject) => {
    imap.openBox('INBOX', false, (openErr) => {
      if (openErr) return reject(openErr);

      const criteria = ['UNSEEN'];
      if (since) criteria.push(['SINCE', since]);

      imap.search(criteria, (searchErr, uids) => {
        if (searchErr) return reject(searchErr);
        if (!uids || uids.length === 0) return resolve([]);

        const limitedUids = uids.slice(-MAX_EMAILS_PER_POLL); // most recent N
        const messages = [];
        const parsePromises = [];

        const fetcher = imap.fetch(limitedUids, {
          bodies: '',        // fetch full RFC 2822 message
          markSeen: false,   // we'll mark READ after successful processing
          struct: true,
        });

        fetcher.on('message', (msg) => {
          let rawBuffer = Buffer.alloc(0);
          let msgUid;

          msg.on('body', (stream) => {
            const chunks = [];
            stream.on('data', (chunk) => chunks.push(chunk));
            stream.on('end', () => { rawBuffer = Buffer.concat(chunks); });
          });

          msg.once('attributes', (attrs) => { msgUid = attrs.uid; });

          msg.once('end', () => {
            // parse after all body chunks collected
            const p = simpleParser(rawBuffer)
              .then((parsed) => {
                messages.push({
                  uid: msgUid,
                  messageId: parsed.messageId || `no-id-${Date.now()}-${msgUid}`,
                  subject: parsed.subject || '(no subject)',
                  fromAddress: parsed.from?.text || '',
                  bodyText: parsed.text || '',
                  bodyHtml: parsed.html || '',
                  date: parsed.date,
                });
              })
              .catch((e) => {
                logger.warn('gmailFetcher: failed to parse message', { uid: msgUid, error: e.message });
              });
            parsePromises.push(p);
          });
        });

        fetcher.once('error', reject);

        fetcher.once('end', async () => {
          await Promise.allSettled(parsePromises);
          resolve(messages);
        });
      });
    });
  });
};

/**
 * Mark a list of UIDs as READ (SEEN) in Gmail.
 */
const markAsRead = (imap, uids) => {
  return new Promise((resolve) => {
    if (!uids || uids.length === 0) return resolve();
    imap.addFlags(uids, '\\Seen', (err) => {
      if (err) logger.warn('gmailFetcher: could not mark emails as read', { error: err.message });
      resolve();
    });
  });
};

// ── Per-tenant poll ───────────────────────────────────────────────────────────

/**
 * Full IMAP poll cycle for a single tenant.
 * 1. Decrypt app password
 * 2. Connect to Gmail
 * 3. Fetch unseen emails since lastCheckedAt
 * 4. Filter to order emails
 * 5. Deduplicate via DB messageId check
 * 6. Store in raw_emails, create orders
 * 7. Mark processed emails READ, update lastCheckedAt
 *
 * @param {object} emailConfig - Prisma EmailConfig record
 */
const pollTenant = async (emailConfig) => {
  const prisma = getPrismaClient();
  const { id: configId, tenantId, gmailAddress, gmailAppPassword, lastCheckedAt } = emailConfig;

  let appPassword;
  try {
    appPassword = decrypt(gmailAppPassword);
  } catch (decryptErr) {
    logger.error('gmailFetcher: failed to decrypt app password', { tenantId, error: decryptErr.message });
    return;
  }

  const imap = new Imap(buildImapConfig(gmailAddress, appPassword));
  const readUids = [];

  try {
    // ── Connect ───────────────────────────────────────────────────────────────
    await new Promise((resolve, reject) => {
      imap.once('ready', resolve);
      imap.once('error', reject);
      imap.connect();
    });

    // ── Fetch ─────────────────────────────────────────────────────────────────
    const messages = await searchAndFetch(imap, lastCheckedAt);

    logger.info('gmailFetcher: fetched messages', {
      tenantId,
      gmailAddress,
      total: messages.length,
    });

    // ── Process each message ──────────────────────────────────────────────────
    for (const msg of messages) {
      // 1. Filter by subject keywords
      if (!isOrderEmail(msg.subject)) {
        readUids.push(msg.uid); // mark non-order emails read to skip next time
        continue;
      }

      // 2. Dedup check
      const existing = await prisma.rawEmail.findUnique({
        where: { tenantId_messageId: { tenantId, messageId: msg.messageId } },
        select: { id: true },
      });
      if (existing) {
        readUids.push(msg.uid);
        continue;
      }

      // 3. Store raw email
      const rawEmail = await prisma.rawEmail.create({
        data: {
          tenantId,
          messageId: msg.messageId,
          subject: msg.subject,
          fromAddress: msg.fromAddress,
          bodyText: msg.bodyText,
          bodyHtml: msg.bodyHtml,
        },
      });

      // 4. Parse order from email content
      const parsed = extractOrderFromEmail({
        subject: msg.subject,
        body: msg.bodyText,
        from: msg.fromAddress,
      });

      if (parsed) {
        // 5. Create order
        try {
          await prisma.$transaction([
            prisma.order.create({
              data: {
                tenantId,
                externalId: parsed.externalId || null,
                customerName: parsed.customerName || 'Unknown Customer',
                customerPhone: parsed.customerPhone || '01000000000',
                address: parsed.address || null,
                productName: parsed.productName || msg.subject,
                quantity: parsed.quantity || 1,
                totalPrice: parsed.totalPrice || 0,
                rawEmailId: rawEmail.id,
                notes: `Auto-created from email. Confidence: ${parsed._confidence}%`,
                status: 'PENDING',
                callStatus: 'NOT_CALLED',
              },
            }),
            prisma.rawEmail.update({
              where: { id: rawEmail.id },
              data: { isParsed: true, processedAt: new Date() },
            }),
          ]);

          logger.info('gmailFetcher: order created from email', {
            tenantId,
            subject: msg.subject,
            confidence: parsed._confidence,
          });
        } catch (orderErr) {
          logger.error('gmailFetcher: failed to create order', {
            tenantId,
            rawEmailId: rawEmail.id,
            error: orderErr.message,
          });
        }
      } else {
        logger.info('gmailFetcher: email not parsed (low confidence)', {
          tenantId,
          subject: msg.subject,
        });
      }

      readUids.push(msg.uid);
    }

    // ── Mark processed emails as READ ─────────────────────────────────────────
    if (readUids.length > 0) {
      await markAsRead(imap, readUids);
    }

    // ── Update lastCheckedAt ──────────────────────────────────────────────────
    await prisma.emailConfig.update({
      where: { id: configId },
      data: { lastCheckedAt: new Date() },
    });

  } catch (err) {
    logger.error('gmailFetcher: poll failed', {
      tenantId,
      gmailAddress,
      error: err.message,
    });

    // If auth failed → deactivate config so we stop retrying
    if (
      err.message?.includes('Invalid credentials') ||
      err.message?.includes('authentication failed') ||
      err.message?.includes('AUTHENTICATIONFAILED')
    ) {
      await prisma.emailConfig.update({
        where: { id: configId },
        data: { isActive: false },
      });
      logger.warn('gmailFetcher: deactivated config due to auth failure', { tenantId });
    }
  } finally {
    try { imap.end(); } catch (_) {}
  }
};

// ── Cron job ──────────────────────────────────────────────────────────────────

let cronJob = null;

/**
 * Start the Gmail polling cron job.
 * Runs every 2 minutes, polls all active EmailConfig records.
 * Safe to call multiple times — idempotent.
 */
const startEmailPollingCron = () => {
  if (cronJob) return; // already running

  cronJob = cron.schedule(CRON_SCHEDULE, async () => {
    const prisma = getPrismaClient();

    let activeConfigs;
    try {
      activeConfigs = await prisma.emailConfig.findMany({
        where: { isActive: true },
      });
    } catch (err) {
      logger.error('gmailFetcher: failed to load email configs', { error: err.message });
      return;
    }

    if (activeConfigs.length === 0) return;

    logger.info(`gmailFetcher: polling ${activeConfigs.length} tenant(s)`);

    // Poll tenants sequentially to avoid hammering Gmail
    for (const config of activeConfigs) {
      await pollTenant(config);
    }
  });

  logger.info(`gmailFetcher: cron started (schedule: ${CRON_SCHEDULE})`);
};

/**
 * Stop the cron job (used on graceful shutdown).
 */
const stopEmailPollingCron = () => {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
    logger.info('gmailFetcher: cron stopped');
  }
};

module.exports = { testImapConnection, startEmailPollingCron, stopEmailPollingCron };
