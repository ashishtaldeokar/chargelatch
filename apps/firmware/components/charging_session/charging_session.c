#include <math.h>
#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "nvs.h"
#include "nvs_flash.h"

#include "charging_session.h"
#include "device_mqtt.h"
#include "relay_control.h"
#include "relay_remote.h"
#include "sdm_json.h"

static const char *TAG = "charging_session";

#define TX_ID_MAX_LEN       64
#define REQUEST_ID_MAX_LEN  40
#define NVS_NAMESPACE       "session"
#define STATE_SUBTOPIC      "tx"
#define END_SUBTOPIC        "tx/end"
#define METER_SUBTOPIC      "tx/meter"

static SemaphoreHandle_t s_lock;
static bool s_active;
static char s_tx_id[TX_ID_MAX_LEN];
static char s_request_id[REQUEST_ID_MAX_LEN];    /* command that produced the current state */
static double s_meter_start;                     /* kWh counter at start; NAN when it was unreadable */
static uint32_t s_interval_s = CONFIG_CHARGING_SESSION_METER_INTERVAL_SECONDS;
static uint32_t s_seq;
/* Latest meter reading, from meter_telemetry. */
static sdm_reading_t s_reading;
static bool s_reading_complete;
static bool s_have_reading;
static int s_total_energy_index = -1;

static bool is_safe(const char *s, size_t max)
{
    const size_t len = strlen(s);
    if (len == 0 || len >= max) {
        return false;
    }
    for (size_t i = 0; i < len; i++) {
        const char c = s[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '-' || c == '_' || c == ':' || c == '.')) {
            return false;
        }
    }
    return true;
}

/* Current kWh counter, or NAN when the last reading did not have it. Caller holds the lock. */
static double current_kwh(void)
{
    if (!s_have_reading || s_total_energy_index < 0 || !s_reading.valid[s_total_energy_index]) {
        return NAN;
    }
    return s_reading.values[s_total_energy_index];
}

static void persist(void)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) != ESP_OK) {
        ESP_LOGW(TAG, "could not persist the transaction");
        return;
    }
    if (s_active) {
        nvs_set_str(h, "tx_id", s_tx_id);
        nvs_set_blob(h, "meter_start", &s_meter_start, sizeof(s_meter_start));
        nvs_set_u32(h, "interval", s_interval_s);
    } else {
        nvs_erase_all(h);
    }
    nvs_commit(h);
    nvs_close(h);
}

static void restore(void)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &h) != ESP_OK) {
        return;
    }
    size_t len = sizeof(s_tx_id);
    if (nvs_get_str(h, "tx_id", s_tx_id, &len) == ESP_OK) {
        size_t blob = sizeof(s_meter_start);
        if (nvs_get_blob(h, "meter_start", &s_meter_start, &blob) != ESP_OK) {
            s_meter_start = NAN;
        }
        nvs_get_u32(h, "interval", &s_interval_s);
        s_active = true;
        ESP_LOGI(TAG, "resuming transaction %s after reboot (meter start %.3f kWh)", s_tx_id, s_meter_start);
    }
    nvs_close(h);
}

/* Caller holds the lock. */
static void publish_state_locked(void)
{
    char payload[192];
    if (s_active) {
        if (isnan(s_meter_start)) {
            snprintf(payload, sizeof(payload), "{\"state\":\"active\",\"txId\":\"%s\",\"meterStart\":null,\"interval\":%lu,\"id\":\"%s\"}",
                     s_tx_id, (unsigned long)s_interval_s, s_request_id);
        } else {
            snprintf(payload, sizeof(payload), "{\"state\":\"active\",\"txId\":\"%s\",\"meterStart\":%.3f,\"interval\":%lu,\"id\":\"%s\"}",
                     s_tx_id, s_meter_start, (unsigned long)s_interval_s, s_request_id);
        }
    } else {
        snprintf(payload, sizeof(payload), "{\"state\":\"idle\",\"id\":\"%s\"}", s_request_id);
    }
    device_mqtt_publish(STATE_SUBTOPIC, payload, 1, true);
}

/* Ends the active transaction: contactor off, tx/end published. Caller holds the lock. */
static void end_locked(const char *reason, const char *request_id)
{
    const double stop = current_kwh();
    const bool metered = !isnan(s_meter_start) && !isnan(stop);
    /* A counter that went backwards (meter swapped) must not produce a negative bill. */
    const double energy_wh = metered ? fmax(0.0, (stop - s_meter_start) * 1000.0) : 0.0;

    relay_control_set(false);

    char payload[256];
    char start_s[32], stop_s[32], energy_s[32];
    snprintf(start_s, sizeof(start_s), isnan(s_meter_start) ? "null" : "%.3f", s_meter_start);
    snprintf(stop_s, sizeof(stop_s), isnan(stop) ? "null" : "%.3f", stop);
    snprintf(energy_s, sizeof(energy_s), metered ? "%.1f" : "null", energy_wh);
    snprintf(payload, sizeof(payload), "{\"txId\":\"%s\",\"meterStart\":%s,\"meterStop\":%s,\"energyWh\":%s,\"reason\":\"%s\",\"id\":\"%s\"}",
             s_tx_id, start_s, stop_s, energy_s, reason, request_id);
    ESP_LOGI(TAG, "transaction %s ended (%s): %s Wh", s_tx_id, reason, energy_s);

    s_active = false;
    strlcpy(s_request_id, request_id, sizeof(s_request_id));
    persist();
    device_mqtt_publish(END_SUBTOPIC, payload, 1, false);
    relay_remote_publish_state();
}

/* Caller holds the lock. */
static void start_locked(const char *tx_id, uint32_t interval_s, const char *request_id)
{
    strlcpy(s_tx_id, tx_id, sizeof(s_tx_id));
    strlcpy(s_request_id, request_id, sizeof(s_request_id));
    s_meter_start = current_kwh();
    s_interval_s = interval_s;
    s_seq = 0;
    s_active = true;
    persist();
    relay_control_set(true);
    ESP_LOGI(TAG, "transaction %s started (meter start %.3f kWh, meter values every %lu s)", s_tx_id, s_meter_start, (unsigned long)interval_s);
    publish_state_locked();
    relay_remote_publish_state();
}

/* The relay command path asks before switching: an active transaction must not be cut short
 * by a plain "off"; with force the transaction ends properly first. */
static bool relay_guard(bool on, bool force)
{
    bool allowed = true;
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (s_active && !on) {
        if (force) {
            end_locked("admin", s_request_id);
        } else {
            allowed = false;
        }
    }
    xSemaphoreGive(s_lock);
    return allowed;
}

void charging_session_handle_command(const char *payload, size_t payload_len)
{
    cJSON *json = cJSON_ParseWithLength(payload, payload_len);
    const cJSON *op = cJSON_GetObjectItemCaseSensitive(json, "op");
    const cJSON *tx = cJSON_GetObjectItemCaseSensitive(json, "txId");
    const cJSON *id = cJSON_GetObjectItemCaseSensitive(json, "id");
    const cJSON *interval = cJSON_GetObjectItemCaseSensitive(json, "interval");

    if (!cJSON_IsString(op) || !cJSON_IsString(tx) || !is_safe(tx->valuestring, TX_ID_MAX_LEN)) {
        ESP_LOGW(TAG, "ignoring malformed tx command: %.*s", (int)payload_len, payload);
        cJSON_Delete(json);
        return;
    }
    char request_id[REQUEST_ID_MAX_LEN] = "";
    if (cJSON_IsString(id) && is_safe(id->valuestring, REQUEST_ID_MAX_LEN)) {
        strlcpy(request_id, id->valuestring, sizeof(request_id));
    }
    uint32_t interval_s = CONFIG_CHARGING_SESSION_METER_INTERVAL_SECONDS;
    if (cJSON_IsNumber(interval) && interval->valuedouble >= 5 && interval->valuedouble <= 3600) {
        interval_s = (uint32_t)interval->valuedouble;
    }

    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (strcmp(op->valuestring, "start") == 0) {
        if (s_active && strcmp(s_tx_id, tx->valuestring) == 0) {
            /* Same transaction again (retry): just confirm. */
            strlcpy(s_request_id, request_id, sizeof(s_request_id));
            publish_state_locked();
        } else {
            if (s_active) {
                end_locked("superseded", request_id);
            }
            start_locked(tx->valuestring, interval_s, request_id);
        }
    } else if (strcmp(op->valuestring, "stop") == 0) {
        if (s_active && strcmp(s_tx_id, tx->valuestring) == 0) {
            end_locked("remote", request_id);
            publish_state_locked();
        } else {
            /* Not the active transaction: report the truth, which the backend reconciles. */
            ESP_LOGW(TAG, "stop for %s but %s is active", tx->valuestring, s_active ? s_tx_id : "nothing");
            strlcpy(s_request_id, request_id, sizeof(s_request_id));
            publish_state_locked();
        }
    } else {
        ESP_LOGW(TAG, "unknown tx op \"%s\"", op->valuestring);
    }
    xSemaphoreGive(s_lock);
    cJSON_Delete(json);
}

void charging_session_publish_state(void)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    publish_state_locked();
    xSemaphoreGive(s_lock);
}

void charging_session_note_reading(const sdm_reading_t *reading, bool complete)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_reading = *reading;
    s_reading_complete = complete;
    s_have_reading = true;
    /* A transaction that started before the meter answered gets its baseline from the first reading. */
    if (s_active && isnan(s_meter_start)) {
        s_meter_start = current_kwh();
        if (!isnan(s_meter_start)) {
            persist();
        }
    }
    xSemaphoreGive(s_lock);
}

bool charging_session_is_active(void)
{
    return s_active;
}

static void meter_values_task(void *arg)
{
    static char reading_json[SDM_JSON_MAX_LEN];
    /* Worst case: a full reading document plus the envelope (tx id, seq, energy, counter). */
    static char payload[SDM_JSON_MAX_LEN + TX_ID_MAX_LEN + 256];

    for (;;) {
        xSemaphoreTake(s_lock, portMAX_DELAY);
        const uint32_t interval_s = s_interval_s;
        if (s_active && s_have_reading && device_mqtt_is_connected()) {
            const double now_kwh = current_kwh();
            const bool metered = !isnan(s_meter_start) && !isnan(now_kwh);
            sdm_json_format(sdm_meter_model(), s_reading.values, s_reading.valid, s_reading_complete ? NULL : "incomplete", reading_json, sizeof(reading_json));
            char energy_s[32], kwh_s[32];
            snprintf(energy_s, sizeof(energy_s), metered ? "%.1f" : "null", metered ? fmax(0.0, (now_kwh - s_meter_start) * 1000.0) : 0.0);
            snprintf(kwh_s, sizeof(kwh_s), isnan(now_kwh) ? "null" : "%.3f", now_kwh);
            snprintf(payload, sizeof(payload), "{\"txId\":\"%s\",\"seq\":%lu,\"energyWh\":%s,\"meterKwh\":%s,\"reading\":%s}",
                     s_tx_id, (unsigned long)++s_seq, energy_s, kwh_s, reading_json);
            /* QoS 1 so a brief broker hiccup does not drop it; not queued while offline. */
            device_mqtt_publish(METER_SUBTOPIC, payload, 1, false);
        }
        xSemaphoreGive(s_lock);
        /* Sleep in short steps so a changed interval or a new transaction is picked up promptly. */
        for (uint32_t waited = 0; waited < interval_s; waited++) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            if (s_interval_s != interval_s) {
                break;
            }
        }
    }
}

esp_err_t charging_session_init(void)
{
    ESP_RETURN_ON_FALSE(!s_lock, ESP_ERR_INVALID_STATE, TAG, "already initialised");
    s_lock = xSemaphoreCreateMutex();
    ESP_RETURN_ON_FALSE(s_lock, ESP_ERR_NO_MEM, TAG, "no memory for lock");
    s_meter_start = NAN;
    s_total_energy_index = sdm_model_index_of(sdm_meter_model(), "total_energy");
    if (s_total_energy_index < 0) {
        ESP_LOGW(TAG, "meter model has no total_energy register: transactions will not carry energy");
    }

    restore();
    if (s_active) {
        /* relay_control restored the contactor from its own NVS state; make sure they agree. */
        relay_control_set(true);
    }
    relay_remote_set_guard(relay_guard);

    ESP_RETURN_ON_FALSE(xTaskCreate(meter_values_task, "tx_meter", 4096, NULL, 4, NULL) == pdPASS, ESP_ERR_NO_MEM, TAG, "no memory for task");
    return ESP_OK;
}
