class WifiNetwork {
  const WifiNetwork({required this.ssid, required this.rssi, required this.secured});

  final String ssid;
  final int rssi;
  final bool secured;
}

sealed class WifiResult {
  const WifiResult();
}

class WifiConnected extends WifiResult {
  const WifiConnected(this.ipAddress);
  final String? ipAddress;
}

class WifiFailed extends WifiResult {
  const WifiFailed(this.message);
  final String message;
}

/// The device refused the proof-of-possession during the secure handshake.
class PopRejectedException implements Exception {
  const PopRejectedException();

  @override
  String toString() => 'The device rejected the proof-of-possession.';
}

class ProvisioningException implements Exception {
  const ProvisioningException(this.message);
  final String message;

  @override
  String toString() => message;
}

/// An open, encrypted provisioning session with one device.
abstract class ProvisioningSession {
  /// Networks as seen by the device itself, so signal strength is what the device will get.
  Future<List<WifiNetwork>> scanWifi();

  /// Sends the credentials and waits for the device to join the network.
  Future<WifiResult> connectToWifi({required String ssid, required String password});

  Future<void> close();
}

abstract class DeviceProvisioner {
  /// Connects over BLE and establishes the security 1 session using [pop].
  /// Throws [PopRejectedException] if the device does not accept it.
  Future<ProvisioningSession> open({required String deviceId, required String pop});
}
