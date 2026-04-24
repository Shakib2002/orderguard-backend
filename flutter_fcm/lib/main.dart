// lib/main.dart
//
// OrderGuard Flutter App — Entry Point with Firebase + FCM

import 'package:flutter/material.dart';
import 'package:firebase_core/firebase_core.dart';
import 'services/fcm_service.dart';
import 'services/api_service.dart';

// Global navigator key for deep linking from notifications
final GlobalKey<NavigatorState> navigatorKey = GlobalKey<NavigatorState>();

void main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // 1. Initialize Firebase
  await Firebase.initializeApp();

  // 2. Initialize FCM service
  await FcmService.instance.initialize();

  // 3. Initialize API service
  ApiService.instance.init();

  // 4. Deep link handler — navigate to order when notification tapped
  FcmService.onOrderTap = (String orderId) {
    navigatorKey.currentState?.pushNamed('/order-detail', arguments: orderId);
  };

  runApp(const OrderGuardApp());
}

class OrderGuardApp extends StatelessWidget {
  const OrderGuardApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'OrderGuard',
      navigatorKey: navigatorKey,
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF6C63FF)),
        useMaterial3: true,
      ),
      home: const LoginScreen(),
      routes: {
        '/home':         (_) => const HomeScreen(),
        '/order-detail': (_) => const OrderDetailScreen(),
      },
    );
  }
}

// ── Login Screen ──────────────────────────────────────────────────────────────
class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _emailCtrl    = TextEditingController();
  final _passwordCtrl = TextEditingController();
  bool _loading = false;

  Future<void> _login() async {
    setState(() => _loading = true);
    try {
      await ApiService.instance.login(_emailCtrl.text, _passwordCtrl.text);

      // Register FCM token after login
      final token = await FcmService.instance.requestPermissionAndGetToken();
      if (token != null) {
        await ApiService.instance.registerFcmToken(token);
      }

      if (mounted) {
        Navigator.pushReplacementNamed(context, '/home');
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Login failed: $e')),
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Text('OrderGuard', style: TextStyle(fontSize: 32, fontWeight: FontWeight.bold)),
            const SizedBox(height: 40),
            TextField(controller: _emailCtrl,    decoration: const InputDecoration(labelText: 'Email')),
            const SizedBox(height: 16),
            TextField(controller: _passwordCtrl, decoration: const InputDecoration(labelText: 'Password'), obscureText: true),
            const SizedBox(height: 24),
            SizedBox(
              width: double.infinity,
              child: ElevatedButton(
                onPressed: _loading ? null : _login,
                child: _loading ? const CircularProgressIndicator() : const Text('Login'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ── Placeholder screens (implement in your project) ───────────────────────────
class HomeScreen        extends StatelessWidget { const HomeScreen({super.key}); @override Widget build(BuildContext context) => const Scaffold(body: Center(child: Text('Home'))); }
class OrderDetailScreen extends StatelessWidget { const OrderDetailScreen({super.key}); @override Widget build(BuildContext context) => const Scaffold(body: Center(child: Text('Order Detail'))); }
