# meter_telemetry

Background task: every `CONFIG_METER_TELEMETRY_INTERVAL_SECONDS` (default 5) it reads the meter
(`sdm_meter`) and publishes to **`devices/<device id>/meter`** (QoS 0, not retained):

```json
{"model":"SDM120","phases":1,"ok":true,"voltage":230.500,"current":1.250,"power":287.100,
 "apparent_power":288.000,"reactive_power":-12.300,"power_factor":0.997,"phase_angle":-4.100,
 "frequency":50.020,"import_energy":1234.750,"export_energy":0.000,
 "import_reactive_energy":12.100,"export_reactive_energy":3.400,
 "total_energy":1234.750,"total_reactive_energy":15.500}
```

Units: V, A, W, VA, VAr, degrees, Hz, kWh, kVArh. A 3-phase meter adds `voltage_l1..l3`,
`current_l1..l3`, `power_l1..l3`, `power_factor_l1..l3`; the unsuffixed keys are then the totals.

When the meter cannot be read: `{"model":"SDM120","phases":1,"ok":false,"error":"timeout"}`
(`timeout`, `crc`, `exception`, …). If only some requests failed, `ok` is false and the values that
were read are still included. This is separate from `devices/<id>/status`, which says whether the
*device* is online.

There is no timestamp: the device has no clock source yet (no SNTP), so stamp on receipt.
Readings taken while MQTT is down are dropped rather than queued.
