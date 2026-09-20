import 'package:admin_mobile/src/app.dart';
import 'package:admin_mobile/src/ble/ble_scanner.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fakes.dart';

/// The scan screen shows an indeterminate progress bar while scanning, so pumpAndSettle would
/// never return. Pump enough frames for futures, rebuilds and route transitions instead.
Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 8; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  testWidgets('signing in as an admin leads to the nearby devices list', (tester) async {
    await tester.pumpWidget(AdminApp(services: fakeServices(auth: FakeAuthService())));
    await settle(tester);

    expect(find.text('Sign in to pair devices with Wi-Fi.'), findsOneWidget);
    await tester.tap(find.text('Sign in'));
    await settle(tester);

    expect(find.text('Nearby devices'), findsOneWidget);
    expect(find.text('SONIK-42'), findsOneWidget);
    expect(find.text('Ready to set up'), findsOneWidget);
    expect(find.text('Development board (not factory flashed)'), findsOneWidget);
  });

  testWidgets('a stored session skips the login screen', (tester) async {
    await tester.pumpWidget(AdminApp(services: fakeServices()));
    await settle(tester);
    expect(find.text('Nearby devices'), findsOneWidget);
  });

  testWidgets('an account without the admin role is turned away', (tester) async {
    final auth = FakeAuthService(stored: fakeSession(roles: ['user'], email: 'user@chargelatch.dev'));
    await tester.pumpWidget(AdminApp(services: fakeServices(auth: auth)));
    await settle(tester);

    expect(find.textContaining('user@chargelatch.dev does not have the "admin" role'), findsOneWidget);
    expect(find.text('Nearby devices'), findsNothing);

    await tester.tap(find.text('Sign out'));
    await settle(tester);
    expect(auth.signedOut, isTrue);
    expect(find.text('Sign in'), findsOneWidget);
  });

  testWidgets('explains when bluetooth is off', (tester) async {
    await tester.pumpWidget(AdminApp(services: fakeServices(scanner: FakeBleScanner(availability: BleAvailability.poweredOff))));
    await settle(tester);
    expect(find.text('Bluetooth is off'), findsOneWidget);
  });

  testWidgets('provisions a factory device with the PoP fetched from the backend', (tester) async {
    final api = FakeApiClient();
    final provisioner = FakeProvisioner(acceptedPop: 'secret-pop-42');
    final scanner = FakeBleScanner(found: const [factoryDevice]);
    await tester.pumpWidget(AdminApp(services: fakeServices(api: api, provisioner: provisioner, scanner: scanner)));
    await settle(tester);

    await tester.tap(find.text('SONIK-42'));
    await settle(tester);

    // Looked up by its BLE name, and the session opened with the secret the API returned.
    expect(api.requested, ['SONIK-42']);
    expect(provisioner.opened, [(factoryDevice.id, 'secret-pop-42')]);
    expect(scanner.stops, greaterThan(0), reason: 'the BLE scan must stop before connecting');

    // Networks as scanned by the device.
    expect(find.text('Workshop'), findsOneWidget);
    await tester.tap(find.text('Workshop'));
    await settle(tester);

    // A wrong password keeps the form open with the reason.
    await tester.enterText(find.byType(TextField), 'wrong');
    await tester.tap(find.text('Connect device'));
    await settle(tester);
    expect(find.text('Wrong Wi-Fi password.'), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'hunter22');
    await tester.tap(find.text('Connect device'));
    await settle(tester);

    expect(find.text('SONIK-42 is online'), findsOneWidget);
    expect(find.textContaining('192.168.1.50'), findsOneWidget);
    expect(provisioner.session.attempts, [('Workshop', 'wrong'), ('Workshop', 'hunter22')]);

    // Back on the list the scan restarts, and the BLE session was released.
    await tester.tap(find.text('Done'));
    await settle(tester);
    expect(find.text('Nearby devices'), findsOneWidget);
    expect(provisioner.session.closed, isTrue);
    expect(scanner.starts, 2);
  });

  testWidgets('open networks need no password, and hidden ones can be typed', (tester) async {
    final provisioner = FakeProvisioner(
      acceptedPop: 'secret-pop-42',
      session: FakeSession(networks: const [], correctPassword: ''),
    );
    await tester.pumpWidget(AdminApp(services: fakeServices(provisioner: provisioner)));
    await settle(tester);
    await tester.tap(find.text('SONIK-42'));
    await settle(tester);

    expect(find.textContaining('found no networks'), findsOneWidget);
    await tester.tap(find.text('Other network…'));
    await settle(tester);
    await tester.enterText(find.widgetWithText(TextField, 'Network name (SSID)'), 'HiddenNet');
    await tester.tap(find.text('Connect device'));
    await settle(tester);

    expect(provisioner.session.attempts, [('HiddenNet', '')]);
    expect(find.text('SONIK-42 is online'), findsOneWidget);
  });

  testWidgets('a rejected PoP is reported instead of looping', (tester) async {
    final provisioner = FakeProvisioner(acceptedPop: 'something-else');
    await tester.pumpWidget(AdminApp(services: fakeServices(provisioner: provisioner)));
    await settle(tester);
    await tester.tap(find.text('SONIK-42'));
    await settle(tester);

    expect(find.text('Could not set up this device'), findsOneWidget);
    expect(find.textContaining('rejected its proof-of-possession'), findsOneWidget);
  });

  testWidgets('a device the backend does not know is explained', (tester) async {
    await tester.pumpWidget(AdminApp(services: fakeServices(api: FakeApiClient(pops: const {}))));
    await settle(tester);
    await tester.tap(find.text('SONIK-42'));
    await settle(tester);
    expect(find.textContaining('flashed through the factory app first'), findsOneWidget);
  });

  testWidgets('a development board asks for its PoP instead of calling the backend', (tester) async {
    final api = FakeApiClient();
    final provisioner = FakeProvisioner(acceptedPop: 'abcd1234');
    await tester.pumpWidget(AdminApp(services: fakeServices(api: api, provisioner: provisioner)));
    await settle(tester);
    await tester.tap(find.text('PROV_A1B2C3'));
    await settle(tester);

    expect(api.requested, isEmpty);
    await tester.enterText(find.widgetWithText(TextField, 'Proof-of-possession'), 'abcd1234');
    await tester.tap(find.text('Connect'));
    await settle(tester);

    expect(provisioner.opened, [(devBoard.id, 'abcd1234')]);
    expect(find.text('Workshop'), findsOneWidget);
  });
}
