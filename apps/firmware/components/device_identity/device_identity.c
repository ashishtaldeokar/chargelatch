#include <stdbool.h>

#include "esp_check.h"
#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"

#include "device_identity.h"

static const char *TAG = "device_identity";

static char s_identity[DEVICE_IDENTITY_MAX_LEN];
static char s_pop[DEVICE_IDENTITY_POP_MAX_LEN];
static bool s_loaded;
static bool s_has_pop;
static char s_meter_model[16];
static char s_meter_parity[8];
static device_meter_config_t s_meter;

esp_err_t device_identity_init(void)
{
    if (s_loaded) {
        return ESP_OK;
    }

    /* Read-only init: the image the factory app writes has every page marked FULL (that is how
     * IDF's generator builds it), and nothing on the device should ever modify this partition. */
    esp_err_t err = nvs_flash_init_partition(DEVICE_IDENTITY_PARTITION);
    if (err == ESP_ERR_NOT_FOUND || err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_PART_NOT_FOUND) {
        ESP_LOGW(TAG, "no usable \"%s\" partition (%s): device was not flashed by the factory app",
                 DEVICE_IDENTITY_PARTITION, esp_err_to_name(err));
        return ESP_ERR_NOT_FOUND;
    }
    ESP_RETURN_ON_ERROR(err, TAG, "nvs_flash_init_partition failed");

    nvs_handle_t handle;
    err = nvs_open_from_partition(DEVICE_IDENTITY_PARTITION, DEVICE_IDENTITY_NAMESPACE, NVS_READONLY, &handle);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        ESP_LOGW(TAG, "factory partition has no \"%s\" namespace", DEVICE_IDENTITY_NAMESPACE);
        return ESP_ERR_NOT_FOUND;
    }
    ESP_RETURN_ON_ERROR(err, TAG, "nvs_open_from_partition failed");

    size_t len = sizeof(s_identity);
    err = nvs_get_str(handle, DEVICE_IDENTITY_KEY, s_identity, &len);

    /* Optional: partitions flashed before PoPs existed only hold the identity. */
    size_t pop_len = sizeof(s_pop);
    s_has_pop = (err == ESP_OK) && nvs_get_str(handle, DEVICE_IDENTITY_POP_KEY, s_pop, &pop_len) == ESP_OK;

    /* Optional meter configuration. */
    if (err == ESP_OK) {
        size_t len = sizeof(s_meter_model);
        if (nvs_get_str(handle, DEVICE_IDENTITY_METER_MODEL_KEY, s_meter_model, &len) == ESP_OK) {
            s_meter.model = s_meter_model;
        }
        nvs_get_u8(handle, DEVICE_IDENTITY_METER_ADDR_KEY, &s_meter.address);
        nvs_get_u32(handle, DEVICE_IDENTITY_METER_BAUD_KEY, &s_meter.baud);
        len = sizeof(s_meter_parity);
        if (nvs_get_str(handle, DEVICE_IDENTITY_METER_PARITY_KEY, s_meter_parity, &len) == ESP_OK) {
            s_meter.parity = s_meter_parity;
        }
    }
    nvs_close(handle);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        ESP_LOGW(TAG, "factory partition has no \"%s\" key", DEVICE_IDENTITY_KEY);
        return ESP_ERR_NOT_FOUND;
    }
    ESP_RETURN_ON_ERROR(err, TAG, "reading identity failed");

    s_loaded = true;
    ESP_LOGI(TAG, "device identity: %s (provisioning PoP %s, meter %s)", s_identity, s_has_pop ? "present" : "MISSING",
             s_meter.model ? s_meter.model : "not configured");
    return ESP_OK;
}

const char *device_identity_get(void)
{
    return s_loaded ? s_identity : NULL;
}

const device_meter_config_t *device_identity_get_meter(void)
{
    return &s_meter;
}

const char *device_identity_get_pop(void)
{
    return (s_loaded && s_has_pop) ? s_pop : NULL;
}
