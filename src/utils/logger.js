'use strict';

const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const { config } = require('../config/env');

const { combine, timestamp, errors, json, colorize, printf } = winston.format;

// ── Custom console format for development ─────────────────────────────────────
const devFormat = printf(({ level, message, timestamp: ts, stack, ...meta }) => {
  let log = `${ts} [${level}]: ${stack || message}`;
  if (Object.keys(meta).length > 0) {
    log += `\n  ${JSON.stringify(meta, null, 2)}`;
  }
  return log;
});

// ── Transports ────────────────────────────────────────────────────────────────
const transports = [];

// Console — always on
transports.push(
  new winston.transports.Console({
    format: config.isDev
      ? combine(colorize(), timestamp({ format: 'HH:mm:ss' }), errors({ stack: true }), devFormat)
      : combine(timestamp(), errors({ stack: true }), json()),
  })
);

// File rotation — only in production or if LOG_DIR is set
if (config.isProd || config.log.dir !== 'logs') {
  const logDir = path.resolve(config.log.dir);

  transports.push(
    new DailyRotateFile({
      dirname: logDir,
      filename: 'error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      level: 'error',
      maxFiles: '14d',
      format: combine(timestamp(), errors({ stack: true }), json()),
    })
  );

  transports.push(
    new DailyRotateFile({
      dirname: logDir,
      filename: 'combined-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxFiles: '7d',
      format: combine(timestamp(), errors({ stack: true }), json()),
    })
  );
}

// ── Logger instance ───────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: config.log.level,
  transports,
  // Don't exit on handled exceptions
  exitOnError: false,
});

module.exports = logger;
