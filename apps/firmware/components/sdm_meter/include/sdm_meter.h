/*
 * Eastron SDM energy meter over RS-485 / Modbus RTU.
 *
 * Wiring (defaults, see menuconfig -> chargelatch SDM energy meter):
 *   ESP32 GPIO17 (TX2) -> transceiver DI        transceiver A -> meter A (+)
 *   ESP32 GPIO16 (RX2) <- transceiver RO        transceiver B -> meter B (-)
 *   ESP32 GPIO4        -> transceiver DE + /RE
 * A 3.3 V transceiver (or level shifting on RO) is required: ESP32 inputs are not 5 V tolerant.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"
#include "sdm_registers.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    /** One entry per register of sdm_meter_model(), in table order. */
    float values[SDM_MAX_REGISTERS];
    /** false where the request covering that register failed. */
    bool valid[SDM_MAX_REGISTERS];
} sdm_reading_t;

typedef enum { SDM_PARITY_NONE = 0, SDM_PARITY_EVEN, SDM_PARITY_ODD } sdm_parity_t;

typedef struct {
    /** sdm_model_t name, e.g. "SDM120". NULL: CONFIG_SDM_METER_DEFAULT_MODEL. */
    const char *model;
    /** Modbus slave address 1..247. 0: CONFIG_SDM_METER_DEFAULT_SLAVE_ADDRESS. */
    uint8_t address;
    /** 0: CONFIG_SDM_METER_DEFAULT_BAUD_RATE. */
    uint32_t baud;
    sdm_parity_t parity;
} sdm_meter_config_t;

/** Parses "none" / "even" / "odd" (anything else: none). */
sdm_parity_t sdm_parity_from_string(const char *s);

/** The register map in use (valid after sdm_meter_init()). */
const sdm_model_t *sdm_meter_model(void);

/**
 * Installs the UART driver in RS-485 half-duplex mode. `config` may be NULL for all defaults.
 * @return ESP_ERR_NOT_FOUND if the model name is unknown to this firmware
 */
esp_err_t sdm_meter_init(const sdm_meter_config_t *config);

/**
 * Reads every register of the model, a few Modbus requests in all. Blocks for the duration
 * (about 1 s for an SDM120 at 2400 baud; up to several seconds if the meter does not answer).
 *
 * @param last_error  may be NULL; a short reason ("timeout", "crc", ...) when anything failed
 * @return ESP_OK if everything was read, ESP_ERR_INVALID_RESPONSE if only part of it was,
 *         ESP_ERR_TIMEOUT if nothing was (meter off, wiring, baud rate or slave address).
 */
esp_err_t sdm_meter_read(sdm_reading_t *reading, const char **last_error);

#ifdef __cplusplus
}
#endif
