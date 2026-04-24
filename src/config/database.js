'use strict';

const { PrismaClient } = require('@prisma/client');
const logger = require('../utils/logger');

// Prisma singleton — prevents multiple connections in dev (hot reload)
let prisma;

const getPrismaClient = () => {
  if (!prisma) {
    prisma = new PrismaClient({
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' },
      ],
      errorFormat: 'minimal',
    });

    // Log slow queries in development
    if (process.env.NODE_ENV === 'development') {
      prisma.$on('query', (e) => {
        if (e.duration > 500) {
          logger.warn(`Slow query detected (${e.duration}ms): ${e.query}`);
        }
      });
    }

    prisma.$on('error', (e) => {
      logger.error('Prisma error:', e);
    });

    prisma.$on('warn', (e) => {
      logger.warn('Prisma warning:', e);
    });
  }

  return prisma;
};

/**
 * Connect to the database and verify the connection.
 */
const connectDatabase = async () => {
  const client = getPrismaClient();
  await client.$connect();
  logger.info('✅ Database connected successfully');
  return client;
};

/**
 * Gracefully disconnect from the database.
 */
const disconnectDatabase = async () => {
  if (prisma) {
    await prisma.$disconnect();
    logger.info('Database disconnected');
  }
};

module.exports = {
  getPrismaClient,
  connectDatabase,
  disconnectDatabase,
};
