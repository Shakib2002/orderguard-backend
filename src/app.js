'use strict';

// Load and validate environment first
const { config, validateEnv } = require('./config/env');
validateEnv();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { connectDatabase, disconnectDatabase } = require('./config/database');
const logger = require('./utils/logger');
const { sendSuccess } = require('./utils/response');
const { errorHandler, notFoundHandler } = require('./middlewares/error.middleware');

// ── Route modules ─────────────────────────────────────────────────────────────
const authRoutes     = require('./modules/auth/auth.routes');
const ordersRoutes   = require('./modules/orders/orders.routes');
const tenantsRoutes  = require('./modules/tenants/tenants.routes');
const callsRoutes    = require('./modules/calls/calls.routes');
const emailRoutes    = require('./modules/email/email.routes');
const settingsRoutes = require('./modules/settings/settings.routes');
const { startEmailPollingCron, stopEmailPollingCron } = require('./modules/email/gmailFetcher.service');

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();

// ── Security headers ──────────────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: config.isProd, // Only enforce CSP in production
    crossOriginEmbedderPolicy: false,     // Relax for API usage
  })
);

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, Postman, curl)
      if (!origin) return callback(null, true);

      if (config.cors.allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS policy does not allow origin: ${origin}`));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
);

// ── Global rate limiter ───────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests from this IP. Please try again later.',
    data: null,
  },
});
app.use('/api/', limiter);

// Stricter limiter for auth endpoints to prevent brute-force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: {
    success: false,
    message: 'Too many authentication attempts. Please try again in 15 minutes.',
    data: null,
  },
});
app.use('/api/v1/auth/', authLimiter);

// ── Request parsing ───────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── HTTP request logging ──────────────────────────────────────────────────────
if (config.isDev) {
  app.use(morgan('dev'));
} else {
  // Production: log to Winston stream (JSON)
  app.use(
    morgan('combined', {
      stream: { write: (msg) => logger.http(msg.trim()) },
      // Skip health check logs in production to reduce noise
      skip: (req) => req.path === '/api/v1/health',
    })
  );
}

// ── Trust proxy (needed for Render.com, rate-limiting by real IP) ─────────────
app.set('trust proxy', 1);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/v1/health', (req, res) => {
  sendSuccess(res, {
    data: {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: config.appVersion,
      environment: config.nodeEnv,
    },
    message: 'OrderGuard API is running.',
  });
});

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/v1/auth',     authRoutes);
app.use('/api/v1/orders',   ordersRoutes);
app.use('/api/v1/tenants',  tenantsRoutes);
app.use('/api/v1/calls',    callsRoutes);
app.use('/api/v1/email',    emailRoutes);
app.use('/api/v1/settings', settingsRoutes);

// ── Root redirect ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.redirect('/api/v1/health');
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use(notFoundHandler);

// ── Global error handler (must be last) ──────────────────────────────────────
app.use(errorHandler);

// ── Server bootstrap ──────────────────────────────────────────────────────────
const startServer = async () => {
  try {
    await connectDatabase();

    const server = app.listen(config.port, () => {
      logger.info(`🚀 OrderGuard API running on port ${config.port}`);
      logger.info(`   Environment : ${config.nodeEnv}`);
      logger.info(`   Version     : v${config.appVersion}`);
      logger.info(`   Health      : http://localhost:${config.port}/api/v1/health`);
    });

    // ── Start Gmail polling cron ──────────────────────────────────────────────
    startEmailPollingCron();

    // ── Graceful shutdown ─────────────────────────────────────────────────────
    const gracefulShutdown = async (signal) => {
      logger.info(`${signal} received — shutting down gracefully...`);
      stopEmailPollingCron();

      server.close(async () => {
        await disconnectDatabase();
        logger.info('Server closed. Goodbye!');
        process.exit(0);
      });

      // Force shutdown after 10 seconds if graceful close hangs
      setTimeout(() => {
        logger.error('Forced shutdown after 10s timeout');
        process.exit(1);
      }, 10_000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Promise Rejection:', { reason, promise });
    });

    process.on('uncaughtException', (err) => {
      logger.error('Uncaught Exception:', err);
      process.exit(1);
    });

    return server;
  } catch (err) {
    logger.error('Failed to start server:', err);
    process.exit(1);
  }
};

startServer();

module.exports = app; // Export for testing
