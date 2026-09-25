/*
 * Wi-Fi provisioning for chargelatch firmware.
 *
 * Wraps the ESP-IDF Wi-Fi provisioning manager: if the device has no stored Wi-Fi
 * credentials it starts the provisioning service (BLE or SoftAP, see menuconfig ->
 * Component config -> chargelatch Wi-Fi provisioning), otherwise it connects as a station.
 *
 * Fallback (CONFIG_PROVISIONING_FALLBACK): a provisioned device that cannot reach its network
 * for N minutes re-opens BLE provisioning for N minutes, then goes back to the stored
 * credentials, alternating until one of them works. The stored credentials are only replaced
 * when new ones actually connect.
 */
#pragma once

#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    /**
     * BLE device name (or SoftAP SSID) advertised while unprovisioned, at most 29 bytes.
     * NULL: "PROV_" + the last three MAC bytes.
     */
    const char *service_name;
    /**
     * Proof-of-possession for security 1. The admin app must present the same value.
     * NULL: CONFIG_PROVISIONING_PROV_DEV_POP, a shared development secret.
     * Ignored with security 2.
     */
    const char *pop;
} provisioning_config_t;

/**
 * Brings up everything Wi-Fi needs and starts provisioning or the station.
 *
 * Initializes NVS, esp_netif, the default event loop and the Wi-Fi driver (each is tolerated
 * if the application already initialized it), then returns immediately. Provisioning and
 * reconnection continue in the background on the default event loop.
 *
 * @param config  may be NULL for all defaults. The strings are copied.
 */
esp_err_t provisioning_start(const provisioning_config_t *config);

/**
 * Blocks until the station has an IP address.
 *
 * @param timeout_ms  maximum time to wait, or PROVISIONING_WAIT_FOREVER
 * @return ESP_OK once connected, ESP_ERR_TIMEOUT otherwise,
 *         ESP_ERR_INVALID_STATE if provisioning_start() was not called
 */
esp_err_t provisioning_wait_for_connection(uint32_t timeout_ms);

#define PROVISIONING_WAIT_FOREVER UINT32_MAX

/**
 * Re-opens the provisioning service so new credentials can be sent to an already provisioned
 * device. Requires CONFIG_PROVISIONING_REPROVISIONING; follow it with
 * provisioning_wait_for_connection().
 */
esp_err_t provisioning_restart(void);

#ifdef __cplusplus
}
#endif
