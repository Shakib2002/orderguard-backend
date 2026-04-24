// lib/services/fcm_service.dart
//
// OrderGuard — Firebase Cloud Messaging Service
// Drop this file into your Flutter project's lib/services/ folder.
//
// Required packages (pubspec.yaml):
//   firebase_core: ^3.0.0
//   firebase_messaging: ^15.0.0
//   flutter_local_notifications: ^17.0.0

import 'dart:convert';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:flutter/material.dart';

// ── Background handler (must be top-level function) ───────────────────────────
@pragma('vm:entry-point')
Future<void> firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  await Firebase.initializeApp();
  debugPrint('[FCM] Background: ${message.notification?.title}');
}

// ── Local notification plugin ─────────────────────────────────────────────────
final FlutterLocalNotificationsPlugin _localNotifications =
    FlutterLocalNotificationsPlugin();

const AndroidNotificationChannel _channel = AndroidNotificationChannel(
  'orderguard_orders',       // Must match backend: android.notification.channelId
  'OrderGuard অর্ডার',
  description: 'নতুন অর্ডার ও আপডেট নোটিফিকেশন',
  importance: Importance.high,
  playSound: true,
);

// ── FCM Service ───────────────────────────────────────────────────────────────
class FcmService {
  FcmService._();
  static final FcmService instance = FcmService._();

  // Callback for navigation (set from main.dart)
  static Function(String orderId)? onOrderTap;

  // ── Initialize everything ─────────────────────────────────────────────────
  Future<void> initialize() async {
    // 1. Background handler
    FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);

    // 2. Local notifications setup
    await _localNotifications.initialize(
      const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
        iOS: DarwinInitializationSettings(
          requestAlertPermission: true,
          requestBadgePermission: true,
          requestSoundPermission: true,
        ),
      ),
      onDidReceiveNotificationResponse: (details) {
        // User tapped local notification
        final payload = details.payload;
        if (payload != null) {
          final data = jsonDecode(payload);
          final orderId = data['orderId'] as String?;
          if (orderId != null) onOrderTap?.call(orderId);
        }
      },
    );

    // 3. Create Android channel
    await _localNotifications
        .resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin>()
        ?.createNotificationChannel(_channel);

    // 4. iOS foreground options
    await FirebaseMessaging.instance
        .setForegroundNotificationPresentationOptions(
      alert: true,
      badge: true,
      sound: true,
    );

    // 5. Listen for foreground messages
    FirebaseMessaging.onMessage.listen(_handleForegroundMessage);

    // 6. App opened from notification (background → foreground)
    FirebaseMessaging.onMessageOpenedApp.listen(_handleNotificationTap);

    // 7. App launched from terminated state via notification
    final initial = await FirebaseMessaging.instance.getInitialMessage();
    if (initial != null) _handleNotificationTap(initial);

    debugPrint('[FCM] Initialized ✅');
  }

  // ── Request permission & get token ────────────────────────────────────────
  Future<String?> requestPermissionAndGetToken() async {
    final settings =
        await FirebaseMessaging.instance.requestPermission(
      alert: true,
      badge: true,
      sound: true,
      provisional: false,
    );

    if (settings.authorizationStatus == AuthorizationStatus.denied) {
      debugPrint('[FCM] Permission denied');
      return null;
    }

    final token = await FirebaseMessaging.instance.getToken();
    debugPrint('[FCM] Token: ${token?.substring(0, 20)}...');
    return token;
  }

  // ── Foreground message handler ────────────────────────────────────────────
  void _handleForegroundMessage(RemoteMessage message) {
    debugPrint('[FCM] Foreground: ${message.notification?.title}');

    final notification = message.notification;
    final android = message.notification?.android;

    if (notification == null) return;

    // Show local notification (FCM doesn't auto-show in foreground on Android)
    _localNotifications.show(
      message.hashCode,
      notification.title,
      notification.body,
      NotificationDetails(
        android: AndroidNotificationDetails(
          _channel.id,
          _channel.name,
          channelDescription: _channel.description,
          icon: android?.smallIcon ?? '@mipmap/ic_launcher',
          importance: Importance.high,
          priority: Priority.high,
          playSound: true,
        ),
        iOS: const DarwinNotificationDetails(
          presentAlert: true,
          presentBadge: true,
          presentSound: true,
        ),
      ),
      payload: jsonEncode(message.data),
    );
  }

  // ── Notification tap handler → deep link ─────────────────────────────────
  void _handleNotificationTap(RemoteMessage message) {
    debugPrint('[FCM] Tapped: ${message.data}');
    final orderId = message.data['orderId'];
    if (orderId != null && orderId.isNotEmpty) {
      onOrderTap?.call(orderId);
    }
  }
}
