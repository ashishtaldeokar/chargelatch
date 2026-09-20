#include <string.h>

#include "esp_log.h"
#include "device_identity.h"
#include "device_mqtt.h"
#include "meter_telemetry.h"
#include "provisioning.h"
#include "relay_control.h"
#include "relay_remote.h"

static const char *TAG = "app";

static void on_command(const char *command, const char *payload, size_t payload_len)
{
    if (strcmp(command, RELAY_REMOTE_COMMAND) == 0) {
        relay_remote_handle_command(payload, payload_len);
    } else {
        ESP_LOGW(TAG, "unknown command \"%s\"", command);
    }
}

void app_main(void)
{
    /* First, and before anything that can block: puts the contactor back in its last state
     * within milliseconds of boot, whether or not Wi-Fi ever comes up. */
    if (relay_control_init() != ESP_OK) {
        ESP_LOGE(TAG, "relay not initialised");
    }

    if (device_identity_init() != ESP_OK) {
        ESP_LOGW(TAG, "running without a factory identity");
    }

    /* Advertise as the factory identity ("SONIK-42") and secure provisioning with the per-device
     * PoP, so the admin app can look the device up by name. Both are NULL on a board that did not
     * go through the factory app, which falls back to PROV_<mac> and the development PoP. */
    const provisioning_config_t provisioning = {
        .service_name = device_identity_get(),
        .pop = device_identity_get_pop(),
    };
    ESP_ERROR_CHECK(provisioning_start(&provisioning));
    ESP_ERROR_CHECK(provisioning_wait_for_connection(PROVISIONING_WAIT_FOREVER));
    ESP_LOGI(TAG, "Wi-Fi connected");

    /* Not fatal: a device without a reachable broker must still run. */
    const device_mqtt_config_t mqtt = {
        .device_id = device_identity_get(),
        .on_command = on_command,
        .on_connected = relay_remote_publish_state,
    };
    if (device_mqtt_start(&mqtt) != ESP_OK) {
        ESP_LOGW(TAG, "MQTT not started");
    }

    /* Energy meter on RS-485 -> devices/<id>/meter every few seconds. */
    if (meter_telemetry_start() != ESP_OK) {
        ESP_LOGW(TAG, "meter telemetry not started");
    }
}
