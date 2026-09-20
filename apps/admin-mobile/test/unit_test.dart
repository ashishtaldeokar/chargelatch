import 'dart:convert';

import 'package:admin_mobile/src/api/api_client.dart';
import 'package:admin_mobile/src/auth/auth_controller.dart';
import 'package:admin_mobile/src/ble/universal_ble_transport.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'fakes.dart';

void main() {
  group('provisioning endpoint UUIDs', () {
    test('follow ESP-IDF\'s scheme of patching the 16-bit id into the service UUID', () {
      expect(endpointCharacteristicUuid('prov-session'), '021aff51-0382-4aea-bff4-6b3f1c5adfb4');
      expect(endpointCharacteristicUuid('prov-config'), '021aff52-0382-4aea-bff4-6b3f1c5adfb4');
      expect(endpointCharacteristicUuid('prov-scan'), '021aff50-0382-4aea-bff4-6b3f1c5adfb4');
      expect(endpointCharacteristicUuid('custom-data'), '021aff54-0382-4aea-bff4-6b3f1c5adfb4');
    });

    test('reject unknown endpoints', () {
      expect(() => endpointCharacteristicUuid('nope'), throwsArgumentError);
    });
  });

  group('device names', () {
    test('factory identities are recognised, dev boards are not', () {
      expect(factoryDevice.identity, 'SONIK-42');
      expect(devBoard.identity, isNull);
    });
  });

  group('session', () {
    test('reads email and realm roles from the access token', () {
      final session = fakeSession(roles: ['admin', 'factory'], email: 'a@b.c');
      expect(session.email, 'a@b.c');
      expect(session.roles, ['admin', 'factory']);
    });

    test('a malformed token has no roles instead of throwing', () {
      expect(fakeSession().roles, isNotEmpty);
      expect(AuthController(FakeAuthService()).isAdmin, isFalse);
    });

    test('an expiring token is refreshed before use', () async {
      final service = FakeAuthService(stored: fakeSession(validFor: const Duration(seconds: 5)));
      final auth = AuthController(service);
      await auth.restore();
      await auth.accessToken();
      expect(service.refreshes, 1);
      await auth.accessToken();
      expect(service.refreshes, 1, reason: 'the refreshed token is still valid');
    });

    test('a failed refresh signs the user out', () async {
      final auth = AuthController(FakeAuthService(stored: fakeSession(validFor: Duration.zero), failRefresh: true));
      await auth.restore();
      await expectLater(auth.accessToken(), throwsStateError);
      expect(auth.status, AuthStatus.signedOut);
      expect(auth.error, contains('expired'));
    });
  });

  group('api client', () {
    HttpApiClient client(MockClientHandler handler) =>
        HttpApiClient(baseUrl: 'http://api.test', accessToken: () async => 'token-123', client: MockClient(handler));

    test('sends the bearer token and parses the PoP', () async {
      late http.Request seen;
      final info = await client((request) async {
        seen = request;
        return http.Response(jsonEncode({'identity': 'SONIK-42', 'securityVersion': 1, 'pop': 'abc'}), 200);
      }).getProvisioningInfo('SONIK-42');

      expect(seen.url.toString(), 'http://api.test/api/admin/devices/SONIK-42/provisioning');
      expect(seen.headers['authorization'], 'Bearer token-123');
      expect(info.pop, 'abc');
    });

    test('explains unknown devices and missing permissions', () async {
      await expectLater(
        client((_) async => http.Response('{}', 404)).getProvisioningInfo('SONIK-9'),
        throwsA(isA<ApiException>().having((e) => e.message, 'message', contains('factory app'))),
      );
      await expectLater(
        client((_) async => http.Response('{}', 403)).getProvisioningInfo('SONIK-9'),
        throwsA(isA<ApiException>().having((e) => e.statusCode, 'statusCode', 403)),
      );
    });

    test('refuses a security scheme it cannot speak', () async {
      await expectLater(
        client((_) async => http.Response(jsonEncode({'identity': 'SONIK-42', 'securityVersion': 2, 'pop': 'abc'}), 200))
            .getProvisioningInfo('SONIK-42'),
        throwsA(isA<ApiException>()),
      );
    });
  });
}
