import 'package:flutter/material.dart';

import 'api/api_client.dart';
import 'auth/auth_controller.dart';
import 'auth/login_screen.dart';
import 'ble/ble_scanner.dart';
import 'devices/scan_screen.dart';
import 'provisioning/provisioner.dart';

/// Everything that touches the outside world, so tests can swap each piece for a fake.
class AppServices {
  const AppServices({required this.auth, required this.api, required this.scanner, required this.provisioner});

  final AuthController auth;
  final ApiClient api;
  final BleScanner scanner;
  final DeviceProvisioner provisioner;
}

class AdminApp extends StatefulWidget {
  const AdminApp({super.key, required this.services});

  final AppServices services;

  @override
  State<AdminApp> createState() => _AdminAppState();
}

class _AdminAppState extends State<AdminApp> {
  @override
  void initState() {
    super.initState();
    widget.services.auth.restore();
  }

  @override
  Widget build(BuildContext context) {
    final seed = const Color(0xFF16A34A);
    return MaterialApp(
      title: 'chargelatch admin',
      theme: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: seed), useMaterial3: true),
      darkTheme: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: seed, brightness: Brightness.dark), useMaterial3: true),
      home: ListenableBuilder(
        listenable: widget.services.auth,
        builder: (context, _) {
          final auth = widget.services.auth;
          return switch (auth.status) {
            AuthStatus.restoring => const Scaffold(body: Center(child: CircularProgressIndicator())),
            AuthStatus.signedOut || AuthStatus.signingIn => LoginScreen(auth: auth),
            AuthStatus.signedIn => auth.isAdmin ? ScanScreen(services: widget.services) : NotAdminScreen(auth: auth),
          };
        },
      ),
    );
  }
}
