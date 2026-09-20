
import 'package:esp_provisioning_ble/esp_provisioning_ble.dart';
import 'package:flutter/foundation.dart';
import 'package:universal_ble/universal_ble.dart';

/// 128-bit UUID of the provisioning GATT service. Must equal `custom_service_uuid` in the
/// firmware's provisioning component (written there LSB first).
const provisioningServiceUuid = '021a9004-0382-4aea-bff4-6b3f1c5adfb4';

/// ESP-IDF derives each endpoint's characteristic UUID from the service UUID by replacing its
/// bytes 2-3 with a 16-bit id (wifi_provisioning/src/manager.c). Application endpoints are
/// numbered from 0xff54 in creation order; the firmware creates exactly one, "custom-data".
const provisioningEndpointIds = <String, int>{
  'prov-scan': 0xff50,
  'prov-session': 0xff51,
  'prov-config': 0xff52,
  'proto-ver': 0xff53,
  'custom-data': 0xff54,
};

String endpointCharacteristicUuid(String endpoint, {String serviceUuid = provisioningServiceUuid}) {
  final id = provisioningEndpointIds[endpoint];
  if (id == null) throw ArgumentError.value(endpoint, 'endpoint', 'Unknown provisioning endpoint');
  return serviceUuid.substring(0, 4) + id.toRadixString(16).padLeft(4, '0') + serviceUuid.substring(8);
}

/// The ESP provisioning protocol (protocomm) over BLE: each request is a GATT write to the
/// endpoint's characteristic, and the response is then read back from the same characteristic.
class UniversalBleTransport implements ProvTransport {
  UniversalBleTransport(this.deviceId);

  final String deviceId;

  static const _timeout = Duration(seconds: 20);

  @override
  Future<bool> connect() async {
    await UniversalBle.connect(deviceId, timeout: _timeout);
    try {
      // Session and Wi-Fi scan responses exceed the default 23 byte MTU. iOS negotiates its own.
      await UniversalBle.requestMtu(deviceId, 512);
    } catch (e) {
      debugPrint('MTU request failed, continuing with the default: $e');
    }
    final services = await UniversalBle.discoverServices(deviceId, timeout: _timeout);
    final hasProvisioning = services.any((s) => BleUuidParser.compareStrings(s.uuid, provisioningServiceUuid));
    if (!hasProvisioning) {
      await disconnect();
      throw StateError('This device does not expose the provisioning service.');
    }
    return true;
  }

  @override
  Future<bool> checkConnect() async =>
      await UniversalBle.getConnectionState(deviceId) == BleConnectionState.connected;

  @override
  Future<bool> disconnect() async {
    try {
      await UniversalBle.disconnect(deviceId);
      return true;
    } catch (e) {
      debugPrint('disconnect failed: $e');
      return false;
    }
  }

  @override
  Future<Uint8List> sendReceive(String epName, Uint8List data) async {
    final characteristic = endpointCharacteristicUuid(epName);
    if (data.isNotEmpty) {
      await UniversalBle.write(deviceId, provisioningServiceUuid, characteristic, data, timeout: _timeout);
    }
    return UniversalBle.read(deviceId, provisioningServiceUuid, characteristic, timeout: _timeout);
  }
}
