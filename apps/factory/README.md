# factory

Browser-based flashing station. For each new ESP32 it reads the MAC over Web Serial, gets the
device's identity (`SONIK-<n>`) from the API (created on first sight, reused on re-flash), and
flashes the firmware together with an NVS partition carrying that identity.

```sh
pnpm services:up                                   # postgres + keycloak
source ~/esp/esp-idf/export.sh
pnpm firmware:build && pnpm firmware:bundle        # firmware -> public/firmware/
pnpm dev                                           # api :3000, factory :5174
```

Open <http://localhost:5174> in **Chrome or Edge** (Web Serial), sign in as
`factory@chargelatch.dev` / `factory`, plug in a board and press **Connect & flash device**.

- Requires the `factory` realm role; the API enforces it, the UI only mirrors it.
- "Erase entire flash first" (default on) wipes Wi-Fi credentials and any stale data on re-flash.
- Every region is MD5-verified by esptool after writing; the flash is only recorded in the
  backend after that succeeds.
- The port is fixed at 5174: it is a registered redirect URI of the `chargelatch-factory` client.
  Serving it from another origin means adding that origin to the client (and HTTPS: Web Serial
  needs a secure context, which only `localhost` gets for free).

`src/lib/esptool.ts` is the only file that touches hardware. The flow in `src/lib/workflow.ts`
runs against the `DeviceConnection` interface and is tested with fakes (`pnpm test:unit`).
