import 'package:flutter/foundation.dart';

import '../config.dart';
import 'auth_service.dart';

enum AuthStatus { restoring, signedOut, signingIn, signedIn }

class AuthController extends ChangeNotifier {
  AuthController(this._service);

  final AuthService _service;

  AuthStatus status = AuthStatus.restoring;
  AuthSession? session;
  String? error;

  bool get isAdmin => session?.roles.contains(AppConfig.requiredRole) ?? false;

  Future<void> restore() async {
    try {
      session = await _service.restore();
    } catch (_) {
      session = null;
    }
    _set(session == null ? AuthStatus.signedOut : AuthStatus.signedIn);
  }

  Future<void> signIn() async {
    error = null;
    _set(AuthStatus.signingIn);
    try {
      session = await _service.signIn();
      _set(AuthStatus.signedIn);
    } catch (e) {
      error = 'Sign-in failed or was cancelled.';
      debugPrint('sign-in failed: $e');
      _set(AuthStatus.signedOut);
    }
  }

  Future<void> signOut() async {
    final current = session;
    session = null;
    _set(AuthStatus.signedOut);
    if (current != null) await _service.signOut(current);
  }

  /// A valid access token for API calls, refreshing it first when it is about to expire.
  /// Signs the user out if the session can no longer be refreshed.
  Future<String> accessToken() async {
    var current = session;
    if (current == null) throw StateError('Not signed in');
    if (current.isExpiringSoon) {
      try {
        current = await _service.refresh(current);
        session = current;
      } catch (_) {
        session = null;
        error = 'Your session expired. Please sign in again.';
        _set(AuthStatus.signedOut);
        throw StateError('Session expired');
      }
    }
    return current.accessToken;
  }

  void _set(AuthStatus next) {
    status = next;
    notifyListeners();
  }
}
