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

/** The register map selected in Kconfig. */
const sdm_model_t *sdm_meter_model(void);

/** Installs the UART driver in RS-485 half-duplex mode. */
esp_err_t sdm_meter_init(void);

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
