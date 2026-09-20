import 'dart:convert';

class AuthSession {
  const AuthSession({
    required this.accessToken,
    required this.expiresAt,
    this.refreshToken,
    this.idToken,
  });

  final String accessToken;
  final DateTime expiresAt;
  final String? refreshToken;
  final String? idToken;

  bool get isExpiringSoon => DateTime.now().isAfter(expiresAt.subtract(const Duration(seconds: 30)));

  Map<String, dynamic> get claims => decodeJwtPayload(accessToken);
  String? get email => claims['email'] as String?;
  List<String> get roles {
    final realmAccess = claims['realm_access'];
    if (realmAccess is! Map || realmAccess['roles'] is! List) return const [];
    return (realmAccess['roles'] as List).whereType<String>().toList();
  }
}

/// Signs in against Keycloak. Implemented with AppAuth on device, faked in tests.
abstract class AuthService {
  /// A previously stored session, refreshed if needed; null when the user must sign in.
  Future<AuthSession?> restore();
  Future<AuthSession> signIn();
  Future<AuthSession> refresh(AuthSession session);
  Future<void> signOut(AuthSession session);
}

/// Payload of a JWT WITHOUT verifying it. Only for display and role hints: the API is what
/// actually verifies tokens.
Map<String, dynamic> decodeJwtPayload(String token) {
  final parts = token.split('.');
  if (parts.length != 3) return const {};
  try {
    final json = utf8.decode(base64Url.decode(base64Url.normalize(parts[1])));
    final payload = jsonDecode(json);
    return payload is Map<String, dynamic> ? payload : const {};
  } on FormatException {
    return const {};
  }
}
