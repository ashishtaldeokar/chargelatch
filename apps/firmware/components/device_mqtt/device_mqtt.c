#include <stdio.h>
#include <string.h>

#include "esp_app_desc.h"
#include "esp_check.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "mqtt_client.h"

#include "device_mqtt.h"

static const char *TAG = "device_mqtt";

#define DEVICE_ID_MAX_LEN   32
#define TOPIC_MAX_LEN       128
#define OFFLINE_PAYLOAD     "{\"online\":false}"

static esp_mqtt_client_handle_t s_client;
static device_mqtt_command_handler_t s_on_command;
static void (*s_on_connected)(void);
static bool s_connected;
static char s_device_id[DEVICE_ID_MAX_LEN];
static char s_status_topic[TOPIC_MAX_LEN];
static char s_command_prefix[TOPIC_MAX_LEN];    /* "devices/<id>/cmd/" */

static void publish_online(void)
{
    char payload[96];
    snprintf(payload, sizeof(payload), "{\"online\":true,\"firmware\":\"%s\"}", esp_app_get_description()->version);
    /* Retained, like the last will, so a late subscriber always sees the current state. */
    esp_mqtt_client_publish(s_client, s_status_topic, payload, 0, 1, 1);
}

static void handle_message(const esp_mqtt_event_handle_t event)
{
    /* Large payloads arrive in several events; commands are small, so only handle whole ones. */
    if (event->current_data_offset != 0 || event->data_len != event->total_data_len) {
        ESP_LOGW(TAG, "ignoring fragmented message (%d bytes)", event->total_data_len);
        return;
    }
    const size_t prefix_len = strlen(s_command_prefix);
    if (!s_on_command || (size_t)event->topic_len <= prefix_len || strncmp(event->topic, s_command_prefix, prefix_len) != 0) {
        return;
    }

    /* event->topic is not NUL-terminated. */
    char command[TOPIC_MAX_LEN];
    const size_t command_len = event->topic_len - prefix_len;
    if (command_len >= sizeof(command)) {
        return;
    }
    memcpy(command, event->topic + prefix_len, command_len);
    command[command_len] = '\0';
    s_on_command(command, event->data, event->data_len);
}

static void event_handler(void *arg, esp_event_base_t base, int32_t event_id, void *event_data)
{
    const esp_mqtt_event_handle_t event = event_data;
    switch ((esp_mqtt_event_id_t)event_id) {
    case MQTT_EVENT_CONNECTED: {
        s_connected = true;
        ESP_LOGI(TAG, "connected to %s as %s", CONFIG_DEVICE_MQTT_BROKER_URI, s_device_id);
        /* Subscriptions do not survive a clean session, so redo them on every connect. */
        char filter[TOPIC_MAX_LEN + 2];
        snprintf(filter, sizeof(filter), "%s#", s_command_prefix);
        esp_mqtt_client_subscribe(s_client, filter, 1);
        publish_online();
        if (s_on_connected) {
            s_on_connected();
        }
        break;
    }
    case MQTT_EVENT_DISCONNECTED:
        s_connected = false;
        ESP_LOGW(TAG, "disconnected, the client will keep retrying");
        break;
    case MQTT_EVENT_DATA:
        handle_message(event);
        break;
    case MQTT_EVENT_ERROR:
        if (event->error_handle->error_type == MQTT_ERROR_TYPE_TCP_TRANSPORT) {
            ESP_LOGW(TAG, "transport error (errno %d): is the broker reachable from this network?",
                     event->error_handle->esp_transport_sock_errno);
        } else if (event->error_handle->error_type == MQTT_ERROR_TYPE_CONNECTION_REFUSED) {
            ESP_LOGW(TAG, "connection refused by broker (code %d)", event->error_handle->connect_return_code);
        }
        break;
    default:
        break;
    }
}

esp_err_t device_mqtt_start(const device_mqtt_config_t *config)
{
    ESP_RETURN_ON_FALSE(s_client == NULL, ESP_ERR_INVALID_STATE, TAG, "already started");
    if (strlen(CONFIG_DEVICE_MQTT_BROKER_URI) == 0) {
        ESP_LOGE(TAG, "no broker configured: set \"chargelatch MQTT -> Broker URI\" in idf.py menuconfig");
        return ESP_ERR_INVALID_STATE;
    }

    if (config && config->device_id) {
        ESP_RETURN_ON_FALSE(strlen(config->device_id) < sizeof(s_device_id), ESP_ERR_INVALID_ARG, TAG, "device_id too long");
        strlcpy(s_device_id, config->device_id, sizeof(s_device_id));
    } else {
        uint8_t mac[6];
        ESP_RETURN_ON_ERROR(esp_read_mac(mac, ESP_MAC_WIFI_STA), TAG, "esp_read_mac failed");
        snprintf(s_device_id, sizeof(s_device_id), "DEV-%02X%02X%02X", mac[3], mac[4], mac[5]);
        ESP_LOGW(TAG, "no factory identity, using %s", s_device_id);
    }
    s_on_command = config ? config->on_command : NULL;
    s_on_connected = config ? config->on_connected : NULL;
    snprintf(s_status_topic, sizeof(s_status_topic), "devices/%s/status", s_device_id);
    snprintf(s_command_prefix, sizeof(s_command_prefix), "devices/%s/cmd/", s_device_id);

    const esp_mqtt_client_config_t mqtt_config = {
        .broker.address.uri = CONFIG_DEVICE_MQTT_BROKER_URI,
        .credentials.client_id = s_device_id,
        .session = {
            .keepalive = CONFIG_DEVICE_MQTT_KEEPALIVE_SECONDS,
            /* Published by the broker when the device vanishes without saying goodbye. */
            .last_will = {
                .topic = s_status_topic,
                .msg = OFFLINE_PAYLOAD,
                .msg_len = sizeof(OFFLINE_PAYLOAD) - 1,
                .qos = 1,
                .retain = 1,
            },
        },
    };

    s_client = esp_mqtt_client_init(&mqtt_config);
    ESP_RETURN_ON_FALSE(s_client, ESP_FAIL, TAG, "esp_mqtt_client_init failed (bad broker URI?)");
    ESP_RETURN_ON_ERROR(esp_mqtt_client_register_event(s_client, ESP_EVENT_ANY_ID, event_handler, NULL), TAG, "register_event failed");
    ESP_RETURN_ON_ERROR(esp_mqtt_client_start(s_client), TAG, "esp_mqtt_client_start failed");
    return ESP_OK;
}

bool device_mqtt_is_connected(void)
{
    return s_connected;
}

esp_err_t device_mqtt_publish(const char *subtopic, const char *payload, int qos, bool retain)
{
    ESP_RETURN_ON_FALSE(s_client, ESP_ERR_INVALID_STATE, TAG, "device_mqtt_start() not called");
    ESP_RETURN_ON_FALSE(subtopic && payload, ESP_ERR_INVALID_ARG, TAG, "subtopic and payload are required");

    char topic[TOPIC_MAX_LEN];
    const int len = snprintf(topic, sizeof(topic), "devices/%s/%s", s_device_id, subtopic);
    ESP_RETURN_ON_FALSE(len > 0 && (size_t)len < sizeof(topic), ESP_ERR_INVALID_ARG, TAG, "topic too long");

    /* enqueue (not publish) so qos>0 messages are stored while offline and never block the caller */
    return esp_mqtt_client_enqueue(s_client, topic, payload, 0, qos, retain, true) >= 0 ? ESP_OK : ESP_FAIL;
}
