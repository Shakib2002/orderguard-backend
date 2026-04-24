'use strict';

const express = require('express');
const router = express.Router();

const {
  register,
  login,
  refresh,
  logout,
  me,
  updateFcmToken,
} = require('./auth.controller');

const {
  joiValidate,
  registerSchema,
  loginSchema,
  refreshSchema,
  fcmTokenSchema,
} = require('./auth.validator');

const { authenticateToken } = require('../../middlewares/auth.middleware');

// ── Public routes (no token required) ────────────────────────────────────────
router.post('/register', joiValidate(registerSchema), register);
router.post('/login',    joiValidate(loginSchema),    login);
router.post('/refresh',  joiValidate(refreshSchema),  refresh);

// ── Protected routes (valid access token required) ───────────────────────────
router.use(authenticateToken); // apply to all routes below

router.post('/logout',   logout);                                    // body { refreshToken? }
router.get('/me',        me);
router.patch('/fcm-token', joiValidate(fcmTokenSchema), updateFcmToken);

module.exports = router;
