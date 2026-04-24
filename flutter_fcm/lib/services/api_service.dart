// lib/services/api_service.dart
//
// OrderGuard — API Service (FCM token registration + order calls)
// Uses Dio with auth token interceptor.

import 'package:dio/dio.dart';
import 'package:shared_preferences/shared_preferences.dart';

class ApiService {
  ApiService._();
  static final ApiService instance = ApiService._();

  static const String baseUrl = 'https://orderguard-backend-ecz3.onrender.com/api/v1';
  
  late final Dio _dio;
  String? _accessToken;

  void init() {
    _dio = Dio(BaseOptions(
      baseUrl: baseUrl,
      connectTimeout: const Duration(seconds: 15),
      receiveTimeout: const Duration(seconds: 30),
      headers: {'Content-Type': 'application/json'},
    ));

    // Auth interceptor
    _dio.interceptors.add(InterceptorsWrapper(
      onRequest: (options, handler) async {
        final token = await _getToken();
        if (token != null) {
          options.headers['Authorization'] = 'Bearer $token';
        }
        handler.next(options);
      },
      onError: (error, handler) {
        if (error.response?.statusCode == 401) {
          // Token expired — handle refresh
          _accessToken = null;
        }
        handler.next(error);
      },
    ));
  }

  Future<String?> _getToken() async {
    if (_accessToken != null) return _accessToken;
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString('access_token');
  }

  void setToken(String token) {
    _accessToken = token;
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  Future<Map<String, dynamic>> login(String email, String password) async {
    final res = await _dio.post('/auth/login', data: {
      'email': email,
      'password': password,
    });
    final data = res.data['data'];
    setToken(data['accessToken']);
    
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString('access_token', data['accessToken']);
    
    return data;
  }

  // ── FCM Token Registration ─────────────────────────────────────────────────
  Future<void> registerFcmToken(String fcmToken) async {
    try {
      await _dio.post('/settings/fcm-token', data: {'fcmToken': fcmToken});
    } catch (e) {
      // Non-critical — don't throw
    }
  }

  // ── Orders ────────────────────────────────────────────────────────────────
  Future<Map<String, dynamic>> getOrders({
    String? status,
    String? search,
    int page = 1,
    int limit = 20,
  }) async {
    final res = await _dio.get('/orders', queryParameters: {
      if (status != null) 'status': status,
      if (search != null) 'search': search,
      'page': page,
      'limit': limit,
      'sortBy': 'createdAt',
      'sortOrder': 'desc',
    });
    return res.data['data'];
  }

  Future<Map<String, dynamic>> getOrder(String orderId) async {
    final res = await _dio.get('/orders/$orderId');
    return res.data['data'];
  }

  Future<Map<String, dynamic>> updateOrderStatus(
      String orderId, String status, {String? notes}) async {
    final res = await _dio.patch('/orders/$orderId/status', data: {
      'status': status,
      if (notes != null) 'notes': notes,
    });
    return res.data['data'];
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  Future<Map<String, dynamic>> getStatsSummary() async {
    final res = await _dio.get('/orders/stats/summary');
    return res.data['data'];
  }

  Future<List<dynamic>> getStatsChart(String period) async {
    final res = await _dio.get('/orders/stats/chart',
        queryParameters: {'period': period});
    return res.data['data'];
  }

  // ── Manual Verification ───────────────────────────────────────────────────
  Future<Map<String, dynamic>> logManualCall(
      String orderId, String outcome, {String? notes}) async {
    final res = await _dio.post('/calls/manual-log', data: {
      'orderId': orderId,
      'outcome': outcome,
      if (notes != null) 'notes': notes,
    });
    return res.data['data'];
  }

  Future<Map<String, dynamic>> sendSms(String orderId) async {
    final res = await _dio.post('/calls/send-sms', data: {'orderId': orderId});
    return res.data['data'];
  }

  // ── Settings ──────────────────────────────────────────────────────────────
  Future<Map<String, dynamic>> getSettings() async {
    final res = await _dio.get('/settings');
    return res.data['data'];
  }
}
