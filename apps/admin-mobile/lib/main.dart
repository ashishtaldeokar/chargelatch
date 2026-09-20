import 'package:flutter/material.dart';

import 'src/api/api_client.dart';
import 'src/app.dart';
import 'src/auth/appauth_service.dart';
import 'src/auth/auth_controller.dart';
import 'src/ble/universal_ble_scanner.dart';
import 'src/config.dart';
import 'src/provisioning/esp_provisioner.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  const config = AppConfig();
  final auth = AuthController(AppAuthService(config));

  runApp(
    AdminApp(
      services: AppServices(
        auth: auth,
        api: HttpApiClient(baseUrl: config.apiUrl, accessToken: auth.accessToken),
        scanner: UniversalBleScanner(),
        provisioner: EspProvisioner(),
      ),
    ),
  );
}
