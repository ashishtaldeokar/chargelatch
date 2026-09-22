/// Build-time configuration, overridable with `--dart-define=KEY=value`.
///
/// The defaults target the local dev stack. BLE needs a physical phone, where `localhost` is the
/// phone itself: on Android run `adb reverse tcp:3000 tcp:3000 && adb reverse tcp:8080 tcp:8080`
/// so these URLs reach your machine (and so the token issuer matches what the API expects).
class AppConfig {
  const AppConfig({
    this.apiUrl = const String.fromEnvironment('API_URL', defaultValue: 'https://sonik-api.ashishtaldeokar.in'),
    this.keycloakUrl = const String.fromEnvironment('KEYCLOAK_URL', defaultValue: 'https://auth.ashishtaldeokar.in'),
    this.keycloakRealm = const String.fromEnvironment('KEYCLOAK_REALM', defaultValue: 'chargelatch'),
    this.clientId = const String.fromEnvironment('KEYCLOAK_CLIENT_ID', defaultValue: 'chargelatch-admin-mobile'),
  });

  final String apiUrl;
  final String keycloakUrl;
  final String keycloakRealm;
  final String clientId;

  String get issuer => '$keycloakUrl/realms/$keycloakRealm';

  /// Must match the app id (android `appAuthRedirectScheme`, iOS `CFBundleURLSchemes`) and the
  /// redirect URI registered on the Keycloak client (`com.sonik.chargelatch.admin:/*`).
  static const redirectUrl = 'com.sonik.chargelatch.admin:/oauthredirect';

  /// Realm role required to use this app; the API enforces it on `/api/admin/*`.
  static const requiredRole = 'admin';
}
