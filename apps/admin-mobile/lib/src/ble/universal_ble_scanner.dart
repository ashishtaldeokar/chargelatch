import 'dart:async';

import 'package:universal_ble/universal_ble.dart';

import 'ble_scanner.dart';
import 'universal_ble_transport.dart';

class UniversalBleScanner implements BleScanner {
  final _controller = StreamController<List<DiscoveredDevice>>.broadcast();
  final _seen = <String, DiscoveredDevice>{};
  StreamSubscription<BleDevice>? _subscription;

  @override
  Stream<List<DiscoveredDevice>> get devices => _controller.stream;

  @override
  Future<BleAvailability> prepare() async {
    try {
      // Android 12+: BLUETOOTH_SCAN/CONNECT. Older Android needs location for BLE scans.
      await UniversalBle.requestPermissions(withAndroidFineLocation: true);
    } catch (_) {
      return BleAvailability.unauthorized;
    }
    return switch (await UniversalBle.getBluetoothAvailabilityState()) {
      AvailabilityState.poweredOn => BleAvailability.ready,
      AvailabilityState.unauthorized => BleAvailability.unauthorized,
      AvailabilityState.unsupported => BleAvailability.unsupported,
      _ => BleAvailability.poweredOff,
    };
  }

  @override
  Future<void> start() async {
    await stop();
    _seen.clear();
    _controller.add(const []);
    _subscription = UniversalBle.scanStream.listen(_onDevice);
    // Only devices advertising the provisioning service: once a device has Wi-Fi credentials it
    // stops advertising it, so provisioned devices drop out of the list by themselves.
    await UniversalBle.startScan(scanFilter: ScanFilter(withServices: [provisioningServiceUuid]));
  }

  void _onDevice(BleDevice device) {
    final name = device.name;
    // The name travels in the scan response, which can arrive after the first advertisement.
    if (name == null || name.isEmpty) return;
    _seen[device.deviceId] = DiscoveredDevice(id: device.deviceId, name: name, rssi: device.rssi);
    final sorted = _seen.values.toList()..sort((a, b) => (b.rssi ?? -999).compareTo(a.rssi ?? -999));
    _controller.add(sorted);
  }

  @override
  Future<void> stop() async {
    await _subscription?.cancel();
    _subscription = null;
    try {
      await UniversalBle.stopScan();
    } catch (_) {
      // Stopping a scan that never started is fine.
    }
  }
}
