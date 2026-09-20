import 'package:flutter_appauth/flutter_appauth.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../config.dart';
import 'auth_service.dart';

/// Authorization code flow with PKCE in the system browser, against the public
/// `chargelatch-admin-mobile` Keycloak client. Only the refresh token is persisted, in the
/// platform keystore.
class AppAuthService implements AuthService {
  AppAuthService(this._config, {FlutterAppAuth? appAuth, FlutterSecureStorage? storage})
      : _appAuth = appAuth ?? const FlutterAppAuth(),
        _storage = storage ?? const FlutterSecureStorage();

  static const _refreshTokenKey = 'refresh_token';
  static const _idTokenKey = 'id_token';
  static const _scopes = ['openid', 'profile', 'email'];

  final AppConfig _config;
  final FlutterAppAuth _appAuth;
  final FlutterSecureStorage _storage;

  String get _discoveryUrl => '${_config.issuer}/.well-known/openid-configuration';
  // Plain http is only ever the local dev Keycloak.
  bool get _insecure => _config.keycloakUrl.startsWith('http://');

  @override
  Future<AuthSession?> restore() async {
    final refreshToken = await _storage.read(key: _refreshTokenKey);
    if (refreshToken == null) return null;
    try {
      return await _exchangeRefreshToken(refreshToken, await _storage.read(key: _idTokenKey));
    } catch (_) {
      // Expired or revoked: fall back to an interactive sign-in.
      await _clear();
      return null;
    }
  }

  @override
  Future<AuthSession> signIn() async {
    final response = await _appAuth.authorizeAndExchangeCode(
      AuthorizationTokenRequest(
        _config.clientId,
        AppConfig.redirectUrl,
        discoveryUrl: _discoveryUrl,
        scopes: _scopes,
        allowInsecureConnections: _insecure,
      ),
    );
    return _persist(response, null);
  }

  @override
  Future<AuthSession> refresh(AuthSession session) {
    final refreshToken = session.refreshToken;
    if (refreshToken == null) throw StateError('Session cannot be refreshed');
    return _exchangeRefreshToken(refreshToken, session.idToken);
  }

  @override
  Future<void> signOut(AuthSession session) async {
    await _clear();
    final idToken = session.idToken;
    if (idToken == null) return;
    try {
      await _appAuth.endSession(
        EndSessionRequest(
          idTokenHint: idToken,
          postLogoutRedirectUrl: AppConfig.redirectUrl,
          discoveryUrl: _discoveryUrl,
          allowInsecureConnections: _insecure,
        ),
      );
    } catch (_) {
      // Local tokens are already gone; a cancelled browser logout is not worth surfacing.
    }
  }

  Future<AuthSession> _exchangeRefreshToken(String refreshToken, String? idToken) async {
    final response = await _appAuth.token(
      TokenRequest(
        _config.clientId,
        AppConfig.redirectUrl,
        discoveryUrl: _discoveryUrl,
        refreshToken: refreshToken,
        scopes: _scopes,
        allowInsecureConnections: _insecure,
      ),
    );
    return _persist(response, idToken);
  }

  Future<AuthSession> _persist(TokenResponse response, String? previousIdToken) async {
    final accessToken = response.accessToken;
    if (accessToken == null) throw StateError('Keycloak returned no access token');
    final session = AuthSession(
      accessToken: accessToken,
      expiresAt: response.accessTokenExpirationDateTime ?? DateTime.now().add(const Duration(minutes: 1)),
      refreshToken: response.refreshToken,
      idToken: response.idToken ?? previousIdToken,
    );
    await _storage.write(key: _refreshTokenKey, value: session.refreshToken);
    await _storage.write(key: _idTokenKey, value: session.idToken);
    return session;
  }

  Future<void> _clear() async {
    await _storage.delete(key: _refreshTokenKey);
    await _storage.delete(key: _idTokenKey);
  }
}
