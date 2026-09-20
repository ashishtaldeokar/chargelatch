#include "driver/gpio.h"
#include "esp_check.h"
#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"

#include "relay_control.h"

static const char *TAG = "relay";

#define NVS_NAMESPACE   "relay"
#define NVS_KEY_STATE   "on"

static bool s_on;
static bool s_ready;

static int level_for(bool on)
{
#if CONFIG_RELAY_ACTIVE_HIGH
    return on ? 1 : 0;
#else
    return on ? 0 : 1;
#endif
}

#if CONFIG_RELAY_RESTORE_STATE
static bool load_state(void)
{
    /* Idempotent; the provisioning component initialises NVS too, but only later. */
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        /* Leave erasing to the provisioning component; without NVS we just start off. */
        ESP_LOGW(TAG, "NVS needs erasing, starting with the relay off");
        return false;
    }
    nvs_handle_t handle;
    if (err != ESP_OK || nvs_open(NVS_NAMESPACE, NVS_READONLY, &handle) != ESP_OK) {
        return false; /* first boot: nothing stored yet */
    }
    uint8_t stored = 0;
    nvs_get_u8(handle, NVS_KEY_STATE, &stored);
    nvs_close(handle);
    return stored != 0;
}

static void save_state(bool on)
{
    nvs_handle_t handle;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &handle) != ESP_OK) {
        ESP_LOGW(TAG, "could not persist relay state");
        return;
    }
    if (nvs_set_u8(handle, NVS_KEY_STATE, on ? 1 : 0) != ESP_OK || nvs_commit(handle) != ESP_OK) {
        ESP_LOGW(TAG, "could not persist relay state");
    }
    nvs_close(handle);
}
#endif

esp_err_t relay_control_init(void)
{
    ESP_RETURN_ON_FALSE(!s_ready, ESP_ERR_INVALID_STATE, TAG, "already initialised");

#if CONFIG_RELAY_RESTORE_STATE
    s_on = load_state();
#else
    s_on = false;
#endif

    /* Level first, direction second: the pin becomes an output already at the right level. */
    ESP_RETURN_ON_ERROR(gpio_set_level(CONFIG_RELAY_GPIO, level_for(s_on)), TAG, "gpio_set_level failed");
    const gpio_config_t config = {
        .pin_bit_mask = 1ULL << CONFIG_RELAY_GPIO,
        /* INPUT_OUTPUT so the level can be read back if ever needed; harmless otherwise. */
        .mode = GPIO_MODE_INPUT_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&config), TAG, "gpio_config failed");
    ESP_RETURN_ON_ERROR(gpio_set_level(CONFIG_RELAY_GPIO, level_for(s_on)), TAG, "gpio_set_level failed");

    s_ready = true;
    ESP_LOGI(TAG, "relay on GPIO%d (active %s) starts %s%s", CONFIG_RELAY_GPIO,
             level_for(true) ? "high" : "low", s_on ? "ON" : "off",
#if CONFIG_RELAY_RESTORE_STATE
             " (restored)"
#else
             ""
#endif
            );
    return ESP_OK;
}

esp_err_t relay_control_set(bool on)
{
    ESP_RETURN_ON_FALSE(s_ready, ESP_ERR_INVALID_STATE, TAG, "relay_control_init() not called");
    if (on == s_on) {
        return ESP_OK; /* also spares the flash a write */
    }
    ESP_RETURN_ON_ERROR(gpio_set_level(CONFIG_RELAY_GPIO, level_for(on)), TAG, "gpio_set_level failed");
    s_on = on;
    ESP_LOGI(TAG, "relay switched %s", on ? "ON" : "off");
#if CONFIG_RELAY_RESTORE_STATE
    save_state(on);
#endif
    return ESP_OK;
}

bool relay_control_is_on(void)
{
    return s_on;
}
