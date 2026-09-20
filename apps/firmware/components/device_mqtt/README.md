# device_mqtt

Connects the device to the chargelatch MQTT broker once Wi-Fi is up.

```c
static void on_command(const char *command, const char *payload, size_t len) { /* devices/<id>/cmd/<command> */ }

const device_mqtt_config_t mqtt = { .device_id = device_identity_get(), .on_command = on_command };
device_mqtt_start(&mqtt);                                   // non-blocking, reconnects forever
device_mqtt_publish("telemetry", "{\"kw\":7.4}", 1, false); // -> devices/SONIK-42/telemetry
```

| Topic                       | Direction | Notes                                                                 |
| --------------------------- | --------- | --------------------------------------------------------------------- |
| `devices/<id>/status`       | device →  | retained. `{"online":true,"firmware":"…"}` on connect; `{"online":false}` is the **last will**, published by the broker when the device disappears |
| `devices/<id>/cmd/#`        | → device  | delivered to `on_command` (whole, small messages only); `cmd/relay` is handled by `relay_control` |
| `devices/<id>/relay`        | device →  | retained contactor state, published by `relay_control`                |
| `devices/<id>/meter`        | device →  | energy meter readings, published by `meter_telemetry`                 |
| `devices/<id>/<subtopic>`   | device →  | `device_mqtt_publish()`                                               |

`<id>` is the factory identity (`SONIK-42`), or `DEV-<mac>` on a board without factory data.

## Broker address

`CONFIG_DEVICE_MQTT_BROKER_URI`, set in `sdkconfig.defaults` to the project broker
`mqtt://ashishtaldeokar.ddns.net:1883`.

The EMQX in `docker-compose.yml` is for dev/e2e. To point a board at it, override the URI in
`idf.py menuconfig` → **chargelatch MQTT** with your machine's **LAN IP**
(`mqtt://192.168.x.y:1883`; the device is another host on the Wi-Fi, so `localhost` cannot work).
That override lives in your local `sdkconfig`.

The firmware the factory app flashes is whatever was built and bundled, so check the URI of
the build before `pnpm firmware:bundle`.

## Not done yet

The broker is **anonymous** and unencrypted: the client id is not a credential, anyone on the
network can publish as any device. Planned: per-device credentials in the `fctry` partition,
a per-device topic ACL, and `mqtts://`.
