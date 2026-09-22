# EMQX (MQTT broker)

`emqx/emqx:6.3.1` with `emqx.conf` baked in and a `HEALTHCHECK`.

**Dev and e2e only.** Real devices connect to the project broker at
`mqtt://ashishtaldeokar.ddns.net:1883` (set in `apps/firmware/sdkconfig.defaults`). This image exists
so backend work and e2e tests have a broker of their own, and so a board on your desk can be pointed
at a broker you control.

> **Anonymous for now.** No authentication, no ACL, no TLS: any client that can reach port 1883 can
> publish and subscribe to anything, including as any device. Fine on a dev LAN, not deployable.
> Planned: per-device credentials flashed into the `fctry` partition, an ACL limiting a device to
> `devices/<identity>/#`, and TLS listeners. `apps/e2e/src/emqx.e2e.test.ts` asserts the current
> anonymous state on purpose, so tightening it is a visible, deliberate change.

## What is baked in, and why

- `authentication = []`, `authorization.no_match = allow`: anonymous, see above.
- TCP `1883` and WebSocket `8083` listeners on (the admin-web portal reads live device data over
  the WebSocket one, straight from the browser); **TLS listeners (`8883`, `8084`) off**, because the
  image only ships a public demo certificate.
- `mqtt.max_packet_size = 64KB`: devices send small JSON; bigger packets get the client dropped.
- `mqtt.session_expiry_interval = 2h`.
- Dashboard on `18083` with dev credentials `admin` / `chargelatch-dev`.
- `HEALTHCHECK`: `curl /status` on the dashboard port, which only says "running" once the broker
  accepts connections. Testcontainers under Bun needs `Wait.forHealthCheck()`.

EMQX config precedence is `base.hocon < cluster.hocon (dashboard/API changes) < emqx.conf < env`.
Because ours lives in `emqx.conf`, those keys are **read-only at runtime**: changing them in the
dashboard does not stick. Compose also gives EMQX **no volume**, so anything else changed in the
dashboard (rules, users, retained messages, sessions) is gone after a restart.

## Changing config

Edit `emqx.conf`, run `pnpm services:up` (it rebuilds), commit. To find a setting, try it in the
dashboard first, then copy it into `emqx.conf`; `etc/examples/` inside the image lists every key.

## Topics

| Topic                     | Publisher | Notes                                                         |
| ------------------------- | --------- | ------------------------------------------------------------- |
| `devices/<id>/status`     | device    | retained `{"online":true,"firmware":"…"}`; last will `{"online":false}` |
| `devices/<id>/cmd/relay`  | backend   | `{"on":true,"id":"…"}`, never retained                        |
| `devices/<id>/relay`      | device    | retained `{"on":true,"id":"…"}`: the actual contactor state   |
| `devices/<id>/meter`      | device    | energy meter reading every 5 s, see `components/meter_telemetry` |
| `devices/<id>/<subtopic>` | device    | anything else via `device_mqtt_publish()`                     |

`<id>` is the device identity (`SONIK-42`), also its MQTT client id.

Watch everything a device says: `docker compose exec emqx emqx ctl` is the broker CLI; for
messages use any MQTT client, e.g. `mosquitto_sub -h localhost -t 'devices/#' -v`.

## Pointing a dev board at it

By default firmware uses the project broker. To use this one, override the URI in
`idf.py menuconfig` → chargelatch MQTT with your machine's **LAN IP** (`mqtt://192.168.x.y:1883`):
a device is another host on your Wi-Fi, so `localhost` cannot work, and port 1883 must not be
firewalled. The override stays in your local `sdkconfig`. Do not `pnpm firmware:bundle` such a
build for the factory app unless you mean to.

## One image everywhere

- **Dev:** compose builds this directory as `chargelatch/emqx:dev`.
- **E2E:** `apps/e2e/src/helpers/emqx.ts` builds the same Dockerfile through Testcontainers
  (`chargelatch/emqx:e2e`).
- **Not production.** Devices use the separate project broker above. Licensing note should this
  ever change: EMQX 5.9+ (including 6.x) is under the Business Source License; a single node is
  free to run, clustering needs a license key.
