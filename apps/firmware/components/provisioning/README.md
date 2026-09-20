# provisioning

Local project component that owns Wi-Fi provisioning, so `main/` stays free of it. Derived from
the ESP-IDF `wifi_prov_mgr` example.

```c
#include "provisioning.h"

void app_main(void)
{
    const provisioning_config_t config = {
        .service_name = device_identity_get(),      // BLE name, NULL -> "PROV_<mac>"
        .pop = device_identity_get_pop(),           // security 1 PoP, NULL -> shared dev PoP
    };
    ESP_ERROR_CHECK(provisioning_start(&config));                                  // non-blocking
    ESP_ERROR_CHECK(provisioning_wait_for_connection(PROVISIONING_WAIT_FOREVER)); // until got IP
}
```

- `provisioning_start(config)` initializes NVS, esp_netif, the default event loop and Wi-Fi (tolerating
  ones the app already initialized). Unprovisioned devices start the provisioning service;
  provisioned ones connect as a station. Reconnects are automatic.
- `provisioning_wait_for_connection(timeout_ms)` returns `ESP_OK` or `ESP_ERR_TIMEOUT`.
- `provisioning_restart()` re-opens provisioning on a provisioned device
  (needs `CONFIG_PROVISIONING_REPROVISIONING`).

Configure under `idf.py menuconfig` → Component config → **chargelatch Wi-Fi provisioning**
(transport BLE/SoftAP, security version 1/2, retries). Symbols are `CONFIG_PROVISIONING_*`.

This is a *local* component (`components/`, committed) with no external dependencies. If one is
ever needed, declare it in an `idf_component.yml` here: it is then downloaded into
`managed_components/` (gitignored, never edit) and pinned by `dependencies.lock` (commit it).

## Security

Security **version 1** (X25519 + proof-of-possession) is the default because the admin mobile
app's `esp_provisioning_ble` library does not implement version 2. `main` passes the per-device
PoP from the factory partition, and the device advertises its identity so the app can fetch that
PoP from the backend.

Without factory data the component falls back to `PROV_<mac>` and
`CONFIG_PROVISIONING_PROV_DEV_POP` (`abcd1234`), logging a warning. That PoP is public: a deployed
device must always have factory data.

Security 2 still compiles (`sdkconfig.ci.security2`) but only in dev mode with a hard-coded
salt/verifier; the production mode is a stub.
