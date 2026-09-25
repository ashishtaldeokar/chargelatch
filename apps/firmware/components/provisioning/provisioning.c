/*
 * Wi-Fi provisioning for chargelatch firmware.
 * Derived from the ESP-IDF wifi_prov_mgr example (Public Domain / CC0).
 */

#include <stdio.h>
#include <string.h>

#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/event_groups.h>

#include <esp_check.h>
#include <esp_log.h>
#include <esp_wifi.h>
#include <esp_event.h>
#include <esp_netif.h>
#include <esp_timer.h>
#include <nvs_flash.h>

#include <wifi_provisioning/manager.h>

#ifdef CONFIG_PROVISIONING_PROV_TRANSPORT_BLE
#include <wifi_provisioning/scheme_ble.h>
#endif

#ifdef CONFIG_PROVISIONING_PROV_TRANSPORT_SOFTAP
#include <wifi_provisioning/scheme_softap.h>
#endif

#include "provisioning.h"

static const char *TAG = "provisioning";

#define WIFI_CONNECTED_BIT      BIT0

/* BLE advertising data leaves room for a 29 byte name; SoftAP SSIDs allow 32. */
#define SERVICE_NAME_MAX_LEN    30
#define POP_MAX_LEN             65

static EventGroupHandle_t s_wifi_event_group;
static wifi_prov_mgr_config_t s_mgr_config;
static char s_service_name[SERVICE_NAME_MAX_LEN];

#if CONFIG_PROVISIONING_FALLBACK
/* Supervisor task events */
#define EV_RECONNECT_TIMEOUT    BIT0    /* stored network unreachable for RECONNECT_MINUTES */
#define EV_WINDOW_TIMEOUT       BIT1    /* provisioning window open for WINDOW_MINUTES */
#define EV_PROV_DONE            BIT2    /* the manager finished (new credentials connected) */
#define RECONNECT_TIMEOUT_US    ((uint64_t)CONFIG_PROVISIONING_FALLBACK_RECONNECT_MINUTES * 60 * 1000000ULL)
#define WINDOW_TIMEOUT_US       ((uint64_t)CONFIG_PROVISIONING_FALLBACK_WINDOW_MINUTES * 60 * 1000000ULL)

static EventGroupHandle_t s_supervisor_events;
static esp_timer_handle_t s_reconnect_timer;
static esp_timer_handle_t s_window_timer;
/* The config given to provisioning_start(), copied so the window can be re-opened later. */
static char s_cfg_service_name[SERVICE_NAME_MAX_LEN];
static char s_cfg_pop[POP_MAX_LEN];
static provisioning_config_t s_cfg;
/* Written on the event-loop task, read by the supervisor task. */
static volatile bool s_ble_client_connected;
static volatile bool s_fallback_active;
static volatile bool s_fallback_got_new_creds;
static wifi_config_t s_backup_config;

static void reconnect_timeout_cb(void *arg)
{
    xEventGroupSetBits(s_supervisor_events, EV_RECONNECT_TIMEOUT);
}

static void window_timeout_cb(void *arg)
{
    xEventGroupSetBits(s_supervisor_events, EV_WINDOW_TIMEOUT);
}

/* Called on every disconnect: the countdown to fallback starts with the first one. */
static void note_disconnected(void)
{
    if (s_reconnect_timer && !s_fallback_active && !esp_timer_is_active(s_reconnect_timer)) {
        ESP_LOGI(TAG, "stored network unreachable, re-opening provisioning in %d min if it stays that way",
                 CONFIG_PROVISIONING_FALLBACK_RECONNECT_MINUTES);
        esp_timer_start_once(s_reconnect_timer, RECONNECT_TIMEOUT_US);
    }
}

static void note_connected(void)
{
    if (s_reconnect_timer) {
        esp_timer_stop(s_reconnect_timer);
    }
}
#else
#define s_fallback_active false
static inline void note_disconnected(void) {}
static inline void note_connected(void) {}
#endif
#ifdef CONFIG_PROVISIONING_PROV_SECURITY_VERSION_1
static char s_pop[POP_MAX_LEN];
#endif

#if CONFIG_PROVISIONING_PROV_SECURITY_VERSION_2
#if CONFIG_PROVISIONING_PROV_SEC2_DEV_MODE
/* Salt and verifier generated for username = "wifiprov" and password = "abcd1234".
 * IMPORTANT: for production these must be unique to every device and come from the
 * device manufacturing partition (see CONFIG_PROVISIONING_PROV_SEC2_PROD_MODE). */
static const char sec2_salt[] = {
    0x03, 0x6e, 0xe0, 0xc7, 0xbc, 0xb9, 0xed, 0xa8, 0x4c, 0x9e, 0xac, 0x97, 0xd9, 0x3d, 0xec, 0xf4
};

static const char sec2_verifier[] = {
    0x7c, 0x7c, 0x85, 0x47, 0x65, 0x08, 0x94, 0x6d, 0xd6, 0x36, 0xaf, 0x37, 0xd7, 0xe8, 0x91, 0x43,
    0x78, 0xcf, 0xfd, 0x61, 0x6c, 0x59, 0xd2, 0xf8, 0x39, 0x08, 0x12, 0x72, 0x38, 0xde, 0x9e, 0x24,
    0xa4, 0x70, 0x26, 0x1c, 0xdf, 0xa9, 0x03, 0xc2, 0xb2, 0x70, 0xe7, 0xb1, 0x32, 0x24, 0xda, 0x11,
    0x1d, 0x97, 0x18, 0xdc, 0x60, 0x72, 0x08, 0xcc, 0x9a, 0xc9, 0x0c, 0x48, 0x27, 0xe2, 0xae, 0x89,
    0xaa, 0x16, 0x25, 0xb8, 0x04, 0xd2, 0x1a, 0x9b, 0x3a, 0x8f, 0x37, 0xf6, 0xe4, 0x3a, 0x71, 0x2e,
    0xe1, 0x27, 0x86, 0x6e, 0xad, 0xce, 0x28, 0xff, 0x54, 0x46, 0x60, 0x1f, 0xb9, 0x96, 0x87, 0xdc,
    0x57, 0x40, 0xa7, 0xd4, 0x6c, 0xc9, 0x77, 0x54, 0xdc, 0x16, 0x82, 0xf0, 0xed, 0x35, 0x6a, 0xc4,
    0x70, 0xad, 0x3d, 0x90, 0xb5, 0x81, 0x94, 0x70, 0xd7, 0xbc, 0x65, 0xb2, 0xd5, 0x18, 0xe0, 0x2e,
    0xc3, 0xa5, 0xf9, 0x68, 0xdd, 0x64, 0x7b, 0xb8, 0xb7, 0x3c, 0x9c, 0xfc, 0x00, 0xd8, 0x71, 0x7e,
    0xb7, 0x9a, 0x7c, 0xb1, 0xb7, 0xc2, 0xc3, 0x18, 0x34, 0x29, 0x32, 0x43, 0x3e, 0x00, 0x99, 0xe9,
    0x82, 0x94, 0xe3, 0xd8, 0x2a, 0xb0, 0x96, 0x29, 0xb7, 0xdf, 0x0e, 0x5f, 0x08, 0x33, 0x40, 0x76,
    0x52, 0x91, 0x32, 0x00, 0x9f, 0x97, 0x2c, 0x89, 0x6c, 0x39, 0x1e, 0xc8, 0x28, 0x05, 0x44, 0x17,
    0x3f, 0x68, 0x02, 0x8a, 0x9f, 0x44, 0x61, 0xd1, 0xf5, 0xa1, 0x7e, 0x5a, 0x70, 0xd2, 0xc7, 0x23,
    0x81, 0xcb, 0x38, 0x68, 0xe4, 0x2c, 0x20, 0xbc, 0x40, 0x57, 0x76, 0x17, 0xbd, 0x08, 0xb8, 0x96,
    0xbc, 0x26, 0xeb, 0x32, 0x46, 0x69, 0x35, 0x05, 0x8c, 0x15, 0x70, 0xd9, 0x1b, 0xe9, 0xbe, 0xcc,
    0xa9, 0x38, 0xa6, 0x67, 0xf0, 0xad, 0x50, 0x13, 0x19, 0x72, 0x64, 0xbf, 0x52, 0xc2, 0x34, 0xe2,
    0x1b, 0x11, 0x79, 0x74, 0x72, 0xbd, 0x34, 0x5b, 0xb1, 0xe2, 0xfd, 0x66, 0x73, 0xfe, 0x71, 0x64,
    0x74, 0xd0, 0x4e, 0xbc, 0x51, 0x24, 0x19, 0x40, 0x87, 0x0e, 0x92, 0x40, 0xe6, 0x21, 0xe7, 0x2d,
    0x4e, 0x37, 0x76, 0x2f, 0x2e, 0xe2, 0x68, 0xc7, 0x89, 0xe8, 0x32, 0x13, 0x42, 0x06, 0x84, 0x84,
    0x53, 0x4a, 0xb3, 0x0c, 0x1b, 0x4c, 0x8d, 0x1c, 0x51, 0x97, 0x19, 0xab, 0xae, 0x77, 0xff, 0xdb,
    0xec, 0xf0, 0x10, 0x95, 0x34, 0x33, 0x6b, 0xcb, 0x3e, 0x84, 0x0f, 0xb9, 0xd8, 0x5f, 0xb8, 0xa0,
    0xb8, 0x55, 0x53, 0x3e, 0x70, 0xf7, 0x18, 0xf5, 0xce, 0x7b, 0x4e, 0xbf, 0x27, 0xce, 0xce, 0xa8,
    0xb3, 0xbe, 0x40, 0xc5, 0xc5, 0x32, 0x29, 0x3e, 0x71, 0x64, 0x9e, 0xde, 0x8c, 0xf6, 0x75, 0xa1,
    0xe6, 0xf6, 0x53, 0xc8, 0x31, 0xa8, 0x78, 0xde, 0x50, 0x40, 0xf7, 0x62, 0xde, 0x36, 0xb2, 0xba
};
#endif

static esp_err_t get_sec2_salt(const char **salt, uint16_t *salt_len)
{
#if CONFIG_PROVISIONING_PROV_SEC2_DEV_MODE
    ESP_LOGI(TAG, "Development mode: using hard coded salt");
    *salt = sec2_salt;
    *salt_len = sizeof(sec2_salt);
    return ESP_OK;
#elif CONFIG_PROVISIONING_PROV_SEC2_PROD_MODE
    ESP_LOGE(TAG, "Security 2 production mode: salt provider not implemented!");
    return ESP_ERR_NOT_SUPPORTED;
#endif
}

static esp_err_t get_sec2_verifier(const char **verifier, uint16_t *verifier_len)
{
#if CONFIG_PROVISIONING_PROV_SEC2_DEV_MODE
    ESP_LOGI(TAG, "Development mode: using hard coded verifier");
    *verifier = sec2_verifier;
    *verifier_len = sizeof(sec2_verifier);
    return ESP_OK;
#elif CONFIG_PROVISIONING_PROV_SEC2_PROD_MODE
    ESP_LOGE(TAG, "Security 2 production mode: verifier provider not implemented!");
    return ESP_ERR_NOT_SUPPORTED;
#endif
}
#endif /* CONFIG_PROVISIONING_PROV_SECURITY_VERSION_2 */

static void event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data)
{
#ifdef CONFIG_PROVISIONING_RESET_PROV_MGR_ON_FAILURE
    static int retries;
#endif
    if (event_base == WIFI_PROV_EVENT) {
        switch (event_id) {
        case WIFI_PROV_START:
            ESP_LOGI(TAG, "Provisioning started");
            break;
        case WIFI_PROV_CRED_RECV: {
            wifi_sta_config_t *wifi_sta_cfg = (wifi_sta_config_t *)event_data;
            /* The password is deliberately not logged. */
            ESP_LOGI(TAG, "Received Wi-Fi credentials for SSID \"%s\"", (const char *)wifi_sta_cfg->ssid);
            break;
        }
        case WIFI_PROV_CRED_FAIL: {
            wifi_prov_sta_fail_reason_t *reason = (wifi_prov_sta_fail_reason_t *)event_data;
            ESP_LOGE(TAG, "Provisioning failed: %s",
                     (*reason == WIFI_PROV_STA_AUTH_ERROR) ?
                     "Wi-Fi station authentication failed" : "Wi-Fi access-point not found");
#ifdef CONFIG_PROVISIONING_RESET_PROV_MGR_ON_FAILURE
            retries++;
            if (retries >= CONFIG_PROVISIONING_PROV_MGR_MAX_RETRY_CNT) {
                ESP_LOGI(TAG, "Failed to connect with provisioned AP, resetting provisioned credentials");
                wifi_prov_mgr_reset_sm_state_on_failure();
                retries = 0;
            }
#endif
            break;
        }
        case WIFI_PROV_CRED_SUCCESS:
            ESP_LOGI(TAG, "Provisioning successful");
#if CONFIG_PROVISIONING_FALLBACK
            s_fallback_got_new_creds = true;
#endif
#ifdef CONFIG_PROVISIONING_RESET_PROV_MGR_ON_FAILURE
            retries = 0;
#endif
            break;
        case WIFI_PROV_END:
            /* De-initialize manager once provisioning is finished */
            wifi_prov_mgr_deinit();
#if CONFIG_PROVISIONING_FALLBACK
            xEventGroupSetBits(s_supervisor_events, EV_PROV_DONE);
#endif
            break;
        default:
            break;
        }
    } else if (event_base == WIFI_EVENT) {
        switch (event_id) {
        case WIFI_EVENT_STA_START:
            esp_wifi_connect();
            break;
        case WIFI_EVENT_STA_DISCONNECTED:
            xEventGroupClearBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
            note_disconnected();
            /* While a provisioning window is open the manager owns the connection attempts. */
            if (!s_fallback_active) {
                ESP_LOGI(TAG, "Disconnected. Connecting to the AP again...");
                esp_wifi_connect();
            }
            break;
#ifdef CONFIG_PROVISIONING_PROV_TRANSPORT_SOFTAP
        case WIFI_EVENT_AP_STACONNECTED:
            ESP_LOGI(TAG, "SoftAP transport: Connected!");
            break;
        case WIFI_EVENT_AP_STADISCONNECTED:
            ESP_LOGI(TAG, "SoftAP transport: Disconnected!");
            break;
#endif
        default:
            break;
        }
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
        ESP_LOGI(TAG, "Connected with IP Address:" IPSTR, IP2STR(&event->ip_info.ip));
        xEventGroupSetBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
        note_connected();
#ifdef CONFIG_PROVISIONING_PROV_TRANSPORT_BLE
    } else if (event_base == PROTOCOMM_TRANSPORT_BLE_EVENT) {
        switch (event_id) {
        case PROTOCOMM_TRANSPORT_BLE_CONNECTED:
            ESP_LOGI(TAG, "BLE transport: Connected!");
#if CONFIG_PROVISIONING_FALLBACK
            s_ble_client_connected = true;
#endif
            break;
        case PROTOCOMM_TRANSPORT_BLE_DISCONNECTED:
            ESP_LOGI(TAG, "BLE transport: Disconnected!");
#if CONFIG_PROVISIONING_FALLBACK
            s_ble_client_connected = false;
#endif
            break;
        default:
            break;
        }
#endif
    } else if (event_base == PROTOCOMM_SECURITY_SESSION_EVENT) {
        switch (event_id) {
        case PROTOCOMM_SECURITY_SESSION_SETUP_OK:
            ESP_LOGI(TAG, "Secured session established!");
            break;
        case PROTOCOMM_SECURITY_SESSION_INVALID_SECURITY_PARAMS:
            ESP_LOGE(TAG, "Received invalid security parameters for establishing secure session!");
            break;
        case PROTOCOMM_SECURITY_SESSION_CREDENTIALS_MISMATCH:
            ESP_LOGE(TAG, "Received incorrect username and/or PoP for establishing secure session!");
            break;
        default:
            break;
        }
    }
}

static void get_default_service_name(char *service_name, size_t max)
{
    uint8_t eth_mac[6];
    const char *ssid_prefix = "SONIK_";
    esp_wifi_get_mac(WIFI_IF_STA, eth_mac);
    snprintf(service_name, max, "%s%02X%02X%02X", ssid_prefix, eth_mac[3], eth_mac[4], eth_mac[5]);
}

/* Handler for the optional "custom-data" provisioning endpoint. The data format is up to the
 * application (plain text here); the mobile app can use it to pass extra data while provisioning. */
static esp_err_t custom_prov_data_handler(uint32_t session_id, const uint8_t *inbuf, ssize_t inlen,
                                          uint8_t **outbuf, ssize_t *outlen, void *priv_data)
{
    if (inbuf) {
        ESP_LOGI(TAG, "Received data: %.*s", (int)inlen, (char *)inbuf);
    }
    char response[] = "SUCCESS";
    *outbuf = (uint8_t *)strdup(response);
    if (*outbuf == NULL) {
        ESP_LOGE(TAG, "System out of memory");
        return ESP_ERR_NO_MEM;
    }
    *outlen = strlen(response) + 1; /* +1 for NULL terminating byte */

    return ESP_OK;
}

/* The application may already own NVS / netif / the default event loop, so "already
 * initialized" is not an error for any of them. */
static esp_err_t init_platform(void)
{
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        /* NVS partition was truncated and needs to be erased */
        ESP_RETURN_ON_ERROR(nvs_flash_erase(), TAG, "nvs_flash_erase failed");
        ret = nvs_flash_init();
    }
    ESP_RETURN_ON_ERROR(ret, TAG, "nvs_flash_init failed");

    ESP_RETURN_ON_ERROR(esp_netif_init(), TAG, "esp_netif_init failed");

    ret = esp_event_loop_create_default();
    if (ret != ESP_OK && ret != ESP_ERR_INVALID_STATE) {
        ESP_RETURN_ON_ERROR(ret, TAG, "esp_event_loop_create_default failed");
    }
    return ESP_OK;
}

static esp_err_t start_provisioning_service(const provisioning_config_t *config)
{

    /* Everything handed to the manager below is static: unlike the IDF example, this function
     * returns while provisioning is still running, and the security parameters must stay valid
     * until WIFI_PROV_END. */

    /* Device Service Name: Wi-Fi SSID for SoftAP, device name for BLE */
    const char *service_name = s_service_name;
    if (config && config->service_name) {
        ESP_RETURN_ON_FALSE(strlen(config->service_name) < sizeof(s_service_name), ESP_ERR_INVALID_ARG, TAG, "service_name too long");
        strlcpy(s_service_name, config->service_name, sizeof(s_service_name));
    } else {
        get_default_service_name(s_service_name, sizeof(s_service_name));
    }
    ESP_LOGI(TAG, "Starting provisioning as \"%s\"", service_name);

#ifdef CONFIG_PROVISIONING_PROV_SECURITY_VERSION_1
    /* Security 1: X25519 key exchange + proof of possession (pop) + AES-CTR */
    wifi_prov_security_t security = WIFI_PROV_SECURITY_1;
    if (config && config->pop) {
        ESP_RETURN_ON_FALSE(strlen(config->pop) < sizeof(s_pop), ESP_ERR_INVALID_ARG, TAG, "pop too long");
        strlcpy(s_pop, config->pop, sizeof(s_pop));
    } else {
        ESP_LOGW(TAG, "no per-device PoP: falling back to the shared development PoP");
        strlcpy(s_pop, CONFIG_PROVISIONING_PROV_DEV_POP, sizeof(s_pop));
    }
    wifi_prov_security1_params_t *sec_params = s_pop;

#elif CONFIG_PROVISIONING_PROV_SECURITY_VERSION_2
    /* Security 2: SRP6a authentication and key exchange + AES-GCM */
    wifi_prov_security_t security = WIFI_PROV_SECURITY_2;

    static wifi_prov_security2_params_t sec2_params = {};
    ESP_RETURN_ON_ERROR(get_sec2_salt(&sec2_params.salt, &sec2_params.salt_len), TAG, "no sec2 salt");
    ESP_RETURN_ON_ERROR(get_sec2_verifier(&sec2_params.verifier, &sec2_params.verifier_len), TAG, "no sec2 verifier");
    wifi_prov_security2_params_t *sec_params = &sec2_params;
#endif

    /* Service key: Wi-Fi password for SoftAP (8..64 chars) or NULL; ignored for BLE */
    const char *service_key = NULL;

#ifdef CONFIG_PROVISIONING_PROV_TRANSPORT_BLE
    /* Custom 128 bit UUID included in the BLE advertisement; it is the primary GATT service
     * whose characteristics are the provisioning endpoints. */
    static uint8_t custom_service_uuid[] = {
        /* LSB <---------------------------------------
         * ---------------------------------------> MSB */
        0xb4, 0xdf, 0x5a, 0x1c, 0x3f, 0x6b, 0xf4, 0xbf,
        0xea, 0x4a, 0x82, 0x03, 0x04, 0x90, 0x1a, 0x02,
    };
    wifi_prov_scheme_ble_set_service_uuid(custom_service_uuid);
#endif

    /* Optional endpoint; must be created before and registered after starting provisioning. */
    wifi_prov_mgr_endpoint_create("custom-data");

#ifdef CONFIG_PROVISIONING_REPROVISIONING
    /* Do not stop and de-init provisioning after success, so that it can be restarted later. */
    wifi_prov_mgr_disable_auto_stop(1000);
#endif

    ESP_RETURN_ON_ERROR(wifi_prov_mgr_start_provisioning(security, (const void *)sec_params, service_name, service_key),
                        TAG, "wifi_prov_mgr_start_provisioning failed");

    wifi_prov_mgr_endpoint_register("custom-data", custom_prov_data_handler, NULL);

    return ESP_OK;
}

#if CONFIG_PROVISIONING_FALLBACK
static void open_fallback_window(void)
{
    /* The manager blanks the stored STA config while it runs; keep a copy to put back if no
     * new credentials arrive. */
    esp_wifi_get_config(WIFI_IF_STA, &s_backup_config);
    s_fallback_got_new_creds = false;

    esp_err_t err = wifi_prov_mgr_init(s_mgr_config);
    if (err == ESP_OK) {
        err = start_provisioning_service(&s_cfg);
        if (err != ESP_OK) {
            wifi_prov_mgr_deinit();
        }
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "could not re-open provisioning (%s), retrying the stored network", esp_err_to_name(err));
        esp_wifi_connect();
        esp_timer_start_once(s_reconnect_timer, RECONNECT_TIMEOUT_US);
        return;
    }
    s_fallback_active = true;
    esp_timer_start_once(s_window_timer, WINDOW_TIMEOUT_US);
    ESP_LOGI(TAG, "provisioning re-opened for %d min", CONFIG_PROVISIONING_FALLBACK_WINDOW_MINUTES);
}

static void close_fallback_window(void)
{
    /* Blocking stop: no WIFI_PROV_END callback is delivered, so deinit here. */
    wifi_prov_mgr_stop_provisioning();
    wifi_prov_mgr_deinit();
    s_fallback_active = false;

    if (s_backup_config.sta.ssid[0]) {
        esp_wifi_set_config(WIFI_IF_STA, &s_backup_config);
    }
    ESP_LOGI(TAG, "provisioning window over, retrying the stored network for %d min",
             CONFIG_PROVISIONING_FALLBACK_RECONNECT_MINUTES);
    esp_wifi_connect();
    /* The next disconnect would start this too, but a network that is simply absent may not
     * produce one promptly. */
    esp_timer_start_once(s_reconnect_timer, RECONNECT_TIMEOUT_US);
}

/* All fallback transitions happen here: wifi_prov_mgr_stop_provisioning() blocks and must not
 * run on the event-loop task, and the timers fire on the esp_timer task. */
static void supervisor_task(void *arg)
{
    for (;;) {
        EventBits_t bits = xEventGroupWaitBits(s_supervisor_events, EV_RECONNECT_TIMEOUT | EV_WINDOW_TIMEOUT | EV_PROV_DONE,
                                               pdTRUE, pdFALSE, portMAX_DELAY);
        if (!s_fallback_active) {
            if (bits & EV_RECONNECT_TIMEOUT) {
                open_fallback_window();
            }
            continue;
        }
        if (bits & EV_PROV_DONE) {
            /* New credentials connected; the manager stopped itself and the handler deinit'd it. */
            esp_timer_stop(s_window_timer);
            s_fallback_active = false;
            ESP_LOGI(TAG, "provisioned with new credentials");
        } else if (bits & EV_WINDOW_TIMEOUT) {
            if (s_ble_client_connected) {
                ESP_LOGI(TAG, "a BLE client is connected, keeping provisioning open for another %d min",
                         CONFIG_PROVISIONING_FALLBACK_WINDOW_MINUTES);
                esp_timer_start_once(s_window_timer, WINDOW_TIMEOUT_US);
            } else if (s_fallback_got_new_creds) {
                /* Connected with new credentials but the manager has not wrapped up yet: give it a moment. */
                esp_timer_start_once(s_window_timer, 10 * 1000000ULL);
            } else {
                close_fallback_window();
            }
        }
    }
}

static esp_err_t fallback_init(const provisioning_config_t *config)
{
    if (config && config->service_name) {
        strlcpy(s_cfg_service_name, config->service_name, sizeof(s_cfg_service_name));
        s_cfg.service_name = s_cfg_service_name;
    }
    if (config && config->pop) {
        strlcpy(s_cfg_pop, config->pop, sizeof(s_cfg_pop));
        s_cfg.pop = s_cfg_pop;
    }

    s_supervisor_events = xEventGroupCreate();
    ESP_RETURN_ON_FALSE(s_supervisor_events, ESP_ERR_NO_MEM, TAG, "no memory for supervisor events");

    const esp_timer_create_args_t reconnect_args = { .callback = reconnect_timeout_cb, .name = "prov_reconnect" };
    const esp_timer_create_args_t window_args = { .callback = window_timeout_cb, .name = "prov_window" };
    ESP_RETURN_ON_ERROR(esp_timer_create(&reconnect_args, &s_reconnect_timer), TAG, "timer create failed");
    ESP_RETURN_ON_ERROR(esp_timer_create(&window_args, &s_window_timer), TAG, "timer create failed");

    ESP_RETURN_ON_FALSE(xTaskCreate(supervisor_task, "prov_supervisor", 4096, NULL, 4, NULL) == pdPASS,
                        ESP_ERR_NO_MEM, TAG, "no memory for supervisor task");
    ESP_LOGI(TAG, "fallback provisioning enabled: %d min on the stored network, then %d min of provisioning",
             CONFIG_PROVISIONING_FALLBACK_RECONNECT_MINUTES, CONFIG_PROVISIONING_FALLBACK_WINDOW_MINUTES);
    return ESP_OK;
}
#endif /* CONFIG_PROVISIONING_FALLBACK */

esp_err_t provisioning_start(const provisioning_config_t *config)
{
    if (s_wifi_event_group) {
        ESP_LOGW(TAG, "provisioning_start() called twice");
        return ESP_ERR_INVALID_STATE;
    }

    ESP_RETURN_ON_ERROR(init_platform(), TAG, "platform init failed");

    s_wifi_event_group = xEventGroupCreate();
    ESP_RETURN_ON_FALSE(s_wifi_event_group, ESP_ERR_NO_MEM, TAG, "no memory for event group");

    ESP_RETURN_ON_ERROR(esp_event_handler_register(WIFI_PROV_EVENT, ESP_EVENT_ANY_ID, &event_handler, NULL), TAG, "register failed");
#ifdef CONFIG_PROVISIONING_PROV_TRANSPORT_BLE
    ESP_RETURN_ON_ERROR(esp_event_handler_register(PROTOCOMM_TRANSPORT_BLE_EVENT, ESP_EVENT_ANY_ID, &event_handler, NULL), TAG, "register failed");
#endif
    ESP_RETURN_ON_ERROR(esp_event_handler_register(PROTOCOMM_SECURITY_SESSION_EVENT, ESP_EVENT_ANY_ID, &event_handler, NULL), TAG, "register failed");
    ESP_RETURN_ON_ERROR(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &event_handler, NULL), TAG, "register failed");
    ESP_RETURN_ON_ERROR(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &event_handler, NULL), TAG, "register failed");

    /* Initialize Wi-Fi including netif with default config */
    esp_netif_create_default_wifi_sta();
#ifdef CONFIG_PROVISIONING_PROV_TRANSPORT_SOFTAP
    esp_netif_create_default_wifi_ap();
#endif
    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_RETURN_ON_ERROR(esp_wifi_init(&cfg), TAG, "esp_wifi_init failed");

    s_mgr_config = (wifi_prov_mgr_config_t) {
#ifdef CONFIG_PROVISIONING_PROV_TRANSPORT_BLE
        .scheme = wifi_prov_scheme_ble,
#if CONFIG_PROVISIONING_FALLBACK
        /* Provisioning must be able to start again later, so the BT stack stays resident:
         * releasing its memory (the FREE_BTDM handler) is irreversible until reboot. */
        .scheme_event_handler = WIFI_PROV_EVENT_HANDLER_NONE
#else
        /* BT is only needed for provisioning, so let the manager free its memory afterwards. */
        .scheme_event_handler = WIFI_PROV_SCHEME_BLE_EVENT_HANDLER_FREE_BTDM
#endif
#endif
#ifdef CONFIG_PROVISIONING_PROV_TRANSPORT_SOFTAP
        .scheme = wifi_prov_scheme_softap,
        .scheme_event_handler = WIFI_PROV_EVENT_HANDLER_NONE
#endif
    };
#if CONFIG_PROVISIONING_FALLBACK
    ESP_RETURN_ON_ERROR(fallback_init(config), TAG, "fallback init failed");
#endif
    ESP_RETURN_ON_ERROR(wifi_prov_mgr_init(s_mgr_config), TAG, "wifi_prov_mgr_init failed");

    bool provisioned = false;
#ifdef CONFIG_PROVISIONING_RESET_PROVISIONED
    wifi_prov_mgr_reset_provisioning();
#else
    ESP_RETURN_ON_ERROR(wifi_prov_mgr_is_provisioned(&provisioned), TAG, "wifi_prov_mgr_is_provisioned failed");
#endif

    if (!provisioned) {
        return start_provisioning_service(config);
    }

    ESP_LOGI(TAG, "Already provisioned, starting Wi-Fi STA");
    /* The manager is not needed when already provisioned, so release its resources. */
    wifi_prov_mgr_deinit();
    ESP_RETURN_ON_ERROR(esp_wifi_set_mode(WIFI_MODE_STA), TAG, "esp_wifi_set_mode failed");
    ESP_RETURN_ON_ERROR(esp_wifi_start(), TAG, "esp_wifi_start failed");
    return ESP_OK;
}

esp_err_t provisioning_wait_for_connection(uint32_t timeout_ms)
{
    ESP_RETURN_ON_FALSE(s_wifi_event_group, ESP_ERR_INVALID_STATE, TAG, "provisioning_start() not called");

    TickType_t ticks = (timeout_ms == PROVISIONING_WAIT_FOREVER) ? portMAX_DELAY : pdMS_TO_TICKS(timeout_ms);
    EventBits_t bits = xEventGroupWaitBits(s_wifi_event_group, WIFI_CONNECTED_BIT, pdFALSE, pdTRUE, ticks);
    return (bits & WIFI_CONNECTED_BIT) ? ESP_OK : ESP_ERR_TIMEOUT;
}

esp_err_t provisioning_restart(void)
{
#ifdef CONFIG_PROVISIONING_REPROVISIONING
    ESP_RETURN_ON_FALSE(s_wifi_event_group, ESP_ERR_INVALID_STATE, TAG, "provisioning_start() not called");
    xEventGroupClearBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
    return wifi_prov_mgr_reset_sm_state_for_reprovision();
#else
    ESP_LOGE(TAG, "Enable CONFIG_PROVISIONING_REPROVISIONING to use provisioning_restart()");
    return ESP_ERR_NOT_SUPPORTED;
#endif
}
