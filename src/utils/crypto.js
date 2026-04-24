'use strict';

const crypto = require('crypto');
const { config } = require('../config/env');

const ALGORITHM = 'aes-256-cbc';
const KEY_LENGTH = 32; // bytes for AES-256
const IV_LENGTH = 16;  // bytes for CBC

/**
 * Derive a 32-byte key from the ENCRYPTION_KEY env var.
 * Pads or truncates to exactly 32 bytes.
 */
const getKey = () => {
  const key = config.encryptionKey || '';
  return Buffer.from(key.padEnd(KEY_LENGTH, '0').slice(0, KEY_LENGTH));
};

/**
 * Encrypt a plaintext string.
 * @param {string} text - Plaintext to encrypt
 * @returns {string} - "iv:encryptedHex" format
 */
const encrypt = (text) => {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
};

/**
 * Decrypt a previously encrypted string.
 * @param {string} encryptedText - "iv:encryptedHex" format
 * @returns {string} - Original plaintext
 */
const decrypt = (encryptedText) => {
  const [ivHex, encryptedHex] = encryptedText.split(':');
  if (!ivHex || !encryptedHex) throw new Error('Invalid encrypted text format');

  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
};

module.exports = { encrypt, decrypt };
