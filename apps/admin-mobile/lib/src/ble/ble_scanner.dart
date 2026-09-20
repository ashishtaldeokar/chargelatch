/// A chargelatch device advertising the Wi-Fi provisioning service.
class DiscoveredDevice {
  const DiscoveredDevice({required this.id, required this.name, this.rssi});

  /// Platform BLE id (MAC address on Android, a per-phone UUID on iOS).
  final String id;

  /// Advertised name. Factory-flashed devices advertise their identity, e.g. `SONIK-42`.
  final String name;
  final int? rssi;

  static final _identityPattern = RegExp(r'^[A-Z]+-\d+$');

  /// The backend identity, or null for a board that did not go through the factory app
  /// (those advertise as `PROV_XXXXXX` and use the shared development PoP).
  String? get identity => _identityPattern.hasMatch(name) ? name : null;
}

enum BleAvailability { ready, poweredOff, unauthorized, unsupported }

abstract class BleScanner {
  /// Asks for the runtime permissions scanning needs and reports whether Bluetooth is usable.
  Future<BleAvailability> prepare();

  /// Emits the devices seen so far, strongest signal first, every time the list changes.
  Stream<List<DiscoveredDevice>> get devices;

  Future<void> start();
  Future<void> stop();
}
