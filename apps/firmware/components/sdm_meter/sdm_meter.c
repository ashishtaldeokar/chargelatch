#include <string.h>

#include "driver/uart.h"
#include "esp_check.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "sdm_meter.h"
#include "sdm_modbus.h"

static const char *TAG = "sdm_meter";

#define UART_PORT           ((uart_port_t)CONFIG_SDM_METER_UART_NUM)
#define MAX_BLOCKS          8
#define ATTEMPTS            2
/* How long the meter may take to start answering, on top of the time the bytes themselves need. */
#define RESPONSE_LATENCY_MS 300
/* Modbus wants 3.5 characters of silence between frames (16 ms at 2400 baud). Be generous. */
#define INTER_FRAME_MS      40

static const sdm_model_t *s_model;
static uint8_t s_address;
static uint32_t s_baud;
static sdm_block_t s_blocks[MAX_BLOCKS];
static size_t s_block_count;
static bool s_ready;

sdm_parity_t sdm_parity_from_string(const char *s)
{
    if (s && strcmp(s, "even") == 0) {
        return SDM_PARITY_EVEN;
    }
    if (s && strcmp(s, "odd") == 0) {
        return SDM_PARITY_ODD;
    }
    return SDM_PARITY_NONE;
}

const sdm_model_t *sdm_meter_model(void)
{
    return s_model;
}

esp_err_t sdm_meter_init(const sdm_meter_config_t *config)
{
    ESP_RETURN_ON_FALSE(!s_ready, ESP_ERR_INVALID_STATE, TAG, "already initialised");

    const char *model_name = (config && config->model) ? config->model : CONFIG_SDM_METER_DEFAULT_MODEL;
    s_model = sdm_model_by_name(model_name);
    ESP_RETURN_ON_FALSE(s_model, ESP_ERR_NOT_FOUND, TAG, "unknown meter model \"%s\": this firmware knows %u models", model_name, (unsigned)SDM_MODEL_COUNT);
    s_address = (config && config->address) ? config->address : CONFIG_SDM_METER_DEFAULT_SLAVE_ADDRESS;
    s_baud = (config && config->baud) ? config->baud : CONFIG_SDM_METER_DEFAULT_BAUD_RATE;
    const sdm_parity_t parity = config ? config->parity : SDM_PARITY_NONE;

    s_block_count = sdm_modbus_plan_blocks(s_model->registers, s_model->register_count, s_blocks, MAX_BLOCKS);
    ESP_RETURN_ON_FALSE(s_block_count > 0, ESP_ERR_INVALID_STATE, TAG, "register table for %s is not sorted by address", s_model->name);

    const uart_config_t uart = {
        .baud_rate = (int)s_baud,
        .data_bits = UART_DATA_8_BITS,
        .parity = parity == SDM_PARITY_EVEN ? UART_PARITY_EVEN : parity == SDM_PARITY_ODD ? UART_PARITY_ODD : UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };
    ESP_RETURN_ON_ERROR(uart_driver_install(UART_PORT, 2 * SDM_MODBUS_MAX_RESPONSE_LEN, 0, 0, NULL, 0), TAG, "uart_driver_install failed");
    ESP_RETURN_ON_ERROR(uart_param_config(UART_PORT, &uart), TAG, "uart_param_config failed");

    /* In RS-485 half-duplex mode the UART drives RTS (= DE/RE) high exactly while it transmits,
     * with bit-accurate timing a GPIO toggled from software could not guarantee. */
    const int de_gpio = CONFIG_SDM_METER_DE_GPIO >= 0 ? CONFIG_SDM_METER_DE_GPIO : UART_PIN_NO_CHANGE;
    ESP_RETURN_ON_ERROR(uart_set_pin(UART_PORT, CONFIG_SDM_METER_TX_GPIO, CONFIG_SDM_METER_RX_GPIO, de_gpio, UART_PIN_NO_CHANGE), TAG, "uart_set_pin failed");
    ESP_RETURN_ON_ERROR(uart_set_mode(UART_PORT, UART_MODE_RS485_HALF_DUPLEX), TAG, "uart_set_mode failed");

    s_ready = true;
    ESP_LOGI(TAG, "%s (%u-phase), slave %u, %lu baud 8%c1 on UART%d (tx %d, rx %d, de %d): %u values in %u requests",
             s_model->name, s_model->phases, s_address, (unsigned long)s_baud, "NEO"[parity], CONFIG_SDM_METER_UART_NUM,
             CONFIG_SDM_METER_TX_GPIO, CONFIG_SDM_METER_RX_GPIO, CONFIG_SDM_METER_DE_GPIO,
             (unsigned)s_model->register_count, (unsigned)s_block_count);
    return ESP_OK;
}

/* One request/response exchange. `frame` must hold SDM_MODBUS_MAX_RESPONSE_LEN bytes. */
static sdm_modbus_result_t transact(const sdm_block_t *block, uint8_t *frame)
{
    uint8_t request[SDM_MODBUS_REQUEST_LEN];
    sdm_modbus_build_read_input(s_address, block->start_address, block->register_count, request);

    /* Drop noise and any late answer to a previous request that timed out. */
    uart_flush_input(UART_PORT);
    uart_write_bytes(UART_PORT, request, sizeof(request));
    if (uart_wait_tx_done(UART_PORT, pdMS_TO_TICKS(500)) != ESP_OK) {
        return SDM_MODBUS_ERR_TOO_SHORT;
    }

    const size_t expected = SDM_MODBUS_RESPONSE_LEN(block->register_count);
    /* 11 bits per byte covers start, 8 data, parity and stop. */
    const uint32_t transfer_ms = (uint32_t)(expected * 11 * 1000 / s_baud);
    const int received = uart_read_bytes(UART_PORT, frame, expected, pdMS_TO_TICKS(transfer_ms + RESPONSE_LATENCY_MS));

    uint8_t exception = 0;
    const sdm_modbus_result_t result = sdm_modbus_check_response(s_address, block->register_count,
                                                                 frame, received > 0 ? (size_t)received : 0, &exception);
    if (result == SDM_MODBUS_ERR_EXCEPTION) {
        ESP_LOGW(TAG, "meter rejected read of 0x%04X+%u with exception %u (wrong model selected?)",
                 block->start_address, block->register_count, exception);
    }
    vTaskDelay(pdMS_TO_TICKS(INTER_FRAME_MS));
    return result;
}

esp_err_t sdm_meter_read(sdm_reading_t *reading, const char **last_error)
{
    ESP_RETURN_ON_FALSE(s_ready, ESP_ERR_INVALID_STATE, TAG, "sdm_meter_init() not called");
    ESP_RETURN_ON_FALSE(reading, ESP_ERR_INVALID_ARG, TAG, "reading is NULL");

    memset(reading, 0, sizeof(*reading));
    if (last_error) {
        *last_error = NULL;
    }

    static uint8_t frame[SDM_MODBUS_MAX_RESPONSE_LEN];
    size_t blocks_ok = 0;

    for (size_t b = 0; b < s_block_count; b++) {
        const sdm_block_t *block = &s_blocks[b];
        sdm_modbus_result_t result = SDM_MODBUS_ERR_TOO_SHORT;
        for (int attempt = 0; attempt < ATTEMPTS && result != SDM_MODBUS_OK; attempt++) {
            result = transact(block, frame);
            /* An exception is the meter's deliberate answer: asking again will not change it. */
            if (result == SDM_MODBUS_ERR_EXCEPTION) {
                break;
            }
        }
        if (result != SDM_MODBUS_OK) {
            ESP_LOGD(TAG, "block 0x%04X failed: %s", block->start_address, sdm_modbus_result_name(result));
            if (last_error) {
                *last_error = sdm_modbus_result_name(result);
            }
            /* If the first request gets no answer at all the meter is simply not there:
             * do not spend seconds timing out on the remaining blocks. */
            if (b == 0 && result == SDM_MODBUS_ERR_TOO_SHORT) {
                break;
            }
            continue;
        }

        blocks_ok++;
        for (size_t i = 0; i < block->value_count; i++) {
            const size_t index = block->first_index + i;
            reading->values[index] = sdm_modbus_float_at(frame, block->start_address, s_model->registers[index].address);
            reading->valid[index] = true;
        }
    }

    if (blocks_ok == s_block_count) {
        return ESP_OK;
    }
    return blocks_ok == 0 ? ESP_ERR_TIMEOUT : ESP_ERR_INVALID_RESPONSE;
}
