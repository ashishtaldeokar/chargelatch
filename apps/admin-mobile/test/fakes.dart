import 'dart:async';
import 'dart:convert';

import 'package:admin_mobile/src/api/api_client.dart';
import 'package:admin_mobile/src/app.dart';
import 'package:admin_mobile/src/auth/auth_controller.dart';
import 'package:admin_mobile/src/auth/auth_service.dart';
import 'package:admin_mobile/src/ble/ble_scanner.dart';
import 'package:admin_mobile/src/provisioning/provisioner.dart';

/// An unsigned JWT carrying the given realm roles, shaped like a Keycloak access token.
String fakeJwt({required List<String> roles, String email = 'admin@chargelatch.dev'}) {
  String part(Map<String, dynamic> json) => base64Url.encode(utf8.encode(jsonEncode(json))).replaceAll('=', '');
  return '${part({'alg': 'none'})}.${part({'email': email, 'realm_access': {'roles': roles}})}.sig';
}

AuthSession fakeSession({List<String> roles = const ['admin', 'user'], String email = 'admin@chargelatch.dev', Duration validFor = const Duration(minutes: 5)}) =>
    AuthSession(accessToken: fakeJwt(roles: roles, email: email), expiresAt: DateTime.now().add(validFor), refreshToken: 'refresh', idToken: 'id');

class FakeAuthService implements AuthService {
  FakeAuthService({this.stored, AuthSession? onSignIn, this.failRefresh = false}) : onSignIn = onSignIn ?? fakeSession();

  AuthSession? stored;
  AuthSession onSignIn;
  bool failRefresh;
  int refreshes = 0;
  bool signedOut = false;

  @override
  Future<AuthSession?> restore() async => stored;

  @override
  Future<AuthSession> signIn() async => onSignIn;

  @override
  Future<AuthSession> refresh(AuthSession session) async {
    refreshes++;
    if (failRefresh) throw StateError('refresh token expired');
    return fakeSession();
  }

  @override
  Future<void> signOut(AuthSession session) async => signedOut = true;
}

class FakeApiClient implements ApiClient {
  FakeApiClient({this.pops = const {'SONIK-42': 'secret-pop-42'}});

  final Map<String, String> pops;
  final requested = <String>[];

  @override
  Future<ProvisioningInfo> getProvisioningInfo(String identity) async {
    requested.add(identity);
    final pop = pops[identity];
    if (pop == null) throw ApiException('$identity is not registered. It has to be flashed through the factory app first.', statusCode: 404);
    return ProvisioningInfo(identity: identity, pop: pop);
  }
}

class FakeBleScanner implements BleScanner {
  FakeBleScanner({this.found = const [], this.availability = BleAvailability.ready});

  final List<DiscoveredDevice> found;
  final BleAvailability availability;
  final _controller = StreamController<List<DiscoveredDevice>>.broadcast();
  int starts = 0;
  int stops = 0;

  @override
  Stream<List<DiscoveredDevice>> get devices => _controller.stream;

  @override
  Future<BleAvailability> prepare() async => availability;

  @override
  Future<void> start() async {
    starts++;
    _controller.add(found);
  }

  @override
  Future<void> stop() async => stops++;
}

class FakeSession implements ProvisioningSession {
  FakeSession({required this.networks, required this.correctPassword});

  final List<WifiNetwork> networks;
  final String correctPassword;
  final attempts = <(String, String)>[];
  bool closed = false;

  @override
  Future<List<WifiNetwork>> scanWifi() async => networks;

  @override
  Future<WifiResult> connectToWifi({required String ssid, required String password}) async {
    attempts.add((ssid, password));
    return password == correctPassword ? const WifiConnected('192.168.1.50') : const WifiFailed('Wrong Wi-Fi password.');
  }

  @override
  Future<void> close() async => closed = true;
}

class FakeProvisioner implements DeviceProvisioner {
  FakeProvisioner({required this.acceptedPop, FakeSession? session})
      : session = session ??
            FakeSession(
              networks: const [WifiNetwork(ssid: 'Workshop', rssi: -48, secured: true), WifiNetwork(ssid: 'Guest', rssi: -70, secured: false)],
              correctPassword: 'hunter22',
            );

  final String acceptedPop;
  final FakeSession session;
  final opened = <(String, String)>[];

  @override
  Future<ProvisioningSession> open({required String deviceId, required String pop}) async {
    opened.add((deviceId, pop));
    if (pop != acceptedPop) throw const PopRejectedException();
    return session;
  }
}

const factoryDevice = DiscoveredDevice(id: 'AA:BB:CC:DD:EE:01', name: 'SONIK-42', rssi: -52);
const devBoard = DiscoveredDevice(id: 'AA:BB:CC:DD:EE:02', name: 'PROV_A1B2C3', rssi: -60);

AppServices fakeServices({FakeAuthService? auth, FakeApiClient? api, FakeBleScanner? scanner, FakeProvisioner? provisioner}) => AppServices(
      auth: AuthController(auth ?? FakeAuthService(stored: fakeSession())),
      api: api ?? FakeApiClient(),
      scanner: scanner ?? FakeBleScanner(found: const [factoryDevice, devBoard]),
      provisioner: provisioner ?? FakeProvisioner(acceptedPop: 'secret-pop-42'),
    );
