#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "charging_session.h"
#include "device_mqtt.h"
#include "meter_telemetry.h"
#include "sdm_json.h"
#include "sdm_meter.h"

static const char *TAG = "meter_telemetry";

static void telemetry_task(void *arg)
{
    static sdm_reading_t reading;
    static char json[SDM_JSON_MAX_LEN];

    const sdm_model_t *model = sdm_meter_model();
    const TickType_t interval = pdMS_TO_TICKS(CONFIG_METER_TELEMETRY_INTERVAL_SECONDS * 1000);
    TickType_t last_wake = xTaskGetTickCount();
    /* Log transitions only: at one reading every few seconds, per-reading logs drown the console. */
    esp_err_t last_status = ESP_FAIL;

    for (;;) {
        const char *error = NULL;
        const esp_err_t status = sdm_meter_read(&reading, &error);

        if (status != last_status) {
            if (status == ESP_OK) {
                ESP_LOGI(TAG, "%s meter is answering", model->name);
            } else {
                ESP_LOGW(TAG, "%s meter read %s (%s): check wiring (A/B swapped?), baud rate and slave address",
                         model->name, status == ESP_ERR_TIMEOUT ? "failed" : "is incomplete", error ? error : "?");
            }
            last_status = status;
        }

        charging_session_note_reading(&reading, status == ESP_OK);

        if (device_mqtt_is_connected()) {
            if (sdm_json_format(model, reading.values, reading.valid, error, json, sizeof(json)) > 0) {
                /* QoS 0: the next reading supersedes this one in a few seconds anyway. */
                device_mqtt_publish(METER_TELEMETRY_SUBTOPIC, json, 0, false);
                ESP_LOGD(TAG, "%s", json);
            }
        }

        /* Fixed period regardless of how long the read took. */
        vTaskDelayUntil(&last_wake, interval);
    }
}

esp_err_t meter_telemetry_start(const sdm_meter_config_t *meter)
{
    ESP_RETURN_ON_ERROR(sdm_meter_init(meter), TAG, "sdm_meter_init failed");
    /* The JSON and reading buffers are static, so the stack only carries printf and the driver. */
    const BaseType_t created = xTaskCreate(telemetry_task, "meter_telemetry", 4096, NULL, 5, NULL);
    return created == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}
