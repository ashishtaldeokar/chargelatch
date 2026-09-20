# admin-mobile

Flutter app (Android + iOS) for admins to pair chargelatch devices with Wi-Fi over BLE.

1. **Sign in** with Keycloak (system browser, PKCE, client `chargelatch-admin-mobile`). The account
   needs the `admin` realm role.
2. **Scan**: lists nearby devices advertising the provisioning service. Factory-flashed devices
   show up under their identity (`SONIK-42`); devices already on Wi-Fi do not advertise.
3. **Provision**: the app fetches that device's proof-of-possession from the API, opens an
   encrypted session (ESP-IDF provisioning, security 1), lets the device scan for networks, sends
   the credentials and waits until the device reports it is online.

Libraries: `esp_provisioning_ble` (protocol + crypto) over `universal_ble` (BLE transport).

## Running against the local stack

BLE needs a physical phone. On Android:

```sh
pnpm services:up && pnpm dev                       # keycloak :8080, api :3000
adb reverse tcp:3000 tcp:3000 && adb reverse tcp:8080 tcp:8080
pnpm admin-mobile                                  # flutter run
```

Sign in as `admin@chargelatch.dev` / `admin`. `adb reverse` makes `localhost` on the phone reach
your machine, which also keeps the token issuer identical to what the API expects. For iOS or a
remote stack pass `--dart-define=API_URL=... --dart-define=KEYCLOAK_URL=...`.

A board flashed with `idf.py` instead of the factory app advertises as `PROV_XXXXXX`; the app then
asks for the PoP, which is the firmware's development default `abcd1234`.

## Tests

`pnpm test:unit` (or `flutter test`). Auth, API, BLE scanning and provisioning are interfaces, and
the widget tests drive the full sign-in → scan → provision flow against fakes in `test/fakes.dart`.
