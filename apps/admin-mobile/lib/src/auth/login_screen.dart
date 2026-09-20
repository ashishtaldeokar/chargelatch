import 'package:flutter/material.dart';

import '../config.dart';
import 'auth_controller.dart';

class LoginScreen extends StatelessWidget {
  const LoginScreen({super.key, required this.auth});

  final AuthController auth;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final busy = auth.status == AuthStatus.signingIn;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.ev_station, size: 72, color: theme.colorScheme.primary),
                const SizedBox(height: 16),
                Text('chargelatch admin', style: theme.textTheme.headlineMedium),
                const SizedBox(height: 8),
                Text(
                  'Sign in to pair devices with Wi-Fi.',
                  style: theme.textTheme.bodyLarge?.copyWith(color: theme.colorScheme.onSurfaceVariant),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 32),
                FilledButton.icon(
                  onPressed: busy ? null : auth.signIn,
                  icon: busy
                      ? const SizedBox.square(dimension: 18, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.login),
                  label: Text(busy ? 'Signing in…' : 'Sign in'),
                ),
                if (auth.error != null) ...[
                  const SizedBox(height: 16),
                  Text(auth.error!, style: TextStyle(color: theme.colorScheme.error), textAlign: TextAlign.center),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Signed in, but without the realm role the API demands for provisioning.
class NotAdminScreen extends StatelessWidget {
  const NotAdminScreen({super.key, required this.auth});

  final AuthController auth;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.all(32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.lock_outline, size: 56, color: theme.colorScheme.error),
                const SizedBox(height: 16),
                Text(
                  '${auth.session?.email ?? 'This account'} does not have the '
                  '"${AppConfig.requiredRole}" role needed to provision devices.',
                  textAlign: TextAlign.center,
                  style: theme.textTheme.bodyLarge,
                ),
                const SizedBox(height: 24),
                OutlinedButton(onPressed: auth.signOut, child: const Text('Sign out')),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
