#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "esp_log.h"

#include "device_mqtt.h"
#include "relay_control.h"
#include "relay_remote.h"

static const char *TAG = "relay_remote";

#define REQUEST_ID_MAX_LEN 40 /* a UUID is 36 */

/* The id of the command that produced the current state; echoed in every state message. */
static char s_request_id[REQUEST_ID_MAX_LEN];
static relay_remote_guard_t s_guard;
static const char *s_rejected;    /* reason the last command was refused, echoed once */

static bool is_safe_id(const char *id)
{
    const size_t len = strlen(id);
    if (len == 0 || len >= REQUEST_ID_MAX_LEN) {
        return false;
    }
    /* It is pasted into a JSON string below, so nothing that would need escaping. */
    for (size_t i = 0; i < len; i++) {
        const char c = id[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '-' || c == '_')) {
            return false;
        }
    }
    return true;
}

void relay_remote_set_guard(relay_remote_guard_t guard)
{
    s_guard = guard;
}

void relay_remote_publish_state(void)
{
    char payload[128];
    const char *on = relay_control_is_on() ? "true" : "false";
    if (s_rejected) {
        snprintf(payload, sizeof(payload), "{\"on\":%s,\"id\":\"%s\",\"rejected\":\"%s\"}", on, s_request_id, s_rejected);
        s_rejected = NULL;
    } else if (s_request_id[0]) {
        snprintf(payload, sizeof(payload), "{\"on\":%s,\"id\":\"%s\"}", on, s_request_id);
    } else {
        snprintf(payload, sizeof(payload), "{\"on\":%s}", on);
    }
    /* Retained + QoS 1: whoever subscribes later still learns the real state. */
    device_mqtt_publish(RELAY_REMOTE_SUBTOPIC, payload, 1, true);
}

void relay_remote_handle_command(const char *payload, size_t payload_len)
{
    bool on;
    bool force = false;
    char id[REQUEST_ID_MAX_LEN] = "";

    if (payload_len == 2 && strncmp(payload, "on", 2) == 0) {
        on = true;
    } else if (payload_len == 3 && strncmp(payload, "off", 3) == 0) {
        on = false;
    } else {
        cJSON *json = cJSON_ParseWithLength(payload, payload_len);
        const cJSON *on_item = cJSON_GetObjectItemCaseSensitive(json, "on");
        if (!cJSON_IsBool(on_item)) {
            /* Never guess with a contactor: anything but an explicit boolean is ignored. */
            ESP_LOGW(TAG, "ignoring relay command without a boolean \"on\": %.*s", (int)payload_len, payload);
            cJSON_Delete(json);
            return;
        }
        on = cJSON_IsTrue(on_item);
        force = cJSON_IsTrue(cJSON_GetObjectItemCaseSensitive(json, "force"));
        const cJSON *id_item = cJSON_GetObjectItemCaseSensitive(json, "id");
        if (cJSON_IsString(id_item) && is_safe_id(id_item->valuestring)) {
            strlcpy(id, id_item->valuestring, sizeof(id));
        }
        cJSON_Delete(json);
    }

    if (s_guard && !s_guard(on, force)) {
        ESP_LOGW(TAG, "relay command refused: a charging transaction is active (send force to end it)");
        strlcpy(s_request_id, id, sizeof(s_request_id));
        s_rejected = "transaction_active";
        relay_remote_publish_state();
        return;
    }
    if (relay_control_set(on) != ESP_OK) {
        ESP_LOGE(TAG, "relay command failed");
        return; /* no state message: the requester times out rather than being lied to */
    }
    strlcpy(s_request_id, id, sizeof(s_request_id));
    relay_remote_publish_state();
}
