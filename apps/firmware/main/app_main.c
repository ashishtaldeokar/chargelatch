#include <string.h>

#include "esp_log.h"
#include "charging_session.h"
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
    } else if (strcmp(command, CHARGING_SESSION_COMMAND) == 0) {
        charging_session_handle_command(payload, payload_len);
    } else {
        ESP_LOGW(TAG, "unknown command \"%s\"", command);
    }
}

static void on_mqtt_connected(void)
{
    relay_remote_publish_state();
    charging_session_publish_state();
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
        .on_connected = on_mqtt_connected,
    };
    if (device_mqtt_start(&mqtt) != ESP_OK) {
        ESP_LOGW(TAG, "MQTT not started");
    }

    /* Energy meter on RS-485 -> devices/<id>/meter every few seconds. Which meter, and how
     * to talk to it, was chosen at the factory; a board without factory data uses the
     * Kconfig defaults. */
    const device_meter_config_t *factory_meter = device_identity_get_meter();
    const sdm_meter_config_t meter = {
        .model = factory_meter->model,
        .address = factory_meter->address,
        .baud = factory_meter->baud,
        .parity = sdm_parity_from_string(factory_meter->parity),
    };
    if (meter_telemetry_start(&meter) != ESP_OK) {
        ESP_LOGW(TAG, "meter telemetry not started");
    }

    /* Charging transactions (after the meter, whose model it needs; before MQTT delivers commands
     * it may have missed nothing: commands are never retained). */
    if (charging_session_init() != ESP_OK) {
        ESP_LOGE(TAG, "charging session not initialised");
    }
}
