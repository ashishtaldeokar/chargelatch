/*
 * The device's connection to the chargelatch MQTT broker (EMQX).
 *
 * Topics, all under devices/<device id>/ :
 *   status      retained JSON. {"online":true,"firmware":"0.1.0"} on connect; the broker publishes
 *               {"online":false} as last will when the device drops off.
 *   cmd/#       subscribed; delivered to the command handler.
 *   <anything>  via device_mqtt_publish(), e.g. "telemetry".
 *
 * The broker is anonymous for now: the device id is only the MQTT client id, not a credential.
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Called on the MQTT task for every message under devices/<id>/cmd/. `command` is the part of the
 * topic after "cmd/" and is NUL-terminated; `payload` is NOT, use `payload_len`. Both are only
 * valid during the call.
 */
typedef void (*device_mqtt_command_handler_t)(const char *command, const char *payload, size_t payload_len);

typedef struct {
    /** MQTT client id and topic prefix, normally the factory identity ("SONIK-42").
     *  NULL: "DEV-" + the last three MAC bytes, for boards without factory data. */
    const char *device_id;
    /** May be NULL. */
    device_mqtt_command_handler_t on_command;
    /** Called on the MQTT task after every (re)connect, once subscriptions are in place: the place to
     *  republish retained state. May be NULL. */
    void (*on_connected)(void);
} device_mqtt_config_t;

/**
 * Starts the client. Call once Wi-Fi is connected. Returns immediately; connecting, reconnecting
 * with backoff and resubscribing all happen in the background for the lifetime of the program.
 *
 * @return ESP_ERR_INVALID_STATE if CONFIG_DEVICE_MQTT_BROKER_URI is empty or the client is
 *         already running.
 */
esp_err_t device_mqtt_start(const device_mqtt_config_t *config);

bool device_mqtt_is_connected(void);

/**
 * Publishes to devices/<id>/<subtopic>. `payload` is a NUL-terminated string.
 * With qos > 0 the message is queued while offline and sent after reconnecting.
 *
 * @return ESP_ERR_INVALID_STATE before device_mqtt_start(), ESP_FAIL if it could not be queued.
 */
esp_err_t device_mqtt_publish(const char *subtopic, const char *payload, int qos, bool retain);

#ifdef __cplusplus
}
#endif
