import 'package:esp_provisioning_ble/esp_provisioning_ble.dart';

import '../ble/universal_ble_transport.dart';
import 'provisioner.dart';

/// [DeviceProvisioner] on top of esp_provisioning_ble (protocol + security 1 crypto) with
/// universal_ble as the BLE transport.
class EspProvisioner implements DeviceProvisioner {
  @override
  Future<ProvisioningSession> open({required String deviceId, required String pop}) async {
    final prov = EspProv(transport: UniversalBleTransport(deviceId), security: Security1(pop: pop));
    try {
      await prov.transport.connect();
    } catch (e) {
      throw ProvisioningException('Could not connect to the device over Bluetooth. Move closer and try again.');
    }

    final status = await prov.establishSession();
    switch (status) {
      case EstablishSessionStatus.connected:
        return _EspSession(prov);
      case EstablishSessionStatus.keymismatch:
        await prov.dispose();
        throw const PopRejectedException();
      case EstablishSessionStatus.disconnected:
        await prov.dispose();
        throw const ProvisioningException('The device disconnected while securing the session.');
    }
  }
}

class _EspSession implements ProvisioningSession {
  _EspSession(this._prov);

  final EspProv _prov;

  // The firmware retries a failing network a few times before it reports the failure.
  static const _pollInterval = Duration(seconds: 2);
  static const _maxPolls = 30;

  @override
  Future<List<WifiNetwork>> scanWifi() async {
    final found = await _prov.startScanWiFi();
    // The device reports one entry per access point: keep the strongest per SSID.
    final strongest = <String, WifiNetwork>{};
    for (final ap in found) {
      if (ap.ssid.isEmpty) continue;
      final current = strongest[ap.ssid];
      if (current == null || ap.rssi > current.rssi) {
        strongest[ap.ssid] = WifiNetwork(ssid: ap.ssid, rssi: ap.rssi, secured: ap.private);
      }
    }
    return strongest.values.toList()..sort((a, b) => b.rssi.compareTo(a.rssi));
  }

  @override
  Future<WifiResult> connectToWifi({required String ssid, required String password}) async {
    if (!await _prov.sendWifiConfig(ssid: ssid, password: password)) {
      return const WifiFailed('The device did not accept the Wi-Fi credentials.');
    }
    if (!await _prov.applyWifiConfig()) {
      return const WifiFailed('The device could not apply the Wi-Fi credentials.');
    }

    for (var i = 0; i < _maxPolls; i++) {
      await Future<void>.delayed(_pollInterval);
      final ConnectionStatus status;
      try {
        status = await _prov.getStatus();
      } catch (_) {
        // Once connected, the firmware ends provisioning and shuts Bluetooth down, so losing
        // the link right after applying credentials means it worked.
        if (!await _prov.transport.checkConnect()) return const WifiConnected(null);
        rethrow;
      }
      switch (status.state) {
        case WifiConnectionState.Connected:
          return WifiConnected(status.deviceIp);
        case WifiConnectionState.ConnectionFailed:
          return WifiFailed(switch (status.failedReason) {
            WifiConnectFailedReason.AuthError => 'Wrong Wi-Fi password.',
            WifiConnectFailedReason.NetworkNotFound => 'The device could not find that network.',
            null => 'The device could not join the network.',
          });
        case WifiConnectionState.Connecting:
        case WifiConnectionState.Disconnected:
          continue;
      }
    }
    return const WifiFailed('Timed out waiting for the device to join the network.');
  }

  @override
  Future<void> close() => _prov.dispose();
}
